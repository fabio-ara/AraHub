import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { handleMcp } from "../src/mcp.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GoogleConnections } from "../src/google_connections.ts";

Deno.test("A02 A30: SDK consulta volumes reais por dono, preservando bytes UTF-8 e sem dados de outro dono", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  let server: Deno.HttpServer | undefined;
  const clients: Client[] = [];
  const connections = new Map<string, string>();
  const google = {
    client: () =>
      Promise.resolve({
        getDocument: () =>
          Promise.resolve({
            documentId: "usage-doc",
            title: "Documento SDK sintético",
            namedRanges: Object.fromEntries(
              Array.from({ length: 205 }, (_, index) => [
                "range-" + index,
                { content: "x".repeat(1000) },
              ]),
            ),
            body: {
              content: [{
                paragraph: { elements: [{ textRun: { content: "Conteúdo nativo persistido" } }] },
              }],
            },
          }),
      }),
  } as unknown as GoogleConnections;
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    await hub.createContext(a, "Uso sintético A");
    for (
      const [owner, binary, text] of [[a, Buffer.from([1, 2, 3]), "á\n"], [
        b,
        Buffer.alloc(1000),
        "Texto do outro dono",
      ]] as const
    ) {
      const connection = await hub.connect(owner, "google", "Conta sintética", null, owner.ownerId);
      connections.set(owner.ownerId, connection.id);
      await db`update public.hub_connections set state='connected',desired_scopes=${
        db.array(["https://www.googleapis.com/auth/drive.readonly"])
      },granted_scopes=${
        db.array(["https://www.googleapis.com/auth/drive.readonly"])
      } where id=${connection.id}`;
      const entity = await hub.entity(
        owner,
        connection.id,
        "resource",
        "same-external-id",
        "Mesmo nome",
        {},
      );
      await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text) values(${owner.ownerId},${entity.id},${"Mesmo nome"},${"application/octet-stream"},${
        "a".repeat(64)
      },${binary.length},${binary},${text})`;
    }
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 8789, onListen: () => {} },
      (req) =>
        handleMcp(
          req,
          hub,
          req.headers.get("Authorization") === "Bearer fixture-a" ? a : b,
          undefined,
          google,
        ),
    );
    for (
      const [identity, expected] of [["fixture-a", [1, "3", "3"]], ["fixture-b", [
        0,
        "1000",
        "19",
      ]]] as const
    ) {
      const client = new Client({ name: "usage-synthetic-client", version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8789/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${identity}` } },
        }),
      );
      const tools = await client.listTools();
      assert.equal(
        tools.tools.find((t: { name: string; annotations?: { readOnlyHint?: boolean } }) =>
          t.name === "hub_usage"
        )?.annotations?.readOnlyHint,
        true,
      );
      const result = await client.callTool({ name: "hub_usage", arguments: {} });
      assert.equal(result.isError, undefined);
      const view = JSON.parse((result.content as { text: string }[])[0].text);
      assert.equal(view.counts.contexts, expected[0]);
      assert.equal(view.counts.files, 1);
      assert.equal(view.storage.preserved_binary_bytes, expected[1]);
      assert.equal(view.storage.extracted_text_utf8_bytes, expected[2]);
      assert.equal(view.storage.measurement, "owner_logical_bytes");
      assert.ok(
        !JSON.stringify(view).includes(a.ownerId) && !JSON.stringify(view).includes(b.ownerId),
      );
      const ownerId = identity === "fixture-a" ? a.ownerId : b.ownerId;
      const saved = await client.callTool({
        name: "hub_preserve_google_material",
        arguments: {
          connection_id: connections.get(ownerId),
          material: { kind: "document", resource_id: "usage-doc" },
        },
      });
      assert.equal(saved.isError, undefined);
      const receipt = JSON.parse((saved.content as { text: string }[])[0].text).memory_commit;
      const part = await client.callTool({
        name: "hub_read_google_material",
        arguments: {
          file_id: receipt.id,
          sha256: receipt.sha256,
          pointer: "/body/content",
          limit: 1,
        },
      });
      assert.equal(part.isError, undefined);
      assert.ok(JSON.stringify(part.content).includes("Conteúdo nativo persistido"));
      const children = await client.callTool({
        name: "hub_read_google_material",
        arguments: {
          file_id: receipt.id,
          sha256: receipt.sha256,
          pointer: "/namedRanges",
          children_offset: 100,
        },
      });
      assert.equal(children.isError, undefined);
      const childPage = JSON.parse((children.content as { text: string }[])[0].text);
      assert.equal(childPage.children_count, 205);
      assert.equal(childPage.children_offset, 100);
      assert.equal(childPage.children_next_offset, 200);
      assert.equal(childPage.children[0], "range-100");
      assert.equal(childPage.children.at(-1), "range-199");
      const principal = { ownerId };
      const activity = await hub.entity(
        principal,
        connections.get(ownerId)!,
        "activity",
        "sdk-activity",
        "Atividade SDK",
        { instruction: "Estudar o material preservado sintético." },
      );
      await asOwner(
        db,
        principal,
        (tx) =>
          tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
          values(${ownerId},${activity.id},${receipt.entity_id},'required',${
            tx.json({ rights: "fixture private" })
          })`,
      );
      const packageResult = await client.callTool({
        name: "hub_study_package",
        arguments: { activity_id: activity.id, goal: "Estudar", offset: 0 },
      });
      assert.equal(packageResult.isError, undefined);
      const pack = JSON.parse((packageResult.content as { text: string }[])[0].text);
      assert.equal(pack.materials[0].id, receipt.entity_id);
      assert.equal(pack.materials[0].files[0].sha256, receipt.sha256);
      assert.equal(pack.materials[0].selection_required, false);
      assert.equal(pack.aralearn.creation_authorized, false);
      assert.equal(pack.read_status[0].status, "available_not_confirmed_read");
      const nextResult = await client.callTool({
        name: "hub_study_package",
        arguments: { activity_id: activity.id, goal: "Estudar", offset: 1 },
      });
      assert.equal(nextResult.isError, undefined);
      assert.deepEqual(
        JSON.parse((nextResult.content as { text: string }[])[0].text).materials,
        [],
      );
    }
  } finally {
    for (const client of clients) await client.close();
    await server?.shutdown();
    await db.end();
  }
});
