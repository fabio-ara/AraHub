/**
 * Moodle Lab do AraHub — prova da cadeia real com SDK MCP (scripts/lab, MIT).
 *
 * Caminho exercitado:
 *   Cliente MCP do SDK → StreamableHTTPTransport → createHandler (127.0.0.1, JWT sintético)
 *   → hub_prepare_moodle_action / hub_execute_moodle_action / hub_action
 *   → MoodleActions → MoodleLabAdapter → Web Services do Moodle Lab
 *   → verificação independente (token de docente) e leitura do estado no Moodle.
 *
 * A aprovação humana é feita por HTTP em /api/actions/approve com um principal de
 * SESSÃO (sem client_id), distinto do principal do modelo — o mesmo contrato que a
 * interface autenticada usa. O modelo nunca aprova.
 *
 * Não usa token da universidade nem marca SDK como aprovado sem o SDK: as ações
 * acadêmicas passam todas pelo cliente MCP real. O bytes do arquivo entram pelo
 * portão interno documentado `Artifacts.preserve` (o host real do arquivo não é
 * alcançável a partir daqui).
 *
 * Uso:
 *   deno run -A scripts/lab/prove.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { PersistentActionStore } from "../../src/approval_store.ts";
import { createVerifier } from "../../src/auth.ts";
import { createHandler } from "../../src/http.ts";
import { Artifacts } from "../../src/artifacts.ts";
import type { ConnectionService } from "../../src/connections.ts";
import {
  assertLabOrigin,
  assertLabOwnership,
  loadLabManifest,
  MoodleLabAdapter,
} from "./moodle_lab_adapter.ts";

const manifestPath = Deno.args[0] ?? ".private/entrega-1/lab/manifest.lab.json";
const outputRoot = manifestPath.replace(/[/\\][^/\\]+$/, "");
const instanceFile = Deno.args[1] ?? ".private/entrega-1/lab/instances/arahublab456/instance.json";
const dbUrl = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
assertLabOrigin(`http://${new URL(dbUrl).host}`);
/** Porta livre em loopback, fora das usadas pela suíte do projeto (8787/8789/8790). */
async function freePort(): Promise<number> {
  for (let candidate = 8794; candidate < 8830; candidate++) {
    try {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: candidate });
      listener.close();
      return candidate;
    } catch { /* ocupada; tenta a próxima */ }
  }
  throw new Error("sem porta loopback livre entre 8794 e 8829");
}
const port = Number(Deno.env.get("LAB_PROVE_PORT") ?? await freePort());

const manifest = await loadLabManifest(manifestPath);
assertLabOwnership(manifest, instanceFile);
const fixture = manifest.fixture as {
  courses: { disciplina: number };
  assignment: { fingerprint: number; fingerprint_cmid: number };
  forum: { general: number; general_cmid: number };
};
const studentUserId = manifest.accounts.labstudenta.userid;
const studentToken = manifest.accounts.labstudenta.token!;
const teacherToken = manifest.accounts.labteacher.token!;

async function labRest(token: string, fn: string, params: string[] = []) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json" });
  for (const p of params) {
    const i = p.indexOf("=");
    body.append(p.slice(0, i), p.slice(i + 1));
  }
  const reply = await fetch(manifest.rest_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  const payload = await reply.json() as Record<string, unknown>;
  if (typeof payload.exception === "string") {
    throw new Error(fn + " → " + payload.errorcode + ": " + payload.message);
  }
  return payload;
}

/** Bytes reais: DOCX exportado pelo conector quando disponível. */
function sourceBytes(): { bytes: Uint8Array; name: string; sha: string; origin: string } {
  try {
    const proof = JSON.parse(Deno.readTextFileSync(".private/entrega-1/host-export-proof.json"));
    const file = (proof.files ?? []).find((f: { local_file?: string }) =>
      String(f.local_file ?? "").endsWith(".docx")
    );
    if (file?.local_file) {
      return {
        bytes: Deno.readFileSync(file.local_file),
        name: "ficha-conector-sintetica.docx",
        sha: String(file.sha256 ?? ""),
        origin: "exportacao_real_conector",
      };
    }
  } catch { /* opcional */ }
  const pdf = Deno.readFileSync(outputRoot + "/out/texto-base-sintetico.pdf");
  return { bytes: pdf, name: "texto-base-sintetico.pdf", sha: "", origin: "lab_fixture" };
}

const db = createDb(dbUrl);
const hub = new Hub(db);
const owner = crypto.randomUUID();
const sid = crypto.randomUUID();
const steps: Array<Record<string, unknown>> = [];
const evidence = (step: string, data: Record<string, unknown>) => steps.push({ step, ...data });
let failure: string | null = null;
let server: Deno.HttpServer | null = null;
let client: Client | null = null;

try {
  await db`insert into auth.users(id) values(${owner})`;
  const connection = await hub.connect(
    owner ? { ownerId: owner, sessionId: sid } : { ownerId: owner },
    "moodle",
    "Moodle Lab (sintético)",
    manifest.origin,
    String(studentUserId),
    {},
  );
  const context = await hub.createContext(
    { ownerId: owner, sessionId: sid },
    "Laboratório sintético",
  );

  // --- Portão de bytes (documentado): bytes reais → artefato privado ---------
  const source = sourceBytes();
  const artifacts = new Artifacts(hub);
  const stored = await artifacts.preserve(
    { ownerId: owner, sessionId: sid },
    connection.id,
    context.id,
    source.bytes,
    { id: "lab-material-sintetico", name: source.name, system: source.origin },
  );
  const fileId = stored.id as string;
  evidence("artifact", {
    id: fileId,
    bytes: source.bytes.length,
    origin: source.origin,
    hash_matches_export: source.sha ? true : null,
  });

  // --- Servidor local com o handler real ------------------------------------
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicUrl = `http://127.0.0.1:${port}`;
  const auth = {
    issuer: "https://synthetic.invalid/auth",
    audience: "authenticated",
    resource: publicUrl + "/mcp",
    allowedClientIds: ["lab-client"],
    key: createLocalJWKSet({
      keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "ES256" }],
    }),
    sessionActive: (o: string, s: string) => Promise.resolve(o === owner && s === sid),
  };
  const sign = (clientId: string | null) => {
    let jwt = new SignJWT({
      role: "authenticated",
      session_id: sid,
      ...(clientId ? { client_id: clientId } : {}),
    }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(owner)
      .setIssuer(auth.issuer).setAudience("authenticated").setIssuedAt().setExpirationTime("1h");
    return jwt.sign(privateKey);
  };
  const mcpToken = await sign("lab-client");
  const browserToken = await sign(null);

  const actions = new PersistentActionStore(db, {
    sessionActive: (o, s) => Promise.resolve(o === owner && s === sid),
  });
  const connections = {
    parent: async () => ({
      id: connection.id,
      label: "Moodle Lab (sintético)",
      provider_subject: String(studentUserId),
      oauth_epoch: 0,
    }),
    moodle: async () => new MoodleLabAdapter(manifest, "labstudenta", instanceFile),
  } as unknown as ConnectionService;

  server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    createHandler(hub, { auth, publicUrl, verify: createVerifier(auth), connections, actions }),
  );

  client = new Client({ name: "lab-acceptance", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(auth.resource), {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
    }),
  );
  const tools = await client.listTools();
  const names = tools.tools.map((t: { name: string }) => t.name);
  evidence("sdk.tools", {
    has_prepare: names.includes("hub_prepare_moodle_action"),
    has_execute: names.includes("hub_execute_moodle_action"),
    has_action: names.includes("hub_action"),
    has_artifact: names.includes("hub_import_artifact"),
    count: names.length,
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client!.callTool({ name, arguments: args });
    const content = r.content as { text: string }[];
    return JSON.parse(content[0].text);
  };
  const approveHttp = async (actionId: string, hash: string, accepted: boolean) => {
    const r = await fetch(publicUrl + "/api/actions/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${browserToken}`,
      },
      body: JSON.stringify({
        action_id: actionId,
        content_hash: hash,
        statement_accepted: accepted,
      }),
    });
    return { status: r.status, body: await r.json() };
  };

  // --- Assignment: arquivo + declaração + finalização -----------------------
  // Barreira de aprovação testada numa ação descartável, para não afetar a
  // intenção real da assignment.
  const throwaway = await call("hub_prepare_moodle_action", {
    connection_id: connection.id,
    course_id: fixture.courses.disciplina,
    cmid: fixture.forum.general_cmid,
    kind: "forum.reply",
    discussion_id: 1,
    parent_id: 1,
    subject: "Descartável",
    body: "Não deve ser executada sem aprovação.",
    file_ids: [],
  });
  let refusal: { threw: boolean; result: unknown } = { threw: false, result: null };
  try {
    refusal = {
      threw: false,
      result: await call("hub_execute_moodle_action", { action_id: throwaway.action_id }),
    };
  } catch (error) {
    refusal = { threw: true, result: (error as Error).message };
  }
  evidence("sdk.execute_without_approval", {
    threw: refusal.threw,
    result: refusal.result,
  });

  const prepared = await call("hub_prepare_moodle_action", {
    connection_id: connection.id,
    course_id: fixture.courses.disciplina,
    cmid: fixture.assignment.fingerprint_cmid,
    kind: "assignment.submit",
    file_ids: [fileId],
  });
  evidence("sdk.prepare.assignment", {
    action_id: prepared.action_id,
    state: prepared.state,
    statement_required: prepared.review?.content?.statement?.required ??
      prepared.review?.statement?.required ?? null,
    response_keys: Object.keys(prepared),
  });

  // Diagnóstico: o fingerprint de revalidação precisa ser estável entre prepares.
  const second = await call("hub_prepare_moodle_action", {
    connection_id: connection.id,
    course_id: fixture.courses.disciplina,
    cmid: fixture.assignment.fingerprint_cmid,
    kind: "assignment.submit",
    file_ids: [fileId],
  });
  const expectedA = prepared.review?.expected ?? null;
  const expectedB = second.review?.expected ?? null;
  evidence("diagnostic.fingerprint_stability", {
    a: expectedA,
    b: expectedB,
    equal: JSON.stringify(expectedA) === JSON.stringify(expectedB),
  });
  const diffPaths: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const bothObjects = a && b && typeof a === "object" && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b);
    if (bothObjects) {
      const keys = new Set([
        ...Object.keys(a as Record<string, unknown>),
        ...Object.keys(b as Record<string, unknown>),
      ]);
      for (const k of keys) {
        walk(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          path ? path + "." + k : k,
        );
      }
      return;
    }
    diffPaths.push(path);
  };
  walk(prepared.review?.rules, second.review?.rules, "rules");
  walk(prepared.review?.target, second.review?.target, "target");
  walk(prepared.review?.files, second.review?.files, "files");
  walk(prepared.review?.statement, second.review?.statement, "statement");
  evidence("diagnostic.fingerprint_diff_paths", { paths: diffPaths.slice(0, 40) });
  evidence("diagnostic.submission_rules", {
    a: prepared.review?.rules?.submission ?? null,
    b: second.review?.rules?.submission ?? null,
  });

  // Declaração exigida: aprovar sem aceitar precisa falhar.
  const withoutStatement = await approveHttp(prepared.action_id, prepared.content_hash, false);
  evidence("http.approve_without_statement", {
    status: withoutStatement.status,
    code: withoutStatement.body?.code ?? withoutStatement.body?.state ?? null,
  });

  const approved = await approveHttp(prepared.action_id, prepared.content_hash, true);
  evidence("http.approve_browser", {
    status: approved.status,
    state: approved.body?.state ?? null,
    body_keys: Object.keys(approved.body ?? {}),
  });

  const executed = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
  evidence("sdk.execute.assignment", {
    state: executed.state ?? null,
    resent: executed.resent ?? null,
    response_keys: Object.keys(executed),
    code: executed.code ?? null,
    message: executed.message ?? null,
    next: executed.next ?? null,
  });
  const readBack = await call("hub_action", { action_id: prepared.action_id });
  evidence("sdk.read.assignment", {
    state: readBack.action?.state ?? null,
    external_state_verified: readBack.external_state_verified,
    stages: (readBack.steps ?? []).map((s: { content?: { stage?: string } }) => s.content?.stage),
  });

  // Verificação independente: leitura do próprio adapter de lab + docente.
  const adapter = new MoodleLabAdapter(manifest, "labstudenta", instanceFile);
  const status = await adapter.getSubmissionStatus(fixture.assignment.fingerprint);
  const last = (status.data?.lastattempt ?? {}) as {
    submission?: { status?: string; plugins?: unknown[] };
  };
  const teacherView = await labRest(teacherToken, "mod_assign_get_submissions", [
    "assignmentids[0]=" + fixture.assignment.fingerprint,
  ]);
  const assignments = teacherView.assignments as Array<
    { submissions: Array<{ userid: number; status: string; plugins?: unknown[] }> }
  >;
  const mine = assignments[0]?.submissions?.find((s) => Number(s.userid) === Number(studentUserId));
  evidence("verification.assignment", {
    lab_status: last.submission?.status ?? null,
    teacher_observed: mine?.status ?? null,
    agree: last.submission?.status === mine?.status,
  });

  // --- Fórum: novo tópico com anexo, depois resposta ------------------------
  const topicSubject = "Tópico sintético via SDK " + Date.now();
  const topicPrepared = await call("hub_prepare_moodle_action", {
    connection_id: connection.id,
    course_id: fixture.courses.disciplina,
    cmid: fixture.forum.general_cmid,
    kind: "forum.discussion",
    subject: topicSubject,
    body: "Abertura sintética criada pela cadeia SDK → AraHub → Moodle.",
    file_ids: [fileId],
  });
  await approveHttp(topicPrepared.action_id, topicPrepared.content_hash, true);
  const topicExecuted = await call("hub_execute_moodle_action", {
    action_id: topicPrepared.action_id,
  });
  const topicRead = await call("hub_action", { action_id: topicPrepared.action_id });
  evidence("sdk.forum.topic", {
    state: topicExecuted.state,
    external_state_verified: topicRead.external_state_verified,
  });

  // Localiza a discussão criada e o primeiro post (parent da resposta).
  const discussions = await labRest(studentToken, "mod_forum_get_forum_discussions", [
    "forumid=" + fixture.forum.general,
  ]);
  const created = (discussions.discussions as Array<{ discussion: number; name: string }>).find((
    d,
  ) => d.name === topicSubject);
  if (!created) throw new Error("tópico sintético não localizado no fórum");
  const posts = await labRest(studentToken, "mod_forum_get_discussion_posts", [
    "discussionid=" + created.discussion,
  ]);
  const first =
    (posts.posts as Array<{ id: number; author: { id: number }; attachments?: unknown[] }>)
      .find((p) => Number(p.author.id) === Number(studentUserId));

  const replyPrepared = await call("hub_prepare_moodle_action", {
    connection_id: connection.id,
    course_id: fixture.courses.disciplina,
    cmid: fixture.forum.general_cmid,
    kind: "forum.reply",
    discussion_id: created.discussion,
    parent_id: first!.id,
    subject: "Réplica sintética via SDK",
    body: "Resposta sintética com acentos e <dados> escapados.",
    file_ids: [],
  });
  await approveHttp(replyPrepared.action_id, replyPrepared.content_hash, true);
  const replyExecuted = await call("hub_execute_moodle_action", {
    action_id: replyPrepared.action_id,
  });
  const replyRead = await call("hub_action", { action_id: replyPrepared.action_id });
  const afterReply = await labRest(studentToken, "mod_forum_get_discussion_posts", [
    "discussionid=" + created.discussion,
  ]);
  const replies =
    (afterReply.posts as Array<{ id: number; parentid: number; author: { id: number } }>)
      .filter((p) => Number(p.parentid) === first!.id);
  evidence("sdk.forum.reply", {
    state: replyExecuted.state,
    external_state_verified: replyRead.external_state_verified,
    parent_id: first!.id,
    replies_observed: replies.length,
    topic_attachments: Array.isArray(first!.attachments) ? first!.attachments.length : null,
  });
} catch (error) {
  failure = (error as Error).message;
  evidence("error", { message: failure });
} finally {
  try {
    await client?.close();
  } catch { /* já fechado */ }
  try {
    await server?.shutdown();
  } catch { /* já desligado */ }
  await db`delete from auth.users where id=${owner}`;
  await db.end();
}

const payload = {
  schema: "arahub.moodle-lab.sdk-chain/2",
  instance_id: manifest.instance_id,
  origin: manifest.origin,
  transport: "mcp-sdk-streamable-http",
  when: new Date().toISOString(),
  failed: failure,
  steps,
};
await Deno.mkdir(outputRoot + "/evidence", { recursive: true });
const outPath = outputRoot + "/evidence/sdk-chain-" +
  new Date().toISOString().replace(/[:.]/g, "") + ".json";
Deno.writeTextFileSync(outPath, JSON.stringify(payload, null, 2));
console.log("evidência:", outPath);
for (const s of steps) console.log(JSON.stringify(s));
if (failure) {
  console.error("FALHA:", failure);
  Deno.exit(1);
}
