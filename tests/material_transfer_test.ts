import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { MaterialTransfers } from "../src/material_transfer.ts";
import { sha256Hex } from "../src/migration.ts";
import { createEdgeHandler, createSupabaseGatewayHandler } from "../src/edge.ts";

async function fixture(size = 2 * 1024 * 1024 + 23) {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db),
    p = {
      ownerId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      clientId: "material-fixture",
    };
  const other = { ...p, ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const key = crypto.getRandomValues(new Uint8Array(32));
  const base = "https://fixture.invalid/functions/v1/arahub";
  let now = new Date(), active = true;
  const access = {
    allowedClientIds: [p.clientId],
    sessionActive: (o: string, s: string) =>
      Promise.resolve(
        active &&
          ((o === p.ownerId && s === p.sessionId) ||
            (o === other.ownerId && s === other.sessionId)),
      ),
  };
  await db`insert into auth.users(id) values(${p.ownerId}),(${other.ownerId})`;
  const con = await hub.connect(p, "migration", "Transferência sintética", null, "fixture");
  const entity = await hub.entity(p, con.id, "resource", "binary", "Material sintético");
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const hash = await sha256Hex(bytes);
  const [file] =
    await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content)
    values(${p.ownerId},${entity.id},${"../ação\r\n.mp4"},'video/mp4',${hash},${bytes.length},${
      Buffer.from(bytes)
    }) returning id`;
  const transfers = new MaterialTransfers(db, key, base, access, () => now);
  return {
    db,
    hub,
    p,
    other,
    key,
    base,
    access,
    bytes,
    hash,
    file,
    transfers,
    clock: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
    revoke: () => {
      active = false;
    },
    request: (value: Awaited<ReturnType<MaterialTransfers["prepare"]>>) =>
      new Request(value.transfer.url, { headers: value.transfer.headers }),
  };
}

Deno.test("transferência: bytes íntegros em chunks, hash fixado e isolamento por dono", async () => {
  const f = await fixture();
  try {
    const cap = await f.transfers.prepare(f.p, f.file.id, f.hash);
    assert.equal(cap.name, "ação.mp4");
    assert.equal(new URL(cap.transfer.url).search, "");
    const response = await f.transfers.download(f.request(cap));
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(response.headers.get("content-length"), String(f.bytes.length));
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    const result = new Uint8Array(await response.arrayBuffer());
    assert.equal(await sha256Hex(result), f.hash);
    assert.equal(result.length, f.bytes.length);
    await assert.rejects(f.transfers.prepare(f.other, f.file.id, f.hash), /não encontrado/);
    await assert.rejects(f.transfers.prepare(f.p, f.file.id, "0".repeat(64)), /não encontrado/);
    await assert.rejects(
      f.transfers.prepare({ ...f.p, clientId: undefined }, f.file.id, f.hash),
      /não autorizada/,
    );
    await f.db`update public.hub_files set binary_content=${
      Buffer.from(new Uint8Array(f.bytes.length).fill(70))
    } where id=${f.file.id}`;
    await assert.rejects(f.transfers.prepare(f.p, f.file.id, f.hash), /íntegro indisponível/);
    await f.db`update public.hub_files set binary_content=${
      Buffer.from("corrompido")
    } where id=${f.file.id}`;
    await assert.rejects(f.transfers.prepare(f.p, f.file.id, f.hash), /íntegro indisponível/);
    await assert.rejects(f.transfers.download(f.request(cap)), /não autorizada/);
    await f.db`update public.hub_files set binary_content=null where id=${f.file.id}`;
    await assert.rejects(f.transfers.prepare(f.p, f.file.id, f.hash), /íntegro indisponível/);
  } finally {
    await f.db.end();
  }
});

Deno.test("transferência: assinatura, tipo, audiência, sessão, cliente, expiração e URL estritos", async () => {
  const f = await fixture();
  try {
    const cap = await f.transfers.prepare(f.p, f.file.id, f.hash);
    const jwt = cap.transfer.headers.Authorization.slice(7);
    const original = decodeJwt(jwt);
    const invalid = async (
      claims: Record<string, unknown>,
      key = f.key,
      typ = "arahub-material-transfer+jwt",
    ) => {
      const value = await new SignJWT({ ...original, ...claims }).setProtectedHeader({
        alg: "HS256",
        typ,
      }).sign(key);
      await assert.rejects(
        f.transfers.download(
          new Request(cap.transfer.url, { headers: { Authorization: "Bearer " + value } }),
        ),
        /não autorizada/,
      );
    };
    await invalid({}, crypto.getRandomValues(new Uint8Array(32)));
    await invalid({}, f.key, "JWT");
    for (
      const claims of [
        { aud: "authenticated" },
        { iss: "https://wrong.invalid" },
        { session: crypto.randomUUID() },
        { client: "unapproved" },
        { sub: f.other.ownerId, session: f.other.sessionId },
        { file: crypto.randomUUID() },
        { sha256: "f".repeat(64) },
        { bytes: f.bytes.length + 1 },
        { exp: Number(original.exp) + 1 },
        { iat: Number(original.iat) + 60, exp: Number(original.exp) + 60 },
      ]
    ) await invalid(claims);
    for (
      const req of [
        new Request(cap.transfer.url),
        new Request(cap.transfer.url + "?token=anything", { headers: cap.transfer.headers }),
        new Request(cap.transfer.url, {
          headers: { ...cap.transfer.headers, Range: "bytes=0-9,20-29" },
        }),
        new Request(cap.transfer.url, { method: "POST", headers: cap.transfer.headers }),
      ]
    ) await assert.rejects(f.transfers.download(req), /não autorizada/);
    f.access.allowedClientIds.length = 0;
    await assert.rejects(f.transfers.download(f.request(cap)), /não autorizada/);
    f.access.allowedClientIds.push(f.p.clientId);
    f.clock(300);
    await assert.rejects(f.transfers.download(f.request(cap)), /não autorizada/);
  } finally {
    await f.db.end();
  }
});

Deno.test("transferência: partes limitadas reconstituem hash completo sem intervalos inválidos", async () => {
  const f = await fixture(9 * 1024 * 1024 + 31);
  try {
    const cap = await f.transfers.prepare(f.p, f.file.id, f.hash);
    assert.equal(cap.transfer.parts.length, 3);
    await assert.rejects(f.transfers.download(f.request(cap)), /até 4 MiB/);
    const merged = new Uint8Array(f.bytes.length);
    for (const part of cap.transfer.parts) {
      const r = await f.transfers.download(
        new Request(cap.transfer.url, {
          headers: { ...cap.transfer.headers, Range: part.range },
        }),
      );
      assert.equal(r.status, 206);
      assert.equal(
        r.headers.get("content-range"),
        `bytes ${part.offset}-${part.offset + part.bytes - 1}/${f.bytes.length}`,
      );
      const bytes = new Uint8Array(await r.arrayBuffer());
      assert.equal(bytes.length, part.bytes);
      assert.ok(bytes.length <= 4 * 1024 * 1024);
      merged.set(bytes, part.offset);
    }
    assert.equal(await sha256Hex(merged), f.hash);
    for (
      const range of [
        "bytes=-5",
        "bytes=0-",
        "bytes=01-3",
        "bytes=3-2",
        "bytes=0-99999999",
        "bytes=0-4194304",
        "bytes=9007199254740992-9007199254740993",
      ]
    ) {
      await assert.rejects(f.transfers.download(
        new Request(cap.transfer.url, {
          headers: { ...cap.transfer.headers, Range: range },
        }),
      ));
    }
    f.revoke();
    await assert.rejects(
      f.transfers.download(
        new Request(cap.transfer.url, {
          headers: { ...cap.transfer.headers, Range: cap.transfer.parts[1].range },
        }),
      ),
      /não autorizada/,
    );
  } finally {
    await f.db.end();
  }
});

Deno.test("transferência: revogação e expiração interrompem chunks posteriores sem sucesso falso", async () => {
  for (const event of ["revoke", "expire", "abort", "cancel"] as const) {
    const f = await fixture();
    try {
      const cap = await f.transfers.prepare(f.p, f.file.id, f.hash);
      const abort = new AbortController();
      const response = await f.transfers.download(
        new Request(cap.transfer.url, { headers: cap.transfer.headers, signal: abort.signal }),
      );
      const reader = response.body!.getReader();
      assert.equal((await reader.read()).value?.length, 1024 * 1024);
      if (event === "revoke") f.revoke();
      if (event === "expire") f.clock(300);
      if (event === "abort") abort.abort();
      if (event === "cancel") {
        await reader.cancel();
        assert.equal((await reader.read()).done, true);
      } else await assert.rejects(reader.read(), /Transferência interrompida/);
    } finally {
      await f.db.end();
    }
  }
});

Deno.test("transferência: cliente MCP SDK, gateway Edge e capacidades não intercambiáveis", async () => {
  const f = await fixture();
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const auth = {
    ...f.access,
    issuer: "https://identity.invalid/auth",
    audience: "authenticated",
    resource: f.base + "/mcp",
    key: createLocalJWKSet({
      keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "ES256" }],
    }),
  };
  const handler = createSupabaseGatewayHandler(
    createEdgeHandler(f.hub, auth, f.base, undefined, {
      origin: "https://ui.invalid",
      materialTransfers: f.transfers,
    }),
    f.base,
  );
  const token = await new SignJWT({
    role: "authenticated",
    session_id: f.p.sessionId,
    client_id: f.p.clientId,
  })
    .setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(f.p.ownerId).setIssuer(
      auth.issuer,
    )
    .setAudience(auth.audience).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const client = new Client({ name: "transfer-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(auth.resource), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
        fetch: (url: string | URL | Request, init?: RequestInit) => handler(new Request(url, init)),
      }),
    );
    assert.equal(
      (await client.listTools()).tools.find((
        t: { name: string; annotations?: { readOnlyHint?: boolean } },
      ) => t.name === "hub_material_transfer")?.annotations
        ?.readOnlyHint,
      true,
    );
    const call = await client.callTool({
      name: "hub_material_transfer",
      arguments: { file_id: f.file.id, sha256: f.hash },
    });
    assert.equal(call.isError, undefined);
    const cap = JSON.parse((call.content as { text: string }[])[0].text);
    const download = await handler(f.request(cap));
    assert.equal(download.status, 200);
    assert.equal(await sha256Hex(new Uint8Array(await download.arrayBuffer())), f.hash);
    const mcp = await handler(
      new Request(auth.resource, { method: "POST", headers: cap.transfer.headers }),
    );
    assert.equal(mcp.status, 401);
    assert.equal((await mcp.text()).includes(cap.transfer.headers.Authorization), false);
    const wrong = await handler(
      new Request(cap.transfer.url, { headers: { Authorization: "Bearer " + token } }),
    );
    assert.equal(wrong.status, 403);
    await wrong.body?.cancel();
    const evil = await handler(
      new Request(cap.transfer.url, {
        headers: { ...cap.transfer.headers, Origin: "https://evil.invalid" },
      }),
    );
    assert.equal(evil.status, 403);
    await evil.body?.cancel();
    const runtime = await handler(
      new Request("http://fixture.invalid/arahub/api/material-transfer", {
        headers: cap.transfer.headers,
      }),
    );
    assert.equal(runtime.status, 200);
    assert.equal(await sha256Hex(new Uint8Array(await runtime.arrayBuffer())), f.hash);
    const off = createEdgeHandler(f.hub, auth, f.base);
    const unavailable = await off(f.request(cap));
    assert.equal(unavailable.status, 404);
    await unavailable.body?.cancel();
  } finally {
    await client.close();
    await f.db.end();
  }
});
