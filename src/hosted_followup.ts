/** Finite hosted dispatcher. No creation/activation route and no human tokens. */
import { z } from "zod";
import type postgres from "postgres";
import { type Db, type TransactionGuard } from "./db.ts";
import { HubError, type Principal } from "./contracts.ts";
import { type FollowupInput, followupInput, FollowupPolicies } from "./followup_policy.ts";
import { scheduleWindow } from "./followup_schedule.ts";
import { Hub } from "./domain.ts";
import type { ConnectionService } from "./connections.ts";
import { Sync, type SyncRunResult } from "./sync.ts";

const LIMIT = 64 * 1024 * 1024;
const uuid = z.string().uuid();
export const hostedFollowupConfig = z.object({
  version: z.literal(1),
  owner_id: uuid,
  connection_id: uuid,
  credential_epoch: z.number().int().nonnegative(),
  origin: z.string().url(),
  starts_at: z.number().int().positive(),
  expires_at: z.number().int().positive(),
  // These ceilings are deliberately not caller-configurable in this first release.
  schedule: z.object({
    timezone: z.literal("Europe/Lisbon"),
    windows: z.tuple([z.literal("08:00"), z.literal("20:00")]),
    duration_ms: z.literal(5400000),
    max_attempts: z.literal(2),
  }).strict(),
  logical_bytes: z.number().int().positive().max(LIMIT),
  policies: z.array(z.object({ id: uuid, input: followupInput }).strict()).min(1).max(2),
}).strict().superRefine((c, ctx) => {
  const seen = new Set<number>();
  if (
    c.expires_at <= c.starts_at || c.expires_at - c.starts_at > 7 * 86400000 ||
    new URL(c.origin).protocol !== "https:"
  ) ctx.addIssue({ code: "custom", message: "Invalid finite grant" });
  for (const { input: p } of c.policies) {
    if (
      seen.has(p.course_id) || p.connection_id !== c.connection_id || p.origin !== c.origin ||
      p.expires_at !== c.expires_at || p.per_run.calls > 18 ||
      p.per_run.response_bytes > 32 * 1024 * 1024 ||
      p.per_run.wall_ms > 45000 || p.forum_calls !== 2 || p.max_failures > 3 ||
      p.backoff_ms < 900000
    ) {
      ctx.addIssue({ code: "custom", message: "Policy outside approved envelope" });
    }
    seen.add(p.course_id);
  }
});
export type HostedFollowupConfig = z.infer<typeof hostedFollowupConfig>;
interface HostedRun {
  id: string;
  policy_id: string;
  started_at: number;
  deadline: number;
}
interface State {
  paused: boolean;
  reason: string | null;
  cursor: number;
  window: string | null;
  attempts: Record<string, number>;
  next: Record<string, number>;
  failures: Record<string, number>;
  runs: number;
  policy_runs: Record<string, number>;
  logical_bytes: number;
  active: HostedRun | null;
  recent: Array<HostedRun & { outcome: string; finished_at: number }>;
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const canonical = (v: unknown): string =>
  JSON.stringify(
    v,
    (_k, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  );
const fail = (code = "followup_grant"): never => {
  throw new HubError(code, "Acompanhamento indisponível para esta execução.", 409);
};
const clock = async (tx: postgres.TransactionSql) =>
  Number((await tx`select floor(extract(epoch from clock_timestamp())*1000)::float8 as t`)[0].t);

export class HostedFollowup {
  readonly policies: FollowupPolicies;
  /** Verified MCP principal only. A stored grant is not evidence of active cron. */
  static async statusForOwner(db: Db, p: Principal) {
    const rows = await db`select g.id,g.config,g.state,c.state as connection_state,c.oauth_epoch,
      floor(extract(epoch from clock_timestamp())*1000)::float8 as current_time
      from arahub_private.followup_grants g join public.hub_connections c
      on c.id=g.connection_id and c.owner_id=g.owner_id where g.owner_id=${p.ownerId}
      order by g.created_at desc limit 20`;
    return {
      scheduling_verified_by_this_read: false,
      grants: rows.map((r) => {
        const c = hostedFollowupConfig.parse(r.config), s = r.state as State;
        return {
          id: r.id,
          connection_id: c.connection_id,
          courses: c.policies.map((p) => p.input.course_id),
          state: s.paused
            ? "paused"
            : Number(r.current_time) >= c.expires_at
            ? "expired"
            : r.connection_state !== "connected" || r.oauth_epoch !== c.credential_epoch
            ? "connection_changed"
            : "configured",
          reason: s.reason,
          schedule: c.schedule,
          expires_at: c.expires_at,
          attempts: s.runs,
          logical_bytes: s.logical_bytes,
          logical_limit: c.logical_bytes,
          last_attempts: s.recent.map((run) => ({
            course_id: c.policies.find((p) => p.id === run.policy_id)?.input.course_id,
            started_at: run.started_at,
            finished_at: run.finished_at,
            outcome: run.outcome,
          })),
        };
      }),
    };
  }
  static async pauseForOwner(db: Db, p: Principal, id: string) {
    uuid.parse(id);
    return await db.begin(async (tx) => {
      const [r] =
        await tx`select state from arahub_private.followup_grants where id=${id} and owner_id=${p.ownerId} for update`;
      if (!r) throw new HubError("not_found", "Acompanhamento não encontrado.", 404);
      const s = r.state as State;
      s.paused = true;
      s.reason = "manual";
      await tx`update arahub_private.followup_grants set state=${
        tx.json(json(s))
      } where id=${id} and owner_id=${p.ownerId}`;
      return { id, paused: true, history_preserved: true };
    });
  }
  constructor(
    readonly db: Db,
    readonly grantId: string,
    readonly connections: ConnectionService,
    private time: (tx: postgres.TransactionSql) => Promise<number> = clock,
  ) {
    uuid.parse(grantId);
    this.policies = new FollowupPolicies(db);
  }
  /** Operator-only provisioning after a reviewed approval. Not reachable by HTTP/MCP. */
  static async provision(db: Db, input: HostedFollowupConfig): Promise<string> {
    const c = hostedFollowupConfig.parse(input);
    return await db.begin(async (tx) => {
      const t = await clock(tx);
      if (c.starts_at < t - 60000 || c.expires_at <= t) fail();
      const [parent] = await tx`select origin,oauth_epoch,state from public.hub_connections
        where owner_id=${c.owner_id} and id=${c.connection_id} and provider='moodle' for update`;
      if (
        !parent || parent.origin !== c.origin || parent.oauth_epoch !== c.credential_epoch ||
        parent.state !== "connected"
      ) fail();
      // A connection cannot have overlapping grants, including paused grants.
      const prior =
        await tx`select id from arahub_private.followup_grants where owner_id=${c.owner_id}
        and connection_id=${c.connection_id} and (config->>'expires_at')::bigint>${c.starts_at}`;
      if (prior.length) fail("followup_overlap");
      await HostedFollowup.checkPolicies(tx, c);
      const s: State = {
        paused: false,
        reason: null,
        cursor: 0,
        window: null,
        attempts: {},
        next: {},
        failures: {},
        runs: 0,
        policy_runs: {},
        logical_bytes: 0,
        active: null,
        recent: [],
      };
      const [r] =
        await tx`insert into arahub_private.followup_grants(owner_id,connection_id,credential_epoch,config,state)
        values(${c.owner_id},${c.connection_id},${c.credential_epoch},${tx.json(json(c))},${
          tx.json(json(s))
        }) returning id`;
      return String(r.id);
    }) as string;
  }
  private static async checkPolicies(tx: postgres.TransactionSql, c: HostedFollowupConfig) {
    for (const policy of c.policies) {
      const [r] =
        await tx`select state from public.hub_entities where id=${policy.id} and owner_id=${c.owner_id}
        and connection_id=${c.connection_id} and kind='followup_policy'`;
      if (!r || canonical(r.state.config) !== canonical(policy.input)) fail("followup_binding");
    }
  }
  private async load(tx: postgres.TransactionSql) {
    const [r] =
      await tx`select owner_id,connection_id,credential_epoch,config,state from arahub_private.followup_grants where id=${this.grantId} for update`;
    if (!r) fail();
    const c = hostedFollowupConfig.parse(r.config), s = r.state as State;
    if (
      r.owner_id !== c.owner_id || r.connection_id !== c.connection_id ||
      r.credential_epoch !== c.credential_epoch
    ) fail();
    return { c, s };
  }
  private async save(tx: postgres.TransactionSql, s: State) {
    await tx`update arahub_private.followup_grants set state=${
      tx.json(json(s))
    } where id=${this.grantId}`;
  }
  private async connectionValid(tx: postgres.TransactionSql, c: HostedFollowupConfig) {
    const [p] =
      await tx`select origin,oauth_epoch,state from public.hub_connections where owner_id=${c.owner_id} and id=${c.connection_id} and provider='moodle'`;
    return p?.state === "connected" && p.origin === c.origin &&
      p.oauth_epoch === c.credential_epoch;
  }
  /** No refund: uncertain/abandoned attempts consume their full admission slot. */
  private settle(s: State, t: number, outcome: string) {
    if (!s.active) return;
    const run = s.active, id = run.policy_id;
    s.recent = [...s.recent, { ...run, outcome, finished_at: t }].slice(-20);
    s.active = null;
    s.failures[id] = outcome === "complete" || outcome === "progress"
      ? 0
      : (s.failures[id] ?? 0) + 1;
    s.next[id] = t +
      (outcome === "complete"
        ? 5400000
        : outcome === "progress"
        ? 900000
        : [1800000, 7200000, 21600000][Math.min(s.failures[id] - 1, 2)]);
    if (outcome === "write_budget" || outcome === "expired" || s.failures[id] >= 3) {
      s.paused = true;
      s.reason = outcome === "write_budget"
        ? "write_budget"
        : outcome === "expired"
        ? "credential_expired"
        : "failure_limit";
    }
  }
  async pause() {
    await this.db.begin(async (tx) => {
      const { s } = await this.load(tx);
      s.paused = true;
      s.reason = "manual";
      await this.save(tx, s);
    });
  }
  /** Internal receipt; no credentials/source content. No caller-supplied owner. */
  async status() {
    return await this.db.begin(async (tx) => {
      const { c, s } = await this.load(tx);
      return { expires_at: c.expires_at, ...s };
    });
  }
  private async reserve(): Promise<
    { c: HostedFollowupConfig; run: HostedRun; input: FollowupInput } | null
  > {
    return await this.db.begin(async (tx) => {
      const { c, s } = await this.load(tx), t = await this.time(tx);
      if (s.active && s.active.deadline <= t) {
        // A worker can lose its response after committing completion. Reconcile
        // that exact run before counting failure, and fence any unfinished job.
        const [entity] =
          await tx`select state from public.hub_entities where id=${s.active.policy_id}
          and owner_id=${c.owner_id} and connection_id=${c.connection_id} and kind='followup_policy'`;
        const active = entity?.state.active;
        let outcome = entity?.state.recent?.find((r: { id: string }) =>
          r.id === s.active!.id
        )?.outcome ?? "abandoned";
        if (active?.id === s.active.id) {
          const [job] =
            await tx`select state from public.hub_jobs where id=${active.job_id} and owner_id=${c.owner_id}
            and connection_id=${c.connection_id} and attempts=${active.attempt} for update`;
          if (job?.state === "complete") outcome = "complete";
          await tx`update public.hub_jobs set state=case when attempts>=5 then 'failed' else 'partial' end,lease_until=null
            where id=${active.job_id} and owner_id=${c.owner_id} and attempts=${active.attempt} and state='running'`;
        }
        this.settle(s, t, outcome);
      }
      if (c.expires_at <= t || !await this.connectionValid(tx, c)) {
        s.paused = true;
        s.reason = c.expires_at <= t ? "expired" : "connection_changed";
      }
      const window = scheduleWindow(t, c.starts_at, c.expires_at, c.schedule);
      if (
        s.paused || s.active || !window || s.logical_bytes >= c.logical_bytes ||
        s.runs >= c.policies.length * 28
      ) {
        await this.save(tx, s);
        return null;
      }
      await HostedFollowup.checkPolicies(tx, c);
      if (s.window !== window.key) {
        s.window = window.key;
        s.attempts = {};
      }
      for (let offset = 0; offset < c.policies.length; offset++) {
        const index = (s.cursor + offset) % c.policies.length, policy = c.policies[index];
        if (
          (s.policy_runs[policy.id] ?? 0) >= 28 ||
          (s.attempts[policy.id] ?? 0) >= 2 || (s.next[policy.id] ?? 0) > t ||
          t + policy.input.per_run.wall_ms > window.ends_at
        ) continue;
        const [entity] =
          await tx`select state from public.hub_entities where id=${policy.id} and owner_id=${c.owner_id}`;
        if (entity.state.paused || entity.state.next_at > t) continue;
        const run: HostedRun = {
          id: crypto.randomUUID(),
          policy_id: policy.id,
          started_at: t,
          deadline: t + policy.input.per_run.wall_ms,
        };
        s.active = run;
        s.runs++;
        s.policy_runs[policy.id] = (s.policy_runs[policy.id] ?? 0) + 1;
        s.attempts[policy.id] = (s.attempts[policy.id] ?? 0) + 1;
        s.cursor = (index + 1) % c.policies.length;
        await this.save(tx, s);
        return { c, run, input: policy.input };
      }
      await this.save(tx, s);
      return null;
    }) as { c: HostedFollowupConfig; run: HostedRun; input: FollowupInput } | null;
  }
  private guard(run: HostedRun): TransactionGuard {
    return async (tx, bytes) => {
      const { c, s } = await this.load(tx), t = await this.time(tx);
      if (
        s.paused || s.active?.id !== run.id || t >= run.deadline || t >= c.expires_at ||
        !await this.connectionValid(tx, c)
      ) fail("job_conflict");
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > c.logical_bytes - s.logical_bytes) {
        fail("followup_write_budget");
      }
      s.logical_bytes += bytes;
      await this.save(tx, s);
    };
  }
  /** Exactly one bounded course attempt per invocation, serialized across workers. */
  async tick(): Promise<{ state: string; result?: SyncRunResult }> {
    const reserved = await this.reserve();
    if (!reserved) return { state: "idle" };
    const { c, run, input } = reserved, p = { ownerId: c.owner_id };
    let outcome = "interrupted";
    const execution = this.policies.execution(p, run.policy_id, c.origin, undefined, run.id, input);
    try {
      const job = await this.policies.prepare(p, run.policy_id);
      if (!job) {
        outcome = "idle";
        return { state: "idle" };
      }
      const guard = this.guard(run);
      const options = execution.options;
      const result = await new Sync(new Hub(this.db), this.connections, {
        forumCallBudget: input.forum_calls,
        execution: {
          ...options,
          transactionGuard: guard,
          moodleDeps: (metrics) => {
            const deps = options.moodleDeps(metrics), budget = deps.requestBudget!;
            return {
              ...deps,
              requestBudget: {
                begin: async (request) => {
                  await this.db.begin((tx) => guard(tx, 0));
                  const permit = await budget.begin(request);
                  return {
                    ...permit,
                    timeoutMs: Math.max(1, Math.min(permit.timeoutMs, run.deadline - Date.now())),
                  };
                },
              },
            };
          },
        },
      }).run(p, job);
      outcome = String(result.job?.state ?? "idle");
      // A bounded traversal or an explicitly unavailable capability is coverage,
      // not a transport failure. Preserve partial, but do not pause a healthy
      // connection merely because its forum requires several windows.
      if (
        outcome === "partial" && result.summary &&
        result.summary.gaps.every((gap) =>
          gap.coverage === "partial" || gap.error_code === "function_unavailable" ||
          gap.moodle_code === "nocriteriaset"
        )
      ) outcome = "progress";
      await execution.finish(outcome);
      return { state: String(result.job?.state ?? "idle"), result };
    } catch (error) {
      outcome = error instanceof HubError && error.code === "followup_write_budget"
        ? "write_budget"
        : error instanceof HubError && ["expired", "invalid_token"].includes(error.code)
        ? "expired"
        : "interrupted";
      return { state: outcome };
    } finally {
      // Reconcile the public job before releasing the private connection slot.
      await execution.finish(outcome);
      await this.db.begin(async (tx) => {
        const { s } = await this.load(tx);
        if (s.active?.id === run.id) {
          this.settle(s, await this.time(tx), outcome);
          await this.save(tx, s);
        }
      });
    }
  }
}

/** A dedicated random key authorizes only tick for the server-bound grant. */
export function createFollowupHandler(runner: Pick<HostedFollowup, "tick">, key: string) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(key)) throw new Error("FOLLOWUP_KEY_INVALID");
  const encode = (s: string) => new TextEncoder().encode(s);
  const expected = crypto.subtle.digest("SHA-256", encode("Bearer " + key));
  return async (request: Request): Promise<Response> => {
    const headers = { "cache-control": "no-store" };
    const supplied = request.headers.get("authorization") ?? "";
    if (supplied.length > 160) return new Response(null, { status: 401, headers });
    const [a, b] = await Promise.all([expected, crypto.subtle.digest("SHA-256", encode(supplied))]);
    let difference = 0;
    new Uint8Array(a).forEach((v, i) => {
      difference |= v ^ new Uint8Array(b)[i];
    });
    if (difference) return new Response(null, { status: 401, headers });
    if (request.method !== "POST" || new URL(request.url).search) {
      return new Response(null, { status: 405, headers });
    }
    // The scheduler sends {}. Stream a strict tiny envelope: never trust length alone.
    const reader = request.body?.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > 32) return new Response(null, { status: 413, headers });
          chunks.push(part.value);
        }
      }
      const data = new Uint8Array(total);
      let at = 0;
      for (const part of chunks) {
        data.set(part, at);
        at += part.length;
      }
      if (!/^\s*\{\s*\}\s*$/.test(new TextDecoder().decode(data))) {
        return new Response(null, { status: 400, headers });
      }
      const result = await runner.tick();
      return Response.json({ state: result.state }, { headers });
    } catch {
      return Response.json({ state: "unavailable" }, { status: 503, headers });
    } finally {
      await reader?.cancel().catch(() => {});
    }
  };
}
