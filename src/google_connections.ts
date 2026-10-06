/**
 * Servico de conexoes Google persistentes do AraHub.
 *
 * Responsabilidades:
 * - start: inicia o consentimento OAuth (state + PKCE + nonce) e grava uma pendencia
 *   privada, one-use, amarrada a owner + session + hash do state, com validade de 10 min.
 * - callback: consome a pendencia atomicamente e valida code/id_token pelo adaptador;
 *   owner, conexao e alvo vem SEMPRE da pendencia, nunca de argumentos do callback.
 * - client/tokens: leitura escopada a partir do token selado no cofre, com refresh sob CAS
 *   e estados de expiracao persistidos.
 *
 * Fronteiras:
 * - Exige navegador: principal sem clientId (MCP/OAuth de cliente nao inicia consentimento)
 *   e sessionId verificado.
 * - Escopos por allowlist; edição nativa exige capacidade explícita e aprovação por ação.
 * - Pendencias e tokens ficam em arahub_private, cifrados pelo cofre; retornos publicos nao
 *   carregam access/refresh token.
 * - Contas institucional e pessoal ficam separadas (origin = dominio ou "personal").
 *
 * SQL usa consultas parametrizadas (unsafe com $n): nenhum valor entra por interpolacao.
 * Sem OAuth real nem escrita externa: o transporte HTTP e o fetch do Google sao injetaveis.
 */

import { asOwner, type Db } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { PostgresTokenStore } from "./connections.ts";
import {
  mergeTokenResponse,
  type OAuthTokenResponse,
  openAccessToken,
  parseScopes,
  type SealedSecret,
  type SealedTokenRecord,
  sealTokenRecord,
  tokenAad,
  type TokenStore,
  type TokenVault,
} from "./adapters/token_vault.ts";
import {
  createAuthorizationRequest,
  createGoogleIdTokenVerifier,
  type FetchLike,
  GOOGLE_SCOPE_SETS,
  GoogleApiError,
  type GoogleIdTokenVerifier,
  type GoogleOAuthConfig,
  GoogleReadClient,
  handleAuthorizationCallback,
  type PendingAuthorization,
  refreshStoredGoogleToken,
  sha256Hex,
} from "./adapters/google.ts";

/**
 * Capacidades de leitura permitidas. Escrita nativa tem allowlist separada.
 *
 * selected_files mapeia drive.file. O Google concede a esse escopo escrita implicita sobre
 * arquivos escolhidos/criados pelo app; o AraHub NAO usa essa escrita (implicit_write=false,
 * sem executor), o usuario escolhe o modo de forma explicita, e isso nao significa acesso ao
 * Drive inteiro nem Picker implementado.
 */
export const GOOGLE_READ_CAPABILITIES = {
  identity: GOOGLE_SCOPE_SETS.identity,
  gmail_read: GOOGLE_SCOPE_SETS.gmailRead,
  calendar_read: GOOGLE_SCOPE_SETS.calendarRead,
  selected_files: GOOGLE_SCOPE_SETS.driveFile,
  drive_read: GOOGLE_SCOPE_SETS.driveRead,
  docs_read: GOOGLE_SCOPE_SETS.docsRead,
  sheets_read: GOOGLE_SCOPE_SETS.sheetsRead,
  slides_read: GOOGLE_SCOPE_SETS.slidesRead,
} as const;

export type GoogleReadCapability = keyof typeof GOOGLE_READ_CAPABILITIES;
export const GOOGLE_WRITE_CAPABILITIES = {
  docs_write: GOOGLE_SCOPE_SETS.docsWrite,
  sheets_write: GOOGLE_SCOPE_SETS.sheetsWrite,
  slides_write: GOOGLE_SCOPE_SETS.slidesWrite,
} as const;

const READ_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set(
  [
    ...Object.values(GOOGLE_READ_CAPABILITIES).flat(),
    ...Object.values(GOOGLE_WRITE_CAPABILITIES).flat(),
  ],
);

export const PENDING_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GooglePrincipal extends Principal {
  readonly sessionId?: string;
}

export interface GoogleConnectionsDeps {
  readonly fetch?: FetchLike;
  readonly verifier?: GoogleIdTokenVerifier;
  readonly sessionActive?: (ownerId: string, sessionId: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly clientFactory?: (accessToken: string) => GoogleReadClient;
  readonly tokenStore?: (db: Db, actor: Principal) => TokenStore;
}

export interface GoogleConnectionStart {
  readonly authorization_url: string;
  readonly state: string;
  readonly connection_id: string;
  readonly label: string;
  readonly desired_scopes: readonly string[];
}

export type GoogleConnectionState = "pending" | "connected" | "expired" | "revoked" | "denied";

export interface GoogleConnectionView {
  readonly id: string;
  readonly provider: "google";
  readonly label: string;
  readonly state: GoogleConnectionState;
  readonly origin: string | null;
  readonly account: {
    readonly subject: string;
    readonly email?: string;
    readonly hosted_domain?: string;
  };
  readonly desired_scopes: readonly string[];
  readonly granted_scopes: readonly string[];
  readonly denied_scopes: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/** Acesso escopado para montar um GoogleReadClient. Nunca inclui refresh token. */
export interface GoogleAccess {
  readonly access_token: string;
  readonly expires_at: number;
  readonly token_type: string;
}

interface SealedPending {
  readonly nonce: SealedSecret;
  readonly verifier: SealedSecret;
  readonly metadata: SealedSecret;
}

interface PendingMetadata {
  readonly label: string;
  readonly connection_id: string;
  readonly desired_scopes: string[];
}

/** Resolve only explicit capabilities. Write grants are separate from per-action human approval. */
export function resolveRequestedScopes(scopes: readonly string[]): readonly string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new HubError(
      "invalid_scope",
      "Informe ao menos uma capacidade do Google.",
      400,
    );
  }
  const out: string[] = [...GOOGLE_SCOPE_SETS.identity];
  for (const entry of scopes) {
    if (Object.prototype.hasOwnProperty.call(GOOGLE_WRITE_CAPABILITIES, entry)) {
      for (
        const scope of GOOGLE_WRITE_CAPABILITIES[entry as keyof typeof GOOGLE_WRITE_CAPABILITIES]
      ) {
        if (!out.includes(scope)) out.push(scope);
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(GOOGLE_READ_CAPABILITIES, entry)) {
      for (const scope of GOOGLE_READ_CAPABILITIES[entry as GoogleReadCapability]) {
        if (!out.includes(scope)) out.push(scope);
      }
      continue;
    }
    if (READ_SCOPE_ALLOWLIST.has(entry)) {
      if (!out.includes(entry)) out.push(entry);
      continue;
    }
    throw new HubError(
      "invalid_scope",
      "Escopo não permitido. Escolha uma capacidade oferecida pela interface.",
      400,
    );
  }
  return out;
}

function capabilityStatusFromScopes(granted: readonly string[]): Record<string, boolean> {
  const set = new Set(granted);
  const out: Record<string, boolean> = {};
  for (const [name, scopes] of Object.entries(GOOGLE_READ_CAPABILITIES)) {
    out[name] = scopes.every((scope) => set.has(scope));
  }
  return out;
}

function pendingAad(ownerId: string, sessionId: string, stateHash: string): string {
  return "arahub:google:oauth_pending:" + ownerId + ":" + sessionId + ":" + stateHash;
}

/**
 * Monta o proximo registro selado a partir do anterior (ou nulo). Em reconexao preserva o
 * refresh token anterior quando a resposta o omite, e incrementa a versao (CAS).
 */
async function buildNextRecord(input: {
  readonly vault: TokenVault;
  readonly previous: SealedTokenRecord | null;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly response: OAuthTokenResponse;
  readonly scopes: readonly string[];
  readonly nowMs: number;
}): Promise<SealedTokenRecord> {
  const { vault, previous, ownerId, connectionId, response, scopes, nowMs } = input;
  if (!previous) {
    return await sealTokenRecord({ vault, ownerId, connectionId, response, scopes, nowMs });
  }
  const merged = mergeTokenResponse({ scopes: previous.scopes }, response, nowMs);
  const rotated = typeof response.refresh_token === "string" &&
    response.refresh_token.trim() !== "";
  return {
    ...previous,
    version: previous.version + 1,
    accessToken: await vault.seal(merged.accessToken, tokenAad(ownerId, connectionId, "access")),
    refreshToken: rotated
      ? await vault.seal(merged.refreshToken as string, tokenAad(ownerId, connectionId, "refresh"))
      : previous.refreshToken,
    tokenType: merged.tokenType,
    scopes: merged.scopes,
    expiresAt: merged.expiresAt,
    updatedAt: nowMs,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "23505";
}

function toHubError(error: unknown): HubError {
  if (error instanceof HubError) return error;
  if (error instanceof GoogleApiError) {
    if (error.kind === "denied") {
      return new HubError("authorization_denied", "A autorizacao do Google foi recusada.", 403);
    }
    if (error.kind === "expired") {
      return new HubError(
        "authorization_expired",
        "A autorizacao do Google expirou. Tente novamente.",
        409,
      );
    }
    if (error.kind === "timeout") {
      return new HubError("source_timeout", "O Google nao respondeu a tempo.", 504);
    }
    return new HubError(
      "connection_failed",
      "Nao foi possivel concluir a conexao com o Google.",
      502,
    );
  }
  return new HubError(
    "connection_failed",
    "Nao foi possivel concluir a conexao com o Google.",
    502,
  );
}

export class GoogleConnections {
  readonly #hub: Hub;
  readonly #vault: TokenVault;
  readonly #config: GoogleOAuthConfig;
  readonly #deps: GoogleConnectionsDeps;

  constructor(
    hub: Hub,
    vault: TokenVault,
    config: GoogleOAuthConfig,
    deps: GoogleConnectionsDeps = {},
  ) {
    this.#hub = hub;
    this.#vault = vault;
    this.#config = config;
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #store(actor: Principal, epoch?: number): TokenStore {
    return this.#deps.tokenStore
      ? this.#deps.tokenStore(this.#hub.db, actor)
      : new PostgresTokenStore(this.#hub.db, actor, epoch);
  }

  #verifier(): GoogleIdTokenVerifier {
    return this.#deps.verifier ??
      createGoogleIdTokenVerifier({ jwksUri: this.#config.jwksUri, fetch: this.#deps.fetch });
  }

  #makeClient(accessToken: string): GoogleReadClient {
    return this.#deps.clientFactory
      ? this.#deps.clientFactory(accessToken)
      : new GoogleReadClient({ accessToken, fetch: this.#deps.fetch });
  }

  /**
   * Identidade para leitura autorizada (HTTP/MCP). Aceita clientId: o verificador externo ja
   * allowlistou o cliente; isto nao autoriza login nem novo escopo.
   */
  #requireIdentity(p: GooglePrincipal): { ownerId: string } {
    if (typeof p.ownerId !== "string" || !UUID_RE.test(p.ownerId)) {
      throw new HubError("unauthorized", "Sessao invalida.", 401);
    }
    return { ownerId: p.ownerId };
  }

  /** Consentimento/reconexao/desconexao exigem navegador: sem clientId e com sessao verificada. */
  async #requireBrowser(p: GooglePrincipal): Promise<{ ownerId: string; sessionId: string }> {
    if (p.clientId) {
      throw new HubError(
        "browser_required",
        "Conecte a conta Google pela interface do AraHub.",
        403,
      );
    }
    const sessionId = p.sessionId;
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
      throw new HubError("session_required", "Sessao do navegador invalida.", 401);
    }
    if (this.#deps.sessionActive && !await this.#deps.sessionActive(p.ownerId, sessionId)) {
      throw new HubError("session_required", "Sessao expirada. Entre novamente.", 401);
    }
    return { ownerId: p.ownerId, sessionId };
  }

  async start(
    p: GooglePrincipal,
    input: { label: string; scopes: readonly string[]; connection_id?: string },
  ): Promise<GoogleConnectionStart> {
    const { ownerId, sessionId } = await this.#requireBrowser(p);
    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (label.length === 0 || label.length > 120) {
      throw new HubError("invalid_request", "Informe um nome para a conexao.", 400);
    }
    const desired = resolveRequestedScopes(input.scopes);

    let connectionId: string;
    const targetId = input.connection_id;
    if (targetId !== undefined) {
      const rows = await asOwner(
        this.#hub.db,
        p,
        (tx) =>
          tx.unsafe(
            "select id,provider from public.hub_connections where owner_id=$1 and id=$2",
            [p.ownerId, targetId],
          ),
      );
      if (rows.length === 0 || rows[0].provider !== "google") {
        throw new HubError("not_found", "Conexao nao encontrada.", 404);
      }
      connectionId = rows[0].id as string;
    } else {
      const created = await this.#hub.connect(p, "google", label, null, null, {});
      connectionId = created.id as string;
    }

    // Escolha de conta obrigatoria no novo vinculo; consentimento forcado quando falta refresh.
    let prompt: "select_account" | "consent" | undefined;
    if (targetId === undefined) {
      prompt = "select_account";
    } else {
      const stored = await this.#store(p).read(ownerId, connectionId);
      if (!stored || !stored.refreshToken) prompt = "consent";
    }

    const auth = await createAuthorizationRequest({
      config: this.#config,
      scopes: desired,
      prompt,
      now: this.#now(),
    });
    const stateHash = await sha256Hex(auth.state);
    const aad = pendingAad(ownerId, sessionId, stateHash);
    const sealed: SealedPending = {
      nonce: await this.#vault.seal(auth.nonce, aad + ":nonce"),
      verifier: await this.#vault.seal(auth.codeVerifier, aad + ":verifier"),
      metadata: await this.#vault.seal(
        JSON.stringify({ label, connection_id: connectionId, desired_scopes: desired }),
        aad + ":metadata",
      ),
    };
    const expiresAt = new Date(this.#now() + PENDING_TTL_MS);
    // Trusted op: incrementa o epoch da conexao e vincula a pendencia a ele. Um start novo
    // invalida pendencias anteriores; disconnect tambem incrementa (fence). A conexao ja
    // mostra o pedido mesmo antes do callback.
    await this.#hub.db.begin(async (tx) => {
      const epochRows = await tx.unsafe(
        "update public.hub_connections set oauth_epoch = oauth_epoch + 1, label=$1, desired_scopes=$2, state=case when state in ('revoked','denied') then 'pending' else state end where owner_id=$3 and id=$4 and provider='google' returning oauth_epoch",
        [label, desired, ownerId, connectionId],
      );
      if (epochRows.length !== 1) throw new HubError("not_found", "Conexao nao encontrada.", 404);
      const epoch = epochRows[0].oauth_epoch as number;
      await tx.unsafe(
        "delete from arahub_private.oauth_pending where owner_id=$1 and expires_at <= now()",
        [ownerId],
      );
      await tx.unsafe(
        "insert into arahub_private.oauth_pending(state_hash,owner_id,session_id,connection_id,label,desired_scopes,sealed,expires_at,oauth_epoch) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          stateHash,
          ownerId,
          sessionId,
          connectionId,
          label,
          desired,
          JSON.parse(JSON.stringify(sealed)),
          expiresAt,
          epoch,
        ],
      );
    });
    return {
      authorization_url: auth.url,
      state: auth.state,
      connection_id: connectionId,
      label,
      desired_scopes: desired,
    };
  }

  async callback(
    p: GooglePrincipal,
    input: { code?: string; state: string; error?: string },
  ): Promise<GoogleConnectionView> {
    const { ownerId, sessionId } = await this.#requireBrowser(p);
    const state = typeof input.state === "string" ? input.state : "";
    if (state.length === 0) throw new HubError("invalid_request", "Callback sem state.", 400);
    const stateHash = await sha256Hex(state);

    // Consumo atomico: so o dono + sessao corretos, uma unica vez, antes da validade.
    const rows = await this.#hub.db.unsafe(
      "update arahub_private.oauth_pending set consumed_at=now() where state_hash=$1 and owner_id=$2 and session_id=$3 and consumed_at is null and expires_at > now() returning connection_id,label,desired_scopes,sealed,created_at,oauth_epoch",
      [stateHash, ownerId, sessionId],
    );
    if (rows.length === 0) {
      throw new HubError("state_invalid", "Autorizacao nao encontrada, expirada ou ja usada.", 409);
    }
    const pending = rows[0];
    const pendingEpoch = pending.oauth_epoch as number;
    const aad = pendingAad(ownerId, sessionId, stateHash);
    const sealed = pending.sealed as SealedPending;
    const nonce = await this.#vault.open(sealed.nonce, aad + ":nonce");
    const codeVerifier = await this.#vault.open(sealed.verifier, aad + ":verifier");
    const metadata = JSON.parse(
      await this.#vault.open(sealed.metadata, aad + ":metadata"),
    ) as PendingMetadata;
    // Owner/conexao/alvo vem da pendencia, nunca dos argumentos do callback.
    const connectionId = pending.connection_id as string;
    const desired = (pending.desired_scopes as string[] | null) ?? metadata.desired_scopes;

    const oneShot = {
      take: (candidate: string): Promise<PendingAuthorization | null> =>
        Promise.resolve(
          candidate === state
            ? {
              state,
              nonce,
              codeVerifier,
              redirectUri: this.#config.redirectUri,
              scopes: desired,
              createdAt: (pending.created_at as Date).getTime(),
            }
            : null,
        ),
    };

    let result;
    try {
      result = await handleAuthorizationCallback({
        params: { code: input.code, state, error: input.error },
        config: this.#config,
        store: oneShot,
        verifier: this.#verifier(),
        fetch: this.#deps.fetch,
        now: this.#now(),
      });
    } catch (error) {
      // Negacao/erro de autorizacao: denied apenas para conexao nova; reauth nao derruba a conectada.
      await this.#markDeniedIfPending(p, connectionId, pendingEpoch);
      throw toHubError(error);
    }

    const identity = result.identity;
    const origin = identity.hostedDomain ?? "personal";
    const grantedRaw = parseScopes(result.tokens.scope);
    const granted = grantedRaw.length > 0 ? grantedRaw : [];
    const denied = desired.filter((scope) => !granted.includes(scope));

    const capabilities = {
      reads: capabilityStatusFromScopes(granted),
      // drive.file concede escrita implicita no Google; o AraHub nao a usa e nao tem executor.
      selected_files_implicit_write: false,
      writes_enabled: Object.values(GOOGLE_WRITE_CAPABILITIES).flat().some((scope) =>
        desired.includes(scope) && granted.includes(scope)
      ),
      picker_implemented: false,
      drive_wide_discovery: granted.includes("https://www.googleapis.com/auth/drive.readonly") &&
        desired.includes("https://www.googleapis.com/auth/drive.readonly"),
      desired_scopes: desired,
      granted_scopes: granted,
      denied_scopes: denied,
      scope_confirmed: grantedRaw.length > 0,
      content_is_untrusted_data: true,
    };

    // Vinculo de identidade + credenciais + estado final, tudo sob lock da linha e epoch.
    // Disconnect/start concorrentes incrementam o epoch e invalidam esta pendencia, de modo
    // que um callback tardio nao reativa a conexao nem troca a identidade/token.
    try {
      await this.#hub.db.begin(async (tx) => {
        const currentRows = await tx.unsafe(
          "select oauth_epoch, state, provider_subject, origin from public.hub_connections where owner_id=$1 and id=$2 for update",
          [ownerId, connectionId],
        );
        if (currentRows.length === 0) {
          throw new HubError("not_found", "Conexao nao encontrada.", 404);
        }
        const current = currentRows[0];
        if ((current.oauth_epoch as number) !== pendingEpoch) {
          throw new HubError(
            "authorization_stale",
            "Esta autorizacao foi substituida. Inicie novamente.",
            409,
          );
        }
        if (current.state === "revoked") {
          throw new HubError("connection_unavailable", "A conexao foi desconectada.", 409);
        }
        if (current.provider_subject !== null && current.provider_subject !== identity.subject) {
          throw new HubError(
            "account_mismatch",
            "A conta Google nao corresponde a esta conexao.",
            409,
          );
        }
        if (current.origin !== null && current.origin !== origin) {
          throw new HubError(
            "account_mismatch",
            "O dominio da conta nao corresponde a esta conexao.",
            409,
          );
        }
        try {
          const claimed = await tx.unsafe(
            "update public.hub_connections set provider_subject=$1, origin=$2 where owner_id=$3 and id=$4 and (provider_subject is null or provider_subject=$1) and (origin is null or origin=$2) returning id",
            [identity.subject, origin, ownerId, connectionId],
          );
          if (claimed.length !== 1) {
            throw new HubError(
              "account_mismatch",
              "A conta Google nao corresponde a esta conexao.",
              409,
            );
          }
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new HubError(
              "account_already_connected",
              "Esta conta Google ja esta conectada.",
              409,
            );
          }
          throw error;
        }
        const existing = await tx.unsafe(
          "select encrypted_payload from arahub_private.credentials where owner_id=$1 and connection_id=$2",
          [ownerId, connectionId],
        );
        const previous = existing.length > 0
          ? (existing[0].encrypted_payload as SealedTokenRecord)
          : null;
        const next = await buildNextRecord({
          vault: this.#vault,
          previous,
          ownerId,
          connectionId,
          response: result.tokens,
          scopes: desired,
          nowMs: this.#now(),
        });
        const encoded = JSON.parse(JSON.stringify(next));
        if (previous) {
          const updated = await tx.unsafe(
            "update arahub_private.credentials set encrypted_payload=$1, key_version=$2, version=$3 where owner_id=$4 and connection_id=$5 and version=$6 returning connection_id",
            [encoded, next.accessToken.kid, next.version, ownerId, connectionId, previous.version],
          );
          if (updated.length !== 1) {
            throw new HubError(
              "connection_conflict",
              "A conexao mudou durante a autorizacao. Tente novamente.",
              409,
            );
          }
        } else {
          const inserted = await tx.unsafe(
            "insert into arahub_private.credentials(owner_id,connection_id,encrypted_payload,key_version,version) values($1,$2,$3,$4,$5) on conflict(connection_id) do nothing returning connection_id",
            [ownerId, connectionId, encoded, next.accessToken.kid, next.version],
          );
          if (inserted.length !== 1) {
            throw new HubError(
              "connection_conflict",
              "A conexao mudou durante a autorizacao. Tente novamente.",
              409,
            );
          }
        }
        await tx.unsafe(
          "update public.hub_connections set state='connected', desired_scopes=$1, granted_scopes=$2, capabilities=$3 where owner_id=$4 and id=$5",
          [desired, granted, tx.json(capabilities), ownerId, connectionId],
        );
      });
    } catch (error) {
      throw toHubError(error);
    }

    return {
      id: connectionId,
      provider: "google",
      label: metadata.label,
      state: "connected",
      origin,
      account: {
        subject: identity.subject,
        email: identity.email,
        hosted_domain: identity.hostedDomain,
      },
      desired_scopes: desired,
      granted_scopes: granted,
      denied_scopes: denied,
      capabilities,
    };
  }

  async client(p: GooglePrincipal, connectionId: string): Promise<GoogleReadClient> {
    const access = await this.tokens(p, connectionId);
    return this.#makeClient(access.access_token);
  }

  async tokens(p: GooglePrincipal, connectionId: string): Promise<GoogleAccess> {
    const { ownerId } = this.#requireIdentity(p);
    const connection = await asOwner(
      this.#hub.db,
      p,
      (tx) =>
        tx.unsafe(
          "select provider,state,oauth_epoch from public.hub_connections where owner_id=$1 and id=$2",
          [p.ownerId, connectionId],
        ),
    );
    if (connection.length === 0 || connection[0].provider !== "google") {
      throw new HubError("not_found", "Conexao nao encontrada.", 404);
    }
    if (connection[0].state === "revoked" || connection[0].state === "denied") {
      throw new HubError("connection_unavailable", "A conexao nao esta ativa.", 409);
    }
    const epoch = connection[0].oauth_epoch as number, store = this.#store(p, epoch);
    const record = await store.read(ownerId, connectionId);
    if (!record) {
      throw new HubError("connection_unavailable", "Renove a conexão pela interface.", 409);
    }
    const now = this.#now();
    if (record.expiresAt > now + ACCESS_TOKEN_SKEW_MS) {
      return {
        access_token: await openAccessToken(this.#vault, record),
        expires_at: record.expiresAt,
        token_type: record.tokenType,
      };
    }
    if (!record.refreshToken) {
      await this.#markExpired(p, connectionId, epoch);
      throw new HubError(
        "reauthorization_required",
        "Renove a conexao Google pela interface.",
        409,
      );
    }
    try {
      const refreshed = await refreshStoredGoogleToken({
        config: this.#config,
        record,
        vault: this.#vault,
        store,
        fetch: this.#deps.fetch,
        nowMs: now,
      });
      return {
        access_token: await openAccessToken(this.#vault, refreshed.record),
        expires_at: refreshed.record.expiresAt,
        token_type: refreshed.record.tokenType,
      };
    } catch (error) {
      await this.#markExpired(p, connectionId, epoch);
      throw toHubError(error);
    }
  }

  async list(p: GooglePrincipal): Promise<readonly GoogleConnectionView[]> {
    this.#requireIdentity(p);
    const rows = await asOwner(
      this.#hub.db,
      p,
      (tx) =>
        tx.unsafe(
          "select id,label,state,origin,provider_subject,desired_scopes,granted_scopes,capabilities from public.hub_connections where owner_id=$1 and provider='google' order by label,id",
          [p.ownerId],
        ),
    );
    return rows.map((row) => {
      const desired = (row.desired_scopes ?? []) as string[];
      const granted = (row.granted_scopes ?? []) as string[];
      return {
        id: row.id as string,
        provider: "google" as const,
        label: row.label as string,
        state: row.state as GoogleConnectionState,
        origin: (row.origin ?? null) as string | null,
        account: { subject: (row.provider_subject ?? "") as string },
        desired_scopes: desired,
        granted_scopes: granted,
        denied_scopes: desired.filter((scope) => !granted.includes(scope)),
        capabilities: (row.capabilities ?? {}) as Record<string, unknown>,
      };
    });
  }

  async disconnect(
    p: GooglePrincipal,
    connectionId: string,
  ): Promise<{ disconnected: true; history_preserved: true }> {
    await this.#requireBrowser(p);
    // Trusted op atomica: incrementa o epoch (fence), invalida pendencias do alvo, apaga
    // credenciais e revoga. Um callback tardio nao reativa a conexao.
    await this.#hub.db.begin(async (tx) => {
      const rows = await tx.unsafe(
        "update public.hub_connections set oauth_epoch = oauth_epoch + 1, state='revoked' where owner_id=$1 and id=$2 and provider='google' returning id",
        [p.ownerId, connectionId],
      );
      if (rows.length !== 1) throw new HubError("not_found", "Conexao nao encontrada.", 404);
      await tx.unsafe(
        "delete from arahub_private.oauth_pending where owner_id=$1 and connection_id=$2",
        [p.ownerId, connectionId],
      );
      await tx.unsafe(
        "delete from arahub_private.credentials where owner_id=$1 and connection_id=$2",
        [p.ownerId, connectionId],
      );
    });
    return { disconnected: true, history_preserved: true };
  }

  /** Erro/negacao de autorizacao vira denied apenas para conexao nova (pending). */
  async #markDeniedIfPending(
    p: GooglePrincipal,
    connectionId: string,
    epoch: number,
  ): Promise<void> {
    try {
      await this.#hub.db.begin(async (tx) => {
        await tx.unsafe(
          "update public.hub_connections set state='denied' where owner_id=$1 and id=$2 and provider='google' and state='pending' and oauth_epoch=$3",
          [p.ownerId, connectionId, epoch],
        );
      });
    } catch {
      // Melhor esforco; o erro de autorizacao original e o que importa.
    }
  }

  async #markExpired(p: GooglePrincipal, connectionId: string, epoch: number): Promise<void> {
    try {
      await this.#hub.db.begin(async (tx) => {
        await tx.unsafe(
          "update public.hub_connections set state='expired' where owner_id=$1 and id=$2 and provider='google' and state='connected' and oauth_epoch=$3",
          [p.ownerId, connectionId, epoch],
        );
      });
    } catch {
      // Estado e melhor esforco; o chamador ainda recebe o erro claro de reautorizacao.
    }
  }
}
