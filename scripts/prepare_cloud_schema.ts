// Prepares an exact migration-file bundle for a newly approved, empty project.
// No network, credentials, local auth fixture, private import or deployment.
const files: string[] = [];
for await (const f of Deno.readDir("supabase/migrations")) {
  if (f.name.endsWith(".sql")) files.push(f.name);
}
const hash = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
let sql = `begin;
set local lock_timeout='4s';
set local statement_timeout='60s';
do $guard$ begin
  if exists(select from pg_tables where schemaname='public' and tablename like 'hub_%')
     or to_regclass('supabase_migrations.schema_migrations') is not null then
    raise exception 'target_not_empty';
  end if;
end $guard$;
-- Registry shape from Supabase CLI v2.119.0 apps/cli-go/pkg/migration/history.go.
create schema supabase_migrations;
revoke all on schema supabase_migrations from public,anon,authenticated;
create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);
alter table supabase_migrations.schema_migrations enable row level security;
alter table supabase_migrations.schema_migrations force row level security;
revoke all on supabase_migrations.schema_migrations from public,anon,authenticated;
`;
const manifest = [];
for (const file of files.sort()) {
  const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(file);
  if (!match) throw new Error("Nome de migration inválido.");
  const [_, version, name] = match;
  const original = await Deno.readTextFile(`supabase/migrations/${file}`);
  const canonical = original.replaceAll("\r\n", "\n");
  const tag = `$arahub_${version}$`;
  if (canonical.includes(tag)) throw new Error("Delimitador SQL colide.");
  sql +=
    `\n-- ${file}\n${canonical}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${name}',array[${tag}${canonical}${tag}]);\n`;
  manifest.push({
    file,
    version,
    name,
    sha256: await hash(original),
    canonical_sha256: await hash(canonical),
  });
}
sql +=
  "commit;\nselect version,name,encode(extensions.digest(replace(statements[1],chr(13)||chr(10),chr(10)),'sha256'),'hex') as canonical_sha256 from supabase_migrations.schema_migrations order by version;\n";
await Deno.mkdir(".private/cloud", { recursive: true });
await Deno.writeTextFile(".private/cloud/schema.sql", sql);
await Deno.writeTextFile(
  ".private/cloud/schema-manifest.json",
  JSON.stringify(
    {
      format: "arahub-cloud-migrations-v1",
      migrations: manifest,
      sql_sha256: await hash(sql),
      requires: "authorized empty AraHub project",
      executed: false,
    },
    null,
    2,
  ),
);
console.log(`Bundle privado preparado: ${files.length} migrations; não executado remotamente.`);
