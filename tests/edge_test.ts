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
    const uiOrigin = "https://ui.fixture.invalid";
    const browserHandler = createEdgeHandler(new Hub(db), auth, base, undefined, undefined, {
      origin: uiOrigin,
      supabaseUrl: "https://identity.invalid",
      publishableKey: "public-fixture",
    });
    const options = (origin: string, headers = "authorization, content-type") =>
      new Request(`${base}/api/context`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": headers,
        },
      });
    const preflight = await browserHandler(options(uiOrigin));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), uiOrigin);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    assert.equal((await browserHandler(options("https://evil.invalid"))).status, 403);
    assert.equal((await browserHandler(options(uiOrigin, "x-unapproved"))).status, 403);
    const browserToken = await new SignJWT({ role: "authenticated", session_id: sid })
      .setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(owner).setIssuer(auth.issuer)
      .setAudience(auth.audience).setIssuedAt().setExpirationTime("10m").sign(privateKey);
    const browserContext = await browserHandler(
      new Request(`${base}/api/context`, {
        headers: { Origin: uiOrigin, Authorization: `Bearer ${browserToken}` },
      }),
    );
    assert.equal(browserContext.status, 200);
    assert.equal(browserContext.headers.get("access-control-allow-origin"), uiOrigin);
    assert.equal((await browserContext.json()).contexts.length, 0);
    const browserConfig = await browserHandler(new Request(`${base}/api/config`));
    assert.equal((await browserConfig.json()).publishableKey, "public-fixture");
    const rejected = await browserHandler(
      new Request(`${base}/api/context`, { headers: { Origin: uiOrigin } }),
    );
    assert.equal(rejected.status, 401);
    assert.equal(
      rejected.headers.get("www-authenticate"),
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    assert.throws(
      () =>
        createEdgeHandler(new Hub(db), auth, base, undefined, undefined, {
          origin: uiOrigin + "/",
        }),
      /origem/,
    );
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
