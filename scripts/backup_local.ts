import { createDb } from "../src/db.ts";
import { sha256Hex } from "../src/migration.ts";
const localUrl = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const source = createDb(localUrl);
const serverProgram = Deno.args.length === 1 && Deno.args[0] === "--postgres-program";
if (Deno.args.length && !serverProgram) throw new Error("Opção de backup local desconhecida.");
const run = async (args: string[]) => {
  const child = new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch { /* already exited */ }
  }, 120_000);
  const r = await child.output().finally(() => clearTimeout(timer));
  if (!r.success) {
    throw new Error("Operação local de backup falhou; não emitir saída potencialmente privada.");
  }
};
// Explicit fallback for this fixed, exclusive local database. Uses its already
// installed pg_dump/pg_restore, with existing operator privileges; grants none.
// Commands contain only constants and our UUID, never input from a source/user.
const program = async (command: string) => {
  await source.begin(async (tx) => {
    await tx`set local statement_timeout='120s'`;
    await tx.unsafe(`copy (select '') to program '${command}'`);
  });
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
    // Never aggregate full binary-bearing rows into one JSONB value (256 MiB
    // element limit). Hash each row independently, then aggregate small hashes.
    // The binary SHA is calculated from actual bytes, not trusted metadata.
    const relation = name === "public.hub_files"
      ? db`(select id,owner_id,entity_id,name,mime_type,sha256,bytes,extracted_text,extraction,
          encode(sha256(binary_content),'hex') as actual_binary_sha256 from public.hub_files)`
      : db(name);
    const rows =
      await db`select count(*)::int as count,md5(coalesce(string_agg(row_hash,'' order by row_hash),'')) as hash
        from (select md5(to_jsonb(t)::text) as row_hash from ${relation} t) row_fingerprints`;
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
  if (serverProgram) {
    await program(`pg_dump -U arahub -d arahub -Fc -f ${containerFile}`);
    const [{ size }] = await source`select size from pg_stat_file(${containerFile})`;
    const length = Number(size);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Dump local inválido.");
    using file = await Deno.open(`${folder}/database.dump`, { write: true, createNew: true });
    for (let offset = 0; offset < length;) {
      const expected = Math.min(1024 * 1024, length - offset);
      const [{ bytes }] =
        await source`select pg_read_binary_file(${containerFile},${offset},${expected}) as bytes`;
      if (!(bytes instanceof Uint8Array) || bytes.length !== expected) {
        throw new Error("Dump local truncado.");
      }
      for (let written = 0; written < bytes.length;) {
        written += await file.write(bytes.subarray(written));
      }
      offset += bytes.length;
    }
  } else {
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
  }
  // New unique database; never drop or replace an existing target.
  await source.unsafe(`create database ${destination}`);
  if (serverProgram) {
    await program(`pg_restore -U arahub -d ${destination} --exit-on-error ${containerFile}`);
  } else {
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
  }
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
          format: "arahub-local-pg-backup-v2",
          fingerprint_algorithm: "sorted_row_hashes_with_actual_binary_sha256",
          source_environment: "local_postgres",
          transport: serverProgram ? "local_postgres_program" : "docker_cli",
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
