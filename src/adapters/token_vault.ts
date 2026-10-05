/**
 * Cofre de tokens do AraHub — AES-256-GCM com chave vinda do ambiente.
 *
 * Garantias:
 * - A chave nunca fica no codigo; vem de variavel de ambiente e precisa ter 32 bytes.
 * - O envelope selado carrega apenas metadados (versao, algoritmo, id da chave, iv, ciphertext).
 * - toJSON/toString e o proprio envelope nunca expoem o texto claro.
 * - O AAD amarra o segredo a (owner, conexao, campo), impedindo reaproveitar o ciphertext.
 * - A persistencia concorrente usa CAS por version; um refresh sem refresh_token
 *   preserva o valor selado anterior em vez de apagar a credencial.
 *
 * Implementacao propria, MIT, independente do repositorio irmao.
 */

const ALG = "A256GCM" as const;

export const TOKEN_VAULT_KEY_ENV = "ARAHUB_TOKEN_VAULT_KEY";
export const TOKEN_VAULT_KEY_ID_ENV = "ARAHUB_TOKEN_VAULT_KEY_ID";
export const TOKEN_VAULT_OLD_KEYS_ENV = "ARAHUB_TOKEN_VAULT_OLD_KEYS";

export class TokenVaultError extends Error {
  constructor(readonly code: string, message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "TokenVaultError";
  }
}

export class TokenConflictError extends TokenVaultError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "TokenConflictError";
  }
}

export interface SealedSecret {
  readonly v: 1;
  readonly alg: "A256GCM";
  readonly kid: string;
  readonly iv: string;
  readonly ct: string;
}

export interface VaultKeyMaterial {
  readonly kid: string;
  readonly key: Uint8Array<ArrayBuffer>;
}

export interface TokenVaultEnvironment {
  get(name: string): string | undefined;
}

export type TokenProvider = "google";

export interface SealedTokenRecord {
  readonly ownerId: string;
  readonly connectionId: string;
  readonly provider: TokenProvider;
  readonly version: number;
  readonly accessToken: SealedSecret;
  readonly refreshToken?: SealedSecret;
  readonly tokenType: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly updatedAt: number;
}

/**
 * Contrato de persistencia. compareAndSwap so troca quando a versao lida ainda
 * e a corrente, com expectedVersion === 0 significando "criar se nao existir".
 */
export interface TokenStore {
  read(ownerId: string, connectionId: string): Promise<SealedTokenRecord | null>;
  compareAndSwap(
    ownerId: string,
    connectionId: string,
    expectedVersion: number,
    next: SealedTokenRecord,
  ): Promise<boolean>;
}

export interface OAuthTokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly token_type?: string;
  readonly id_token?: string;
  readonly [key: string]: unknown;
}

export interface MergedTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly tokenType: string;
  readonly expiresIn: number;
}

function normalizeBase64(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = cleaned.length % 4;
  return pad === 0 ? cleaned : cleaned + "=".repeat(4 - pad);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(normalizeBase64(text));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Aceita 32 bytes em hex (64 digitos) ou base64/base64url. Nunca ecoa o material. */
export function parseVaultKey(material: string): Uint8Array<ArrayBuffer> {
  const trimmed = material.trim();
  if (trimmed === "") {
    throw new TokenVaultError("empty_key", "material da chave do cofre esta vazio");
  }
  const bytes = /^[0-9a-fA-F]{64}$/.test(trimmed) ? hexToBytes(trimmed) : base64UrlDecode(trimmed);
  if (bytes.length !== 32) {
    throw new TokenVaultError(
      "invalid_key_length",
      "chave do cofre precisa decodificar para 32 bytes, obtido " + bytes.length,
    );
  }
  return bytes;
}

export function tokenAad(
  ownerId: string,
  connectionId: string,
  field: "access" | "refresh",
): string {
  return "arahub:token:v1:" + ownerId + ":" + connectionId + ":" + field;
}

export function parseScopes(scope: string | undefined): readonly string[] {
  if (!scope) return [];
  return scope.split(/\s+/).map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Mescla a resposta de refresh com o estado anterior.
 * Regra central: ausencia de refresh_token na resposta preserva o anterior.
 */
export function mergeTokenResponse(
  previous: { readonly refreshToken?: string; readonly scopes?: readonly string[] },
  response: OAuthTokenResponse,
  nowMs: number = Date.now(),
): MergedTokens {
  const accessToken = typeof response.access_token === "string" && response.access_token !== ""
    ? response.access_token
    : undefined;
  if (!accessToken) {
    throw new TokenVaultError("missing_access_token", "resposta de token nao incluiu access_token");
  }
  const expiresIn =
    typeof response.expires_in === "number" && Number.isFinite(response.expires_in) &&
      response.expires_in > 0
      ? response.expires_in
      : 3600;
  const rotated = typeof response.refresh_token === "string" && response.refresh_token.trim() !== ""
    ? response.refresh_token
    : undefined;
  const scopes = parseScopes(response.scope);
  return {
    accessToken,
    refreshToken: rotated ?? previous.refreshToken,
    scopes: scopes.length > 0 ? scopes : (previous.scopes ?? []),
    expiresAt: nowMs + expiresIn * 1000,
    tokenType: typeof response.token_type === "string" && response.token_type !== ""
      ? response.token_type
      : "Bearer",
    expiresIn,
  };
}

export class TokenVault {
  readonly #keys: ReadonlyMap<string, CryptoKey>;
  readonly #activeKid: string;

  private constructor(keys: ReadonlyMap<string, CryptoKey>, activeKid: string) {
    this.#keys = keys;
    this.#activeKid = activeKid;
  }

  static async fromRawKeys(materials: readonly VaultKeyMaterial[]): Promise<TokenVault> {
    if (materials.length === 0) {
      throw new TokenVaultError("no_keys", "ao menos uma chave e obrigatoria");
    }
    const keys = new Map<string, CryptoKey>();
    for (const material of materials) {
      if (keys.has(material.kid)) {
        throw new TokenVaultError("duplicate_kid", "id de chave duplicado: " + material.kid);
      }
      if (material.key.length !== 32) {
        throw new TokenVaultError("invalid_key_length", "chave do cofre precisa ter 32 bytes");
      }
      const key = await crypto.subtle.importKey(
        "raw",
        material.key,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
      keys.set(material.kid, key);
    }
    return new TokenVault(keys, materials[0].kid);
  }

  static async fromEnv(env: TokenVaultEnvironment = Deno.env): Promise<TokenVault> {
    const material = env.get(TOKEN_VAULT_KEY_ENV);
    if (!material) {
      throw new TokenVaultError("missing_key", TOKEN_VAULT_KEY_ENV + " nao esta definida");
    }
    const activeKid = env.get(TOKEN_VAULT_KEY_ID_ENV) ?? "primary";
    const materials: VaultKeyMaterial[] = [{ kid: activeKid, key: parseVaultKey(material) }];
    const oldKeys = env.get(TOKEN_VAULT_OLD_KEYS_ENV);
    if (oldKeys && oldKeys.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(oldKeys);
      } catch (cause) {
        throw new TokenVaultError(
          "invalid_old_keys",
          TOKEN_VAULT_OLD_KEYS_ENV + " nao e JSON valido",
          cause,
        );
      }
      if (!Array.isArray(parsed)) {
        throw new TokenVaultError(
          "invalid_old_keys",
          TOKEN_VAULT_OLD_KEYS_ENV + " precisa ser um array JSON",
        );
      }
      for (const entry of parsed) {
        if (typeof entry !== "object" || entry === null) {
          throw new TokenVaultError("invalid_old_keys", "cada chave antiga precisa ser um objeto");
        }
        const { kid, material: keyMaterial } = entry as { kid?: unknown; material?: unknown };
        if (typeof kid !== "string" || typeof keyMaterial !== "string") {
          throw new TokenVaultError(
            "invalid_old_keys",
            "cada chave antiga precisa de {kid, material}",
          );
        }
        materials.push({ kid, key: parseVaultKey(keyMaterial) });
      }
    }
    return TokenVault.fromRawKeys(materials);
  }

  get activeKid(): string {
    return this.#activeKid;
  }

  get keyIds(): readonly string[] {
    return [...this.#keys.keys()];
  }

  async seal(plaintext: string, aad = ""): Promise<SealedSecret> {
    const key = this.#keys.get(this.#activeKid);
    if (!key) throw new TokenVaultError("missing_active_key", "chave ativa do cofre indisponivel");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      key,
      new TextEncoder().encode(plaintext),
    );
    return {
      v: 1,
      alg: ALG,
      kid: this.#activeKid,
      iv: base64UrlEncode(iv),
      ct: base64UrlEncode(new Uint8Array(ciphertext)),
    };
  }

  async open(sealed: SealedSecret, aad = ""): Promise<string> {
    if (sealed.v !== 1 || sealed.alg !== ALG) {
      throw new TokenVaultError("unsupported_envelope", "envelope de segredo nao suportado");
    }
    const key = this.#keys.get(sealed.kid);
    if (!key) {
      throw new TokenVaultError("unknown_kid", "nenhuma chave disponivel para o kid " + sealed.kid);
    }
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlDecode(sealed.iv),
          additionalData: new TextEncoder().encode(aad),
        },
        key,
        base64UrlDecode(sealed.ct),
      );
    } catch (cause) {
      throw new TokenVaultError(
        "decrypt_failed",
        "segredo selado nao pode ser aberto (chave, AAD ou ciphertext invalido)",
        cause,
      );
    }
    return new TextDecoder().decode(plaintext);
  }

  /** Exportacao sem texto claro e sem material de chave. */
  toJSON(): {
    readonly kind: "TokenVault";
    readonly alg: "A256GCM";
    readonly activeKid: string;
    readonly keyIds: readonly string[];
  } {
    return { kind: "TokenVault", alg: ALG, activeKid: this.#activeKid, keyIds: this.keyIds };
  }

  toString(): string {
    return "TokenVault(activeKid=" + this.#activeKid + ", keys=" + this.#keys.size + ")";
  }
}

export class InMemoryTokenStore implements TokenStore {
  readonly #records = new Map<string, SealedTokenRecord>();

  #key(ownerId: string, connectionId: string): string {
    return ownerId + "\u0000" + connectionId;
  }

  read(ownerId: string, connectionId: string): Promise<SealedTokenRecord | null> {
    const record = this.#records.get(this.#key(ownerId, connectionId));
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  compareAndSwap(
    ownerId: string,
    connectionId: string,
    expectedVersion: number,
    next: SealedTokenRecord,
  ): Promise<boolean> {
    const key = this.#key(ownerId, connectionId);
    const current = this.#records.get(key);
    if (expectedVersion === 0) {
      if (current) return Promise.resolve(false);
    } else if (!current || current.version !== expectedVersion) {
      return Promise.resolve(false);
    }
    if (next.version !== expectedVersion + 1) {
      throw new TokenConflictError(
        "invalid_next_version",
        "proxima versao precisa ser expectedVersion + 1",
      );
    }
    this.#records.set(key, structuredClone(next));
    return Promise.resolve(true);
  }
}

export async function sealTokenRecord(input: {
  readonly vault: TokenVault;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly provider?: TokenProvider;
  readonly response: OAuthTokenResponse;
  readonly scopes?: readonly string[];
  readonly nowMs?: number;
}): Promise<SealedTokenRecord> {
  const nowMs = input.nowMs ?? Date.now();
  const merged = mergeTokenResponse({ scopes: input.scopes }, input.response, nowMs);
  const { ownerId, connectionId } = input;
  return {
    ownerId,
    connectionId,
    provider: input.provider ?? "google",
    version: 1,
    accessToken: await input.vault.seal(
      merged.accessToken,
      tokenAad(ownerId, connectionId, "access"),
    ),
    refreshToken: merged.refreshToken
      ? await input.vault.seal(merged.refreshToken, tokenAad(ownerId, connectionId, "refresh"))
      : undefined,
    tokenType: merged.tokenType,
    scopes: merged.scopes,
    expiresAt: merged.expiresAt,
    updatedAt: nowMs,
  };
}

/**
 * Grava o resultado de um refresh sob CAS. Em conflito, rele a versao corrente e
 * tenta de novo. O refresh token anterior permanece selado quando a resposta o omite.
 */
export async function persistRefreshedTokens(input: {
  readonly store: TokenStore;
  readonly vault: TokenVault;
  readonly previous: SealedTokenRecord;
  readonly response: OAuthTokenResponse;
  readonly nowMs?: number;
  readonly maxAttempts?: number;
}): Promise<SealedTokenRecord> {
  const nowMs = input.nowMs ?? Date.now();
  const maxAttempts = input.maxAttempts ?? 4;
  let current = input.previous;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const merged = mergeTokenResponse({ scopes: current.scopes }, input.response, nowMs);
    const rotated = typeof input.response.refresh_token === "string" &&
      input.response.refresh_token.trim() !== "";
    const refreshToken = rotated
      ? await input.vault.seal(
        merged.refreshToken as string,
        tokenAad(current.ownerId, current.connectionId, "refresh"),
      )
      : current.refreshToken;
    const next: SealedTokenRecord = {
      ...current,
      version: current.version + 1,
      accessToken: await input.vault.seal(
        merged.accessToken,
        tokenAad(current.ownerId, current.connectionId, "access"),
      ),
      refreshToken,
      tokenType: merged.tokenType,
      scopes: merged.scopes,
      expiresAt: merged.expiresAt,
      updatedAt: nowMs,
    };
    const swapped = await input.store.compareAndSwap(
      current.ownerId,
      current.connectionId,
      current.version,
      next,
    );
    if (swapped) return next;
    const reread = await input.store.read(current.ownerId, current.connectionId);
    if (!reread) {
      throw new TokenConflictError(
        "record_vanished",
        "registro de token desapareceu durante o refresh",
      );
    }
    current = reread;
  }
  throw new TokenConflictError(
    "cas_exhausted",
    "nao foi possivel persistir o token apos " + maxAttempts + " tentativas",
  );
}

export async function openAccessToken(
  vault: TokenVault,
  record: SealedTokenRecord,
): Promise<string> {
  return await vault.open(
    record.accessToken,
    tokenAad(record.ownerId, record.connectionId, "access"),
  );
}

export async function openRefreshToken(
  vault: TokenVault,
  record: SealedTokenRecord,
): Promise<string | undefined> {
  if (!record.refreshToken) return undefined;
  return await vault.open(
    record.refreshToken,
    tokenAad(record.ownerId, record.connectionId, "refresh"),
  );
}
