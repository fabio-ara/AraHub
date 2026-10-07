/**
 * AraHub MIT — real READ-01..08 proof; READ-09 here is a local DB diagnostic only.
 * No production credentials/browser. Physical READ-09 uses two_origins_prove.ts.
 * deno run -A scripts/lab/read_prove.ts [--direct] [--run=UUID] [--cases=READ-07]
 * Optional private inputs: --manifest=PATH --instance=PATH.
 * New runs start from fresh fixtures. --run resumes diagnostics; mutations from
 * an earlier run (rename/old-post edit) remain and are not silently reset.
 * Only read_fixtures.php creates/mutates the isolated course; all consumer reads
 * use student B through the real adapter and MCP SDK/handler. Auth is a local
 * synthetic bearer fixture, not a claim of installed/hosted ChatGPT proof.
 * Evidence contains checks, IDs, hashes and coverage, never source bodies.
 * Handoff rule: no image download/save through UI/menu/shortcuts/data/blob;
 * only native capture results and bytes written outside UI (none used here).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { createHandler } from "../../src/http.ts";
import type { ConnectionService } from "../../src/connections.ts";
import { AUDITED_FUNCTIONS } from "../../src/adapters/moodle.ts";
import { assertLabOwnership, loadLabManifest, MoodleLabAdapter } from "./moodle_lab_adapter.ts";

// JSON from the provider/SDK is intentionally inspected at the boundary.
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const root = ".private/entrega-1/lab";
const manifestPath = Deno.args.find((a) => a.startsWith("--manifest="))?.slice(11) ??
  root + "/manifest.lab.json";
const instanceFile = Deno.args.find((a) => a.startsWith("--instance="))?.slice(11) ??
  root + "/instances/arahublab456/instance.json";
const manifest = await loadLabManifest(manifestPath);
assertLabOwnership(manifest, instanceFile);
if (
  !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(manifest.instance_id) ||
  manifest.origin !== "http://localhost:8480" || manifest.project !== "arahublab456"
) {
  throw new Error("READ_GUARD_INSTANCE");
}
const run = Deno.args.find((a) => a.startsWith("--run="))?.slice(6) ?? crypto.randomUUID();
if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run)) throw new Error("READ_GUARD_RUN");
const secrets = Object.values(manifest.accounts).map((a) => a.token).filter(Boolean) as string[];
const password = (manifest as unknown as Json).accounts_password;
if (typeof password === "string") secrets.push(password);
const evidencePath = root + "/evidence/read-suite-" + run + "-" +
  new Date().toISOString().replace(/[:.]/g, "") + ".json";
const selectedCases = Deno.args.find((a) => a.startsWith("--cases="))?.slice(8).split(",");
const allowedCases = [
  "READ-01",
  "READ-02",
  "READ-03",
  "READ-04",
  "READ-05",
  "READ-06",
  "READ-07",
  "READ-08",
  "READ-09",
];
const directCases = ["READ-02", "READ-03", "READ-04"];
const requestedCases = selectedCases ??
  (Deno.args.includes("--direct") ? directCases : allowedCases);
if (
  !requestedCases.length || requestedCases.some((id) => !allowedCases.includes(id)) ||
  (Deno.args.includes("--direct") &&
    requestedCases.some((id) => !directCases.includes(id)))
) {
  throw new Error("READ_GUARD_CASES");
}
const results: Json[] = [];
const report: Json = {
  schema: "arahub.lab.read-suite/1",
  run,
  instance_id: manifest.instance_id,
  origin: manifest.origin,
  started_at: new Date().toISOString(),
  authentication: "local synthetic bearer; real student B Moodle token",
  requested_cases: requestedCases,
  levels: {
    lab_integration: "running",
    hosted: "not_run",
    browser: "root_owned",
    production_read: "not_run",
  },
  results,
};
async function save() {
  const serialized = JSON.stringify(report, null, 2);
  if (secrets.some((s) => serialized.includes(s))) throw new Error("READ_EVIDENCE_SECRET_REFUSED");
  await Deno.mkdir(root + "/evidence", { recursive: true });
  await Deno.writeTextFile(evidencePath, serialized);
}
function errorCode(error: unknown): string {
  const value = error as { code?: string; message?: string };
  const code = value.code ?? value.message ?? "unknown";
  return /^[a-zA-Z0-9_: .-]{1,120}$/.test(code) && !secrets.some((s) => code.includes(s))
    ? code
    : "error_details_omitted";
}
async function cli(command: string): Promise<Json> {
  const output = await new Deno.Command("docker", {
    // Existing Linux-engine pipe; no Docker context/global settings mutation.
    args: [
      "--host",
      "npipe:////./pipe/docker_engine_linux",
      "exec",
      "arahublab456-webserver-1",
      "php",
      "/opt/arahub-lab/tools/read_fixtures.php",
      command,
      run,
      manifest.instance_id,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const marker = "ARAHUB-READ-JSON:";
  const index = stdout.lastIndexOf(marker);
  if (output.code || index < 0) {
    report.helper_failure = { command, exit_code: output.code, stderr_bytes: output.stderr.length };
    throw new Error("READ_HELPER_FAILED_" + command);
  }
  return JSON.parse(stdout.slice(index + marker.length).split("\n")[0]);
}
async function test(id: string, work: () => Promise<Json>) {
  if (selectedCases && !selectedCases.includes(id)) return;
  diagnostics = {};
  try {
    const item = await work();
    results.push({ id, level: "lab_integration", ...item, diagnostics });
  } catch (error) {
    results.push({
      id,
      level: "lab_integration",
      status: "error",
      code: errorCode(error),
      diagnostics,
    });
  }
  await save();
  console.log(id + ": " + results.at(-1)!.status);
}
let diagnostics: Json = {};
const calls: Json[] = [];
let externalAttempts = 0;
let afterResponse: ((fn: string) => Promise<void>) | null = null;
let auditedReadsOnly = false;
const transport: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== manifest.origin) {
    externalAttempts++;
    throw new Error("READ_NETWORK_GUARD");
  }
  const body = new URLSearchParams(
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
      ? init.body.toString()
      : "",
  );
  const fn = body.get("wsfunction") ?? "authenticated_file";
  if (auditedReadsOnly && !AUDITED_FUNCTIONS.includes(fn)) {
    throw new Error("READ_FUNCTION_GUARD");
  }
  const headers = new Headers(init?.headers);
  calls.push({
    fn,
    token_present: body.has("wstoken") || url.searchParams.has("token"),
    authorization_present: headers.has("authorization"),
    origin: url.origin,
  });
  const response = await fetch(input, { ...init, redirect: "error" });
  await afterResponse?.(fn);
  return response;
};
let activeManifest = manifest;
const adapter = () => new MoodleLabAdapter(activeManifest, "labstudentb", instanceFile, transport);
let fixture: Json;
const owner = crypto.randomUUID();
const principal = { ownerId: owner, sessionId: crypto.randomUUID(), clientId: "lab-read" };
const dbUrl = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const dbTarget = new URL(dbUrl);
if (
  dbTarget.hostname !== "127.0.0.1" || dbTarget.port !== "55432" || dbTarget.pathname !== "/arahub"
) {
  throw new Error("READ_GUARD_DATABASE");
}
const db = createDb(dbUrl);
const hub = new Hub(db);
let client: Client | undefined;
let server: Deno.HttpServer | undefined;
let connectionId: string;
let tokenOutstanding = false;
let suspended = false;
let stealthOutstanding = false;
let assignmentsOutstanding = false;
const call = async (name: string, args: Json = {}): Promise<Json> => {
  const reply = await client!.callTool({ name, arguments: args });
  const content = reply.content as Array<{ text: string }>;
  const data = JSON.parse(content[0].text);
  if (reply.isError) throw new Error(data.code ?? "READ_MCP_ERROR");
  return data;
};
const content = (kind: string) =>
  call("hub_moodle_content", {
    connection_id: connectionId,
    course_id: fixture.course_id,
    kind,
  });
const modules = (structure: Json): Json[] =>
  (structure.data ?? []).flatMap((s: Json) => s.modules ?? []);
const module = (structure: Json, id: number) => modules(structure).find((m) => m.id === id);
const check = (checks: Json, detail: Json = {}): Json => ({
  status: Object.values(checks).every((v) => v === true) ? "pass" : "fail",
  checks,
  ...detail,
});
const sync = () =>
  call("hub_sync_moodle_course", { connection_id: connectionId, course_id: fixture.course_id });
async function entities(kind: string): Promise<Json[]> {
  const found: Json[] = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const result = await call("hub_entities", { connection_id: connectionId, kind, offset });
    found.push(...result.records);
    if (result.next_offset === null) return found;
    offset = result.next_offset;
  }
  throw new Error("READ_ENTITY_PAGE_LIMIT");
}
async function entity(kind: string, suffix: string): Promise<Json> {
  const found = (await entities(kind)).find((e) => String(e.external_id).endsWith(suffix));
  if (!found) throw new Error("READ_ENTITY_NOT_FOUND");
  return found;
}
async function versions(id: string): Promise<Json[]> {
  return (await call("hub_observations", { entity_id: id })).records;
}
async function finishSync(): Promise<Json[]> {
  const summaries: Json[] = [];
  for (let i = 0; i < 8; i++) {
    const result = await sync();
    if (!result.summary) throw new Error("READ_SYNC_NO_SUMMARY");
    summaries.push(result.summary);
    if (!result.summary.checkpoint?.pending) return summaries;
  }
  throw new Error("READ_SYNC_RESUME_LIMIT");
}

try {
  fixture = await cli("setup");
  if (fixture.course_id <= 4 || fixture.student_id !== manifest.accounts.labstudentb.userid) {
    throw new Error("READ_GUARD_FIXTURE");
  }
  report.fixture = fixture;
  await save();
  await db`insert into auth.users(id) values(${owner})`;
  const connection = await hub.connect(
    principal,
    "moodle",
    "Read suite",
    manifest.origin,
    String(fixture.student_id),
    {},
  );
  connectionId = connection.id as string;
  const connections = {
    parent: (p: { ownerId: string }, id: string) => {
      if (p.ownerId !== owner || id !== connectionId) throw new Error("READ_CONNECTION_SCOPE");
      return { id, provider_subject: String(fixture.student_id), oauth_epoch: 0 };
    },
    moodle: (p: { ownerId: string }, id: string, options?: { onRequest?: () => void }) => {
      if (p.ownerId !== owner || id !== connectionId) throw new Error("READ_CONNECTION_SCOPE");
      return new MoodleLabAdapter(
        activeManifest,
        "labstudentb",
        instanceFile,
        async (input, init) => {
          options?.onRequest?.();
          return await transport(input, init);
        },
      );
    },
  } as unknown as ConnectionService;
  const bearer = crypto.randomUUID();
  secrets.push(bearer);
  server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const publicUrl = "http://127.0.0.1:" + (server!.addr as Deno.NetAddr).port;
    return createHandler(hub, {
      publicUrl,
      auth: { issuer: "https://synthetic.invalid", resource: publicUrl + "/mcp" },
      verify: () => {
        if (req.headers.get("authorization") !== "Bearer " + bearer) {
          throw new Error("READ_AUTH_FIXTURE");
        }
        return Promise.resolve(principal);
      },
      connections,
    })(req);
  });
  client = new Client({ name: "lab-read-proof", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1:" + (server.addr as Deno.NetAddr).port + "/mcp"),
      { requestInit: { headers: { Authorization: "Bearer " + bearer } } },
    ),
  );

  await test("READ-02", async () => {
    stealthOutstanding = true;
    try {
      report.stealth_config = { enabled: await cli("stealth-enable") };
      const structure = await content("structure");
      const pages = await content("pages");
      const stealth = module(structure, fixture.stealth_cmid);
      const page = pages.data?.find((p: Json) => p.id === fixture.stealth_id);
      const outcome = check({
        accessible: stealth?.uservisible === true,
        outside_course_page: stealth?.visibleoncoursepage === 0,
        actual_body: String(page?.content).includes("READ_STEALTH_BODY_" + run),
        direct_locator: stealth?.url?.endsWith("id=" + fixture.stealth_cmid) === true,
      }, {
        coverage: { structure: structure.coverage, pages: pages.coverage },
        cmid: fixture.stealth_cmid,
        allowstealth: report.stealth_config.enabled,
        stored_visibleoncoursepage: fixture.stored_visibleoncoursepage,
        effective_visibleoncoursepage: stealth?.visibleoncoursepage,
      });
      return outcome;
    } finally {
      report.stealth_config ??= {};
      report.stealth_config.restoration = await cli("stealth-restore");
      stealthOutstanding = false;
    }
  });
  await test("READ-03", async () => {
    const structure = await content("structure");
    const books = await content("books");
    const book = module(structure, fixture.book_cmid);
    const chapterFiles = (book?.contents ?? []).filter((c: Json) => c.filename === "index.html");
    const details = [];
    const direct = adapter();
    await direct.getCourseContents(fixture.course_id);
    for (const [i, chapter] of chapterFiles.entries()) {
      const raw = await direct.downloadFile(chapter.file?.file_id);
      const rawHtml = raw.data ? new TextDecoder().decode(raw.data.bytes) : "";
      const saved = await call("hub_preserve_moodle_material", {
        connection_id: connectionId,
        course_id: fixture.course_id,
        file_id: chapter.file?.file_id,
      });
      const file = saved.memory_commit;
      if (!file) {
        details.push({ body: false });
        continue;
      }
      const read = await call("hub_file_text", { file_id: file.id, sha256: file.sha256 });
      const text = String(read.excerpt);
      details.push({
        body: text.includes("READ_BOOK_" + (i === 0 ? "CALENDAR" : "TASK") + "_" + run),
        locator: chapter.file?.url?.includes("/mod_book/chapter/"),
        internal_link: text.includes("/mod/page/view.php?id=" + fixture.stealth_cmid),
        external_link: text.includes("https://example.org/read-reference"),
        raw_html_internal_link: rawHtml.includes("/mod/page/view.php?id=" + fixture.stealth_cmid),
        raw_html_external_link: rawHtml.includes("https://example.org/read-reference"),
        coverage: read.coverage,
        hash: file.sha256,
        bytes: Number(file.bytes),
      });
    }
    return check({
      two_chapters: details.length === 2,
      actual_bodies: details.every((d) => d.body),
      locators: details.every((d) => d.locator),
      links: details.every((d) => d.internal_link && d.external_link),
      metadata_without_claiming_body:
        !(JSON.stringify(books.data).includes("READ_BOOK_CALENDAR_" + run)),
    }, {
      chapters: details,
      books_metadata_coverage: books.coverage,
      interpretation: "books endpoint supplies metadata; chapter bytes preserved/read separately",
    });
  });
  await test("READ-04", async () => {
    const before = calls.length;
    const structure = await content("structure");
    const urls = await content("urls");
    const external = module(structure, fixture.url_cmid)?.contents?.find((c: Json) =>
      c.type === "url"
    );
    const file = module(structure, fixture.resource_cmid)?.contents?.find((c: Json) => c.file)
      ?.file;
    const saved = await call("hub_preserve_moodle_material", {
      connection_id: connectionId,
      course_id: fixture.course_id,
      file_id: file?.file_id,
    });
    const text = saved.memory_commit
      ? await call("hub_file_text", {
        file_id: saved.memory_commit.id,
        sha256: saved.memory_commit.sha256,
      })
      : {};
    return check({
      external_link_preserved: external?.external_url === "https://example.org/read-reference",
      external_reference_only: external?.reference_only === true && !external?.file,
      urls_endpoint_agrees: urls.data?.some((u: Json) =>
        u.externalurl === external?.external_url
      ) === true,
      no_external_request: externalAttempts === 0,
      authenticated_download: calls.slice(before).some((c) =>
        c.fn === "authenticated_file" && c.token_present
      ),
      bytes_match: saved.memory_commit?.sha256 === fixture.file_sha256,
      body: String(text.excerpt).includes("READ_AUTH_FILE_" + run),
    }, {
      external_requests: externalAttempts,
      requests: calls.length - before,
      divergence_root:
        "Moodle exports a url in fileurl/type=url; only type=file uses authenticated pluginfile",
    });
  });

  if (!Deno.args.includes("--direct")) {
    await test("READ-01", async () => {
      auditedReadsOnly = true;
      try {
        const firstRead = calls.length;
        const identity = await adapter().getIdentity();
        if (identity.data?.user_id !== fixture.student_id) throw new Error("READ_STUDENT_IDENTITY");
        fixture = await cli("assignments");
        report.fixture = fixture;
        const targets: Json[] = fixture.read01_assignments;
        const visible = targets[0];
        const denied = targets.slice(1);
        const beforeAssignments = await content("assignments");
        const beforeStructure = await content("structure");
        const baseline = await finishSync();
        const beforeModules = await entities("module");
        const beforeEntities = await entities("assignment");
        const retained: Json[] = [];
        for (const target of targets) {
          for (
            const [kind, suffix] of [
              ["assignment", "/assignment/" + target.id],
              ["module", "/module/" + target.cmid],
            ]
          ) {
            const item = await entity(kind, suffix);
            retained.push({ kind, suffix, id: item.id, observations: await versions(item.id) });
          }
        }
        const resource = await entity("module", "/module/" + fixture.resource_cmid);
        retained.push({
          kind: "module",
          suffix: "/module/" + fixture.resource_cmid,
          id: resource.id,
          observations: await versions(resource.id),
        });
        diagnostics.baseline = {
          assignments: beforeAssignments.data?.length,
          warnings: beforeAssignments.warnings?.length,
          module_entities: beforeModules.length,
          retained_entities: retained.length,
        };
        let partialAssignments: Json = {}, partialStructure: Json = {}, partialSync: Json = {};
        let repeatedSync: Json = {}, visibleMemory: Json = {};
        let sameEntities = false, historyRetained = false, historyReadable = false;
        let noResourcesLost = false, repeatedNoDuplicates = false;
        const observationCounts: Json[] = [];
        try {
          assignmentsOutstanding = true;
          report.read01_visibility = { denied: await cli("assignments-deny") };
          partialStructure = await content("structure");
          partialAssignments = await content("assignments");
          partialSync = await sync();
          repeatedSync = await sync();
          sameEntities = true;
          historyRetained = true;
          historyReadable = true;
          for (const previous of retained) {
            const current = await entity(previous.kind, previous.suffix);
            const history = await versions(current.id);
            sameEntities &&= current.id === previous.id;
            historyRetained &&= previous.observations.length > 0 &&
              previous.observations.every((v: Json) => history.some((w) => w.id === v.id));
            for (const prior of previous.observations) {
              const read = await call("hub_observation", { observation_id: prior.id });
              historyReadable &&= typeof read.excerpt === "string" && read.excerpt.length > 0;
              if (previous.kind === "assignment") {
                const target = targets.find((t) => previous.suffix === "/assignment/" + t.id)!;
                historyReadable &&= read.excerpt.includes(
                  "READ_ASSIGN_" + target.index + "_" + run,
                );
              }
            }
            observationCounts.push({
              entity_id: current.id,
              before: previous.observations.length,
              during: history.length,
            });
          }
          const duringModules = await entities("module");
          const duringAssignments = await entities("assignment");
          noResourcesLost = beforeModules.every((e) => duringModules.some((r) => r.id === e.id)) &&
            beforeEntities.every((e) => duringAssignments.some((r) => r.id === e.id));
          repeatedNoDuplicates = duringAssignments.length === beforeEntities.length &&
            duringModules.length === beforeModules.length;
          const visibleEntity = await entity("assignment", "/assignment/" + visible.id);
          visibleMemory = await call("hub_observation", {
            observation_id: (await versions(visibleEntity.id))[0].id,
          });
        } finally {
          report.read01_visibility ??= {};
          report.read01_visibility.restoration = await cli("assignments-restore");
          assignmentsOutstanding = false;
        }
        const restoredAssignments = await content("assignments");
        const restoredStructure = await content("structure");
        const restoredSync = await finishSync();
        let restoredIdentities = true, restoredHistory = true;
        for (const previous of retained) {
          const current = await entity(previous.kind, previous.suffix);
          const history = await versions(current.id);
          restoredIdentities &&= current.id === previous.id;
          restoredHistory &&= previous.observations.every((v: Json) =>
            history.some((w) => w.id === v.id)
          );
        }
        const warnings = (partialAssignments.warnings ?? []).map((w: Json) => ({
          item: w.item,
          itemid: w.itemid,
          warningcode: w.warningcode,
        }));
        return check({
          student_identity: identity.coverage === "complete" &&
            identity.data?.user_id === fixture.student_id,
          read_only_functions: calls.slice(firstRead).every((c) =>
            AUDITED_FUNCTIONS.includes(c.fn)
          ),
          baseline_all_assignments: beforeAssignments.coverage === "complete" &&
            beforeAssignments.data?.length === 3 && beforeAssignments.warnings?.length === 0,
          baseline_structure: targets.every((t) =>
            module(beforeStructure, t.cmid)?.uservisible === true
          ),
          visible_structure_preserved: module(partialStructure, visible.cmid)?.uservisible === true,
          hidden_structure_excluded: denied.every((t) => !module(partialStructure, t.cmid)),
          visible_assignment_and_body: partialAssignments.data?.length === 1 &&
            partialAssignments.data[0].id === visible.id &&
            String(partialAssignments.data[0].intro).includes("READ_ASSIGN_0_" + run),
          coexistence_warnings: warnings.length === denied.length &&
            denied.every((t) =>
              warnings.some((w: Json) =>
                w.item === "module" && w.itemid === t.cmid && w.warningcode === "1"
              )
            ),
          assignments_partial_not_empty: partialAssignments.coverage === "partial" &&
            partialAssignments.empty === false && partialAssignments.error_code === null,
          sync_not_complete: [partialSync, repeatedSync].every((s) =>
            ["partial", "unavailable"].includes(s.summary?.coverage) && s.job?.state === "partial"
          ),
          aggregate_gap_explained: [partialSync, repeatedSync].every((s) =>
            s.summary?.coverage === "partial" ||
            s.summary?.gaps?.some((g: Json) =>
                g.stage === "course_completion" && g.coverage === "unavailable" &&
                g.moodle_code === "nocriteriaset"
              ) === true
          ),
          assignment_gap_explicit: partialSync.summary?.gaps?.some((g: Json) =>
            g.stage === "assignments" && g.coverage === "partial"
          ) === true,
          visible_observation_partial: visibleMemory.coverage === "partial" &&
            String(visibleMemory.excerpt).includes("READ_ASSIGN_0_" + run),
          same_entities: sameEntities,
          no_resources_lost: noResourcesLost,
          history_retained: historyRetained,
          history_readable_while_denied: historyReadable,
          repeated_sync_no_duplicate_entities: repeatedNoDuplicates,
          visibility_restored: report.read01_visibility.restoration.restored === true,
          student_access_restored: restoredAssignments.coverage === "complete" &&
            restoredAssignments.warnings?.length === 0 && restoredAssignments.data?.length === 3 &&
            targets.every((t) =>
              module(restoredStructure, t.cmid)?.uservisible === true &&
              restoredAssignments.data.some((a: Json) =>
                a.id === t.id &&
                String(a.intro).includes("READ_ASSIGN_" + t.index + "_" + run)
              )
            ),
          restored_identities: restoredIdentities,
          restored_history: restoredHistory,
          no_restored_assignment_gap: restoredSync.every((s) =>
            !s.gaps.some((g: Json) =>
              g.stage === "assignments"
            )
          ),
        }, {
          student_id: identity.data?.user_id,
          moodle_release: identity.data?.release,
          functions_called: [...new Set(calls.slice(firstRead).map((c) => c.fn))].sort(),
          mutation: "two owned assignments hidden with Moodle visibility API, restored in finally",
          assignments: targets.map((t) => ({ id: t.id, cmid: t.cmid })),
          warnings,
          coverage: {
            structure: partialStructure.coverage,
            assignments: partialAssignments.coverage,
            baseline_sync: baseline.at(-1)?.coverage,
            partial_sync: partialSync.summary?.coverage,
            repeated_sync: repeatedSync.summary?.coverage,
            restored_assignments: restoredAssignments.coverage,
            restored_sync: restoredSync.at(-1)?.coverage,
          },
          refresh_gaps: partialSync.summary?.gaps,
          job_states: [partialSync.job?.state, repeatedSync.job?.state],
          observation_counts: observationCounts,
          limits:
            "structure complete is endpoint-scoped; sync is not complete (nocriteriaset can dominate as unavailable); no hosted/OAuth/UI proof",
        });
      } finally {
        auditedReadsOnly = false;
      }
    });
    await test("READ-05", async () => {
      await finishSync();
      const item = await entity("page", "/page/" + fixture.movable_id);
      const before = await versions(item.id);
      let denial: Json = {}, unavailable: Json = {}, memory: Json = {}, absent = false;
      try {
        suspended = true;
        await cli("suspend");
        denial = await content("structure");
        const courses = await call("hub_moodle_courses", { connection_id: connectionId });
        absent = !courses.data?.some((c: Json) => c.id === fixture.course_id);
        unavailable = await sync();
        memory = await call("hub_observation", { observation_id: before[0].id });
      } finally {
        await cli("restore");
        suspended = false;
      }
      const restored = await content("pages");
      await finishSync();
      const after = await entity("page", "/page/" + fixture.movable_id);
      const history = await versions(after.id);
      return check({
        live_access_denied: denial.coverage === "denied",
        explicit_refresh_gap: unavailable.summary?.gaps?.some((g: Json) =>
          g.coverage === "denied"
        ) === true,
        memory_readable_during_revocation: String(memory.excerpt).includes("READ_MOVABLE_" + run),
        restored_body: restored.data?.some((p: Json) =>
          p.id === fixture.movable_id && String(p.content).includes("READ_MOVABLE_" + run)
        ) === true,
        stable_entity: after.id === item.id,
        history_retained: before.every((v) => history.some((w) => w.id === v.id)),
        no_duplicate_identity: (await entities("page")).filter((e) =>
          e.external_id === item.external_id
        ).length === 1,
      }, {
        revoked_structure_coverage: denial.coverage,
        revoked_structure_error: denial.error_code,
        course_absent_from_listing: absent,
        refresh_coverage: unavailable.summary?.coverage,
        revoked_error_detail: denial.error_detail,
        refresh_gaps: unavailable.summary?.gaps,
        observation_counts: [before.length, history.length],
        entity_id: item.id,
        mode: "manual enrolment suspended and restored using enrol API",
      });
    });
    await test("READ-06", async () => {
      await finishSync();
      const before = await entity("module", "/module/" + fixture.movable_cmid);
      const historyBefore = await versions(before.id);
      const moved = await cli("moverename");
      await finishSync();
      const after = await entity("module", "/module/" + fixture.movable_cmid);
      const context = await call("hub_entity_context", { entity_id: after.id });
      const history = await versions(after.id);
      const parents = context.relations.filter((r: Json) =>
        r.kind === "has_module" && r.to_id === after.id
      );
      const old = await call("hub_observation", { observation_id: historyBefore[0].id });
      const returned = await cli("moveback");
      await finishSync();
      const again = await entity("module", "/module/" + fixture.movable_cmid);
      const contextAgain = await call("hub_entity_context", { entity_id: again.id });
      const historyAgain = await versions(again.id);
      const parentsAgain = contextAgain.relations.filter((r: Json) =>
        r.kind === "has_module" && r.to_id === again.id
      );
      const movedObservation = await call("hub_observation", { observation_id: history[0].id });
      const returnedObservation = await call("hub_observation", {
        observation_id: historyAgain[0].id,
      });
      return check({
        identity: before.id === after.id,
        renamed: after.title === "Movable after",
        current_section: context.entity.state.section_id === moved.new_section,
        prior_observation_readable: String(old.excerpt).includes("Movable before"),
        history_retained: historyBefore.every((v) => history.some((w) => w.id === v.id)),
        single_current_parent: parents.length === 1,
        return_identity: again.id === before.id,
        return_name_and_section: again.title === "Movable before" &&
          contextAgain.entity.state.section_id === moved.old_section &&
          returned.new_section === moved.old_section,
        return_single_current_parent: parentsAgain.length === 1,
        return_different_parent: parents.length === 1 && parentsAgain.length === 1 &&
          parents[0].from_id !== parentsAgain[0].from_id,
        history_a_b_a: String(movedObservation.excerpt).includes("Movable after") &&
          String(returnedObservation.excerpt).includes("Movable before") &&
          historyAgain[0].id !== historyBefore[0].id && history.every((v) =>
            historyAgain.some((w) => w.id === v.id)
          ),
      }, {
        cmid: fixture.movable_cmid,
        entity_id: after.id,
        before_section: moved.old_section,
        after_section: moved.new_section,
        has_module_parent_count: parents.length,
        returned_section: returned.new_section,
        returned_has_module_parent_count: parentsAgain.length,
        observation_counts: [historyBefore.length, history.length, historyAgain.length],
        relation_limitation: parents.length > 1
          ? "Old has_module edge remains indistinguishable from current parent"
          : null,
      });
    });
    await test("READ-07", async () => {
      fixture = await cli("forum");
      report.fixture = fixture;
      const discussionPages: Json[] = [];
      const discussions: Json[] = [];
      for (let page = 0; page < 10; page++) {
        const result = await call("hub_moodle_discussions", {
          connection_id: connectionId,
          forum_id: fixture.forum_id,
          page,
          per_page: 20,
        });
        discussionPages.push({
          page,
          count: result.data?.length,
          coverage: result.coverage,
          has_more: result.pagination?.has_more,
        });
        discussions.push(...(result.data ?? []));
        if (!result.pagination?.has_more) break;
      }
      const postPages: Json[] = [];
      const posts: Json[] = [];
      for (const offset of [0, 100]) {
        const result = await call("hub_moodle_posts", {
          connection_id: connectionId,
          discussion_id: fixture.long_discussion_id,
          offset,
          limit: 100,
        });
        postPages.push({
          offset,
          count: result.data?.length,
          coverage: result.coverage,
          truncated: result.truncated,
          has_more: result.pagination?.has_more,
        });
        posts.push(...(result.data ?? []));
      }
      const baseline = await finishSync();
      diagnostics.discussion_pages = discussionPages;
      diagnostics.post_pages = postPages;
      diagnostics.baseline = baseline;
      diagnostics.post_entities = (await entities("post")).length;
      diagnostics.discussion_entities = (await entities("discussion")).length;
      await save();
      const oldEntity = await entity("post", "/post/" + fixture.old_post_id);
      const before = await versions(oldEntity.id);
      const oldPage = Math.floor(
        discussions.findIndex((d) => d.discussion_id === fixture.long_discussion_id) / 20,
      );
      await cli("editold");
      const firstPageAfter = await call("hub_moodle_discussions", {
        connection_id: connectionId,
        forum_id: fixture.forum_id,
        page: 0,
        per_page: 20,
      });
      const refresh = await finishSync();
      const oldContext = await call("hub_entity_context", { entity_id: oldEntity.id });
      const history = await versions(oldEntity.id);
      const previous = await call("hub_observation", { observation_id: before[0].id });
      const mirrored = await entities("post");
      return check({
        all_discussion_pages: discussions.length === 45 &&
          new Set(discussions.map((d) => d.discussion_id)).size === 45,
        all_posts: posts.length === 130 && new Set(posts.map((p) => p.id)).size === 130,
        first_post_page_partial: postPages[0].coverage === "partial" && postPages[0].has_more,
        old_discussion_outside_recent: oldPage >= 1 &&
          !firstPageAfter.data.some((d: Json) => d.discussion_id === fixture.long_discussion_id),
        bounded_resume: baseline.some((s) => s.checkpoint?.pending && s.coverage !== "complete") &&
          baseline.at(-1)?.checkpoint?.pending === false,
        edited_body_observed: JSON.stringify(oldContext.entity.state.provider_record).includes(
          "READ_OLD_AFTER_" + run,
        ),
        previous_body_preserved: String(previous.excerpt).includes("READ_OLD_BEFORE_" + run),
        history_grew: history.length > before.length,
        no_lost_posts: mirrored.length === 174,
      }, {
        discussion_pages: discussionPages,
        post_pages: postPages,
        old_discussion_page: oldPage,
        baseline_runs: baseline.map((s) => ({
          coverage: s.coverage,
          checkpoint: s.checkpoint,
          counts: s.counts,
        })),
        refresh_runs: refresh.map((s) => ({
          coverage: s.coverage,
          checkpoint: s.checkpoint,
          counts: s.counts,
        })),
        mirror_posts: mirrored.length,
      });
    });
    await test("READ-08", async () => {
      const memoryEntity = await entity("page", "/page/" + fixture.movable_id);
      const beforeMemory = await versions(memoryEntity.id);
      const issued = await cli("token");
      tokenOutstanding = true;
      if (secrets.includes(issued.token)) throw new Error("READ_GUARD_TOKEN_REUSED");
      secrets.push(issued.token);
      activeManifest = {
        ...manifest,
        accounts: {
          ...manifest.accounts,
          labstudentb: { userid: fixture.student_id, token: issued.token },
        },
      };
      let revokedAt: string | null = null;
      let initialRead: Json = {};
      const started = performance.now();
      const firstCall = calls.length;
      try {
        initialRead = await call("hub_moodle_courses", { connection_id: connectionId });
        afterResponse = async (fn) => {
          if (fn !== "core_course_get_contents" || revokedAt) return;
          await cli("revoke");
          tokenOutstanding = false;
          revokedAt = fn;
        };
        const refresh = await sync();
        afterResponse = null;
        const denied = await content("pages");
        const memory = await call("hub_observation", { observation_id: beforeMemory[0].id });
        const callCount = calls.length - firstCall;
        activeManifest = manifest;
        const original = await content("pages");
        return check({
          disposable_initially_valid: initialRead.coverage === "complete",
          revoked_during_read: revokedAt === "core_course_get_contents",
          expired_refresh: refresh.summary?.coverage === "expired",
          explicit_invalid_token: denied.coverage === "expired" &&
            denied.error_code === "invalid_token",
          memory_remains_readable: String(memory.excerpt).includes("READ_MOVABLE_" + run),
          bounded_requests: callCount < 30,
          manifest_token_intact: original.coverage === "complete",
        }, {
          revoked_after: revokedAt,
          request_count: callCount,
          elapsed_ms: Math.round(performance.now() - started),
          refresh_coverage: refresh.summary?.coverage,
          refresh_gaps: refresh.summary?.gaps,
          read_coverage: denied.coverage,
          read_error: denied.error_code,
        });
      } finally {
        afterResponse = null;
        activeManifest = manifest;
        if (tokenOutstanding) {
          await cli("revoke");
          tokenOutstanding = false;
        }
      }
    });
    await test("READ-09", async () => {
      const second = await hub.connect(
        principal,
        "moodle",
        "Synthetic second namespace",
        "https://second-moodle.invalid",
        String(fixture.student_id),
        {},
      );
      const sameTitle = "Namespace probe " + run;
      const a = await hub.entity(
        principal,
        connectionId,
        "namespace_probe",
        String(fixture.course_id),
        sameTitle,
        {},
      );
      const b = await hub.entity(
        principal,
        second.id as string,
        "namespace_probe",
        String(fixture.course_id),
        sameTitle,
        {},
      );
      const filtered = await call("hub_entities", {
        connection_id: connectionId,
        kind: "namespace_probe",
      });
      const broad = await call("hub_entities", { kind: "namespace_probe", query: sameTitle });
      return {
        status: "blocked",
        level: "local_database_only",
        physical_two_moodle_test: { status: "not_run", second_instance_exercised: false },
        local_database_proof: check({
          separate_ids: a.id !== b.id,
          selected_connection_isolated: filtered.records.length === 1 &&
            filtered.records[0].id === a.id,
          ambiguous_name_keeps_both: broad.records.length === 2,
        }),
        reason:
          "Second namespace is a local DB fixture. No second-Moodle requests/actions; physical two-site proof requires its own reachable instance and remains blocked",
      };
    });
  }
} catch (error) {
  report.fatal = errorCode(error);
} finally {
  afterResponse = null;
  activeManifest = manifest;
  if (assignmentsOutstanding) {
    try {
      report.read01_visibility ??= {};
      report.read01_visibility.restoration = await cli("assignments-restore");
      assignmentsOutstanding = false;
    } catch {
      report.assignments_restore_failed = true;
    }
  }
  if (stealthOutstanding) {
    try {
      report.stealth_config ??= {};
      report.stealth_config.restoration = await cli("stealth-restore");
      stealthOutstanding = false;
    } catch {
      report.stealth_restore_failed = true;
    }
  }
  if (suspended) {
    try {
      await cli("restore");
      suspended = false;
    } catch {
      report.restore_failed = true;
    }
  }
  if (tokenOutstanding) {
    try {
      await cli("revoke");
      tokenOutstanding = false;
    } catch {
      report.token_cleanup_failed = true;
    }
  }
  try {
    await client?.close();
  } catch { /* already closed */ }
  try {
    await server?.shutdown();
  } catch { /* already closed */ }
  try {
    await db`delete from auth.users where id=${owner}`;
  } catch {
    report.local_owner_cleanup_failed = true;
  }
  await db.end();
  report.finished_at = new Date().toISOString();
  report.request_count = calls.length;
  report.external_requests = externalAttempts;
  if (
    report.restore_failed || report.assignments_restore_failed || report.stealth_restore_failed ||
    report.token_cleanup_failed ||
    report.local_owner_cleanup_failed
  ) {
    report.fatal = report.fatal ?? "READ_CLEANUP_FAILED";
  }
  report.levels.lab_integration = report.fatal
    ? "error"
    : results.some((r) => r.status === "fail" || r.status === "error")
    ? "fail"
    : results.some((r) => r.status === "blocked")
    ? "incomplete"
    : "pass";
  await save();
  console.log("evidence: " + evidencePath);
}
if (report.fatal || results.some((r) => r.status === "fail" || r.status === "error")) {
  Deno.exitCode = 1;
}
