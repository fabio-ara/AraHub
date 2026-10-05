/**
 * Testes do servico GoogleConnections contra o Postgres local (dados sinteticos).
 * Sem OAuth real e sem escrita externa: fetch e verificador de id_token sao injetados.
 * Executar: deno test --allow-net=127.0.0.1:55432 --allow-env tests/google_connections_test.ts
 */

import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb, type Db } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { PostgresTokenStore } from "../src/connections.ts";
import { openAccessToken, openRefreshToken, TokenVault } from "../src/adapters/token_vault.ts";
import {
  type FetchLike,
  googleOAuthConfig,
  sha256Hex,
  verifierFromJwks,
} from "../src/adapters/google.ts";
import {
  GOOGLE_READ_CAPABILITIES,
  GoogleConnections,
  type GooglePrincipal,
  resolveRequestedScopes,
} from "../src/google_connections.ts";
import { HubError } from "../src/contracts.ts";

const DB_URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const ISSUER = "https://accounts.google.com";
const CLIENT_ID = "client-abc";
const DEFAULT_GRANTED = "openid email profile https://www.googleapis.com/auth/gmail.readonly";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Env {
  readonly db: Db;
  readonly hub: Hub;
  readonly vault: TokenVault;
  readonly service: GoogleConnections;
  readonly sign: (claims: Record<string, unknown>) => Promise<string>;
  readonly setTokenResponse: (tokens: unknown) => void;
  readonly setTokenError: (body: unknown, status?: number) => void;
}

async function makeEnv(
  extra: { sessionActive?: (ownerId: string, sessionId: string) => Promise<boolean> } = {},
): Promise<Env> {
  const db = createDb(DB_URL);
  const hub = new Hub(db);
  const vault = await TokenVault.fromRawKeys([
    { kid: "fixture", key: crypto.getRandomValues(new Uint8Array(32)) },
  ]);
  const config = googleOAuthConfig({
    clientId: CLIENT_ID,
    redirectUri: "https://hub.example/oauth/google/callback",
  });
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k";
  jwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  let respond: () => Response | Promise<Response> = () =>
    jsonResponse({ error: "invalid_grant" }, 400);
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/token") return await respond();
    throw new Error("rota nao mapeada: " + url.pathname);
  };
  const service = new GoogleConnections(hub, vault, config, {
    fetch: fetchImpl,
    verifier: verifierFromJwks(jwks),
    sessionActive: extra.sessionActive,
  });
  return {
    db,
    hub,
    vault,
    service,
    sign,
    setTokenResponse: (tokens) => {
      respond = typeof tokens === "function"
        ? (tokens as () => Response)
        : () => jsonResponse(tokens);
    },
    setTokenError: (body, status = 400) => {
      respond = () => jsonResponse(body, status);
    },
  };
}

async function newPrincipal(db: Db): Promise<GooglePrincipal> {
  const ownerId = crypto.randomUUID();
  await db.unsafe("insert into auth.users(id) values($1)", [ownerId]);
  return { ownerId, sessionId: crypto.randomUUID() };
}

async function authorize(
  env: Env,
  p: GooglePrincipal,
  opts: {
    readonly label?: string;
    readonly scopes?: readonly string[];
    readonly sub?: string;
    readonly hd?: string;
    readonly email?: string;
    readonly granted?: string;
    readonly access?: string;
    readonly refresh?: string | null;
    readonly connection_id?: string;
  } = {},
) {
  const start = await env.service.start(p, {
    label: opts.label ?? "Conta Google",
    scopes: opts.scopes ?? ["gmail_read"],
    connection_id: opts.connection_id,
  });
  const nonce = new URL(start.authorization_url).searchParams.get("nonce") as string;
  const idToken = await env.sign({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: opts.sub ?? "google-sub-1",
    nonce,
    ...(opts.hd ? { hd: opts.hd } : {}),
    ...(opts.email ? { email: opts.email } : {}),
  });
  const tokens: Record<string, unknown> = {
    access_token: opts.access ?? "ya29.access-marker",
    expires_in: 3600,
    scope: opts.granted ?? DEFAULT_GRANTED,
    token_type: "Bearer",
    id_token: idToken,
  };
  if (opts.refresh !== null) tokens.refresh_token = opts.refresh ?? "1//refresh-marker";
  env.setTokenResponse(tokens);
  const view = await env.service.callback(p, { code: "code-1", state: start.state });
  return { start, view, nonce, idToken };
}

// ---------------------------------------------------------------------------
// Guarda de navegador e escopos
// ---------------------------------------------------------------------------

Deno.test("novo consentimento após desconexão reativa somente a mesma conta", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db), first = await authorize(env, p);
    await env.service.disconnect(p, first.view.id);
    const renewed = await authorize(env, p, { connection_id: first.view.id });
    assert.equal(renewed.view.state, "connected");
    assert.equal(renewed.view.account.subject, first.view.account.subject);
    const record = await new PostgresTokenStore(env.db, p).read(p.ownerId, first.view.id);
    assert.equal(record?.version, 1);
  } finally {
    await env.db.end();
  }
});

Deno.test("start exige navegador e sessao valida", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    await assert.rejects(
      env.service.start({ ...p, clientId: "model-client" }, { label: "x", scopes: ["gmail_read"] }),
      (error: unknown) => error instanceof HubError && error.code === "browser_required",
    );
    await assert.rejects(
      env.service.start({ ownerId: p.ownerId }, { label: "x", scopes: ["gmail_read"] }),
      (error: unknown) => error instanceof HubError && error.code === "session_required",
    );
    await assert.rejects(
      env.service.start(
        { ownerId: p.ownerId, sessionId: "nao-e-uuid" },
        { label: "x", scopes: ["gmail_read"] },
      ),
      (error: unknown) => error instanceof HubError && error.code === "session_required",
    );
  } finally {
    await env.db.end();
  }
});

Deno.test("sessao inativa e recusada pelo verificador injetado", async () => {
  const env = await makeEnv({ sessionActive: () => Promise.resolve(false) });
  try {
    const p = await newPrincipal(env.db);
    await assert.rejects(
      env.service.start(p, { label: "x", scopes: ["gmail_read"] }),
      (error: unknown) => error instanceof HubError && error.code === "session_required",
    );
  } finally {
    await env.db.end();
  }
});

Deno.test("escopos fora da allowlist de leitura sao recusados", async () => {
  assert.throws(
    () => resolveRequestedScopes(["driveFull"]),
    (error: unknown) => error instanceof HubError && error.code === "invalid_scope",
  );
  assert.throws(
    () => resolveRequestedScopes(["https://www.googleapis.com/auth/drive"]),
    (error: unknown) => error instanceof HubError && error.code === "invalid_scope",
  );
  assert.throws(
    () => resolveRequestedScopes(["gmail.modify"]),
    (error: unknown) => error instanceof HubError && error.code === "invalid_scope",
  );
  const read = resolveRequestedScopes(["gmail_read"]);
  assert.ok(read.includes("openid"));
  assert.ok(read.includes(GOOGLE_READ_CAPABILITIES.gmail_read[0]));
  const selected = resolveRequestedScopes(["selected_files"]);
  assert.ok(selected.includes(GOOGLE_READ_CAPABILITIES.selected_files[0]));

  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    await assert.rejects(
      env.service.start(p, { label: "x", scopes: ["driveFull"] }),
      (error: unknown) => error instanceof HubError && error.code === "invalid_scope",
    );
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Pendencia privada
// ---------------------------------------------------------------------------

Deno.test("start grava pendencia privada one-use amarrada a owner e sessao", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const start = await env.service.start(p, { label: "Conta", scopes: ["gmail_read"] });
    const nonce = new URL(start.authorization_url).searchParams.get("nonce") as string;
    const rows = await env.db.unsafe(
      "select state_hash,owner_id,session_id,connection_id,desired_scopes,sealed,expires_at,consumed_at from arahub_private.oauth_pending where owner_id=$1",
      [p.ownerId],
    );
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.state_hash, await sha256Hex(start.state));
    assert.strictEqual(row.session_id, p.sessionId);
    assert.strictEqual(row.connection_id, start.connection_id);
    assert.ok((row.desired_scopes as string[]).includes(GOOGLE_READ_CAPABILITIES.gmail_read[0]));
    assert.strictEqual(row.consumed_at, null);
    assert.ok(row.expires_at instanceof Date);
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes(start.state), false);
    assert.equal(serialized.includes(nonce), false);
    assert.equal(typeof (row.sealed as { nonce: { ct: string } }).nonce.ct, "string");
    assert.equal(typeof (row.sealed as { verifier: { iv: string } }).verifier.iv, "string");
  } finally {
    await env.db.end();
  }
});

Deno.test("callback exige owner e sessao da pendencia", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const other = await newPrincipal(env.db);
    const start = await env.service.start(p, { label: "Conta", scopes: ["gmail_read"] });
    await assert.rejects(
      env.service.callback({ ...p, sessionId: crypto.randomUUID() }, {
        code: "c",
        state: start.state,
      }),
      (error: unknown) => error instanceof HubError && error.code === "state_invalid",
    );
    await assert.rejects(
      env.service.callback(other, { code: "c", state: start.state }),
      (error: unknown) => error instanceof HubError && error.code === "state_invalid",
    );
    const rows = await env.db.unsafe(
      "select consumed_at from arahub_private.oauth_pending where owner_id=$1",
      [p.ownerId],
    );
    assert.strictEqual(rows[0].consumed_at, null);
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Callback feliz, uso unico e erro
// ---------------------------------------------------------------------------

Deno.test("callback conclui a conexao, persiste tokens selados e nao vaza segredos", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const { view } = await authorize(env, p, { sub: "google-sub-1", email: "pessoa@example.com" });
    assert.strictEqual(view.state, "connected");
    assert.strictEqual(view.origin, "personal");
    assert.strictEqual(view.account.subject, "google-sub-1");
    assert.deepStrictEqual(view.denied_scopes, []);
    assert.strictEqual((view.capabilities.reads as Record<string, boolean>).gmail_read, true);
    assert.equal("access_token" in view, false);
    assert.equal(JSON.stringify(view).includes("ya29.access-marker"), false);
    assert.equal(JSON.stringify(view).includes("1//refresh-marker"), false);

    const connection = await env.db.unsafe(
      "select state,provider_subject,origin,granted_scopes,capabilities from public.hub_connections where id=$1",
      [view.id],
    );
    assert.strictEqual(connection[0].state, "connected");
    assert.strictEqual(connection[0].provider_subject, "google-sub-1");
    assert.strictEqual(connection[0].origin, "personal");
    assert.ok(
      (connection[0].granted_scopes as string[]).includes(GOOGLE_READ_CAPABILITIES.gmail_read[0]),
    );
    assert.equal(JSON.stringify(connection[0].capabilities).includes("ya29.access-marker"), false);

    const credentials = await env.db.unsafe(
      "select encrypted_payload from arahub_private.credentials where connection_id=$1",
      [view.id],
    );
    assert.strictEqual(credentials.length, 1);
    const sealed = JSON.stringify(credentials[0]);
    assert.equal(sealed.includes("ya29.access-marker"), false);
    assert.equal(sealed.includes("1//refresh-marker"), false);

    const listed = await env.service.list(p);
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].state, "connected");
    assert.equal(JSON.stringify(listed).includes("ya29.access-marker"), false);
  } finally {
    await env.db.end();
  }
});

Deno.test("callback e de uso unico", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const { start } = await authorize(env, p, {});
    await assert.rejects(
      env.service.callback(p, { code: "code-1", state: start.state }),
      (error: unknown) => error instanceof HubError && error.code === "state_invalid",
    );
  } finally {
    await env.db.end();
  }
});

Deno.test("erro do provedor consome a pendencia e nao conecta", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const start = await env.service.start(p, { label: "Conta", scopes: ["gmail_read"] });
    await assert.rejects(
      env.service.callback(p, { state: start.state, error: "access_denied" }),
      (error: unknown) => error instanceof HubError && error.code === "authorization_denied",
    );
    const rows = await env.db.unsafe(
      "select consumed_at from arahub_private.oauth_pending where owner_id=$1",
      [p.ownerId],
    );
    assert.ok(rows[0].consumed_at instanceof Date);
    await assert.rejects(
      env.service.callback(p, { code: "c", state: start.state }),
      (error: unknown) => error instanceof HubError && error.code === "state_invalid",
    );
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Vinculo de conta e reconexao
// ---------------------------------------------------------------------------

Deno.test("reconexao exige a mesma conta e separa institucional de pessoal", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const institutional = await authorize(env, p, { sub: "sub-inst", hd: "example.edu" });
    assert.strictEqual(institutional.view.origin, "example.edu");
    const personal = await authorize(env, p, { sub: "sub-pers" });
    assert.strictEqual(personal.view.origin, "personal");
    assert.notStrictEqual(institutional.view.id, personal.view.id);

    // A mesma conta Google nao pode virar duas conexoes (indice parcial unico).
    await assert.rejects(
      authorize(env, p, { sub: "sub-inst", hd: "example.edu" }),
      (error: unknown) => error instanceof HubError && error.code === "account_already_connected",
    );

    const start = await env.service.start(p, {
      label: "Reconectar",
      scopes: ["gmail_read"],
      connection_id: institutional.view.id,
    });
    const nonce = new URL(start.authorization_url).searchParams.get("nonce") as string;
    const wrongToken = await env.sign({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "sub-Y",
      hd: "example.edu",
      nonce,
    });
    env.setTokenResponse({
      access_token: "ya29.other",
      refresh_token: "1//other",
      expires_in: 3600,
      scope: DEFAULT_GRANTED,
      token_type: "Bearer",
      id_token: wrongToken,
    });
    await assert.rejects(
      env.service.callback(p, { code: "code-2", state: start.state }),
      (error: unknown) => error instanceof HubError && error.code === "account_mismatch",
    );
  } finally {
    await env.db.end();
  }
});

Deno.test("reconexao preserva refresh token ausente e incrementa versao", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const first = await authorize(env, p, { sub: "sub-R", refresh: "1//keep-me" });
    const reconnected = await authorize(env, p, {
      sub: "sub-R",
      connection_id: first.view.id,
      refresh: null,
      access: "ya29.second",
    });
    assert.strictEqual(reconnected.view.id, first.view.id);
    const record = await new PostgresTokenStore(env.db, p).read(p.ownerId, first.view.id);
    assert.ok(record);
    assert.strictEqual(record.version, 2);
    assert.strictEqual(await openRefreshToken(env.vault, record), "1//keep-me");
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Leitura escopada e expiracao
// ---------------------------------------------------------------------------

Deno.test("tokens entrega acesso escopado sem refresh", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const { view } = await authorize(env, p, { access: "ya29.scoped" });
    const access = await env.service.tokens(p, view.id);
    assert.strictEqual(access.access_token, "ya29.scoped");
    assert.ok(access.expires_at > Date.now());
    assert.equal("refresh_token" in access, false);
    const client = await env.service.client(p, view.id);
    assert.ok(client instanceof Object);
  } finally {
    await env.db.end();
  }
});

Deno.test("tokens renova com refresh sob CAS e preserva refresh", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const { view } = await authorize(env, p, { sub: "sub-T", refresh: "1//keep" });
    const store = new PostgresTokenStore(env.db, p);
    const record = await store.read(p.ownerId, view.id);
    assert.ok(record);
    const expired = { ...record, version: record.version + 1, expiresAt: Date.now() - 1000 };
    assert.strictEqual(
      await store.compareAndSwap(p.ownerId, view.id, record.version, expired),
      true,
    );
    env.setTokenResponse({
      access_token: "ya29.refreshed",
      expires_in: 3600,
      token_type: "Bearer",
    });
    const access = await env.service.tokens(p, view.id);
    assert.strictEqual(access.access_token, "ya29.refreshed");
    const after = await store.read(p.ownerId, view.id);
    assert.ok(after);
    assert.strictEqual(await openRefreshToken(env.vault, after), "1//keep");
  } finally {
    await env.db.end();
  }
});

Deno.test("conexao expirada sem refresh vira estado expired e exige reautorizacao", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const { view } = await authorize(env, p, { sub: "sub-E" });
    const store = new PostgresTokenStore(env.db, p);
    const record = await store.read(p.ownerId, view.id);
    assert.ok(record);
    const expired = {
      ...record,
      version: record.version + 1,
      expiresAt: Date.now() - 1000,
      refreshToken: undefined,
    };
    assert.strictEqual(
      await store.compareAndSwap(p.ownerId, view.id, record.version, expired),
      true,
    );
    await assert.rejects(
      env.service.tokens(p, view.id),
      (error: unknown) => error instanceof HubError && error.code === "reauthorization_required",
    );
    const connection = await env.db.unsafe(
      "select state from public.hub_connections where id=$1",
      [view.id],
    );
    assert.strictEqual(connection[0].state, "expired");
  } finally {
    await env.db.end();
  }
});

Deno.test("selected_files nao alega escrita nem Drive inteiro", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const { view } = await authorize(env, p, {
      scopes: ["selected_files"],
      granted: "openid email profile https://www.googleapis.com/auth/drive.file",
    });
    assert.strictEqual((view.capabilities.reads as Record<string, boolean>).selected_files, true);
    assert.strictEqual(view.capabilities.selected_files_implicit_write, false);
    assert.strictEqual(view.capabilities.writes_enabled, false);
    assert.strictEqual(view.capabilities.picker_implemented, false);
    assert.strictEqual(view.capabilities.drive_wide_discovery, false);
    assert.equal((view.capabilities.reads as Record<string, boolean>).drive_read, false);
  } finally {
    await env.db.end();
  }
});

Deno.test("leituras MCP com clientId sao permitidas", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const { view } = await authorize(env, p, { access: "ya29.mcp" });
    const mcp = { ownerId: p.ownerId, clientId: "mcp-client" };
    const access = await env.service.tokens(mcp, view.id);
    assert.strictEqual(access.access_token, "ya29.mcp");
    const client = await env.service.client(mcp, view.id);
    assert.strictEqual(typeof client.getDocument, "function");
    const listed = await env.service.list(mcp);
    assert.strictEqual(listed.length, 1);
    await assert.rejects(
      env.service.start(mcp, { label: "x", scopes: ["gmail_read"] }),
      (error: unknown) => error instanceof HubError && error.code === "browser_required",
    );
  } finally {
    await env.db.end();
  }
});

Deno.test("novo vinculo pede select_account; reconexao sem refresh pede consent", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const startNew = await env.service.start(p, { label: "Nova", scopes: ["gmail_read"] });
    assert.strictEqual(
      new URL(startNew.authorization_url).searchParams.get("prompt"),
      "select_account",
    );
    const withRefresh = await authorize(env, p, { sub: "sub-p1", refresh: "1//keep" });
    const reconnect = await env.service.start(p, {
      label: "Re",
      scopes: ["gmail_read"],
      connection_id: withRefresh.view.id,
    });
    assert.strictEqual(new URL(reconnect.authorization_url).searchParams.get("prompt"), null);
    const noRefresh = await authorize(env, p, { sub: "sub-p2", refresh: null });
    const consent = await env.service.start(p, {
      label: "Re2",
      scopes: ["gmail_read"],
      connection_id: noRefresh.view.id,
    });
    assert.strictEqual(new URL(consent.authorization_url).searchParams.get("prompt"), "consent");
  } finally {
    await env.db.end();
  }
});

Deno.test("start persiste desired_scopes na conexao e na pendencia com epoch", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const start = await env.service.start(p, {
      label: "Desejo",
      scopes: ["gmail_read", "calendar_read"],
    });
    const conn = await env.db.unsafe(
      "select desired_scopes, oauth_epoch from public.hub_connections where id=$1",
      [start.connection_id],
    );
    assert.ok(
      (conn[0].desired_scopes as string[]).includes(GOOGLE_READ_CAPABILITIES.gmail_read[0]),
    );
    assert.ok(
      (conn[0].desired_scopes as string[]).includes(GOOGLE_READ_CAPABILITIES.calendar_read[0]),
    );
    assert.strictEqual(conn[0].oauth_epoch, 1);
    const pend = await env.db.unsafe(
      "select desired_scopes, oauth_epoch from arahub_private.oauth_pending where connection_id=$1",
      [start.connection_id],
    );
    assert.deepStrictEqual(pend[0].desired_scopes, conn[0].desired_scopes);
    assert.strictEqual(pend[0].oauth_epoch, 1);
  } finally {
    await env.db.end();
  }
});

Deno.test("negacao marca denied em conexao nova e preserva a conectada na reauth", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const fresh = await env.service.start(p, { label: "Nova", scopes: ["gmail_read"] });
    await assert.rejects(
      env.service.callback(p, { state: fresh.state, error: "access_denied" }),
      (error: unknown) => error instanceof HubError && error.code === "authorization_denied",
    );
    const denied = await env.db.unsafe("select state from public.hub_connections where id=$1", [
      fresh.connection_id,
    ]);
    assert.strictEqual(denied[0].state, "denied");

    const connected = await authorize(env, p, { sub: "sub-keep" });
    const reauth = await env.service.start(p, {
      label: "Reauth",
      scopes: ["gmail_read"],
      connection_id: connected.view.id,
    });
    await assert.rejects(
      env.service.callback(p, { state: reauth.state, error: "access_denied" }),
      (error: unknown) => error instanceof HubError && error.code === "authorization_denied",
    );
    const kept = await env.db.unsafe("select state from public.hub_connections where id=$1", [
      connected.view.id,
    ]);
    assert.strictEqual(kept[0].state, "connected");
    const record = await new PostgresTokenStore(env.db, p).read(p.ownerId, connected.view.id);
    assert.ok(record);
    assert.strictEqual(await openAccessToken(env.vault, record), "ya29.access-marker");
  } finally {
    await env.db.end();
  }
});

Deno.test("callback superado nao troca identidade nem token; o atual vence", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const conn = await env.hub.connect(p, "google", "Race", null, null, {});
    const startA = await env.service.start(p, {
      label: "Race",
      scopes: ["gmail_read"],
      connection_id: conn.id,
    });
    const startB = await env.service.start(p, {
      label: "Race",
      scopes: ["gmail_read"],
      connection_id: conn.id,
    });
    const tokenBody = async (
      authorizationUrl: string,
      sub: string,
      access: string,
    ): Promise<Record<string, unknown>> => {
      const nonce = new URL(authorizationUrl).searchParams.get("nonce") as string;
      const idToken = await env.sign({ iss: ISSUER, aud: CLIENT_ID, sub, nonce });
      return {
        access_token: access,
        refresh_token: "1//" + access,
        expires_in: 3600,
        scope: DEFAULT_GRANTED,
        token_type: "Bearer",
        id_token: idToken,
      };
    };
    env.setTokenResponse(await tokenBody(startA.authorization_url, "sub-A", "ya29.a"));
    await assert.rejects(
      env.service.callback(p, { code: "cA", state: startA.state }),
      (error: unknown) => error instanceof HubError && error.code === "authorization_stale",
    );
    const untouched = await env.db.unsafe(
      "select provider_subject, state from public.hub_connections where id=$1",
      [conn.id],
    );
    assert.strictEqual(untouched[0].provider_subject, null);
    assert.strictEqual(untouched[0].state, "pending");

    env.setTokenResponse(await tokenBody(startB.authorization_url, "sub-B", "ya29.b"));
    const viewB = await env.service.callback(p, { code: "cB", state: startB.state });
    assert.strictEqual(viewB.account.subject, "sub-B");
    const record = await new PostgresTokenStore(env.db, p).read(p.ownerId, conn.id);
    assert.ok(record);
    assert.strictEqual(await openAccessToken(env.vault, record), "ya29.b");

    const startC = await env.service.start(p, {
      label: "Race",
      scopes: ["gmail_read"],
      connection_id: conn.id,
    });
    env.setTokenResponse(await tokenBody(startC.authorization_url, "sub-C", "ya29.c"));
    await assert.rejects(
      env.service.callback(p, { code: "cC", state: startC.state }),
      (error: unknown) => error instanceof HubError && error.code === "account_mismatch",
    );
    const row = await env.db.unsafe(
      "select provider_subject, state from public.hub_connections where id=$1",
      [conn.id],
    );
    assert.strictEqual(row[0].provider_subject, "sub-B");
    assert.strictEqual(row[0].state, "connected");
  } finally {
    await env.db.end();
  }
});

Deno.test("callback em voo apos disconnect nao reativa nem guarda token", async () => {
  const env = await makeEnv();
  try {
    const p = await newPrincipal(env.db);
    const start = await env.service.start(p, { label: "Race", scopes: ["gmail_read"] });
    const nonce = new URL(start.authorization_url).searchParams.get("nonce") as string;
    const idToken = await env.sign({ iss: ISSUER, aud: CLIENT_ID, sub: "sub-race", nonce });
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let startedFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      startedFetch = resolve;
    });
    env.setTokenResponse(async () => {
      startedFetch!();
      await gate;
      return jsonResponse({
        access_token: "ya29.race",
        refresh_token: "1//race",
        expires_in: 3600,
        scope: DEFAULT_GRANTED,
        token_type: "Bearer",
        id_token: idToken,
      });
    });
    const pendingCallback = env.service.callback(p, { code: "c", state: start.state });
    await fetchStarted;
    await env.service.disconnect(p, start.connection_id);
    releaseFetch!();
    await assert.rejects(
      pendingCallback,
      (error: unknown) =>
        error instanceof HubError &&
        (error.code === "state_invalid" || error.code === "authorization_stale" ||
          error.code === "connection_unavailable"),
    );
    const row = await env.db.unsafe(
      "select state, oauth_epoch from public.hub_connections where id=$1",
      [start.connection_id],
    );
    assert.strictEqual(row[0].state, "revoked");
    assert.strictEqual(row[0].oauth_epoch, 2);
    const creds = await env.db.unsafe(
      "select connection_id from arahub_private.credentials where connection_id=$1",
      [start.connection_id],
    );
    assert.strictEqual(creds.length, 0);
  } finally {
    await env.db.end();
  }
});
