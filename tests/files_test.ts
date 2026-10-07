import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { boundedBody } from "../src/network.ts";
import { sha256Hex } from "../src/migration.ts";
Deno.test("A02 A23 A24: arquivos por proprietário, hash/continuação e pacote ligado à atividade", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const con = await hub.connect(a, "migration", "Fonte sintética", null, "fixture");
    const activity = await hub.entity(a, con.id, "activity", "1", "Fórum de estudo", {
      instruction: "Compare os dois argumentos com evidências.",
    });
    const material = await hub.entity(a, con.id, "resource", "1", "Texto ligado");
    const unrelated = await hub.entity(a, con.id, "resource", "2", "Texto sem relação");
    const content = new TextEncoder().encode("argumento A\nargumento B\n"),
      hash = await sha256Hex(content);
    const file = await asOwner(
      db,
      a,
      async (tx) =>
        (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${a.ownerId},${material.id},'fixture.txt','text/plain',${hash},${content.length},${
          Buffer.from(content)
        },'argumento A\nargumento B\n',${
          tx.json({ complete: true, pages: [{ page: 1, text: "PAGINA_NAO_LISTADA" }] })
        }) returning id`)[0],
    );
    const first = await hub.fileText(a, file.id, hash, 0, 11);
    assert.equal(first.excerpt, "argumento A");
    assert.equal(first.next_offset, 11);
    const firstMetadata = first as unknown as { extraction: Record<string, unknown> };
    assert.equal(Object.hasOwn(firstMetadata.extraction, "pages"), false);
    const second = await hub.fileText(a, file.id, hash, 11, 20);
    assert.equal(second.next_offset, null);
    await assert.rejects(hub.fileText(a, file.id, "wrong-hash"), /mudou/);
    await assert.rejects(hub.fileText(b, file.id, hash), /não encontrado/);
    assert.equal((await hub.files(b)).records.length, 0);
    assert.equal(Object.hasOwn((await hub.files(a)).records[0].extraction, "pages"), false);
    assert.equal((await hub.searchDocuments(b, "argumento")).records.length, 0);
    const matches = await hub.searchDocuments(a, "argumento");
    assert.equal(matches.records.length, 1);
    assert.equal(Object.hasOwn(matches.records[0].extraction, "pages"), false);
    await asOwner(db, a, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${a.ownerId},${activity.id},${material.id},'required','{"rights":"study only"}')`;
    });
    const pack = await hub.activityPackage(a, activity.id, "Entender os argumentos");
    assert.equal(pack.materials.length, 1);
    assert.equal(pack.materials[0].role, "required");
    assert.equal(pack.materials.some((m) => m.id === unrelated.id), false);
    assert.equal(pack.read_status[0].status, "available_not_confirmed_read");
    await assert.rejects(hub.activityPackage(b, activity.id, "indisponível"));
    assert.equal(
      (await hub.entities(a, { connection_id: con.id, kind: "activity" })).records[0].id,
      activity.id,
    );
    assert.equal((await hub.entities(b, { connection_id: con.id })).records.length, 0);
    assert.equal((await hub.entityContext(a, activity.id)).relations.length, 1);
    await assert.rejects(hub.entityContext(b, activity.id));
  } finally {
    await db.end();
  }
});
Deno.test("A05: corpo chunked é limitado antes de acumular conteúdo irrestrito", async () => {
  const req = new Request(
    "http://fixture.invalid",
    {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("123456"));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit,
  );
  await assert.rejects(boundedBody(req, 5), /limite/);
});
Deno.test("A05: cliente com corpo interrompido não prende a leitura indefinidamente", async () => {
  let cancelled = false;
  const req = new Request(
    "http://fixture.invalid",
    {
      method: "POST",
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit,
  );
  await assert.rejects(boundedBody(req, 100, 20), /expirou/);
  assert.equal(cancelled, true);
});
