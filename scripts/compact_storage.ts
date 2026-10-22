// Explicit local maintenance. New application writes already compact transactionally.
import { asOwner, createDb } from "../src/db.ts";
const apply = Deno.args.length === 1 && Deno.args[0] === "--apply";
if (Deno.args.length && !apply) throw new Error("Use sem argumentos para inspecionar, ou --apply.");
const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
try {
  // Never touch incomplete or hash-divergent records. They require their own diagnosis.
  const rows = await db`select id,owner_id from public.hub_files where binary_content is not null
    and octet_length(binary_content)=bytes and encode(extensions.digest(binary_content,'sha256'),'hex')=sha256 order by owner_id,id`;
  let compacted = 0, pruned = 0;
  if (apply) {
    for (const file of rows) {
      await asOwner(db, { ownerId: file.owner_id }, async (tx) => {
        const [r] = await tx`select public.hub_compact_file(${file.id}::uuid) as compacted`;
        if (r.compacted) compacted++;
      });
    }
    const owners = await db`select distinct owner_id from public.hub_file_blobs`;
    for (const { owner_id } of owners) {
      await asOwner(db, { ownerId: owner_id }, async (tx) => {
        const [r] = await tx`select public.hub_prune_file_blobs() as removed`;
        pruned += Number(r.removed);
      });
    }
  }
  console.log(
    JSON.stringify({ local_only: true, dry_run: !apply, eligible: rows.length, compacted, pruned }),
  );
} finally {
  await db.end();
}
