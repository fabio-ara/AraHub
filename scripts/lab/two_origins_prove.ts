/**
 * AraHub MIT — READ09 on TWO physical, independently seeded Moodle Labs.
 * Default mode prepares a private receipt without reading secrets or using network/DB/Docker.
 * Execute ONLY after the root coordinator confirms both seeds are ready:
 *   deno run -A scripts/lab/two_origins_prove.ts --execute --seed-ready
 * Optional: --manifest-a=PATH --instance-a=PATH --manifest-b=PATH --instance-b=PATH --run=UUID
 * Only labstudenta is used. Exactly one new discussion is allowed, on origin B.
 * Approval is an explicit local session fixture, not installed ChatGPT/human-UI proof.
 * No reset, seed, password change, browser or images. Never download/save images
 * via UI/menu/shortcut/data/blob; capture only native results and bytes outside UI.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { HubError, type Principal } from "../../src/contracts.ts";
import { createHandler } from "../../src/http.ts";
import { PersistentActionStore } from "../../src/approval_store.ts";
import { Artifacts } from "../../src/artifacts.ts";
import { forumHtml } from "../../src/moodle_actions.ts";
import type { ConnectionService } from "../../src/connections.ts";
import { AUDITED_FUNCTIONS } from "../../src/adapters/moodle.ts";
import {
  assertLabOwnership,
  type LabManifest,
  loadLabManifest,
  MoodleLabAdapter,
} from "./moodle_lab_adapter.ts";

// Provider and SDK JSON is inspected at the boundary, never logged wholesale.
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const root = ".private/entrega-1/lab";
const arg = (name: string, fallback: string) =>
  Deno.args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1) ?? fallback;
const run = arg("--run", crypto.randomUUID());
if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run)) throw Error("READ09_RUN_GUARD");
const configs = [
  {
    manifestPath: arg("--manifest-a", root + "/manifest.lab.json"),
    instancePath: arg("--instance-a", root + "/instances/arahublab456/instance.json"),
    project: "arahublab456",
    origin: "http://localhost:8480",
  },
  {
    manifestPath: arg("--manifest-b", root + "/instances/arahublab4515/manifest.lab.json"),
    instancePath: arg("--instance-b", root + "/instances/arahublab4515/instance.json"),
    project: "arahublab4515",
    origin: "http://localhost:8481",
  },
];
const output = root + "/evidence/read-two-origins-" + run + "-" +
  new Date().toISOString().replace(/[:.]/g, "") + ".json";
const secrets: string[] = [];
const report: Json = {
  schema: "arahub.lab.read-two-origins/1",
  scenario: "READ-09",
  run,
  started_at: new Date().toISOString(),
  status: "prepared",
  physical_two_moodle_test: "not_run",
  levels: {
    local_database: "not_run",
    lab_integration: "not_run",
    hosted: "not_run",
    host_chatgpt: "not_run",
  },
  authentication:
    "MCP SDK/handler with explicit local bearer/session fixtures; Moodle tokens belong only to labstudenta",
  topology: {
    first: "existing Docker published loopback port 8480",
    second:
      "root-owned loopback 8481 bridge to Docker exec PHP TCP port 80; real Moodle HTTP, not a mock",
    second_transport:
      "Connection: close avoids reuse of an idle bridge socket; no bridge/core changes",
  },
  required_gate:
    "Root must explicitly confirm seed ready before --execute --seed-ready. File appearance alone is not authorization.",
  inputs: configs.map(({ manifestPath, instancePath, origin, project }) => ({
    manifestPath,
    instancePath,
    origin,
    project,
  })),
  planned_checks: [
    "distinct runtime markers and live identities",
    "same real course/module/forum IDs",
    "connection-qualified entities",
    "ambiguous WorkContext refuses inferred target",
    "cross-connection artifact load and action preparation refused",
    "one approved discussion on B",
    "no matching GUID on A before/after",
  ],
  steps: [],
  limits: [
    "No hosted/installed OAuth or UI proof",
    "Absence is checked over the full student-visible corresponding general forum, not hidden content or every course in the database",
    "Uncertain effects are never retried; local receipt state is retained on failure after dispatch",
  ],
};
async function save() {
  const serialized = JSON.stringify(report, null, 2);
  if (secrets.some((s) => s && serialized.includes(s))) throw Error("READ09_SECRET_REFUSED");
  await Deno.mkdir(root + "/evidence", { recursive: true });
  await Deno.writeTextFile(output, serialized);
}
function code(error: unknown): string {
  const raw = error instanceof HubError
    ? error.code
    : error instanceof Error
    ? error.message
    : "unknown";
  return /^(READ09_[A-Z0-9_]+|[a-z_]{1,80})$/.test(raw) && !secrets.some((s) => raw.includes(s))
    ? raw
    : "details_omitted";
}
async function check(step: string, checks: Record<string, boolean>, detail: Json = {}) {
  const passed = Object.values(checks).every(Boolean);
  report.steps.push({ step, passed, checks, ...detail });
  await save();
  console.log(step + ": " + (passed ? "pass" : "fail"));
  if (!passed) throw Error("READ09_CHECK_FAILED");
}
async function main() {
  if (!Deno.args.includes("--execute")) {
    await save();
    console.log("READ09 prepared; no network, DB, Docker or secret reads. evidence: " + output);
    return;
  }
  if (!Deno.args.includes("--seed-ready")) {
    report.status = "blocked";
    report.reason = "READ09_SEED_READY_REQUIRED";
    await save();
    console.log("READ09_SEED_READY_REQUIRED; no external calls. evidence: " + output);
    Deno.exitCode = 1;
    return;
  }
  await execute();
}

type Lab = typeof configs[number] & {
  manifest: LabManifest;
  courseId: number;
  cmid: number;
  forumId: number;
  studentId: number;
  connectionId: string;
};
async function execute() {
  let db: ReturnType<typeof createDb> | undefined,
    server: Deno.HttpServer | undefined,
    client: Client | undefined;
  const owner = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const session = { ownerId: owner, sessionId },
    principal = { ...session, clientId: "read-two-origins" };
  const requests: { origin: string; fn: string; write: boolean }[] = [];
  let dispatches = 0, dispatchArmed = false, ownerCreated = false;
  const subject = "READ09 " + run;
  const body = "Synthetic isolated discussion " + run;
  // Persist only hashes/booleans for these fields, never text snapshots or provider bodies.
  secrets.push(body);
  const hash = async (text: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const positive = (value: unknown) => {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw Error("READ09_FIXTURE_ID_GUARD");
    return Number(value);
  };
  try {
    const labs: Lab[] = [];
    report.status = "running";
    report.phase = "load_private_inputs";
    await save();
    for (const config of configs) {
      const manifest = await loadLabManifest(config.manifestPath);
      assertLabOwnership(manifest, config.instancePath);
      if (manifest.origin !== config.origin || manifest.project !== config.project) {
        throw Error("READ09_ORIGIN_GUARD");
      }
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(manifest.instance_id)) {
        throw Error("READ09_INSTANCE_GUARD");
      }
      for (const account of Object.values(manifest.accounts)) {
        if (account.token) secrets.push(account.token);
      }
      const password = (manifest as unknown as Json).accounts_password;
      if (typeof password === "string") secrets.push(password);
      const fixture = manifest.fixture as Json;
      if (!manifest.accounts.labstudenta?.token) throw Error("READ09_STUDENT_TOKEN_MISSING");
      labs.push({
        ...config,
        manifest,
        courseId: positive(fixture.courses?.disciplina),
        cmid: positive(fixture.forum?.general_cmid),
        forumId: positive(fixture.forum?.general),
        studentId: positive(manifest.accounts.labstudenta.userid),
        connectionId: "",
      });
    }
    await check("manifest_pair", {
      distinct_instances: labs[0].manifest.instance_id !== labs[1].manifest.instance_id,
      distinct_origins: labs[0].origin !== labs[1].origin,
      equal_course_ids: labs[0].courseId === labs[1].courseId,
      equal_module_ids: labs[0].cmid === labs[1].cmid,
      equal_forum_ids: labs[0].forumId === labs[1].forumId,
    }, {
      instances: labs.map((l) => ({
        origin: l.origin,
        instance_id: l.manifest.instance_id,
        course_id: l.courseId,
        cmid: l.cmid,
        forum_id: l.forumId,
        student_id: l.studentId,
      })),
    });

    // A local manifest is not evidence of a second physical Moodle. Read each
    // running container's existing dataroot marker; no mutation or service setup.
    report.phase = "runtime_markers";
    for (const lab of labs) {
      const php =
        'define("CLI_SCRIPT", true); require("/var/www/html/config.php"); echo "READ09-MARKER:" . json_encode(["instance_id" => trim(file_get_contents($CFG->dataroot . "/.arahub-lab-instance-id")), "origin" => $CFG->wwwroot, "release" => $CFG->release]);';
      const command = await new Deno.Command("docker", {
        args: [
          "--host",
          "npipe:////./pipe/docker_engine_linux",
          "exec",
          lab.project + "-webserver-1",
          "php",
          "-r",
          php,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const raw = new TextDecoder().decode(command.stdout),
        index = raw.lastIndexOf("READ09-MARKER:");
      if (command.code || index < 0) throw Error("READ09_RUNTIME_MARKER_UNAVAILABLE");
      const marker = JSON.parse(raw.slice(index + "READ09-MARKER:".length));
      await check("runtime_marker_" + lab.project, {
        marker_matches: marker.instance_id === lab.manifest.instance_id,
        origin_matches: marker.origin?.replace(/\/$/, "") === lab.origin,
      }, { origin: lab.origin, release: marker.release });
    }

    const transport = (lab: Lab, onRequest?: () => void): typeof fetch => async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const params = new URLSearchParams(String(init?.body ?? ""));
      const fn = params.get("wsfunction") ?? "";
      if (
        url.origin !== lab.origin || url.pathname !== "/webservice/rest/server.php" || url.search ||
        url.hash || url.username || url.password || init?.method !== "POST"
      ) throw Error("READ09_NETWORK_GUARD");
      if (params.get("wstoken") !== lab.manifest.accounts.labstudenta.token) {
        throw Error("READ09_ACCOUNT_GUARD");
      }
      const write = fn === "mod_forum_add_discussion";
      if (write) {
        if (
          lab !== labs[1] || !dispatchArmed || dispatches !== 0 ||
          params.get("subject") !== subject || params.get("message") !== forumHtml(body) ||
          Number(params.get("forumid")) !== lab.forumId
        ) throw Error("READ09_WRITE_GUARD");
        dispatches++;
        report.dispatch_attempted = true;
        await save();
      } else if (!AUDITED_FUNCTIONS.includes(fn)) throw Error("READ09_FUNCTION_GUARD");
      requests.push({ origin: lab.origin, fn, write });
      onRequest?.();
      const headers = new Headers(init?.headers);
      if (lab === labs[1]) headers.set("connection", "close");
      return await fetch(input, { ...init, headers, redirect: "error" });
    };
    const adapter = (lab: Lab, onRequest?: () => void) =>
      new MoodleLabAdapter(
        lab.manifest,
        "labstudenta",
        lab.instancePath,
        transport(lab, onRequest),
      );
    report.phase = "live_identity";
    for (const lab of labs) {
      const identity = await adapter(lab).getIdentity();
      await check("identity_" + lab.project, {
        complete: identity.coverage === "complete",
        student_a: identity.data?.user_id === lab.studentId &&
          identity.data?.username === "labstudenta",
        origin_matches: identity.data?.site_url === lab.origin,
      }, { origin: lab.origin, user_id: identity.data?.user_id, release: identity.data?.release });
    }
    report.physical_two_moodle_test = "identities_verified_checks_pending";
    const dbUrl = Deno.env.get("LOCAL_DATABASE_URL") ??
      "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
    const dbTarget = new URL(dbUrl);
    if (
      dbTarget.hostname !== "127.0.0.1" || dbTarget.port !== "55432" ||
      dbTarget.pathname !== "/arahub"
    ) throw Error("READ09_DATABASE_GUARD");
    db = createDb(dbUrl);
    const hub = new Hub(db), artifacts = new Artifacts(hub);
    await db`insert into auth.users(id) values(${owner})`;
    ownerCreated = true;
    const parents = new Map<string, Json>();
    for (const lab of labs) {
      const parent = await hub.connect(
        session,
        "moodle",
        "READ09 " + lab.project,
        lab.origin,
        String(lab.studentId),
        {},
      );
      lab.connectionId = parent.id as string;
      parents.set(lab.connectionId, {
        ...parent,
        provider_subject: String(lab.studentId),
        oauth_epoch: 0,
      });
    }
    const findLab = (p: Principal, id: string) => {
      const lab = labs.find((l) => l.connectionId === id);
      if (p.ownerId !== owner || !lab) {
        throw new HubError("not_found", "READ09_CONNECTION_GUARD", 404);
      }
      return lab;
    };
    const connections = {
      parent: (p: Principal, id: string) => {
        findLab(p, id);
        return Promise.resolve(parents.get(id));
      },
      moodle: (p: Principal, id: string, options?: { onRequest?: () => void }) =>
        Promise.resolve(adapter(findLab(p, id), options?.onRequest)),
    } as unknown as ConnectionService;
    const store = new PersistentActionStore(db, {
      sessionActive: (o, s) => Promise.resolve(o === owner && s === sessionId),
    });
    const mcpBearer = crypto.randomUUID(), sessionBearer = crypto.randomUUID();
    secrets.push(mcpBearer, sessionBearer);
    server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      const publicUrl = "http://127.0.0.1:" + (server!.addr as Deno.NetAddr).port;
      return createHandler(hub, {
        publicUrl,
        auth: { issuer: "https://synthetic.invalid", resource: publicUrl + "/mcp" },
        connections,
        actions: store,
        verify: (request, mcp) => {
          const expected = mcp ? mcpBearer : sessionBearer;
          if (request.headers.get("authorization") !== "Bearer " + expected) {
            throw new HubError("invalid_token", "Local auth fixture rejected", 401);
          }
          return Promise.resolve(mcp ? principal : session);
        },
      })(req);
    });
    const publicUrl = "http://127.0.0.1:" + (server.addr as Deno.NetAddr).port;
    client = new Client({ name: "read-two-origins", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(publicUrl + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + mcpBearer } },
      }),
    );
    const call = async (name: string, args: Json): Promise<Json> => {
      const result = await client!.callTool({ name, arguments: args });
      const blocks = result.content as { type: string; text?: string }[];
      const value = JSON.parse(blocks.find((b) => b.type === "text")?.text ?? "{}");
      if (result.isError) {
        throw new HubError(
          /^[a-z_]{1,80}$/.test(value.code) ? value.code : "mcp_error",
          "SDK error details omitted",
          409,
        );
      }
      return value;
    };
    const content = (lab: Lab, kind: string) =>
      call("hub_moodle_content", {
        connection_id: lab.connectionId,
        course_id: lab.courseId,
        kind,
      });
    report.phase = "student_reads_and_sync";
    const observedModules: Json[] = [];
    for (const lab of labs) {
      const courses = await call("hub_moodle_courses", { connection_id: lab.connectionId });
      const structure = await content(lab, "structure");
      const module = structure.data?.flatMap((s: Json) => s.modules ?? []).find((m: Json) =>
        m.id === lab.cmid
      );
      const forums = await content(lab, "forums");
      await check("student_reads_" + lab.project, {
        enrolled: courses.coverage === "complete" &&
          courses.data?.some((c: Json) => c.id === lab.courseId),
        structure_complete: structure.coverage === "complete",
        forum_complete: forums.coverage === "complete",
        module_accessible: module?.uservisible === true,
        correct_forum: module?.modname === "forum" && module?.instance === lab.forumId &&
          forums.data?.some((f: Json) => f.id === lab.forumId),
        no_groups: Number(module?.groupmode ?? 0) === 0,
      }, {
        connection_id: lab.connectionId,
        course_id: lab.courseId,
        cmid: lab.cmid,
        course_listing: {
          coverage: courses.coverage,
          error_code: courses.error_code,
          moodle_code: courses.error_detail?.moodle_code,
          returned_ids: courses.data?.map((c: Json) => c.id) ?? [],
        },
      });
      observedModules.push(module);
      let pending = true;
      const summaries: Json[] = [];
      for (let attempt = 0; attempt < 8 && pending; attempt++) {
        const result = await call("hub_sync_moodle_course", {
          connection_id: lab.connectionId,
          course_id: lab.courseId,
        });
        if (!result.summary) throw Error("READ09_SYNC_SUMMARY_MISSING");
        pending = result.summary.checkpoint?.pending === true;
        summaries.push({
          coverage: result.summary.coverage,
          counts: result.summary.counts,
          gap_kinds: (result.summary.gaps ?? []).map((g: Json) =>
            g.kind ?? g.key ?? g.error_code ?? "unspecified"
          ),
          pending,
        });
      }
      await check("sync_" + lab.project, { traversal_finished: !pending }, {
        summaries,
        scope: "traversal completion does not imply every endpoint has complete coverage",
      });
    }
    await check("real_numeric_collision", {
      same_course: labs[0].courseId === labs[1].courseId,
      same_cmid: observedModules[0].id === observedModules[1].id,
      same_instance: observedModules[0].instance === observedModules[1].instance,
      same_title: observedModules[0].name === observedModules[1].name,
    });
    const entities = async (connectionId?: string): Promise<Json[]> => {
      let offset = 0;
      const all: Json[] = [];
      for (let page = 0; page < 100; page++) {
        const result = await call("hub_entities", {
          connection_id: connectionId,
          kind: "module",
          offset,
        });
        all.push(...result.records);
        if (result.next_offset === null) return all;
        offset = result.next_offset;
      }
      throw Error("READ09_ENTITY_PAGE_LIMIT");
    };
    const externalId = "moodle:course/" + labs[0].courseId + "/module/" + labs[0].cmid;
    const paired: Json[] = [];
    for (const lab of labs) {
      const found = (await entities(lab.connectionId)).filter((e) => e.external_id === externalId);
      if (found.length !== 1 || found[0].connection_id !== lab.connectionId) {
        throw Error("READ09_ENTITY_SCOPE");
      }
      paired.push(found[0]);
    }
    const broad = (await entities()).filter((e) => e.external_id === externalId);
    await check("connection_entities", {
      distinct_connections: labs[0].connectionId !== labs[1].connectionId,
      same_external_id: paired[0].external_id === paired[1].external_id,
      distinct_entity_ids: paired[0].id !== paired[1].id,
      unfiltered_keeps_both: broad.length === 2,
      same_title: paired[0].title === paired[1].title,
    }, {
      external_id: externalId,
      entities: paired.map((e) => ({ id: e.id, connection_id: e.connection_id })),
    });
    const context = await hub.createContext(session, "READ09 " + run);
    await call("hub_bind_work_targets", {
      context_id: context.id,
      expected_version: 0,
      entity_ids: paired.map((e) => e.id),
    });
    const targets = await call("hub_work_targets", { context_id: context.id });
    let ambiguousCode = "unexpected_success";
    try {
      await call("hub_report_submission", {
        context_id: context.id,
        expected_version: 1,
        idempotency_key: run,
        content: "Synthetic ambiguity probe",
      });
    } catch (error) {
      ambiguousCode = code(error);
    }
    const history = await hub.history(session, context.id);
    await check("work_context_ambiguous", {
      ambiguous: targets.resolution === "ambiguous",
      both_connections: new Set(targets.targets.map((t: Json) => t.connection_id)).size === 2,
      refused: ambiguousCode === "ambiguous_activity",
      no_report_written: history.records.length === 0,
    }, { refusal: ambiguousCode });
    const artifact = await artifacts.preserve(
      session,
      labs[0].connectionId,
      context.id,
      new TextEncoder().encode("READ09 synthetic artifact " + run),
      { id: run, name: "read09.txt", system: "local_synthetic_fixture" },
    );
    const own = await artifacts.load(session, labs[0].connectionId, artifact.id);
    let loadCode = "unexpected_success", prepareCode = "unexpected_success";
    try {
      await artifacts.load(session, labs[1].connectionId, artifact.id);
    } catch (error) {
      loadCode = code(error);
    }
    const input = {
      connection_id: labs[1].connectionId,
      course_id: labs[1].courseId,
      cmid: labs[1].cmid,
      kind: "forum.discussion",
      subject,
      body,
      file_ids: [],
    };
    try {
      await call("hub_prepare_moodle_action", { ...input, file_ids: [artifact.id] });
    } catch (error) {
      prepareCode = code(error);
    }
    await check("artifact_cross_connection_refused", {
      own_load: own.sha256 === artifact.sha256,
      cross_load_refused: loadCode === "not_found",
      cross_prepare_refused: prepareCode === "not_found",
      no_provider_write: dispatches === 0,
    }, {
      artifact_id: artifact.id,
      sha256: artifact.sha256,
      load_refusal: loadCode,
      prepare_refusal: prepareCode,
    });
    report.levels.local_database = "pass";

    const scan = async (lab: Lab): Promise<Json> => {
      const matchedPosts: Json[] = [], matchedDiscussions: number[] = [];
      const discussions = new Set<number>(), posts = new Set<number>();
      let pages = 0;
      for (let page = 0; page < 50; page++) {
        const list = await call("hub_moodle_discussions", {
          connection_id: lab.connectionId,
          forum_id: lab.forumId,
          page,
          per_page: 100,
        });
        if (list.coverage !== "complete" || !Array.isArray(list.data) || list.warnings?.length) {
          throw Error("READ09_DISCUSSION_SCAN_INCOMPLETE");
        }
        pages++;
        for (const discussion of list.data) {
          const id = positive(discussion.discussion_id ?? discussion.discussion);
          if (discussions.has(id)) throw Error("READ09_DISCUSSION_SCAN_REORDERED");
          discussions.add(id);
          if (String(discussion.name).includes(run)) matchedDiscussions.push(id);
          let done = false;
          for (let offset = 0; offset < 10000; offset += 100) {
            const result = await call("hub_moodle_posts", {
              connection_id: lab.connectionId,
              discussion_id: id,
              offset,
              limit: 100,
            });
            if (
              !Array.isArray(result.data) || result.warnings?.length ||
              !["complete", "partial"].includes(result.coverage)
            ) throw Error("READ09_POST_SCAN_INCOMPLETE");
            for (const post of result.data) {
              posts.add(post.id);
              if (String(post.subject).includes(run) || String(post.message).includes(run)) {
                matchedPosts.push({
                  id: post.id,
                  discussion_id: id,
                  author_id: post.author?.id ?? post.userid,
                  subject_matches: post.subject === subject,
                  body_contains_run: String(post.message).includes(run),
                  body_matches: String(post.message).includes(body),
                });
              }
            }
            if (result.pagination?.has_more === false) {
              done = true;
              break;
            }
          }
          if (!done) throw Error("READ09_POST_SCAN_LIMIT");
        }
        if (list.pagination?.has_more === false) {
          return {
            completed: true,
            pages,
            discussions_scanned: discussions.size,
            posts_scanned: posts.size,
            matched_discussions: matchedDiscussions,
            matched_posts: matchedPosts,
          };
        }
      }
      throw Error("READ09_DISCUSSION_SCAN_LIMIT");
    };
    report.phase = "before_dispatch_oracle";
    const before = [await scan(labs[0]), await scan(labs[1])];
    await check("before_dispatch_absence", {
      absent_a: before[0].matched_posts.length === 0 && before[0].matched_discussions.length === 0,
      absent_b: before[1].matched_posts.length === 0 && before[1].matched_discussions.length === 0,
    }, {
      observations: before,
      subject_sha256: await hash(subject),
      body_sha256: await hash(body),
    });
    report.phase = "prepare_approve_execute_b";
    const prepared = await call("hub_prepare_moodle_action", input);
    report.action_id = prepared.action_id;
    await check("prepare_b", {
      prepared: prepared.state === "prepared",
      origin_b: prepared.review?.connection?.origin === labs[1].origin,
      target_b: prepared.review?.target?.cmid === labs[1].cmid &&
        prepared.review?.target?.course_id === labs[1].courseId,
      no_write: dispatches === 0,
    }, { action_id: prepared.action_id, content_hash: prepared.content_hash });
    const approval = await fetch(publicUrl + "/api/actions/approve", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + sessionBearer },
      body: JSON.stringify({
        action_id: prepared.action_id,
        content_hash: prepared.content_hash,
        statement_accepted: false,
      }),
    });
    await approval.body?.cancel();
    const approved = await store.load(session, prepared.action_id);
    await check("approve_session_fixture", {
      http_success: approval.status === 200,
      approved: approved?.state === "approved",
      connection_b: approved?.action.connectionId === labs[1].connectionId,
    }, { mode: "explicit session fixture via HTTP, not a browser/human interaction" });
    dispatchArmed = true;
    let executed: Json = {}, executionError: string | null = null;
    try {
      executed = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
    } catch (error) {
      executionError = code(error);
    }
    dispatchArmed = false;
    // No retry, even if the first call was uncertain. Independent fresh adapters
    // are created by the read-only SDK routes for the post-dispatch scans.
    report.phase = "after_dispatch_oracle";
    const after = [await scan(labs[0]), await scan(labs[1])];
    const receipt = await call("hub_action", { action_id: prepared.action_id });
    await check("execute_b_verify_b_and_absence_a", {
      succeeded: executed.state === "succeeded",
      external_state_verified: receipt.external_state_verified === true,
      exactly_one_dispatch: dispatches === 1,
      no_write_a: requests.every((r) => !r.write || r.origin === labs[1].origin),
      absent_a: after[0].matched_posts.length === 0 && after[0].matched_discussions.length === 0,
      exactly_one_discussion_b: after[1].matched_discussions.length === 1,
      exactly_one_post_b: after[1].matched_posts.length === 1,
      author_student_a: after[1].matched_posts[0]?.author_id === labs[1].studentId,
      intended_text: after[1].matched_posts[0]?.subject_matches === true &&
        after[1].matched_posts[0]?.body_matches === true,
    }, {
      execution_state: executed.state ?? null,
      execution_error: executionError,
      action_id: prepared.action_id,
      observations: after,
    });
    report.physical_two_moodle_test = "pass";
    report.levels.lab_integration = "pass";
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = code(error);
    report.levels.lab_integration = "fail";
  } finally {
    dispatchArmed = false;
    try {
      await client?.close();
    } catch { /* Already closed. */ }
    try {
      await server?.shutdown();
    } catch { /* Already stopped. */ }
    if (db && ownerCreated) {
      if (report.status !== "pass" && dispatches > 0) {
        report.local_fixture_retained = {
          owner_id: owner,
          session_id: sessionId,
          reason:
            "preserve uncertain/failed action receipt for read-only reconciliation; do not resend",
        };
      } else {
        try {
          await db`delete from auth.users where id=${owner}`;
          report.local_owner_removed = true;
        } catch {
          report.cleanup_failed = true;
          report.status = "fail";
        }
      }
    }
    await db?.end();
    report.finished_at = new Date().toISOString();
    report.provider_requests = requests;
    report.dispatch_attempts = dispatches;
    await save();
    console.log("READ09 " + report.status + "; evidence: " + output);
    if (report.status !== "pass") Deno.exitCode = 1;
  }
}

await main();
