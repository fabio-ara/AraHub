import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";

const URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";

Deno.test("Exclusão de usuário sintético apaga seus registros sem atingir outro dono", async () => {
  const db = createDb(URL);
  const removedOwner = crypto.randomUUID();
  const keptOwner = crypto.randomUUID();
  try {
    await db`insert into auth.users(id) values(${removedOwner}),(${keptOwner})`;
    const removedConnection =
      (await db`insert into public.hub_connections(owner_id,provider,label) values(${removedOwner},'moodle','fixture') returning id`)[
        0
      ];
    const keptConnection =
      (await db`insert into public.hub_connections(owner_id,provider,label) values(${keptOwner},'moodle','fixture') returning id`)[
        0
      ];
    const removedEntity =
      (await db`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title) values(${removedOwner},${removedConnection.id},'course','synthetic-a','fixture') returning id`)[
        0
      ];
    const keptEntity =
      (await db`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title) values(${keptOwner},${keptConnection.id},'course','synthetic-b','fixture') returning id`)[
        0
      ];
    await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes) values(${removedOwner},${removedEntity.id},'fixture.txt','text/plain','synthetic-hash',0)`;
    await db`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage) values(${removedOwner},${removedEntity.id},'{}','synthetic-hash','{}','complete')`;
    await db`insert into arahub_private.credentials(owner_id,connection_id,encrypted_payload,key_version) values(${removedOwner},${removedConnection.id},'{}','fixture')`;
    await db`insert into public.hub_contexts(owner_id,title) values(${removedOwner},'fixture')`;

    await db`delete from auth.users where id=${removedOwner}`;

    const [deletedAccount] =
      await db`select count(*)::integer as count from auth.users where id=${removedOwner}`;
    assert.equal(deletedAccount.count, 0);
    const ownedTables =
      await db`select table_schema,table_name from information_schema.columns where column_name='owner_id' and ((table_schema='public' and table_name like 'hub_%') or table_schema='arahub_private') order by table_schema,table_name`;
    for (const { table_schema, table_name } of ownedTables) {
      assert.match(table_schema, /^[a-z_]+$/);
      assert.match(table_name, /^[a-z_]+$/);
      const [row] = await db.unsafe(
        `select count(*)::integer as count from "${table_schema}"."${table_name}" where owner_id=$1`,
        [removedOwner],
      );
      assert.equal(row.count, 0, `${table_schema}.${table_name} reteve dados do dono excluído`);
    }
    const [kept] =
      await db`select count(*)::integer as count from public.hub_entities where owner_id=${keptOwner} and id=${keptEntity.id}`;
    assert.equal(kept.count, 1);
  } finally {
    await db.end();
  }
});
