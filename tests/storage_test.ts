import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { sha256Hex } from "../src/migration.ts";

Deno.test("storage: mesmos bytes conservam referências, isolam donos e sobrevivem à exclusão de uma referência", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  const bytes = Buffer.from("Material de estudo privado — UTF-8"), hash = await sha256Hex(bytes);
  const ids: string[] = [];
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    for (const p of [a, a, b]) {
      const connection = await hub.connect(
        p,
        "moodle",
        "Teste de armazenamento",
        null,
        crypto.randomUUID(),
      );
      const entity = await hub.entity(p, connection.id, "resource", "file", "Documento", {});
      const id = await asOwner(db, p, async (tx) => {
        const [file] =
          await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content)
          values(${p.ownerId},${entity.id},'documento.txt','text/plain',${hash},${bytes.length},${bytes}) returning id`;
        await tx`select public.hub_compact_file(${file.id}::uuid)`;
        assert.equal(
          (await tx`select public.hub_compact_file(${file.id}::uuid) as changed`)[0].changed,
          false,
        );
        return file.id as string;
      });
      ids.push(id);
    }
    assert.equal(
      (await db`select count(*)::int as n from public.hub_file_blobs where owner_id in (${a.ownerId},${b.ownerId})`)[
        0
      ].n,
      2,
    );
    assert.equal(
      (await db`select count(*)::int as n from public.hub_files where owner_id=${a.ownerId} and binary_content is null`)[
        0
      ].n,
      2,
    );
    const usage = await hub.usage(a);
    assert.equal(usage.storage.preserved_binary_bytes, String(bytes.length * 2));
    assert.equal(usage.storage.stored_binary_bytes, String(bytes.length));
    assert.equal(usage.storage.deduplicated_bytes, String(bytes.length));
    const exported = await hub.exportMemory(a);
    const exportedFiles = exported.hub_files as {
      id: string;
      binary_content: Uint8Array;
      blob_sha256?: string;
    }[];
    assert.equal(exportedFiles.length, 2);
    for (const file of exportedFiles) {
      assert.ok(ids.slice(0, 2).includes(file.id));
      assert.deepEqual(Buffer.from(file.binary_content), bytes);
      assert.equal(file.blob_sha256, undefined);
    }
    await asOwner(db, a, async (tx) => {
      assert.equal((await tx`select * from public.hub_file_contents where id=${ids[2]}`).length, 0);
      assert.equal(
        (await tx`select * from public.hub_file_blobs where owner_id=${b.ownerId}`).length,
        0,
      );
      const [file] = await tx`select binary_content from public.hub_file_contents where id=${
        ids[0]
      }`;
      assert.deepEqual(Buffer.from(file.binary_content), bytes);
    });
    await db`delete from public.hub_files where id=${ids[0]}`;
    await asOwner(db, a, async (tx) => {
      assert.equal(Number((await tx`select public.hub_prune_file_blobs() as n`)[0].n), 0);
    });
    await assert.rejects(() =>
      asOwner(db, a, (tx) => tx`delete from public.hub_file_blobs where owner_id=${a.ownerId}`)
    );
    await db`delete from public.hub_files where id=${ids[1]}`;
    await asOwner(db, a, async (tx) => {
      assert.equal(Number((await tx`select public.hub_prune_file_blobs() as n`)[0].n), 1);
    });
    assert.equal((await hub.usage(b)).storage.stored_binary_bytes, String(bytes.length));
    await db`delete from auth.users where id=${b.ownerId}`;
    assert.equal(
      (await db`select count(*)::int as n from public.hub_file_blobs where owner_id=${b.ownerId}`)[
        0
      ].n,
      0,
    );
  } finally {
    await db`delete from auth.users where id in (${a.ownerId},${b.ownerId})`;
    await db.end();
  }
});

Deno.test("storage: hash inválido e dono cruzado recusados; compactação concorrente mantém um objeto", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  const bytes = Buffer.from("conteúdo concorrente"), hash = await sha256Hex(bytes);
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const connection = await hub.connect(a, "moodle", "Concorrência", null, crypto.randomUUID());
    const ids: string[] = [];
    for (const number of [1, 2, 3]) {
      const entity = await hub.entity(a, connection.id, "resource", String(number), "Arquivo", {});
      const [file] =
        await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content)
        values(${a.ownerId},${entity.id},'fixture.txt','text/plain',${
          number === 3 ? "0".repeat(64) : hash
        },${bytes.length},${bytes}) returning id`;
      ids.push(file.id);
    }
    await assert.rejects(() =>
      asOwner(db, b, (tx) => tx`select public.hub_compact_file(${ids[0]}::uuid)`)
    );
    await assert.rejects(() =>
      asOwner(db, a, (tx) => tx`select public.hub_compact_file(${ids[2]}::uuid)`)
    );
    await Promise.all(
      ids.slice(0, 2).map((id) =>
        asOwner(db, a, (tx) => tx`select public.hub_compact_file(${id}::uuid)`)
      ),
    );
    assert.equal(
      (await db`select count(*)::int as n from public.hub_file_blobs where owner_id=${a.ownerId}`)[
        0
      ].n,
      1,
    );
    assert.deepEqual(
      Buffer.from(
        (await db`select binary_content from public.hub_files where id=${ids[2]}`)[0]
          .binary_content,
      ),
      bytes,
    );
    await assert.rejects(() =>
      asOwner(db, a, (tx) => tx`update public.hub_files set bytes=bytes+1 where id=${ids[0]}`)
    );
  } finally {
    await db`delete from auth.users where id in (${a.ownerId},${b.ownerId})`;
    await db.end();
  }
});
