/** Real local Moodle + SQL + finite CLI children. No source writes, cron, browser or remote auth. */
import assert from "node:assert/strict";
import { createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { ConnectionService } from "../../src/connections.ts";
import { base64UrlEncode, TokenVault } from "../../src/adapters/token_vault.ts";
import { MoodleAdapter } from "../../src/adapters/moodle.ts";
import { type FollowupInput, FollowupPolicies } from "../../src/followup_policy.ts";
import { assertLabOwnership, labAccountToken, loadLabManifest } from "./moodle_lab_adapter.ts";

const arg = (name: string, fallback: string) =>
  Deno.args.find((s) => s.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback;
const manifestPath = arg("manifest", ".private/entrega-1/lab/manifest.lab.json");
const instancePath = arg("instance", ".private/entrega-1/lab/instances/arahublab456/instance.json");
const manifest = await loadLabManifest(manifestPath);
assertLabOwnership(manifest, instancePath);
const dbUrl = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const owner = { ownerId: crypto.randomUUID() };
const run = crypto.randomUUID(), dir = ".private/entrega-1/followup/" + run;
await Deno.mkdir(dir, { recursive: true });
const db = createDb(dbUrl), hub = new Hub(db), policies = new FollowupPolicies(db);
const checks: Record<string, boolean> = {};
const receipts: Record<string, unknown> = {};
const report = {
  schema: "arahub.followup-proof/1",
  run,
  owner_id: owner.ownerId,
  level: "real_local_moodle_sql_cli_processes",
  remote: "not_run_or_authorized",
  instance_id: manifest.instance_id,
  checks,
  receipts,
  started_at: new Date().toISOString(),
};
const key = crypto.getRandomValues(new Uint8Array(32));
const encodedKey = base64UrlEncode(key), token = labAccountToken(manifest, "labstudentb");
const keyId = "followup-lab";
const vault = await TokenVault.fromRawKeys([{ kid: keyId, key }]);
let setupCalls = 0;
const connections = new ConnectionService(hub, vault, (origin, secret, deps) =>
  new MoodleAdapter(
    { origin, token: secret },
    {
      ...deps,
      fetch: (input, init) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.origin !== manifest.origin || u.pathname !== "/webservice/rest/server.php") {
          throw new Error("LAB_TARGET");
        }
        setupCalls++;
        return fetch(input, { ...init, redirect: "error" });
      },
    },
  ));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function cli(config: string, action: string) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--allow-read",
      "--allow-env",
      "--allow-write=.private",
      "--allow-run=" + Deno.execPath(),
      "--allow-net=127.0.0.1:55432," + new URL(manifest.origin).host,
      "scripts/run_followup.ts",
      "--config=" + config,
      "--action=" + action,
    ],
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).spawn();
  const output = await child.output();
  const text = new TextDecoder().decode(output.stdout).trim();
  // Never persist raw logs or provider bodies. Receipts contain only IDs/counts/states.
  if (text.includes(token) || text.includes(encodedKey)) throw new Error("SECRET_GUARD");
  return {
    pid: child.pid,
    exit: output.code,
    stderr_bytes: output.stderr.length,
    data: text ? JSON.parse(text) as Record<string, unknown> : {},
  };
}
async function save() {
  const serialized = JSON.stringify({ ...report, finished_at: new Date().toISOString() }, null, 2);
  if ([token, encodedKey].some((s) => serialized.includes(s))) throw new Error("SECRET_GUARD");
  await Deno.writeTextFile(dir + "/proof.json", serialized);
}
let policyId: string | undefined, shortId: string | undefined;
try {
  await db`insert into auth.users(id) values(${owner.ownerId})`;
  const connection = await connections.addMoodle(owner, {
    label: "Follow-up local Lab fixture",
    origin: manifest.origin,
    token,
  });
  const courseIds = manifest.fixture.courses as Record<string, number>;
  const input: FollowupInput = {
    connection_id: connection.id,
    origin: manifest.origin,
    course_id: courseIds.disciplina,
    expires_at: Date.now() + 3600000,
    interval_ms: 100,
    backoff_ms: 100,
    max_failures: 5,
    forum_calls: 2,
    per_run: { calls: 18, response_bytes: 32 * 1024 * 1024, wall_ms: 45000 },
    total: { calls: 90, response_bytes: 160 * 1024 * 1024, wall_ms: 225000 },
    window_ms: 86400000,
    window: { calls: 90, response_bytes: 160 * 1024 * 1024, wall_ms: 225000 },
  };
  const config = {
    schema: "arahub.local-followup/1",
    database_url: dbUrl,
    owner_id: owner.ownerId,
    manifest: manifestPath,
    instance: instancePath,
    vault_key_b64: encodedKey,
    vault_key_id: keyId,
    policy: input,
  };
  const path = dir + "/config.json";
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2));
  receipts.create = await cli(path, "create");
  policyId = JSON.parse(await Deno.readTextFile(path)).policy_id;
  assert.ok(policyId);
  const firstPending = cli(path, "run");
  let observed = false;
  for (let poll = 0; poll < 160; poll++) {
    const state = await policies.get(owner, policyId);
    if ((state.active?.calls ?? 0) >= 2) {
      observed = true;
      break;
    }
    await delay(50);
  }
  assert.ok(observed, "real CLI child dispatched source reads");
  receipts.pause = await cli(path, "pause");
  const first = await firstPending;
  receipts.interrupted_process = first;
  const paused = await policies.get(owner, policyId);
  checks.pause_is_durable = paused.paused && paused.active === null;
  checks.no_refund_on_interruption = paused.reserved.calls === 18 &&
    paused.reserved.response_bytes === 32 * 1024 * 1024;
  receipts.idle_while_paused = await cli(path, "run");
  assert.equal((receipts.idle_while_paused as { data: { state?: string } }).data.state, "idle");
  const jobId = paused.job_id;
  receipts.resume = await cli(path, "resume");
  const second = await cli(path, "run");
  receipts.restarted_process = second;
  const resumed = await policies.get(owner, policyId);
  checks.real_process_restart = first.pid !== second.pid;
  checks.same_durable_job = resumed.job_id === jobId;
  checks.second_reservation_preserved = resumed.reserved.calls === 36 &&
    resumed.reserved.wall_ms === 90000;
  const [job] =
    await db`select id,attempts,state,coverage,cursor from public.hub_jobs where owner_id=${owner.ownerId} and id=${jobId}`;
  checks.same_job_second_attempt = job.attempts === 2;
  checks.actual_calls_bounded = resumed.recent.length === 2 &&
    resumed.recent.every((r) => r.calls <= 18);
  checks.actual_bytes_bounded = resumed.recent.every((r) => r.response_bytes <= 32 * 1024 * 1024);
  const [counts] = await db`select
    (select count(*)::int from public.hub_observations where owner_id=${owner.ownerId}) as observations,
    (select count(*)::int from public.hub_entities where owner_id=${owner.ownerId} and kind<>'followup_policy') as entities`;
  checks.real_source_persisted = counts.observations > 0 && counts.entities > 0;
  receipts.readback = {
    job_id: jobId,
    attempts: job.attempts,
    state: job.state,
    coverage: job.coverage?.status,
    counts,
    runs: resumed.recent,
    setup_calls_outside_policy: setupCalls,
    gap_count: job.coverage?.gaps ?? null,
    gaps: second.data.gaps ?? [],
    checkpoint: second.data.checkpoint ?? null,
  };
  await delay(250);
  const third = await cli(path, "run");
  receipts.checkpoint_restart = third;
  const checkpoint = third.data.checkpoint as { resumed?: boolean } | undefined;
  const progressed = await policies.get(owner, policyId);
  checks.persisted_checkpoint_resumed = checkpoint?.resumed === true;
  checks.same_job_third_process = third.data.job_id === jobId && third.data.attempt === 3 &&
    third.pid !== second.pid;
  checks.third_full_reservation = progressed.reserved.calls === 54 &&
    progressed.reserved.wall_ms === 135000;
  // A short independent policy demonstrates actual watchdog termination and fencing.
  const shortPath = dir + "/short-config.json";
  await Deno.writeTextFile(
    shortPath,
    JSON.stringify(
      {
        ...config,
        policy: {
          ...input,
          course_id: courseIds.ambientacao,
          per_run: { ...input.per_run, wall_ms: 1800 },
        },
      },
      null,
      2,
    ),
  );
  receipts.short_create = await cli(shortPath, "create");
  shortId = JSON.parse(await Deno.readTextFile(shortPath)).policy_id;
  assert.ok(shortId);
  const short = await cli(shortPath, "run");
  receipts.wall_watchdog = short;
  const after = await policies.get(owner, shortId);
  checks.wall_watchdog_terminated = short.data.state === "wall_timeout" &&
    Number(short.data.child_ms) < 2800;
  checks.wall_watchdog_fenced = after.active === null &&
    after.recent.at(-1)?.outcome === "wall_timeout";
  checks.wall_reservation_retained = after.reserved.wall_ms === 1800;
  const other = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${other.ownerId})`;
  await assert.rejects(policies.get(other, policyId));
  checks.other_owner_isolated = true;
  await save();
  assert.ok(Object.values(checks).every(Boolean), "one or more bounded follow-up checks failed");
  console.log(
    JSON.stringify({
      proof: dir + "/proof.json",
      passed: Object.keys(checks).length,
      remote: "not_run",
    }),
  );
} catch {
  await save();
  console.error("FOLLOWUP_LAB_PROOF_FAILED; diagnóstico numérico no recibo privado.");
  Deno.exitCode = 1;
} finally {
  for (const id of [policyId, shortId]) {
    if (!id) continue;
    const s = await policies.get(owner, id);
    if (!s.paused) await policies.pause(owner, id, true, s.revision);
  }
  await db.end({ timeout: 2 });
}
