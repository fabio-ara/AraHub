import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { PersistentActionStore } from "../src/approval_store.ts";
import { GoogleWrites, googleWriteSchema } from "../src/google_writes.ts";
import type { GoogleConnections } from "../src/google_connections.ts";
import { createHandler } from "../src/http.ts";

Deno.test("A21: células tipadas e fórmulas locais têm limites sem interpretar texto como fórmula", () => {
  const base = { operation: "sheets_create" as const, title: "Dados sintéticos" };
  assert.ok(
    googleWriteSchema.safeParse({
      ...base,
      rows: [['=IMPORTXML("https://fixture.invalid")', 2, true, null, { formula: "=SUM(B2:B3)" }]],
    }).success,
  );
  for (
    const rows of [
      [[{ formula: '=IMPORTXML("https://fixture.invalid","//x")' }]],
      [[{ formula: "=NOW()" }]],
      [[{ formula: "=Other!A1" }]],
      [[{ formula: "=[external]A1" }]],
      [[{ formula: "=1", url: "https://fixture.invalid" }]],
      [[Number.NaN]],
      Array.from({ length: 101 }, () => Array.from({ length: 50 }, () => 1)),
      Array.from({ length: 30 }, () => ["á".repeat(1000)]),
    ]
  ) assert.equal(googleWriteSchema.safeParse({ ...base, rows }).success, false);
});

Deno.test("A02 A21 A22: criação com células e slide com texto conservam aprovação, revisão e envio único", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db);
  const browser = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const mcp = { ...browser, clientId: "fixture-content" }, other = { ownerId: crypto.randomUUID() };
  let revision = "slides-rev-1",
    collision = false,
    unknownSize = false,
    wrongReceipt = false,
    wrongSource = false;
  const sent: { url: string; body: Record<string, any> }[] = [];
  const store = new PersistentActionStore(db, {
    sessionActive: (o, s) => Promise.resolve(o === browser.ownerId && s === browser.sessionId),
  });
  const google = {
    client: () =>
      Promise.resolve({
        getPresentation: () =>
          Promise.resolve({
            presentationId: wrongSource ? "other-presentation" : "slides-content",
            revisionId: revision,
            ...(unknownSize ? {} : {
              pageSize: {
                width: { magnitude: 9144000, unit: "EMU" },
                height: { magnitude: 5143500, unit: "EMU" },
              },
            }),
            slides: collision ? [{ objectId: "arahub_new_slide" }] : [],
          }),
      }),
    tokens: () =>
      Promise.resolve({
        access_token: "synthetic-only-content-token",
        expires_at: Date.now() + 60000,
        token_type: "Bearer",
      }),
  } as unknown as GoogleConnections;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer synthetic-only-content-token",
    );
    const action =
      await db`select state from public.hub_actions where owner_id=${browser.ownerId} order by created_at desc limit 1`;
    assert.equal(action[0].state, "uncertain");
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json(
      String(url).includes("sheets.googleapis.com")
        ? { spreadsheetId: "sheet-created" }
        : { presentationId: wrongReceipt ? "other-presentation" : "slides-content" },
    );
  };
  const writes = new GoogleWrites(hub, google, store, fetcher);
  const handler = createHandler(hub, {
    auth: { issuer: "https://fixture.invalid/auth", resource: "https://fixture.invalid/mcp" },
    publicUrl: "https://fixture.invalid",
    actions: store,
    verify: () => Promise.resolve(browser),
  });
  const approve = (action: { id: string; hash: string }) =>
    handler(
      new Request("https://fixture.invalid/api/actions/approve", {
        method: "POST",
        headers: { Origin: "https://fixture.invalid" },
        body: JSON.stringify({ action_id: action.id, content_hash: action.hash }),
      }),
    );
  try {
    await db`insert into auth.users(id) values(${browser.ownerId}),(${other.ownerId})`;
    const connection = await hub.connect(
      browser,
      "google",
      "Produção sintética de conteúdo",
      null,
      "fixture-content-subject",
    );
    const scopes = [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
    ];
    await db`update public.hub_connections set state='connected',desired_scopes=${
      db.array(scopes)
    },granted_scopes=${db.array(scopes)} where owner_id=${browser.ownerId} and id=${connection.id}`;
    const sheet = await writes.prepare(mcp, connection.id, {
      operation: "sheets_create",
      title: "Teste sintético",
      sheet_title: "Dados",
      rows: [["=1+1", 2, true, null], [{ formula: "=SUM(B1:B2)" }, 3]],
    });
    await assert.rejects(writes.execute(mcp, sheet.id), /Autorize/);
    assert.equal(sent.length, 0);
    await assert.rejects(writes.execute(other, sheet.id), /encontrada/);
    assert.equal((await approve(sheet)).status, 200);
    assert.equal((await writes.execute(mcp, sheet.id)).state, "succeeded");
    assert.equal((await writes.execute(mcp, sheet.id)).state, "succeeded");
    assert.equal(sent.length, 1);
    const body = sent[0].body;
    assert.deepEqual(body.sheets[0].data[0].rowData[0].values, [
      { userEnteredValue: { stringValue: "=1+1" } },
      { userEnteredValue: { numberValue: 2 } },
      { userEnteredValue: { boolValue: true } },
      {},
    ]);
    assert.deepEqual(body.sheets[0].data[0].rowData[1].values[0], {
      userEnteredValue: { formulaValue: "=SUM(B1:B2)" },
    });
    assert.deepEqual(body.sheets[0].properties.gridProperties, { rowCount: 2, columnCount: 4 });
    const add = {
      operation: "slides_add_text" as const,
      resource_id: "slides-content",
      slide_id: "arahub_new_slide",
      text_id: "arahub_new_text",
      text: "Conteúdo sintético com acentos.",
    };
    await assert.rejects(
      writes.prepare(mcp, connection.id, { ...add, text_id: add.slide_id }),
      /distintos/,
    );
    await assert.rejects(writes.prepare(mcp, connection.id, { ...add, x: 700 }), /caber/);
    wrongSource = true;
    await assert.rejects(writes.prepare(mcp, connection.id, add), /destino escolhido/);
    wrongSource = false;
    unknownSize = true;
    await assert.rejects(writes.prepare(mcp, connection.id, add), /tamanho/);
    unknownSize = false;
    collision = true;
    await assert.rejects(writes.prepare(mcp, connection.id, add), /já existem/);
    collision = false;
    const stale = await writes.prepare(mcp, connection.id, add);
    await approve(stale);
    revision = "slides-rev-2";
    await assert.rejects(writes.execute(mcp, stale.id), /fonte mudou/);
    assert.equal(sent.length, 1);
    const slide = await writes.prepare(mcp, connection.id, add);
    assert.equal((await approve(slide)).status, 200);
    assert.equal((await writes.execute(mcp, slide.id)).state, "succeeded");
    assert.equal(sent[1].body.writeControl.requiredRevisionId, "slides-rev-2");
    assert.deepEqual(
      sent[1].body.requests.map((request: Record<string, unknown>) => Object.keys(request)[0]),
      ["createSlide", "createShape", "insertText"],
    );
    assert.equal(sent[1].body.requests[1].createShape.elementProperties.pageObjectId, add.slide_id);
    assert.equal(sent[1].body.requests[2].insertText.objectId, add.text_id);
    assert.equal(sent[1].body.requests[2].insertText.text, add.text);
    const uncertain = await writes.prepare(mcp, connection.id, {
      ...add,
      slide_id: "arahub_other_slide",
      text_id: "arahub_other_text",
    });
    await approve(uncertain);
    wrongReceipt = true;
    assert.equal((await writes.execute(mcp, uncertain.id)).state, "uncertain");
    assert.equal((await writes.execute(mcp, uncertain.id)).state, "uncertain");
    assert.equal(sent.length, 3);
  } finally {
    await db.end();
  }
});
