/**
 * Testes dirigidos do AraHub para atenção acadêmica quantitativa e relatos.
 *
 * SQL real no Postgres exclusivo local (127.0.0.1:55432) com contas, conexões,
 * cursos, fóruns, atividades e relatos sintéticos sob IDs próprios, sempre
 * removidos por dono. Sem fontes externas, dados reais, credenciais ou
 * navegador. Cobre: obrigações de fórum (tópico e respostas por colegas
 * distintos), recibos preservados em state.forum_publications, relato de
 * entrega vs estado nativo da própria submissão, relato de respostas com
 * quantidade comunicada, distinção entre conclusão e entrega, retratação do
 * relato, views summary/audit e volume de eventos de outras entidades.
 */

import assert from "node:assert/strict";
import { createDb, type Db } from "../src/db.ts";
import { Attention } from "../src/attention.ts";
import { Hub } from "../src/domain.ts";
import { type Principal } from "../src/contracts.ts";
import { MoodleMemory } from "../src/moodle_memory.ts";
import { WorkContext } from "../src/work_context.ts";
import type { MoodleRecord, MoodleResult } from "../src/adapters/moodle.ts";

const DB_URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";

function result<T>(data: T, observed_at: string): MoodleResult<T> {
  return {
    data,
    observed_at,
    coverage: "complete",
    warnings: [],
    error_code: null,
    empty: false,
    truncated: false,
  };
}

interface RequirementView {
  requirement_key: string;
  action: string | null;
  fulfillment: string;
  state: "satisfied" | "pending" | "uncertain";
  state_reasons: string[];
  evidence: Array<Record<string, unknown>>;
  quantity: { kind: unknown; at_least: unknown } | null;
  source?: { excerpt?: unknown; observation_id?: unknown; content_hash?: unknown } | null;
}

interface ObRow {
  entity: {
    id: string;
    kind: string;
    title: string;
    external_id?: string;
    provider?: string;
    connection_state?: string;
  };
  outcome: { status: string; reasons: string[] };
  requirements: RequirementView[];
  colleague_requirements?: Array<{
    requirement_key: string;
    required_at_least: unknown;
    observed_distinct_colleagues: unknown;
    observed_meets_at_least: unknown;
  }>;
  colleagues: {
    subject_userid: string;
    distinct_colleagues: number;
    colleagues_answered_by_owner: number;
    observed_posts: number;
    owner_posts: number;
  } | null;
  provenance?: Record<string, unknown>;
  state?: {
    user_report: { delta_id?: string; reported?: boolean } | null;
    legacy_user_report_active?: boolean;
    own_submission_status: { qualified?: boolean; status?: string; reasons?: string[] } | null;
    submission_evidence: {
      user_report: boolean;
      confirmed_academic_action: boolean;
      native_completion: boolean;
      own_submission_status: { qualified?: boolean; status?: string; reasons?: string[] } | null;
    };
    academic_events?: Array<{ delta_id: string; event_type: string }>;
    forum_publications: {
      publications: Array<Record<string, unknown>>;
      replies: Array<Record<string, unknown>>;
      publications_truncated: boolean;
      replies_truncated: boolean;
    } | null;
  };
  gaps?: string[];
  basis?: string;
}

interface OverviewResult {
  obligations: ObRow[];
  attention: Array<{ entity_id: string; kind: string }>;
  limitations: string[];
}

interface Fixture {
  db: Db;
  hub: Hub;
  attention: Attention;
  memory: MoodleMemory;
  work: WorkContext;
  a: Principal;
  b: Principal;
  connectionId: string;
}

/** Cria duas contas sintéticas e sempre as remove por dono no finally. */
async function withOwner(run: (fixture: Fixture) => Promise<void>) {
  const db = createDb(DB_URL);
  const a: Principal = { ownerId: crypto.randomUUID() };
  const b: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const hub = new Hub(db);
    const connection = await hub.connect(a, "moodle", "Fixture atenção", null, "7");
    await run({
      db,
      hub,
      attention: new Attention(hub),
      memory: new MoodleMemory(hub),
      work: new WorkContext(hub),
      a,
      b,
      connectionId: connection.id,
    });
  } finally {
    try {
      await db`delete from auth.users where id in (${a.ownerId},${b.ownerId})`;
    } catch {
      // Limpeza de melhor esforço; nunca mascara o resultado do teste.
    }
    await db.end();
  }
}

async function read(f: Fixture, view: "summary" | "audit", connectionId?: string) {
  return await f.attention.overview(f.a, {
    view,
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as unknown as OverviewResult;
}

function findOb(view: OverviewResult, id: string): ObRow {
  const found = view.obligations.find((o) => o.entity.id === id);
  if (!found) throw new Error("obrigação não encontrada: " + id);
  return found;
}

function reqOf(ob: ObRow, key: string): RequirementView {
  const found = ob.requirements.find((r) => r.requirement_key === key);
  if (!found) throw new Error("obrigação interpretada não encontrada: " + key);
  return found;
}

function forumWithRequirement(view: OverviewResult, requirementKey: string): ObRow {
  const found = view.obligations.find((ob) =>
    ob.entity.kind === "forum" && ob.requirements.some((r) => r.requirement_key === requirementKey)
  );
  if (!found) throw new Error("fórum com obrigação não encontrado: " + requirementKey);
  return found;
}

function kindsOf(view: OverviewResult, id: string): string[] {
  return view.attention.filter((item) => item.entity_id === id).map((item) => item.kind);
}

async function onlyEntityId(f: Fixture, kind: string): Promise<string> {
  const records = (await f.hub.entities(f.a, { kind })).records;
  if (records.length !== 1) throw new Error("esperava uma entidade " + kind);
  return String(records[0].id);
}

async function sourceObservation(f: Fixture, entityId: string) {
  const observation = (await f.hub.observations(f.a, entityId)).records[0];
  return {
    observation_id: String(observation.id),
    content_hash: String(observation.content_hash),
  };
}

const postRecord = (id: number, userid: number, parentid: number, message: string) => ({
  id,
  discussionid: 77,
  userid,
  parentid,
  subject: message,
  message,
  created: 1791892800,
});

Deno.test("fórum B/C/D/E: tópico satisfeito, respostas por colegas distintos e recibos preservados", async () => {
  await withOwner(async (f) => {
    const { hub, memory, attention, a, connectionId } = f;
    const forumInstance = 22, discussionId = 77;
    await memory.remember(
      a,
      connectionId,
      { kind: "forums", course_id: 12 },
      result([{
        id: forumInstance,
        course: 12,
        cmid: 102,
        name: "Fórum de participação",
        intro: "Publique um tópico e responda a dois colegas diferentes.",
      }], "2026-10-13T10:00:00Z"),
    );
    await memory.remember(
      a,
      connectionId,
      { kind: "discussions", forum_id: forumInstance },
      result([
        {
          id: 201,
          discussion: discussionId,
          discussion_id: discussionId,
          userid: 7,
          name: "Minha análise",
        },
      ], "2026-10-13T10:01:00Z"),
    );
    const addPosts = (records: MoodleRecord[], at: string) =>
      memory.remember(
        a,
        connectionId,
        { kind: "posts", discussion_id: discussionId },
        result(records, at),
      );

    const forumId = await onlyEntityId(f, "forum");
    const forumObs = await sourceObservation(f, forumId);
    await attention.recordRequirement(a, {
      source_entity_id: forumId,
      requirement_key: "topico",
      observation_id: forumObs.observation_id,
      content_hash: forumObs.content_hash,
      excerpt: "Publique um tópico",
      action: "publicar tópico no fórum",
      fulfillment: "forum_topic",
    });

    // O endpoint de discussions já expõe autor e ID do post inicial: o tópico
    // próprio é comprovado ANTES de qualquer consulta de postagens.
    const beforePosts = findOb(await read(f, "audit"), forumId);
    assert.equal(reqOf(beforePosts, "topico").state, "satisfied");
    const rootPublication = beforePosts.state!.forum_publications!.publications;
    assert.equal(rootPublication.length, 1);
    assert.equal(rootPublication[0].author_userid, "7");
    assert.equal(rootPublication[0].post_id, "201");

    await addPosts([
      postRecord(201, 7, 0, "Meu tópico"),
      postRecord(211, 11, 0, "Post do colega 11"),
      postRecord(212, 12, 0, "Post do colega 12"),
    ], "2026-10-13T10:02:00Z");
    await attention.recordRequirement(a, {
      source_entity_id: forumId,
      requirement_key: "respostas",
      observation_id: forumObs.observation_id,
      content_hash: forumObs.content_hash,
      excerpt: "responda a dois colegas diferentes",
      action: "responder a dois colegas distintos",
      fulfillment: "forum_reply",
      quantity: { kind: "colleagues_distinct", at_least: 2 },
    });

    const initial = findOb(await read(f, "audit"), forumId);
    const topico = reqOf(initial, "topico");
    const respostas = reqOf(initial, "respostas");
    assert.equal(topico.fulfillment, "forum_topic");
    assert.equal(topico.state, "satisfied");
    assert.equal(respostas.fulfillment, "forum_reply");
    assert.equal(respostas.state, "pending");
    assert.equal(respostas.quantity!.at_least, 2);
    assert.equal(initial.colleagues!.distinct_colleagues, 2);
    assert.equal(initial.colleagues!.colleagues_answered_by_owner, 0);
    assert.equal(initial.outcome.status, "pending");

    // Recibos de publicação preservam ID, observação, hash e autoria do titular.
    const publication = initial.state!.forum_publications!.publications;
    assert.equal(publication.length, 1);
    assert.equal(publication[0].author_userid, "7");
    assert.equal(publication[0].post_id, "201");
    assert.equal(publication[0].basis, "preserved_owner_publication");
    assert.ok(publication[0].observation_id);
    assert.ok(
      typeof publication[0].content_hash === "string" && publication[0].content_hash !== "",
    );
    const stored = (await hub.observations(a, String(publication[0].post_entity_id))).records[0];
    assert.equal(publication[0].content_hash, stored.content_hash);

    // Duas respostas ao MESMO colega continuam contando um colega distinto.
    await addPosts([
      postRecord(221, 7, 211, "Resposta ao colega 11"),
      postRecord(222, 7, 211, "Segunda resposta ao colega 11"),
    ], "2026-10-13T10:03:00Z");
    const sameColleague = findOb(await read(f, "audit"), forumId);
    assert.equal(sameColleague.colleagues!.colleagues_answered_by_owner, 1);
    assert.equal(reqOf(sameColleague, "respostas").state, "pending");
    assert.equal(sameColleague.outcome.status, "pending");

    // Após o SEGUNDO colega distinto a quantidade é satisfeita.
    await addPosts([postRecord(223, 7, 212, "Resposta ao colega 12")], "2026-10-13T10:04:00Z");
    const twoColleagues = findOb(await read(f, "audit"), forumId);
    assert.equal(twoColleagues.colleagues!.colleagues_answered_by_owner, 2);
    assert.equal(twoColleagues.colleague_requirements![0].observed_meets_at_least, true);
    assert.equal(reqOf(twoColleagues, "respostas").state, "satisfied");
    assert.equal(twoColleagues.outcome.status, "concluded");
    const replies = twoColleagues.state!.forum_publications!.replies;
    assert.equal(replies.length, 3);
    assert.deepEqual(
      [...new Set(replies.map((reply) => reply.colleague_userid))].sort(),
      ["11", "12"],
    );
    for (const reply of replies) {
      assert.equal(reply.author_userid, "7");
      assert.ok(reply.parent_post_id);
      assert.ok(typeof reply.content_hash === "string" && reply.content_hash !== "");
    }
  });
});

Deno.test("relato de entrega: user_report preservado, status próprio new/draft incerto e submitted como prova", async () => {
  await withOwner(async (f) => {
    const { hub, memory, attention, work, a, connectionId } = f;
    await memory.remember(
      a,
      connectionId,
      { kind: "assignments", course_id: 12 },
      result([
        { id: 11, course_id: 12, cmid: 101, name: "Atividade 1", duedate: 1791907200 },
      ], "2026-10-13T11:00:00Z"),
    );
    const assignmentId = await onlyEntityId(f, "assignment");
    const assignmentObs = await sourceObservation(f, assignmentId);
    await attention.recordRequirement(a, {
      source_entity_id: assignmentId,
      requirement_key: "entrega",
      observation_id: assignmentObs.observation_id,
      content_hash: assignmentObs.content_hash,
      excerpt: "Entregue a Atividade 1",
      action: "entregar a atividade",
      fulfillment: "submission",
    });
    const report = await work.recordEvent(a, {
      content: "Entreguei a Atividade 1 pelo Moodle.",
      event_type: "submission",
      target_entity_id: assignmentId,
      requirement_key: "entrega",
    });
    assert.equal(report.evidence_kind, "user_report");
    assert.equal(report.external_submission, "not_verified");

    const rememberStatus = (status: string, at: string) =>
      memory.remember(
        a,
        connectionId,
        { kind: "own_status", course_id: 12, assignment_id: 11 },
        result({
          lastattempt: { submission: { userid: 7, status } },
          assignment_scope: { course_id: 12, assignment_id: 11, cmid: 101 },
        }, at),
      );

    // Estado nativo "new" contradiz o relato: permanece incerto e nada é apagado.
    await rememberStatus("new", "2026-10-13T11:05:00Z");
    const incerto = findOb(await read(f, "audit"), assignmentId);
    const entregaIncerta = reqOf(incerto, "entrega");
    assert.equal(entregaIncerta.state, "uncertain");
    assert.ok(entregaIncerta.state_reasons.includes("user_report_contradicts_native_status"));
    const bases = new Set(entregaIncerta.evidence.map((entry) => entry.basis));
    assert.ok(bases.has("user_report_delta"));
    assert.ok(bases.has("own_submission_status"));
    const ownReceipt = entregaIncerta.evidence.find((entry) =>
      entry.basis === "own_submission_status"
    )!;
    assert.equal(ownReceipt.qualified, true);
    assert.equal(ownReceipt.status, "new");
    assert.equal(incerto.outcome.status, "uncertain");
    assert.equal(incerto.state!.submission_evidence.user_report, true);
    assert.equal(incerto.state!.own_submission_status!.qualified, true);
    assert.equal(incerto.state!.own_submission_status!.status, "new");
    assert.ok(
      kindsOf(await read(f, "audit"), assignmentId).includes("report_observation_contradiction"),
    );
    // O relato continua na memória do contexto.
    const history = await hub.history(a, report.context_id);
    assert.ok(history.records.some((record) => record.id === report.memory_commit.id));

    // Estado nativo "draft" também contradiz e permanece incerto.
    await rememberStatus("draft", "2026-10-13T11:06:00Z");
    assert.equal(reqOf(findOb(await read(f, "audit"), assignmentId), "entrega").state, "uncertain");

    // Estado nativo "submitted" é prova observada da própria entrega.
    await rememberStatus("submitted", "2026-10-13T11:07:00Z");
    const satisfeito = findOb(await read(f, "audit"), assignmentId);
    assert.equal(reqOf(satisfeito, "entrega").state, "satisfied");
    assert.equal(satisfeito.outcome.status, "concluded");
    assert.equal(satisfeito.state!.own_submission_status!.status, "submitted");
    assert.equal(satisfeito.state!.submission_evidence.own_submission_status!.status, "submitted");
  });
});

Deno.test("respostas de fórum: relato sem número não cumpre dois colegas; número comunicado não soma", async () => {
  await withOwner(async (f) => {
    const { memory, attention, work, a, connectionId } = f;
    const discussionId = 77;
    await memory.remember(
      a,
      connectionId,
      { kind: "forums", course_id: 12 },
      result([
        {
          id: 22,
          course: 12,
          cmid: 102,
          name: "Fórum de respostas",
          intro: "Responda a dois colegas.",
        },
      ], "2026-10-13T12:00:00Z"),
    );
    await memory.remember(
      a,
      connectionId,
      { kind: "discussions", forum_id: 22 },
      result([
        {
          id: 201,
          discussion: discussionId,
          discussion_id: discussionId,
          userid: 7,
          name: "Tópico",
        },
      ], "2026-10-13T12:01:00Z"),
    );
    await memory.remember(
      a,
      connectionId,
      { kind: "posts", discussion_id: discussionId },
      result([postRecord(211, 11, 0, "Post do colega 11")], "2026-10-13T12:02:00Z"),
    );
    const forumId = await onlyEntityId(f, "forum");
    const forumObs = await sourceObservation(f, forumId);
    await attention.recordRequirement(a, {
      source_entity_id: forumId,
      requirement_key: "respostas",
      observation_id: forumObs.observation_id,
      content_hash: forumObs.content_hash,
      excerpt: "Responda a dois colegas",
      action: "responder a dois colegas",
      fulfillment: "forum_reply",
      quantity: { kind: "colleagues_distinct", at_least: 2 },
    });
    const state = async () => reqOf(findOb(await read(f, "audit"), forumId), "respostas").state;
    const reportReply = (occurrence_key: string, reported_distinct_colleagues?: number) =>
      work.recordEvent(a, {
        content: "Respondi a colegas no fórum.",
        event_type: "forum_reply",
        target_entity_id: forumId,
        requirement_key: "respostas",
        occurrence_key,
        ...(reported_distinct_colleagues === undefined ? {} : { reported_distinct_colleagues }),
      });

    // Relato sem quantidade não cumpre uma exigência de dois colegas distintos.
    await reportReply("reply-sem-numero");
    assert.equal(await state(), "pending");
    // Número comunicado explicitamente: 1 ainda não cumpre dois.
    await reportReply("reply-um", 1);
    assert.equal(await state(), "pending");
    // Dois relatos de "um" NÃO somam para "dois".
    await reportReply("reply-um-de-novo", 1);
    assert.equal(await state(), "pending");
    // Número 2 explícito satisfaz como relato, sem evidência preservada de postagens.
    await reportReply("reply-dois", 2);
    assert.equal(await state(), "satisfied");
    const final = findOb(await read(f, "audit"), forumId);
    assert.equal(final.state!.forum_publications!.replies.length, 0);
    const receipt = reqOf(final, "respostas").evidence.find((entry) =>
      entry.basis === "user_report_delta"
    )!;
    assert.equal(receipt.reported_distinct_colleagues, 2);
  });
});

Deno.test("'completion' não significa entrega: conclusão relatada não satisfaz a submissão", async () => {
  await withOwner(async (f) => {
    const { memory, attention, work, a, connectionId } = f;
    await memory.remember(
      a,
      connectionId,
      { kind: "assignments", course_id: 12 },
      result([
        { id: 11, course_id: 12, cmid: 101, name: "Atividade 1", duedate: 1791907200 },
      ], "2026-10-13T13:00:00Z"),
    );
    const assignmentId = await onlyEntityId(f, "assignment");
    const assignmentObs = await sourceObservation(f, assignmentId);
    await attention.recordRequirement(a, {
      source_entity_id: assignmentId,
      requirement_key: "entrega",
      observation_id: assignmentObs.observation_id,
      content_hash: assignmentObs.content_hash,
      excerpt: "Entregue a Atividade 1",
      action: "entregar a atividade",
      fulfillment: "submission",
    });
    const completion = await work.recordEvent(a, {
      content: "Concluí a Atividade 1.",
      event_type: "completion",
      target_entity_id: assignmentId,
      occurrence_key: "concluida-1",
    });
    assert.equal(completion.event_type, "completion");

    const ob = findOb(await read(f, "audit"), assignmentId);
    assert.equal(reqOf(ob, "entrega").state, "pending");
    assert.equal(ob.outcome.status, "pending");
    assert.equal(ob.state!.submission_evidence.user_report, false);
    assert.equal(ob.state!.submission_evidence.native_completion, false);
    // O relato de conclusão existe como acontecimento, mas não é entrega.
    assert.ok(ob.state!.academic_events!.some((event) => event.event_type === "completion"));
  });
});

Deno.test("retract retira só a evidência corrente e preserva a memória; user_report antigo não ressuscita", async () => {
  await withOwner(async (f) => {
    const { hub, memory, attention, work, a, connectionId } = f;
    await memory.remember(
      a,
      connectionId,
      { kind: "assignments", course_id: 12 },
      result([
        { id: 11, course_id: 12, cmid: 101, name: "Atividade 1", duedate: 1791907200 },
      ], "2026-10-13T14:00:00Z"),
    );
    const assignmentId = await onlyEntityId(f, "assignment");
    const assignmentObs = await sourceObservation(f, assignmentId);
    await attention.recordRequirement(a, {
      source_entity_id: assignmentId,
      requirement_key: "entrega",
      observation_id: assignmentObs.observation_id,
      content_hash: assignmentObs.content_hash,
      excerpt: "Entregue a Atividade 1",
      action: "entregar a atividade",
      fulfillment: "submission",
    });
    const context = await hub.createContext(a, "Contexto da entrega");
    await work.bind(a, { context_id: context.id, expected_version: 0, entity_ids: [assignmentId] });
    const submit = await work.reportSubmission(a, {
      context_id: context.id,
      idempotency_key: crypto.randomUUID(),
      expected_version: 1,
      content: "Entreguei a Atividade 1.",
    });

    const before = findOb(await read(f, "audit"), assignmentId);
    assert.equal(reqOf(before, "entrega").state, "satisfied");
    assert.equal(before.state!.legacy_user_report_active, true);
    assert.equal(before.state!.user_report!.delta_id, submit.memory_commit.id);
    assert.equal(before.state!.submission_evidence.user_report, true);

    // Retratação: exige supersedes e a versão revisada do contexto.
    const version = (await hub.history(a, context.id)).context.version;
    const retract = await work.recordEvent(a, {
      content: "Retrato o relato de entrega anterior.",
      event_type: "submission",
      context_id: context.id,
      expected_version: version,
      supersedes: submit.memory_commit.id,
      retract: true,
      idempotency_key: crypto.randomUUID(),
    });
    assert.notEqual(retract.memory_commit.id, submit.memory_commit.id);

    const after = findOb(await read(f, "audit"), assignmentId);
    assert.equal(reqOf(after, "entrega").state, "pending");
    assert.equal(after.outcome.status, "pending");
    assert.equal(after.state!.legacy_user_report_active, false);
    assert.equal(after.state!.submission_evidence.user_report, false);
    // O estado antigo permanece como dado preservado, mas não volta a contar.
    assert.equal(after.state!.user_report!.delta_id, submit.memory_commit.id);

    const history = await hub.history(a, context.id);
    const original = history.records.find((record) => record.id === submit.memory_commit.id)!;
    const correction = history.records.find((record) => record.id === retract.memory_commit.id)!;
    assert.equal(original.content, "Entreguei a Atividade 1.");
    assert.equal(original.evidence_kind, "user_report");
    assert.equal(correction.kind, "correction");
    assert.equal(correction.scope.retracted, "true");
    assert.equal(correction.scope.supersedes, submit.memory_commit.id);
  });
});

Deno.test("summary compacta sem recursos nem discussão duplicada; audit permite fonte detalhada", async () => {
  await withOwner(async (f) => {
    const { hub, memory, attention, work, a, connectionId } = f;
    // Atividade com entrega relatada (deve aparecer como concluída).
    await memory.remember(
      a,
      connectionId,
      { kind: "assignments", course_id: 12 },
      result([
        { id: 11, course_id: 12, cmid: 101, name: "Atividade 1", duedate: 1791907200 },
      ], "2026-10-13T15:00:00Z"),
    );
    // Estrutura do curso com módulos de material (page/book/url) e uma atividade.
    await memory.remember(
      a,
      connectionId,
      { kind: "structure", course_id: 12 },
      result([{
        id: 1,
        section: 1,
        name: "Geral",
        visible: 1,
        modules: [
          {
            id: 101,
            instance: 11,
            modname: "assign",
            name: "Atividade 1",
            visible: 1,
            uservisible: true,
          },
          { id: 103, instance: 31, modname: "page", name: "Página", visible: 1, uservisible: true },
          { id: 104, instance: 41, modname: "book", name: "Livro", visible: 1, uservisible: true },
          { id: 105, instance: 51, modname: "url", name: "Link", visible: 1, uservisible: true },
        ],
      }], "2026-10-13T15:01:00Z"),
    );
    // Fórum com uma discussão vinculada e sem publicação do titular (pendente).
    await memory.remember(
      a,
      connectionId,
      { kind: "forums", course_id: 12 },
      result([
        { id: 22, course: 12, cmid: 102, name: "Fórum", intro: "Publique um tópico." },
      ], "2026-10-13T15:02:00Z"),
    );
    await memory.remember(
      a,
      connectionId,
      { kind: "discussions", forum_id: 22 },
      result(
        [{ id: 201, discussion: 77, discussion_id: 77, userid: 8, name: "Discussão" }],
        "2026-10-13T15:03:00Z",
      ),
    );

    const assignmentId = await onlyEntityId(f, "assignment");
    const forumId = await onlyEntityId(f, "forum");
    const discussionId = await onlyEntityId(f, "discussion");
    const moduleEntities = (await hub.entities(a, { kind: "module" })).records;
    assert.equal(moduleEntities.length, 4);
    const moduleIds = new Set(moduleEntities.map((row) => String(row.id)));
    const modnames = new Set<string>();
    for (const module of moduleEntities) {
      const detail = await hub.entityContext(a, String(module.id));
      const state = detail.entity.state as { provider_record?: { modname?: unknown } };
      modnames.add(String(state.provider_record?.modname));
    }
    assert.deepEqual([...modnames].sort(), ["assign", "book", "page", "url"]);

    await work.recordEvent(a, {
      content: "Entreguei a Atividade 1.",
      event_type: "submission",
      target_entity_id: assignmentId,
    });
    const forumObs = await sourceObservation(f, forumId);
    await attention.recordRequirement(a, {
      source_entity_id: forumId,
      requirement_key: "topico",
      observation_id: forumObs.observation_id,
      content_hash: forumObs.content_hash,
      excerpt: "Publique um tópico.",
      action: "publicar tópico",
      fulfillment: "forum_topic",
    });

    const summary = await read(f, "summary");
    const summaryKinds = summary.obligations.map((ob) => ob.entity.kind);
    assert.ok(!summaryKinds.includes("discussion"));
    assert.ok(!summaryKinds.includes("module"));
    for (const ob of summary.obligations) assert.equal(moduleIds.has(ob.entity.id), false);
    const sAssignment = findOb(summary, assignmentId);
    assert.equal(sAssignment.outcome.status, "concluded");
    const sForum = findOb(summary, forumId);
    assert.equal(sForum.outcome.status, "pending");
    assert.equal(reqOf(sForum, "topico").state, "pending");
    // A view compacta não carrega o inventário detalhado do audit.
    assert.equal(Object.hasOwn(sForum, "state"), false);
    assert.equal(Object.hasOwn(sForum, "gaps"), false);

    const audit = await read(f, "audit");
    assert.ok(audit.obligations.map((ob) => ob.entity.kind).includes("discussion"));
    assert.equal(findOb(audit, discussionId).entity.kind, "discussion");
    const aForum = forumWithRequirement(audit, "topico");
    assert.equal(reqOf(aForum, "topico").source!.excerpt, "Publique um tópico.");
    assert.ok(aForum.state);
    assert.ok(Array.isArray(aForum.gaps));
    assert.ok(aForum.provenance!.recorded_provenance !== undefined);
    assert.equal(aForum.state!.forum_publications!.publications.length, 0);
    assert.equal(aForum.state!.forum_publications!.replies.length, 0);
    assert.equal(findOb(audit, assignmentId).state!.submission_evidence.user_report, true);
  });
});

Deno.test("mais de 500 eventos de OUTRAS entidades não apaga a entrega da entidade filtrada", async () => {
  await withOwner(async (f) => {
    const { hub, memory, attention, work, a, connectionId } = f;
    await memory.remember(
      a,
      connectionId,
      { kind: "assignments", course_id: 12 },
      result([
        { id: 11, course_id: 12, cmid: 101, name: "Atividade filtrada", duedate: 1791907200 },
      ], "2026-10-13T16:00:00Z"),
    );
    const assignmentId = await onlyEntityId(f, "assignment");
    const report = await work.recordEvent(a, {
      content: "Entreguei a Atividade filtrada.",
      event_type: "submission",
      target_entity_id: assignmentId,
    });
    const baseline = findOb(await read(f, "audit", connectionId), assignmentId);
    assert.equal(baseline.outcome.status, "concluded");
    assert.equal(baseline.state!.submission_evidence.user_report, true);

    // Outra conexão do mesmo dono acumula mais de 500 eventos de outras entidades.
    const otherConnection = await hub.connect(a, "moodle", "Outra fonte", null, "7");
    const noiseTargets: string[] = [];
    for (let index = 0; index < 5; index++) {
      const entity = await hub.entity(
        a,
        otherConnection.id,
        "assignment",
        "noise:" + index,
        "Ruído " + index,
      );
      noiseTargets.push(String(entity.id));
    }
    for (let round = 0; round < 104; round++) {
      for (const target of noiseTargets) {
        await work.recordEvent(a, {
          content: "Evento ruído " + round + ".",
          event_type: "completion",
          target_entity_id: target,
          occurrence_key: "ruido-" + round,
        });
      }
    }
    const usage = await hub.usage(a) as { counts: Record<string, unknown> };
    assert.ok(Number(usage.counts.deltas) > 500, "esperava mais de 500 relatos sintéticos");

    const filtered = findOb(await read(f, "audit", connectionId), assignmentId);
    assert.equal(filtered.outcome.status, "concluded");
    assert.equal(filtered.state!.submission_evidence.user_report, true);
    assert.ok(
      filtered.state!.academic_events!.some((event) => event.delta_id === report.memory_commit.id),
    );
  });
});
