import { createDb } from "../src/db.ts";
import { sha256Hex } from "../src/migration.ts";
const localUrl = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const source = createDb(localUrl);
const run = async (args: string[]) => {
  const r = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!r.success) {
    throw new Error("Operação local de backup falhou; não emitir saída potencialmente privada.");
  }
};
const id = crypto.randomUUID().replaceAll("-", "");
const destination = `arahub_restore_${id.slice(0, 12)}`;
const folder = `.private/backups/${id}`;
await Deno.mkdir(folder, { recursive: true });
const containerFile = `/tmp/arahub-${id}.dump`;
const tables =
  (await source`select schemaname||'.'||tablename as name from pg_tables where (schemaname='public' and tablename like 'hub_%') or schemaname='arahub_private' or (schemaname='auth' and tablename in ('users','sessions')) order by schemaname,tablename`)
    .map((r) => r.name as string);
const fingerprint = async (db: ReturnType<typeof createDb>) => {
  const result: Record<string, { count: number; hash: string }> = {};
  for (const name of tables) {
    const rows =
      await db`select count(*)::int as count,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text) as hash from ${
        db(name)
      } t`;
    result[name] = { count: rows[0].count, hash: rows[0].hash };
  }
  return result;
};
const isolation = async (db: ReturnType<typeof createDb>) => ({
  tables:
    await db`select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and (n.nspname='arahub_private' or (n.nspname='public' and c.relname like 'hub_%')) order by n.nspname,c.relname`,
  policies:
    await db`select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','arahub_private') order by schemaname,tablename,policyname`,
  grants:
    await db`select grantee,table_schema,table_name,privilege_type from information_schema.role_table_grants where table_schema in ('public','arahub_private') and grantee in ('anon','authenticated') order by grantee,table_schema,table_name,privilege_type`,
});
try {
  const before = await fingerprint(source), beforeIsolation = await isolation(source);
  await run([
    "exec",
    "arahub-db-1",
    "pg_dump",
    "-U",
    "arahub",
    "-d",
    "arahub",
    "-Fc",
    "-f",
    containerFile,
  ]);
  await run(["cp", `arahub-db-1:${containerFile}`, `${folder}/database.dump`]);
  // New unique database; never drop or replace an existing target.
  await source.unsafe(`create database ${destination}`);
  await run([
    "exec",
    "arahub-db-1",
    "pg_restore",
    "-U",
    "arahub",
    "-d",
    destination,
    "--exit-on-error",
    containerFile,
  ]);
  const restored = createDb(localUrl.replace(/\/arahub$/, "/" + destination));
  try {
    const after = await fingerprint(restored);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(beforeIsolation) !== JSON.stringify(await isolation(restored))
    ) throw new Error("Restore não corresponde aos dados e controles de acesso do snapshot.");
    const bytes = await Deno.readFile(`${folder}/database.dump`);
    await Deno.writeTextFile(
      `${folder}/manifest.json`,
      JSON.stringify(
        {
          format: "arahub-local-pg-backup-v1",
          source_environment: "local_postgres",
          destination_database: destination,
          sha256: await sha256Hex(bytes),
          bytes: bytes.length,
          tables: before,
          restore_verified: true,
          isolation_verified: true,
          cutover: false,
          credentials: "encrypted records only; vault keys are separate",
        },
        null,
        2,
      ),
    );
    console.log(
      `Backup/restore local aprovado: ${tables.length} tabelas e políticas/grants comparados; ${bytes.length} bytes. Destino limpo exclusivo preservado.`,
    );
  } finally {
    await restored.end();
  }
} finally {
  await source.end();
}
