// Prepare a guarded incremental migration batch. No network or external writes.
import { sha256Hex } from "../src/migration.ts";
const hashText = (text: string) => sha256Hex(new TextEncoder().encode(text));

export type RegistryRow = { version: string; name: string; canonical_sha256: string };
export async function prepareCloudUpdate(
  registry: RegistryRow[],
  projectRef: string,
  source = new URL("../supabase/migrations/", import.meta.url),
  output = new URL("../.private/cloud/", import.meta.url),
) {
  if (!/^[a-z]{20}$/.test(projectRef) || !Array.isArray(registry)) {
    throw new Error("Alvo ou registro inválido.");
  }
  const migrations: (RegistryRow & { file: string; sql: string })[] = [];
  for await (const file of Deno.readDir(source)) {
    if (!file.name.endsWith(".sql")) continue;
    const parsed = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(file.name);
    if (!parsed || !file.isFile) throw new Error("Nome de migration inválido.");
    const sql = (await Deno.readTextFile(new URL(file.name, source))).replaceAll("\r\n", "\n");
    migrations.push({
      version: parsed[1],
      name: parsed[2],
      file: file.name,
      sql,
      canonical_sha256: await hashText(sql),
    });
  }
  migrations.sort((a, b) => a.version.localeCompare(b.version));
  const expected = [...registry].sort((a, b) => String(a.version).localeCompare(String(b.version)));
  if (expected.length > migrations.length) {
    throw new Error("Registro remoto contém migrations desconhecidas.");
  }
  for (let i = 0; i < expected.length; i++) {
    const actual = expected[i], local = migrations[i];
    if (
      !actual || actual.version !== local.version || actual.name !== local.name ||
      actual.canonical_sha256 !== local.canonical_sha256
    ) {
      throw new Error("Histórico remoto não é um prefixo exato das migrations locais.");
    }
  }
  const pending = migrations.slice(expected.length);
  if (!pending.length) throw new Error("Nenhuma migration pendente; nenhum arquivo gerado.");
  // Only verified fields enter SQL. No user-supplied statements or arbitrary identifiers.
  const expectedJson = JSON.stringify(
    expected.map(({ version, name, canonical_sha256 }) => ({ version, name, canonical_sha256 })),
  );
  let sql = `begin;
set local lock_timeout='4s';
set local statement_timeout='60s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $guard$ begin
  if coalesce((select jsonb_agg(jsonb_build_object('version',version,'name',name,'canonical_sha256',
    encode(extensions.digest(replace(statements[1],chr(13)||chr(10),chr(10)),'sha256'),'hex')) order by version)
    from supabase_migrations.schema_migrations),'[]'::jsonb) <> '${expectedJson}'::jsonb then
    raise exception 'migration_registry_changed';
  end if;
end $guard$;
`;
  for (const migration of pending) {
    const tag = `$arahub_${migration.version}$`;
    if (migration.sql.includes(tag)) throw new Error("Delimitador SQL colide.");
    sql +=
      `\n-- ${migration.file}\n${migration.sql}\ninsert into supabase_migrations.schema_migrations(version,name,statements)
values('${migration.version}','${migration.name}',array[${tag}${migration.sql}${tag}]);\n`;
  }
  sql += "commit;\n";
  const directory = new URL("update-" + crypto.randomUUID() + "/", output);
  await Deno.mkdir(output, { recursive: true });
  await Deno.mkdir(directory);
  const manifest = {
    schema: "arahub.cloud.update.v1",
    project_ref: projectRef,
    prepared_at: new Date().toISOString(),
    executed: false,
    expected_registry: expected,
    sql_sha256: await hashText(sql),
    pending: pending.map(({ sql: _sql, ...migration }) => migration),
  };
  await Deno.writeTextFile(new URL("update.sql", directory), sql, { createNew: true });
  await Deno.writeTextFile(
    new URL("manifest.json", directory),
    JSON.stringify(manifest, null, 2) + "\n",
    { createNew: true },
  );
  return { directory: directory.href, manifest };
}

if (import.meta.main) {
  if (Deno.args.length !== 2) {
    throw new Error("Uso: prepare_cloud_update.ts <registro CLI JSON> <project-ref autorizado>");
  }
  const record = JSON.parse(await Deno.readTextFile(Deno.args[0]));
  const result = await prepareCloudUpdate(record.rows, Deno.args[1]);
  console.log(
    JSON.stringify({
      directory: result.directory,
      pending: result.manifest.pending.length,
      executed: false,
    }),
  );
}
