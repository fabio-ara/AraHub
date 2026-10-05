import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { ConnectionService } from "../src/connections.ts";
import { MoodleAdapter } from "../src/adapters/moodle.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { createHandler } from "../src/http.ts";

Deno.test("A02 A16: renovação HTTP Moodle preserva identidade, histórico e cofre atomicamente", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db);
  const p = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${p.ownerId}),(${other.ownerId})`;
    const vault = await TokenVault.fromRawKeys([{
      kid: "synthetic",
      key: crypto.getRandomValues(new Uint8Array(32)),
    }]);
    const seen: string[] = [];
    let gate: Promise<void> | undefined, entered: (() => void) | undefined;
    const factory = (origin: string, token: string) =>
      new MoodleAdapter({ origin, token }, {
        fetch: async (_u, init) => {
          const fn = new URLSearchParams(String(init?.body)).get("wsfunction");
          if (fn === "core_webservice_get_site_info") {
            seen.push(token);
            if (token === "synthetic-delayed") {
              entered?.();
              await gate;
            }
            return Response.json({
              userid: token === "synthetic-other-account" ? 99 : 42,
              siteurl: origin,
              functions: [{ name: "core_enrol_get_users_courses" }],
            });
          }
          return Response.json([]);
        },
      });
    const service = new ConnectionService(hub, vault, factory);
    const input = {
      label: "Synthetic Moodle",
      origin: "https://synthetic.invalid/moodle",
      token: "synthetic-original",
    };
    const connected = await service.addMoodle(p, input);
    const entity = await hub.entity(p, connected.id, "course", "123", "SYNTHETIC history");
    await assert.rejects(service.addMoodle(p, input), /Renovar acesso/);
    assert.equal((await hub.context(p)).connections.length, 1);
    await assert.rejects(
      service.addMoodle(p, {
        ...input,
        connection_id: connected.id,
        token: "synthetic-other-account",
      }),
      /mesma instalação e conta/,
    );
    const requests = seen.length;
    await assert.rejects(
      service.addMoodle(other, { ...input, connection_id: connected.id }),
      /não encontrada/,
    );
    await assert.rejects(
      service.addMoodle(p, {
        ...input,
        connection_id: connected.id,
        origin: "https://other.invalid/moodle",
      }),
      /mesma instalação e conta/,
    );
    assert.equal(seen.length, requests); // Rejected before sending credentials.
    const handler = createHandler(hub, {
      publicUrl: "https://arahub.synthetic.invalid",
      connections: service,
      auth: {
        issuer: "https://synthetic.invalid",
        resource: "https://arahub.synthetic.invalid/mcp",
      },
      verify: () => Promise.resolve(p),
    });
    const response = await handler(
      new Request("https://arahub.synthetic.invalid/api/connections/moodle", {
        method: "POST",
        headers: { Origin: "https://arahub.synthetic.invalid", "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          connection_id: connected.id,
          token: "synthetic-replacement",
        }),
      }),
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.id, connected.id);
    assert.equal(result.renewed, true);
    const history = await hub.entities(p, { connection_id: connected.id });
    assert.equal(history.records[0].id, entity.id);
    await (await service.moodle(p, connected.id)).initialize();
    assert.equal(seen.at(-1), "synthetic-replacement");
    const stored =
      await db`select encrypted_payload from arahub_private.credentials where connection_id=${connected.id}`;
    assert.equal(JSON.stringify(stored).includes("synthetic-replacement"), false);
    await assert.rejects(
      asOwner(
        db,
        p,
        (tx) =>
          tx`update public.hub_connections set origin='https://attacker.invalid' where id=${connected.id}`,
      ),
    );
    await assert.rejects(
      asOwner(
        db,
        p,
        (tx) =>
          tx`update public.hub_connections set oauth_epoch=0,state='connected' where id=${connected.id}`,
      ),
    );
    let release!: () => void;
    gate = new Promise<void>((r) => release = r);
    const started = new Promise<void>((r) => entered = r);
    const inFlight = service.addMoodle(p, {
      ...input,
      connection_id: connected.id,
      token: "synthetic-delayed",
    });
    const rejected = assert.rejects(inFlight, /conexão mudou/);
    await started;
    await service.disconnect(p, connected.id);
    release();
    await rejected;
    assert.equal((await service.parent(p, connected.id)).state, "revoked");
    assert.equal(
      (await db`select connection_id from arahub_private.credentials where connection_id=${connected.id}`)
        .length,
      0,
    );
    const reactivated = await service.addMoodle(p, {
      ...input,
      connection_id: connected.id,
      token: "synthetic-after-revoke",
    });
    assert.equal(reactivated.id, connected.id);
    assert.equal((await hub.entities(p, { connection_id: connected.id })).records[0].id, entity.id);
  } finally {
    await db.end();
  }
});
