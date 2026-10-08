/** Finite, opt-in follow-up. No scheduler, endpoint, credentials or global defaults. */
import { z } from "zod";
import type postgres from "postgres";
import { asOwner, type Db } from "./db.ts";
import { HubError, type Principal } from "./contracts.ts";
import type { JobClaimGate } from "./jobs.ts";
import type { SyncOptions } from "./sync.ts";
import { type FetchLike, type MoodleDeps, MoodleError } from "./adapters/moodle.ts";

export const FOLLOWUP_KIND = "followup_policy";
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const budget = z.object({ calls: amount, response_bytes: amount, wall_ms: amount }).strict();
export type FollowupBudget = z.infer<typeof budget>;
const keys = ["calls", "response_bytes", "wall_ms"] as const;
const zero = (): FollowupBudget => ({ calls: 0, response_bytes: 0, wall_ms: 0 });
export const followupInput = z.object({
  connection_id: z.string().uuid(),
  origin: z.string().url().max(500),
  course_id: z.number().int().positive(),
  expires_at: z.number().int().positive(),
  interval_ms: z.number().int().min(100).max(7 * 86400000),
  backoff_ms: z.number().int().min(100).max(86400000),
  max_failures: z.number().int().min(1).max(5),
  forum_calls: z.number().int().min(2).max(40),
  per_run: budget,
  total: budget,
  window_ms: z.number().int().min(1000).max(7 * 86400000),
  window: budget,
}).strict().superRefine((value, ctx) => {
  if (
    value.per_run.calls < 1 || value.per_run.calls > 1000 ||
    value.per_run.response_bytes < 1 || value.per_run.response_bytes > 64 * 1024 * 1024 ||
    value.per_run.wall_ms < 100 || value.per_run.wall_ms > 120000 ||
    keys.some((k) => value.per_run[k] > value.total[k] || value.per_run[k] > value.window[k])
  ) {
    ctx.addIssue({ code: "custom", message: "Invalid bounded policy budgets" });
  }
});
export type FollowupInput = z.infer<typeof followupInput>;
interface Run {
  id: string;
  job_id: string;
  attempt: number;
  started_at: number;
  deadline: number;
  calls: number;
  response_bytes: number;
  outcome?: string;
  finished_at?: number;
}
export interface FollowupState {
  version: 1;
  revision: number;
  owner_id: string;
  config: FollowupInput;
  paused: boolean;
  pause_reason: string | null;
  next_at: number;
  failures: number;
  job_id: string | null;
  reserved: FollowupBudget;
  window_started_at: number;
  window_reserved: FollowupBudget;
  active: Run | null;
  recent: Run[];
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
function fail(code: string): never {
  throw new HubError(code, "Política indisponível para esta execução.", 409);
}
async function now(tx: postgres.TransactionSql): Promise<number> {
  const [r] = await tx`select floor(extract(epoch from clock_timestamp())*1000)::float8 as ms`;
  return Number(r.ms);
}
async function lockConnection(tx: postgres.TransactionSql, p: Principal, connection: string) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${
    "arahub:sync:" + p.ownerId + ":" + connection
  },0))`;
}
function fits(used: FollowupBudget, limit: FollowupBudget, run: FollowupBudget) {
  return keys.every((k) => used[k] <= limit[k] - run[k]);
}
function charge(used: FollowupBudget, run: FollowupBudget) {
  for (const k of keys) used[k] += run[k];
}

export class FollowupPolicies {
  constructor(readonly db: Db) {}

  private async load(tx: postgres.TransactionSql, p: Principal, id: string, locked = true) {
    const rows = locked
      ? await tx`select state from public.hub_entities where owner_id=${p.ownerId} and id=${id} and kind=${FOLLOWUP_KIND} for update`
      : await tx`select state from public.hub_entities where owner_id=${p.ownerId} and id=${id} and kind=${FOLLOWUP_KIND}`;
    if (!rows.length) fail("not_found");
    const s = rows[0].state as FollowupState;
    if (s.version !== 1 || s.owner_id !== p.ownerId || !followupInput.safeParse(s.config).success) {
      fail("policy_invalid");
    }
    return s;
  }
  private async save(tx: postgres.TransactionSql, p: Principal, id: string, s: FollowupState) {
    await tx`update public.hub_entities set state=${
      tx.json(json(s))
    } where owner_id=${p.ownerId} and id=${id} and kind=${FOLLOWUP_KIND}`;
  }
  get(p: Principal, id: string) {
    return asOwner(this.db, p, (tx) => this.load(tx, p, id, false));
  }
  create(p: Principal, input: FollowupInput): Promise<string> {
    const c = followupInput.parse(input);
    return asOwner(this.db, p, async (tx) => {
      await lockConnection(tx, p, c.connection_id);
      const t = await now(tx);
      if (c.expires_at <= t || c.expires_at > t + 7 * 86400000) fail("policy_expiry");
      const [parent] =
        await tx`select origin from public.hub_connections where owner_id=${p.ownerId} and id=${c.connection_id} and provider='moodle' and state='connected'`;
      if (!parent || parent.origin !== c.origin) fail("policy_origin");
      const s: FollowupState = {
        version: 1,
        revision: 1,
        owner_id: p.ownerId,
        config: c,
        paused: false,
        pause_reason: null,
        next_at: t,
        failures: 0,
        job_id: null,
        reserved: zero(),
        window_started_at: t,
        window_reserved: zero(),
        active: null,
        recent: [],
      };
      // Unique owner/connection/course: rerunning create cannot silently reset balances.
      const rows =
        await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
        values(${p.ownerId},${c.connection_id},${FOLLOWUP_KIND},${
          "course/" + c.course_id
        },'Política de acompanhamento',${tx.json(json(s))})
        on conflict(owner_id,connection_id,kind,external_id) do nothing returning id`;
      if (!rows.length) fail("policy_exists");
      return String(rows[0].id);
    });
  }

  /** No refunds, including uncertain replies and process death. Counters are reserved ceilings. */
  private async end(
    tx: postgres.TransactionSql,
    p: Principal,
    s: FollowupState,
    t: number,
    outcome: string,
  ) {
    if (!s.active) return;
    const r = s.active;
    // Jobs.finish may have committed before the worker lost its reply/process.
    // Lock the exact attempt through reconciliation and fencing: a concurrent
    // finish either commits first and wins, or is fenced as still running.
    const [job] = await tx`select state from public.hub_jobs where owner_id=${p.ownerId}
      and id=${r.job_id} and attempts=${r.attempt} for update`;
    if (job?.state === "complete") outcome = "complete";
    // Fence delayed writes before another process can claim the same job.
    await tx`update public.hub_jobs set state=case when attempts>=5 then 'failed' else 'partial' end,
      lease_until=null,updated_at=clock_timestamp() where owner_id=${p.ownerId} and id=${r.job_id}
      and attempts=${r.attempt} and state='running'`;
    s.recent = [...s.recent, { ...r, outcome, finished_at: t }].slice(-10);
    s.active = null;
    s.failures = outcome === "complete" || outcome === "progress" ? 0 : s.failures + 1;
    s.next_at = t +
      (outcome === "complete"
        ? s.config.interval_ms
        : outcome === "progress"
        ? s.config.backoff_ms
        : Math.min(86400000, s.config.backoff_ms * 2 ** Math.min(s.failures - 1, 5)));
    if (outcome === "expired" || s.failures >= s.config.max_failures) {
      s.paused = true;
      s.pause_reason = outcome === "expired" ? "credential_expired" : "failure_limit";
    }
  }

  /** Reconcile a dead attempt, then reuse its durable job; never recreate a failed job. */
  async prepare(p: Principal, id: string): Promise<string | null> {
    const initial = await this.get(p, id);
    return asOwner(this.db, p, async (tx) => {
      await lockConnection(tx, p, initial.config.connection_id);
      const s = await this.load(tx, p, id);
      const t = await now(tx);
      if (s.active && s.active.deadline <= t) await this.end(tx, p, s, t, "abandoned");
      if (s.config.expires_at <= t) {
        s.paused = true;
        s.pause_reason = "policy_expired";
      }
      if (s.paused || s.active || s.next_at > t) {
        await this.save(tx, p, id, s);
        return null;
      }
      if (s.job_id) {
        const [job] =
          await tx`select state,attempts from public.hub_jobs where owner_id=${p.ownerId} and id=${s.job_id}`;
        if (
          !job || job.state === "failed" || job.state === "expired" ||
          job.attempts >= 5 && job.state !== "complete"
        ) {
          s.paused = true;
          s.pause_reason = "job_terminal";
          await this.save(tx, p, id, s);
          return null;
        }
        if (job.state === "complete") s.job_id = null;
      }
      if (!s.job_id) {
        const [job] = await tx`insert into public.hub_jobs(owner_id,connection_id,kind,coverage)
          values(${p.ownerId},${s.config.connection_id},${"moodle_course:" + s.config.course_id},
          ${tx.json({ followup_policy_id: id })}) returning id`;
        s.job_id = String(job.id);
      }
      await this.save(tx, p, id, s);
      return s.job_id;
    });
  }

  async pause(p: Principal, id: string, paused: boolean, revision: number) {
    const initial = await this.get(p, id);
    return asOwner(this.db, p, async (tx) => {
      await lockConnection(tx, p, initial.config.connection_id);
      const s = await this.load(tx, p, id), t = await now(tx);
      if (s.revision !== revision) fail("version_conflict");
      if (s.active) {
        if (!paused) fail("policy_busy");
        await this.end(tx, p, s, t, "paused");
      }
      if (!paused && s.config.expires_at <= t) fail("policy_expiry");
      s.paused = paused;
      s.pause_reason = paused ? "manual" : null;
      s.revision++;
      // Resumption retains balances, failure count, next_at, job and attempts.
      await this.save(tx, p, id, s);
      return s;
    });
  }

  /** Reservation and Jobs.claim commit together, before any source request. */
  execution(
    p: Principal,
    id: string,
    origin: string,
    transport?: FetchLike,
    runId: string = crypto.randomUUID(),
    expectedInput?: FollowupInput,
  ): FollowupExecution {
    z.string().uuid().parse(runId);
    const binding = expectedInput ? JSON.stringify(followupInput.parse(expectedInput)) : null;
    let active: Run | null = null;
    let limits: FollowupBudget | null = null;
    const claim: JobClaimGate = {
      policyId: id,
      reserve: async (tx, job) => {
        const s = await this.load(tx, p, id), t = await now(tx), c = s.config;
        if (binding && JSON.stringify(followupInput.parse(c)) !== binding) fail("policy_binding");
        const [parent] =
          await tx`select origin,state from public.hub_connections where owner_id=${p.ownerId} and id=${c.connection_id}`;
        if (
          !parent || parent.origin !== c.origin || parent.state !== "connected" ||
          c.origin !== origin ||
          job.connection_id !== c.connection_id || job.kind !== "moodle_course:" + c.course_id ||
          s.job_id !== job.id
        ) fail("policy_binding");
        if (active || s.active || s.paused || s.next_at > t || c.expires_at <= t) return false;
        if (t >= s.window_started_at + c.window_ms) {
          s.window_started_at = t;
          s.window_reserved = zero();
        }
        if (
          !fits(s.reserved, c.total, c.per_run) || !fits(s.window_reserved, c.window, c.per_run) ||
          t + c.per_run.wall_ms > c.expires_at
        ) {
          await this.save(tx, p, id, s);
          return false;
        }
        charge(s.reserved, c.per_run);
        charge(s.window_reserved, c.per_run);
        active = {
          id: runId,
          job_id: job.id,
          attempt: job.attempts + 1,
          started_at: t,
          deadline: t + c.per_run.wall_ms,
          calls: 0,
          response_bytes: 0,
        };
        limits = c.per_run;
        s.active = active;
        await this.save(tx, p, id, s);
        return true;
      },
    };
    const dispatch = async () => {
      if (!active || !limits) fail("policy_unclaimed");
      const run = active, cap = limits;
      await asOwner(this.db, p, async (tx) => {
        const s = await this.load(tx, p, id), t = await now(tx);
        if (
          s.paused || s.active?.id !== run.id || t >= run.deadline ||
          s.active.calls >= cap.calls || s.active.response_bytes >= cap.response_bytes
        ) {
          fail("followup_budget");
        }
        const [job] =
          await tx`select id from public.hub_jobs where owner_id=${p.ownerId} and id=${run.job_id}
          and state='running' and attempts=${run.attempt} and lease_until>clock_timestamp()`;
        if (!job) fail("job_conflict");
        s.active.calls++;
        run.calls = s.active.calls;
        await this.save(tx, p, id, s);
      });
    };
    const bytes = async (count: number) => {
      const run = active!;
      await asOwner(this.db, p, async (tx) => {
        const s = await this.load(tx, p, id);
        if (s.active?.id !== run.id || s.paused) fail("job_conflict");
        s.active.response_bytes = count;
        run.response_bytes = count;
        await this.save(tx, p, id, s);
      });
    };
    const finish = async (outcome: string) => {
      if (!active) return;
      const run = active;
      await asOwner(this.db, p, async (tx) => {
        // Same lock order as administrative pause/recovery.
        const initial = await this.load(tx, p, id, false);
        await lockConnection(tx, p, initial.config.connection_id);
        const s = await this.load(tx, p, id);
        if (s.active?.id !== run.id) return;
        await this.end(tx, p, s, await now(tx), outcome);
        await this.save(tx, p, id, s);
      });
    };
    return new FollowupExecution(
      claim,
      () => ({ active, limits }),
      dispatch,
      bytes,
      finish,
      origin,
      transport,
    );
  }

  /** Parent watchdog: fence only its own child attempt, never a replacement. */
  async interrupt(p: Principal, id: string, runId: string) {
    const initial = await this.get(p, id);
    return asOwner(this.db, p, async (tx) => {
      await lockConnection(tx, p, initial.config.connection_id);
      const s = await this.load(tx, p, id);
      if (s.active?.id !== runId) return false;
      await this.end(tx, p, s, await now(tx), "wall_timeout");
      await this.save(tx, p, id, s);
      return true;
    });
  }
}

/** Guarded local transport. Byte limit means decoded response bytes admitted, not wire/IP bytes. */
export class FollowupExecution {
  #bytes = 0;
  #calls = 0;
  #busy = false;
  #stopped = false;
  constructor(
    readonly claim: JobClaimGate,
    private snapshot: () => { active: Run | null; limits: FollowupBudget | null },
    private dispatch: () => Promise<void>,
    private saveBytes: (count: number) => Promise<void>,
    readonly finish: (outcome: string) => Promise<void>,
    private origin: string,
    private transport?: FetchLike,
  ) {}
  get run() {
    return this.snapshot().active;
  }
  get options(): NonNullable<SyncOptions["execution"]> {
    return {
      claim: this.claim,
      moodleDeps: (metrics) => ({
        ...(this.transport
          ? {
            fetch: (input: string | URL | Request, init?: RequestInit) =>
              this.fetch(input, init, () => metrics.recordCall()),
          }
          : {
            requestBudget: this.requestBudget,
            onRequest: () => metrics.recordCall(),
          }),
      }),
    };
  }
  /** Never injects fetch: DNS validation, address pinning and TLS stay mandatory. */
  get requestBudget(): NonNullable<MoodleDeps["requestBudget"]> {
    return {
      begin: async ({ url, method, fn }) => {
        const target = new URL(url), expected = new URL(this.origin);
        const allowed = new Set([
          "core_webservice_get_site_info",
          "core_enrol_get_users_courses",
          "core_course_get_contents",
          "mod_page_get_pages_by_courses",
          "mod_book_get_books_by_courses",
          "mod_resource_get_resources_by_courses",
          "mod_url_get_urls_by_courses",
          "mod_forum_get_forums_by_courses",
          "mod_forum_get_forum_discussions",
          "mod_forum_get_discussion_posts",
          "mod_feedback_get_feedbacks_by_courses",
          "mod_feedback_get_items",
          "mod_assign_get_assignments",
          "core_completion_get_course_completion_status",
          "core_completion_get_activities_completion_status",
        ]);
        if (
          expected.protocol !== "https:" || target.origin !== expected.origin ||
          target.pathname !==
            expected.pathname.replace(/\/$/, "") + "/webservice/rest/server.php" ||
          target.search || target.hash || target.username || target.password || method !== "POST" ||
          !allowed.has(fn)
        ) fail("followup_transport");
        if (this.#busy || this.#stopped) {
          throw new MoodleError(
            "limit_exceeded",
            "Orçamento desta execução esgotado.",
          );
        }
        const { active, limits } = this.snapshot();
        if (!active || !limits) fail("policy_unclaimed");
        if (this.#calls >= limits.calls) fail("followup_budget");
        this.#busy = true;
        try {
          await this.dispatch();
          this.#calls++;
          const timeoutMs = active.deadline - Date.now();
          if (timeoutMs <= 0) fail("followup_budget");
          let settled = false;
          return {
            maxBytes: Math.min(16 * 1024 * 1024, limits.response_bytes - this.#bytes),
            timeoutMs,
            finish: async (count: number | null) => {
              if (settled) return;
              settled = true;
              if (count === null) this.#stopped = true; // unknown partial body never permits another call
              else this.#bytes += count;
              try {
                await this.saveBytes(this.#bytes);
              } finally {
                this.#busy = false;
              }
              if (Date.now() >= active.deadline) {
                this.#stopped = true;
                fail("followup_budget");
              }
            },
          };
        } catch (error) {
          this.#busy = false;
          this.#stopped = true;
          throw error;
        }
      },
    };
  }
  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
    onDispatch?: () => void,
  ): Promise<Response> {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const expected = new URL(this.origin);
    // This implementation is deliberately local-only; never bypass production DNS pinning.
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname) || !expected.port ||
      target.origin !== expected.origin || target.pathname !== "/webservice/rest/server.php" ||
      target.search || target.hash || target.username || target.password || init?.method !== "POST"
    ) {
      fail("followup_local_transport");
    }
    if (this.#busy || this.#stopped) {
      throw new MoodleError("limit_exceeded", "Orçamento desta execução esgotado.");
    }
    const { active, limits } = this.snapshot();
    if (!active || !limits) fail("policy_unclaimed");
    this.#busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    try {
      await this.dispatch();
      const remainingMs = active.deadline - Date.now();
      if (remainingMs <= 0) fail("followup_budget");
      timer = setTimeout(() => controller.abort(), remainingMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
      onDispatch?.();
      if (!this.transport) fail("followup_local_transport");
      const response = await this.transport(input, { ...init, redirect: "error", signal });
      reader = response.body?.getReader();
      const remaining = Math.min(16 * 1024 * 1024, limits.response_bytes - this.#bytes);
      const declared = Number(response.headers.get("content-length"));
      if (declared > remaining) {
        this.#stopped = true;
        throw new MoodleError("limit_exceeded", "Orçamento de resposta esgotado.");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (reader) {
        signal.throwIfAborted();
        // Cancellation also unblocks a stalled custom/body stream, not just network fetch.
        const cancel = () => {
          void reader?.cancel().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await reader.read();
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        signal.throwIfAborted();
        if (part.done) break;
        if (part.value.byteLength > remaining - total) {
          this.#stopped = true;
          throw new MoodleError("limit_exceeded", "Orçamento de resposta esgotado.");
        }
        total += part.value.byteLength;
        this.#bytes += part.value.byteLength;
        chunks.push(part.value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await this.saveBytes(this.#bytes);
      signal.throwIfAborted();
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.set("content-length", String(total));
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status,
        headers,
      });
    } catch (error) {
      if (controller.signal.aborted || this.#bytes >= limits.response_bytes) this.#stopped = true;
      // Partial reads also have a receipt; an interrupted SQL write cannot release reserved quota.
      await this.saveBytes(this.#bytes).catch(() => {});
      if (error instanceof HubError && error.code === "followup_budget") {
        throw new MoodleError("limit_exceeded", "Orçamento desta execução esgotado.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
      this.#busy = false;
    }
  }
}
