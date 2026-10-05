import { Hub } from "./domain.ts";
import { asOwner } from "./db.ts";
import { Jobs } from "./jobs.ts";
import { type Coverage, type Principal } from "./contracts.ts";
import type { ConnectionService } from "./connections.ts";
import { sha256Hex } from "./migration.ts";

export class Sync {
  readonly jobs: Jobs;
  constructor(private hub: Hub, private connections: ConnectionService) {
    this.jobs = new Jobs(hub.db);
  }
  async courses(p: Principal, connectionId: string) {
    await this.connections.parent(p, connectionId);
    const job = await this.jobs.enqueue(p, connectionId, "moodle_courses");
    return await this.run(p, job.id);
  }
  async run(p: Principal, expectedId?: string) {
    const job = await this.jobs.claim(p, expectedId);
    if (!job) return { state: "idle" };
    // A queued job may run before the newly requested one; its receipt makes this explicit.
    const directed = expectedId === undefined || expectedId === job.id;
    try {
      if (job.kind !== "moodle_courses") {
        return {
          job: await this.jobs.finish(p, job.id, job.attempts, "unavailable", null),
          directed,
        };
      }
      const moodle = await this.connections.moodle(p, job.connection_id);
      const result = await moodle.listCourses();
      let count = 0;
      for (const c of result.data ?? []) {
        const entity = await this.hub.entity(
          p,
          job.connection_id,
          "course",
          String(c.id),
          String(c.fullname ?? c.shortname ?? "Curso"),
          { provider_record: c },
        );
        const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(c)));
        await asOwner(this.hub.db, p, async (tx) => {
          await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${p.ownerId},${entity.id},${
            tx.json(JSON.parse(JSON.stringify(c)))
          },${hash},${
            tx.json({
              system: "moodle",
              connection_id: job.connection_id,
              external_id: String(c.id),
              observed_at: result.observed_at,
            })
          },${result.coverage},${result.observed_at}) on conflict(owner_id,entity_id,content_hash) do nothing`;
        });
        count++;
      }
      return {
        job: await this.jobs.finish(p, job.id, job.attempts, result.coverage, {
          completed_at: result.observed_at,
        }, { resources: count, error_code: result.error_code }),
        directed,
      };
    } catch {
      return {
        job: await this.jobs.finish(p, job.id, job.attempts, "unavailable" as Coverage, null, {
          reason: "A fonte não pôde ser atualizada. A memória foi preservada.",
        }),
        directed,
      };
    }
  }
}
