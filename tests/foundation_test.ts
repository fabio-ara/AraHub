import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { formatInstant, Hub, reconcileActivity, selectActivity } from "../src/domain.ts";
import type { Delta } from "../src/contracts.ts";
const URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";

Deno.test("A02 A03 A06–09: SQL real, RLS, idempotência e concorrência", async () => {
  const db = createDb(URL);
  const hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const c = await hub.createContext(a, "Trabalho sintético", { genre: "forum" });
    const d: Delta = {
      context_id: c.id,
      idempotency_key: crypto.randomUUID(),
      kind: "preference",
      content: "No fórum, explicar antes de nomear",
      evidence_kind: "user_report",
      expected_version: 0,
      scope: { genre: "forum" },
      provenance: [{ system: "synthetic", locator: "fixture:1" }],
    };
    const first = await hub.recordDelta(a, d), replay = await hub.recordDelta(a, d);
    assert.equal(first.id, replay.id);
    assert.equal(replay.replayed, true);
    await assert.rejects(hub.recordDelta(a, { ...d, content: "Texto diferente" }), /versão mudou/);
    const concurrent = await Promise.allSettled([
      hub.recordDelta(a, {
        ...d,
        idempotency_key: crypto.randomUUID(),
        expected_version: 1,
        content: "Revisão A",
      }),
      hub.recordDelta(a, {
        ...d,
        idempotency_key: crypto.randomUUID(),
        expected_version: 1,
        content: "Revisão B",
      }),
    ]);
    assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await hub.context(a, c.id)).deltas.length, 2);
    const snapshot = await hub.context(a, c.id);
    const commit = await hub.commitAndRefresh(a, {
      ...d,
      idempotency_key: crypto.randomUUID(),
      expected_version: snapshot.contexts[0].version,
      content: "Decisão salva antes do timeout",
    }, () => Promise.reject(new Error("secret-marker")));
    assert.equal(commit.source_refresh.status, "failed");
    assert.ok(commit.memory_commit.id);
    assert.equal((await hub.preferences(a, { genre: "article" })).applicable.length, 0);
    const legacy = await hub.preferences(a, { genre: "forum", institution: "synthetic" });
    assert.equal(legacy.applicable.length, 0);
    assert.equal(legacy.review_required.length, 3);
    assert.equal(legacy.history.length, 3);
    assert.equal((await hub.search(b, "Trabalho")).records.length, 0);
    const directOAuth = await db.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub',${a.ownerId},true)`;
      await tx`select set_config('request.jwt.claims',${
        JSON.stringify({ sub: a.ownerId, client_id: "unrelated-oauth-client", scope: "email" })
      },true)`;
      await tx`set local role authenticated`;
      return await tx`select id from public.hub_deltas`;
    });
    assert.equal(directOAuth.length, 0); // OIDC consent alone does not grant Data API memory access.
    await assert.rejects(hub.context(b, c.id), /não encontrado/);
    await assert.rejects(
      hub.recordDelta(b, { ...d, idempotency_key: crypto.randomUUID() }),
      /não encontrado/,
    );
    const con1 = await hub.connect(a, "moodle", "Instância A", "https://moodle.example.edu", "42");
    const con2 = await hub.connect(
      a,
      "moodle",
      "Instância B",
      "https://other.example.edu/moodle",
      "42",
    );
    const e1 = await hub.entity(a, con1.id, "course", "123", "Curso A");
    const e2 = await hub.entity(a, con2.id, "course", "123", "Curso B");
    assert.notEqual(e1.id, e2.id);
    await assert.rejects(hub.entity(b, con1.id, "course", "123", "Proibido"), /não encontrado/);
    const own = await hub.connect(b, "google", "Conta B", null, "sub-b");
    const be = await hub.entity(b, own.id, "file", "id-b", "Arquivo B");
    await assert.rejects(asOwner(db, b, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${b.ownerId},${be.id},${e1.id},'test','{}')`;
    }));
    await assert.rejects(asOwner(db, a, async (tx) => {
      await tx`update public.hub_contexts set owner_id=${b.ownerId} where id=${c.id}`;
    }));
    await assert.rejects(asOwner(db, a, async (tx) => {
      await tx`select * from arahub_private.credentials`;
    }));
    const exported = await hub.exportMemory(b);
    assert.equal(JSON.stringify(exported).includes("Curso A"), false);
    assert.equal(JSON.stringify(exported).includes("Decisão salva"), false);
    const tables =
      await db`select tablename from pg_tables where schemaname='public' and tablename like 'hub_%'`;
    for (const t of tables) {
      const rows = await asOwner(
        db,
        b,
        async (tx) => await tx`select owner_id from ${tx("public." + (t.tablename as string))}`,
      );
      assert.ok(rows.every((r) => r.owner_id === b.ownerId));
    }
  } finally {
    await db.end();
  }
});

Deno.test("A11–15: estado multidimensional, ambiguidades e horário de verão", () => {
  const report = reconcileActivity({}, { kind: "submission_report" });
  assert.deepEqual(report.user_report, { reported: true, actual_submission_time: null });
  const completion = reconcileActivity({}, { kind: "completion", value: true });
  assert.equal(completion.submitted, undefined);
  assert.equal(reconcileActivity(completion, { kind: "grade", value: 19 }).submitted, undefined);
  assert.equal(reconcileActivity(report, { kind: "reopened" }).availability, "reopened");
  assert.equal(
    reconcileActivity({}, { kind: "forum_post", value: "post-1", authorMatches: false })
      .forum_publication,
    undefined,
  );
  assert.throws(() => selectActivity(["a", "b"]), /Qual atividade/);
  assert.equal(selectActivity(["a"]), "a");
  assert.ok(formatInstant("2026-09-24T20:00:00Z", "Europe/Lisbon").includes("21:00"));
  assert.ok(formatInstant("2026-11-24T20:00:00Z", "Europe/Lisbon").includes("20:00"));
  assert.ok(formatInstant("2026-09-24T20:00:00Z", "America/Sao_Paulo").includes("17:00"));
});
