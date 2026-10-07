import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { ConnectionService } from "../src/connections.ts";
import { MoodleAdapter } from "../src/adapters/moodle.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { Sync } from "../src/sync.ts";
Deno.test("A02 A04 A18 A19: cofre persistente, conexão e sync isolados por principal", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const vault = await TokenVault.fromRawKeys([{
      kid: "fixture",
      key: crypto.getRandomValues(new Uint8Array(32)),
    }]);
    const token = "synthetic-moodle-secret-marker";
    const factory = (origin: string, t: string) =>
      new MoodleAdapter({ origin, token: t }, {
        fetch: (_u, init) => {
          const body = new URLSearchParams(String(init?.body));
          const fn = body.get("wsfunction");
          return Promise.resolve(Response.json(
            fn === "core_webservice_get_site_info"
              ? {
                userid: 42,
                siteurl: origin,
                functions: [{ name: "core_enrol_get_users_courses" }],
              }
              : [{ id: 123, fullname: "Curso sintético" }],
          ));
        },
      });
    const connections = new ConnectionService(hub, vault, factory);
    const connection = await connections.addMoodle(a, {
      label: "Fonte fixture",
      origin: "https://fixture.invalid/moodle",
      token,
    });
    await assert.rejects(connections.moodle(b, connection.id));
    await assert.rejects(
      connections.addMoodle({ ...a, clientId: "model-client" }, {
        label: "x",
        origin: "https://fixture.invalid",
        token,
      }),
      /interface/,
    );
    const stored =
      await db`select encrypted_payload from arahub_private.credentials where connection_id=${connection.id}`;
    assert.equal(JSON.stringify(stored).includes(token), false);
    assert.equal(JSON.stringify(await hub.exportMemory(a)).includes(token), false);
    const sync = new Sync(hub, connections);
    const result = await sync.courses(a, connection.id);
    assert.equal(result.job?.state, "complete");
    await assert.rejects(sync.courses(b, connection.id));
    // Mesmo dono+origem+assunto não duplica; assunto distinto não se funde.
    const sameSubject = await hub.connect(
      a,
      "moodle",
      "Conta A",
      "https://fixture.invalid/moodle",
      "moodle-sub-1",
    );
    await assert.rejects(
      hub.connect(a, "moodle", "Outra etiqueta", "https://fixture.invalid/moodle", "moodle-sub-1"),
    );
    const otherSubject = await hub.connect(
      a,
      "moodle",
      "Conta A",
      "https://fixture.invalid/moodle",
      "moodle-sub-2",
    );
    assert.notEqual(otherSubject.id, sameSubject.id);
    await connections.disconnect(a, connection.id);
    await assert.rejects(connections.moodle(a, connection.id));
    assert.equal(
      (await hub.context(a)).connections.some((c) =>
        c.id === connection.id && c.state === "revoked"
      ),
      true,
    );
  } finally {
    await db.end();
  }
});
