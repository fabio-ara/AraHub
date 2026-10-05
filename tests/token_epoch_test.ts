import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { PostgresTokenStore } from "../src/connections.ts";
import { sealTokenRecord, TokenVault } from "../src/adapters/token_vault.ts";

Deno.test("A19: refresh antigo não substitui novo consentimento mesmo com versão do token reiniciada", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db),
    p = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${p.ownerId})`;
    const connection = await hub.connect(p, "google", "Conta sintética", null, "stable-subject");
    await db`update public.hub_connections set oauth_epoch=1,state='connected' where owner_id=${p.ownerId} and id=${connection.id}`;
    const vault = await TokenVault.fromRawKeys([{
      kid: "fixture",
      key: crypto.getRandomValues(new Uint8Array(32)),
    }]);
    const old = await sealTokenRecord({
      vault,
      ownerId: p.ownerId,
      connectionId: connection.id,
      response: {
        access_token: "synthetic-old-token",
        refresh_token: "synthetic-old-refresh",
        expires_in: 3600,
      },
    });
    const firstStore = new PostgresTokenStore(db, p, 1);
    assert.equal(await firstStore.compareAndSwap(p.ownerId, connection.id, 0, old), true);
    // A later disconnect/reconnect deletes the old credential and issues version one again.
    await db.begin(async (tx) => {
      await tx`update public.hub_connections set oauth_epoch=3,state='connected' where owner_id=${p.ownerId} and id=${connection.id}`;
      await tx`delete from arahub_private.credentials where owner_id=${p.ownerId} and connection_id=${connection.id}`;
    });
    const fresh = await sealTokenRecord({
      vault,
      ownerId: p.ownerId,
      connectionId: connection.id,
      response: {
        access_token: "synthetic-new-token",
        refresh_token: "synthetic-new-refresh",
        expires_in: 3600,
      },
    });
    const current = new PostgresTokenStore(db, p, 3);
    assert.equal(await current.compareAndSwap(p.ownerId, connection.id, 0, fresh), true);
    await assert.rejects(
      firstStore.compareAndSwap(p.ownerId, connection.id, 1, { ...old, version: 2 }),
    );
    assert.deepEqual(await current.read(p.ownerId, connection.id), fresh);
  } finally {
    await db.end();
  }
});
