/** Real Moodle Lab through an explicit fixture transport, real SQL, simulated
 * scheduler clock. Does NOT prove external DNS/TLS, hosted CPU, or active cron. */
import assert from "node:assert/strict";
import { createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { ConnectionService } from "../../src/connections.ts";
import { TokenVault } from "../../src/adapters/token_vault.ts";
import { MoodleAdapter } from "../../src/adapters/moodle.ts";
import { type FollowupInput, FollowupPolicies } from "../../src/followup_policy.ts";
import { HostedFollowup, type HostedFollowupConfig } from "../../src/hosted_followup.ts";
import { nextScheduleWindow } from "../../src/followup_schedule.ts";
import { assertLabOwnership, labAccountToken, loadLabManifest } from "./moodle_lab_adapter.ts";

const manifest = await loadLabManifest(".private/entrega-1/lab/manifest.lab.json");
assertLabOwnership(manifest, ".private/entrega-1/lab/instances/arahublab456/instance.json");
const endpoint = new URL(manifest.origin);
if (!["127.0.0.1", "localhost"].includes(endpoint.hostname) || !endpoint.port) {
  throw new Error("LAB_ONLY");
}
const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
const hub = new Hub(db), p = { ownerId: crypto.randomUUID() };
const origin = "https://synthetic-lab.invalid";
const vault = await TokenVault.fromRawKeys([{
  kid: "synthetic-lab",
  key: crypto.getRandomValues(new Uint8Array(32)),
}]);
let dispatched = 0;
const connections = new ConnectionService(
  hub,
  vault,
  (configured, token, deps) =>
    new MoodleAdapter({ origin: configured, token }, {
      ...deps,
      fetch: async (input, init) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (
          u.origin !== origin || u.pathname !== "/webservice/rest/server.php" ||
          init?.method !== "POST"
        ) throw new Error("LAB_REQUEST_ONLY");
        const response = await fetch(manifest.origin + u.pathname, { ...init, redirect: "error" });
        dispatched++;
        // Moodle site identity is rebound only in this isolated lab fixture.
        if (
          new URLSearchParams(String(init.body)).get("wsfunction") ===
            "core_webservice_get_site_info"
        ) {
          const body = await response.json();
          body.siteurl = origin;
          return Response.json(body);
        }
        return response;
      },
    }),
);
const directory = ".private/entrega-1/hosted-followup-lab/" + crypto.randomUUID();
await Deno.mkdir(directory, { recursive: true });
const proof: Record<string, unknown> = {
  schema: "arahub.hosted-followup-lab/1",
  started_at: new Date().toISOString(),
  level: "real_moodle_lab_sql_fixture_transport_simulated_schedule_clock",
  hosted: "not_run",
  cron: "not_active",
  owner_id: p.ownerId,
};
let runner: HostedFollowup | undefined;
try {
  await db`insert into auth.users(id) values(${p.ownerId})`;
  const c = await connections.addMoodle(p, {
    label: "Synthetic hosted follow-up Lab",
    origin,
    token: labAccountToken(manifest, "labstudentb"),
  });
  dispatched = 0;
  const schedule = {
    timezone: "Europe/Lisbon" as const,
    windows: ["08:00", "20:00"] as ["08:00", "20:00"],
    duration_ms: 5400000 as const,
    max_attempts: 2 as const,
  };
  const start = Date.now(), end = start + 2 * 86400000;
  let simulated = nextScheduleWindow(start, start, end, schedule)! + 1000;
  const input: FollowupInput = {
    connection_id: c.id,
    origin,
    course_id: (manifest.fixture.courses as Record<string, number>).disciplina,
    expires_at: end,
    interval_ms: 900000,
    backoff_ms: 900000,
    max_failures: 3,
    forum_calls: 2,
    per_run: { calls: 18, response_bytes: 32 * 1024 * 1024, wall_ms: 45000 },
    total: { calls: 504, response_bytes: 896 * 1024 * 1024, wall_ms: 1260000 },
    window_ms: 86400000,
    window: { calls: 72, response_bytes: 128 * 1024 * 1024, wall_ms: 180000 },
  };
  const policies = new FollowupPolicies(db), policy = await policies.create(p, input);
  const config: HostedFollowupConfig = {
    version: 1,
    owner_id: p.ownerId,
    connection_id: c.id,
    credential_epoch: 0,
    origin,
    starts_at: start,
    expires_at: end,
    schedule,
    logical_bytes: 64 * 1024 * 1024,
    policies: [{ id: policy, input }],
  };
  const grant = await HostedFollowup.provision(db, config);
  runner = new HostedFollowup(db, grant, connections, () => Promise.resolve(simulated));
  const first = await runner.tick(),
    status1 = await runner.status(),
    state1 = await policies.get(p, policy);
  proof.first = { result: first, status: status1, policy: state1 };
  assert.ok(first.result?.metrics && first.result.metrics.calls > 0, "real source was read");
  assert.ok(status1.logical_bytes > 0 && status1.logical_bytes < config.logical_bytes);
  assert.equal((await runner.tick()).state, "idle", "backoff prevents immediate repeat");
  // Advance the private scheduler clock AND the public policy's next-at in this
  // synthetic owner only. This is accelerated test time, not a 15-minute wait.
  simulated += 900001;
  await db`update public.hub_entities set state=jsonb_set(state,'{next_at}','0') where owner_id=${p.ownerId} and id=${policy}`;
  const restarted = new HostedFollowup(db, grant, connections, () => Promise.resolve(simulated));
  const second = await restarted.tick(),
    status2 = await restarted.status(),
    state2 = await policies.get(p, policy);
  proof.second = { result: second, status: status2, policy: state2 };
  assert.equal(status2.runs, 2);
  assert.equal(state1.job_id, state2.job_id, "partial job resumed");
  assert.ok(status2.logical_bytes > status1.logical_bytes);
  assert.ok(
    state2.recent.every((run) => run.calls <= 18 && run.response_bytes <= 32 * 1024 * 1024),
  );
  simulated += 900001;
  await db`update public.hub_entities set state=jsonb_set(state,'{next_at}','0') where owner_id=${p.ownerId} and id=${policy}`;
  assert.equal((await restarted.tick()).state, "idle", "two attempts per window enforced");
  const [counts] =
    await db`select (select count(*) from public.hub_entities where owner_id=${p.ownerId} and kind<>'followup_policy')::int as entities,
    (select count(*) from public.hub_observations where owner_id=${p.ownerId})::int as observations`;
  assert.ok(counts.entities > 0 && counts.observations > 0);
  proof.readback = counts;
  proof.dispatched = dispatched;
  proof.passed = true;
} catch (error) {
  proof.passed = false;
  proof.error = error instanceof assert.AssertionError ? error.message : "LAB_EXECUTION_FAILED";
  throw error;
} finally {
  if (runner) {
    await runner.pause();
    proof.final_state = await runner.status();
  }
  proof.finished_at = new Date().toISOString();
  await Deno.writeTextFile(directory + "/proof.json", JSON.stringify(proof, null, 2));
  await db.end();
  console.log(JSON.stringify({ proof: directory + "/proof.json", passed: proof.passed }));
}
