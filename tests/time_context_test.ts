import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { normalizeTime, TimeContext } from "../src/time_context.ts";
import { handleMcp } from "../src/mcp.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const zones = ["Europe/Lisbon", "America/Sao_Paulo"];
Deno.test("A15: instantes reconciliam DST Lisboa/São Paulo sem mudar a data original", () => {
  const summer = normalizeTime(
    { dateTime: "2026-09-24T21:00:00+01:00", timeZone: zones[0] },
    zones,
  );
  assert.equal(summer.kind, "instant");
  assert.equal(summer.instant, "2026-09-24T20:00:00.000Z");
  assert.deepEqual(summer.displays?.map((d) => d.local), [
    "2026-09-24T21:00:00",
    "2026-09-24T17:00:00",
  ]);
  assert.equal(summer.source_zone_matches, true);
  const winter = normalizeTime({ dateTime: "2026-11-24T20:00:00", timeZone: zones[0] }, zones);
  assert.equal(winter.instant, "2026-11-24T20:00:00.000Z");
  assert.deepEqual(winter.displays?.map((d) => d.local), [
    "2026-11-24T20:00:00",
    "2026-11-24T17:00:00",
  ]);
  const precise = { dateTime: "2026-11-24T20:00:00.123456Z" };
  assert.equal(normalizeTime(precise, zones).instant, "2026-11-24T20:00:00.123Z");
  assert.deepEqual(normalizeTime(precise, zones).original, precise);
});

Deno.test("A15: dia inteiro, fuso ausente e transições DST nunca ganham horário escolhido", () => {
  const allDay = normalizeTime({ date: "2026-10-06" }, zones);
  assert.equal(allDay.kind, "date_only");
  assert.equal(allDay.instant, null);
  assert.equal(
    normalizeTime({ dateTime: "2026-10-06T17:00:00" }, zones).reason,
    "time_zone_unconfirmed",
  );
  assert.equal(
    normalizeTime({ dateTime: "2026-10-25T01:30:00", timeZone: zones[0] }, zones).reason,
    "ambiguous_local_time",
  );
  assert.equal(
    normalizeTime({ dateTime: "2026-03-29T01:30:00", timeZone: zones[0] }, zones).reason,
    "nonexistent_local_time",
  );
  assert.equal(
    normalizeTime({ dateTime: "2026-10-25T01:30:00+01:00", timeZone: zones[0] }, zones).instant,
    "2026-10-25T00:30:00.000Z",
  );
});

Deno.test("A15: datas inválidas e desacordo entre offset/fuso têm evidência explícita", () => {
  assert.equal(normalizeTime({ date: "2026-02-30" }, zones).kind, "unresolved");
  assert.equal(normalizeTime({ dateTime: "2026-02-30T17:00:00Z" }, zones).kind, "unresolved");
  assert.equal(normalizeTime({ dateTime: "2026-10-06T25:00:00Z" }, zones).kind, "unresolved");
  assert.equal(
    normalizeTime({ dateTime: "2026-10-06T17:00:00+25:00" }, zones).reason,
    "invalid_offset",
  );
  assert.equal(
    normalizeTime({ dateTime: "2026-10-06T17:00:00Z", timeZone: "Mars/Olympus" }, zones).reason,
    "invalid_source_time_zone",
  );
  const mismatch = normalizeTime({ dateTime: "2026-09-24T21:00:00Z", timeZone: zones[0] }, zones);
  assert.equal(mismatch.instant, "2026-09-24T21:00:00.000Z");
  assert.equal(mismatch.source_zone_matches, false);
});

Deno.test("A02 A15: SQL/SDK leem datas qualificadas sem fonte externa; preservam observação e recusam dono alheio", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db),
    times = new TimeContext(hub),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  let server: Deno.HttpServer | undefined, client: Client | undefined;
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const moodle = await hub.connect(a, "moodle", "Fixture", null, "42");
    const google = await hub.connect(a, "google", "Fixture", null, "google-a");
    const foreign = await hub.connect(b, "google", "Fixture", null, "google-b");
    const assignment = await hub.entity(a, moodle.id, "assignment", "1", "Prazo", {
      provider_record: { duedate: 1 },
    });
    const allDay = await hub.entity(a, google.id, "calendar_event", "1", "Dia inteiro", {
      provider_record: { start: { date: "2026-10-06" }, end: { date: "2026-10-07" } },
    });
    const vague = await hub.entity(a, google.id, "calendar_event", "2", "Sem fuso", {
      provider_record: {
        start: { dateTime: "2026-10-06T17:00:00" },
        end: { dateTime: "2026-10-06T19:00:00Z" },
        endTimeUnspecified: true,
        status: "cancelled",
      },
    });
    const other = await hub.entity(b, foreign.id, "calendar_event", "1", "Nome privado alheio");
    const observed = { duedate: Date.parse("2026-09-24T20:00:00Z") / 1000, cutoffdate: 0 };
    const observationId = crypto.randomUUID();
    await db`insert into public.hub_observations(id,owner_id,entity_id,content,content_hash,provenance,coverage)
      values(${observationId},${a.ownerId},${assignment.id},${db.json(observed)},${
      "a".repeat(64)
    },${
      db.json({ system: "moodle", connection_id: moodle.id, locator: "synthetic:assignment/1" })
    },'complete')`;
    const output = await times.read(a, { entity_ids: [assignment.id, allDay.id, vague.id] });
    const due = output.entities.find((e) => e.id === assignment.id)!;
    assert.equal(due.basis, "preserved_observation");
    assert.equal(due.observation?.id, observationId);
    assert.equal(due.dates.length, 1); // Moodle 0 means unset, not 1970.
    assert.equal(due.dates[0].time.instant, "2026-09-24T20:00:00.000Z");
    assert.equal(output.entities.find((e) => e.id === allDay.id)?.dates[1].end_exclusive, true);
    assert.equal(output.entities.find((e) => e.id === vague.id)?.dates[0].time.instant, null);
    assert.equal(
      output.entities.find((e) => e.id === vague.id)?.dates[1].time.reason,
      "end_time_unspecified",
    );
    assert.equal(output.entities.find((e) => e.id === vague.id)?.calendar_status, "cancelled");
    assert.equal(output.external_changes, false);
    await assert.rejects(
      times.read(a, { entity_ids: [assignment.id, other.id] }),
      /Recurso não encontrado/,
    );
    await assert.rejects(
      times.read(a, { entity_ids: [assignment.id], display_zones: ["Mars/Olympus"] }),
      /IANA/,
    );
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 8790, onListen: () => {} },
      (req) => handleMcp(req, hub, a),
    );
    client = new Client({ name: "time-context-fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8790/mcp")));
    const list = await client.listTools();
    assert.equal(
      list.tools.find((t: { name: string; annotations?: { readOnlyHint?: boolean } }) =>
        t.name === "hub_time_context"
      )?.annotations?.readOnlyHint,
      true,
    );
    const result = await client.callTool({
      name: "hub_time_context",
      arguments: { entity_ids: [assignment.id] },
    });
    assert.ok(!result.isError);
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) =>
      c.type === "text"
    )!.text!;
    assert.equal(
      JSON.parse(text).entities[0].dates[0].time.displays[1].local,
      "2026-09-24T17:00:00",
    );
  } finally {
    await client?.close();
    await server?.shutdown();
    await db.end();
  }
});
