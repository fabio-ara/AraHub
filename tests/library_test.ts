import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { Library, LIBRARY_PART_BYTES } from "../src/library.ts";
import { createEdgeHandler } from "../src/edge.ts";
import { sha256Hex } from "../src/migration.ts";
import { type LibraryFile, previewMime, readLibraryFile, safeFileName } from "../web/library.ts";

Deno.test("biblioteca: sessão web real assinada, partes íntegras, paginação, RLS e revogação", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db), library = new Library(db);
  const p = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const other = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const bytes = new Uint8Array(LIBRARY_PART_BYTES + 29).map((_, i) => i % 251);
  const hash = await sha256Hex(bytes);
  let active = true;
  try {
    await db`insert into auth.users(id) values(${p.ownerId}),(${other.ownerId})`;
    const connection = await hub.connect(p, "migration", "Biblioteca sintética", null, "fixture");
    const entity = await hub.entity(p, connection.id, "resource", "library", "Material sintético");
    const legacy = await hub.entity(
      p,
      connection.id,
      "source_document",
      "old-repo",
      "Memória importada",
    );
    await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content)
      values(${p.ownerId},${legacy.id},'verificar.py','text/plain',${hash},${bytes.length},${
      Buffer.from(bytes)
    })`;
    const [file] =
      await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content)
      values(${p.ownerId},${entity.id},'material.pdf','application/pdf',${hash},${bytes.length},${
        Buffer.from(bytes)
      }) returning id`;
    for (let i = 0; i < 21; i++) {
      const content = new TextEncoder().encode("versão " + i);
      await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content)
        values(${p.ownerId},${entity.id},'material.txt','text/plain',${await sha256Hex(
        content,
      )},${content.length},${Buffer.from(content)})`;
    }
    const first = await library.list(p);
    const second = await library.list(p, first.next_id);
    assert.equal(first.files.length, 20);
    assert.ok(first.files.every((f) => f.source === "" && f.name !== "verificar.py"));
    const [preserved] =
      await db`select count(*)::integer as n from public.hub_files where entity_id=${legacy.id}`;
    assert.equal(preserved.n, 1);
    assert.equal(second.files.length, 2);
    assert.equal(second.next_id, null);
    assert.equal(new Set([...first.files, ...second.files].map((f) => f.id)).size, 22);
    assert.equal((await library.list(other)).files.length, 0);
    await assert.rejects(library.list({ ...p, clientId: "mcp" }), /sessão pessoal/);
    await assert.rejects(
      library.part(other, { file_id: file.id, sha256: hash, offset: 0 }),
      /não encontrado/,
    );
    await assert.rejects(
      library.part(p, { file_id: file.id, sha256: "0".repeat(64), offset: 0 }),
      /não encontrado/,
    );
    await assert.rejects(
      library.part(p, { file_id: file.id, sha256: hash, offset: 1 }),
      /inválida/,
    );
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const base = "https://library.invalid/functions/v1/arahub";
    const auth = {
      issuer: "https://identity.invalid/auth",
      audience: "authenticated",
      resource: base + "/mcp",
      allowedClientIds: ["mcp"],
      sessionActive: (owner: string, session: string) =>
        Promise.resolve(active && owner === p.ownerId && session === p.sessionId),
      key: createLocalJWKSet({
        keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "ES256" }],
      }),
    };
    const handler = createEdgeHandler(hub, auth, base, undefined, { origin: "https://ui.invalid" });
    const token = await new SignJWT({ role: "authenticated", session_id: p.sessionId })
      .setProtectedHeader({ alg: "ES256", kid: "test" }).setSubject(p.ownerId).setIssuer(
        auth.issuer,
      )
      .setAudience(auth.audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const call = (
      path: string,
      body: unknown,
      authorization = "Bearer " + token,
      origin = "https://ui.invalid",
    ) =>
      handler(
        new Request(base + path, {
          method: "POST",
          headers: {
            Authorization: authorization,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const listing = await call("/api/library/list", {});
    assert.equal(listing.status, 200);
    assert.equal(listing.headers.get("access-control-allow-origin"), "https://ui.invalid");
    assert.equal((await listing.json()).files.length, 20);
    const info = [...first.files, ...second.files].find((f) => f.id === file.id) as LibraryFile;
    const result = await readLibraryFile(info, (offset) =>
      call("/api/library/part", {
        file_id: file.id,
        sha256: hash,
        offset,
      }), new AbortController().signal);
    assert.deepEqual(result, bytes);
    for (
      const response of [
        await call("/api/library/list", {}, ""),
        await call("/api/library/list", {}, "Bearer " + token, "https://evil.invalid"),
      ]
    ) {
      assert.ok([401, 403].includes(response.status));
      await response.body?.cancel();
    }
    await db`update public.hub_files set binary_content=${
      Buffer.from(bytes.map((v) => v ^ 1))
    } where id=${file.id}`;
    await assert.rejects(
      library.part(p, { file_id: file.id, sha256: hash, offset: 0 }),
      /não está disponível/,
    );
    active = false;
    const revoked = await call("/api/library/part", {
      file_id: file.id,
      sha256: hash,
      offset: LIBRARY_PART_BYTES,
    });
    assert.equal(revoked.status, 401);
    await revoked.body?.cancel();
  } finally {
    await db.end();
  }
});

Deno.test("biblioteca: cliente recusa truncamento, corrupção, excesso, cancelamento e formatos ativos", async () => {
  const bytes = new TextEncoder().encode("arquivo de prova");
  const file: LibraryFile = {
    id: crypto.randomUUID(),
    name: "../a\r\n.pdf",
    sha256: await sha256Hex(bytes),
    bytes: bytes.length,
    mime_type: "application/pdf",
    source: "Teste",
    source_title: "Teste",
    available: true,
  };
  const response = (data: Uint8Array) =>
    Promise.resolve(
      new Response(new Uint8Array(data), {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  for (const bad of [bytes.slice(1), new Uint8Array(bytes.length + 1), bytes.map((v) => v ^ 1)]) {
    await assert.rejects(readLibraryFile(file, () => response(bad), new AbortController().signal));
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(readLibraryFile(file, () => response(bytes), aborted.signal));
  assert.equal(safeFileName(file.name), "a.pdf");
  for (
    const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "application/javascript"]
  ) {
    assert.equal(previewMime(mime), null);
  }
  assert.equal(previewMime("application/pdf"), "application/pdf");
});
