import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { GoogleConnections } from "../src/google_connections.ts";
import { googleOAuthConfig, GoogleReadClient, verifierFromJwks } from "../src/adapters/google.ts";
import { createVerifier } from "../src/auth.ts";
import { createHandler } from "../src/http.ts";

Deno.test("A02 A19 A21: HTTP sessão→OAuth Google sintético→leitura nativa por MCP, conta e escopos vinculados", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db);
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    sid = crypto.randomUUID(),
    otherSid = crypto.randomUUID();
  const base = "https://hub.fixture.invalid", issuer = "https://auth.fixture.invalid/auth";
  const hubKeys = await generateKeyPair("ES256"), googleKeys = await generateKeyPair("RS256");
  const localKeys = createLocalJWKSet({
    keys: [{ ...await exportJWK(hubKeys.publicKey), kid: "hub", alg: "ES256" }],
  });
  const googleJwks = createLocalJWKSet({
    keys: [{ ...await exportJWK(googleKeys.publicKey), kid: "google", alg: "RS256" }],
  });
  const auth = {
    issuer,
    resource: `${base}/mcp`,
    audience: "authenticated",
    allowedClientIds: ["approved-mcp"],
    key: localKeys,
    sessionActive: (o: string, s: string) =>
      Promise.resolve((o === owner && s === sid) || (o === other && s === otherSid)),
  };
  const sign = (sub: string, session: string, clientId?: string) =>
    new SignJWT({
      role: "authenticated",
      session_id: session,
      ...(clientId ? { client_id: clientId } : {}),
    }).setProtectedHeader({ kid: "hub", alg: "ES256" }).setSubject(sub).setIssuer(issuer)
      .setAudience(auth.audience).setIssuedAt().setExpirationTime("10m").sign(hubKeys.privateKey);
  let googleIdToken = "", apiReads = 0;
  const scopes = "openid email profile https://www.googleapis.com/auth/drive.readonly";
  const fixtureFetch = (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/token") {
      return Promise.resolve(
        Response.json({
          id_token: googleIdToken,
          access_token: "synthetic-access-marker",
          refresh_token: "synthetic-refresh-marker",
          expires_in: 3600,
          scope: scopes,
        }),
      );
    }
    apiReads++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-access-marker");
    if (url.pathname === "/v1/documents/doc-1") {
      assert.equal(url.searchParams.get("includeTabsContent"), "true");
      return Promise.resolve(
        Response.json({
          documentId: "doc-1",
          tabs: [{
            documentTab: {
              body: {
                content: [{
                  paragraph: { elements: [{ textRun: { content: "Documento sintético nativo" } }] },
                }],
              },
            },
          }],
        }),
      );
    }
    throw new Error("Rota de fixture não prevista.");
  };
  const vault = await TokenVault.fromRawKeys([{
    kid: "fixture",
    key: crypto.getRandomValues(new Uint8Array(32)),
  }]);
  const google = new GoogleConnections(
    hub,
    vault,
    googleOAuthConfig({ clientId: "google-fixture", redirectUri: `${base}/oauth/google/callback` }),
    {
      fetch: fixtureFetch,
      verifier: verifierFromJwks(googleJwks),
      sessionActive: auth.sessionActive,
      clientFactory: (token) => new GoogleReadClient({ accessToken: token, fetch: fixtureFetch }),
    },
  );
  const handler = createHandler(hub, {
    auth,
    verify: createVerifier(auth),
    publicUrl: base,
    google,
  });
  const browser = await sign(owner, sid),
    mcp = await sign(owner, sid, "approved-mcp"),
    otherToken = await sign(other, otherSid);
  const post = (path: string, token: string, value: unknown) =>
    handler(
      new Request(base + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify(value),
      }),
    );
  const client = new Client({ name: "google-http-fixture", version: "1.0.0" });
  try {
    await db`insert into auth.users(id) values(${owner}),(${other})`;
    assert.equal(
      (await post("/api/connections/google/start", mcp, { label: "Conta", scopes: ["drive_read"] }))
        .status,
      403,
    );
    const response = await post("/api/connections/google/start", browser, {
      label: "Conta escolhida",
      scopes: ["drive_read"],
    });
    assert.equal(response.status, 200);
    const start = await response.json();
    const nonce = new URL(start.authorization_url).searchParams.get("nonce");
    googleIdToken = await new SignJWT({
      iss: "https://accounts.google.com",
      aud: "google-fixture",
      sub: "subject-fixture",
      nonce,
      email: "synthetic@example.invalid",
      email_verified: true,
    }).setProtectedHeader({ kid: "google", alg: "RS256" }).setIssuedAt().setExpirationTime("10m")
      .sign(googleKeys.privateKey);
    const callback = { state: start.state, code: "synthetic-code" };
    assert.equal(
      (await post("/api/connections/google/callback", otherToken, callback)).status,
      409,
    );
    assert.equal(
      (await post("/api/connections/google/callback", browser, { ...callback, owner_id: other }))
        .status,
      400,
    );
    const accepted = await post("/api/connections/google/callback", browser, callback);
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.text()).includes("synthetic-access-marker"), false);
    assert.equal((await post("/api/connections/google/callback", browser, callback)).status, 409);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(auth.resource), {
        requestInit: { headers: { Authorization: `Bearer ${mcp}` } },
        fetch: (input: string | URL | Request, init?: RequestInit) =>
          handler(new Request(input, init)),
      }),
    );
    const native = await client.callTool({
      name: "hub_google_read",
      arguments: { connection_id: start.connection_id, kind: "document", resource_id: "doc-1" },
    });
    assert.equal(native.isError, undefined);
    assert.match(JSON.stringify(native), /Documento sintético nativo/);
    assert.equal(JSON.stringify(native).includes("synthetic-access-marker"), false);
    const denied = await client.callTool({
      name: "hub_google_read",
      arguments: { connection_id: start.connection_id, kind: "gmail_messages" },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /scope_required/);
    assert.equal(apiReads, 1);
  } finally {
    await client.close();
    await db.end();
  }
});
