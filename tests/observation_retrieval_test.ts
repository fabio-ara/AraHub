import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";

const LOCAL_DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";

Deno.test("observações Moodle: versões paginadas, corpo por trechos e isolamento", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const conn = await hub.connect(
      owner,
      "moodle",
      "Moodle sintético",
      null,
      "observation-fixture",
    );
    const entity = await hub.entity(owner, conn.id, "module", "moodle:course/1/module/9", "Módulo");
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const content = {
        section_id: i < 12 ? 1 : 2,
        text: i === 22 ? "A".repeat(19000) : `versão ${i}`,
      };
      const observedAt = `2026-10-06T00:00:00.${String(i).padStart(6, "0")}Z`;
      const row = await asOwner(db, owner, async (tx) => {
        const inserted =
          await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
          values(${owner.ownerId},${entity.id},${tx.json(content)},${`synthetic-hash-${i}`},${
            tx.json({ system: "synthetic", locator: "fixture:module/9" })
          },'complete',${observedAt}::text::timestamptz) returning id`;
        return inserted[0];
      });
      ids.push(row.id);
    }
    const first = await hub.observations(owner, entity.id);
    assert.equal(first.records.length, 20);
    assert.equal(first.records[0].id, ids[22]);
    assert.equal(first.next_cursor?.id, ids[3]);
    assert.equal(first.next_cursor?.observed_at, "2026-10-06T00:00:00.000003Z");
    const last = await hub.observations(owner, entity.id, first.next_cursor!);
    assert.deepEqual(last.records.map((r) => r.id), [ids[2], ids[1], ids[0]]);
    assert.equal(last.next_cursor, null);
    const chunks: string[] = [];
    let offset = 0;
    do {
      const part = await hub.observationText(owner, ids[22], offset, 8000);
      assert.equal(part.entity_id, entity.id);
      assert.equal(part.text_format, "jsonb_serialization");
      chunks.push(part.excerpt);
      if (part.next_offset === null) break;
      offset = part.next_offset;
    } while (true);
    assert.deepEqual(JSON.parse(chunks.join("")), { section_id: 2, text: "A".repeat(19000) });
    await assert.rejects(hub.observations(other, entity.id), /não encontrado/);
    await assert.rejects(hub.observationText(other, ids[22]), /não encontrado/);
    assert.throws(() => hub.observationText(owner, ids[22], -1), /Trecho inválido/);
  } finally {
    await db.end();
  }
});
