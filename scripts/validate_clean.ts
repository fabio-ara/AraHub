import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";

// A new SQL database with no AraHub state. This is not a clean hosted/OS installation.
const rootUrl = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const root = createDb(rootUrl),
  name = `arahub_install_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let db: ReturnType<typeof createDb> | undefined;
try {
  await root.unsafe(`create database ${name}`);
  db = createDb(rootUrl.replace(/\/arahub$/, "/" + name));
  await db.unsafe(await Deno.readTextFile(new URL("./local_identity.sql", import.meta.url)));
  const files: string[] = [];
  for await (const file of Deno.readDir("supabase/migrations")) {
    if (file.name.endsWith(".sql")) files.push(file.name);
  }
  for (const file of files.sort()) {
    await db.begin(async (tx) => {
      await tx.unsafe(await Deno.readTextFile(`supabase/migrations/${file}`));
      await tx`insert into public.arahub_migrations(name) values(${file})`;
    });
  }
  const hub = new Hub(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
  const context = await hub.createContext(a, "Instalação sintética limpa");
  const delta = {
    context_id: context.id,
    idempotency_key: crypto.randomUUID(),
    kind: "decision" as const,
    content: "Continuar com a origem preservada.",
    expected_version: 0,
    evidence_kind: "user_report" as const,
    provenance: [{ system: "synthetic", locator: "fixture:clean-install" }],
  };
  const receipt = await hub.recordDelta(a, delta);
  assert.equal((await hub.recordDelta(a, delta)).id, receipt.id);
  assert.equal((await hub.context(b)).contexts.length, 0);
  await assert.rejects(hub.context(b, context.id));
  const protection =
    await db`select count(*)::integer as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and (n.nspname='arahub_private' or (n.nspname='public' and c.relname like 'hub_%')) and (not c.relrowsecurity or not c.relforcerowsecurity)`;
  assert.equal(protection[0].count, 0);
  await Deno.mkdir(".private/evidence", { recursive: true });
  await Deno.writeTextFile(
    ".private/evidence/clean-install.json",
    JSON.stringify(
      {
        database: name,
        migrations: files,
        identity: "local_fixture",
        fresh_database: true,
        rls_verified: true,
        two_owners_verified: true,
        idempotency_verified: true,
        hosted: false,
        dependencies_fresh_cache: false,
      },
      null,
      2,
    ),
  );
  console.log(
    `Instalação SQL local limpa aprovada: ${files.length} migrations, dois proprietários e retry idempotente. Banco de prova preservado.`,
  );
} finally {
  await db?.end();
  await root.end();
}
