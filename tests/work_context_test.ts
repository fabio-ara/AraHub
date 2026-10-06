import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { comparePublishedText, WorkContext } from "../src/work_context.ts";

Deno.test("A02 A08 A11: alvo explícito, ambiguidade, relato transacional e retry após mudança de contexto", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db),
    work = new WorkContext(hub);
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const conn = await hub.connect(a, "moodle", "Fixture", "https://fixture.invalid", "1");
    const first = await hub.entity(a, conn.id, "assignment", "1", "Atividade um", {
      completion: true,
    });
    const second = await hub.entity(a, conn.id, "forum", "2", "Atividade dois");
    const ctx = await hub.createContext(a, "Trabalho aberto");
    const base = {
      context_id: ctx.id,
      expected_version: 0,
      idempotency_key: crypto.randomUUID(),
      content: "Pronto, entreguei",
    };
    await assert.rejects(work.reportSubmission(a, base), /Qual atividade/);
    await assert.rejects(
      work.bind(b, { context_id: ctx.id, expected_version: 0, entity_ids: [first.id] }),
      /não encontrado/,
    );
    await work.bind(a, {
      context_id: ctx.id,
      expected_version: 0,
      entity_ids: [first.id, second.id],
    });
    assert.equal((await work.targets(a, ctx.id)).resolution, "ambiguous");
    await assert.rejects(
      work.reportSubmission(a, { ...base, expected_version: 1 }),
      /Qual das atividades/,
    );
    assert.equal((await hub.history(a, ctx.id)).records.length, 0);
    await work.bind(a, { context_id: ctx.id, expected_version: 1, entity_ids: [first.id] });
    const report = { ...base, expected_version: 2 };
    const race = await Promise.allSettled([
      work.reportSubmission(a, report),
      work.reportSubmission(a, {
        ...report,
        idempotency_key: crypto.randomUUID(),
        content: "Relato concorrente diferente",
      }),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    // Use whichever committed payload for the idempotency proof.
    const event = (await hub.history(a, ctx.id)).records[0];
    const committed = event.content === report.content ? report : {
      ...report,
      idempotency_key: (await asOwner(db, a, async (tx) =>
        (await tx`select idempotency_key from public.hub_deltas where id=${event.id}`)[0]))
        .idempotency_key,
      content: event.content,
    };
    const before = await work.reportSubmission(a, committed);
    assert.equal(before.actual_submission_time, null);
    assert.equal(before.external_submission, "not_verified");
    assert.equal((await hub.entityContext(a, first.id)).entity.state.completion, true);
    await work.bind(a, { context_id: ctx.id, expected_version: 3, entity_ids: [second.id] });
    const replay = await work.reportSubmission(a, committed);
    assert.equal(replay.target_entity_id, first.id);
    assert.equal(replay.memory_commit.replayed, true);
    await assert.rejects(
      work.reportSubmission(a, { ...committed, content: "Texto mudou" }),
      /chave/,
    );
    assert.equal((await hub.history(a, ctx.id)).records.length, 1);
    assert.equal((await hub.entityContext(a, second.id)).entity.state.user_report, undefined);
    await assert.rejects(work.targets(b, ctx.id), /não encontrado/);
  } finally {
    await db.end();
  }
});

Deno.test("A13: comparar texto publicado não confunde autoria nem equivalência semântica", () => {
  assert.equal(comparePublishedText("Minha versão.", "Minha versão.", false).state, "other_author");
  assert.equal(
    comparePublishedText("Minha\n versão.", "Minha versão.", true).matches_selected,
    true,
  );
  assert.equal(
    comparePublishedText("Minha versão.", "Minha versão revisada.", true).state,
    "differs_from_selected",
  );
});

Deno.test("A02 A13: comparação usa versão escolhida e observação Moodle qualificada, não estado alegado", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db),
    work = new WorkContext(hub);
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const conn = await hub.connect(a, "moodle", "Fixture", "https://fixture.invalid", "17");
    const post = await hub.entity(a, conn.id, "post", "45", "Publicação", {
      userid: 17,
      message: "Alegação sem observação",
    });
    const context = await hub.createContext(a, "Rascunhos");
    const draft = await hub.recordDelta(a, {
      context_id: context.id,
      idempotency_key: crypto.randomUUID(),
      expected_version: 0,
      kind: "artifact",
      evidence_kind: "user_report",
      content: "Versão selecionada.",
      provenance: [],
    });
    await hub.recordDelta(a, {
      context_id: context.id,
      idempotency_key: crypto.randomUUID(),
      expected_version: 1,
      kind: "artifact",
      evidence_kind: "user_report",
      content: "Versão nova diferente.",
      provenance: [],
    });
    assert.equal((await work.compareForumDraft(a, draft.id, post.id)).state, "not_observed");
    const observe = async (
      content: { userid?: number; author?: { userid: number }; message: string },
      coverage = "complete",
      system = "moodle",
      minute = 0,
    ) => {
      const instant = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
      await db`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${a.ownerId},${post.id},${
        db.json(content)
      },${crypto.randomUUID()},${
        db.json({ system, connection_id: conn.id })
      },${coverage},${instant})`;
    };
    await observe({ author: { userid: 17 }, message: "Versão\n selecionada." });
    const match = await work.compareForumDraft(a, draft.id, post.id);
    assert.equal(match.state, "matches_selected");
    assert.ok("selected_draft" in match);
    if ("selected_draft" in match) assert.equal(match.selected_draft.id, draft.id);
    await assert.rejects(work.compareForumDraft(b, draft.id, post.id), /não encontrada/);
    await observe({ userid: 88, message: "Versão selecionada." }, "complete", "moodle", 1);
    assert.equal((await work.compareForumDraft(a, draft.id, post.id)).state, "other_author");
    await observe({ userid: 17, message: "Versão selecionada." }, "partial", "moodle", 2);
    assert.equal((await work.compareForumDraft(a, draft.id, post.id)).state, "evidence_incomplete");
    await observe({ userid: 17, message: "Versão selecionada." }, "complete", "user_report", 3);
    assert.equal((await work.compareForumDraft(a, draft.id, post.id)).state, "evidence_incomplete");
    await observe({ userid: 17, message: "Versão nova diferente." }, "complete", "moodle", 4);
    assert.equal(
      (await work.compareForumDraft(a, draft.id, post.id)).state,
      "differs_from_selected",
    );
  } finally {
    await db.end();
  }
});
