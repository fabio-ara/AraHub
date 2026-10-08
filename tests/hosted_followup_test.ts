import assert from "node:assert/strict";
import { asOwner, createDb, withJobLease } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { Jobs } from "../src/jobs.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { AUDITED_FUNCTIONS, MoodleAdapter } from "../src/adapters/moodle.ts";
import { type FollowupInput, FollowupPolicies } from "../src/followup_policy.ts";
import {
  createFollowupHandler,
  HostedFollowup,
  type HostedFollowupConfig,
} from "../src/hosted_followup.ts";
import { nextScheduleWindow } from "../src/followup_schedule.ts";
import { prepareFollowupCron } from "../scripts/prepare_followup_cron.ts";

const DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const ORIGIN = "https://synthetic.invalid/moodle";
async function setup(logical = 64 * 1024 * 1024) {
  const db = createDb(DB), hub = new Hub(db), p = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${p.ownerId})`;
  const vault = await TokenVault.fromRawKeys([{
    kid: "synthetic",
    key: crypto.getRandomValues(new Uint8Array(32)),
  }]);
  let hook: ((fn: string) => Promise<void>) | undefined, calls = 0;
  const connections = new ConnectionService(
    hub,
    vault,
    (origin, token, deps) =>
      new MoodleAdapter({ origin, token }, {
        ...deps,
        fetch: async (_input, init) => {
          calls++;
          const fn = new URLSearchParams(String(init?.body)).get("wsfunction")!;
          await hook?.(fn);
          return Response.json(
            fn === "core_webservice_get_site_info"
              ? {
                userid: 42,
                username: "synthetic",
                siteurl: origin,
                functions: AUDITED_FUNCTIONS.map((name) => ({ name })),
              }
              : fn === "core_enrol_get_users_courses"
              ? [{ id: 1, fullname: "Synthetic" }]
              : fn === "core_course_get_contents"
              ? [{ id: 9, name: "Synthetic section", modules: [] }]
              : fn === "mod_assign_get_assignments"
              ? { courses: [] }
              : fn === "core_completion_get_course_completion_status"
              ? { completionstatus: { completed: false, criteria: [] } }
              : fn === "core_completion_get_activities_completion_status"
              ? { statuses: [] }
              : [],
          );
        },
      }),
  );
  const c = await connections.addMoodle(p, {
    label: "Synthetic",
    origin: ORIGIN,
    token: "synthetic-followup-token",
  });
  calls = 0;
  const schedule = {
    timezone: "Europe/Lisbon" as const,
    windows: ["08:00", "20:00"] as ["08:00", "20:00"],
    duration_ms: 5400000 as const,
    max_attempts: 2 as const,
  };
  const start = Date.now(), end = start + 2 * 86400000;
  let t = nextScheduleWindow(start, start, end, schedule)! + 1000;
  const unit = { calls: 18, response_bytes: 32 * 1024 * 1024, wall_ms: 45000 };
  const input: FollowupInput = {
    connection_id: c.id,
    origin: ORIGIN,
    course_id: 1,
    expires_at: end,
    interval_ms: 900000,
    backoff_ms: 900000,
    max_failures: 3,
    forum_calls: 2,
    per_run: unit,
    total: { calls: 504, response_bytes: unit.response_bytes * 28, wall_ms: 1260000 },
    window_ms: 86400000,
    window: { calls: 72, response_bytes: unit.response_bytes * 4, wall_ms: 180000 },
  };
  const policies = new FollowupPolicies(db), policy = await policies.create(p, input);
  const config: HostedFollowupConfig = {
    version: 1,
    owner_id: p.ownerId,
    connection_id: c.id,
    credential_epoch: 0,
    origin: ORIGIN,
    starts_at: start,
    expires_at: end,
    schedule,
    logical_bytes: logical,
    policies: [{ id: policy, input }],
  };
  const id = await HostedFollowup.provision(db, config);
  const runner = new HostedFollowup(db, id, connections, () => Promise.resolve(t));
  return {
    db,
    p,
    c,
    config,
    id,
    runner,
    policy,
    policies,
    input,
    calls: () => calls,
    time: (value: number) => {
      t = value;
    },
    now: () => t,
    hook: (fn: typeof hook) => {
      hook = fn;
    },
  };
}

Deno.test("hosted followup: authenticated tiny envelope, no caller-selected scope", async () => {
  let calls = 0;
  const key = "s".repeat(43),
    handler = createFollowupHandler({
      tick: () => {
        calls++;
        return Promise.resolve({ state: "idle" });
      },
    }, key);
  for (
    const [token, method, body, status] of [
      ["wrong", "POST", "{}", 401],
      [key, "GET", null, 405],
      [key, "POST", '{"owner_id":"x"}', 400],
      [key, "POST", "x".repeat(33), 413],
      [key, "POST", "{}", 200],
    ] as const
  ) {
    const response = await handler(
      new Request("https://host.invalid/", {
        method,
        headers: { authorization: "Bearer " + token },
        body,
      }),
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 1);
});
Deno.test("hosted followup: actual SQL, bounded provider fixture, durable receipt and duplicate idle", async () => {
  const s = await setup();
  try {
    const result = await s.runner.tick();
    assert.ok(["complete", "partial"].includes(result.state), JSON.stringify(result));
    assert.ok(s.calls() > 2 && s.calls() <= 18);
    const status = await s.runner.status();
    assert.equal(status.runs, 1);
    assert.equal(status.active, null);
    assert.ok(status.logical_bytes > 0);
    const entities = await s
      .db`select id from public.hub_entities where owner_id=${s.p.ownerId} and kind='section'`;
    assert.equal(entities.length, 1);
    assert.equal((await s.runner.tick()).state, "idle");
    assert.equal((await s.runner.status()).runs, 1);
    await assert.rejects(HostedFollowup.provision(s.db, s.config));
    await assert.rejects(
      asOwner(s.db, s.p, (tx) => tx`select * from arahub_private.followup_grants`),
    );
  } finally {
    await s.db.end();
  }
});
Deno.test("hosted followup: parallel workers reserve once and pause fences delayed response", async () => {
  const s = await setup();
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let running: Promise<unknown> | undefined;
  try {
    s.hook(async (fn) => {
      if (fn === "core_course_get_contents") {
        ready();
        await held;
      }
    });
    running = s.runner.tick();
    await waiting;
    assert.equal((await s.runner.tick()).state, "idle");
    await s.runner.pause();
    release();
    await running;
    const state = await s.runner.status();
    assert.equal(state.runs, 1);
    assert.equal(state.paused, true);
    assert.equal(state.reason, "manual");
    assert.equal(
      (await s
        .db`select id from public.hub_entities where owner_id=${s.p.ownerId} and kind='section'`)
        .length,
      0,
    );
    assert.equal((await s.runner.tick()).state, "idle");
    assert.equal(s.calls(), 3);
  } finally {
    release?.();
    await running;
    await s.db.end();
  }
});
Deno.test("hosted followup: write budget rolls back data and debit together", async () => {
  const s = await setup(4096);
  try {
    assert.equal((await s.runner.tick()).state, "write_budget");
    assert.equal((await s.runner.status()).logical_bytes, 0);
    assert.equal((await s.runner.status()).reason, "write_budget");
    assert.equal(
      (await s
        .db`select id from public.hub_entities where owner_id=${s.p.ownerId} and kind='course'`)
        .length,
      0,
    );
    assert.equal(s.calls(), 2);
  } finally {
    await s.db.end();
  }
});
Deno.test("hosted followup: epoch change, expired grant and outside window send nothing", async () => {
  const s = await setup();
  try {
    const original = s.now();
    s.time(original + 6000000);
    assert.equal((await s.runner.tick()).state, "idle");
    s.time(original);
    await s.db`update public.hub_connections set oauth_epoch=oauth_epoch+1 where id=${s.c.id}`;
    assert.equal((await s.runner.tick()).state, "idle");
    assert.equal((await s.runner.status()).reason, "connection_changed");
    s.time(s.config.expires_at);
    assert.equal((await s.runner.tick()).state, "idle");
    assert.equal(s.calls(), 0);
  } finally {
    await s.db.end();
  }
});
Deno.test("hosted followup: altered public policy cannot broaden private grant", async () => {
  const s = await setup();
  try {
    await s
      .db`update public.hub_entities set state=jsonb_set(state,'{config,course_id}','2') where id=${s.policy}`;
    await assert.rejects(s.runner.tick());
    assert.equal(s.calls(), 0);
  } finally {
    await s.db.end();
  }
});
Deno.test("hosted followup: group deadline fences response before data write", async () => {
  const s = await setup();
  try {
    s.hook(async (fn) => {
      if (fn === "core_course_get_contents") s.time(s.now() + 46000);
    });
    assert.equal((await s.runner.tick()).state, "interrupted");
    assert.equal(
      (await s
        .db`select id from public.hub_entities where owner_id=${s.p.ownerId} and kind='section'`)
        .length,
      0,
    );
  } finally {
    await s.db.end();
  }
});
Deno.test("hosted followup: production budget retains DNS guard and refuses status/uploads", async () => {
  const s = await setup();
  try {
    const job = (await s.policies.prepare(s.p, s.policy))!;
    const execution = s.policies.execution(s.p, s.policy, ORIGIN);
    await new Jobs(s.db).claim(s.p, job, execution.claim);
    const deps = execution.options.moodleDeps({ recordCall() {} } as never);
    assert.equal(deps.fetch, undefined);
    for (
      const [method, fn, path] of [
        ["GET", "core_webservice_get_site_info", "/webservice/rest/server.php"],
        ["POST", "mod_assign_get_submission_status", "/webservice/rest/server.php"],
        ["POST", "core_files_upload", "/webservice/upload.php"],
      ]
    ) {
      await assert.rejects(deps.requestBudget!.begin({ url: ORIGIN + path, method, fn }));
    }
    const adapter = new MoodleAdapter({ origin: ORIGIN, token: "synthetic" }, {
      ...deps,
      resolveHost: () => Promise.resolve(["127.0.0.1"]),
    });
    await assert.rejects(adapter.initialize());
    assert.equal((await s.policies.get(s.p, s.policy)).active?.calls, 0);
    await execution.finish("interrupted");
  } finally {
    await s.db.end();
  }
});
Deno.test("transaction deadline: completed SQL is rolled back when final guard refuses", async () => {
  const s = await setup();
  try {
    const jobs = new Jobs(s.db), enqueued = await jobs.enqueue(s.p, s.c.id, "synthetic_guard");
    const job = (await jobs.claim(s.p, enqueued.id))!;
    let guards = 0;
    const leased = withJobLease(s.p, job.id, job.attempts, () => {
      guards++;
      if (guards === 2) throw new Error("deadline");
      return Promise.resolve();
    });
    await assert.rejects(
      asOwner(
        s.db,
        leased,
        (tx) =>
          tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${s.p.ownerId},${s.c.id},'late','late','late','{}')`,
      ),
    );
    assert.equal(
      (await s.db`select id from public.hub_entities where owner_id=${s.p.ownerId} and kind='late'`)
        .length,
      0,
    );
  } finally {
    await s.db.end();
  }
});

Deno.test("hosted followup: health and pause isolate owners; no activation API", async () => {
  const s = await setup(), other = { ownerId: crypto.randomUUID() };
  try {
    assert.equal((await HostedFollowup.statusForOwner(s.db, other)).grants.length, 0);
    await assert.rejects(HostedFollowup.pauseForOwner(s.db, other, s.id));
    const own = await HostedFollowup.statusForOwner(s.db, s.p);
    assert.equal(own.grants[0].state, "configured");
    assert.equal(own.scheduling_verified_by_this_read, false);
    await HostedFollowup.pauseForOwner(s.db, s.p, s.id);
    assert.equal((await s.runner.tick()).state, "idle");
    assert.equal(s.calls(), 0);
  } finally {
    await s.db.end();
  }
});
Deno.test("hosted followup: private per-window and per-course counters cannot be reset by public policy", async () => {
  const s = await setup();
  try {
    // One real attempt fixes this test clock's window key, then the operator fixture
    // models an exhausted balance. Public state is deliberately reset as an attack.
    await s.runner.tick();
    const sent = s.calls();
    await s
      .db`update public.hub_entities set state=jsonb_set(jsonb_set(state,'{next_at}','0'),'{reserved,calls}','0') where id=${s.policy}`;
    await s
      .db`update arahub_private.followup_grants set state=jsonb_set(jsonb_set(state,'{next}','{}'),'{attempts}',${
      s.db.json({ [s.policy]: 2 })
    }) where id=${s.id}`;
    assert.equal((await s.runner.tick()).state, "idle");
    s.time(s.now() + 43200000);
    await s.db`update arahub_private.followup_grants set state=jsonb_set(state,'{policy_runs}',${
      s.db.json({ [s.policy]: 28 })
    }) where id=${s.id}`;
    assert.equal((await s.runner.tick()).state, "idle");
    assert.equal(s.calls(), sent);
  } finally {
    await s.db.end();
  }
});
Deno.test("hosted followup: reconcile committed completion after worker crash without false failure", async () => {
  const s = await setup();
  try {
    const jobId = (await s.policies.prepare(s.p, s.policy))!, runId = crypto.randomUUID();
    const execution = s.policies.execution(s.p, s.policy, ORIGIN, undefined, runId);
    const jobs = new Jobs(s.db), job = (await jobs.claim(s.p, jobId, execution.claim))!;
    await jobs.finish(s.p, jobId, job.attempts, "complete", {});
    const active = {
      id: runId,
      policy_id: s.policy,
      started_at: s.now() - 1000,
      deadline: s.now() - 1,
    };
    await s.db`update arahub_private.followup_grants set state=state || ${
      s.db.json({ active, failures: { [s.policy]: 2 }, paused: true, reason: "manual" })
    }::jsonb where id=${s.id}`;
    assert.equal((await s.runner.tick()).state, "idle");
    const status = await s.runner.status();
    assert.equal(status.failures[s.policy], 0);
    assert.equal(status.recent.at(-1)?.outcome, "complete");
    assert.equal(status.reason, "manual");
    assert.equal(s.calls(), 0);
  } finally {
    await s.db.end();
  }
});
Deno.test("cron preparation rejects injected identifiers, secrets in URL and foreign endpoints", () => {
  const id = crypto.randomUUID(), project = "https://" + "a".repeat(20) + ".supabase.co";
  for (
    const target of [
      "http://" + "a".repeat(20) + ".supabase.co",
      "https://example.com",
      project + "/?secret=x",
      project + "/wrong",
      project.replace("https://", "https://user:pass@"),
    ]
  ) assert.throws(() => prepareFollowupCron(id, target));
  assert.throws(() => prepareFollowupCron("';select 1;--", project));
  const plan = prepareFollowupCron(id, project);
  assert.ok(plan.install_disabled_sql.includes("set active=false"));
  assert.ok(plan.install_disabled_sql.includes("vault.decrypted_secrets"));
});

Deno.test("hosted followup: policy change between private reservation and claim cannot broaden scope", async () => {
  const s = await setup();
  try {
    const prepare = s.runner.policies.prepare.bind(s.runner.policies);
    s.runner.policies.prepare = async (p, id) => {
      await s
        .db`update public.hub_entities set state=jsonb_set(state,'{config,course_id}','2') where id=${id}`;
      return await prepare(p, id);
    };
    assert.equal((await s.runner.tick()).state, "interrupted");
    assert.equal(s.calls(), 0);
    assert.equal((await s.runner.status()).runs, 1, "reservation is not refunded");
  } finally {
    await s.db.end();
  }
});
