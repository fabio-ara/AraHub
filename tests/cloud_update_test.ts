import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { sha256Hex } from "../src/migration.ts";
import { prepareCloudUpdate, type RegistryRow } from "../scripts/prepare_cloud_update.ts";

Deno.test("A01 A02: atualização incremental confere prefixo, aplica só o novo e recusa replay/drift", async () => {
  const root = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const name = "arahub_update_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  let db: ReturnType<typeof createDb> | undefined;
  try {
    await root.unsafe(`create database ${name}`);
    db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/" + name);
    const sql = await db.reserve();
    try {
      await sql.unsafe(await Deno.readTextFile("scripts/local_identity.sql"));
      await sql.unsafe(
        "create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text)",
      );
      const names: string[] = [];
      for await (const file of Deno.readDir("supabase/migrations")) {
        if (file.name.endsWith(".sql")) names.push(file.name);
      }
      names.sort();
      const registry: RegistryRow[] = [];
      for (const file of names.slice(0, 8)) {
        const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(file)!;
        const content = (await Deno.readTextFile("supabase/migrations/" + file)).replaceAll(
          "\r\n",
          "\n",
        );
        await sql.unsafe(content);
        await sql`insert into supabase_migrations.schema_migrations(version,name,statements) values(${
          match[1]
        },${match[2]},${sql.array([content])})`;
        registry.push({
          version: match[1],
          name: match[2],
          canonical_sha256: await sha256Hex(new TextEncoder().encode(content)),
        });
      }
      const prepared = await prepareCloudUpdate(registry, "aaaaaaaaaaaaaaaaaaaa");
      const statement = await Deno.readTextFile(new URL("update.sql", prepared.directory));
      assert.equal(prepared.manifest.pending.length, names.length - 8);
      await sql.unsafe(statement);
      assert.equal(
        (await sql`select count(*)::int as n from supabase_migrations.schema_migrations`)[0].n,
        names.length,
      );
      const secured =
        await sql`select relname from pg_class where relname in ('hub_actions','hub_action_approvals','hub_context_targets') and relrowsecurity and relforcerowsecurity`;
      assert.equal(secured.length, 3);
      await assert.rejects(sql.unsafe(statement), /migration_registry_changed/);
      await sql.unsafe("rollback");
      assert.equal(
        (await sql`select count(*)::int as n from supabase_migrations.schema_migrations`)[0].n,
        names.length,
      );
      const unchanged = await Deno.readTextFile(new URL("manifest.json", prepared.directory));
      const again = await prepareCloudUpdate(registry, "aaaaaaaaaaaaaaaaaaaa");
      assert.notEqual(again.directory, prepared.directory);
      assert.equal(
        await Deno.readTextFile(new URL("manifest.json", prepared.directory)),
        unchanged,
      );
      await assert.rejects(
        prepareCloudUpdate(
          [{ ...registry[0], canonical_sha256: "0".repeat(64) }],
          "aaaaaaaaaaaaaaaaaaaa",
        ),
        /prefixo exato/,
      );
      await assert.rejects(
        prepareCloudUpdate([registry[1]], "aaaaaaaaaaaaaaaaaaaa"),
        /prefixo exato/,
      );
      await assert.rejects(prepareCloudUpdate(registry, "bad-target"), /inválido/);
    } finally {
      await sql.release();
    }
  } finally {
    await db?.end();
    await root.end();
  }
});
