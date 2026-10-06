/**
 * Aprovação humana durável para ações externas (prepare -> approve/deny -> consume -> result).
 *
 * Responsabilidades:
 * - prepare: fixa no Postgres a fotografia canônica da ação (o mesmo JSON que
 *   src/production.ts hasheia) junto do hash SHA-256; credenciais nunca entram na ação.
 * - load/list: leitura isolada por dono; o hash é recomputado a partir do snapshot e
 *   conferido, então uma reescrita privilegiada do conteúdo é detectada.
 * - approve/deny: exigem Principal de navegador (sem clientId) com sessão ativa; a
 *   aprovação pinna conteúdo, versão, sessão e uma validade fixa (não deslizante).
 * - consume/persistResult/result: implementam ApprovalAuthority sem alterar
 *   src/production.ts. O consumo é atômico e de uso único: consome a aprovação e
 *   transiciona a ação para "uncertain" na MESMA transação, antes de qualquer chamada
 *   externa, impedindo envio duplo concorrente.
 *
 * Fronteiras:
 * - O dono da ação é derivado do Principal e conferido contra a conexão (FK composta).
 * - Um cliente MCP (client_id no JWT) não lê nem escreve a fronteira de aprovação pela
 *   Data API: RLS FORCE + política por owner com guarda de client_id no Postgres.
 * - Resultado incerto é preservado: nunca reenvia; reconciliação é explícita.
 */

import { createHash } from "node:crypto";
import { asOwner, type Db } from "./db.ts";
import { HubError, type Principal } from "./contracts.ts";
import {
  type ApprovalAuthority,
  prepareAction,
  type PreparedAction,
  type TrustedReceipt,
} from "./production.ts";

export type ActionState = "prepared" | "approved" | "denied" | "uncertain" | "succeeded";
export type ActionDecision = "approved" | "denied";
export type ActionOutcome = { state: "succeeded" | "uncertain"; externalId?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const STATE_VALUES: readonly ActionState[] = [
  "prepared",
  "approved",
  "denied",
  "uncertain",
  "succeeded",
];
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 64 * 1024;

/** Campos que nunca podem viajar na ação: credenciais vivem no cofre, não na aprovação. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "bearer",
  "authorization",
  "cookie",
  "cookies",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "private_key",
  "api_key",
  "apikey",
  "credential",
  "credentials",
]);

const ACTION_COLUMNS =
  "a.id,a.owner_id,a.connection_id,a.operation,a.target,a.revision,a.snapshot,a.content_hash,a.state,a.external_id,a.created_at,a.updated_at, ap.decision, ap.decided_hash, ap.decided_revision, ap.expires_at, ap.consumed_at, ap.decided_at";
const ACTION_FROM =
  "public.hub_actions a left join public.hub_action_approvals ap on ap.owner_id=a.owner_id and ap.action_id=a.id";

export interface ApprovalStoreDeps {
  /** Verificador de sessão do AraHub (auth.sessionActive). Obrigatório: a aprovação é de sessão. */
  sessionActive(ownerId: string, sessionId: string): Promise<boolean>;
  now?(): number;
  approvalTtlMs?: number;
}

export interface PrepareActionInput {
  connectionId: string;
  operation: string;
  target: string;
  revision?: string | null;
  content: unknown;
}

export interface ActionApprovalView {
  decision: ActionDecision;
  decidedHash: string;
  decidedRevision: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
  decidedAt: string;
}

export interface ActionView {
  action: PreparedAction;
  state: ActionState;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
  approval: ActionApprovalView | null;
}

export interface ListActionsFilter {
  states?: readonly ActionState[];
  limit?: number;
}

/**
 * Expectativa do revisor da UI. Opcional, mas fecha o TOCTOU entre a revisão exibida e a
 * aprovação: verificada contra a linha travada, depois do lock e antes de qualquer mutação.
 */
export interface ApprovalExpectation {
  expectedHash?: string;
  expectedRevision?: string | null;
}

interface ActionRow {
  id: string;
  owner_id: string;
  connection_id: string;
  operation: string;
  target: string;
  revision: string | null;
  snapshot: string;
  content_hash: string;
  state: ActionState;
  external_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  decision: ActionDecision | null;
  decided_hash: string | null;
  decided_revision: string | null;
  expires_at: unknown;
  consumed_at: unknown;
  decided_at: unknown;
}

/** Mesma serialização canônica de prepareAction: a ordem das chaves define o hash. */
function canonicalSnapshot(action: {
  connectionId: string;
  operation: string;
  target: string;
  revision: string | null;
  content: unknown;
}): string {
  return JSON.stringify({
    connectionId: action.connectionId,
    operation: action.operation,
    target: action.target,
    revision: action.revision,
    content: action.content,
  });
}

function hashOf(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string).toISOString();
}

function toNullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function assertNoCredentials(value: unknown, path: string, depth = 0): void {
  if (depth > 24) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoCredentials(entry, path + "[" + index + "]", depth + 1)
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new HubError(
          "credentials_in_action",
          "A ação não pode carregar credenciais; use o cofre protegido.",
          400,
        );
      }
      assertNoCredentials(nested, path + "." + key, depth + 1);
    }
  }
}

function requireText(value: unknown, min: number, max: number, message: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HubError("invalid_request", message, 400);
  }
  return value;
}

function requireUuid(value: unknown, message: string, status: number, code: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new HubError(code, message, status);
  return value;
}

function isActionState(value: unknown): value is ActionState {
  return typeof value === "string" && (STATE_VALUES as readonly string[]).includes(value);
}

export class PersistentActionStore implements ApprovalAuthority {
  readonly #db: Db;
  readonly #deps: ApprovalStoreDeps;

  constructor(db: Db, deps: ApprovalStoreDeps) {
    if (!deps || typeof deps.sessionActive !== "function") {
      throw new HubError(
        "invalid_config",
        "A aprovação durável exige verificador de sessão.",
        500,
      );
    }
    this.#db = db;
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #ttl(): number {
    const ttl = this.#deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 60 * 60 * 1000) {
      throw new HubError("invalid_config", "Validade de aprovação inválida.", 500);
    }
    return ttl;
  }

  async #requireBrowser(p: Principal): Promise<{ ownerId: string; sessionId: string }> {
    if (p.clientId) {
      throw new HubError("browser_required", "Aprove a ação pela interface do AraHub.", 403);
    }
    const ownerId = requireUuid(p.ownerId, "Sessão inválida.", 401, "unauthorized");
    const sessionId = requireUuid(
      p.sessionId,
      "Sessão do navegador inválida.",
      401,
      "session_required",
    );
    if (!await this.#deps.sessionActive(ownerId, sessionId)) {
      throw new HubError("session_required", "Sessão expirada. Entre novamente.", 401);
    }
    return { ownerId, sessionId };
  }

  #view(row: ActionRow): ActionView {
    let parsed: {
      connectionId?: unknown;
      operation?: unknown;
      target?: unknown;
      revision?: unknown;
      content?: unknown;
    };
    try {
      parsed = JSON.parse(row.snapshot) as typeof parsed;
    } catch {
      throw new HubError("content_changed", "A ação armazenada está corrompida.", 409);
    }
    const revision = parsed.revision === undefined ? null : parsed.revision;
    if (
      parsed.connectionId !== row.connection_id || parsed.operation !== row.operation ||
      parsed.target !== row.target || revision !== row.revision
    ) {
      throw new HubError("content_changed", "A ação não corresponde ao snapshot fixado.", 409);
    }
    const hash = hashOf(row.snapshot);
    if (hash !== row.content_hash || !HASH_RE.test(hash)) {
      throw new HubError("content_changed", "O hash do conteúdo não confere.", 409);
    }
    const action: PreparedAction = {
      id: row.id,
      ownerId: row.owner_id,
      connectionId: row.connection_id,
      operation: row.operation,
      target: row.target,
      revision: row.revision,
      content: parsed.content,
      hash,
    };
    // Recomputa pela forma de prepareAction para garantir compatibilidade com executeAction.
    const recomputed = prepareAction(
      action,
      action.connectionId,
      action.operation,
      action.target,
      action.revision,
      action.content,
    );
    if (recomputed.hash !== hash) {
      throw new HubError("content_changed", "O conteúdo mudou; prepare e autorize de novo.", 409);
    }
    const approval: ActionApprovalView | null = row.decision === null ? null : {
      decision: row.decision,
      decidedHash: row.decided_hash as string,
      decidedRevision: row.decided_revision,
      expiresAt: toNullableIso(row.expires_at),
      consumedAt: toNullableIso(row.consumed_at),
      decidedAt: toIso(row.decided_at),
    };
    return {
      action,
      state: row.state,
      externalId: row.external_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      approval,
    };
  }

  /** Persiste a ação preparada. Credenciais no conteúdo são recusadas. */
  async prepare(p: Principal, input: PrepareActionInput): Promise<PreparedAction> {
    if (!input || typeof input !== "object") {
      throw new HubError("invalid_request", "Ação inválida.", 400);
    }
    const ownerId = requireUuid(p.ownerId, "Sessão inválida.", 401, "unauthorized");
    const connectionId = requireUuid(
      input.connectionId,
      "Conexão inválida.",
      400,
      "invalid_request",
    );
    const operation = requireText(input.operation, 1, 120, "Operação inválida.");
    const target = requireText(input.target, 1, 2000, "Alvo inválido.");
    const revision = input.revision === undefined || input.revision === null
      ? null
      : requireText(input.revision, 1, 200, "Versão inválida.");
    if (!("content" in input)) {
      throw new HubError("invalid_request", "A ação precisa de conteúdo.", 400);
    }
    assertNoCredentials(input.content, "content");
    const snapshot = canonicalSnapshot({
      connectionId,
      operation,
      target,
      revision,
      content: input.content,
    });
    if (typeof snapshot !== "string") {
      throw new HubError("invalid_request", "O conteúdo da ação não é serializável.", 400);
    }
    if (new TextEncoder().encode(snapshot).length > MAX_SNAPSHOT_BYTES) {
      throw new HubError("limit_exceeded", "A ação excede o tamanho permitido.", 413);
    }
    const hash = hashOf(snapshot);
    const action = prepareAction(p, connectionId, operation, target, revision, input.content);
    if (action.hash !== hash) {
      throw new HubError("operation_failed", "Não foi possível fixar o conteúdo da ação.", 500);
    }
    // Caminho privilegiado: authenticated não tem grant de escrita. O dono é conferido
    // explicitamente e a FK composta (owner_id, connection_id) reforça o vínculo.
    await this.#db.begin(async (tx) => {
      const connection = await tx.unsafe(
        "select state from public.hub_connections where owner_id=$1 and id=$2",
        [ownerId, connectionId],
      );
      if (!connection.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
      if (connection[0].state === "revoked") {
        throw new HubError("connection_unavailable", "A conexão está revogada.", 409);
      }
      await tx.unsafe(
        "insert into public.hub_actions(id,owner_id,connection_id,operation,target,revision,snapshot,content_hash) values($1,$2,$3,$4,$5,$6,$7,$8)",
        [action.id, ownerId, connectionId, operation, target, revision, snapshot, hash],
      );
    });
    return action;
  }

  /** Carrega a ação do próprio dono. Ação inexistente ou de outro dono retorna null. */
  async load(p: Principal, actionId: string): Promise<ActionView | null> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) return null;
    return await asOwner(this.#db, p, async (tx) => {
      const rows = await tx.unsafe(
        "select " + ACTION_COLUMNS + " from " + ACTION_FROM +
          " where a.owner_id=$1 and a.id=$2",
        [p.ownerId, actionId],
      );
      return rows.length ? this.#view(rows[0] as unknown as ActionRow) : null;
    });
  }

  /** Lista as ações do dono, opcionalmente filtradas por estado. */
  async list(p: Principal, filter: ListActionsFilter = {}): Promise<ActionView[]> {
    const limit = filter.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new HubError("invalid_request", "Limite inválido.", 400);
    }
    const states = filter.states === undefined ? null : filter.states.slice();
    if (states && (states.length === 0 || !states.every(isActionState))) {
      throw new HubError("invalid_request", "Estados inválidos.", 400);
    }
    return await asOwner(this.#db, p, async (tx) => {
      const rows = states
        ? await tx.unsafe(
          "select " + ACTION_COLUMNS + " from " + ACTION_FROM +
            " where a.owner_id=$1 and a.state = any($2::text[]) order by a.created_at desc, a.id limit $3",
          [p.ownerId, states, limit],
        )
        : await tx.unsafe(
          "select " + ACTION_COLUMNS + " from " + ACTION_FROM +
            " where a.owner_id=$1 order by a.created_at desc, a.id limit $2",
          [p.ownerId, limit],
        );
      return rows.map((row) => this.#view(row as unknown as ActionRow));
    });
  }

  /** Aprovação humana confiável: navegador, sessão ativa, conteúdo fixado, validade estável. */
  async approve(
    p: Principal,
    actionId: string,
    expected: ApprovalExpectation = {},
  ): Promise<TrustedReceipt> {
    const { ownerId, sessionId } = await this.#requireBrowser(p);
    const id = requireUuid(actionId, "Ação não encontrada.", 404, "not_found");
    const view = await this.load(p, id);
    if (!view) throw new HubError("not_found", "Ação não encontrada.", 404);
    if (view.state === "uncertain" || view.state === "succeeded") {
      throw new HubError("approval_invalid", "A ação já foi executada.", 409);
    }
    const nowMs = this.#now();
    const expiresAt = new Date(nowMs + this.#ttl()).toISOString();
    return await this.#db.begin(async (tx) => {
      const locked = await tx.unsafe(
        "select state,content_hash,revision,snapshot from public.hub_actions where owner_id=$1 and id=$2 for update",
        [ownerId, id],
      );
      if (!locked.length) throw new HubError("not_found", "Ação não encontrada.", 404);
      const hash = locked[0].content_hash as string;
      const revision = locked[0].revision as string | null;
      // Igualdade snapshot/hash antes de qualquer mutação privilegiada.
      if (!HASH_RE.test(hash) || hashOf(locked[0].snapshot as string) !== hash) {
        throw new HubError("content_changed", "O snapshot não corresponde ao hash fixado.", 409);
      }
      // Fecha o TOCTOU entre a revisão na UI e a aprovação, já sob lock.
      if (
        (expected.expectedHash !== undefined && expected.expectedHash !== hash) ||
        (expected.expectedRevision !== undefined && expected.expectedRevision !== revision)
      ) {
        throw new HubError("content_changed", "O conteúdo revisado mudou; revise de novo.", 409);
      }
      const state = locked[0].state as ActionState;
      if (state === "uncertain" || state === "succeeded") {
        throw new HubError("approval_invalid", "A ação já foi executada.", 409);
      }
      if (state === "approved") {
        const prior = await tx.unsafe(
          "select decision,decided_hash,decided_revision,expires_at,consumed_at from public.hub_action_approvals where owner_id=$1 and action_id=$2 for update",
          [ownerId, id],
        );
        if (
          prior.length && prior[0].consumed_at === null && prior[0].decision === "approved" &&
          prior[0].decided_hash === hash && prior[0].decided_revision === locked[0].revision
        ) {
          if (Date.parse(toIso(prior[0].expires_at)) > nowMs) {
            // Reaprovação dentro da validade não estende a data já fixada.
            return {
              actionId: id,
              hash,
              ownerId,
              expiresAt: toIso(prior[0].expires_at),
              source: "trusted_ui" as const,
            };
          }
          // Aprovação vencida: uma nova decisão humana substitui a validade antiga.
        } else {
          throw new HubError("approval_invalid", "A ação já foi executada.", 409);
        }
      }
      // state 'prepared' ou 'denied': nova decisão humana substitui uma negativa anterior.
      const upserted = await tx.unsafe(
        "insert into public.hub_action_approvals(action_id,owner_id,approver_session_id,decided_hash,decided_revision,decision,expires_at,consumed_at) values($1,$2,$3,$4,$5,'approved',$6,null) on conflict(action_id) do update set approver_session_id=excluded.approver_session_id,decided_hash=excluded.decided_hash,decided_revision=excluded.decided_revision,decision='approved',expires_at=excluded.expires_at,consumed_at=null,decided_at=now() where public.hub_action_approvals.consumed_at is null returning action_id",
        [id, ownerId, sessionId, hash, locked[0].revision, expiresAt],
      );
      if (!upserted.length) {
        throw new HubError("approval_invalid", "A aprovação já foi usada.", 409);
      }
      const changed = await tx.unsafe(
        "update public.hub_actions set state='approved',updated_at=now() where owner_id=$1 and id=$2 and state in ('prepared','denied','approved') returning id",
        [ownerId, id],
      );
      if (!changed.length) throw new HubError("approval_invalid", "A ação mudou de estado.", 409);
      return { actionId: id, hash, ownerId, expiresAt, source: "trusted_ui" as const };
    });
  }

  /** Negativa humana. Não consome a ação; apenas remove a possibilidade de envio. */
  async deny(p: Principal, actionId: string, expected: ApprovalExpectation = {}): Promise<void> {
    const { ownerId, sessionId } = await this.#requireBrowser(p);
    const id = requireUuid(actionId, "Ação não encontrada.", 404, "not_found");
    const view = await this.load(p, id);
    if (!view) throw new HubError("not_found", "Ação não encontrada.", 404);
    if (view.state === "uncertain" || view.state === "succeeded") {
      throw new HubError("approval_invalid", "A ação já foi executada.", 409);
    }
    await this.#db.begin(async (tx) => {
      const locked = await tx.unsafe(
        "select state,content_hash,revision,snapshot from public.hub_actions where owner_id=$1 and id=$2 for update",
        [ownerId, id],
      );
      if (!locked.length) throw new HubError("not_found", "Ação não encontrada.", 404);
      const state = locked[0].state as ActionState;
      if (state === "uncertain" || state === "succeeded") {
        throw new HubError("approval_invalid", "A ação já foi executada.", 409);
      }
      const hash = locked[0].content_hash as string;
      const revision = locked[0].revision as string | null;
      if (!HASH_RE.test(hash) || hashOf(locked[0].snapshot as string) !== hash) {
        throw new HubError("content_changed", "O snapshot não corresponde ao hash fixado.", 409);
      }
      if (
        (expected.expectedHash !== undefined && expected.expectedHash !== hash) ||
        (expected.expectedRevision !== undefined && expected.expectedRevision !== revision)
      ) {
        throw new HubError("content_changed", "O conteúdo revisado mudou; revise de novo.", 409);
      }
      const written = await tx.unsafe(
        "insert into public.hub_action_approvals(action_id,owner_id,approver_session_id,decided_hash,decided_revision,decision,expires_at,consumed_at) values($1,$2,$3,$4,$5,'denied',null,null) on conflict(action_id) do update set approver_session_id=excluded.approver_session_id,decided_hash=excluded.decided_hash,decided_revision=excluded.decided_revision,decision='denied',expires_at=null,consumed_at=null,decided_at=now() where public.hub_action_approvals.consumed_at is null returning action_id",
        [id, ownerId, sessionId, hash, locked[0].revision],
      );
      if (!written.length) {
        throw new HubError("approval_invalid", "A aprovação já foi usada.", 409);
      }
      await tx.unsafe(
        "update public.hub_actions set state='denied',updated_at=now() where owner_id=$1 and id=$2 and state in ('prepared','approved','denied')",
        [ownerId, id],
      );
    });
  }

  /**
   * Uso único: consome a aprovação e marca a ação como incerta na mesma transação, antes
   * de qualquer efeito externo. Um segundo consumo concorrente não obtém recibo.
   */
  async consume(action: PreparedAction, actor: Principal): Promise<TrustedReceipt | null> {
    if (!action || typeof action.id !== "string" || !UUID_RE.test(action.id)) return null;
    if (!actor || actor.ownerId !== action.ownerId) return null;
    const ownerId = action.ownerId;
    if (!UUID_RE.test(ownerId)) return null;
    // Integridade criptográfica: o próprio objeto recebido tem que bater com o hash.
    if (!HASH_RE.test(action.hash) || hashOf(canonicalSnapshot(action)) !== action.hash) {
      return null;
    }
    const current = await asOwner(this.#db, { ownerId }, async (tx) => {
      const rows = await tx.unsafe(
        "select a.state,a.content_hash,a.revision,a.snapshot, ap.decision, ap.decided_hash, ap.decided_revision, ap.expires_at, ap.consumed_at, ap.approver_session_id from " +
          ACTION_FROM + " where a.owner_id=$1 and a.id=$2",
        [ownerId, action.id],
      );
      return rows[0] ?? null;
    });
    if (!current) return null;
    if (current.state !== "approved") return null;
    if (current.decision !== "approved" || current.consumed_at !== null) return null;
    // Compara a versão e o snapshot exato que o humano aprovou.
    if (
      current.content_hash !== action.hash || current.decided_hash !== action.hash ||
      current.revision !== action.revision || current.decided_revision !== action.revision
    ) return null;
    if (hashOf(current.snapshot as string) !== current.content_hash) return null;
    const expiresAt = toIso(current.expires_at);
    if (Date.parse(expiresAt) <= this.#now()) return null;
    const approverSession = current.approver_session_id;
    if (typeof approverSession !== "string" || !UUID_RE.test(approverSession)) return null;
    // Sessão expirada ou revogada invalida a aprovação, mesmo dentro da validade fixa.
    if (!await this.#deps.sessionActive(ownerId, approverSession)) return null;
    // Transação privilegiada única: trava ação e aprovação, reconfere snapshot/hash/versão,
    // consome a aprovação e promove para "uncertain" antes de liberar qualquer envio.
    const consumed = await this.#db.begin(async (tx) => {
      const locked = await tx.unsafe(
        "select state,content_hash,revision,snapshot from public.hub_actions where owner_id=$1 and id=$2 for update",
        [ownerId, action.id],
      );
      if (!locked.length) return null;
      const row = locked[0];
      if (row.state !== "approved") return null;
      if (row.content_hash !== action.hash || row.revision !== action.revision) return null;
      if (hashOf(row.snapshot as string) !== row.content_hash) return null;
      const approval = await tx.unsafe(
        "select decision,decided_hash,decided_revision,expires_at,consumed_at from public.hub_action_approvals where owner_id=$1 and action_id=$2 for update",
        [ownerId, action.id],
      );
      if (!approval.length) return null;
      const decided = approval[0];
      if (decided.decision !== "approved" || decided.consumed_at !== null) return null;
      if (
        decided.decided_hash !== action.hash || decided.decided_revision !== action.revision
      ) return null;
      if (Date.parse(toIso(decided.expires_at)) <= this.#now()) return null;
      const used = await tx.unsafe(
        "update public.hub_action_approvals set consumed_at=now() where owner_id=$1 and action_id=$2 and consumed_at is null and decision='approved' returning expires_at",
        [ownerId, action.id],
      );
      if (!used.length) return null;
      const moved = await tx.unsafe(
        "update public.hub_actions set state='uncertain',updated_at=now() where owner_id=$1 and id=$2 and state='approved' and content_hash=$3 returning id",
        [ownerId, action.id, action.hash],
      );
      if (!moved.length) {
        throw new HubError("approval_invalid", "A ação mudou durante a execução.", 409);
      }
      return toIso(used[0].expires_at);
    });
    if (!consumed) return null;
    return {
      actionId: action.id,
      hash: action.hash,
      ownerId,
      expiresAt: consumed,
      source: "trusted_ui",
    };
  }

  /** Persiste o desfecho terminal. "uncertain" nunca reenvia; reconciliação é explícita. */
  async persistResult(
    action: PreparedAction,
    result: { state: "succeeded" | "uncertain"; externalId?: string },
  ): Promise<void> {
    if (!action || typeof action.id !== "string" || !UUID_RE.test(action.id)) return;
    const ownerId = action.ownerId;
    if (!UUID_RE.test(ownerId) || !HASH_RE.test(action.hash)) return;
    const externalId = typeof result.externalId === "string"
      ? result.externalId.slice(0, 500)
      : null;
    // Mutação privilegiada com igualdade snapshot/hash: nunca confirma sobre conteúdo divergente.
    await this.#db.begin(async (tx) => {
      const locked = await tx.unsafe(
        "select state,content_hash,snapshot from public.hub_actions where owner_id=$1 and id=$2 for update",
        [ownerId, action.id],
      );
      if (!locked.length) return;
      const row = locked[0];
      if (row.content_hash !== action.hash || hashOf(row.snapshot as string) !== row.content_hash) {
        return;
      }
      if (result.state === "uncertain") {
        await tx.unsafe(
          "update public.hub_actions set state='uncertain',updated_at=now() where owner_id=$1 and id=$2 and state in ('prepared','approved','uncertain') and content_hash=$3",
          [ownerId, action.id, action.hash],
        );
        return;
      }
      await tx.unsafe(
        "update public.hub_actions set state='succeeded',external_id=$3,updated_at=now() where owner_id=$1 and id=$2 and state in ('uncertain','succeeded') and content_hash=$4",
        [ownerId, action.id, externalId, action.hash],
      );
    });
  }

  /** Resultado durável. Retorna null enquanto não houver desfecho (não reenvia incerto). */
  async result(actionId: string, ownerId: string): Promise<ActionOutcome | null> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) return null;
    if (typeof ownerId !== "string" || !UUID_RE.test(ownerId)) return null;
    return await asOwner(this.#db, { ownerId }, async (tx) => {
      const rows = await tx.unsafe(
        "select state,external_id from public.hub_actions where owner_id=$1 and id=$2",
        [ownerId, actionId],
      );
      if (!rows.length) return null;
      const state = rows[0].state as ActionState;
      if (state === "uncertain") return { state: "uncertain" as const };
      if (state === "succeeded") {
        return {
          state: "succeeded" as const,
          ...(typeof rows[0].external_id === "string"
            ? { externalId: rows[0].external_id as string }
            : {}),
        };
      }
      return null;
    });
  }
}
