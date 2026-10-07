import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { DocumentMaterials, extractDocumentIsolated } from "../src/document_materials.ts";
import { sha256Hex } from "../src/migration.ts";
import { extractHtmlText } from "../src/document_text.ts";

Deno.test("durable document job: isolated worker, idempotent enqueue, owner/hash and paginated block retrieval", async () => {
  const db = createDb(
      Deno.env.get("LOCAL_DATABASE_URL") ??
        "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub",
    ),
    hub = new Hub(db);
  const p = { ownerId: crypto.randomUUID() }, q = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${p.ownerId}),(${q.ownerId})`;
    const c = await hub.connect(p, "moodle", "Document fixture", null, null, {}),
      e = await hub.entity(p, c.id, "resource", "html", "Book chapter", {});
    const bytes = new TextEncoder().encode(
        "<h1>Chapter</h1>" + Array.from({ length: 9 }, (_, i) => `<p>Paragraph ${i}</p>`).join("") +
          "<table><tr><td>Cell A</td><td>Cell B</td></tr></table>",
      ),
      hash = await sha256Hex(bytes);
    const [file] =
      await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content) values(${p.ownerId},${e.id},'chapter.html','text/html',${hash},${bytes.length},${
        Buffer.from(bytes)
      }) returning id`;
    const docs = new DocumentMaterials(hub),
      job = await docs.enqueue(p, file.id, hash),
      same = await docs.enqueue(p, file.id, hash);
    assert.equal(same.id, job.id);
    await assert.rejects(() => docs.enqueue(q, file.id, hash));
    const done = await docs.run(p, job.id);
    assert.ok(["complete", "partial"].includes(done.state));
    let offset: number | null = 0, total = 0;
    while (offset !== null) {
      const r = await docs.read(p, file.id, hash, offset, 3);
      total += r.blocks.length;
      offset = r.next_offset;
      assert.ok(r.blocks.length <= 3);
      assert.ok(!("sanitized_html" in (r.summary ?? {})));
    }
    assert.ok(total >= 10);
    await assert.rejects(() => docs.read(p, file.id, "0".repeat(64)));
    assert.equal((await docs.run(p, job.id)).state, "not_claimed");
    // Reprocessing the same hash with a weaker extractor must not erase the
    // stronger, already preserved document representation.
    await db`update public.hub_jobs set state='partial' where owner_id=${p.ownerId} and id=${job.id}`;
    const weaker = new DocumentMaterials(
      hub,
      async () => ({ ...extractHtmlText("<p>Less</p>"), coverage: "partial" as const }),
    );
    const retry = await weaker.run(p, job.id);
    assert.equal(retry.coverage?.preserved_prior, true);
    assert.equal((await docs.read(p, file.id, hash)).total, total);
    await assert.rejects(() => docs.read(q, file.id, hash));
  } finally {
    await db`delete from auth.users where id in (${p.ownerId},${q.ownerId})`;
    await db.end();
  }
});
Deno.test("document CPU timeout terminates worker", async () => {
  await assert.rejects(
    () => extractDocumentIsolated(new TextEncoder().encode("<p>Source</p>"), "html", 1),
    /limite/,
  );
});
