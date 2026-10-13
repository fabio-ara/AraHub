/**
 * Testes dirigidos locais do relato acadêmico do WorkContext (cenários A/E/F).
 *
 * SQL real no Postgres exclusivo do AraHub (127.0.0.1:55432), com contas e
 * atividades sintéticas sob IDs próprios. Sem rede externa, credenciais ou
 * dados reais. Cobre relato de submission, idempotência/reconciliação,
 * resolução por atividade, alias módulo→has_content, ambiguidade, isolamento
 * por dono, versionamento/correção e preservação do histórico, além dos
 * relatos separados de completion/feedback/deadline. Não exercita attention
 * nem MCP.
 */

import assert from "node:assert/strict";
import { asOwner, createDb, type Db } from "../src/db.ts";
import { HubError, type Principal } from "../src/contracts.ts";
import { Hub } from "../src/domain.ts";
import { WorkContext } from "../src/work_context.ts";

const DB_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";

const expectCode = async (code: string, run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HubError, "esperava HubError " + code + ": " + String(error));
    assert.equal((error as HubError).code, code);
    return;
  }
  assert.fail("esperava falha " + code);
};

const counts = async (db: Db, owner: string) => {
  const [row] = await db`select
    (select count(*)::int from public.hub_contexts where owner_id=${owner}) as contexts,
    (select count(*)::int from public.hub_deltas where owner_id=${owner}) as deltas,
    (select count(*)::int from public.hub_context_targets where owner_id=${owner}) as targets,
    (select count(*)::int from public.hub_entities where owner_id=${owner}) as entities,
    (select count(*)::int from public.hub_observations where owner_id=${owner}) as observations`;
  return {
    contexts: Number(row.contexts),
    deltas: Number(row.deltas),
    targets: Number(row.targets),
    entities: Number(row.entities),
    observations: Number(row.observations),
  };
};

interface Fixture {
  db: Db;
  hub: Hub;
  work: WorkContext;
  a: Principal;
  b: Principal;
  connectionId: string;
}

/** Cria duas contas sintéticas e sempre as remove no finally, sob IDs próprios. */
async function withOwners(run: (fixture: Fixture) => Promise<void>) {
  const db = createDb(DB_URL);
  const a: Principal = { ownerId: crypto.randomUUID() };
  const b: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const hub = new Hub(db);
    const connection = await hub.connect(
      a,
      "moodle",
      "Fixture sintética",
      "https://fixture.invalid",
      "1",
    );
    await run({ db, hub, work: new WorkContext(hub), a, b, connectionId: connection.id });
  } finally {
    try {
      await db`delete from auth.users where id in (${a.ownerId},${b.ownerId})`;
    } catch {
      // Limpeza de melhor esforço; nunca mascara o resultado do teste.
    }
    await db.end();
  }
}

Deno.test("acadêmico A: relato submission vira user_report e retry/concorrência criam um só delta", async () => {
  await withOwners(async ({ db, hub, work, a, connectionId }) => {
    const assignment = await hub.entity(a, connectionId, "assignment", "1", "Tarefa A");
    const first = await work.recordEvent(a, {
      content: "Entreguei a tarefa pelo Moodle.",
      event_type: "submission",
      target_entity_id: assignment.id,
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(first.evidence_kind, "user_report");
    assert.equal(first.external_submission, "not_verified");
    assert.equal(first.event_type, "submission");
    assert.equal(first.target_entity_id, assignment.id);
    assert.equal(first.memory_commit.replayed, false);

    const [stored] = await db`select kind,evidence_kind,scope from public.hub_deltas
      where owner_id=${a.ownerId} and id=${first.memory_commit.id}`;
    assert.equal(stored.kind, "submission_report");
    assert.equal(stored.evidence_kind, "user_report");
    assert.equal(stored.scope.academic_event, "submission");
    assert.equal(stored.scope.entity_id, assignment.id);

    const afterFirst = await counts(db, a.ownerId);
    assert.equal(afterFirst.contexts, 1);
    assert.equal(afterFirst.deltas, 1);

    // Repetição idêntica com chave nova é replay, não novo delta.
    const replay = await work.recordEvent(a, {
      content: "Entreguei a tarefa pelo Moodle.",
      event_type: "submission",
      target_entity_id: assignment.id,
      idempotency_key: crypto.randomUUID(),
    });
    assert.equal(replay.memory_commit.replayed, true);
    assert.equal(replay.memory_commit.id, first.memory_commit.id);
    assert.equal(replay.context_id, first.context_id);
    assert.deepEqual(await counts(db, a.ownerId), afterFirst);

    // Chamadas concorrentes do mesmo relato não duplicam delta nem contexto.
    const other = await hub.entity(a, connectionId, "assignment", "2", "Tarefa B");
    const raced = await Promise.allSettled([
      work.recordEvent(a, {
        content: "Segundo relato sintético.",
        event_type: "submission",
        target_entity_id: other.id,
        idempotency_key: crypto.randomUUID(),
      }),
      work.recordEvent(a, {
        content: "Segundo relato sintético.",
        event_type: "submission",
        target_entity_id: other.id,
        idempotency_key: crypto.randomUUID(),
      }),
    ]);
    const values = raced.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
    assert.equal(values.length, 2);
    assert.equal(values[0].context_id, values[1].context_id);
    assert.equal(values[0].memory_commit.id, values[1].memory_commit.id);
    assert.equal(values.filter((value) => value.memory_commit.replayed === false).length, 1);
    const afterRace = await counts(db, a.ownerId);
    assert.equal(afterRace.contexts, afterFirst.contexts + 1);
    assert.equal(afterRace.deltas, afterFirst.deltas + 1);
  });
});

Deno.test("acadêmico E: entity-only resolve/cria contexto, alias de módulo e ambiguidade não gravam", async () => {
  await withOwners(async ({ db, hub, work, a, b, connectionId }) => {
    // entity-only cria o contexto uma vez e o reutiliza no retry.
    const solo = await hub.entity(a, connectionId, "assignment", "e1", "Tarefa única");
    const created = await work.recordEvent(a, {
      content: "Relato inicial.",
      event_type: "submission",
      target_entity_id: solo.id,
    });
    const replayed = await work.recordEvent(a, {
      content: "Relato inicial.",
      event_type: "submission",
      target_entity_id: solo.id,
    });
    assert.equal(replayed.memory_commit.replayed, true);
    assert.equal(replayed.memory_commit.id, created.memory_commit.id);
    assert.equal(replayed.context_id, created.context_id);
    const resolved = await work.targets(a, created.context_id);
    assert.equal(resolved.resolution, "unique");
    assert.deepEqual(resolved.targets.map((target) => target.id), [solo.id]);

    // Contexto inequívoco pré-existente é reutilizado por um novo acontecimento.
    const milestone = await work.recordEvent(a, {
      content: "Concluí sem abrir um contexto novo.",
      event_type: "completion",
      target_entity_id: solo.id,
      occurrence_key: "marco-1",
    });
    assert.equal(milestone.context_id, created.context_id);
    assert.equal((await counts(db, a.ownerId)).contexts, 1);

    // Alias módulo→has_content resolve para a atividade interna, sem duplicar.
    const module = await hub.entity(a, connectionId, "module", "m1", "Módulo com uma tarefa");
    const inner = await hub.entity(a, connectionId, "assignment", "e2", "Tarefa do módulo");
    await db`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
      values(${a.ownerId},${module.id},${inner.id},'has_content','{}')`;
    const viaModule = await work.recordEvent(a, {
      content: "Feito pelo módulo.",
      event_type: "submission",
      target_entity_id: module.id,
      occurrence_key: "occ-modulo",
    });
    assert.equal(viaModule.target_entity_id, inner.id);
    const viaInner = await work.recordEvent(a, {
      content: "Feito pelo módulo.",
      event_type: "submission",
      target_entity_id: inner.id,
      occurrence_key: "occ-modulo",
    });
    assert.equal(viaInner.memory_commit.replayed, true);
    assert.equal(viaInner.memory_commit.id, viaModule.memory_commit.id);
    assert.equal(viaInner.context_id, viaModule.context_id);
    assert.equal((await counts(db, a.ownerId)).contexts, 2);

    // Módulo com duas atividades é ambíguo e não cria memória.
    const ambiguousModule = await hub.entity(a, connectionId, "module", "m2", "Módulo ambíguo");
    const childA = await hub.entity(a, connectionId, "assignment", "e3", "Tarefa 3");
    const childB = await hub.entity(a, connectionId, "forum", "e4", "Fórum 4");
    await db`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values
      (${a.ownerId},${ambiguousModule.id},${childA.id},'has_content','{}'),
      (${a.ownerId},${ambiguousModule.id},${childB.id},'has_content','{}')`;
    const beforeModule = await counts(db, a.ownerId);
    await expectCode("ambiguous_activity", () =>
      work.recordEvent(a, {
        content: "Ambíguo pelo módulo.",
        event_type: "submission",
        target_entity_id: ambiguousModule.id,
      }));
    assert.deepEqual(await counts(db, a.ownerId), beforeModule);

    // Atividade vinculada a dois contextos é ambígua e não cria memória.
    const shared = await hub.entity(a, connectionId, "assignment", "e5", "Tarefa compartilhada");
    const contextX = await hub.createContext(a, "Contexto X");
    const contextY = await hub.createContext(a, "Contexto Y");
    await work.bind(a, { context_id: contextX.id, expected_version: 0, entity_ids: [shared.id] });
    await work.bind(a, { context_id: contextY.id, expected_version: 0, entity_ids: [shared.id] });
    const beforeContext = await counts(db, a.ownerId);
    await expectCode("ambiguous_context", () =>
      work.recordEvent(a, {
        content: "Ambíguo por contexto.",
        event_type: "completion",
        target_entity_id: shared.id,
        occurrence_key: "ctx-amb",
      }));
    assert.deepEqual(await counts(db, a.ownerId), beforeContext);

    // Contexto sem alvo ativo não infere atividade nem grava memória.
    const emptyContext = await hub.createContext(a, "Contexto vazio");
    const beforeEmpty = await counts(db, a.ownerId);
    await expectCode("ambiguous_activity", () =>
      work.recordEvent(a, {
        content: "Sem alvo vinculado.",
        event_type: "submission",
        context_id: emptyContext.id,
      }));
    assert.deepEqual(await counts(db, a.ownerId), beforeEmpty);
    await expectCode(
      "ambiguous_activity",
      () => work.recordEvent(a, { content: "Sem alvo nem contexto.", event_type: "submission" }),
    );

    // RLS: o segundo dono não vê nem alcança contexto/atividade do titular.
    await expectCode("not_found", () =>
      work.recordEvent(b, {
        content: "Intruso.",
        event_type: "submission",
        context_id: created.context_id,
      }));
    await expectCode("not_found", () =>
      work.recordEvent(b, {
        content: "Intruso.",
        event_type: "submission",
        target_entity_id: solo.id,
      }));
    await expectCode("not_found", () => work.targets(b, created.context_id));
    const visibleToB = await asOwner(
      db,
      b,
      (tx) => tx`select count(*)::int as c from public.hub_contexts`,
    );
    assert.equal(Number(visibleToB[0].c), 0);
    const visibleToA = await asOwner(
      db,
      a,
      (tx) => tx`select count(*)::int as c from public.hub_contexts`,
    );
    assert.ok(Number(visibleToA[0].c) > 0);
    assert.equal((await counts(db, b.ownerId)).deltas, 0);
    assert.equal((await counts(db, b.ownerId)).contexts, 0);
  });
});

Deno.test("acadêmico F: versão exigida para corrigir, só uma correção vence e o histórico recupera", async () => {
  await withOwners(async ({ db, hub, work, a, connectionId }) => {
    const assignment = await hub.entity(a, connectionId, "assignment", "f1", "Tarefa F");
    const original = await work.recordEvent(a, {
      content: "Entreguei.",
      event_type: "submission",
      target_entity_id: assignment.id,
      idempotency_key: "synthetic-original-0001",
    });
    assert.equal(original.memory_commit.replayed, false);

    // expected_version desatualizada falha sem gravar.
    const before = await counts(db, a.ownerId);
    await expectCode("version_conflict", () =>
      work.recordEvent(a, {
        content: "Correção com versão velha.",
        event_type: "submission",
        context_id: original.context_id,
        expected_version: 99,
        occurrence_key: "stale-1",
      }));
    assert.deepEqual(await counts(db, a.ownerId), before);

    // Toda correção exige o registro anterior e a versão revisada.
    await expectCode("version_required", () =>
      work.recordEvent(a, {
        content: "Correção sem versão.",
        event_type: "submission",
        context_id: original.context_id,
        supersedes: original.memory_commit.id,
      }));
    await expectCode("version_required", () =>
      work.recordEvent(a, {
        content: "Retratação sem anterior.",
        event_type: "submission",
        context_id: original.context_id,
        retract: true,
        expected_version: 1,
      }));

    // Correção válida cria delta próprio e preserva o original.
    const correction = await work.recordEvent(a, {
      content: "Na verdade entreguei mais tarde.",
      event_type: "submission",
      context_id: original.context_id,
      expected_version: 1,
      supersedes: original.memory_commit.id,
      idempotency_key: "synthetic-correction-0001",
    });
    assert.notEqual(correction.memory_commit.id, original.memory_commit.id);
    const [correctionRow] = await db`select kind,evidence_kind,scope from public.hub_deltas
      where owner_id=${a.ownerId} and id=${correction.memory_commit.id}`;
    assert.equal(correctionRow.kind, "correction");
    assert.equal(correctionRow.evidence_kind, "user_report");
    assert.equal(correctionRow.scope.supersedes, original.memory_commit.id);
    const [originalRow] = await db`select content,evidence_kind from public.hub_deltas
      where owner_id=${a.ownerId} and id=${original.memory_commit.id}`;
    assert.equal(originalRow.content, "Entreguei.");
    assert.equal(originalRow.evidence_kind, "user_report");

    // Corrigir de novo o mesmo original é recusado mesmo com a versão corrente.
    const currentVersion = (await hub.history(a, original.context_id)).context.version;
    await expectCode("version_conflict", () =>
      work.recordEvent(a, {
        content: "Segunda correção do mesmo original.",
        event_type: "submission",
        context_id: original.context_id,
        expected_version: currentVersion,
        supersedes: original.memory_commit.id,
      }));

    // Um novo relato recebe apenas uma das correções concorrentes.
    const second = await work.recordEvent(a, {
      content: "Segunda entrega relatada.",
      event_type: "submission",
      target_entity_id: assignment.id,
      occurrence_key: "occ-2",
      idempotency_key: "synthetic-original-0002",
    });
    const raceVersion = (await hub.history(a, original.context_id)).context.version;
    const raced = await Promise.allSettled([
      work.recordEvent(a, {
        content: "Correção concorrente um.",
        event_type: "submission",
        context_id: original.context_id,
        expected_version: raceVersion,
        supersedes: second.memory_commit.id,
        idempotency_key: crypto.randomUUID(),
      }),
      work.recordEvent(a, {
        content: "Correção concorrente dois.",
        event_type: "submission",
        context_id: original.context_id,
        expected_version: raceVersion,
        supersedes: second.memory_commit.id,
        idempotency_key: crypto.randomUUID(),
      }),
    ]);
    assert.equal(raced.filter((entry) => entry.status === "fulfilled").length, 1);
    const rejected = raced.filter((entry) =>
      entry.status === "rejected"
    ) as PromiseRejectedResult[];
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof HubError);
    assert.equal((rejected[0].reason as HubError).code, "version_conflict");
    const [corrections] = await db`select count(*)::int as total from public.hub_deltas
      where owner_id=${a.ownerId} and scope->>'supersedes'=${second.memory_commit.id}`;
    assert.equal(Number(corrections.total), 1);

    // Histórico preservado em memória e recuperado por instância nova.
    const history = await hub.history(a, original.context_id);
    const ids = history.records.map((record) => record.id);
    assert.ok(ids.includes(original.memory_commit.id));
    assert.ok(ids.includes(correction.memory_commit.id));
    assert.ok(ids.includes(second.memory_commit.id));

    const freshDb = createDb(DB_URL);
    try {
      const freshHub = new Hub(freshDb);
      const freshWork = new WorkContext(freshHub);
      const recovered = await freshHub.history(a, original.context_id);
      assert.ok(recovered.records.some((record) => record.id === original.memory_commit.id));
      assert.ok(recovered.records.some((record) => record.id === correction.memory_commit.id));
      const replay = await freshWork.recordEvent(a, {
        content: "Entreguei.",
        event_type: "submission",
        target_entity_id: assignment.id,
        idempotency_key: "synthetic-original-0001",
      });
      assert.equal(replay.memory_commit.replayed, true);
      assert.equal(replay.memory_commit.id, original.memory_commit.id);
    } finally {
      await freshDb.end();
    }
  });
});

Deno.test("acadêmico: completion, feedback e deadline são relatos separados, sem conexão", async () => {
  await withOwners(async ({ db, hub, work, a, connectionId }) => {
    const assignment = await hub.entity(a, connectionId, "assignment", "g1", "Tarefa G");
    const completion = await work.recordEvent(a, {
      content: "Concluí a atividade.",
      event_type: "completion",
      target_entity_id: assignment.id,
      occurrence_key: "done-1",
    });
    const feedback = await work.recordEvent(a, {
      content: "Recebi devolutiva do docente.",
      event_type: "feedback_received",
      target_entity_id: assignment.id,
      occurrence_key: "fb-1",
    });
    const deadline = await work.recordEvent(a, {
      content: "O prazo foi prorrogado.",
      event_type: "deadline_change",
      target_entity_id: assignment.id,
      occurrence_key: "dl-1",
      original_date: "2026-11-02",
    });
    const ids = [completion.memory_commit.id, feedback.memory_commit.id, deadline.memory_commit.id];
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(
      [completion.event_type, feedback.event_type, deadline.event_type],
      ["completion", "feedback_received", "deadline_change"],
    );
    for (const report of [completion, feedback, deadline]) {
      assert.equal(report.evidence_kind, "user_report");
      assert.equal(report.external_submission, "not_verified");
      assert.equal(report.target_entity_id, assignment.id);
      assert.equal("connection_id" in report, false);
    }
    const [storedDeadline] = await db`select kind,evidence_kind,scope,provenance
      from public.hub_deltas where owner_id=${a.ownerId} and id=${deadline.memory_commit.id}`;
    assert.equal(storedDeadline.kind, "experience");
    assert.equal(storedDeadline.evidence_kind, "user_report");
    assert.equal(storedDeadline.scope.academic_event, "deadline_change");
    assert.equal(storedDeadline.provenance[0].system, "user_report");
    assert.equal(storedDeadline.provenance[0].original_date, "2026-11-02");
    // Nada é observado na fonte: relato do usuário não cria observação de conexão.
    assert.equal((await counts(db, a.ownerId)).observations, 0);
  });
});
