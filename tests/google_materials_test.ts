import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { GoogleMaterials } from "../src/google_materials.ts";
import type { GoogleConnections } from "../src/google_connections.ts";
import { asOwner } from "../src/db.ts";

Deno.test("A02 A07 A23: snapshot nativo conserva abas/tabelas/slides/fórmulas, seleção, versões e leitura offline por dono", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  let unavailable = false, wrongSource = false, changeEpoch = false, calls = 0;
  const document = {
    documentId: "native-doc",
    title: "Documento sintético",
    revisionId: "rev-1",
    tabs: [{
      tabProperties: { tabId: "tab-1" },
      documentTab: {
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: "Parágrafo com á 😀\n" } }] } },
            {
              table: {
                tableRows: [{
                  tableCells: [{
                    content: [{
                      paragraph: { elements: [{ textRun: { content: "Célula preservada" } }] },
                    }],
                  }],
                }],
              },
            },
          ],
        },
      },
    }, {
      tabProperties: { tabId: "tab-2" },
      documentTab: {
        body: { content: [{ paragraph: { elements: [{ textRun: { content: "Outra aba" } }] } }] },
      },
    }],
    "a/b~c": { text: "Escapado" },
  };
  const spreadsheet = {
    spreadsheetId: "native-sheet",
    properties: { title: "Planilha sintética" },
    sheets: [{
      properties: { sheetId: 7, title: "Dados" },
      data: [{
        rowData: [{
          values: [{
            userEnteredValue: { formulaValue: "=SUM(A2:A3)" },
            effectiveValue: { numberValue: 5 },
            formattedValue: "5",
          }],
        }],
      }],
    }],
  };
  const presentation = {
    presentationId: "native-slides",
    title: "Apresentação sintética",
    revisionId: "rev-2",
    slides: [{
      objectId: "slide-1",
      pageElements: [{
        objectId: "shape-1",
        shape: { text: { textElements: [{ textRun: { content: "Texto do slide" } }] } },
      }],
    }],
  };
  const source = async (kind: string, connectionId: string) => {
    calls++;
    if (unavailable) throw new Error("Synthetic source unavailable");
    if (changeEpoch) {
      await db`update public.hub_connections set oauth_epoch=oauth_epoch+1 where id=${connectionId}`;
    }
    return wrongSource ? { documentId: "another-doc" } : structuredClone(
      kind === "document" ? document : kind === "spreadsheet" ? spreadsheet : presentation,
    );
  };
  const google = {
    client: (_: unknown, connectionId: string) =>
      Promise.resolve({
        getDocument: () => source("document", connectionId),
        getSpreadsheet: () => source("spreadsheet", connectionId),
        getPresentation: () => source("presentation", connectionId),
      }),
  } as unknown as GoogleConnections;
  const material = new GoogleMaterials(hub, google), offline = new GoogleMaterials(hub);
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const connections = [];
    for (const owner of [a, b]) {
      const conn = await hub.connect(owner, "google", "Conta sintética", null, owner.ownerId);
      await db`update public.hub_connections set state='connected',desired_scopes=${
        db.array(["https://www.googleapis.com/auth/drive.readonly"])
      },granted_scopes=${
        db.array(["https://www.googleapis.com/auth/drive.readonly"])
      } where id=${conn.id}`;
      connections.push(conn.id);
    }
    const receipt = await material.preserve(a, connections[0], {
      kind: "document",
      resource_id: "native-doc",
    });
    const file = receipt.memory_commit;
    assert.equal(
      (await material.preserve(a, connections[0], { kind: "document", resource_id: "native-doc" }))
        .memory_commit.id,
      file.id,
    );
    const full = await offline.read(a, file.id, file.sha256);
    assert.deepEqual(full.result, document);
    assert.equal(full.snapshot_coverage, "complete");
    const page = await offline.read(
      a,
      file.id,
      file.sha256,
      "/tabs/0/documentTab/body/content",
      0,
      1,
    );
    assert.equal(page.next_offset, 1);
    assert.equal(page.coverage, "partial");
    assert.deepEqual(
      (await offline.read(a, file.id, file.sha256, "/tabs/0/documentTab/body/content", 1, 1))
        .result,
      [document.tabs[0].documentTab.body.content[1]],
    );
    assert.equal((await offline.read(a, file.id, file.sha256, "/a~1b~0c/text")).result, "Escapado");
    await assert.rejects(offline.read(a, file.id, file.sha256, "/tabs/length"), /Índice/);
    await assert.rejects(offline.read(a, file.id, file.sha256, "/constructor"), /ausente/);
    await assert.rejects(offline.read(b, file.id, file.sha256), /encontrado/);
    await assert.rejects(offline.read(a, file.id, "b".repeat(64)), /hash/);
    unavailable = true;
    const priorCalls = calls;
    assert.deepEqual((await offline.read(a, file.id, file.sha256)).result, document);
    assert.equal(calls, priorCalls);
    await assert.rejects(
      material.preserve(a, connections[0], { kind: "document", resource_id: "native-doc" }),
    );
    unavailable = false;
    wrongSource = true;
    await assert.rejects(
      material.preserve(a, connections[0], { kind: "document", resource_id: "native-doc" }),
      /recurso escolhido/,
    );
    wrongSource = false;
    const sheet = await material.preserve(a, connections[0], {
      kind: "spreadsheet",
      resource_id: "native-sheet",
      ranges: ["Dados!A1"],
    });
    assert.deepEqual(
      (await offline.read(a, sheet.memory_commit.id, sheet.memory_commit.sha256)).result,
      spreadsheet,
    );
    assert.equal(sheet.source_refresh.coverage, "partial");
    const otherRange = await material.preserve(a, connections[0], {
      kind: "spreadsheet",
      resource_id: "native-sheet",
      ranges: ["Dados!A1:A2"],
    });
    assert.notEqual(otherRange.memory_commit.sha256, sheet.memory_commit.sha256);
    const slide = await material.preserve(a, connections[0], {
      kind: "presentation",
      resource_id: "native-slides",
    });
    assert.deepEqual(
      (await offline.read(a, slide.memory_commit.id, slide.memory_commit.sha256, "/slides", 0, 1))
        .result,
      presentation.slides,
    );
    const bFile = await material.preserve(b, connections[1], {
      kind: "document",
      resource_id: "native-doc",
    });
    assert.notEqual(bFile.memory_commit.id, file.id);
    document.revisionId = "rev-3";
    const newer = await material.preserve(a, connections[0], {
      kind: "document",
      resource_id: "native-doc",
    });
    assert.notEqual(newer.memory_commit.id, file.id);
    assert.equal((await offline.read(a, file.id, file.sha256)).provenance.revision, "rev-1");
    changeEpoch = true;
    await assert.rejects(
      material.preserve(a, connections[0], { kind: "document", resource_id: "native-doc" }),
      /conexão mudou/,
    );
    const [total] =
      await db`select count(*)::integer as count from public.hub_files where owner_id=${a.ownerId}`;
    assert.equal(total.count, 5);
    await db`update public.hub_files set binary_content=${new Uint8Array([
      1,
      2,
    ])} where owner_id=${a.ownerId} and id=${file.id}`;
    await assert.rejects(offline.read(a, file.id, file.sha256), /bytes/);
  } finally {
    await db.end();
  }
});

Deno.test("A05 A23: partes nativas extensas paginam sem corte silencioso; bytes, Unicode e lock permanecem protegidos", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  const native = {
    documentId: "large-doc",
    title: "Grande sintético",
    emoji: "😀a",
    namedRanges: {} as Record<string, { text: string }>,
    body: {
      content: Array.from({ length: 20 }, (_, index) => ({ index, text: "x".repeat(14000) })),
    },
  };
  const google = {
    client: () => Promise.resolve({ getDocument: () => Promise.resolve(native) }),
  } as unknown as GoogleConnections;
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const connection = await hub.connect(owner, "google", "Conta sintética", null, "large-source");
    await db`update public.hub_connections set state='connected',desired_scopes=${
      db.array(["https://www.googleapis.com/auth/drive.readonly"])
    },granted_scopes=${
      db.array(["https://www.googleapis.com/auth/drive.readonly"])
    } where id=${connection.id}`;
    await assert.rejects(
      asOwner(db, other, (tx) => tx`select current_user`, { lockConnection: connection.id }),
      /encontrada/,
    );
    const [role] = await asOwner(db, owner, (tx) => tx`select current_user as role`, {
      lockConnection: connection.id,
    });
    assert.equal(role.role, "authenticated");
    await assert.rejects(
      asOwner(
        db,
        owner,
        (tx) => tx`update public.hub_connections set label='forbidden' where id=${connection.id}`,
        {
          lockConnection: connection.id,
        },
      ),
      /concluir/,
    );
    const material = new GoogleMaterials(hub, google), offline = new GoogleMaterials(hub);
    const receipt = (await material.preserve(owner, connection.id, {
      kind: "document",
      resource_id: "large-doc",
    })).memory_commit;
    const root = await offline.read(owner, receipt.id, receipt.sha256);
    assert.equal(root.result, null);
    assert.equal(root.coverage, "partial");
    assert.ok(root.children.includes("body"));
    let offset: number | null = 0;
    const recovered: unknown[] = [];
    while (offset !== null) {
      const part = await offline.read(
        owner,
        receipt.id,
        receipt.sha256,
        "/body/content",
        offset,
        20,
      );
      assert.ok(new TextEncoder().encode(JSON.stringify(part.result)).length <= 128 * 1024);
      recovered.push(...part.result as unknown[]);
      offset = part.next_offset;
    }
    assert.deepEqual(recovered, native.body.content);
    const emoji = await offline.read(owner, receipt.id, receipt.sha256, "/emoji", 0, 1);
    assert.equal(emoji.result, "😀");
    assert.equal(emoji.next_offset, 2);
    assert.equal(
      (await offline.read(owner, receipt.id, receipt.sha256, "/emoji", 2, 1)).result,
      "a",
    );
    await assert.rejects(offline.read(owner, receipt.id, receipt.sha256, "/emoji", 1, 1), /UTF-16/);
    native.body.content[10].text = "x".repeat(140000);
    const largeChild = (await material.preserve(owner, connection.id, {
      kind: "document",
      resource_id: "large-doc",
    })).memory_commit;
    const narrowed = await offline.read(
      owner,
      largeChild.id,
      largeChild.sha256,
      "/body/content",
      10,
      1,
    );
    assert.equal(narrowed.result, null);
    assert.deepEqual(narrowed.children, ["10"]);
    assert.equal(
      (await offline.read(owner, largeChild.id, largeChild.sha256, "/body/content/10/text", 0, 20))
        .result,
      "x".repeat(20),
    );
    native.namedRanges = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [
        "range/" + index,
        { text: "x".repeat(1000) },
      ]),
    );
    const manyKeys = (await material.preserve(owner, connection.id, {
      kind: "document",
      resource_id: "large-doc",
    })).memory_commit;
    const keys: string[] = [];
    let childOffset: number | null = 0;
    while (childOffset !== null) {
      const part = await offline.read(
        owner,
        manyKeys.id,
        manyKeys.sha256,
        "/namedRanges",
        0,
        undefined,
        childOffset,
      );
      assert.equal(part.result, null);
      assert.equal(part.children_count, 205);
      keys.push(...part.children);
      childOffset = part.children_next_offset;
    }
    assert.deepEqual(keys, Object.keys(native.namedRanges));
    assert.equal(
      (await offline.read(owner, manyKeys.id, manyKeys.sha256, "/namedRanges/range~1204/text"))
        .result,
      "x".repeat(1000),
    );
    await assert.rejects(
      offline.read(owner, manyKeys.id, manyKeys.sha256, "/namedRanges", 0, undefined, 206),
      /filhos disponíveis/,
    );
    await assert.rejects(
      offline.read(owner, manyKeys.id, manyKeys.sha256, "/emoji", 0, undefined, 1),
      /filhos disponíveis/,
    );
    native.body.content[0].text = "x".repeat(8 * 1024 * 1024);
    await assert.rejects(
      material.preserve(owner, connection.id, { kind: "document", resource_id: "large-doc" }),
      /8 MiB/,
    );
    const [count] =
      await db`select count(*)::integer as files from public.hub_files where owner_id=${owner.ownerId}`;
    assert.equal(count.files, 3);
  } finally {
    await db.end();
  }
});
