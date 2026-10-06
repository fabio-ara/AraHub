/**
 * Testes do adaptador Google e do cofre de tokens (dados sinteticos, sem rede real).
 * Executar: deno test --allow-env tests/google_test.ts
 */

import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  type ApprovalBinding,
  type ApprovalConsumeResult,
  canonicalJson,
  classifyGoogleHttpError,
  createAuthorizationRequest,
  createGoogleIdTokenVerifier,
  executePreparedWrite,
  type FetchLike,
  GOOGLE_NARROW_SCOPES,
  GOOGLE_SCOPE_SETS,
  GoogleApiError,
  googleOAuthConfig,
  GoogleReadClient,
  handleAuthorizationCallback,
  InMemoryPendingAuthorizations,
  type PersistedWriteOutcome,
  prepareWrite,
  refreshAccessToken,
  resolveGoogleScopes,
  sha256Hex,
  storeGoogleAuthorization,
  verifierFromJwks,
  type WriteApprovalAuthority,
  writeBindingCanonical,
  type WriteExecutor,
} from "../src/adapters/google.ts";
import {
  base64UrlEncode,
  InMemoryTokenStore,
  mergeTokenResponse,
  openAccessToken,
  openRefreshToken,
  parseVaultKey,
  persistRefreshedTokens,
  sealTokenRecord,
  TOKEN_VAULT_KEY_ENV,
  TokenVault,
  TokenVaultError,
} from "../src/adapters/token_vault.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Route {
  readonly match: (url: URL) => boolean;
  readonly respond: (url: URL) => Response;
}

function routeFetch(routes: readonly Route[]): FetchLike {
  return (input) => {
    const url = new URL(String(input));
    for (const route of routes) {
      if (route.match(url)) return Promise.resolve(route.respond(url));
    }
    return Promise.reject(new Error("rota nao mapeada: " + url.pathname));
  };
}

function byPath(path: string, respond: (url: URL) => Response): Route {
  return { match: (url) => url.pathname === path, respond };
}

async function makeSigner() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return { jwks, sign };
}

async function signWith(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function testConfig() {
  return googleOAuthConfig({
    clientId: "client-abc",
    redirectUri: "https://hub.example/oauth/google/callback",
  });
}

async function newVault(kid = "k1"): Promise<TokenVault> {
  return await TokenVault.fromRawKeys([{ kid, key: crypto.getRandomValues(new Uint8Array(32)) }]);
}

interface AuthorityHarness {
  readonly authority: WriteApprovalAuthority;
  readonly persisted: Array<{ state: string; externalId?: string }>;
  readonly calls: { consumed: number };
}

function makeAuthority(
  options: {
    readonly prior?: PersistedWriteOutcome | null;
    readonly consume?: (binding: ApprovalBinding, receiptId: string) => ApprovalConsumeResult;
  } = {},
): AuthorityHarness {
  const persisted: Array<{ state: string; externalId?: string }> = [];
  const calls = { consumed: 0 };
  const authority: WriteApprovalAuthority = {
    priorResult: () => Promise.resolve(options.prior ?? null),
    consume: (_prepared, binding, receiptId) => {
      calls.consumed++;
      if (options.consume) return Promise.resolve(options.consume(binding, receiptId));
      return Promise.resolve({
        status: "authorized",
        receipt: { receiptId, approvedAt: 1, source: "trusted_ui", ...binding },
      });
    },
    persistResult: (_prepared, result) => {
      persisted.push({ state: result.state, externalId: result.externalId });
      return Promise.resolve();
    },
  };
  return { authority, persisted, calls };
}

// ---------------------------------------------------------------------------
// OAuth: PKCE, state, nonce
// ---------------------------------------------------------------------------

Deno.test("authorization request usa PKCE S256, state e nonce", async () => {
  const config = testConfig();
  const request = await createAuthorizationRequest({
    config,
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
  });
  const url = new URL(request.url);
  assert.strictEqual(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.strictEqual(url.searchParams.get("response_type"), "code");
  assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
  assert.strictEqual(url.searchParams.get("access_type"), "offline");
  assert.strictEqual(url.searchParams.get("include_granted_scopes"), "true");
  assert.strictEqual(url.searchParams.get("state"), request.state);
  assert.strictEqual(url.searchParams.get("nonce"), request.nonce);
  assert.strictEqual(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.strictEqual(url.searchParams.get("client_id"), "client-abc");
  const expectedChallenge = base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.codeVerifier)),
    ),
  );
  assert.strictEqual(request.codeChallenge, expectedChallenge);
  assert.strictEqual(url.searchParams.get("code_challenge"), expectedChallenge);
  assert.ok(request.codeVerifier.length >= 43);
});

Deno.test("state pendente e de uso unico", async () => {
  const store = new InMemoryPendingAuthorizations();
  const request = await createAuthorizationRequest({ config: testConfig(), scopes: ["openid"] });
  store.register(request);
  assert.ok(await store.take(request.state));
  assert.strictEqual(await store.take(request.state), null);
  assert.strictEqual(store.size, 0);
});

Deno.test("callback feliz valida id_token e devolve identidade", async () => {
  const config = testConfig();
  const store = new InMemoryPendingAuthorizations();
  const request = await createAuthorizationRequest({ config, scopes: ["openid", "email"] });
  store.register(request);
  const { jwks, sign } = await makeSigner();
  const idToken = await sign({
    iss: "https://accounts.google.com",
    aud: "client-abc",
    sub: "google-sub-1",
    email: "pessoa@example.com",
    email_verified: true,
    hd: "example.com",
    nonce: request.nonce,
  });
  const fetchImpl = routeFetch([
    byPath("/token", () =>
      jsonResponse({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        scope: "openid email",
        token_type: "Bearer",
        id_token: idToken,
      })),
  ]);
  const result = await handleAuthorizationCallback({
    params: { code: "code-1", state: request.state },
    config,
    store,
    verifier: verifierFromJwks(jwks),
    fetch: fetchImpl,
  });
  assert.strictEqual(result.identity.subject, "google-sub-1");
  assert.strictEqual(result.identity.email, "pessoa@example.com");
  assert.strictEqual(result.identity.emailVerified, true);
  assert.strictEqual(result.identity.hostedDomain, "example.com");
  assert.strictEqual(result.additionalAccount, false);
  assert.deepStrictEqual(result.scopes, ["openid", "email"]);
  assert.strictEqual(store.size, 0);
});

Deno.test("callback rejeita state reutilizado", async () => {
  const config = testConfig();
  const store = new InMemoryPendingAuthorizations();
  const request = await createAuthorizationRequest({ config, scopes: ["openid"] });
  store.register(request);
  await store.take(request.state);
  await assert.rejects(
    () =>
      handleAuthorizationCallback({
        params: { code: "code-1", state: request.state },
        config,
        store,
        verifier: verifierFromJwks(createLocalJWKSet({ keys: [] })),
      }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === "denied" &&
      error.reason === "state_invalid",
  );
});

Deno.test("callback rejeita redirect divergente", async () => {
  const store = new InMemoryPendingAuthorizations();
  const other = googleOAuthConfig({
    clientId: "client-abc",
    redirectUri: "https://evil.example/cb",
  });
  const request = await createAuthorizationRequest({ config: other, scopes: ["openid"] });
  store.register(request);
  await assert.rejects(
    () =>
      handleAuthorizationCallback({
        params: { code: "code-1", state: request.state },
        config: testConfig(),
        store,
        verifier: verifierFromJwks(createLocalJWKSet({ keys: [] })),
      }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === "denied" &&
      error.reason === "redirect_mismatch",
  );
});

Deno.test("callback rejeita nonce divergente no id_token", async () => {
  const config = testConfig();
  const store = new InMemoryPendingAuthorizations();
  const request = await createAuthorizationRequest({ config, scopes: ["openid"] });
  store.register(request);
  const { jwks, sign } = await makeSigner();
  const idToken = await sign({
    iss: "https://accounts.google.com",
    aud: "client-abc",
    sub: "google-sub-1",
    nonce: "outro-nonce",
  });
  const fetchImpl = routeFetch([
    byPath(
      "/token",
      () => jsonResponse({ access_token: "at-1", expires_in: 3600, id_token: idToken }),
    ),
  ]);
  await assert.rejects(
    () =>
      handleAuthorizationCallback({
        params: { code: "code-1", state: request.state },
        config,
        store,
        verifier: verifierFromJwks(jwks),
        fetch: fetchImpl,
      }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === "denied" &&
      error.reason === "nonce_mismatch",
  );
});

Deno.test("callback mapeia access_denied do provedor", async () => {
  const store = new InMemoryPendingAuthorizations();
  await assert.rejects(
    () =>
      handleAuthorizationCallback({
        params: { error: "access_denied", error_description: "usuario recusou ya29.SECRET" },
        config: testConfig(),
        store,
        verifier: verifierFromJwks(createLocalJWKSet({ keys: [] })),
      }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === "denied" &&
      error.reason === "access_denied" &&
      !String(error).includes("ya29.SECRET"),
  );
});

Deno.test("conta adicional nao substitui a sessao AraHub", async () => {
  const config = testConfig();
  const store = new InMemoryPendingAuthorizations();
  const request = await createAuthorizationRequest({ config, scopes: ["openid"] });
  store.register(request);
  const { jwks, sign } = await makeSigner();
  const idToken = await sign({
    iss: "https://accounts.google.com",
    aud: "client-abc",
    sub: "google-sub-2",
    nonce: request.nonce,
  });
  const fetchImpl = routeFetch([
    byPath(
      "/token",
      () => jsonResponse({ access_token: "at-2", expires_in: 3600, id_token: idToken }),
    ),
  ]);
  const result = await handleAuthorizationCallback({
    params: { code: "code-2", state: request.state },
    config,
    store,
    verifier: verifierFromJwks(jwks),
    fetch: fetchImpl,
    sessionId: "hub-session-1",
    additionalAccount: true,
  });
  assert.strictEqual(result.additionalAccount, true);
  assert.strictEqual(result.identity.subject, "google-sub-2");
  assert.strictEqual(result.sessionId, "hub-session-1");
});

Deno.test("id_token com aud multiplo exige azp do client_id", async () => {
  const { jwks, sign } = await makeSigner();
  const base = { iss: "https://accounts.google.com", sub: "s1", nonce: "n1" };
  const ok = await sign({ ...base, aud: ["client-abc", "outro"], azp: "client-abc" });
  const identity = await verifierFromJwks(jwks).verify(ok, {
    issuer: "https://accounts.google.com",
    audience: "client-abc",
    nonce: "n1",
  });
  assert.strictEqual(identity.subject, "s1");
  const bad = await sign({ ...base, aud: ["client-abc", "outro"], azp: "outro" });
  await assert.rejects(
    () =>
      verifierFromJwks(jwks).verify(bad, {
        issuer: "https://accounts.google.com",
        audience: "client-abc",
        nonce: "n1",
      }),
    (error: unknown) => error instanceof GoogleApiError && error.reason === "azp_mismatch",
  );
});

Deno.test("verifier atualiza JWKS uma vez quando aparece kid novo", async () => {
  const pairA = await generateKeyPair("RS256");
  const jwkA = await exportJWK(pairA.publicKey);
  jwkA.kid = "kid-a";
  jwkA.alg = "RS256";
  const pairB = await generateKeyPair("RS256");
  const jwkB = await exportJWK(pairB.publicKey);
  jwkB.kid = "kid-b";
  jwkB.alg = "RS256";
  let calls = 0;
  const fetchImpl: FetchLike = () => {
    calls++;
    return Promise.resolve(jsonResponse({ keys: calls === 1 ? [jwkA] : [jwkA, jwkB] }));
  };
  const verifier = createGoogleIdTokenVerifier({
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    fetch: fetchImpl,
    cacheMs: 60000,
  });
  const opts = { issuer: "https://accounts.google.com", audience: "client-abc", nonce: "n1" };
  const tokenA = await signWith(pairA.privateKey, "kid-a", {
    iss: "https://accounts.google.com",
    aud: "client-abc",
    sub: "s-a",
    nonce: "n1",
  });
  assert.strictEqual((await verifier.verify(tokenA, opts)).subject, "s-a");
  assert.strictEqual(calls, 1);
  const tokenB = await signWith(pairB.privateKey, "kid-b", {
    iss: "https://accounts.google.com",
    aud: "client-abc",
    sub: "s-b",
    nonce: "n1",
  });
  assert.strictEqual((await verifier.verify(tokenB, opts)).subject, "s-b");
  assert.strictEqual(calls, 2);
});

// ---------------------------------------------------------------------------
// Escopos
// ---------------------------------------------------------------------------

Deno.test("escopos selecionados e amplos sao distintos e deduplicados", () => {
  const merged = resolveGoogleScopes(["identity", "identity", "driveFile"]);
  assert.deepStrictEqual(merged, ["openid", "email", "profile", GOOGLE_SCOPE_SETS.driveFile[0]]);
  assert.ok(GOOGLE_NARROW_SCOPES.includes(GOOGLE_SCOPE_SETS.driveFile[0]));
  assert.ok(!GOOGLE_NARROW_SCOPES.includes(GOOGLE_SCOPE_SETS.driveFull[0]));
});

// ---------------------------------------------------------------------------
// Cofre
// ---------------------------------------------------------------------------

Deno.test("cofre cifra e decifra e nao vaza plaintext nos exports", async () => {
  const vault = await newVault();
  const sealed = await vault.seal("ya29.SEGREDO", "aad-x");
  assert.strictEqual(await vault.open(sealed, "aad-x"), "ya29.SEGREDO");
  assert.ok(!JSON.stringify(sealed).includes("SEGREDO"));
  assert.ok(!JSON.stringify(vault.toJSON()).includes("SEGREDO"));
  assert.ok(!vault.toString().includes("SEGREDO"));
  await assert.rejects(
    () => vault.open(sealed, "aad-errado"),
    (error: unknown) => error instanceof TokenVaultError && error.code === "decrypt_failed",
  );
});

Deno.test("registro selado nao expoe access nem refresh token", async () => {
  const vault = await newVault();
  const record = await sealTokenRecord({
    vault,
    ownerId: "o1",
    connectionId: "c1",
    response: {
      access_token: "ya29.ACCESS_SECRET",
      refresh_token: "1//REFRESH_SECRET",
      expires_in: 3600,
      scope: "openid email",
      token_type: "Bearer",
    },
  });
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("ACCESS_SECRET"));
  assert.ok(!serialized.includes("REFRESH_SECRET"));
  assert.strictEqual(record.version, 1);
  assert.strictEqual(await openAccessToken(vault, record), "ya29.ACCESS_SECRET");
  assert.strictEqual(await openRefreshToken(vault, record), "1//REFRESH_SECRET");
});

Deno.test("chave do cofre vem do ambiente e valida tamanho", async () => {
  const hexKey = "a".repeat(64);
  const vault = await TokenVault.fromEnv({
    get: (name) => name === TOKEN_VAULT_KEY_ENV ? hexKey : undefined,
  });
  assert.strictEqual(vault.activeKid, "primary");
  assert.deepStrictEqual(vault.keyIds, ["primary"]);
  await assert.rejects(
    () => TokenVault.fromEnv({ get: () => undefined }),
    (error: unknown) => error instanceof TokenVaultError && error.code === "missing_key",
  );
  assert.throws(
    () => parseVaultKey("AAAA"),
    (error: unknown) => error instanceof TokenVaultError && error.code === "invalid_key_length",
  );
});

Deno.test("refresh omitido preserva o refresh token anterior", () => {
  const merged = mergeTokenResponse({ refreshToken: "1//antigo", scopes: ["openid"] }, {
    access_token: "at-novo",
    expires_in: 1800,
  }, 1000);
  assert.strictEqual(merged.refreshToken, "1//antigo");
  assert.strictEqual(merged.accessToken, "at-novo");
  assert.strictEqual(merged.expiresAt, 1000 + 1800 * 1000);
  assert.deepStrictEqual(merged.scopes, ["openid"]);
  const rotated = mergeTokenResponse({ refreshToken: "1//antigo" }, {
    access_token: "at-2",
    refresh_token: "1//novo",
  }, 1000);
  assert.strictEqual(rotated.refreshToken, "1//novo");
});

Deno.test("CAS: criacao unica e troca obsoleta rejeitada", async () => {
  const vault = await newVault();
  const store = new InMemoryTokenStore();
  const record = await sealTokenRecord({
    vault,
    ownerId: "o1",
    connectionId: "c1",
    response: { access_token: "at-1", refresh_token: "rt-1", expires_in: 60 },
  });
  assert.strictEqual(await store.compareAndSwap("o1", "c1", 0, record), true);
  assert.strictEqual(await store.compareAndSwap("o1", "c1", 0, record), false);
  assert.strictEqual(await store.compareAndSwap("o1", "c1", 5, { ...record, version: 6 }), false);
});

Deno.test("refresh concorrente: CAS retenta e preserva refresh token", async () => {
  const vault = await newVault();
  const store = new InMemoryTokenStore();
  const initial = await sealTokenRecord({
    vault,
    ownerId: "o1",
    connectionId: "c1",
    response: { access_token: "at-1", refresh_token: "rt-1", expires_in: 60, scope: "openid" },
  });
  assert.ok(await store.compareAndSwap("o1", "c1", 0, initial));
  const refreshed = await persistRefreshedTokens({
    store,
    vault,
    previous: initial,
    response: { access_token: "at-2", expires_in: 60 },
  });
  assert.strictEqual(refreshed.version, 2);
  assert.strictEqual(await openRefreshToken(vault, refreshed), "rt-1");
  assert.strictEqual(await openAccessToken(vault, refreshed), "at-2");
});

Deno.test("refresh concorrente rele e vence apos conflito de versao", async () => {
  const vault = await newVault();
  class ConflictingStore extends InMemoryTokenStore {
    #failOnce = true;
    override compareAndSwap(
      ownerId: string,
      connectionId: string,
      expectedVersion: number,
      next: Parameters<InMemoryTokenStore["compareAndSwap"]>[3],
    ): Promise<boolean> {
      if (this.#failOnce && expectedVersion === 1) {
        this.#failOnce = false;
        return Promise.resolve(false);
      }
      return super.compareAndSwap(ownerId, connectionId, expectedVersion, next);
    }
  }
  const store = new ConflictingStore();
  const initial = await sealTokenRecord({
    vault,
    ownerId: "o1",
    connectionId: "c1",
    response: { access_token: "at-1", refresh_token: "rt-1", expires_in: 60 },
  });
  assert.ok(await store.compareAndSwap("o1", "c1", 0, initial));
  const refreshed = await persistRefreshedTokens({
    store,
    vault,
    previous: initial,
    response: { access_token: "at-2", expires_in: 60 },
  });
  assert.strictEqual(refreshed.version, 2);
  assert.strictEqual(await openRefreshToken(vault, refreshed), "rt-1");
});

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

function gmailClient(fetchImpl: FetchLike): GoogleReadClient {
  return new GoogleReadClient({
    accessToken: "at",
    fetch: fetchImpl,
    allowCustomEndpoints: true,
    endpoints: { gmail: "https://gmail.example/gmail/v1" },
  });
}

Deno.test("Gmail distribui orçamento de itens entre páginas sem perder continuação", async () => {
  const sizes: number[] = [];
  const client = gmailClient(routeFetch([
    byPath("/gmail/v1/users/me/messages", (url) => {
      sizes.push(Number(url.searchParams.get("maxResults")));
      return url.searchParams.get("pageToken") === "p2"
        ? jsonResponse({ messages: [{ id: "3" }], nextPageToken: "p3" })
        : jsonResponse({ messages: [{ id: "1" }, { id: "2" }], nextPageToken: "p2" });
    }),
  ]));
  const page = await client.listGmailMessages({ maxResults: 2, limits: { maxPages: 3, maxItems: 3 } });
  assert.deepEqual(sizes, [2, 1]);
  assert.equal(page.items.length, 3);
  assert.equal(page.pages, 2);
  assert.equal(page.coverage, "partial");
  assert.equal(page.resumeCursor, "p3");
  assert.equal(page.cursorAdvanced, false);
});

Deno.test("Gmail history parcial nao avanca o cursor", async () => {
  const client = gmailClient(routeFetch([
    byPath("/gmail/v1/users/me/history", (url) => {
      const token = url.searchParams.get("pageToken");
      if (token === "p2") {
        return jsonResponse({ history: [{ id: "2" }], nextPageToken: "p3", historyId: "999" });
      }
      if (token === "p3") return jsonResponse({ history: [{ id: "3" }], historyId: "999" });
      return jsonResponse({ history: [{ id: "1" }], nextPageToken: "p2", historyId: "999" });
    }),
  ]));
  const page = await client.listGmailHistory({ startHistoryId: "100", limits: { maxPages: 2 } });
  assert.strictEqual(page.coverage, "partial");
  assert.strictEqual(page.cursorAdvanced, false);
  assert.strictEqual(page.nextCursor, undefined);
  assert.strictEqual(page.resumeCursor, "p3");
  assert.strictEqual(page.items.length, 2);
});

Deno.test("Gmail history completa avanca para o novo historyId", async () => {
  const client = gmailClient(routeFetch([
    byPath(
      "/gmail/v1/users/me/history",
      () => jsonResponse({ history: [{ id: "1" }], historyId: "999" }),
    ),
  ]));
  const page = await client.listGmailHistory({ startHistoryId: "100" });
  assert.strictEqual(page.coverage, "complete");
  assert.strictEqual(page.cursorAdvanced, true);
  assert.strictEqual(page.nextCursor, "999");
});

Deno.test("Gmail history expirado retorna 404 e nao avanca", async () => {
  const client = gmailClient(routeFetch([
    byPath(
      "/gmail/v1/users/me/history",
      () => jsonResponse({ error: { code: 404, message: "not found", status: "NOT_FOUND" } }, 404),
    ),
  ]));
  const page = await client.listGmailHistory({ startHistoryId: "1" });
  assert.strictEqual(page.coverage, "expired");
  assert.strictEqual(page.cursorAdvanced, false);
  assert.strictEqual(page.reason, "history_expired");
});

function calendarClient(fetchImpl: FetchLike): GoogleReadClient {
  return new GoogleReadClient({
    accessToken: "at",
    fetch: fetchImpl,
    allowCustomEndpoints: true,
    endpoints: { calendar: "https://calendar.example/calendar/v3" },
  });
}

Deno.test("Calendar sync completo devolve nextSyncToken e preserva dia inteiro", async () => {
  const event = {
    id: "ev-1",
    start: { date: "2026-10-05" },
    end: { date: "2026-10-06" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
  };
  const client = calendarClient(routeFetch([
    byPath(
      "/calendar/v3/calendars/primary/events",
      () => jsonResponse({ items: [event], nextSyncToken: "sync-1" }),
    ),
  ]));
  const page = await client.listCalendarEvents({ calendarId: "primary" });
  assert.strictEqual(page.coverage, "complete");
  assert.strictEqual(page.nextCursor, "sync-1");
  assert.strictEqual(page.cursorAdvanced, true);
  assert.deepStrictEqual(page.items[0], event);
});

Deno.test("Calendar sync token invalido retorna 410 e exige sincronizacao completa", async () => {
  const client = calendarClient(routeFetch([
    byPath("/calendar/v3/calendars/primary/events", (url) => {
      assert.strictEqual(url.searchParams.get("syncToken"), "velho");
      assert.strictEqual(url.searchParams.get("showDeleted"), "true");
      return jsonResponse(
        { error: { code: 410, message: "sync token invalid", status: "GONE" } },
        410,
      );
    }),
  ]));
  const page = await client.listCalendarEvents({ syncToken: "velho" });
  assert.strictEqual(page.coverage, "expired");
  assert.strictEqual(page.cursorAdvanced, false);
  assert.strictEqual(page.reason, "full_sync_required");
});

function driveClient(fetchImpl: FetchLike): GoogleReadClient {
  return new GoogleReadClient({
    accessToken: "at",
    fetch: fetchImpl,
    allowCustomEndpoints: true,
    endpoints: { drive: "https://drive.example/drive/v3" },
  });
}

Deno.test("Drive changes completo avanca para newStartPageToken", async () => {
  const client = driveClient(routeFetch([
    byPath(
      "/drive/v3/changes",
      () => jsonResponse({ changes: [{ fileId: "f1" }], newStartPageToken: "page-2" }),
    ),
  ]));
  const page = await client.listDriveChanges({ pageToken: "page-1" });
  assert.strictEqual(page.coverage, "complete");
  assert.strictEqual(page.nextCursor, "page-2");
  assert.strictEqual(page.cursorAdvanced, true);
});

Deno.test("Drive pageToken expirado retorna 410", async () => {
  const client = driveClient(routeFetch([
    byPath(
      "/drive/v3/changes",
      () => jsonResponse({ error: { code: 410, message: "expired" } }, 410),
    ),
  ]));
  const page = await client.listDriveChanges({ pageToken: "page-1" });
  assert.strictEqual(page.coverage, "expired");
  assert.strictEqual(page.reason, "sync_token_expired");
});

Deno.test("Docs, Sheets e Slides devolvem o JSON nativo integro", async () => {
  const doc = {
    documentId: "doc-1",
    title: "Plano",
    body: { content: [{ paragraph: { elements: [] } }] },
  };
  const sheet = {
    spreadsheetId: "sheet-1",
    sheets: [{ properties: { title: "Notas" }, data: [{ rowData: [] }] }],
  };
  const deck = { presentationId: "deck-1", slides: [{ objectId: "s1", pageElements: [] }] };
  let docQuery: URLSearchParams | undefined;
  let sheetQuery: URLSearchParams | undefined;
  const client = new GoogleReadClient({
    accessToken: "at",
    allowCustomEndpoints: true,
    fetch: routeFetch([
      byPath("/v1/documents/doc-1", (url) => {
        docQuery = url.searchParams;
        return jsonResponse(doc);
      }),
      byPath("/v4/spreadsheets/sheet-1", (url) => {
        sheetQuery = url.searchParams;
        return jsonResponse(sheet);
      }),
      byPath("/v1/presentations/deck-1", () => jsonResponse(deck)),
    ]),
    endpoints: {
      docs: "https://docs.example/v1",
      sheets: "https://sheets.example/v4",
      slides: "https://slides.example/v1",
    },
  });
  assert.deepStrictEqual(await client.getDocument({ documentId: "doc-1" }), doc);
  // includeTabsContent preserva abas por padrao; sem ele o Docs devolve so a primeira aba.
  assert.strictEqual(docQuery?.get("includeTabsContent"), "true");
  assert.deepStrictEqual(
    await client.getSpreadsheet({ spreadsheetId: "sheet-1", includeGridData: true }),
    sheet,
  );
  assert.strictEqual(sheetQuery?.get("includeGridData"), "true");
  assert.deepStrictEqual(await client.getPresentation({ presentationId: "deck-1" }), deck);
});

Deno.test("getDocument permite desligar includeTabsContent", async () => {
  let query: URLSearchParams | undefined;
  const client = new GoogleReadClient({
    accessToken: "at",
    allowCustomEndpoints: true,
    fetch: routeFetch([
      byPath("/v1/documents/doc-2", (url) => {
        query = url.searchParams;
        return jsonResponse({ documentId: "doc-2" });
      }),
    ]),
    endpoints: { docs: "https://docs.example/v1" },
  });
  await client.getDocument({ documentId: "doc-2", includeTabsContent: false });
  assert.strictEqual(query?.get("includeTabsContent"), "false");
});

// ---------------------------------------------------------------------------
// Erros e endurecimento de rede
// ---------------------------------------------------------------------------

Deno.test("erros HTTP sao classificados sem vazar corpo do provedor", () => {
  assert.strictEqual(classifyGoogleHttpError(401, {}).kind, "expired");
  const denied = classifyGoogleHttpError(403, {
    error: {
      code: 403,
      message: "insufficient ya29.SECRET",
      errors: [{ reason: "insufficientPermissions" }],
    },
  });
  assert.strictEqual(denied.kind, "denied");
  assert.strictEqual(denied.reason, "insufficientPermissions");
  assert.strictEqual(classifyGoogleHttpError(429, {}).retryable, true);
  assert.strictEqual(classifyGoogleHttpError(500, {}).kind, "unavailable");
  assert.strictEqual(classifyGoogleHttpError(400, {}).kind, "invalid_request");
  const unknown = classifyGoogleHttpError(400, { error: { message: "ya29.SECRET livre" } });
  assert.strictEqual(unknown.reason, "provider_error");
  assert.ok(!String(unknown).includes("ya29.SECRET"));
});

Deno.test("erro 401 com token no corpo nao vaza o token", async () => {
  const client = new GoogleReadClient({
    accessToken: "at",
    allowCustomEndpoints: true,
    fetch: routeFetch([
      byPath("/gmail/v1/users/me/threads", () =>
        jsonResponse({
          error: {
            code: 401,
            message: "Invalid Credentials ya29.SECRET",
            status: "UNAUTHENTICATED",
          },
          error_description: "token ya29.SECRET rejeitado",
        }, 401)),
    ]),
    endpoints: { gmail: "https://gmail.example/gmail/v1" },
  });
  await assert.rejects(
    () => client.listGmailThreads(),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.strictEqual(error.kind, "expired");
      assert.strictEqual(error.reason, "UNAUTHENTICATED");
      const surface = String(error) + JSON.stringify(error) + String(error.stack ?? "");
      assert.ok(!surface.includes("ya29.SECRET"));
      return true;
    },
  );
});

Deno.test("erro do token endpoint com token no corpo nao vaza", async () => {
  const config = testConfig();
  const fetchImpl = routeFetch([
    byPath(
      "/token",
      () => jsonResponse({ error: "invalid_grant", error_description: "refresh ya29.SECRET" }, 400),
    ),
  ]);
  await assert.rejects(
    () => refreshAccessToken({ config, refreshToken: "rt-1", fetch: fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.strictEqual(error.reason, "invalid_grant");
      assert.ok(!(String(error) + JSON.stringify(error)).includes("ya29.SECRET"));
      return true;
    },
  );
});

Deno.test("redirecionamento 3xx e recusado", async () => {
  const client = new GoogleReadClient({
    accessToken: "at",
    allowCustomEndpoints: true,
    fetch: () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://evil.example/leak" } }),
      ),
  });
  await assert.rejects(
    () => client.listCalendars(),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.strictEqual(error.kind, "denied");
      assert.strictEqual(error.reason, "unexpected_redirect");
      assert.ok(!String(error).includes("evil.example"));
      return true;
    },
  );
});

Deno.test("timeout cobre a leitura do corpo (stream parado)", async () => {
  const stall = new Response(
    new ReadableStream<Uint8Array>({ start() {/* nunca encerra */} }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const client = new GoogleReadClient({
    accessToken: "at",
    allowCustomEndpoints: true,
    timeoutMs: 40,
    fetch: () => Promise.resolve(stall),
  });
  await assert.rejects(
    () => client.listCalendars(),
    (error: unknown) => error instanceof GoogleApiError && error.kind === "timeout",
  );
});

Deno.test("corpo acima do limite via Content-Length e recusado", async () => {
  const client = new GoogleReadClient({
    accessToken: "at",
    allowCustomEndpoints: true,
    maxResponseBytes: 100,
    fetch: () =>
      Promise.resolve(
        new Response("x".repeat(5000), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "5000" },
        }),
      ),
  });
  await assert.rejects(
    () => client.listCalendars(),
    (error: unknown) => error instanceof GoogleApiError && error.reason === "response_too_large",
  );
});

Deno.test("corpo acima do limite via stream e recusado", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(200));
      controller.enqueue(new Uint8Array(200));
      controller.close();
    },
  });
  const client = new GoogleReadClient({
    accessToken: "at",
    allowCustomEndpoints: true,
    maxResponseBytes: 100,
    fetch: () =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      ),
  });
  await assert.rejects(
    () => client.listCalendars(),
    (error: unknown) => error instanceof GoogleApiError && error.reason === "response_too_large",
  );
});

Deno.test("abort do fetch vira timeout", async () => {
  const failing: FetchLike = () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  };
  const client = new GoogleReadClient({ accessToken: "at", fetch: failing });
  await assert.rejects(
    () => client.listCalendars(),
    (error: unknown) => error instanceof GoogleApiError && error.kind === "timeout",
  );
});

Deno.test("endpoints fora do Google oficial sao recusados em producao", () => {
  assert.throws(
    () =>
      new GoogleReadClient({
        accessToken: "at",
        endpoints: { gmail: "https://gmail.example/gmail/v1" },
      }),
    (error: unknown) => error instanceof GoogleApiError && error.kind === "invalid_request",
  );
  assert.throws(
    () =>
      googleOAuthConfig({
        clientId: "client-abc",
        redirectUri: "https://hub.example/cb",
        tokenEndpoint: "https://evil.example/token",
      }),
    (error: unknown) => error instanceof GoogleApiError && error.kind === "invalid_request",
  );
  const ok = googleOAuthConfig({
    clientId: "client-abc",
    redirectUri: "https://hub.example/cb",
    tokenEndpoint: "https://evil.example/token",
    allowCustomEndpoints: true,
  });
  assert.strictEqual(ok.tokenEndpoint, "https://evil.example/token");
});

// ---------------------------------------------------------------------------
// Refresh persistido
// ---------------------------------------------------------------------------

Deno.test("refreshStoredGoogleToken preserva refresh token quando o Google o omite", async () => {
  const vault = await newVault();
  const store = new InMemoryTokenStore();
  const initial = await storeGoogleAuthorization({
    vault,
    ownerId: "o1",
    connectionId: "c1",
    response: { access_token: "at-1", refresh_token: "rt-1", expires_in: 60, scope: "openid" },
  });
  assert.ok(await store.compareAndSwap("o1", "c1", 0, initial));
  const { refreshStoredGoogleToken } = await import("../src/adapters/google.ts");
  const fetchImpl = routeFetch([
    byPath("/token", () => jsonResponse({ access_token: "at-2", expires_in: 60 })),
  ]);
  const result = await refreshStoredGoogleToken({
    config: testConfig(),
    record: initial,
    vault,
    store,
    fetch: fetchImpl,
  });
  assert.strictEqual(result.record.version, 2);
  assert.strictEqual(await openRefreshToken(vault, result.record), "rt-1");
  assert.strictEqual(await openAccessToken(vault, result.record), "at-2");
});

// ---------------------------------------------------------------------------
// Escrita: preparacao + autoridade de aprovacao
// ---------------------------------------------------------------------------

Deno.test("prepareWrite amarra alvo+payload com hash estavel", async () => {
  const target = { provider: "docs" as const, resourceId: "doc-1" };
  const a = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target,
    payload: { a: 1, b: 2 },
    baseRevision: "rev-1",
  });
  const b = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target,
    payload: { b: 2, a: 1 },
  });
  assert.strictEqual(a.payloadHash, b.payloadHash);
  assert.strictEqual(a.payloadHash, await sha256Hex(writeBindingCanonical(target, { a: 1, b: 2 })));
  assert.strictEqual(a.baseRevision, "rev-1");
  const otherTarget = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-2" },
    payload: { a: 1, b: 2 },
  });
  assert.notStrictEqual(otherTarget.payloadHash, a.payloadHash);
  assert.strictEqual(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

Deno.test("execucao bloqueada sem autoridade confiavel", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-1" },
    payload: { requests: [] },
  });
  await assert.rejects(
    () => executePreparedWrite({ prepared, receiptId: "r1" }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.kind === "denied" &&
      error.reason === "approval_authority_missing",
  );
});

Deno.test("execucao autorizada persiste incerto antes do efeito e sucesso depois", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-1" },
    payload: { requests: [{ insertText: { text: "oi" } }] },
    baseRevision: "rev-1",
  });
  const { authority, persisted } = makeAuthority();
  const executor: WriteExecutor = {
    execute: (write, receipt) => {
      assert.strictEqual(write.baseRevision, "rev-1");
      assert.strictEqual(receipt.payloadHash, write.payloadHash);
      return Promise.resolve({ externalId: "doc-1", revision: "rev-2" });
    },
  };
  const result = await executePreparedWrite({ prepared, receiptId: "r1", authority, executor });
  assert.deepStrictEqual(result, { state: "succeeded", externalId: "doc-1", revision: "rev-2" });
  assert.deepStrictEqual(persisted, [
    { state: "uncertain", externalId: undefined },
    { state: "succeeded", externalId: "doc-1" },
  ]);
});

Deno.test("payload mutado apos preparar e rejeitado mesmo com recibo valido", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-1" },
    payload: { requests: [{ insertText: { text: "original" } }] },
  });
  (prepared.payload as Record<string, unknown>).injected = "malicioso";
  const { authority, calls } = makeAuthority();
  const executor: WriteExecutor = {
    execute: () => Promise.resolve({ externalId: "doc-1" }),
  };
  await assert.rejects(
    () => executePreparedWrite({ prepared, receiptId: "r1", authority, executor }),
    (error: unknown) => error instanceof GoogleApiError && error.reason === "payload_mutated",
  );
  assert.strictEqual(calls.consumed, 0);
});

Deno.test("recibo divergente do hash/alvo e recusado", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-1" },
    payload: { requests: [] },
  });
  const { authority } = makeAuthority({
    consume: (binding, receiptId) => ({
      status: "authorized",
      receipt: { receiptId, approvedAt: 1, source: "trusted_ui", ...binding, payloadHash: "outro" },
    }),
  });
  const executor: WriteExecutor = { execute: () => Promise.resolve({ externalId: "x" }) };
  await assert.rejects(
    () => executePreparedWrite({ prepared, receiptId: "r2", authority, executor }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.reason === "approval_binding_mismatch",
  );
});

Deno.test("recibo sem marca trusted_ui nunca autoriza", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-1" },
    payload: { requests: [] },
  });
  const { authority } = makeAuthority({
    consume: (binding, receiptId) => ({
      status: "authorized",
      receipt: {
        receiptId,
        approvedAt: 1,
        source: "untrusted" as unknown as "trusted_ui",
        ...binding,
      },
    }),
  });
  const executor: WriteExecutor = { execute: () => Promise.resolve({ externalId: "x" }) };
  await assert.rejects(
    () => executePreparedWrite({ prepared, receiptId: "r3", authority, executor }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.reason === "approval_binding_mismatch",
  );
});

Deno.test("recibo ja consumido nao reexecuta", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-1" },
    payload: { requests: [] },
  });
  const { authority } = makeAuthority({
    consume: () => ({ status: "already_consumed", consumedAt: 1 }),
  });
  const executor: WriteExecutor = { execute: () => Promise.resolve({ externalId: "x" }) };
  await assert.rejects(
    () => executePreparedWrite({ prepared, receiptId: "r4", authority, executor }),
    (error: unknown) =>
      error instanceof GoogleApiError && error.reason === "approval_already_consumed",
  );
});

Deno.test("resultado anterior incerto impede reenvio", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "sheets", resourceId: "sheet-1" },
    payload: { values: [] },
  });
  const { authority, calls } = makeAuthority({ prior: { state: "uncertain" } });
  let executed = 0;
  const executor: WriteExecutor = {
    execute: () => {
      executed++;
      return Promise.resolve({ externalId: "x" });
    },
  };
  const result = await executePreparedWrite({ prepared, receiptId: "r5", authority, executor });
  assert.deepStrictEqual(result, { state: "uncertain", reason: "prior_uncertain" });
  assert.strictEqual(executed, 0);
  assert.strictEqual(calls.consumed, 0);
});

Deno.test("falha do executor vira incerto e nao reexecuta", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "docs", resourceId: "doc-1" },
    payload: { requests: [] },
  });
  const { authority, persisted } = makeAuthority();
  const executor: WriteExecutor = {
    execute: () => Promise.reject(new Error("timeout apos enviar")),
  };
  const result = await executePreparedWrite({ prepared, receiptId: "r6", authority, executor });
  assert.deepStrictEqual(result, { state: "uncertain", reason: "executor_failed" });
  assert.deepStrictEqual(persisted, [{ state: "uncertain", externalId: undefined }]);
});

Deno.test("recibo expirado nao executa", async () => {
  const prepared = await prepareWrite({
    ownerId: "o1",
    connectionId: "c1",
    target: { provider: "sheets", resourceId: "sheet-1" },
    payload: { values: [] },
  });
  const { authority } = makeAuthority({
    consume: (binding, receiptId) => ({
      status: "authorized",
      receipt: { receiptId, approvedAt: 1, expiresAt: 100, source: "trusted_ui", ...binding },
    }),
  });
  const executor: WriteExecutor = { execute: () => Promise.resolve({ externalId: "x" }) };
  await assert.rejects(
    () => executePreparedWrite({ prepared, receiptId: "r7", authority, executor, now: 200 }),
    (error: unknown) => error instanceof GoogleApiError && error.reason === "approval_expired",
  );
});
