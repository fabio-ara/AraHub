/**
 * Adaptador Google proprio do AraHub (OAuth + leitura + escrita preparada).
 *
 * Independente do repositorio irmao: implementacao nova, MIT.
 *
 * Endurecimento de rede e erro:
 * - requestJson usa redirect manual, recusa 3xx, limita bytes (Content-Length e
 *   stream), e o timeout cobre a leitura completa do corpo.
 * - Erros publicos sao estaveis: kind, status e reason de enum; nunca repassam
 *   message/error_description/cause do provedor (podem conter tokens).
 * - Endpoints customizados so com allowCustomEndpoints (fixtures). Em producao, os
 *   hosts precisam ser dominios oficiais do Google antes de enviar Authorization/secret.
 *
 * Escrita: executePreparedWrite recalcula o binding alvo+payload (rejeita payload
 * mutado), exige autoridade de aprovacao com consumo atomico e resultado incerto, e
 * nunca reenvia operacao ja registrada. Sem autoridade confiavel, fica bloqueada.
 */

import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JWK,
  type JWTPayload,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import {
  base64UrlEncode,
  type OAuthTokenResponse,
  openRefreshToken,
  parseScopes,
  persistRefreshedTokens,
  type SealedTokenRecord,
  sealTokenRecord,
  type TokenStore,
  type TokenVault,
} from "./token_vault.ts";

export type JsonObject = { readonly [key: string]: unknown };

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Erros publicos estaveis
// ---------------------------------------------------------------------------

export type GoogleErrorKind =
  | "denied"
  | "expired"
  | "unavailable"
  | "timeout"
  | "parsing_error"
  | "invalid_request"
  | "conflict";

export type GoogleCoverage =
  | "complete"
  | "partial"
  | "denied"
  | "unavailable"
  | "expired"
  | "timeout"
  | "parsing_error";

const STABLE_MESSAGES: Record<GoogleErrorKind, string> = {
  denied: "acesso ao Google negado",
  expired: "credencial ou cursor do Google expirado",
  unavailable: "servico do Google indisponivel",
  timeout: "requisicao ao Google expirou",
  parsing_error: "resposta do Google invalida",
  invalid_request: "pedido invalido ao Google",
  conflict: "conflito ao executar a operacao no Google",
};

/** Allowlist de reasons estaveis; qualquer outro texto vira provider_error. */
const SAFE_REASONS: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "access_denied",
  "temporarily_unavailable",
  "invalid_token",
  "expired_token",
  "server_error",
  "interaction_required",
  "login_required",
  "consent_required",
  "account_selection_required",
  "insufficientPermissions",
  "accessNotConfigured",
  "forbidden",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "notFound",
  "fullSyncRequired",
  "invalidCredentials",
  "authError",
  "domainPolicy",
  "accountRestricted",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
  "RESOURCE_EXHAUSTED",
  "ABORTED",
  "ALREADY_EXISTS",
  "CANCELLED",
  "INTERNAL",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "network_error",
  "timeout",
  "unexpected_redirect",
  "response_too_large",
  "invalid_json",
  "provider_error",
  "state_invalid",
  "redirect_mismatch",
  "pending_expired",
  "missing_code",
  "missing_state",
  "missing_id_token",
  "nonce_mismatch",
  "azp_mismatch",
  "missing_sub",
  "id_token_invalid",
  "approval_authority_missing",
  "write_executor_missing",
  "approval_not_found",
  "approval_binding_mismatch",
  "approval_expired",
  "approval_already_consumed",
  "payload_mutated",
  "executor_failed",
]);

function safeReason(raw: string | undefined): string {
  return raw !== undefined && SAFE_REASONS.has(raw) ? raw : "provider_error";
}

export interface GoogleApiErrorOptions {
  readonly status?: number;
  readonly reason?: string;
  readonly retryable?: boolean;
}

/**
 * Erro publico estavel. Nao carrega description nem cause do provedor: apenas um
 * reason de enum e, opcionalmente, o status HTTP.
 */
export class GoogleApiError extends Error {
  readonly status?: number;
  readonly reason?: string;
  readonly #retryable?: boolean;

  constructor(
    readonly kind: GoogleErrorKind,
    message: string,
    options: GoogleApiErrorOptions = {},
  ) {
    super(message);
    this.name = "GoogleApiError";
    this.status = options.status;
    this.reason = options.reason;
    this.#retryable = options.retryable;
  }

  get retryable(): boolean {
    return this.#retryable ?? (this.kind === "unavailable" || this.kind === "timeout");
  }

  get coverage(): GoogleCoverage {
    if (this.kind === "invalid_request" || this.kind === "conflict") return "denied";
    return this.kind;
  }
}

/** Extrai apenas o enum de reason; ignora message e error_description. */
function providerReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const nested = error as Record<string, unknown>;
    const errors = nested.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0];
      if (typeof first === "object" && first !== null) {
        const reason = (first as Record<string, unknown>).reason;
        if (typeof reason === "string") return reason;
      }
    }
    if (typeof nested.status === "string") return nested.status;
  }
  return undefined;
}

export function classifyGoogleHttpError(status: number, body: unknown): GoogleApiError {
  const options: GoogleApiErrorOptions = { status, reason: safeReason(providerReason(body)) };
  if (status === 401) return new GoogleApiError("expired", STABLE_MESSAGES.expired, options);
  if (status === 403) return new GoogleApiError("denied", STABLE_MESSAGES.denied, options);
  if (status === 404) {
    return new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, options);
  }
  if (status === 410) return new GoogleApiError("expired", STABLE_MESSAGES.expired, options);
  if (status === 429) {
    return new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, {
      ...options,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, {
      ...options,
      retryable: true,
    });
  }
  if (status === 400) {
    return new GoogleApiError("invalid_request", STABLE_MESSAGES.invalid_request, options);
  }
  return new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, options);
}

function tokenEndpointError(body: unknown, status: number): GoogleApiError {
  const reason = safeReason(providerReason(body));
  const kind: GoogleErrorKind = reason === "invalid_grant"
    ? "expired"
    : reason === "access_denied" || reason === "invalid_client" || reason === "unauthorized_client"
    ? "denied"
    : reason === "temporarily_unavailable"
    ? "unavailable"
    : "invalid_request";
  return new GoogleApiError(kind, STABLE_MESSAGES[kind], { status, reason });
}

// ---------------------------------------------------------------------------
// Endpoints oficiais
// ---------------------------------------------------------------------------

function isOfficialGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "google.com" || host.endsWith(".google.com") || host.endsWith(".googleapis.com");
}

/**
 * Em producao, recusa hosts fora dos dominios oficiais do Google antes de qualquer
 * envio de Authorization ou secret. allowCustomEndpoints existe apenas para fixtures.
 */
export function assertOfficialEndpoint(label: string, rawUrl: string, allowCustom = false): void {
  if (allowCustom) return;
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    throw new GoogleApiError("invalid_request", STABLE_MESSAGES.invalid_request, {
      reason: "invalid_request",
    });
  }
  if (!isOfficialGoogleHost(hostname)) {
    throw new GoogleApiError("invalid_request", "endpoint fora dos dominios oficiais do Google", {
      reason: "invalid_request",
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP: redirect manual, timeout total e corpo limitado
// ---------------------------------------------------------------------------

interface RequestOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function isAbortLike(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // corpo ja consumido ou indisponivel
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await cancelBody(response);
      throw new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, {
        reason: "response_too_large",
      });
    }
  }
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, {
          reason: "response_too_large",
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // lock ja liberado
    }
  }
  return text;
}

async function requestJson(
  fetchImpl: FetchLike,
  input: string | URL,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timeoutError = () =>
    new GoogleApiError("timeout", STABLE_MESSAGES.timeout, { reason: "timeout" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const work = (async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, redirect: "manual", signal: controller.signal });
    } catch (cause) {
      if (isAbortLike(cause)) throw timeoutError();
      throw new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, {
        reason: "network_error",
        retryable: true,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      throw new GoogleApiError("denied", STABLE_MESSAGES.denied, {
        status: response.status,
        reason: "unexpected_redirect",
      });
    }
    const text = await readBoundedBody(response, maxBytes, controller.signal);
    let parsed: unknown;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) throw classifyGoogleHttpError(response.status, parsed);
    if (parsed === undefined) {
      throw new GoogleApiError("parsing_error", STABLE_MESSAGES.parsing_error, {
        status: response.status,
        reason: "invalid_json",
      });
    }
    return parsed;
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function asTokenResponse(value: unknown, status: number): OAuthTokenResponse {
  if (typeof value !== "object" || value === null) {
    throw new GoogleApiError("parsing_error", STABLE_MESSAGES.parsing_error, { status });
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") throw tokenEndpointError(record, status);
  if (typeof record.access_token !== "string" || record.access_token === "") {
    throw new GoogleApiError("parsing_error", STABLE_MESSAGES.parsing_error, { status });
  }
  return record as OAuthTokenResponse;
}

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

export function randomUrlSafe(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") +
    "}";
}

// ---------------------------------------------------------------------------
// Configuracao OAuth
// ---------------------------------------------------------------------------

export const GOOGLE_OIDC_ISSUER = "https://accounts.google.com";

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly issuer: string;
  readonly jwksUri: string;
}

export const GOOGLE_OAUTH_DEFAULTS = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  issuer: GOOGLE_OIDC_ISSUER,
} as const;

export function googleOAuthConfig(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly clientSecret?: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly issuer?: string;
  readonly jwksUri?: string;
  readonly allowCustomEndpoints?: boolean;
}): GoogleOAuthConfig {
  if (!input.clientId) throw new GoogleApiError("invalid_request", "clientId e obrigatorio");
  if (!input.redirectUri) throw new GoogleApiError("invalid_request", "redirectUri e obrigatorio");
  const allowCustom = input.allowCustomEndpoints ?? false;
  const config: GoogleOAuthConfig = {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUri: input.redirectUri,
    authorizationEndpoint: input.authorizationEndpoint ??
      GOOGLE_OAUTH_DEFAULTS.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint ?? GOOGLE_OAUTH_DEFAULTS.tokenEndpoint,
    revocationEndpoint: input.revocationEndpoint ?? GOOGLE_OAUTH_DEFAULTS.revocationEndpoint,
    issuer: input.issuer ?? GOOGLE_OAUTH_DEFAULTS.issuer,
    jwksUri: input.jwksUri ?? GOOGLE_OAUTH_DEFAULTS.jwksUri,
  };
  assertOfficialEndpoint("authorizationEndpoint", config.authorizationEndpoint, allowCustom);
  assertOfficialEndpoint("tokenEndpoint", config.tokenEndpoint, allowCustom);
  assertOfficialEndpoint("revocationEndpoint", config.revocationEndpoint, allowCustom);
  assertOfficialEndpoint("issuer", config.issuer, allowCustom);
  assertOfficialEndpoint("jwksUri", config.jwksUri, allowCustom);
  return config;
}

// ---------------------------------------------------------------------------
// Escopos
// ---------------------------------------------------------------------------

/** Google returns userinfo URLs for the equivalent OIDC email/profile scopes. */
export function normalizeGoogleScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => {
    if (scope === "https://www.googleapis.com/auth/userinfo.email") return "email";
    if (scope === "https://www.googleapis.com/auth/userinfo.profile") return "profile";
    return scope;
  }))];
}

export const GOOGLE_SCOPE_SETS = {
  identity: ["openid", "email", "profile"],
  gmailRead: ["https://www.googleapis.com/auth/gmail.readonly"],
  gmailModify: ["https://www.googleapis.com/auth/gmail.modify"],
  calendarRead: ["https://www.googleapis.com/auth/calendar.readonly"],
  calendarEvents: ["https://www.googleapis.com/auth/calendar.events"],
  driveFile: ["https://www.googleapis.com/auth/drive.file"],
  driveRead: ["https://www.googleapis.com/auth/drive.readonly"],
  driveFull: ["https://www.googleapis.com/auth/drive"],
  docsRead: ["https://www.googleapis.com/auth/documents.readonly"],
  docsWrite: ["https://www.googleapis.com/auth/documents"],
  sheetsRead: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  sheetsWrite: ["https://www.googleapis.com/auth/spreadsheets"],
  slidesRead: ["https://www.googleapis.com/auth/presentations.readonly"],
  slidesWrite: ["https://www.googleapis.com/auth/presentations"],
} as const;

export type GoogleScopeSetName = keyof typeof GOOGLE_SCOPE_SETS;

export function resolveGoogleScopes(names: readonly GoogleScopeSetName[]): readonly string[] {
  const out: string[] = [];
  for (const name of names) {
    for (const scope of GOOGLE_SCOPE_SETS[name]) {
      if (!out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

export const GOOGLE_NARROW_SCOPES: readonly string[] = resolveGoogleScopes([
  "identity",
  "gmailRead",
  "calendarRead",
  "driveFile",
  "docsRead",
  "sheetsRead",
  "slidesRead",
]);

export const GOOGLE_BROAD_SCOPES: readonly string[] = resolveGoogleScopes([
  "identity",
  "gmailModify",
  "calendarEvents",
  "driveFull",
  "docsWrite",
  "sheetsWrite",
  "slidesWrite",
]);

// ---------------------------------------------------------------------------
// PKCE e autorizacao
// ---------------------------------------------------------------------------

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomUrlSafe(32);
  return { verifier, challenge: await sha256Base64Url(verifier), method: "S256" };
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly createdAt: number;
}

export async function createAuthorizationRequest(input: {
  readonly config: GoogleOAuthConfig;
  readonly scopes: readonly string[];
  readonly state?: string;
  readonly nonce?: string;
  readonly loginHint?: string;
  readonly prompt?: "none" | "consent" | "select_account";
  readonly accessType?: "offline" | "online";
  readonly includeGrantedScopes?: boolean;
  readonly now?: number;
}): Promise<AuthorizationRequest> {
  if (input.scopes.length === 0) {
    throw new GoogleApiError("invalid_request", "ao menos um escopo e obrigatorio");
  }
  const state = input.state ?? randomUrlSafe(32);
  const nonce = input.nonce ?? randomUrlSafe(32);
  const pkce = await createPkcePair();
  const url = new URL(input.config.authorizationEndpoint);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  url.searchParams.set("access_type", input.accessType ?? "offline");
  url.searchParams.set("include_granted_scopes", String(input.includeGrantedScopes ?? true));
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  if (input.prompt) url.searchParams.set("prompt", input.prompt);
  return {
    url: url.toString(),
    state,
    nonce,
    codeVerifier: pkce.verifier,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: "S256",
    scopes: input.scopes,
    redirectUri: input.config.redirectUri,
    createdAt: input.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Sessao pendente
// ---------------------------------------------------------------------------

export const MAX_PENDING_AGE_MS = 10 * 60 * 1000;

export interface PendingAuthorization {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
}

export interface PendingAuthorizationStore {
  take(state: string): Promise<PendingAuthorization | null>;
}

export class InMemoryPendingAuthorizations implements PendingAuthorizationStore {
  readonly #pending = new Map<string, PendingAuthorization>();

  register(request: AuthorizationRequest): PendingAuthorization {
    const pending: PendingAuthorization = {
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      createdAt: request.createdAt,
    };
    this.#pending.set(request.state, pending);
    return pending;
  }

  get size(): number {
    return this.#pending.size;
  }

  take(state: string): Promise<PendingAuthorization | null> {
    const pending = this.#pending.get(state);
    if (!pending) return Promise.resolve(null);
    this.#pending.delete(state);
    return Promise.resolve(pending);
  }
}

// ---------------------------------------------------------------------------
// id_token e identidade
// ---------------------------------------------------------------------------

export interface IdTokenVerificationOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
  readonly clockToleranceSec?: number;
}

export interface GoogleIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly hostedDomain?: string;
  readonly name?: string;
  readonly picture?: string;
  readonly issuer: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly issuedAt?: number;
  readonly nonce: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GoogleIdTokenVerifier {
  verify(idToken: string, options: IdTokenVerificationOptions): Promise<GoogleIdentity>;
}

export async function verifyIdTokenWithJwks(
  idToken: string,
  jwks: JWTVerifyGetKey,
  options: IdTokenVerificationOptions,
  clockToleranceSec = 60,
): Promise<GoogleIdentity> {
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(idToken, jwks, {
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: clockToleranceSec,
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
    });
    payload = verified.payload;
  } catch {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "id_token_invalid" });
  }
  const nonce = payload.nonce;
  if (typeof nonce !== "string" || nonce !== options.nonce) {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "nonce_mismatch" });
  }
  const aud = payload.aud;
  if (Array.isArray(aud)) {
    const azp = payload.azp;
    if (typeof azp !== "string" || azp !== options.audience) {
      throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "azp_mismatch" });
    }
  }
  const subject = payload.sub;
  if (typeof subject !== "string" || subject === "") {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "missing_sub" });
  }
  return {
    subject,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    hostedDomain: typeof payload.hd === "string" ? payload.hd : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
    issuer: typeof payload.iss === "string" ? payload.iss : options.issuer,
    audience: typeof aud === "string" ? aud : options.audience,
    expiresAt: typeof payload.exp === "number" ? payload.exp : 0,
    issuedAt: typeof payload.iat === "number" ? payload.iat : undefined,
    nonce,
    raw: payload as Readonly<Record<string, unknown>>,
  };
}

export function verifierFromJwks(
  jwks: JWTVerifyGetKey,
  clockToleranceSec = 60,
): GoogleIdTokenVerifier {
  return {
    verify: (idToken, options) => verifyIdTokenWithJwks(idToken, jwks, options, clockToleranceSec),
  };
}

/** Le o kid sem confiar no conteudo; nunca registra o token. */
function readTokenKid(idToken: string): string | undefined {
  try {
    const header = decodeProtectedHeader(idToken);
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verificador com cache de JWKS. Se o kid do token nao estiver no cache, atualiza
 * o JWKS uma vez (rotacao de chaves) antes de validar. Nunca registra segredo.
 */
export function createGoogleIdTokenVerifier(options: {
  readonly jwksUri: string;
  readonly fetch?: FetchLike;
  readonly clockToleranceSec?: number;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowCustomEndpoints?: boolean;
}): GoogleIdTokenVerifier {
  assertOfficialEndpoint("jwksUri", options.jwksUri, options.allowCustomEndpoints ?? false);
  const fetchImpl = options.fetch ?? defaultFetch;
  const cacheMs = options.cacheMs ?? 300000;
  interface JwksCache {
    readonly jwks: JWTVerifyGetKey;
    readonly kids: ReadonlySet<string>;
    readonly at: number;
  }
  let cache: JwksCache | null = null;
  const load = async (force: boolean): Promise<JwksCache> => {
    const now = Date.now();
    if (!force && cache && now - cache.at < cacheMs) return cache;
    const body = await requestJson(fetchImpl, options.jwksUri, { method: "GET" }, {
      timeoutMs: options.timeoutMs ?? 30000,
      maxBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    });
    const keys = typeof body === "object" && body !== null &&
        Array.isArray((body as { keys?: unknown }).keys)
      ? (body as { keys: JWK[] }).keys
      : [];
    const kids = new Set(
      keys.map((key) => key.kid).filter((kid): kid is string => typeof kid === "string"),
    );
    cache = { jwks: createLocalJWKSet({ keys }), kids, at: now };
    return cache;
  };
  return {
    async verify(idToken, verifyOptions) {
      const kid = readTokenKid(idToken);
      let entry = await load(false);
      if (kid !== undefined && !entry.kids.has(kid)) {
        entry = await load(true);
      }
      return await verifyIdTokenWithJwks(
        idToken,
        entry.jwks,
        verifyOptions,
        options.clockToleranceSec ?? 60,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Troca de codigo, refresh e revogacao
// ---------------------------------------------------------------------------

export async function exchangeAuthorizationCode(input: {
  readonly config: GoogleOAuthConfig;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.config.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.config.redirectUri,
  });
  if (input.config.clientSecret) body.set("client_secret", input.config.clientSecret);
  const json = await requestJson(
    input.fetch ?? defaultFetch,
    input.config.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { timeoutMs: input.timeoutMs, maxBytes: input.maxBytes },
  );
  return asTokenResponse(json, 200);
}

export async function refreshAccessToken(input: {
  readonly config: GoogleOAuthConfig;
  readonly refreshToken: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.config.clientId,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (input.config.clientSecret) body.set("client_secret", input.config.clientSecret);
  const json = await requestJson(
    input.fetch ?? defaultFetch,
    input.config.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { timeoutMs: input.timeoutMs, maxBytes: input.maxBytes },
  );
  return asTokenResponse(json, 200);
}

export async function revokeToken(input: {
  readonly config: GoogleOAuthConfig;
  readonly token: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30000);
  try {
    let response: Response;
    try {
      response = await (input.fetch ?? defaultFetch)(input.config.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: input.token }).toString(),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (cause) {
      if (isAbortLike(cause)) {
        throw new GoogleApiError("timeout", STABLE_MESSAGES.timeout, { reason: "timeout" });
      }
      throw new GoogleApiError("unavailable", STABLE_MESSAGES.unavailable, {
        reason: "network_error",
        retryable: true,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      throw new GoogleApiError("denied", STABLE_MESSAGES.denied, {
        status: response.status,
        reason: "unexpected_redirect",
      });
    }
    if (response.ok) {
      await cancelBody(response);
      return true;
    }
    if (response.status === 400) {
      await cancelBody(response);
      return false;
    }
    const text = await readBoundedBody(
      response,
      input.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      controller.signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    throw classifyGoogleHttpError(response.status, parsed);
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshStoredGoogleToken(input: {
  readonly config: GoogleOAuthConfig;
  readonly record: SealedTokenRecord;
  readonly vault: TokenVault;
  readonly store: TokenStore;
  readonly fetch?: FetchLike;
  readonly nowMs?: number;
}): Promise<{ readonly record: SealedTokenRecord; readonly tokens: OAuthTokenResponse }> {
  const refreshToken = await openRefreshToken(input.vault, input.record);
  if (!refreshToken) {
    throw new GoogleApiError("expired", STABLE_MESSAGES.expired, { reason: "invalid_grant" });
  }
  const tokens = await refreshAccessToken({
    config: input.config,
    refreshToken,
    fetch: input.fetch,
  });
  const record = await persistRefreshedTokens({
    store: input.store,
    vault: input.vault,
    previous: input.record,
    response: tokens,
    nowMs: input.nowMs,
  });
  return { record, tokens };
}

export async function storeGoogleAuthorization(input: {
  readonly vault: TokenVault;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly response: OAuthTokenResponse;
  readonly scopes?: readonly string[];
  readonly nowMs?: number;
}): Promise<SealedTokenRecord> {
  return await sealTokenRecord({
    vault: input.vault,
    ownerId: input.ownerId,
    connectionId: input.connectionId,
    response: input.response,
    scopes: input.scopes,
    nowMs: input.nowMs,
  });
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export interface CallbackParams {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly error_description?: string;
}

export interface HandleCallbackInput {
  readonly params: CallbackParams;
  readonly config: GoogleOAuthConfig;
  readonly store: PendingAuthorizationStore;
  readonly verifier: GoogleIdTokenVerifier;
  readonly fetch?: FetchLike;
  readonly sessionId?: string;
  readonly additionalAccount?: boolean;
  readonly now?: number;
  readonly clockToleranceSec?: number;
}

export interface CallbackResult {
  readonly identity: GoogleIdentity;
  readonly tokens: OAuthTokenResponse;
  readonly scopes: readonly string[];
  readonly additionalAccount: boolean;
  readonly sessionId?: string;
}

export async function handleAuthorizationCallback(
  input: HandleCallbackInput,
): Promise<CallbackResult> {
  const { params, config, store, verifier } = input;
  if (params.error) {
    const kind: GoogleErrorKind = params.error === "access_denied" ? "denied" : "invalid_request";
    throw new GoogleApiError(kind, STABLE_MESSAGES[kind], { reason: safeReason(params.error) });
  }
  if (!params.code) {
    throw new GoogleApiError("invalid_request", STABLE_MESSAGES.invalid_request, {
      reason: "missing_code",
    });
  }
  if (!params.state) {
    throw new GoogleApiError("invalid_request", STABLE_MESSAGES.invalid_request, {
      reason: "missing_state",
    });
  }
  const pending = await store.take(params.state);
  if (!pending) {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "state_invalid" });
  }
  if (pending.redirectUri !== config.redirectUri) {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "redirect_mismatch" });
  }
  const now = input.now ?? Date.now();
  if (now - pending.createdAt > MAX_PENDING_AGE_MS) {
    throw new GoogleApiError("expired", STABLE_MESSAGES.expired, { reason: "pending_expired" });
  }
  const tokens = await exchangeAuthorizationCode({
    config,
    code: params.code,
    codeVerifier: pending.codeVerifier,
    fetch: input.fetch,
  });
  if (typeof tokens.id_token !== "string" || tokens.id_token === "") {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "missing_id_token" });
  }
  const identity = await verifier.verify(tokens.id_token, {
    issuer: config.issuer,
    audience: config.clientId,
    nonce: pending.nonce,
    clockToleranceSec: input.clockToleranceSec,
  });
  const granted = parseScopes(tokens.scope);
  return {
    identity,
    tokens,
    scopes: granted.length > 0 ? granted : pending.scopes,
    additionalAccount: input.additionalAccount ?? false,
    sessionId: input.sessionId,
  };
}

// ---------------------------------------------------------------------------
// Paginacao
// ---------------------------------------------------------------------------

export interface PaginationLimits {
  readonly maxPages?: number;
  readonly maxItems?: number;
}

export interface BoundedPage<T> {
  readonly items: readonly T[];
  readonly coverage: GoogleCoverage;
  readonly pages: number;
  readonly nextCursor?: string;
  readonly resumeCursor?: string;
  readonly cursorAdvanced: boolean;
  readonly reason?: string;
}

interface PageSlice<T> {
  readonly items: readonly T[];
  readonly nextPageToken?: string;
  readonly terminal?: string;
}

interface Paginated<T> {
  readonly items: readonly T[];
  readonly pages: number;
  readonly complete: boolean;
  readonly nextPageToken?: string;
  readonly terminal?: string;
}

async function paginate<T>(
  fetchPage: (token: string | undefined, remainingItems: number) => Promise<PageSlice<T>>,
  options: { readonly startToken?: string; readonly limits?: PaginationLimits },
): Promise<Paginated<T>> {
  const maxPages = options.limits?.maxPages ?? 25;
  const maxItems = options.limits?.maxItems ?? 1000;
  const items: T[] = [];
  let token = options.startToken;
  let pages = 0;
  let complete = false;
  let nextPageToken: string | undefined;
  let terminal: string | undefined;
  while (true) {
    pages++;
    const slice = await fetchPage(token, maxItems - items.length);
    items.push(...slice.items);
    if (slice.terminal !== undefined) terminal = slice.terminal;
    nextPageToken = slice.nextPageToken;
    if (!slice.nextPageToken) {
      complete = true;
      break;
    }
    if (pages >= maxPages || items.length >= maxItems) break;
    token = slice.nextPageToken;
  }
  return { items, pages, complete, nextPageToken, terminal };
}

function completePage<T>(items: readonly T[], pages: number, terminal?: string): BoundedPage<T> {
  return {
    items,
    coverage: "complete",
    pages,
    cursorAdvanced: terminal !== undefined,
    nextCursor: terminal,
  };
}

function partialPage<T>(items: readonly T[], pages: number, resumeCursor?: string): BoundedPage<T> {
  return { items, coverage: "partial", pages, cursorAdvanced: false, resumeCursor };
}

// ---------------------------------------------------------------------------
// Cliente de leitura
// ---------------------------------------------------------------------------

export interface GoogleApiEndpoints {
  readonly gmail: string;
  readonly calendar: string;
  readonly drive: string;
  readonly docs: string;
  readonly sheets: string;
  readonly slides: string;
}

export const GOOGLE_API_ENDPOINTS: GoogleApiEndpoints = {
  gmail: "https://gmail.googleapis.com/gmail/v1",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  slides: "https://slides.googleapis.com/v1",
};

export interface GoogleReadClientOptions {
  readonly accessToken: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly endpoints?: Partial<GoogleApiEndpoints>;
  /** Somente fixtures: permite hosts fora dos dominios oficiais do Google. */
  readonly allowCustomEndpoints?: boolean;
}

export class GoogleReadClient {
  readonly #accessToken: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #endpoints: GoogleApiEndpoints;

  constructor(options: GoogleReadClientOptions) {
    if (!options.accessToken) {
      throw new GoogleApiError("invalid_request", "accessToken e obrigatorio");
    }
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#timeoutMs = options.timeoutMs ?? 30000;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#endpoints = { ...GOOGLE_API_ENDPOINTS, ...options.endpoints };
    const allowCustom = options.allowCustomEndpoints ?? false;
    for (const [name, value] of Object.entries(this.#endpoints)) {
      assertOfficialEndpoint(name, value, allowCustom);
    }
  }

  async #json(input: string | URL, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + this.#accessToken);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return await requestJson(this.#fetch, input, { ...init, headers }, {
      timeoutMs: this.#timeoutMs,
      maxBytes: this.#maxResponseBytes,
    });
  }

  // --- Gmail -------------------------------------------------------------

  async listGmailMessages(
    input: {
      readonly query?: string;
      readonly labelIds?: readonly string[];
      readonly maxResults?: number;
      readonly pageToken?: string;
      readonly limits?: PaginationLimits;
    } = {},
  ): Promise<BoundedPage<JsonObject>> {
    const p = await paginate<JsonObject>(async (token, remaining) => {
      const url = new URL(this.#endpoints.gmail + "/users/me/messages");
      if (input.query) url.searchParams.set("q", input.query);
      for (const label of input.labelIds ?? []) url.searchParams.append("labelIds", label);
      url.searchParams.set("maxResults", String(Math.min(input.maxResults ?? 100, remaining, 500)));
      if (token) url.searchParams.set("pageToken", token);
      const body = await this.#json(url) as { messages?: JsonObject[]; nextPageToken?: string };
      return { items: body.messages ?? [], nextPageToken: body.nextPageToken };
    }, { startToken: input.pageToken, limits: input.limits });
    return p.complete
      ? completePage(p.items, p.pages)
      : partialPage(p.items, p.pages, p.nextPageToken);
  }

  async listGmailThreads(
    input: {
      readonly query?: string;
      readonly maxResults?: number;
      readonly pageToken?: string;
      readonly limits?: PaginationLimits;
    } = {},
  ): Promise<BoundedPage<JsonObject>> {
    const p = await paginate<JsonObject>(async (token) => {
      const url = new URL(this.#endpoints.gmail + "/users/me/threads");
      if (input.query) url.searchParams.set("q", input.query);
      if (input.maxResults !== undefined) {
        url.searchParams.set("maxResults", String(input.maxResults));
      }
      if (token) url.searchParams.set("pageToken", token);
      const body = await this.#json(url) as { threads?: JsonObject[]; nextPageToken?: string };
      return { items: body.threads ?? [], nextPageToken: body.nextPageToken };
    }, { startToken: input.pageToken, limits: input.limits });
    return p.complete
      ? completePage(p.items, p.pages)
      : partialPage(p.items, p.pages, p.nextPageToken);
  }

  async getGmailMessage(input: {
    readonly messageId: string;
    readonly format?: "metadata" | "full" | "minimal" | "raw";
    readonly metadataHeaders?: readonly string[];
  }): Promise<JsonObject> {
    const url = new URL(
      this.#endpoints.gmail + "/users/me/messages/" + encodeURIComponent(input.messageId),
    );
    url.searchParams.set("format", input.format ?? "metadata");
    for (const header of input.metadataHeaders ?? []) {
      url.searchParams.append("metadataHeaders", header);
    }
    return await this.#json(url) as JsonObject;
  }

  async listGmailHistory(input: {
    readonly startHistoryId: string;
    readonly historyTypes?: readonly string[];
    readonly pageToken?: string;
    readonly limits?: PaginationLimits;
  }): Promise<BoundedPage<JsonObject>> {
    try {
      const p = await paginate<JsonObject>(async (token) => {
        const url = new URL(this.#endpoints.gmail + "/users/me/history");
        url.searchParams.set("startHistoryId", input.startHistoryId);
        for (const type of input.historyTypes ?? []) url.searchParams.append("historyTypes", type);
        if (token) url.searchParams.set("pageToken", token);
        const body = await this.#json(url) as {
          history?: JsonObject[];
          nextPageToken?: string;
          historyId?: string;
        };
        return {
          items: body.history ?? [],
          nextPageToken: body.nextPageToken,
          terminal: body.historyId,
        };
      }, { startToken: input.pageToken, limits: input.limits });
      return p.complete
        ? completePage(p.items, p.pages, p.terminal)
        : partialPage(p.items, p.pages, p.nextPageToken);
    } catch (cause) {
      if (cause instanceof GoogleApiError && cause.status === 404) {
        return {
          items: [],
          coverage: "expired",
          pages: 0,
          cursorAdvanced: false,
          reason: "history_expired",
        };
      }
      throw cause;
    }
  }

  // --- Calendar ----------------------------------------------------------

  async listCalendars(
    input: { readonly limits?: PaginationLimits; readonly maxResults?: number; readonly pageToken?: string } = {},
  ): Promise<BoundedPage<JsonObject>> {
    const p = await paginate<JsonObject>(async (token, remaining) => {
      const url = new URL(this.#endpoints.calendar + "/users/me/calendarList");
      url.searchParams.set("maxResults", String(Math.min(input.maxResults ?? 100, remaining, 250)));
      if (token) url.searchParams.set("pageToken", token);
      const body = await this.#json(url) as { items?: JsonObject[]; nextPageToken?: string };
      return { items: body.items ?? [], nextPageToken: body.nextPageToken };
    }, { startToken: input.pageToken, limits: input.limits });
    return p.complete
      ? completePage(p.items, p.pages)
      : partialPage(p.items, p.pages, p.nextPageToken);
  }

  async listCalendarEvents(
    input: {
      readonly calendarId?: string;
      readonly maxResults?: number;
      readonly syncToken?: string;
      readonly singleEvents?: boolean;
      readonly showDeleted?: boolean;
      readonly timeMin?: string;
      readonly timeMax?: string;
      readonly pageToken?: string;
      readonly limits?: PaginationLimits;
    } = {},
  ): Promise<BoundedPage<JsonObject>> {
    const calendarId = input.calendarId ?? "primary";
    const incremental = input.syncToken !== undefined;
    const singleEvents = input.singleEvents ?? true;
    try {
      const p = await paginate<JsonObject>(async (token, remaining) => {
        const url = new URL(
          this.#endpoints.calendar + "/calendars/" + encodeURIComponent(calendarId) + "/events",
        );
        url.searchParams.set("singleEvents", String(singleEvents));
        url.searchParams.set("maxResults", String(Math.min(input.maxResults ?? 250, remaining, 2500)));
        if (incremental) {
          url.searchParams.set("syncToken", input.syncToken as string);
          url.searchParams.set("showDeleted", "true");
        } else {
          url.searchParams.set("showDeleted", String(input.showDeleted ?? true));
          if (input.timeMin) url.searchParams.set("timeMin", input.timeMin);
          if (input.timeMax) url.searchParams.set("timeMax", input.timeMax);
        }
        if (token) url.searchParams.set("pageToken", token);
        const body = await this.#json(url) as {
          items?: JsonObject[];
          nextPageToken?: string;
          nextSyncToken?: string;
        };
        return {
          items: body.items ?? [],
          nextPageToken: body.nextPageToken,
          terminal: body.nextSyncToken,
        };
      }, { startToken: input.pageToken, limits: input.limits });
      return p.complete
        ? completePage(p.items, p.pages, p.terminal)
        : partialPage(p.items, p.pages, p.nextPageToken);
    } catch (cause) {
      if (
        cause instanceof GoogleApiError &&
        (cause.status === 410 || cause.reason === "fullSyncRequired")
      ) {
        return {
          items: [],
          coverage: "expired",
          pages: 0,
          cursorAdvanced: false,
          reason: "full_sync_required",
        };
      }
      throw cause;
    }
  }

  // --- Drive -------------------------------------------------------------

  async getDriveStartPageToken(input: { readonly driveId?: string } = {}): Promise<string> {
    const url = new URL(this.#endpoints.drive + "/changes/startPageToken");
    if (input.driveId) {
      url.searchParams.set("driveId", input.driveId);
      url.searchParams.set("supportsAllDrives", "true");
    }
    const body = await this.#json(url) as { startPageToken?: string };
    if (typeof body.startPageToken !== "string") {
      throw new GoogleApiError("parsing_error", STABLE_MESSAGES.parsing_error, {
        reason: "invalid_json",
      });
    }
    return body.startPageToken;
  }

  async listDriveChanges(input: {
    readonly pageToken: string;
    readonly includeRemoved?: boolean;
    readonly limits?: PaginationLimits;
  }): Promise<BoundedPage<JsonObject>> {
    try {
      const p = await paginate<JsonObject>(async (token) => {
        const url = new URL(this.#endpoints.drive + "/changes");
        url.searchParams.set("pageToken", token ?? input.pageToken);
        url.searchParams.set("includeRemoved", String(input.includeRemoved ?? true));
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set("includeItemsFromAllDrives", "true");
        const body = await this.#json(url) as {
          changes?: JsonObject[];
          nextPageToken?: string;
          newStartPageToken?: string;
        };
        return {
          items: body.changes ?? [],
          nextPageToken: body.nextPageToken,
          terminal: body.newStartPageToken,
        };
      }, { startToken: input.pageToken, limits: input.limits });
      return p.complete
        ? completePage(p.items, p.pages, p.terminal)
        : partialPage(p.items, p.pages, p.nextPageToken ?? input.pageToken);
    } catch (cause) {
      if (cause instanceof GoogleApiError && cause.status === 410) {
        return {
          items: [],
          coverage: "expired",
          pages: 0,
          cursorAdvanced: false,
          reason: "sync_token_expired",
        };
      }
      throw cause;
    }
  }

  async listDriveFiles(
    input: {
      readonly query?: string;
      readonly pageSize?: number;
      readonly pageToken?: string;
      readonly fields?: string;
      readonly limits?: PaginationLimits;
    } = {},
  ): Promise<BoundedPage<JsonObject>> {
    const p = await paginate<JsonObject>(async (token, remaining) => {
      const url = new URL(this.#endpoints.drive + "/files");
      url.searchParams.set("pageSize", String(Math.min(input.pageSize ?? 100, remaining, 1000)));
      if (input.query) url.searchParams.set("q", input.query);
      if (input.fields) url.searchParams.set("fields", input.fields);
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (token) url.searchParams.set("pageToken", token);
      const body = await this.#json(url) as { files?: JsonObject[]; nextPageToken?: string };
      return { items: body.files ?? [], nextPageToken: body.nextPageToken };
    }, { startToken: input.pageToken, limits: input.limits });
    return p.complete
      ? completePage(p.items, p.pages)
      : partialPage(p.items, p.pages, p.nextPageToken);
  }

  async listDriveRevisions(input: {
    readonly fileId: string;
    readonly limits?: PaginationLimits;
  }): Promise<BoundedPage<JsonObject>> {
    const p = await paginate<JsonObject>(async (token) => {
      const url = new URL(
        this.#endpoints.drive + "/files/" + encodeURIComponent(input.fileId) + "/revisions",
      );
      if (token) url.searchParams.set("pageToken", token);
      const body = await this.#json(url) as { revisions?: JsonObject[]; nextPageToken?: string };
      return { items: body.revisions ?? [], nextPageToken: body.nextPageToken };
    }, { limits: input.limits });
    return p.complete
      ? completePage(p.items, p.pages)
      : partialPage(p.items, p.pages, p.nextPageToken);
  }

  // --- Docs / Sheets / Slides -------------------------------------------

  async getDocument(input: {
    readonly documentId: string;
    readonly suggestionsViewMode?: string;
    readonly includeTabsContent?: boolean;
  }): Promise<JsonObject> {
    const url = new URL(
      this.#endpoints.docs + "/documents/" + encodeURIComponent(input.documentId),
    );
    if (input.suggestionsViewMode) {
      url.searchParams.set("suggestionsViewMode", input.suggestionsViewMode);
    }
    // Preserva abas por padrao; sem includeTabsContent o Docs devolve apenas a primeira aba.
    url.searchParams.set("includeTabsContent", String(input.includeTabsContent ?? true));
    return await this.#json(url) as JsonObject;
  }

  async getSpreadsheet(input: {
    readonly spreadsheetId: string;
    readonly ranges?: readonly string[];
    readonly includeGridData?: boolean;
  }): Promise<JsonObject> {
    const url = new URL(
      this.#endpoints.sheets + "/spreadsheets/" + encodeURIComponent(input.spreadsheetId),
    );
    for (const range of input.ranges ?? []) url.searchParams.append("ranges", range);
    if (input.includeGridData !== undefined) {
      url.searchParams.set("includeGridData", String(input.includeGridData));
    }
    return await this.#json(url) as JsonObject;
  }

  async getSpreadsheetValues(input: {
    readonly spreadsheetId: string;
    readonly range: string;
    readonly valueRenderOption?: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA";
  }): Promise<JsonObject> {
    const url = new URL(
      this.#endpoints.sheets + "/spreadsheets/" + encodeURIComponent(input.spreadsheetId) +
        "/values/" + encodeURIComponent(input.range),
    );
    if (input.valueRenderOption) url.searchParams.set("valueRenderOption", input.valueRenderOption);
    return await this.#json(url) as JsonObject;
  }

  async getPresentation(input: { readonly presentationId: string }): Promise<JsonObject> {
    const url = new URL(
      this.#endpoints.slides + "/presentations/" + encodeURIComponent(input.presentationId),
    );
    return await this.#json(url) as JsonObject;
  }
}

// ---------------------------------------------------------------------------
// Escrita: preparacao + autoridade de aprovacao (consumo atomico)
// ---------------------------------------------------------------------------

export type GoogleWriteProvider = "docs" | "sheets" | "slides" | "gmail" | "calendar" | "drive";

export interface WriteTarget {
  readonly provider: GoogleWriteProvider;
  readonly resourceId: string;
}

export interface PreparedWrite {
  readonly preparedId: string;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly target: WriteTarget;
  readonly baseRevision?: string;
  readonly payload: JsonObject;
  readonly payloadHash: string;
  readonly preparedAt: number;
}

export interface ApprovalBinding {
  readonly preparedId: string;
  readonly payloadHash: string;
  readonly target: WriteTarget;
  readonly ownerId: string;
  readonly connectionId: string;
}

export interface ApprovalReceipt extends ApprovalBinding {
  readonly receiptId: string;
  readonly approvedAt: number;
  readonly expiresAt?: number;
  /** Marca de confianca; um recibo sem trusted_ui nunca autoriza. */
  readonly source: "trusted_ui";
}

export type ApprovalConsumeResult =
  | { readonly status: "authorized"; readonly receipt: ApprovalReceipt }
  | { readonly status: "already_consumed"; readonly consumedAt: number }
  | { readonly status: "not_found" }
  | { readonly status: "mismatch" }
  | { readonly status: "expired" };

export type PersistedWriteOutcome =
  | { readonly state: "succeeded"; readonly externalId: string; readonly revision?: string }
  | { readonly state: "uncertain" };

export type WriteExecutionResult =
  | { readonly state: "succeeded"; readonly externalId: string; readonly revision?: string }
  | { readonly state: "uncertain"; readonly reason: string };

/**
 * Autoridade confiavel, fora dos argumentos do modelo. Consumo atomico garante que
 * um recibo so autoriza uma execucao; persistResult registra o desfecho incerto
 * antes de cruzar a fronteira externa, e priorResult impede reenvio.
 *
 * Espelha a semantica de src/production.ts (ApprovalAuthority) e pode ser ligada a
 * ela por um adaptador futuro. Sem implementacao confiavel, a execucao fica bloqueada.
 */
export interface WriteApprovalAuthority {
  priorResult(preparedId: string, ownerId: string): Promise<PersistedWriteOutcome | null>;
  consume(
    prepared: PreparedWrite,
    binding: ApprovalBinding,
    receiptId: string,
  ): Promise<ApprovalConsumeResult>;
  persistResult(
    prepared: PreparedWrite,
    result: { readonly state: "succeeded" | "uncertain"; readonly externalId?: string },
  ): Promise<void>;
}

export interface WriteExecutor {
  execute(
    prepared: PreparedWrite,
    receipt: ApprovalReceipt,
  ): Promise<{ readonly externalId: string; readonly revision?: string }>;
}

/** Hash canonico que amarra alvo + payload (deteccao de payload mutado). */
export function writeBindingCanonical(target: WriteTarget, payload: JsonObject): string {
  return canonicalJson({
    target: { provider: target.provider, resourceId: target.resourceId },
    payload,
  });
}

export async function prepareWrite(input: {
  readonly ownerId: string;
  readonly connectionId: string;
  readonly target: WriteTarget;
  readonly payload: JsonObject;
  readonly baseRevision?: string;
  readonly preparedId?: string;
  readonly now?: number;
}): Promise<PreparedWrite> {
  if (!input.target.resourceId) {
    throw new GoogleApiError("invalid_request", "alvo de escrita sem resourceId");
  }
  const payload = structuredClone(input.payload);
  return {
    preparedId: input.preparedId ?? randomUrlSafe(18),
    ownerId: input.ownerId,
    connectionId: input.connectionId,
    target: input.target,
    baseRevision: input.baseRevision,
    payload,
    payloadHash: await sha256Hex(writeBindingCanonical(input.target, payload)),
    preparedAt: input.now ?? Date.now(),
  };
}

function sameTarget(a: WriteTarget, b: WriteTarget): boolean {
  return a.provider === b.provider && a.resourceId === b.resourceId;
}

/**
 * Executa uma escrita preparada. Sem autoridade/executor confiaveis, fica bloqueada.
 * Recalcula o binding alvo+payload para rejeitar payload mutado; consome o recibo
 * atomicamente; registra incerto antes do efeito externo e nunca reenvia.
 */
export async function executePreparedWrite(input: {
  readonly prepared: PreparedWrite;
  readonly receiptId: string;
  readonly authority?: WriteApprovalAuthority;
  readonly executor?: WriteExecutor;
  readonly now?: number;
}): Promise<WriteExecutionResult> {
  if (!input.authority) {
    throw new GoogleApiError(
      "denied",
      "execucao bloqueada: nenhuma autoridade de aprovacao confiavel configurada",
      { reason: "approval_authority_missing" },
    );
  }
  if (!input.executor) {
    throw new GoogleApiError(
      "denied",
      "execucao bloqueada: nenhum executor de escrita configurado",
      { reason: "write_executor_missing" },
    );
  }
  const { prepared, authority } = input;
  const recomputed = await sha256Hex(writeBindingCanonical(prepared.target, prepared.payload));
  if (recomputed !== prepared.payloadHash) {
    throw new GoogleApiError("denied", "payload mudou depois da preparacao; prepare de novo", {
      reason: "payload_mutated",
    });
  }
  const binding: ApprovalBinding = {
    preparedId: prepared.preparedId,
    payloadHash: prepared.payloadHash,
    target: prepared.target,
    ownerId: prepared.ownerId,
    connectionId: prepared.connectionId,
  };
  const prior = await authority.priorResult(prepared.preparedId, prepared.ownerId);
  if (prior) {
    return prior.state === "succeeded"
      ? { state: "succeeded", externalId: prior.externalId, revision: prior.revision }
      : { state: "uncertain", reason: "prior_uncertain" };
  }
  const consumed = await authority.consume(prepared, binding, input.receiptId);
  if (consumed.status === "already_consumed") {
    throw new GoogleApiError("conflict", STABLE_MESSAGES.conflict, {
      reason: "approval_already_consumed",
    });
  }
  if (consumed.status === "not_found") {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, { reason: "approval_not_found" });
  }
  if (consumed.status === "mismatch") {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, {
      reason: "approval_binding_mismatch",
    });
  }
  if (consumed.status === "expired") {
    throw new GoogleApiError("expired", STABLE_MESSAGES.expired, { reason: "approval_expired" });
  }
  const receipt = consumed.receipt;
  if (
    receipt.source !== "trusted_ui" ||
    receipt.preparedId !== binding.preparedId ||
    receipt.payloadHash !== binding.payloadHash ||
    receipt.ownerId !== binding.ownerId ||
    receipt.connectionId !== binding.connectionId ||
    !sameTarget(receipt.target, binding.target)
  ) {
    throw new GoogleApiError("denied", STABLE_MESSAGES.denied, {
      reason: "approval_binding_mismatch",
    });
  }
  const now = input.now ?? Date.now();
  if (receipt.expiresAt !== undefined && now > receipt.expiresAt) {
    throw new GoogleApiError("expired", STABLE_MESSAGES.expired, { reason: "approval_expired" });
  }
  await authority.persistResult(prepared, { state: "uncertain" });
  try {
    const sent = await input.executor.execute(prepared, receipt);
    await authority.persistResult(prepared, { state: "succeeded", externalId: sent.externalId });
    return { state: "succeeded", externalId: sent.externalId, revision: sent.revision };
  } catch {
    return { state: "uncertain", reason: "executor_failed" };
  }
}
