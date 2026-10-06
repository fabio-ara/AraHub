import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";

Deno.test("A02 A10: títulos e contextos antigos são recuperáveis com continuação explícita por dono", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db),
    owner = { ownerId: crypto.randomUUID() },
    other = {
      ownerId: crypto.randomUUID(),
    };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    await db`insert into public.hub_contexts(owner_id,title,scope,updated_at)
      select ${owner.ownerId}, 'Contexto sintético título ' || n,
        '{}'::jsonb, now() - n * interval '1 day' from generate_series(1,45) n`;
    const outside = await hub.createContext(other, "Contexto sintético título 45");
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await hub.context(owner, undefined, offset);
      assert.ok(page.contexts.length <= 20);
      ids.push(...page.contexts.map((c) => c.id));
      assert.ok(!page.contexts.some((c) => c.id === outside.id));
      assert.equal(page.coverage.contexts, page.next_offset === null ? "complete" : "partial");
      offset = page.next_offset;
    }
    assert.equal(ids.length, 45);
    assert.equal(new Set(ids).size, 45);
    const byTitle = await hub.search(owner, "título 45");
    assert.equal(byTitle.records.length, 0);
    assert.equal(byTitle.contexts.length, 1);
    assert.ok(ids.includes(byTitle.contexts[0].id));
    assert.notEqual(byTitle.contexts[0].id, outside.id);
    assert.equal(byTitle.next_offset, null);
    const searchIds: string[] = [];
    offset = 0;
    while (offset !== null) {
      const page = await hub.search(owner, "Contexto sintético título", offset);
      searchIds.push(...page.contexts.map((c) => c.id));
      assert.equal(page.record_next_offset, null);
      assert.equal(page.next_offset, page.context_next_offset);
      offset = page.next_offset;
    }
    assert.deepEqual(searchIds, ids);
    const selected = ids.at(-1)!;
    for (let index = 0; index < 55; index++) {
      await hub.recordDelta(owner, {
        context_id: selected,
        idempotency_key: "retrieval-synthetic-event-" + index,
        kind: "decision",
        content: "Decisão sintética paginada " + index,
        evidence_kind: "interpretation",
        expected_version: index,
        provenance: [{ system: "fixture", locator: "synthetic:event:" + index }],
      });
    }
    const first = await hub.context(owner, selected);
    assert.equal(first.deltas.length, 50);
    assert.equal(first.deltas_next_offset, 50);
    assert.equal(first.coverage.deltas, "partial");
    const second = await hub.context(owner, selected, 0, first.deltas_next_offset!);
    assert.equal(second.deltas.length, 5);
    assert.equal(second.coverage.deltas, "complete");
    assert.equal(second.deltas_next_offset, null);
    assert.equal(new Set([...first.deltas, ...second.deltas].map((d) => d.id)).size, 55);
    await assert.rejects(hub.context(other, selected), /encontrado/);
    assert.throws(() => hub.context(owner, selected, 1), /Página/);
    assert.throws(() => hub.context(owner, undefined, -1), /Página/);
    assert.throws(() => hub.context(owner, selected, 0, 0.5), /Página/);
  } finally {
    await db.end();
  }
});
