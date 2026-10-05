import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { importStaging } from "../src/importer.ts";
const url = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
if (new URL(url).hostname !== "127.0.0.1" || new URL(url).port !== "55432") {
  throw new Error(
    "Este comando só permite o banco local AraHub. Importação remota exige gate próprio.",
  );
}
await Deno.mkdir(".private", { recursive: true });
let actor: { ownerId: string };
try {
  actor = JSON.parse(await Deno.readTextFile(".private/local-owner.json"));
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
  actor = { ownerId: crypto.randomUUID() };
  await Deno.writeTextFile(".private/local-owner.json", JSON.stringify(actor), { createNew: true });
}
const db = createDb(url);
try {
  await db`insert into auth.users(id) values(${actor.ownerId}) on conflict do nothing`;
  const result = await importStaging(new Hub(db), actor, ".private/migration/staging");
  await Deno.mkdir(".private/evidence", { recursive: true });
  await Deno.writeTextFile(
    ".private/evidence/local-import.json",
    JSON.stringify(
      {
        ...result,
        owner_id: actor.ownerId,
        environment: "local_postgres_identity_fixture",
        cutover: false,
      },
      null,
      2,
    ),
  );
  console.log(
    `Importação local: ${result.files} arquivos; ${result.records} registros novos; ${result.reused} reutilizados. Não é virada.`,
  );
} finally {
  await db.end();
}
