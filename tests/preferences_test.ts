import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import type { Delta } from "../src/contracts.ts";
import { resolvePreferences } from "../src/preferences.ts";

Deno.test("A09: vigência, superação e retirada preservam história sem ressuscitar regra antiga", async () => {
  const db = createDb(
    Deno.env.get("LOCAL_DATABASE_URL") ??
      "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub",
  );
  const hub = new Hub(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const c = await hub.createContext(a, "Preferências sintéticas");
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const after = new Date(Date.now() + 7_200_000).toISOString();
    let version = 0;
    const make = (content: string, options: Partial<Delta> = {}): Delta => ({
      context_id: c.id,
      expected_version: version,
      idempotency_key: crypto.randomUUID(),
      content,
      kind: "preference",
      evidence_kind: "user_report",
      scope: {},
      provenance: [],
      preference: { key: "style", state: "active", supersedes: [] },
      ...options,
    });
    const save = async (content: string, options: Partial<Delta> = {}) => {
      const d = make(content, options), receipt = await hub.recordDelta(a, d);
      version = receipt.version;
      return { d, receipt };
    };
    const first = await save("Explicar os conceitos");
    const change = await save("Usar exemplos no fórum", {
      scope: { genre: "forum" },
      preference: { key: "style", state: "active", supersedes: [] },
    });
    let result = await hub.preferences(a, { genre: "forum", institution: "synthetic" });
    assert.deepEqual(result.applicable.map((r) => r.id), [change.receipt.id]);
    assert.deepEqual(result.contextual_overrides, [first.receipt.id]);
    assert.equal(
      (await hub.preferences(a, { genre: "article" })).applicable[0].id,
      first.receipt.id,
    );
    const revised = await save("Exemplos somente até a próxima revisão", {
      scope: { genre: "forum" },
      preference: {
        key: "style",
        state: "active",
        supersedes: [change.receipt.id],
        valid_from: later,
        valid_until: after,
      },
    });
    const replay = await hub.recordDelta(a, revised.d);
    assert.equal(replay.replayed, true);
    assert.equal(
      (await hub.preferences(a, { genre: "forum" })).applicable[0].id,
      change.receipt.id,
    );
    result = await hub.preferences(a, { genre: "forum" }, later);
    assert.equal(result.applicable[0].id, revised.receipt.id);
    assert.equal(result.history.find((r) => r.id === change.receipt.id)?.status, "superseded");
    result = await hub.preferences(a, { genre: "forum" }, after);
    assert.equal(result.applicable[0].id, first.receipt.id); // Broader rule, not superseded forum text.
    assert.equal(result.history.find((r) => r.id === revised.receipt.id)?.status, "expired");
    const inferred = await save("Talvez prefira textos curtos", {
      evidence_kind: "hypothesis",
      preference: { key: "style", state: "active", supersedes: [] },
    });
    result = await hub.preferences(a, { genre: "article" });
    assert.equal(result.applicable[0].id, first.receipt.id);
    assert.ok(result.review_required.some((r) => r.id === inferred.receipt.id));
    assert.throws(
      () =>
        hub.recordDelta(
          a,
          make("Hipótese supera regra", {
            evidence_kind: "hypothesis",
            preference: { key: "style", state: "active", supersedes: [first.receipt.id] },
          }),
        ),
      /explicitamente/,
    );
    const rival = await save("Preferência explícita incompatível");
    result = await hub.preferences(a, {});
    assert.equal(result.applicable.length, 0);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(
      new Set(result.conflicts[0].ids),
      new Set([first.receipt.id, rival.receipt.id]),
    );
    const withdrawal = await save("Retiro ambas as preferências", {
      preference: {
        key: "style",
        state: "withdrawn",
        supersedes: [first.receipt.id, rival.receipt.id],
      },
    });
    result = await hub.preferences(a, {});
    assert.equal(result.applicable.length, 0);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.history.find((r) => r.id === withdrawal.receipt.id)?.status, "withdrawal");
    assert.equal((await hub.history(a, c.id)).records.length, version);
    assert.equal((await hub.preferences(b, { genre: "forum" })).history.length, 0);
    await assert.rejects(
      hub.recordDelta(b, {
        ...make("Alvo de outro dono"),
        context_id: (await hub.createContext(b, "Outro")).id,
        expected_version: 0,
        preference: { key: "style", state: "active", supersedes: [first.receipt.id] },
      }),
      /não encontrado/,
    );
    await assert.rejects(
      hub.recordDelta(
        a,
        make("Escopo não pode mudar alvo", {
          scope: { genre: "article" },
          preference: { key: "style", state: "active", supersedes: [change.receipt.id] },
        }),
      ),
      /não encontrado/,
    );
    assert.throws(() =>
      hub.recordDelta(
        a,
        make("Janela inválida", {
          preference: {
            key: "style",
            state: "active",
            supersedes: [],
            valid_from: after,
            valid_until: later,
          },
        }),
      )
    );
    // Data API inserts also enforce target ownership and explicit evidence; no alternate bypass.
    await assert.rejects(asOwner(db, a, async (tx) => {
      await tx`insert into public.hub_deltas(owner_id,context_id,idempotency_key,kind,content,evidence_kind,payload_hash,version,preference)
        values(${a.ownerId},${c.id},${crypto.randomUUID()},'preference','invalid','hypothesis','synthetic',${
        version + 1
      },${tx.json({ key: "style", state: "active", supersedes: [first.receipt.id] })})`;
    }));
    // The SQL clock can be a millisecond behind the application clock; pin the
    // historical instant to the first persisted event rather than wall time.
    const firstEvent = await asOwner(
      db,
      a,
      async (tx) =>
        (await tx`select recorded_at from public.hub_deltas where id=${first.receipt.id}`)[0],
    );
    const beforeFirst = new Date(new Date(firstEvent.recorded_at).getTime() - 1).toISOString();
    assert.equal((await hub.preferences(a, {}, beforeFirst)).applicable.length, 0);
  } finally {
    await db.end();
  }
});

Deno.test("A09: datas SQL preservam milissegundos na consulta histórica e na superação", () => {
  const first = {
    id: "first",
    scope: {},
    recorded_at: new Date("2026-10-05T12:00:00.123Z"),
    evidence_kind: "user_report",
    preference: { key: "style", state: "active", supersedes: [] },
  };
  const replacement = {
    ...first,
    id: "replacement",
    recorded_at: new Date("2026-10-05T12:00:00.456Z"),
    preference: { key: "style", state: "active", supersedes: ["first"] },
  };
  const rows = [replacement, first];
  assert.equal(resolvePreferences(rows, "2026-10-05T12:00:00.122Z").applicable.length, 0);
  assert.deepEqual(
    resolvePreferences(rows, "2026-10-05T12:00:00.123Z").applicable.map((r) => r.id),
    ["first"],
  );
  const after = resolvePreferences(rows, "2026-10-05T12:00:00.456Z");
  assert.deepEqual(after.applicable.map((r) => r.id), ["replacement"]);
  assert.equal(after.history.find((r) => r.id === "first")?.status, "superseded");
});

Deno.test("A09: escopos incomparáveis conflitam; cobertura parcial nunca confirma vigência", () => {
  const row = (id: string, scope: object) => ({
    id,
    scope,
    recorded_at: "2026-01-01T00:00:00Z",
    evidence_kind: "user_report",
    preference: { key: "style", state: "active", supersedes: [] },
  });
  const at = "2026-10-05T12:00:00Z";
  const result = resolvePreferences([
    row("a", { genre: "forum" }),
    row("b", { institution: "synthetic" }),
  ], at);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.applicable.length, 0);
  const partial = resolvePreferences(Array.from({ length: 201 }, (_, i) => row(String(i), {})), at);
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.applicable.length, 0);
});

Deno.test("A09: legado sem política conserva fontes para revisão sem afirmar aplicação atual", () => {
  const legacy = {
    id: "historical-goal",
    scope: {},
    evidence_kind: "user_report",
    content: "Objetivo e exemplo históricos; vigência atual não confirmada.",
    recorded_at: "2026-01-01T00:00:00Z",
    preference: null,
    provenance: [{ system: "fixture", locator: "private-source:12" }],
  };
  const explicit = {
    ...legacy,
    id: "explicit-scoped",
    scope: { genre: "forum" },
    preference: { key: "writing.style", state: "active", supersedes: [] },
  };
  const result = resolvePreferences([legacy, explicit], "2026-10-06T00:00:00Z");
  assert.deepEqual(result.applicable.map((r) => r.id), [explicit.id]);
  assert.deepEqual(result.review_required.map((r) => r.id), [legacy.id]);
  const retained = result.history.find((r) => r.id === legacy.id)!;
  assert.equal(retained.status, "legacy_requires_review");
  assert.equal(retained.content, legacy.content);
  assert.deepEqual(retained.provenance, legacy.provenance);
  assert.equal(result.history_tool, "hub_history");
});
