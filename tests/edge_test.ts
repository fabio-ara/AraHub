import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { createEdgeHandler } from "../src/edge.ts";

Deno.test("A02 A28: prefixo Edge, discovery e sessão revogada por cliente SDK sintético", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const owner = crypto.randomUUID(),
    sid = crypto.randomUUID(),
    base = "https://fixture.invalid/functions/v1/arahub";
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  let active = true;
  const auth = {
    issuer: "https://identity.invalid/auth",
    audience: "authenticated",
    resource: `${base}/mcp`,
    allowedClientIds: ["edge-fixture"],
    key: createLocalJWKSet({
      keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "ES256" }],
    }),
    sessionActive: (o: string, s: string) => Promise.resolve(active && o === owner && s === sid),
  };
  const handler = createEdgeHandler(new Hub(db), auth, base + "/");
  const token = await new SignJWT({
    role: "authenticated",
    session_id: sid,
    client_id: "edge-fixture",
  }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(owner).setIssuer(auth.issuer)
    .setAudience(auth.audience).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const client = new Client({ name: "edge-local-fixture", version: "1.0.0" });
  try {
    await db`insert into auth.users(id) values(${owner})`;
    const metadata = await handler(new Request(`${base}/.well-known/oauth-protected-resource`));
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).resource, auth.resource);
    const noToken = await handler(new Request(auth.resource, { method: "POST" }));
    assert.equal(noToken.status, 401);
    assert.equal(
      noToken.headers.get("www-authenticate"),
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    for (
      const url of [
        "https://fixture.invalid/mcp",
        `${base}-evil/mcp`,
        `${base}/ui/app.js`,
        "https://attacker.invalid/functions/v1/arahub/mcp",
      ]
    ) assert.equal((await handler(new Request(url))).status, 404);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(auth.resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: (input: string | URL | Request, init?: RequestInit) =>
          handler(new Request(input, init)),
      }),
    );
    assert.ok(
      (await client.listTools()).tools.some((t: { name: string }) => t.name === "hub_record_delta"),
    );
    const result = await client.callTool({
      name: "hub_create_context",
      arguments: { title: "Contexto Edge sintético" },
    });
    assert.equal(result.isError, undefined);
    active = false;
    assert.equal(
      (await handler(
        new Request(auth.resource, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
      )).status,
      401,
    );
    assert.throws(
      () =>
        createEdgeHandler(new Hub(db), { ...auth, resource: "https://wrong.invalid/mcp" }, base),
      /recurso/,
    );
  } finally {
    await client.close();
    await db.end();
  }
});
