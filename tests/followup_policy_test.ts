import assert from "node:assert/strict";
import { createDb, withJobLease } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { Attention } from "../src/attention.ts";
import { Jobs } from "../src/jobs.ts";
import { type FollowupInput, FollowupPolicies } from "../src/followup_policy.ts";
import { JobMetrics } from "../src/job_metrics.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { MoodleAdapter } from "../src/adapters/moodle.ts";
import { Sync } from "../src/sync.ts";

const ORIGIN = "http://127.0.0.1:8787";
const DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(overrides: Partial<FollowupInput> = {}) {
  const db = createDb(DB),
    hub = new Hub(db),
    jobs = new Jobs(db),
    policies = new FollowupPolicies(db);
  const p = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${p.ownerId}),(${other.ownerId})`;
  const connection = await hub.connect(p, "moodle", "Synthetic policy fixture", ORIGIN, "1");
  await db`update public.hub_connections set state='connected' where id=${connection.id}`;
  const unit = { calls: 3, response_bytes: 1024, wall_ms: 2000 };
  const input: FollowupInput = {
    connection_id: connection.id,
    origin: ORIGIN,
    course_id: 1,
    expires_at: Date.now() + 60000,
    interval_ms: 100,
    backoff_ms: 100,
    max_failures: 5,
    forum_calls: 2,
    per_run: unit,
    total: { calls: 30, response_bytes: 10240, wall_ms: 20000 },
    window_ms: 60000,
    window: { calls: 30, response_bytes: 10240, wall_ms: 20000 },
    ...overrides,
  };
  const id = await policies.create(p, input);
  return { db, hub, jobs, policies, p, other, connection, input, id };
}
const endpoint = ORIGIN + "/webservice/rest/server.php";
const post = {
  method: "POST",
  body: "synthetic",
  headers: { "content-type": "application/x-www-form-urlencoded" },
};

Deno.test("followup P2: prepare reconciles committed completion after process death without failure/refund", async () => {
  const s = await setup({ max_failures: 1 });
  try {
    const id = (await s.policies.prepare(s.p, s.id))!;
    const e = s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    const job = (await s.jobs.claim(s.p, id, e.claim))!;
    const cursor = { completed: true };
    await s.jobs.finish(s.p, id, job.attempts, "complete", cursor);
    // Crash between Jobs.finish and execution.finish; persisted reservation expires.
    await s
      .db`update public.hub_entities set state=jsonb_set(state,'{active,deadline}',to_jsonb(0::bigint)) where owner_id=${s.p.ownerId} and id=${s.id}`;
    assert.equal(await s.policies.prepare(s.p, s.id), null);
    const state = await s.policies.get(s.p, s.id);
    assert.equal(state.active, null);
    assert.equal(state.paused, false);
    assert.equal(state.pause_reason, null);
    assert.equal(state.failures, 0);
    assert.equal(state.recent.at(-1)?.outcome, "complete");
    assert.deepEqual(state.reserved, s.input.per_run);
    assert.deepEqual(state.window_reserved, s.input.per_run);
    const [stored] = await s
      .db`select state,cursor from public.hub_jobs where owner_id=${s.p.ownerId} and id=${id}`;
    assert.equal(stored.state, "complete");
    assert.deepEqual(stored.cursor, cursor);
  } finally {
    await s.db.end();
  }
});

Deno.test("followup P2: watchdog reconciles committed completion; later manual pause stays paused", async () => {
  const s = await setup({ max_failures: 1 });
  try {
    const id = (await s.policies.prepare(s.p, s.id))!;
    const e = s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    const job = (await s.jobs.claim(s.p, id, e.claim))!;
    await s.jobs.finish(s.p, id, job.attempts, "complete", { completed: true });
    assert.equal(await s.policies.interrupt(s.p, s.id, e.run!.id), true);
    const state = await s.policies.get(s.p, s.id);
    assert.equal(state.paused, false);
    assert.equal(state.pause_reason, null);
    assert.equal(state.failures, 0);
    assert.equal(state.active, null);
    assert.equal(state.recent.at(-1)?.outcome, "complete");
    assert.deepEqual(state.reserved, s.input.per_run);
    assert.deepEqual(state.window_reserved, s.input.per_run);
    await s.policies.pause(s.p, s.id, true, state.revision);
    assert.equal(await s.policies.interrupt(s.p, s.id, e.run!.id), false);
    await e.finish("wall_timeout");
    const paused = await s.policies.get(s.p, s.id);
    assert.equal(paused.paused, true);
    assert.equal(paused.pause_reason, "manual");
    assert.equal(paused.failures, 0);
    assert.equal(paused.recent.length, 1);
  } finally {
    await s.db.end();
  }
});

Deno.test("followup P2: reconciliation waits for concurrent completion commit under job row lock", async () => {
  const s = await setup({ max_failures: 1 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writer: Promise<unknown> | undefined;
  let interruption: Promise<boolean> | undefined;
  try {
    const id = (await s.policies.prepare(s.p, s.id))!;
    const e = s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    const job = (await s.jobs.claim(s.p, id, e.claim))!;
    let ready!: (pid: number) => void;
    const writerReady = new Promise<number>((resolve) => {
      ready = resolve;
    });
    // Hold the completion transaction open while the watchdog tries to settle.
    writer = s.db.begin(async (tx) => {
      const [backend] = await tx`select pg_backend_pid() as pid`;
      await tx`update public.hub_jobs set state='complete',lease_until=null where owner_id=${s.p.ownerId} and id=${id} and attempts=${job.attempts} and state='running'`;
      ready(Number(backend.pid));
      await held;
    });
    const pid = await writerReady;
    interruption = s.policies.interrupt(s.p, s.id, e.run!.id);
    let blocked = false;
    for (let poll = 0; poll < 50; poll++) {
      const [row] = await s
        .db`select exists(select 1 from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))) as blocked`;
      if (row.blocked) {
        blocked = true;
        break;
      }
      await delay(10);
    }
    assert.equal(blocked, true, "reconciliation must wait for the exact job row");
    release();
    await writer;
    assert.equal(await interruption, true);
    const state = await s.policies.get(s.p, s.id);
    assert.equal(state.recent.at(-1)?.outcome, "complete");
    assert.equal(state.failures, 0);
    assert.equal(state.paused, false);
    assert.deepEqual(state.reserved, s.input.per_run);
    const [stored] = await s
      .db`select state from public.hub_jobs where owner_id=${s.p.ownerId} and id=${id}`;
    assert.equal(stored.state, "complete");
  } finally {
    release();
    await Promise.allSettled([writer, interruption]);
    await s.db.end();
  }
});

Deno.test("followup: invalid token during discovery pauses policy and preserves expired job", async () => {
  const s = await setup();
  try {
    const vault = await TokenVault.fromRawKeys([{
      kid: "fixture",
      key: crypto.getRandomValues(new Uint8Array(32)),
    }]);
    const connections = new ConnectionService(
      s.hub,
      vault,
      (origin, token, deps) =>
        new MoodleAdapter(
          { origin, token },
          {
            ...deps,
            fetch: deps?.fetch ??
              (() => Promise.resolve(Response.json({ userid: 1, siteurl: origin, functions: [] }))),
          },
        ),
    );
    await connections.addMoodle(s.p, {
      connection_id: s.connection.id,
      label: "Fixture",
      origin: ORIGIN,
      token: "synthetic-followup-fixture",
    });
    const e = s.policies.execution(
      s.p,
      s.id,
      ORIGIN,
      () =>
        Promise.resolve(
          Response.json({ exception: "moodle_exception", errorcode: "invalidtoken" }),
        ),
    );
    const job = (await s.policies.prepare(s.p, s.id))!;
    const result = await new Sync(s.hub, connections, { execution: e.options }).run(s.p, job);
    assert.equal(result.job?.state, "expired");
    assert.equal(result.metrics?.calls, 1);
    await e.finish(String(result.job?.state));
    const state = await s.policies.get(s.p, s.id);
    assert.equal(state.paused, true);
    assert.equal(state.pause_reason, "credential_expired");
    assert.equal(state.reserved.calls, 3);
    assert.equal(await s.policies.prepare(s.p, s.id), null);
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: atomic reservation, concurrent consumers, isolation and internal state", async () => {
  const s = await setup();
  try {
    const job = (await s.policies.prepare(s.p, s.id))!;
    assert.equal(await s.jobs.claim(s.p, job), null, "default path must not bypass policy");
    const executions = Array.from(
      { length: 8 },
      () => s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([]))),
    );
    const claimed = await Promise.all(executions.map((e) => s.jobs.claim(s.p, job, e.claim)));
    assert.equal(claimed.filter(Boolean).length, 1);
    assert.deepEqual((await s.policies.get(s.p, s.id)).reserved, s.input.per_run);
    const otherCourse = await s.jobs.enqueue(s.p, s.connection.id, "moodle_course:2");
    assert.equal(await s.jobs.claim(s.p, otherCourse.id), null, "policy serializes its connection");
    await assert.rejects(s.policies.get(s.other, s.id));
    await assert.rejects(s.policies.pause(s.other, s.id, true, 1));
    await assert.rejects(s.policies.create(s.p, s.input), /Política/);
    assert.equal((await s.hub.context(s.p)).contexts.length, 0);
    assert.equal((await s.hub.preferences(s.p, {})).applicable.length, 0);
    const attention = await new Attention(s.hub).overview(s.p, {});
    assert.ok(!JSON.stringify(attention).includes("followup_policy"));
    assert.ok(!JSON.stringify(attention).includes(s.id));
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: pause/restart reuses job, fences late writes and preserves all reserved balances", async () => {
  const s = await setup();
  try {
    const jobId = (await s.policies.prepare(s.p, s.id))!;
    const first = s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    const job = (await s.jobs.claim(s.p, jobId, first.claim))!;
    await s.policies.pause(s.p, s.id, true, 1);
    await assert.rejects(s.hub.createContext(withJobLease(s.p, job.id, job.attempts), "late"));
    await assert.rejects(first.fetch(endpoint, post));
    assert.equal(await s.policies.prepare(s.p, s.id), null);
    await assert.rejects(s.policies.pause(s.p, s.id, false, 1));
    await s.policies.pause(s.p, s.id, false, 2);
    await delay(115);
    const restarted = new FollowupPolicies(s.db);
    assert.equal(await restarted.prepare(s.p, s.id), jobId);
    const second = restarted.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    const next = (await new Jobs(s.db).claim(s.p, jobId, second.claim))!;
    assert.equal(next.id, job.id);
    assert.equal(next.attempts, 2);
    await s.jobs.finish(s.p, next.id, next.attempts, "complete", { completed: true }, {
      followup_policy_id: "forged",
    });
    await second.finish("complete");
    const state = await restarted.get(s.p, s.id);
    assert.equal(state.reserved.calls, s.input.per_run.calls * 2);
    assert.equal(state.active, null);
    const [stored] = await s.db`select coverage from public.hub_jobs where id=${jobId}`;
    assert.equal(stored.coverage.followup_policy_id, s.id);
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: distinct policies on one connection serialize; another connection progresses", async () => {
  const s = await setup();
  try {
    const id2 = await s.policies.create(s.p, { ...s.input, course_id: 2 });
    const j1 = (await s.policies.prepare(s.p, s.id))!, j2 = (await s.policies.prepare(s.p, id2))!;
    const e1 = s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    const e2 = s.policies.execution(s.p, id2, ORIGIN, () => Promise.resolve(Response.json([])));
    const claims = await Promise.all([
      s.jobs.claim(s.p, j1, e1.claim),
      s.jobs.claim(s.p, j2, e2.claim),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const totals = await Promise.all([s.policies.get(s.p, s.id), s.policies.get(s.p, id2)]);
    assert.equal(totals.reduce((n, r) => n + r.reserved.calls, 0), 3);
    const c2 = await s.hub.connect(s.p, "moodle", "Independent fixture", ORIGIN, "2");
    const unrelated = await s.jobs.enqueue(s.p, c2.id, "moodle_course:1");
    assert.ok(await s.jobs.claim(s.p, unrelated.id));
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: durable window rollover never resets lifetime debit; expired policy refuses resume", async () => {
  const unit = { calls: 3, response_bytes: 1024, wall_ms: 2000 };
  const s = await setup({ window: unit });
  try {
    const jobId = (await s.policies.prepare(s.p, s.id))!;
    const first = s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    await s.jobs.claim(s.p, jobId, first.claim);
    await first.finish("partial");
    await delay(110);
    const second = s.policies.execution(
      s.p,
      s.id,
      ORIGIN,
      () => Promise.resolve(Response.json([])),
    );
    assert.equal(await s.jobs.claim(s.p, jobId, second.claim), null);
    // Move the persisted window, not the process clock; exercise recovery from stored state.
    await s
      .db`update public.hub_entities set state=jsonb_set(state,'{window_started_at}',to_jsonb(0::bigint)) where id=${s.id}`;
    assert.ok(await new Jobs(s.db).claim(s.p, jobId, second.claim));
    const charged = await s.policies.get(s.p, s.id);
    assert.equal(charged.reserved.calls, 6);
    assert.equal(charged.window_reserved.calls, 3);
    await second.finish("partial");
    await s
      .db`update public.hub_entities set state=jsonb_set(state,'{config,expires_at}',to_jsonb(1::bigint)) where id=${s.id}`;
    assert.equal(await s.policies.prepare(s.p, s.id), null);
    const expired = await s.policies.get(s.p, s.id);
    assert.equal(expired.pause_reason, "policy_expired");
    await assert.rejects(s.policies.pause(s.p, s.id, false, expired.revision));
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: uncertain transport consumes dispatch, retry cannot refund total/window quota", async () => {
  const unit = { calls: 1, response_bytes: 1024, wall_ms: 2000 };
  const s = await setup({ per_run: unit, total: unit, window: unit });
  let calls = 0;
  try {
    const job = (await s.policies.prepare(s.p, s.id))!;
    const e = s.policies.execution(s.p, s.id, ORIGIN, () => {
      calls++;
      throw new Error("uncertain");
    });
    await s.jobs.claim(s.p, job, e.claim);
    const metrics = new JobMetrics(), deps = e.options.moodleDeps(metrics);
    await assert.rejects(deps.fetch!(endpoint, post));
    await assert.rejects(deps.fetch!(endpoint, post));
    assert.equal(calls, 1);
    assert.equal(metrics.calls, 1);
    await e.finish("partial");
    await delay(110);
    assert.equal(await s.policies.prepare(s.p, s.id), job);
    const retry = s.policies.execution(s.p, s.id, ORIGIN, () => Promise.resolve(Response.json([])));
    assert.equal(await s.jobs.claim(s.p, job, retry.claim), null);
    const state = await s.policies.get(s.p, s.id);
    assert.deepEqual(state.reserved, unit);
    assert.deepEqual(state.window_reserved, unit);
    assert.equal(state.recent[0].calls, 1);
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: aggregate decoded bytes stop chunked body and reject further dispatch", async () => {
  const s = await setup({ per_run: { calls: 3, response_bytes: 12, wall_ms: 2000 } });
  let calls = 0, cancelled = 0;
  try {
    const e = s.policies.execution(s.p, s.id, ORIGIN, () => {
      calls++;
      if (calls === 1) return Promise.resolve(new Response(new Uint8Array(8)));
      return Promise.resolve(
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(4));
            },
            cancel() {
              cancelled++;
            },
          }),
        ),
      );
    });
    await s.jobs.claim(s.p, (await s.policies.prepare(s.p, s.id))!, e.claim);
    await (await e.fetch(endpoint, post)).arrayBuffer();
    await assert.rejects(e.fetch(endpoint, post));
    await assert.rejects(e.fetch(endpoint, post));
    assert.equal(calls, 2);
    assert.equal(cancelled, 1);
    assert.equal((await s.policies.get(s.p, s.id)).active?.response_bytes, 12);
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: stalled response aborted at wall deadline; abandoned reservation fenced without lease refund", async () => {
  const s = await setup({ per_run: { calls: 3, response_bytes: 1024, wall_ms: 180 } });
  let cancelled = false;
  try {
    const jobId = (await s.policies.prepare(s.p, s.id))!;
    const e = s.policies.execution(
      s.p,
      s.id,
      ORIGIN,
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
        ),
    );
    const job = (await s.jobs.claim(s.p, jobId, e.claim))!;
    const start = performance.now();
    await assert.rejects(e.fetch(endpoint, post));
    assert.ok(performance.now() - start < 1500);
    assert.equal(cancelled, true);
    await delay(20);
    assert.equal(await s.policies.prepare(s.p, s.id), null, "backoff after abandoned attempt");
    const state = await s.policies.get(s.p, s.id);
    assert.equal(state.recent[0].outcome, "abandoned");
    assert.deepEqual(state.reserved, s.input.per_run);
    await assert.rejects(s.jobs.finish(s.p, jobId, job.attempts, "complete", {}));
    await delay(110);
    assert.equal(await s.policies.prepare(s.p, s.id), jobId);
  } finally {
    await s.db.end();
  }
});

Deno.test("followup: expiry/origin guards, no destination bypass, fifth attempt stays terminal", async () => {
  const s = await setup();
  let sent = 0;
  try {
    const job = (await s.policies.prepare(s.p, s.id))!;
    const wrong = s.policies.execution(s.p, s.id, "http://127.0.0.1:9999", () => {
      sent++;
      return Promise.resolve(Response.json([]));
    });
    await assert.rejects(s.jobs.claim(s.p, job, wrong.claim));
    assert.equal((await s.policies.get(s.p, s.id)).reserved.calls, 0);
    const e = s.policies.execution(s.p, s.id, ORIGIN, () => {
      sent++;
      return Promise.resolve(Response.json([]));
    });
    await s.jobs.claim(s.p, job, e.claim);
    await assert.rejects(e.fetch("https://example.com/webservice/rest/server.php", post));
    await assert.rejects(e.fetch(ORIGIN + "/webservice/upload.php", post));
    assert.equal(sent, 0);
    await e.finish("partial");
    await s.db`update public.hub_jobs set attempts=5,state='failed' where id=${job}`;
    await delay(110);
    assert.equal(await s.policies.prepare(s.p, s.id), null);
    assert.equal((await s.policies.get(s.p, s.id)).pause_reason, "job_terminal");
    await assert.rejects(
      s.policies.create(s.p, { ...s.input, course_id: 2, expires_at: Date.now() - 1 }),
    );
  } finally {
    await s.db.end();
  }
});
