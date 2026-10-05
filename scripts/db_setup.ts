import postgres from "postgres";
export const LOCAL_DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const databaseUrl = Deno.env.get("LOCAL_DATABASE_URL") ?? LOCAL_DB;
const target = new URL(databaseUrl);
if (target.hostname !== "127.0.0.1" || target.port !== "55432" || target.pathname !== "/arahub") {
  throw new Error("A fixture de identidade só pode ser aplicada no banco local exclusivo.");
}
const db = postgres(databaseUrl, { max: 1, onnotice: () => {} });
try {
  await db.unsafe(await Deno.readTextFile(new URL("local_identity.sql", import.meta.url)));
  const files = [];
  for await (const f of Deno.readDir(new URL("../supabase/migrations/", import.meta.url))) {
    files.push(f);
  }
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!f.name.endsWith(".sql")) continue;
    const exists = await db`select name from public.arahub_migrations where name=${f.name}`;
    if (!exists.length) {
      await db.begin(async (tx) => {
        await tx.unsafe(
          await Deno.readTextFile(new URL(`../supabase/migrations/${f.name}`, import.meta.url)),
        );
        await tx`insert into public.arahub_migrations(name) values(${f.name})`;
      });
      console.log(`Migration aplicada: ${f.name}`);
    }
  }
} finally {
  await db.end();
}
