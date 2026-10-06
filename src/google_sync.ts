/**
 * Sincronizacao duravel de leitura do Google (Gmail, Calendar, Drive).
 *
 * Reaproveita GoogleConnections.client (token escopado, refresh sob CAS) e Jobs
 * (fila persistente retomavel). Nenhuma escrita remota: somente os metodos de
 * leitura oficiais de GoogleReadClient sao chamados, sob a mesma allowlist de
 * capacidades usada por GoogleReads.
 *
 * Garantias:
 * - O cursor (historyId do Gmail, nextSyncToken do Calendar, newStartPageToken do
 *   Drive) so avanca quando TODAS as paginas da janela pedida terminam completas.
 *   Leitura parcial grava um checkpoint de retomada (resume) no proprio estado
 *   duravel e no coverage do job; nada e descartado em silencio.
 * - Cursores expirados (Gmail 404 history_expired, Calendar 410 fullSyncRequired,
 *   Drive 410) disparam reconstrucao limitada por consulta/janela/selecao.
 * - Entidades qualificadas (owner+conexao+kind+external_id) e observacoes
 *   imutaveis deduplicadas por hash; o estado da entidade e mesclado (jsonb ||),
 *   preservando dimensoes do usuario. Ausencia ou leitura parcial nao apaga nada.
 * - O estado de sincronizacao fica numa entidade propria (kind google_sync_state)
 *   por conexao e chave de sincronizacao; cursor comprometido e checkpoint de
 *   retomada sao duraveis, independentes do processo que enfileirou.
 *
 * Fronteiras: leitura apenas; sem envio, marcacao de lida, escrita, novo
 * consentimento ou alteracao de projetos irmaos.
 */

import { asOwner, withJobLease } from "./db.ts";
import { Hub } from "./domain.ts";
import { Jobs } from "./jobs.ts";
import { type Coverage, HubError, type Principal } from "./contracts.ts";
import { GOOGLE_READ_CAPABILITIES, type GoogleConnections } from "./google_connections.ts";
import {
  type BoundedPage,
  GoogleApiError,
  type GoogleReadClient,
  type JsonObject,
  type PaginationLimits,
  sha256Hex,
} from "./adapters/google.ts";

/** Prefixo do kind do job. O restante carrega a chave duravel da sincronizacao. */
export const GOOGLE_SYNC_JOB_PREFIX = "google_sync:";
/** Kind da entidade que guarda cursor/checkpoint por conexao e chave. */
export const GOOGLE_SYNC_STATE_KIND = "google_sync_state";

export const GOOGLE_SYNC_KINDS = ["gmail", "calendar", "drive"] as const;
export type GoogleSyncKind = (typeof GOOGLE_SYNC_KINDS)[number];
export type GoogleSyncMode = "initial" | "incremental" | "rebuild";

const HASH_LEN = 16;
const DEFAULT_GMAIL_MESSAGE_LIMIT = 25;
const DEFAULT_GMAIL_REBUILD_WINDOW_DAYS = 30;
const DEFAULT_CALENDAR_WINDOW_PAST_DAYS = 30;
const DEFAULT_CALENDAR_WINDOW_FUTURE_DAYS = 90;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GoogleSyncGap {
  readonly stage: string;
  readonly coverage: Coverage;
  readonly error_code: string | null;
}

export interface GoogleSyncSummary {
  readonly sync_kind: GoogleSyncKind;
  readonly key: string;
  readonly mode: GoogleSyncMode;
  readonly coverage: Coverage;
  readonly cursor: string | null;
  readonly cursor_kind: string | null;
  readonly resume: Record<string, unknown> | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly gaps: readonly GoogleSyncGap[];
  readonly rebuilt: boolean;
  readonly truncated: boolean;
  readonly observed_at: string;
  readonly bounded: Readonly<Record<string, number>>;
}

export interface GoogleSyncRun {
  readonly job: Record<string, unknown>;
  readonly directed: boolean;
  readonly summary: GoogleSyncSummary;
}

export type GoogleSyncRunResult = GoogleSyncRun | { readonly state: "idle" };

export interface GmailSyncInput {
  readonly query?: string;
  readonly label_ids?: readonly string[];
  readonly message_limit?: number;
  readonly limits?: PaginationLimits;
  readonly rebuild?: boolean;
  readonly rebuild_window_days?: number;
}

export interface CalendarSyncInput {
  readonly calendar_id?: string;
  readonly time_min?: string;
  readonly time_max?: string;
  readonly limits?: PaginationLimits;
  readonly rebuild?: boolean;
}

export interface DriveSyncInput {
  readonly drive_id?: string;
  readonly selection_query?: string;
  readonly limits?: PaginationLimits;
  readonly rebuild?: boolean;
}

interface GoogleSyncState {
  sync_kind?: GoogleSyncKind;
  descriptor?: Record<string, unknown>;
  limits?: PaginationLimits | null;
  cursor?: string | null;
  cursor_kind?: string | null;
  resume?: Record<string, unknown> | null;
  coverage?: Coverage;
  mode?: GoogleSyncMode;
  rebuilt?: boolean;
  rebuild_requested?: boolean;
  updated_at?: string;
  counts?: Record<string, number>;
  truncated?: boolean;
}

interface ConnectionRow {
  readonly id: string;
  readonly state: string;
  readonly desired_scopes: string[];
  readonly granted_scopes: string[];
}

interface SyncOutcome {
  coverage: Coverage;
  cursor: string | null;
  cursorKind: string | null;
  resume: Record<string, unknown> | null;
  counts: Record<string, number>;
  gaps: GoogleSyncGap[];
  truncated: boolean;
  rebuilt: boolean;
  bounded: Record<string, number>;
}

type ClaimedJob = NonNullable<Awaited<ReturnType<Jobs["claim"]>>>;

const COVERAGE_RANK: Readonly<Record<Coverage, number>> = {
  complete: 0,
  partial: 1,
  timeout: 2,
  parsing_error: 3,
  unavailable: 4,
  denied: 5,
  expired: 6,
};

function worstCoverage(list: readonly Coverage[]): Coverage {
  let worst: Coverage = "complete";
  for (const value of list) {
    if (COVERAGE_RANK[value] > COVERAGE_RANK[worst]) worst = value;
  }
  return worst;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoOffsetDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Normaliza um id decimal do provedor sem passar por Number. O historyId do
 * Gmail e um decimal que pode exceder 2^53, entao a comparacao e feita como
 * string (por comprimento e depois lexicografica), nunca por float.
 */
function decimalId(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const normalized = trimmed.replace(/^0+(?=\d)/, "");
    return normalized === "0" ? null : normalized;
  }
  return null;
}

function maxDecimalId(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a >= b ? a : b;
}

function jsonable(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function connectionScopes(row: {
  readonly desired_scopes?: unknown;
  readonly granted_scopes?: unknown;
}): { readonly desired: string[]; readonly granted: string[] } {
  return {
    desired: Array.isArray(row.desired_scopes) ? row.desired_scopes as string[] : [],
    granted: Array.isArray(row.granted_scopes) ? row.granted_scopes as string[] : [],
  };
}

/** Mesma regra de GoogleReads: precisa estar desejado E concedido na conexao. */
function hasCapability(
  row: { readonly desired_scopes?: unknown; readonly granted_scopes?: unknown },
  scopes: readonly string[],
): boolean {
  const { desired, granted } = connectionScopes(row);
  return scopes.every((scope) => desired.includes(scope) && granted.includes(scope));
}

function errorCoverage(error: unknown): Coverage {
  if (error instanceof HubError) return "denied";
  if (error instanceof GoogleApiError) return error.coverage;
  return "unavailable";
}

function errorCode(error: unknown): string | null {
  if (error instanceof HubError) return error.code;
  if (error instanceof GoogleApiError) return error.reason ?? error.kind;
  return "error";
}

function provenance(
  connectionId: string,
  locator: string,
  observedAt: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    system: "google",
    connection_id: connectionId,
    locator,
    observed_at: observedAt,
    ...extra,
  };
}

function gmailSubject(message: JsonObject): string {
  const payload = asRecord(message.payload);
  const headers = payload.headers;
  if (Array.isArray(headers)) {
    for (const header of headers) {
      const item = asRecord(header);
      if (String(item.name ?? "").toLowerCase() === "subject") {
        const value = String(item.value ?? "").trim();
        if (value) return value.slice(0, 300);
      }
    }
  }
  const snippet = typeof message.snippet === "string" ? message.snippet.trim() : "";
  return snippet ? snippet.slice(0, 300) : "Mensagem Gmail";
}

function historyMessageIds(record: JsonObject): string[] {
  const ids: string[] = [];
  const added = record.messagesAdded;
  if (!Array.isArray(added)) return ids;
  for (const entry of added) {
    const message = asRecord(asRecord(entry).message);
    const id = asString(message.id);
    if (id) ids.push(id);
  }
  return ids;
}

function composeGmailQuery(base: string | null, windowDays: number | null): string | undefined {
  const parts: string[] = [];
  if (base && base.trim()) parts.push(base.trim());
  if (windowDays !== null && windowDays > 0) parts.push("newer_than:" + windowDays + "d");
  return parts.length ? parts.join(" ") : undefined;
}

async function syncKey(
  syncKind: GoogleSyncKind,
  descriptor: Record<string, unknown>,
): Promise<string> {
  const hash = await sha256Hex(JSON.stringify([syncKind, descriptor]));
  return syncKind + ":" + hash.slice(0, HASH_LEN);
}

function parseJobKind(kind: string): { syncKind: GoogleSyncKind; key: string } | null {
  if (typeof kind !== "string" || !kind.startsWith(GOOGLE_SYNC_JOB_PREFIX)) return null;
  const key = kind.slice(GOOGLE_SYNC_JOB_PREFIX.length);
  const split = key.indexOf(":");
  if (split < 0) return null;
  const syncKind = key.slice(0, split);
  const hash = key.slice(split + 1);
  if (!(GOOGLE_SYNC_KINDS as readonly string[]).includes(syncKind)) return null;
  if (!/^[a-f0-9]{16}$/.test(hash)) return null;
  return { syncKind: syncKind as GoogleSyncKind, key };
}

/**
 * Sincronizacao duravel dirigida (Gmail, Calendar, Drive).
 *
 * Cada metodo enfileira um job retomavel e o executa ate o limite local; um
 * resultado parcial mantem o cursor anterior e grava o checkpoint de retomada.
 * Chamar o mesmo metodo de novo (mesma chave) continua do checkpoint.
 */
export class GoogleSync {
  readonly jobs: Jobs;
  constructor(private hub: Hub, private connections: GoogleConnections) {
    this.jobs = new Jobs(hub.db);
  }

  /** Consulta dirigida + history incremental com reconstrucao limitada. */
  async gmail(
    p: Principal,
    connectionId: string,
    input: GmailSyncInput = {},
  ): Promise<GoogleSyncRun> {
    const query = typeof input.query === "string" && input.query.trim() ? input.query.trim() : null;
    const externalId = await this.#configure(p, connectionId, "gmail", {
      query,
      label_ids: Array.isArray(input.label_ids) ? [...input.label_ids].map(String).sort() : [],
      message_limit: input.message_limit ?? null,
      rebuild_window_days: input.rebuild_window_days ?? null,
    }, { limits: input.limits ?? null, rebuild: input.rebuild === true });
    const job = await this.jobs.enqueue(p, connectionId, externalId);
    return await this.run(p, job.id as string) as GoogleSyncRun;
  }

  /** Sincronizacao por calendario com syncToken e reconstrucao limitada. */
  async calendar(
    p: Principal,
    connectionId: string,
    input: CalendarSyncInput = {},
  ): Promise<GoogleSyncRun> {
    const calendarId = typeof input.calendar_id === "string" && input.calendar_id.trim()
      ? input.calendar_id.trim()
      : "primary";
    const externalId = await this.#configure(p, connectionId, "calendar", {
      calendar_id: calendarId,
      time_min: input.time_min ?? null,
      time_max: input.time_max ?? null,
    }, { limits: input.limits ?? null, rebuild: input.rebuild === true });
    const job = await this.jobs.enqueue(p, connectionId, externalId);
    return await this.run(p, job.id as string) as GoogleSyncRun;
  }

  /** Changes do Drive com startPageToken e reconstrucao limitada por selecao. */
  async drive(
    p: Principal,
    connectionId: string,
    input: DriveSyncInput = {},
  ): Promise<GoogleSyncRun> {
    const externalId = await this.#configure(p, connectionId, "drive", {
      drive_id: input.drive_id ?? null,
      selection_query: input.selection_query ?? null,
    }, { limits: input.limits ?? null, rebuild: input.rebuild === true });
    const job = await this.jobs.enqueue(p, connectionId, externalId);
    return await this.run(p, job.id as string) as GoogleSyncRun;
  }

  /** Reivindica e executa um job especifico de sincronizacao Google. */
  async run(p: Principal, jobId: string): Promise<GoogleSyncRunResult> {
    if (typeof jobId !== "string" || !UUID_RE.test(jobId)) {
      throw new HubError("invalid_job", "Informe um lote valido.", 400);
    }
    const kindRows = await asOwner(
      this.hub.db,
      p,
      (tx) => tx`select kind from public.hub_jobs where owner_id=${p.ownerId} and id=${jobId}`,
    );
    if (!kindRows.length) throw new HubError("not_found", "Registro nao encontrado.", 404);
    const parsed = parseJobKind(kindRows[0].kind as string);
    if (!parsed) throw new HubError("invalid_job", "Lote nao e de sincronizacao Google.", 400);
    const job = await this.jobs.claim(p, jobId);
    if (!job) return { state: "idle" };
    p = withJobLease(p, job.id, job.attempts);
    try {
      switch (parsed.syncKind) {
        case "gmail":
          return await this.#runGmail(p, job, parsed);
        case "calendar":
          return await this.#runCalendar(p, job, parsed);
        case "drive":
          return await this.#runDrive(p, job, parsed);
      }
    } catch (error) {
      if (error instanceof HubError && error.code === "job_conflict") throw error;
      return await this.#finishError(p, job, parsed, error);
    }
  }

  /** Jobs de sincronizacao Google do proprietario; insumo para retomar um lote. */
  async pending(p: Principal): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.jobs.list(p);
    return rows.filter((row) =>
      typeof row.kind === "string" && row.kind.startsWith(GOOGLE_SYNC_JOB_PREFIX)
    );
  }

  /** Estado duravel (cursor/checkpoint) por conexao e, opcionalmente, por chave. */
  async state(p: Principal, connectionId: string, externalId?: string) {
    await this.#connection(p, connectionId);
    const rows = externalId
      ? await asOwner(
        this.hub.db,
        p,
        (tx) =>
          tx`select external_id,title,state,state->>'updated_at' as updated_at from public.hub_entities where owner_id=${p.ownerId} and connection_id=${connectionId} and kind=${GOOGLE_SYNC_STATE_KIND} and external_id=${externalId}`,
      )
      : await asOwner(
        this.hub.db,
        p,
        (tx) =>
          tx`select external_id,title,state,state->>'updated_at' as updated_at from public.hub_entities where owner_id=${p.ownerId} and connection_id=${connectionId} and kind=${GOOGLE_SYNC_STATE_KIND} order by external_id`,
      );
    return { states: rows, content_is_untrusted_data: true };
  }

  // -- Configuracao duravel da chave --------------------------------------

  /**
   * Persiste o descritor da chave antes de enfileirar, para que um job
   * reivindicado depois por outro processo saiba o que ler e onde retomar.
   */
  async #configure(
    p: Principal,
    connectionId: string,
    syncKind: GoogleSyncKind,
    descriptor: Record<string, unknown>,
    options: { readonly limits: PaginationLimits | null; readonly rebuild: boolean },
  ): Promise<string> {
    await this.#connection(p, connectionId);
    const externalId = GOOGLE_SYNC_JOB_PREFIX +
      await syncKey(syncKind, descriptor);
    await asOwner(this.hub.db, p, async (tx) => {
      const scope = "arahub:sync:" + p.ownerId + ":" + connectionId;
      await tx`select pg_advisory_xact_lock(hashtextextended(${scope},0))`;
      const active = await tx`select id from public.hub_jobs where owner_id=${p.ownerId}
        and connection_id=${connectionId} and kind=${externalId} and state='running'
        and lease_until>clock_timestamp() limit 1`;
      if (active.length) {
        throw new HubError(
          "sync_busy",
          "Esta sincronização já está em andamento. Retome o lote existente.",
          409,
        );
      }
      // Read and merge under the same transaction/scope lock; never reset a
      // running worker's descriptor or checkpoint using an earlier snapshot.
      const rows = await tx`select state from public.hub_entities where owner_id=${p.ownerId}
        and connection_id=${connectionId} and kind=${GOOGLE_SYNC_STATE_KIND} and external_id=${externalId}`;
      const state = {
        ...(rows[0]?.state ?? {}),
        sync_kind: syncKind,
        descriptor,
        limits: options.limits,
        rebuild_requested: options.rebuild,
        updated_at: nowIso(),
      };
      await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
        values(${p.ownerId},${connectionId},${GOOGLE_SYNC_STATE_KIND},${externalId},${
        "Google sync " + externalId.slice(GOOGLE_SYNC_JOB_PREFIX.length)
      },${tx.json(state)})
        on conflict(owner_id,connection_id,kind,external_id) do update set state=hub_entities.state || excluded.state`;
    });
    return externalId;
  }

  async #connection(p: Principal, connectionId: string): Promise<ConnectionRow> {
    if (typeof connectionId !== "string" || !UUID_RE.test(connectionId)) {
      throw new HubError("invalid_request", "Informe a conexao escolhida.", 400);
    }
    const rows = await asOwner(
      this.hub.db,
      p,
      (tx) =>
        tx`select id,state,desired_scopes,granted_scopes from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId} and provider='google'`,
    );
    if (!rows.length) throw new HubError("not_found", "Conexao nao encontrada.", 404);
    return rows[0] as unknown as ConnectionRow;
  }

  async #readState(
    p: Principal,
    connectionId: string,
    externalId: string,
  ): Promise<{ id: string; state: GoogleSyncState } | null> {
    const rows = await asOwner(
      this.hub.db,
      p,
      (tx) =>
        tx`select id,state from public.hub_entities where owner_id=${p.ownerId} and connection_id=${connectionId} and kind=${GOOGLE_SYNC_STATE_KIND} and external_id=${externalId}`,
    );
    if (!rows.length) return null;
    return { id: rows[0].id as string, state: (rows[0].state ?? {}) as GoogleSyncState };
  }

  async #persistState(
    p: Principal,
    connectionId: string,
    externalId: string,
    state: GoogleSyncState,
  ): Promise<void> {
    await this.#upsertEntity(
      p,
      connectionId,
      GOOGLE_SYNC_STATE_KIND,
      externalId,
      "Google sync " + externalId.slice(GOOGLE_SYNC_JOB_PREFIX.length),
      state as Record<string, unknown>,
    );
  }

  // -- Persistencia (entidades + observacoes) -----------------------------

  /** Upsert com mesclagem (jsonb ||) para nao sobrescrever dimensoes do usuario. */
  async #upsertEntity(
    p: Principal,
    connectionId: string,
    kind: string,
    externalId: string,
    title: string,
    state: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return await asOwner(this.hub.db, p, async (tx) => {
      const parent =
        await tx`select id from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId}`;
      if (!parent.length) throw new HubError("not_found", "Registro nao encontrado.", 404);
      const rows =
        await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${p.ownerId},${connectionId},${kind},${externalId},${title},${
          tx.json(jsonable(state))
        }) on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title,state=hub_entities.state || excluded.state returning id`;
      return { id: rows[0].id as string };
    });
  }

  /** Observacao imutavel, deduplicada por (owner, entity, content_hash). */
  async #observe(
    p: Principal,
    entityId: string,
    content: unknown,
    prov: Record<string, unknown>,
    coverage: Coverage,
    observedAt: string,
  ): Promise<void> {
    const hash = await sha256Hex(JSON.stringify(jsonable(content)));
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${p.ownerId},${entityId},${
        tx.json(jsonable(content))
      },${hash},${
        tx.json(jsonable(prov))
      },${coverage},${observedAt}) on conflict(owner_id,entity_id,content_hash) do nothing`;
    });
  }

  // -- Gmail --------------------------------------------------------------

  async #runGmail(
    p: Principal,
    job: ClaimedJob,
    parsed: { syncKind: GoogleSyncKind; key: string },
  ): Promise<GoogleSyncRun> {
    const connectionId = job.connection_id;
    const observedAt = nowIso();
    const row = await this.#connection(p, connectionId);
    const state = (await this.#readState(p, connectionId, job.kind))?.state ?? {};
    const descriptor = asRecord(state.descriptor);
    const limits = (state.limits ?? undefined) as PaginationLimits | undefined;
    const counts: Record<string, number> = {};
    const gaps: GoogleSyncGap[] = [];
    const coverages: Coverage[] = [];
    const messageLimit = clampInt(descriptor.message_limit, 1, 500, DEFAULT_GMAIL_MESSAGE_LIMIT);
    const bounded = {
      max_pages: clampInt(limits?.maxPages, 1, 200, 25),
      max_items: clampInt(limits?.maxItems, 1, 5000, 1000),
      message_limit: messageLimit,
    };

    if (!hasCapability(row, GOOGLE_READ_CAPABILITIES.gmail_read)) {
      return await this.#finish(
        p,
        job,
        parsed,
        {
          coverage: "denied",
          cursor: asString(state.cursor),
          cursorKind: asString(state.cursor_kind),
          resume: null,
          counts,
          gaps: [{ stage: "gmail", coverage: "denied", error_code: "scope_required" }],
          truncated: false,
          rebuilt: false,
          bounded,
        },
        "initial",
        state,
        observedAt,
      );
    }

    const client = await this.connections.client(p, connectionId);
    let cursor = asString(state.cursor);
    let cursorKind = asString(state.cursor_kind) ?? "history_id";
    let resume = asRecordOrNull(state.resume);
    const rebuildInProgress = resume?.rebuild === true;
    let mode: GoogleSyncMode = (rebuildInProgress || (cursor && state.rebuild_requested === true))
      ? "rebuild"
      : (cursor ? "incremental" : "initial");
    let rebuilt = mode === "rebuild";
    let truncated = false;
    const prevCursor = cursor;

    if (mode === "incremental" && prevCursor) {
      const pendingIds = Array.isArray(resume?.pending_ids)
        ? (resume.pending_ids as unknown[]).map(String).filter(Boolean)
        : [];
      let drained = { remaining: [] as string[], maxHistoryId: null as string | null };
      if (pendingIds.length) {
        drained = await this.#fetchGmailMessages(
          p,
          client,
          connectionId,
          pendingIds,
          messageLimit,
          observedAt,
          counts,
          gaps,
          coverages,
        );
      }
      if (drained.remaining.length > 0) {
        truncated = true;
        gaps.push({ stage: "gmail_messages", coverage: "partial", error_code: "message_limit" });
        resume = {
          pending_ids: drained.remaining,
          start_history_id: prevCursor,
          page_token: asString(resume?.page_token) ?? null,
          history_complete: resume?.history_complete === true,
          next_history_id: asString(resume?.next_history_id) ?? null,
        };
        coverages.push("partial");
      } else if (resume?.history_complete === true) {
        cursor = asString(resume?.next_history_id) ?? prevCursor;
        cursorKind = "history_id";
        resume = null;
      } else {
        const history = await client.listGmailHistory({
          startHistoryId: prevCursor,
          pageToken: asString(resume?.page_token) ?? undefined,
          limits,
        });
        if (history.coverage === "expired") {
          gaps.push({ stage: "gmail_history", coverage: "expired", error_code: "history_expired" });
          mode = "rebuild";
          rebuilt = true;
          resume = null;
        } else {
          coverages.push(history.coverage);
          const added: string[] = [];
          for (const entry of history.items) {
            const record = entry as JsonObject;
            const historyId = record.id !== undefined ? String(record.id) : null;
            const locator = "google:gmail/history/" + (historyId ?? "unknown");
            const entity = await this.#upsertEntity(
              p,
              connectionId,
              "gmail_history",
              historyId ?? locator,
              "Historico Gmail " + (historyId ?? "sem id"),
              { history_id: historyId, provider_record: record },
            );
            await this.#observe(
              p,
              entity.id,
              record,
              provenance(connectionId, locator, observedAt, {
                external_id: historyId,
                capability: "gmail_read",
              }),
              history.coverage,
              observedAt,
            );
            counts.gmail_history = (counts.gmail_history ?? 0) + 1;
            added.push(...historyMessageIds(record));
          }
          const fetched = await this.#fetchGmailMessages(
            p,
            client,
            connectionId,
            added,
            messageLimit,
            observedAt,
            counts,
            gaps,
            coverages,
          );
          if (history.coverage === "complete" && fetched.remaining.length === 0) {
            cursor = history.nextCursor ?? prevCursor;
            cursorKind = "history_id";
            resume = null;
          } else {
            truncated = fetched.remaining.length > 0;
            if (truncated) {
              gaps.push({
                stage: "gmail_messages",
                coverage: "partial",
                error_code: "message_limit",
              });
            }
            const listingComplete = history.coverage === "complete";
            resume = {
              pending_ids: fetched.remaining,
              start_history_id: prevCursor,
              page_token: listingComplete
                ? null
                : (history.resumeCursor ?? asString(resume?.page_token) ?? null),
              history_complete: listingComplete,
              next_history_id: listingComplete ? (history.nextCursor ?? null) : null,
            };
            coverages.push("partial");
          }
        }
      }
    }

    if (mode !== "incremental") {
      const rebuildWindow = mode === "rebuild"
        ? clampInt(descriptor.rebuild_window_days, 1, 3650, DEFAULT_GMAIL_REBUILD_WINDOW_DAYS)
        : null;
      const query = composeGmailQuery(asString(descriptor.query), rebuildWindow);
      const labelIds = Array.isArray(descriptor.label_ids)
        ? (descriptor.label_ids as unknown[]).map(String).filter(Boolean)
        : [];
      let listResume: string | undefined = asString(resume?.page_token) ?? undefined;
      let maxHistoryId: string | null = asString(resume?.next_history_id);
      let remaining: string[] = [];
      let listingDone = resume?.listing_complete === true;
      const pendingIds = Array.isArray(resume?.pending_ids)
        ? (resume.pending_ids as unknown[]).map(String).filter(Boolean)
        : [];
      if (pendingIds.length) {
        const fetched = await this.#fetchGmailMessages(
          p,
          client,
          connectionId,
          pendingIds,
          messageLimit,
          observedAt,
          counts,
          gaps,
          coverages,
        );
        remaining = fetched.remaining;
        maxHistoryId = maxDecimalId(maxHistoryId, fetched.maxHistoryId);
      }
      if (remaining.length === 0 && !listingDone) {
        const page: BoundedPage<JsonObject> = await client.listGmailMessages({
          query,
          labelIds: labelIds.length ? labelIds : undefined,
          limits,
          pageToken: listResume,
        });
        coverages.push(page.coverage);
        listingDone = page.coverage === "complete";
        listResume = page.resumeCursor;
        counts.gmail_listed = (counts.gmail_listed ?? 0) + page.items.length;
        const ids = page.items
          .map((item) => asString((item as JsonObject).id))
          .filter((id): id is string => id !== null);
        const fetched = await this.#fetchGmailMessages(
          p,
          client,
          connectionId,
          ids,
          messageLimit,
          observedAt,
          counts,
          gaps,
          coverages,
        );
        remaining = fetched.remaining;
        maxHistoryId = maxDecimalId(maxHistoryId, fetched.maxHistoryId);
      }
      const complete = listingDone && remaining.length === 0;
      if (complete) {
        cursor = maxHistoryId ?? cursor;
        cursorKind = "history_id";
        resume = null;
      } else {
        truncated = truncated || remaining.length > 0;
        if (remaining.length > 0) {
          gaps.push({ stage: "gmail_messages", coverage: "partial", error_code: "message_limit" });
        }
        resume = {
          pending_ids: remaining,
          page_token: listResume ?? null,
          listing_complete: listingDone,
          next_history_id: maxHistoryId,
          rebuild: mode === "rebuild",
        };
        coverages.push("partial");
      }
    }

    const coverage = worstCoverage(coverages);
    return await this.#finish(
      p,
      job,
      parsed,
      {
        coverage,
        cursor,
        cursorKind,
        resume,
        counts,
        gaps,
        truncated,
        rebuilt,
        bounded,
      },
      mode,
      state,
      observedAt,
    );
  }

  async #fetchGmailMessages(
    p: Principal,
    client: GoogleReadClient,
    connectionId: string,
    ids: readonly string[],
    limit: number,
    observedAt: string,
    counts: Record<string, number>,
    gaps: GoogleSyncGap[],
    coverages: Coverage[],
  ): Promise<{ remaining: string[]; maxHistoryId: string | null }> {
    const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
    const toFetch = unique.slice(0, limit);
    const deferred = unique.slice(limit);
    const retry: string[] = [];
    let maxHistoryId: string | null = null;
    for (const id of toFetch) {
      try {
        const message = await client.getGmailMessage({ messageId: id, format: "full" });
        const entity = await this.#upsertEntity(
          p,
          connectionId,
          "gmail_message",
          id,
          gmailSubject(message),
          {
            message_id: id,
            thread_id: message.threadId ?? null,
            history_id: message.historyId ?? null,
            snippet: typeof message.snippet === "string" ? message.snippet : null,
            provider_record: message,
          },
        );
        await this.#observe(
          p,
          entity.id,
          message,
          provenance(connectionId, "google:gmail/message/" + id, observedAt, {
            external_id: id,
            capability: "gmail_read",
          }),
          "complete",
          observedAt,
        );
        counts.gmail_messages = (counts.gmail_messages ?? 0) + 1;
        maxHistoryId = maxDecimalId(maxHistoryId, decimalId(message.historyId));
      } catch (error) {
        const cov = errorCoverage(error);
        gaps.push({
          stage: "gmail_message",
          coverage: cov,
          error_code: errorCode(error),
        });
        coverages.push(cov);
        if (error instanceof GoogleApiError && error.retryable) retry.push(id);
      }
    }
    return { remaining: [...retry, ...deferred], maxHistoryId };
  }

  // -- Calendar -----------------------------------------------------------

  async #runCalendar(
    p: Principal,
    job: ClaimedJob,
    parsed: { syncKind: GoogleSyncKind; key: string },
  ): Promise<GoogleSyncRun> {
    const connectionId = job.connection_id;
    const observedAt = nowIso();
    const row = await this.#connection(p, connectionId);
    const state = (await this.#readState(p, connectionId, job.kind))?.state ?? {};
    const descriptor = asRecord(state.descriptor);
    const limits = (state.limits ?? undefined) as PaginationLimits | undefined;
    const counts: Record<string, number> = {};
    const gaps: GoogleSyncGap[] = [];
    const coverages: Coverage[] = [];
    const bounded = {
      max_pages: clampInt(limits?.maxPages, 1, 200, 25),
      max_items: clampInt(limits?.maxItems, 1, 5000, 1000),
      window_past_days: DEFAULT_CALENDAR_WINDOW_PAST_DAYS,
      window_future_days: DEFAULT_CALENDAR_WINDOW_FUTURE_DAYS,
    };

    if (!hasCapability(row, GOOGLE_READ_CAPABILITIES.calendar_read)) {
      return await this.#finish(
        p,
        job,
        parsed,
        {
          coverage: "denied",
          cursor: asString(state.cursor),
          cursorKind: asString(state.cursor_kind),
          resume: null,
          counts,
          gaps: [{ stage: "calendar", coverage: "denied", error_code: "scope_required" }],
          truncated: false,
          rebuilt: false,
          bounded,
        },
        "initial",
        state,
        observedAt,
      );
    }

    const client = await this.connections.client(p, connectionId);
    const calendarId = asString(descriptor.calendar_id) ?? "primary";
    let cursor = asString(state.cursor);
    let cursorKind = asString(state.cursor_kind) ?? "sync_token";
    let resume = asRecordOrNull(state.resume);
    let mode: GoogleSyncMode = (resume?.rebuild === true ||
        (cursor && state.rebuild_requested === true))
      ? "rebuild"
      : (cursor ? "incremental" : "initial");
    let rebuilt = mode === "rebuild";
    let truncated = false;

    if (mode === "incremental" && cursor) {
      const page = await client.listCalendarEvents({
        calendarId,
        syncToken: cursor,
        pageToken: asString(resume?.page_token) ?? undefined,
        limits,
      });
      if (page.coverage === "expired") {
        gaps.push({
          stage: "calendar_events",
          coverage: "expired",
          error_code: "full_sync_required",
        });
        mode = "rebuild";
        rebuilt = true;
        resume = null;
      } else {
        coverages.push(page.coverage);
        await this.#persistCalendarEvents(
          p,
          connectionId,
          calendarId,
          page.items,
          observedAt,
          counts,
          page.coverage,
        );
        if (page.coverage === "complete") {
          cursor = page.nextCursor ?? cursor;
          cursorKind = "sync_token";
          resume = null;
        } else {
          resume = {
            sync_token_restart: cursor,
            page_token: page.resumeCursor ?? asString(resume?.page_token) ?? null,
          };
          coverages.push("partial");
        }
      }
    }

    if (mode !== "incremental") {
      const timeMin = asString(resume?.time_min) ?? asString(descriptor.time_min) ??
        isoOffsetDays(-DEFAULT_CALENDAR_WINDOW_PAST_DAYS);
      const timeMax = asString(resume?.time_max) ?? asString(descriptor.time_max) ??
        isoOffsetDays(DEFAULT_CALENDAR_WINDOW_FUTURE_DAYS);
      const page = await client.listCalendarEvents({
        calendarId,
        timeMin,
        timeMax,
        showDeleted: true,
        pageToken: asString(resume?.page_token) ?? undefined,
        limits,
      });
      coverages.push(page.coverage);
      await this.#persistCalendarEvents(
        p,
        connectionId,
        calendarId,
        page.items,
        observedAt,
        counts,
        page.coverage,
      );
      if (page.coverage === "complete") {
        cursor = page.nextCursor ?? cursor;
        cursorKind = "sync_token";
        resume = null;
      } else {
        truncated = true;
        resume = {
          full: true,
          time_min: timeMin,
          time_max: timeMax,
          page_token: page.resumeCursor ?? null,
          rebuild: mode === "rebuild",
        };
        coverages.push("partial");
      }
    }

    const coverage = worstCoverage(coverages);
    return await this.#finish(
      p,
      job,
      parsed,
      {
        coverage,
        cursor,
        cursorKind,
        resume,
        counts,
        gaps,
        truncated,
        rebuilt,
        bounded,
      },
      mode,
      state,
      observedAt,
    );
  }

  async #persistCalendarEvents(
    p: Principal,
    connectionId: string,
    calendarId: string,
    items: readonly JsonObject[],
    observedAt: string,
    counts: Record<string, number>,
    coverage: Coverage,
  ): Promise<void> {
    for (const raw of items) {
      const event = raw as JsonObject;
      const eventId = asString(event.id);
      if (!eventId) continue;
      const start = asRecord(event.start);
      const allDay = typeof start.date === "string" && start.dateTime === undefined;
      const summary = typeof event.summary === "string" ? event.summary.trim() : "";
      const entity = await this.#upsertEntity(
        p,
        connectionId,
        "calendar_event",
        calendarId + "/" + eventId,
        summary ? summary.slice(0, 300) : "Evento " + eventId,
        {
          calendar_id: calendarId,
          event_id: eventId,
          status: event.status ?? null,
          all_day: allDay,
          recurring: Array.isArray(event.recurrence),
          recurrence: event.recurrence ?? null,
          recurring_event_id: event.recurringEventId ?? null,
          original_start_time: event.originalStartTime ?? null,
          start: event.start ?? null,
          end: event.end ?? null,
          updated: event.updated ?? null,
          etag: event.etag ?? null,
          provider_record: event,
        },
      );
      await this.#observe(
        p,
        entity.id,
        event,
        provenance(
          connectionId,
          "google:calendar/" + encodeURIComponent(calendarId) + "/event/" + eventId,
          observedAt,
          { external_id: eventId, calendar_id: calendarId, capability: "calendar_read" },
        ),
        coverage,
        observedAt,
      );
      counts.calendar_events = (counts.calendar_events ?? 0) + 1;
      if (event.status === "cancelled") {
        counts.calendar_cancelled = (counts.calendar_cancelled ?? 0) + 1;
      }
    }
  }

  // -- Drive --------------------------------------------------------------

  async #runDrive(
    p: Principal,
    job: ClaimedJob,
    parsed: { syncKind: GoogleSyncKind; key: string },
  ): Promise<GoogleSyncRun> {
    const connectionId = job.connection_id;
    const observedAt = nowIso();
    const row = await this.#connection(p, connectionId);
    const state = (await this.#readState(p, connectionId, job.kind))?.state ?? {};
    const descriptor = asRecord(state.descriptor);
    const limits = (state.limits ?? undefined) as PaginationLimits | undefined;
    const counts: Record<string, number> = {};
    const gaps: GoogleSyncGap[] = [];
    const coverages: Coverage[] = [];
    const bounded = {
      max_pages: clampInt(limits?.maxPages, 1, 200, 25),
      max_items: clampInt(limits?.maxItems, 1, 5000, 1000),
    };
    const canIncremental = hasCapability(row, GOOGLE_READ_CAPABILITIES.drive_read);
    const canSelect = canIncremental ||
      hasCapability(row, GOOGLE_READ_CAPABILITIES.selected_files);

    if (!canSelect) {
      return await this.#finish(
        p,
        job,
        parsed,
        {
          coverage: "denied",
          cursor: asString(state.cursor),
          cursorKind: asString(state.cursor_kind),
          resume: null,
          counts,
          gaps: [{ stage: "drive", coverage: "denied", error_code: "scope_required" }],
          truncated: false,
          rebuilt: false,
          bounded,
        },
        "initial",
        state,
        observedAt,
      );
    }

    const client = await this.connections.client(p, connectionId);
    const driveId = asString(descriptor.drive_id) ?? undefined;
    const selectionQuery = asString(descriptor.selection_query) ?? undefined;
    let cursor = canIncremental ? asString(state.cursor) : null;
    let cursorKind = asString(state.cursor_kind) ?? "start_page_token";
    let resume = asRecordOrNull(state.resume);
    let mode: GoogleSyncMode = cursor && canIncremental && state.rebuild_requested !== true
      ? "incremental"
      : "initial";
    let rebuilt = false;
    let truncated = false;

    if (mode === "incremental" && cursor) {
      const page = await client.listDriveChanges({ pageToken: cursor, limits });
      if (page.coverage === "expired") {
        gaps.push({
          stage: "drive_changes",
          coverage: "expired",
          error_code: "sync_token_expired",
        });
        mode = "rebuild";
        rebuilt = true;
      } else {
        coverages.push(page.coverage);
        await this.#persistDriveChanges(p, connectionId, page.items, observedAt, counts);
        if (page.coverage === "complete") {
          cursor = page.nextCursor ?? cursor;
          cursorKind = "start_page_token";
          resume = null;
        } else {
          resume = { page_token: page.resumeCursor };
          coverages.push("partial");
        }
      }
    }

    if (mode !== "incremental") {
      const pendingStart = asString(resume?.pending_start_token);
      let startToken = pendingStart;
      if (canIncremental && !startToken) {
        startToken = await client.getDriveStartPageToken(driveId ? { driveId } : {});
      }
      const page = await client.listDriveFiles({
        query: selectionQuery,
        limits,
        fields:
          "nextPageToken,files(id,name,mimeType,modifiedTime,version,webViewLink,capabilities,permissions)",
      });
      coverages.push(page.coverage);
      await this.#persistDriveFiles(p, connectionId, page.items, observedAt, counts, page.coverage);
      if (page.coverage === "complete") {
        cursor = canIncremental && startToken ? startToken : null;
        cursorKind = "start_page_token";
        resume = null;
      } else {
        truncated = true;
        resume = { page_token: page.resumeCursor ?? null, pending_start_token: startToken ?? null };
        coverages.push("partial");
      }
    }

    const coverage = worstCoverage(coverages);
    return await this.#finish(
      p,
      job,
      parsed,
      {
        coverage,
        cursor,
        cursorKind: cursor ? cursorKind : null,
        resume,
        counts,
        gaps,
        truncated,
        rebuilt,
        bounded,
      },
      mode,
      state,
      observedAt,
    );
  }

  async #persistDriveChanges(
    p: Principal,
    connectionId: string,
    items: readonly JsonObject[],
    observedAt: string,
    counts: Record<string, number>,
  ): Promise<void> {
    for (const raw of items) {
      const change = raw as JsonObject;
      const file = asRecordOrNull(change.file);
      const fileId = asString(change.fileId) ?? (file ? asString(file.id) : null);
      const changeId = asString(change.id) ??
        (fileId !== null ? fileId + "@" + String(change.time ?? "") : null);
      if (!changeId) continue;
      const removed = change.removed === true;
      const name = file ? asString(file.name) : null;
      const entity = await this.#upsertEntity(
        p,
        connectionId,
        "drive_change",
        changeId,
        removed ? "Remocao no Drive" : (name ?? "Mudanca no Drive"),
        {
          change_id: changeId,
          file_id: fileId,
          removed,
          change_type: change.changeType ?? null,
          time: change.time ?? null,
          provider_record: change,
        },
      );
      await this.#observe(
        p,
        entity.id,
        change,
        provenance(connectionId, "google:drive/change/" + changeId, observedAt, {
          external_id: changeId,
          file_id: fileId,
          capability: "drive_read",
        }),
        "complete",
        observedAt,
      );
      counts.drive_changes = (counts.drive_changes ?? 0) + 1;
      if (removed) counts.drive_removed = (counts.drive_removed ?? 0) + 1;
      if (file && fileId && !removed) {
        const fileEntity = await this.#upsertEntity(
          p,
          connectionId,
          "drive_file",
          fileId,
          name ?? "Arquivo Drive",
          { file_id: fileId, provider_record: file },
        );
        await this.#observe(
          p,
          fileEntity.id,
          file,
          provenance(connectionId, "google:drive/file/" + fileId, observedAt, {
            external_id: fileId,
            capability: "drive_read",
          }),
          "complete",
          observedAt,
        );
        counts.drive_files = (counts.drive_files ?? 0) + 1;
      }
    }
  }

  async #persistDriveFiles(
    p: Principal,
    connectionId: string,
    items: readonly JsonObject[],
    observedAt: string,
    counts: Record<string, number>,
    coverage: Coverage,
  ): Promise<void> {
    for (const raw of items) {
      const file = raw as JsonObject;
      const fileId = asString(file.id);
      if (!fileId) continue;
      const name = asString(file.name);
      const entity = await this.#upsertEntity(
        p,
        connectionId,
        "drive_file",
        fileId,
        name ?? "Arquivo Drive",
        {
          file_id: fileId,
          mime_type: file.mimeType ?? null,
          modified_time: file.modifiedTime ?? null,
          version: file.version ?? null,
          web_view_link: file.webViewLink ?? null,
          provider_record: file,
        },
      );
      await this.#observe(
        p,
        entity.id,
        file,
        provenance(connectionId, "google:drive/file/" + fileId, observedAt, {
          external_id: fileId,
          capability: "drive_read",
        }),
        coverage,
        observedAt,
      );
      counts.drive_files = (counts.drive_files ?? 0) + 1;
    }
  }

  // -- Fechamento ---------------------------------------------------------

  async #finish(
    p: Principal,
    job: ClaimedJob,
    parsed: { syncKind: GoogleSyncKind; key: string },
    outcome: SyncOutcome,
    mode: GoogleSyncMode,
    state: GoogleSyncState,
    observedAt: string,
  ): Promise<GoogleSyncRun> {
    const finishedAt = nowIso();
    const cursorValue = outcome.cursorKind
      ? { kind: outcome.cursorKind, value: outcome.cursor }
      : null;
    const jobCursor = outcome.coverage === "complete" && outcome.cursor !== null
      ? cursorValue
      : null;
    const details: Record<string, unknown> = {
      counts: outcome.counts,
      gaps: outcome.gaps,
      resume: outcome.resume,
      rebuilt: outcome.rebuilt,
      truncated: outcome.truncated,
      mode,
      bounded: outcome.bounded,
      next_checkpoint: {
        cursor_advanced: outcome.coverage === "complete",
        resume: outcome.resume,
      },
    };
    await this.#persistState(p, job.connection_id, job.kind, {
      ...state,
      sync_kind: parsed.syncKind,
      cursor: outcome.cursor,
      cursor_kind: outcome.cursorKind,
      resume: outcome.resume,
      coverage: outcome.coverage,
      mode,
      rebuilt: outcome.rebuilt,
      rebuild_requested: false,
      updated_at: finishedAt,
      counts: outcome.counts,
      truncated: outcome.truncated,
    });
    const jobRow = await this.jobs.finish(
      p,
      job.id,
      job.attempts,
      outcome.coverage,
      jobCursor,
      details,
    ) as Record<string, unknown>;
    const summary: GoogleSyncSummary = {
      sync_kind: parsed.syncKind,
      key: job.kind,
      mode,
      coverage: outcome.coverage,
      cursor: outcome.cursor,
      cursor_kind: outcome.cursorKind,
      resume: outcome.resume,
      counts: outcome.counts,
      gaps: outcome.gaps,
      rebuilt: outcome.rebuilt,
      truncated: outcome.truncated,
      observed_at: observedAt,
      bounded: outcome.bounded,
    };
    return { job: jobRow, directed: true, summary };
  }

  async #finishError(
    p: Principal,
    job: ClaimedJob,
    parsed: { syncKind: GoogleSyncKind; key: string },
    error: unknown,
  ): Promise<GoogleSyncRun> {
    const observedAt = nowIso();
    const state = (await this.#readState(p, job.connection_id, job.kind))?.state ?? {};
    const coverage = errorCoverage(error);
    return await this.#finish(
      p,
      job,
      parsed,
      {
        coverage,
        cursor: asString(state.cursor),
        cursorKind: asString(state.cursor_kind),
        resume: asRecordOrNull(state.resume),
        counts: {},
        gaps: [{ stage: parsed.syncKind, coverage, error_code: errorCode(error) }],
        truncated: false,
        rebuilt: false,
        bounded: {},
      },
      "initial",
      state,
      observedAt,
    );
  }
}
