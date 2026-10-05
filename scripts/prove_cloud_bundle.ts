import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
const local = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const root = createDb(local);
const name = `arahub_bundle_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let db: ReturnType<typeof createDb> | undefined;
try {
  await root.unsafe(`create database ${name}`);
  db = createDb(local.replace(/\/arahub$/, "/" + name));
  const connection = await db.reserve();
  try {
    await connection.unsafe(await Deno.readTextFile("scripts/local_identity.sql"));
    await connection.unsafe(await Deno.readTextFile(".private/cloud/schema.sql"));
    const expected = JSON.parse(await Deno.readTextFile(".private/cloud/schema-manifest.json"));
    const actual =
      await connection`select version,name,encode(extensions.digest(replace(statements[1],chr(13)||chr(10),chr(10)),'sha256'),'hex') as canonical_sha256 from supabase_migrations.schema_migrations order by version`;
    assert.deepEqual(
      [...actual],
      expected.migrations.map(({ version, name, canonical_sha256 }: Record<string, string>) => ({
        version,
        name,
        canonical_sha256,
      })),
    );
    await assert.rejects(
      connection.unsafe(await Deno.readTextFile(".private/cloud/schema.sql")),
      /target_not_empty/,
    );
    await connection.unsafe("rollback");
    await connection.unsafe(await Deno.readTextFile("scripts/verify_cloud_sql.sql"));
    assert.equal((await connection`select count(*)::int as count from auth.users`)[0].count, 0);
    assert.equal(
      (await connection`select count(*)::int as count from public.hub_contexts`)[0].count,
      0,
    );
    await Deno.mkdir(".private/evidence", { recursive: true });
    await Deno.writeTextFile(
      ".private/evidence/schema-bundle-local.json",
      JSON.stringify(
        {
          database: name,
          migrations: actual.length,
          hashes_verified: true,
          replay_refused: true,
          synthetic_sql_isolation_verified: true,
          synthetic_records_rolled_back: true,
          hosted: false,
        },
        null,
        2,
      ),
    );
    console.log(
      `Bundle aprovado localmente: ${actual.length} hashes, transação e recusa de reaplicação.`,
    );
  } finally {
    await connection.release();
  }
} finally {
  await db?.end();
  await root.end();
}
