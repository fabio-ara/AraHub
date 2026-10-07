/** One bounded local processing batch. No scheduler and no remote credentials. */
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { DocumentMaterials } from "../src/document_materials.ts";

const ownerId = Deno.args[0], limit = Number(Deno.args[1] ?? 5);
if (
  !/^[a-f0-9-]{36}$/i.test(ownerId ?? "") || !Number.isInteger(limit) || limit < 1 || limit > 20
) {
  throw new Error("Uso: deno task materials:jobs <owner-uuid> [limite 1–20]");
}
const target = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const url = new URL(target);
if (url.hostname !== "127.0.0.1" || url.port !== "55432") {
  throw new Error("Este executor está restrito ao banco local exclusivo.");
}
const db = createDb(target), principal = { ownerId };
try {
  const jobs = await asOwner(
    db,
    principal,
    (tx) =>
      tx`select id from public.hub_jobs where owner_id=${ownerId} and kind like 'document:%' and attempts<5 and (state in ('pending','partial') or (state='running' and lease_until<now())) order by updated_at limit ${limit}`,
  );
  const materials = new DocumentMaterials(new Hub(db));
  const outcomes = [];
  for (const job of jobs) {
    const result = await materials.run(principal, String(job.id));
    outcomes.push({ id: job.id, ...result });
  }
  console.log(
    JSON.stringify({
      executor: "local-once",
      scheduled: false,
      processed: outcomes.length,
      results: outcomes,
    }),
  );
} finally {
  await db.end();
}
