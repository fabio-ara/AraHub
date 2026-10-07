/**
 * Bounded memory/time regression probes. Real AraHub + local PostgreSQL + MCP SDK;
 * source records and the OPS provider transport are explicitly synthetic fixtures.
 * Never connects to Moodle/Google/hosted databases or reads another Lab's fixture.
 * Existing passing regressions are mapped, not executed again.
 *
 * deno run --allow-net=127.0.0.1 --allow-env --allow-read=src,tests,.private/entrega-1/tests-final.log --allow-write=.private/entrega-1/memory-scenarios scripts/lab/memory_prove.ts
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asOwner, createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { ConnectionService } from "../../src/connections.ts";
import { TokenVault } from "../../src/adapters/token_vault.ts";
import { AUDITED_FUNCTIONS, MoodleAdapter } from "../../src/adapters/moodle.ts";
import { handleMcp } from "../../src/mcp.ts";
import { Sync } from "../../src/sync.ts";
import { Attention } from "../../src/attention.ts";
import { Jobs } from "../../src/jobs.ts";
import { sha256Hex } from "../../src/migration.ts";

// Fixed loopback target: environment variables cannot redirect this mutable probe.
const DATABASE = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const OUT = ".private/entrega-1/memory-scenarios";
const command =
  "deno run --allow-net=127.0.0.1 --allow-env --allow-read=src,tests,.private/entrega-1/tests-final.log --allow-write=.private/entrega-1/memory-scenarios scripts/lab/memory_prove.ts";
type Json = Record<string, any>; // SDK JSON boundary; assertions validate fields used below.
type Result = { id: string; status: "passed" | "failed"; proof: string; details: Json };
const results: Result[] = [];
const selected = Deno.args.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const allowedScenarios = [
  "MEM-03",
  "MEM-04",
  "MEM-06",
  "TIME-01",
  "TIME-02",
  "TIME-03",
  "ATTN-01",
  "ATTN-02",
  "MAT-05",
  "OPS-02",
];
assert.ok(
  !selected || selected.every((id) => allowedScenarios.includes(id)),
  "Cenário fora do escopo",
);
const enabled = (id: string) => !selected || selected.includes(id);
let executionComplete = false;
const owner = { ownerId: crypto.randomUUID() };
const other = { ownerId: crypto.randomUUID() };
let db = createDb(DATABASE);
let hub = new Hub(db);
const vault = await TokenVault.fromRawKeys([
  { kid: "memory-probe", key: crypto.getRandomValues(new Uint8Array(32)) },
]);
let service = new ConnectionService(hub, vault);
let server: Deno.HttpServer | undefined;
let client: Client | undefined;
const hash = (value: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
const record = (id: string, details: Json, status: "passed" | "failed" = "passed") => {
  results.push({ id, status, proof: "local_postgres_mcp_sdk_synthetic_sources", details });
  console.log(`${id}: ${status}`);
};
async function startSdk() {
  // Principal injection is an explicit local authentication fixture, not an OAuth proof.
  server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => handleMcp(request, hub, owner, service),
  );
  client = new Client({ name: "memory-scenarios-local", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/mcp`),
    ),
  );
}
async function stopSdk() {
  await client?.close();
  client = undefined;
  await server?.shutdown();
  server = undefined;
}
async function call(name: string, args: Json): Promise<Json> {
  const answer = await client!.callTool({ name, arguments: args });
  const content = answer.content as Array<{ type: string; text?: string }>;
  const parsed = JSON.parse(content.find((item) => item.type === "text")!.text!);
  assert.ok(!answer.isError, `${name}: ${parsed.code ?? "tool_error"}`);
  return parsed;
}
async function observe(
  connectionId: string,
  entityId: string,
  content: Json,
  observedAt: string,
  extra: Json = {},
) {
  const digest = await hash(content);
  const provenance = {
    system: "moodle",
    connection_id: connectionId,
    locator: `synthetic:memory-probe/${entityId}`,
    fixture: true,
    ...extra,
  };
  await asOwner(db, owner, async (tx) => {
    await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
      values(${owner.ownerId},${entityId},${tx.json(content)},${digest},${
      tx.json(provenance)
    },'complete',${observedAt}::timestamptz)
      on conflict(owner_id,entity_id,content_hash) do nothing`;
    await tx`update public.hub_entities set state=state || ${
      tx.json({ provider_record: content })
    }::jsonb
      where owner_id=${owner.ownerId} and id=${entityId}`;
  });
  const versions = await hub.observations(owner, entityId);
  return { id: String(versions.records[0].id), hash: digest };
}
async function context(title: string) {
  return await call("hub_create_context", { title: `[SINTÉTICO] ${title}` });
}
function delta(contextId: string, version: number, content: string, extra: Json = {}) {
  return {
    context_id: contextId,
    expected_version: version,
    idempotency_key: crypto.randomUUID(),
    kind: "artifact",
    evidence_kind: "user_report",
    content,
    provenance: [{ system: "synthetic", locator: "fixture:memory-probe" }],
    ...extra,
  };
}

const log = await Deno.readTextFile(".private/entrega-1/tests-final.log");
assert.match(log, /195 passed \| 0 failed \| 2 ignored/);
const reused = [
  {
    id: "MEM-04",
    file: "tests/observation_retrieval_test.ts",
    line: 65,
    test: "ocorrências: A→B→A preserva três ocorrências, deduplica bytes e isola por dono",
    covers:
      "SQL/RLS: três ocorrências, dois snapshots, vigente A, retry exato sem duplicação, isolamento. Fonte sintética inserida; não é sync Moodle real.",
  },
  {
    id: "TIME-01",
    file: "tests/attention_test.ts",
    line: 380,
    test: "atenção: obrigações interpretadas e recibo de ação acadêmica (Postgres sintético)",
    covers:
      "SQL: interpretação explícita de duas cláusulas, duas datas, trechos/hashes, hora desconhecida e retry. Datas 10/17 equivalem a 12/16; interpretação fixture, não extração semântica autônoma.",
  },
  {
    id: "ATTN-01",
    file: "tests/attention_test.ts",
    line: 264,
    test: "atenção: apresentado/lido local, marca nativa separada e reversão A→B→A",
    covers:
      "SQL: versão apresentada não volta como novidade, edição volta, hash protege corridas, leitura e completion separados, sem objeto de provedor ou rede externa.",
  },
];
for (const previous of reused) {
  assert.ok(log.includes(`${previous.test} ... ok`), `Prova anterior ausente: ${previous.id}`);
  record(previous.id, { reused: true, ...previous, rerun: false });
}
const supplemental = [
  [
    "MEM-03",
    "tests/work_context_test.ts",
    "A02 A13: comparação usa versão escolhida e observação Moodle qualificada, não estado alegado",
  ],
  [
    "MEM-06",
    "tests/foundation_test.ts",
    "A02 A03 A06–09: SQL real, RLS, idempotência e concorrência",
  ],
  [
    "TIME-03",
    "tests/time_context_test.ts",
    "A02 A15: SQL/SDK leem datas qualificadas sem fonte externa; preservam observação e recusam dono alheio",
  ],
  [
    "OPS-02",
    "tests/sync_content_test.ts",
    "A18: checkpoint retoma paginas e discussao >100 posts apos reinicio",
  ],
  [
    "OPS-02",
    "tests/job_metrics_test.ts",
    "A30 job_metrics: erro do provedor e contado e a retomada mede a proxima tentativa",
  ],
];
for (const [, , title] of supplemental) assert.ok(log.includes(`${title} ... ok`));

await Deno.mkdir(OUT, { recursive: true });
try {
  await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
  await startSdk();
  const conn = await hub.connect(
    owner,
    "moodle",
    "Fixture memória isolada",
    "https://fixture.invalid",
    "17",
  );

  if (enabled("MEM-03")) {
    // MEM-03: exact missing combination A/B chosen drafts versus externally observed C.
    const draftsContext = await context("A/B escolhidos e publicação C");
    const a = await call(
      "hub_record_delta",
      delta(draftsContext.id, 0, "Texto A escolhido para revisão."),
    );
    const b = await call(
      "hub_record_delta",
      delta(draftsContext.id, 1, "Texto B escolhido para revisão."),
    );
    await call(
      "hub_record_delta",
      delta(
        draftsContext.id,
        2,
        "A e B foram aprovados como rascunhos; isso não confirma postagem.",
        { kind: "decision" },
      ),
    );
    const post = await hub.entity(owner, conn.id, "post", "memory:post/1", "Publicação fixture");
    for (const draft of [a, b]) {
      const before = await call("hub_compare_forum_draft", {
        draft_delta_id: draft.id,
        post_entity_id: post.id,
      });
      assert.equal(before.state, "not_observed");
    }
    const c = await observe(conn.id, post.id, {
      userid: 17,
      message: "Texto C publicado com outra redação.",
    }, "2026-10-06T12:00:00Z");
    const comparisons = [];
    for (const draft of [a, b]) {
      const compared = await call("hub_compare_forum_draft", {
        draft_delta_id: draft.id,
        post_entity_id: post.id,
      });
      assert.equal(compared.state, "differs_from_selected");
      assert.equal(compared.matches_selected, false);
      assert.equal(compared.selected_draft.id, draft.id);
      assert.equal(compared.published_observation.content_hash, c.hash);
      comparisons.push(compared);
    }
    assert.equal((await call("hub_history", { context_id: draftsContext.id })).records.length, 3);
    record("MEM-03", {
      comparisons,
      history_count: 3,
      external_publication: "synthetic qualified source record; no Moodle call",
    });
  }
  if (enabled("MEM-06")) {
    // MEM-06: real service missing credentials; no provider stub or remote call.
    const mem = await context("Memória antes da indisponibilidade");
    const input = delta(mem.id, 0, "Decisão durável apesar da fonte indisponível.", {
      kind: "decision",
    });
    const first = await call("hub_update_context", { delta: input, connection_id: conn.id });
    assert.ok(first.memory_commit.id);
    assert.equal(first.source_refresh.job.coverage.status, "unavailable");
    assert.equal(first.source_refresh.metrics.calls, 0);
    await stopSdk();
    await db.end();
    db = createDb(DATABASE);
    hub = new Hub(db);
    service = new ConnectionService(hub, vault);
    await startSdk();
    const retry = await call("hub_update_context", { delta: input, connection_id: conn.id });
    assert.equal(retry.memory_commit.id, first.memory_commit.id);
    assert.equal(retry.memory_commit.replayed, true);
    assert.equal(retry.source_refresh.job.coverage.status, "unavailable");
    const recovered = await call("hub_context", { context_id: mem.id });
    assert.equal(recovered.deltas.length, 1);
    assert.equal(recovered.deltas[0].content, input.content);
    await assert.rejects(hub.context(other, mem.id));
    record("MEM-06", {
      first,
      retry,
      recovered_delta_id: recovered.deltas[0].id,
      restart: "MCP client/server and PostgreSQL pool recreated",
      provider_calls: 0,
    });
  }
  if (enabled("TIME-03")) {
    // TIME-03: vague oral statement retains event/record distinction; SDK reads
    // local source instants across Lisbon DST and date-only legacy Calendar data.
    const oral = await context("Data oral vaga");
    const oralInput = delta(
      oral.id,
      0,
      "O professor teria dito sexta-feira; dia e hora não confirmados.",
      {
        kind: "experience",
        evidence_kind: "user_report",
        provenance: [{
          system: "user_report",
          locator: "fixture:oral-conversation",
          original_date: "sexta-feira",
          observed_at: "2026-10-05T10:00:00+01:00",
        }],
      },
    );
    await call("hub_record_delta", oralInput);
    const oralHistory = await call("hub_history", { context_id: oral.id });
    const oralRecord = oralHistory.records[0];
    assert.equal(oralRecord.evidence_kind, "user_report");
    assert.deepEqual(oralRecord.provenance, oralInput.provenance);
    assert.equal(oralRecord.provenance[0].occurred_at, undefined);
    assert.equal(oralRecord.provenance[0].original_date, "sexta-feira");
    const dates = await hub.entity(owner, conn.id, "module", "memory:dates", "Instantes DST");
    await observe(conn.id, dates.id, {
      duedate: Date.parse("2026-10-25T00:30:00Z") / 1000,
      cutoffdate: Date.parse("2026-10-25T01:30:00Z") / 1000,
    }, "2026-10-06T13:00:00Z");
    // A local historical record exercises retained Calendar reads, never Google writes.
    const legacyConn = await hub.connect(
      owner,
      "google",
      "Calendar histórico sintético",
      null,
      "fixture",
    );
    const day = await hub.entity(
      owner,
      legacyConn.id,
      "calendar_event",
      "date-only",
      "Dia sem hora",
      {
        provider_record: { start: { date: "2026-10-25" }, end: { date: "2026-10-26" } },
      },
    );
    const fold = await hub.entity(owner, legacyConn.id, "calendar_event", "fold", "Hora ambígua", {
      provider_record: { start: { dateTime: "2026-10-25T01:30:00", timeZone: "Europe/Lisbon" } },
    });
    const times = await call("hub_time_context", { entity_ids: [dates.id, day.id, fold.id] });
    const dst = times.entities.find((row: Json) => row.id === dates.id);
    assert.deepEqual(dst.dates.map((row: Json) => row.time.displays[0].local), [
      "2026-10-25T01:30:00",
      "2026-10-25T01:30:00",
    ]);
    assert.deepEqual(dst.dates.map((row: Json) => row.time.displays[1].local), [
      "2026-10-24T21:30:00",
      "2026-10-24T22:30:00",
    ]);
    assert.notEqual(dst.dates[0].time.instant, dst.dates[1].time.instant);
    assert.equal(
      times.entities.find((row: Json) => row.id === fold.id).dates[0].time.reason,
      "ambiguous_local_time",
    );
    const dateOnly = times.entities.find((row: Json) => row.id === day.id).dates[0].time;
    assert.equal(dateOnly.instant, null);
    assert.deepEqual(dateOnly.original, { date: "2026-10-25" });
    assert.equal(times.external_changes, false);
    record("TIME-03", {
      oral: oralRecord,
      times,
      scope:
        "Persistence and deterministic timezone projection; natural-language Friday resolution intentionally absent",
    });
  }
  if (enabled("TIME-02")) {
    // TIME-02: independently anchored API/PDF-excerpt/teacher claims. The fixture
    // is already extracted text; this probe does not certify PDF extraction.
    const temporal = await context("Conflito de prazo");
    const assignment = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "memory:assignment",
      "Entrega conflitante",
    );
    const api = await observe(conn.id, assignment.id, {
      name: "Entrega conflitante",
      duedate: Date.parse("2026-10-12T22:59:00Z") / 1000,
    }, "2026-10-06T14:00:00Z");
    const pdf = await hub.entity(owner, conn.id, "module", "memory:pdf", "Plano PDF");
    const pdfObs = await observe(
      conn.id,
      pdf.id,
      { content: "Entregar o trabalho até 14 de outubro." },
      "2026-10-06T14:01:00Z",
      { media_type: "application/pdf", page: 2 },
    );
    const teacher = await hub.entity(
      owner,
      conn.id,
      "forum",
      "memory:teacher",
      "Correção docente",
    );
    const correction =
      "Correção para esta turma: a entrega do trabalho passa de 14 para 16 de outubro; substitui o prazo do plano.";
    const teacherObs = await observe(
      conn.id,
      teacher.id,
      { message: correction, userid: 22 },
      "2026-10-06T14:02:00Z",
      { author_role: "teacher" },
    );
    for (
      const [entity, source, excerpt, date] of [[
        pdf,
        pdfObs,
        "Entregar o trabalho até 14 de outubro.",
        "2026-10-14",
      ], [teacher, teacherObs, correction, "2026-10-16"]] as const
    ) {
      await call("hub_record_requirement", {
        source_entity_id: entity.id,
        requirement_key: "entrega",
        observation_id: source.id,
        content_hash: source.hash,
        excerpt,
        action: "entregar o trabalho",
        deadline: { original_text: excerpt, date },
      });
    }
    await call("hub_bind_work_targets", {
      context_id: temporal.id,
      expected_version: 0,
      entity_ids: [assignment.id, pdf.id, teacher.id],
    });
    await call(
      "hub_record_delta",
      delta(temporal.id, 1, correction, {
        kind: "correction",
        evidence_kind: "observed",
        scope: { entity_id: assignment.id },
        provenance: [{
          system: "synthetic",
          locator: `hub:observation:${teacherObs.id}`,
          version: teacherObs.hash,
          excerpt: correction,
        }],
      }),
    );
    const conflictView = await call("hub_attention", { context_id: temporal.id });
    assert.equal(conflictView.obligations.length, 3);
    assert.ok(
      conflictView.obligations.some((row: Json) =>
        row.deadlines.some((d: Json) => d.time.instant === "2026-10-12T22:59:00.000Z")
      ),
    );
    assert.deepEqual(
      conflictView.obligations.flatMap((row: Json) =>
        row.requirement_deadlines.map((r: Json) => r.deadline.date)
      ).sort(),
      ["2026-10-14", "2026-10-16"],
    );
    const temporalKinds = conflictView.attention.map((row: Json) => row.kind);
    const hasConflict = temporalKinds.some((kind: string) => /conflict|contradic/.test(kind));
    record("TIME-02", {
      preserved_claims: { api, pdf: pdfObs, teacher: teacherObs },
      view: conflictView,
      claims_preserved: true,
      calendar_provider_calls: 0,
      missing: hasConflict ? [] : [
        "A visão não identifica conflito entre as três fontes nem corrige o prazo corrente por âmbito; a correção só permanece como delta recuperável.",
      ],
    }, hasConflict ? "passed" : "failed");
  }
  if (enabled("MAT-05")) {
    // MAT-05: a preserved draft depends on v1; v2 changes the requirement. No
    // 'presented' marker is added: dependency change must not depend on that marker.
    const materialContext = await context("Rascunho com material alterado");
    const task = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "memory:material-task",
      "Trabalho dependente",
    );
    const material = await hub.entity(
      owner,
      conn.id,
      "module",
      "memory:material",
      "Enunciado versionado",
    );
    const v1 = await observe(
      conn.id,
      material.id,
      { content: "Analise dois conceitos." },
      new Date(Date.now() - 60_000).toISOString(),
    );
    await call("hub_bind_work_targets", {
      context_id: materialContext.id,
      expected_version: 0,
      entity_ids: [task.id, material.id],
    });
    const draft = await call(
      "hub_record_delta",
      delta(materialContext.id, 1, "Rascunho baseado nos dois conceitos de v1.", {
        scope: { entity_id: task.id },
        provenance: [{
          system: "synthetic",
          locator: `hub:observation:${v1.id}`,
          version: v1.hash,
          excerpt: "Analise dois conceitos.",
        }],
      }),
    );
    await asOwner(db, owner, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
      values(${owner.ownerId},${task.id},${material.id},'required_material',${
        tx.json({ source_observation_id: v1.id, content_hash: v1.hash })
      })`;
    });
    const beforeChange = await call("hub_context", { context_id: materialContext.id });
    const draftRecordedAt = Date.parse(beforeChange.deltas[0].recorded_at);
    const changedAt = new Date(Math.max(Date.now(), draftRecordedAt + 1)).toISOString();
    assert.ok(Date.parse(changedAt) > draftRecordedAt);
    const v2 = await observe(conn.id, material.id, {
      content: "Analise quatro conceitos com referências.",
    }, changedAt);
    const materialView = await call("hub_attention", { context_id: materialContext.id });
    const materialHistory = await hub.observations(owner, material.id);
    assert.equal(materialHistory.records.length, 2);
    assert.deepEqual(materialHistory.records.map((row) => row.content_hash), [v2.hash, v1.hash]);
    const resumedDraft = await call("hub_context", { context_id: materialContext.id });
    assert.equal(resumedDraft.deltas[0].id, draft.id);
    assert.equal(resumedDraft.deltas[0].provenance[0].version, v1.hash);
    const alert = materialView.attention.find((row: Json) =>
      row.kind === "material_dependency_changed" && row.entity_id === task.id &&
      row.draft_id === draft.id && row.material_entity_id === material.id
    );
    const dependencyAlert = !!alert;
    if (alert) {
      assert.equal(alert.context_id, materialContext.id);
      assert.equal(alert.baseline.content_hash, v1.hash);
      assert.equal(alert.current.content_hash, v2.hash);
      assert.equal(alert.current.observation_id, v2.id);
      assert.equal(alert.requires_review, true);
    }
    record("MAT-05", {
      versions: { v1, v2 },
      draft_id: draft.id,
      draft_recorded_at: beforeChange.deltas[0].recorded_at,
      source_v2_observed_at: changedAt,
      history_preserved: true,
      old_dependency_preserved: true,
      attention: materialView,
      missing: dependencyAlert ? [] : [
        "Não há alerta de dependência desatualizada. not_presented não identifica que o rascunho usa a versão anterior.",
      ],
    }, dependencyAlert ? "passed" : "failed");
  }
  if (enabled("OPS-02")) {
    // OPS-02: only the missing joint assertion: checkpoint, independent restart,
    // per-attempt transport counts, no repeated completed thread and SQL uniqueness.
    // MoodleAdapter parses injected Response objects: no actual Moodle is involved.
    const counts: Array<{ fn: string; discussion: string | null }> = [];
    const makeProvider = (
      origin: string,
      token: string,
      deps?: Parameters<ConnectionService["moodle"]>[2],
    ) =>
      new MoodleAdapter({ origin, token }, {
        ...deps,
        fetch: (_url, init) => {
          const params = new URLSearchParams(String(init?.body ?? ""));
          const fn = params.get("wsfunction") ?? "";
          counts.push({ fn, discussion: params.get("discussionid") });
          let body: unknown = [];
          if (fn === "core_webservice_get_site_info") {
            body = {
              userid: 17,
              siteurl: origin,
              release: "4.5.6+ fixture",
              functions: AUDITED_FUNCTIONS.map((name) => ({ name })),
            };
          }
          if (fn === "core_enrol_get_users_courses") {
            body = [{ id: 991, fullname: "Curso fixture OPS" }];
          }
          if (fn === "core_course_get_contents") {
            body = [{
              id: 1,
              name: "Seção",
              section: 1,
              modules: [{ id: 55, name: "Fórum", modname: "forum", instance: 5 }],
            }];
          }
          if (fn === "mod_forum_get_forums_by_courses") {
            body = [{ id: 5, course: 991, name: "Fórum", cmid: 55 }];
          }
          if (fn === "mod_forum_get_forum_discussions") {
            body = {
              discussions: [{ discussion: 91, name: "Já concluída" }, {
                discussion: 92,
                name: "Thread 121 posts",
              }],
              warnings: [],
            };
          }
          if (fn === "mod_forum_get_discussion_posts") {
            const discussion = Number(params.get("discussionid"));
            body = {
              posts: Array.from(
                { length: discussion === 91 ? 2 : 121 },
                (_, index) => ({
                  id: discussion * 1000 + index,
                  subject: `Post ${index}`,
                  message: "Fixture",
                  userid: 17,
                }),
              ),
              warnings: [],
            };
          }
          return Promise.resolve(Response.json(body));
        },
      });
    let opsConnections = new ConnectionService(hub, vault, makeProvider);
    const opsConnection = await opsConnections.addMoodle(owner, {
      label: "Fixture OPS isolada",
      origin: "https://ops-fixture.invalid",
      token: "synthetic-memory-probe-only",
    });
    counts.length = 0;
    const steps: Json[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await stopSdk();
        await db.end();
        db = createDb(DATABASE);
        hub = new Hub(db);
        opsConnections = new ConnectionService(hub, vault, makeProvider);
      }
      const start = counts.length;
      const run = await new Sync(hub, opsConnections, { forumCallBudget: 3 }).courseContent(
        owner,
        opsConnection.id,
        991,
      );
      const requests = counts.slice(start);
      assert.equal(run.metrics.calls, requests.length);
      const forumCalls = requests.filter((r) =>
        ["mod_forum_get_forum_discussions", "mod_forum_get_discussion_posts"].includes(r.fn)
      );
      assert.ok(forumCalls.length <= 3);
      steps.push({
        state: run.job.state,
        checkpoint: run.summary.checkpoint,
        metrics: run.metrics,
        requests,
      });
      if (run.job.state === "complete") break;
    }
    assert.equal(steps.at(-1)!.state, "complete");
    assert.ok(steps.length > 1);
    assert.ok(steps.some((step) => step.checkpoint.post_offset === 100));
    assert.equal(
      counts.filter((r) => r.fn === "mod_forum_get_discussion_posts" && r.discussion === "91")
        .length,
      1,
    );
    const [postCounts] = await asOwner(
      db,
      owner,
      async (tx) =>
        await tx`select count(*)::int as total,count(distinct external_id)::int as distinct_posts
    from public.hub_entities where owner_id=${owner.ownerId} and connection_id=${opsConnection.id} and kind='post'`,
    );
    assert.equal(postCounts.total, 123);
    assert.equal(postCounts.distinct_posts, 123);
    record("OPS-02", {
      steps,
      post_counts: postCounts,
      actual_moodle: false,
      transport: "injected synthetic Response objects parsed by real MoodleAdapter",
      limitation:
        "Moodle's posts route returns a whole discussion; offset windows cause one bounded reread of the 121-post thread. Completed prior thread is not rescanned; fixed metadata reads repeat per batch.",
    });
  }
  if (enabled("ATTN-02")) {
    // Deliberately finite Lab scheduler, stored under synthetic owners only.
    // This runner is the scheduler under test; it is not a production cron.
    type Profile = {
      name: string;
      course: number;
      revision: number;
      slowOnce: boolean;
      expired: boolean;
      calls: Array<{ fn: string; at: number }>;
      connectionId?: string;
      policyId?: string;
    };
    const profiles: Profile[] = [
      { name: "slow", course: 701, revision: 1, slowOnce: false, expired: false, calls: [] },
      { name: "healthy", course: 702, revision: 1, slowOnce: false, expired: false, calls: [] },
      { name: "expired", course: 703, revision: 1, slowOnce: false, expired: false, calls: [] },
    ];
    const factory = (
      origin: string,
      token: string,
      deps?: Parameters<ConnectionService["moodle"]>[2],
    ) => {
      const profile = profiles.find((p) =>
        origin === `https://${p.name}.attention-fixture.invalid`
      )!;
      assert.ok(profile, "Only this invocation's synthetic source profiles are allowed");
      return new MoodleAdapter({ origin, token, timeoutMs: 75 }, {
        ...deps,
        fetch: async (_url, init) => {
          const args = new URLSearchParams(String(init?.body ?? ""));
          const fn = args.get("wsfunction") ?? "";
          profile.calls.push({ fn, at: Date.now() });
          if (profile.expired) {
            return Response.json({
              exception: "moodle_exception",
              errorcode: "invalidtoken",
              message: "synthetic expired",
            });
          }
          if (fn === "core_webservice_get_site_info") {
            return Response.json({
              userid: 17,
              siteurl: origin,
              release: "4.5.6 fixture",
              functions: AUDITED_FUNCTIONS.map((name) => ({ name })),
            });
          }
          if (fn === "core_enrol_get_users_courses") {
            return Response.json([{ id: profile.course, fullname: `Course ${profile.name}` }]);
          }
          if (fn === "core_course_get_contents") {
            return Response.json([{
              id: 1,
              section: 1,
              name: "Section",
              modules: [{ id: 55, modname: "forum", instance: 5, name: "Forum" }],
            }]);
          }
          if (fn === "mod_forum_get_forums_by_courses") {
            return Response.json([{
              id: 5,
              course: profile.course,
              cmid: 55,
              name: "Forum",
              intro: `Requirement revision ${profile.revision}`,
            }]);
          }
          if (fn === "mod_forum_get_forum_discussions") {
            return Response.json({
              discussions: [{ discussion: 91, name: "Discussion" }],
              warnings: [],
            });
          }
          if (fn === "mod_forum_get_discussion_posts") {
            if (profile.slowOnce) {
              profile.slowOnce = false;
              // A real AbortSignal timeout, not a fabricated successful result.
              await new Promise<never>((_resolve, reject) => {
                const signal = init!.signal!;
                if (signal.aborted) {
                  reject(signal.reason);
                } else {signal.addEventListener("abort", () => reject(signal.reason), {
                    once: true,
                  });}
              });
            }
            return Response.json({
              posts: Array.from(
                { length: profile.name === "slow" ? 121 : 1 },
                (_, i) => ({
                  id: 9100 + i,
                  userid: 17,
                  parent: 0,
                  subject: `Post ${i}`,
                  message: `Text ${profile.revision}`,
                }),
              ),
              warnings: [],
            });
          }
          return Response.json([]);
        },
      });
    };
    let connections = new ConnectionService(hub, vault, factory);
    const baseline: Json[] = [];
    const policies: string[] = [];
    for (const profile of profiles) {
      const connection = await connections.addMoodle(owner, {
        label: `ATTN Lab ${profile.name}`,
        origin: `https://${profile.name}.attention-fixture.invalid`,
        token: "synthetic-attention-local-only",
      });
      profile.connectionId = connection.id;
      const warmup = await new Sync(hub, connections, { forumCallBudget: 4 }).courseContent(
        owner,
        connection.id,
        profile.course,
      );
      assert.equal(warmup.job.state, "complete");
      const policy = await hub.entity(
        owner,
        connection.id,
        "lab_schedule",
        `attention-lab:${profile.course}`,
        "Finite private Lab schedule",
        {
          connection_id: connection.id,
          course_id: profile.course,
          paused: false,
          next_at: Date.now(),
          interval_ms: 100,
          backoff_ms: 1000,
          max_backoff_ms: 4000,
          forum_call_budget: 2,
          max_runs: profile.name === "healthy" ? 2 : 4,
          run_count: 0,
          failure_count: 0,
          call_budget: 72,
          used_calls: 0,
          pending_job: null,
          last_cursor: warmup.job.cursor,
        },
      );
      profile.policyId = policy.id;
      policies.push(policy.id);
      baseline.push({ profile: profile.name, job_id: warmup.job.id, cursor: warmup.job.cursor });
      profile.calls.length = 0;
    }
    const state = async (id: string): Promise<Json> =>
      await asOwner(
        db,
        owner,
        async (tx) =>
          (await tx`select state from public.hub_entities where owner_id=${owner.ownerId} and id=${id} and kind='lab_schedule'`)[
            0
          ].state,
      );
    const save = async (id: string, value: Json) =>
      await asOwner(db, owner, async (tx) => {
        await tx`update public.hub_entities set state=${
          tx.json(value)
        } where owner_id=${owner.ownerId} and id=${id} and kind='lab_schedule'`;
      });
    const events: Json[] = [];
    const tick = async (id: string) => {
      const policy = await state(id);
      if (
        policy.paused || policy.run_count >= policy.max_runs || Date.now() < policy.next_at ||
        policy.call_budget - policy.used_calls < 18
      ) return;
      const startedAt = Date.now();
      const profile = profiles.find((p) => p.policyId === id)!;
      const countBefore = profile.calls.length;
      const sync = new Sync(hub, connections, { forumCallBudget: policy.forum_call_budget });
      const result = policy.pending_job
        ? await sync.run(owner, policy.pending_job)
        : await sync.courseContent(owner, policy.connection_id, policy.course_id);
      assert.ok(result.job);
      assert.equal(result.metrics!.calls, profile.calls.length - countBefore);
      assert.ok(
        result.metrics!.calls <= 18,
        "fixed metadata plus at most two forum calls per fixture batch",
      );
      const requests = profile.calls.slice(countBefore);
      assert.ok(
        requests.filter((r) =>
          ["mod_forum_get_forum_discussions", "mod_forum_get_discussion_posts"].includes(r.fn)
        ).length <= 2,
      );
      const coverage = (result.job!.coverage as Json).status;
      if (coverage !== "complete") assert.equal(result.job!.cursor, null);
      const terminalExpired = coverage === "expired";
      const transientFailure = ["timeout", "unavailable", "parsing_error", "denied"].includes(
        coverage,
      );
      const failures = transientFailure ? policy.failure_count + 1 : 0;
      const delay = transientFailure
        ? Math.min(policy.backoff_ms * 2 ** (failures - 1), policy.max_backoff_ms)
        : policy.interval_ms;
      const next = {
        ...policy,
        run_count: policy.run_count + 1,
        used_calls: policy.used_calls + result.metrics!.calls,
        failure_count: failures,
        next_at: Date.now() + delay,
        paused: terminalExpired,
        pause_reason: terminalExpired ? "credential_expired" : null,
        pending_job: result.job!.state === "partial" ? result.job!.id : null,
        last_cursor: coverage === "complete" ? result.job!.cursor : policy.last_cursor,
      };
      await save(id, next);
      events.push({
        profile: profile.name,
        started_at: startedAt,
        due_at: policy.next_at,
        coverage,
        state: result.job!.state,
        job_id: result.job!.id,
        cursor: result.job!.cursor,
        last_success_cursor: next.last_cursor,
        next_at: next.next_at,
        backoff_ms: transientFailure ? delay : 0,
        paused: next.paused,
        metrics: result.metrics,
        checkpoint: result.summary?.checkpoint,
        requests,
      });
    };
    // Short real timers drive a bounded private loop; no OS/global scheduler is installed.
    // The measured 100-post SQL batch took ~19 s on the shared local database.
    // Bound elapsed time without confusing that persistence cost with API budget.
    const pump = async (done: () => Promise<boolean>, timeoutMs = 45000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        await Promise.all(policies.map(tick));
        if (await done()) return;
      }
      await Deno.writeTextFile(
        `${OUT}/attention02-interruption.json`,
        JSON.stringify({ events, states: await Promise.all(policies.map(state)) }, null, 2),
      );
      throw new Error("Finite Lab schedule did not reach its expected checkpoint");
    };
    const healthy = profiles[1], slow = profiles[0], expired = profiles[2];
    const [forum] = await asOwner(
      db,
      owner,
      async (tx) =>
        await tx`select id from public.hub_entities where owner_id=${owner.ownerId} and connection_id=${healthy
          .connectionId!} and kind='forum'`,
    );
    const original = (await hub.observations(owner, forum.id)).records[0];
    await new Attention(hub).markPresented(owner, {
      entities: [{ entity_id: forum.id, content_hash: String(original.content_hash) }],
    });
    for (const profile of profiles) profile.revision = 2;
    slow.slowOnce = true;
    expired.expired = true;
    await pump(async () => events.length >= 3);
    assert.equal(events.find((e) => e.profile === "slow")!.coverage, "timeout");
    assert.equal(events.find((e) => e.profile === "healthy")!.coverage, "complete");
    const expiry = events.find((e) => e.profile === "expired")!;
    assert.equal(expiry.coverage, "expired");
    assert.equal((await state(expired.policyId!)).pause_reason, "credential_expired");
    assert.equal(await new Jobs(db).claim(owner, expiry.job_id), null);
    assert.deepEqual((await state(slow.policyId!)).last_cursor, baseline[0].cursor);
    const callsBeforeBackoff = slow.calls.length;
    await tick(slow.policyId!);
    assert.equal(slow.calls.length, callsBeforeBackoff);
    const novelty = await new Attention(hub).overview(owner, {
      connection_id: healthy.connectionId,
    });
    assert.ok(
      novelty.attention.some((item) =>
        (item as Json).entity_id === forum.id && (item as Json).kind === "changed_since_presented"
      ),
    );
    const latest = (await hub.observations(owner, forum.id)).records[0];
    await new Attention(hub).markPresented(owner, {
      entities: [{ entity_id: forum.id, content_hash: String(latest.content_hash) }],
    });

    for (const id of policies) await save(id, { ...await state(id), paused: true });
    const countsBeforePause = profiles.map((p) => p.calls.length);
    const pausedStates = await Promise.all(policies.map(state));
    await stopSdk();
    await db.end();
    db = createDb(DATABASE);
    hub = new Hub(db);
    connections = new ConnectionService(hub, vault, factory);
    service = new ConnectionService(hub, vault);
    await startSdk();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await Promise.all(policies.map(tick));
    assert.deepEqual(profiles.map((p) => p.calls.length), countsBeforePause);
    assert.deepEqual(await Promise.all(policies.map(state)), pausedStates);
    const pausedExpiryMemory = await call("hub_entities", {
      connection_id: expired.connectionId,
      kind: "post",
    });
    assert.equal(pausedExpiryMemory.records.length, 1);
    const priorVersions = await call("hub_observations", {
      entity_id: pausedExpiryMemory.records[0].id,
    });
    const priorText = await call("hub_observation", {
      observation_id: priorVersions.records[0].id,
    });
    assert.ok(priorText.excerpt.includes("Text 1"), "preserved memory remains after expiry");
    await save(slow.policyId!, { ...await state(slow.policyId!), paused: false });
    await pump(async () => events.some((e) => e.profile === "slow" && e.coverage === "complete"));
    const slowEvents = events.filter((e) => e.profile === "slow");
    assert.ok(slowEvents.length >= 3);
    assert.ok(slowEvents[1].started_at >= slowEvents[0].next_at);
    assert.ok(slowEvents.some((e) => e.checkpoint?.post_offset === 100));
    assert.equal(slowEvents.at(-1)!.checkpoint.resumed, true);
    assert.equal(
      new Set(slowEvents.map((e) => e.job_id)).size,
      1,
      "same partial job resumed across restart",
    );
    const [postCount] = await asOwner(
      db,
      owner,
      async (tx) =>
        await tx`select count(*)::int as n,count(distinct external_id)::int as distinct_n from public.hub_entities where owner_id=${owner.ownerId} and connection_id=${slow
          .connectionId!} and kind='post'`,
    );
    assert.deepEqual({ n: postCount.n, distinct_n: postCount.distinct_n }, {
      n: 121,
      distinct_n: 121,
    });
    await save(slow.policyId!, { ...await state(slow.policyId!), paused: true });
    await save(healthy.policyId!, { ...await state(healthy.policyId!), paused: false });
    await pump(async () => (await state(healthy.policyId!)).run_count === 2);
    const again = await call("hub_attention", { connection_id: healthy.connectionId });
    assert.ok(
      !again.attention.some((item: Json) =>
        item.entity_id === forum.id &&
        ["not_presented", "changed_since_presented"].includes(item.kind)
      ),
    );
    const [versions] = await asOwner(
      db,
      owner,
      async (tx) =>
        await tx`select count(*)::int as n from public.hub_observations where owner_id=${owner.ownerId} and entity_id=${forum.id}`,
    );
    assert.equal(
      versions.n,
      2,
      "unchanged recurring scans do not manufacture a third content version",
    );

    // Only the synthetic source is renewed. The expired job remains immutable history.
    expired.expired = false;
    await connections.addMoodle(owner, {
      label: "ATTN Lab renewed",
      origin: "https://expired.attention-fixture.invalid",
      token: "synthetic-attention-renewed-only",
      connection_id: expired.connectionId,
    });
    await save(expired.policyId!, {
      ...await state(expired.policyId!),
      paused: false,
      next_at: Date.now(),
      pending_job: null,
    });
    await pump(async () => events.filter((e) => e.profile === "expired").length === 2);
    const recovered = events.filter((e) => e.profile === "expired").at(-1)!;
    assert.equal(recovered.coverage, "complete");
    assert.notEqual(recovered.job_id, expiry.job_id);
    const finalStates = await Promise.all(policies.map(state));
    assert.ok(finalStates.every((s) => s.used_calls <= s.call_budget && s.run_count <= s.max_runs));
    for (const id of policies) await save(id, { ...await state(id), paused: true });
    record("ATTN-02", {
      baseline,
      events,
      final_states: finalStates,
      post_count: postCount,
      durable_pause_survived_restart: true,
      observed_content_versions: versions.n,
      real_timer_driven: true,
      actual_moodle: false,
      provider_transport: "injected synthetic Moodle responses, real adapter parsing/timeouts",
      scheduler:
        "finite local Lab runner in memory_prove.ts; policy state in owner-scoped PostgreSQL entities",
      production_cron_active: false,
      limitations: [
        "No production scheduling endpoint or service added.",
        "No Moodle server/ChatGPT/university evidence implied; local SQL/SDK plus provider fixture.",
      ],
    });
  }
  executionComplete = true;
} finally {
  await stopSdk();
  // Delete exclusively UUIDs generated by this invocation; no global reset or shared fixture cleanup.
  await db`delete from auth.users where id in (${owner.ownerId},${other.ownerId})`;
  await db.end();
  const fingerprints: Record<string, string> = {};
  for (
    const file of [
      ...new Set([
        ...reused.map((r) => r.file),
        ...supplemental.map((r) => r[1]),
        "src/domain.ts",
        "src/attention.ts",
        "src/time_context.ts",
        "src/sync.ts",
        "src/mcp.ts",
      ]),
    ]
  ) {
    fingerprints[file] = await sha256Hex(await Deno.readFile(file));
  }
  const report = {
    generated_at: new Date().toISOString(),
    command: command + (selected ? ` --only=${selected.join(",")}` : ""),
    execution_complete: executionComplete,
    environment: {
      database: "127.0.0.1:55432/arahub",
      runtime: Deno.version,
      authentication: "injected local principal (not hosted/Auth proof)",
      owners: [owner.ownerId, other.ownerId],
      cleanup: "only generated synthetic owners removed",
      external_provider_calls: 0,
    },
    reused_run: {
      path: ".private/entrega-1/tests-final.log",
      sha256: await sha256Hex(new TextEncoder().encode(log)),
      supplemental,
    },
    source_fingerprints: fingerprints,
    results,
  };
  await Deno.writeTextFile(
    `${OUT}/proof${selected ? "-" + selected.join("_") : ""}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (results.some((result) => result.status === "failed")) Deno.exitCode = 1;
