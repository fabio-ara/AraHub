/** Local finite consumer. One attempt per invocation; no cron or installed service. */
import { z } from "zod";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { MoodleAdapter } from "../src/adapters/moodle.ts";
import { followupInput, FollowupPolicies } from "../src/followup_policy.ts";
import { Sync } from "../src/sync.ts";
import { assertLabOwnership, loadLabManifest } from "./lab/moodle_lab_adapter.ts";

export const localFollowupConfig = z.object({
  schema: z.literal("arahub.local-followup/1"),
  database_url: z.string(),
  owner_id: z.string().uuid(),
  manifest: z.string().min(1),
  instance: z.string().min(1),
  vault_key_b64: z.string().min(40).max(50),
  vault_key_id: z.string().min(1).max(80),
  policy: followupInput,
  policy_id: z.string().uuid().optional(),
}).strict();
export async function readFollowupConfig(path: string) {
  const c = localFollowupConfig.parse(JSON.parse(await Deno.readTextFile(path)));
  const url = new URL(c.database_url);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" ||
    url.port !== "55432" || url.pathname !== "/arahub" || url.search || url.hash
  ) {
    throw new Error("FOLLOWUP_LOCAL_DB_ONLY");
  }
  const manifest = await loadLabManifest(c.manifest);
  assertLabOwnership(manifest, c.instance);
  if (c.policy.origin !== manifest.origin) throw new Error("FOLLOWUP_LAB_ORIGIN");
  return c;
}
const argument = (name: string) =>
  Deno.args.find((s) => s.startsWith("--" + name + "="))?.slice(name.length + 3);

async function main() {
  const path = argument("config"), action = argument("action") ?? "status";
  if (!path || !["create", "status", "pause", "resume", "run"].includes(action)) {
    throw new Error("FOLLOWUP_ARGUMENTS");
  }
  const c = await readFollowupConfig(path), p = { ownerId: c.owner_id };
  const db = createDb(c.database_url), policies = new FollowupPolicies(db);
  try {
    if (action === "create") {
      const id = await policies.create(p, c.policy);
      // Config is private input; explicit create records its new local policy ID.
      await Deno.writeTextFile(path, JSON.stringify({ ...c, policy_id: id }, null, 2));
      console.log(JSON.stringify({ policy_id: id, state: "created_local_only" }));
      return;
    }
    if (!c.policy_id) throw new Error("FOLLOWUP_POLICY_ID_REQUIRED");
    const id = c.policy_id;
    const state = await policies.get(p, id);
    if (
      state.config.connection_id !== c.policy.connection_id ||
      state.config.origin !== c.policy.origin ||
      state.config.course_id !== c.policy.course_id
    ) throw new Error("FOLLOWUP_POLICY_BINDING");
    if (action === "status") {
      console.log(
        JSON.stringify({
          policy_id: id,
          revision: state.revision,
          paused: state.paused,
          pause_reason: state.pause_reason,
          next_at: state.next_at,
          expires_at: state.config.expires_at,
          job_id: state.job_id,
          reserved: state.reserved,
          window_reserved: state.window_reserved,
          active: state.active,
          recent: state.recent,
        }),
      );
      return;
    }
    if (action === "pause" || action === "resume") {
      const changed = await policies.pause(p, id, action === "pause", state.revision);
      console.log(
        JSON.stringify({
          state: changed.paused ? "paused" : "resumed",
          revision: changed.revision,
        }),
      );
      return;
    }
    if (Deno.args.includes("--worker")) {
      const runId = z.string().uuid().parse(argument("run-id"));
      const jobId = await policies.prepare(p, id);
      if (!jobId) {
        console.log(JSON.stringify({ state: "idle" }));
        return;
      }
      const vault = await TokenVault.fromEnv({
        get: (key) =>
          key === "ARAHUB_TOKEN_VAULT_KEY"
            ? c.vault_key_b64
            : key === "ARAHUB_TOKEN_VAULT_KEY_ID"
            ? c.vault_key_id
            : undefined,
      });
      const hub = new Hub(db);
      const connections = new ConnectionService(hub, vault, (origin, token, deps) => {
        if (origin !== c.policy.origin || !deps?.fetch) {
          throw new Error("FOLLOWUP_TRANSPORT_REQUIRED");
        }
        return new MoodleAdapter({ origin, token }, deps);
      });
      const execution = policies.execution(p, id, c.policy.origin, fetch, runId);
      // Best-effort orphan protection if the supervising CLI itself disappears.
      // The parent remains the hard boundary for a blocked child event loop.
      const orphanDeadline = setTimeout(() => Deno.exit(124), state.config.per_run.wall_ms);
      try {
        const result = await new Sync(hub, connections, {
          forumCallBudget: state.config.forum_calls,
          execution: execution.options,
        }).run(p, jobId);
        await execution.finish(String(result.job?.state ?? "partial"));
        console.log(
          JSON.stringify({
            state: result.job?.state ?? "idle",
            job_id: result.job?.id ?? null,
            attempt: result.job?.attempts ?? null,
            run: execution.run,
            metrics: result.metrics ?? null,
            gaps: result.summary?.gaps ?? [],
            checkpoint: result.summary?.checkpoint ?? null,
          }),
        );
      } finally {
        try {
          await execution.finish("interrupted");
        } finally {
          clearTimeout(orphanDeadline);
        }
      }
      return;
    }
    // A separate process enforces wall time even if the worker blocks its JS event loop.
    // The measured wall budget includes process startup; SQL fencing/cleanup follows termination.
    const runId = crypto.randomUUID();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--allow-read",
        "--allow-env",
        "--allow-net=127.0.0.1:55432," + new URL(c.policy.origin).host,
        import.meta.filename!,
        "--config=" + path,
        "--action=run",
        "--worker",
        "--run-id=" + runId,
      ],
      stdout: "piped",
      stderr: "null",
      stdin: "null",
    }).spawn();
    const started = performance.now();
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, state.config.per_run.wall_ms);
    const output = await child.output();
    clearTimeout(timer);
    const elapsed = Math.round(performance.now() - started);
    if (killed || !output.success) {
      const fenced = await policies.interrupt(p, id, runId);
      console.log(
        JSON.stringify({
          state: killed ? "wall_timeout" : "child_failed",
          child_ms: elapsed,
          fenced,
        }),
      );
      if (!killed) Deno.exitCode = 1;
    } else {
      const safe = JSON.parse(new TextDecoder().decode(output.stdout));
      console.log(
        JSON.stringify({ ...safe, child_ms: elapsed, execution: "local_finite_process" }),
      );
    }
  } finally {
    await db.end({ timeout: 2 });
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(
      "FOLLOWUP_FAILED: consulte configuração/política local; detalhes privados omitidos.",
    );
    Deno.exitCode = 1;
  }
}
