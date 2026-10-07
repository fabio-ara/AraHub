import assert from "node:assert/strict";
import {
  Artifacts,
  artifactType,
  hostFileSchema,
  MAX_ARTIFACT_BYTES,
  safeArtifactName,
} from "../src/artifacts.ts";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { HubError } from "../src/contracts.ts";

Deno.test("host file schema, byte identification and safe names", async () => {
  assert.deepEqual(
    hostFileSchema.parse({ download_url: "https://files.oaiusercontent.com/f", file_id: "file_1" }),
    { download_url: "https://files.oaiusercontent.com/f", file_id: "file_1" },
  );
  assert.throws(() =>
    hostFileSchema.parse({
      download_url: "https://files.oaiusercontent.com/f",
      file_id: "file_1",
      approved: true,
    })
  );
  assert.equal(safeArtifactName("..\\CON.pdf", "docx"), "arquivo.docx");
  assert.equal(safeArtifactName("../../versão final.exe", "pdf"), "versão final.pdf");
  assert.equal(
    (await artifactType(new TextEncoder().encode("%PDF-1.7\nsynthetic"))).mime,
    "application/pdf",
  );
  await assert.rejects(() => artifactType(new Uint8Array([0, 1, 2, 3])), HubError);
  await assert.rejects(
    () => artifactType(new TextEncoder().encode("<script>alert(1)</script>")),
    HubError,
  );
});
Deno.test("artifact private bytes port + host transport: isolation, idempotency, SSRF, redirect and no URL retention", async () => {
  const db = createDb(
      Deno.env.get("LOCAL_DATABASE_URL") ??
        "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub",
    ),
    hub = new Hub(db);
  const p = { ownerId: crypto.randomUUID() }, q = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${p.ownerId}),(${q.ownerId})`;
    const c = await hub.connect(p, "moodle", "Fixture", null, null, {}),
      context = await hub.createContext(p, "Synthetic");
    let requests = 0;
    const bytes = new TextEncoder().encode("Arquivo sintético, versão 1.");
    const receiver = new Artifacts(hub, {
      hosts: ["files.oaiusercontent.com"],
      resolve: () => Promise.resolve(["104.18.1.1"]),
      send: async (options) => {
        requests++;
        assert.equal(options.address, "104.18.1.1");
        assert.equal(options.headers.authorization, undefined);
        return { status: 200, bytes, contentType: "application/octet-stream" };
      },
    });
    const file = {
      download_url: "https://files.oaiusercontent.com/private?signature=SYNTHETIC_SECRET",
      file_id: "file_test",
      file_name: "../Versão.exe",
      mime_type: "image/png",
    };
    const a = await receiver.importHost(p, c.id, context.id, file),
      b = await receiver.importHost(p, c.id, context.id, file);
    assert.equal(a.id, b.id);
    assert.equal(a.mime, "text/plain");
    assert.equal(a.name, "Versão.txt");
    assert.deepEqual((await receiver.load(p, c.id, a.id)).content, bytes);
    const saved = await db`select state from public.hub_entities where owner_id=${p.ownerId}`;
    assert.ok(!JSON.stringify(saved).includes("SYNTHETIC_SECRET"));
    await assert.rejects(() => receiver.load(q, c.id, a.id), /não encontrado/);
    const before = requests;
    await assert.rejects(() => receiver.importHost(q, c.id, context.id, file));
    assert.equal(requests, before);
    for (
      const url of [
        "http://files.oaiusercontent.com/f",
        "https://evil.invalid/f",
        "https://files.oaiusercontent.com@127.0.0.1/f",
        "https://files.oaiusercontent.com:8443/f",
      ]
    ) {
      await assert.rejects(() =>
        receiver.importHost(p, c.id, context.id, { ...file, download_url: url })
      );
    }
    assert.equal(requests, before);
    const local = new Artifacts(hub, {
      hosts: ["files.oaiusercontent.com"],
      resolve: () => Promise.resolve(["127.0.0.1"]),
      send: async () => {
        throw Error("must not call");
      },
    });
    await assert.rejects(() => local.importHost(p, c.id, context.id, file), /não pública/);
    const redirect = new Artifacts(hub, {
      hosts: ["files.oaiusercontent.com"],
      resolve: () => Promise.resolve(["104.18.1.1"]),
      send: async () => ({ status: 302, bytes: new Uint8Array(), contentType: null }),
    });
    await assert.rejects(() => redirect.importHost(p, c.id, context.id, file), /expirado/);
    await assert.rejects(
      () =>
        receiver.preserve(p, c.id, context.id, new Uint8Array(MAX_ARTIFACT_BYTES + 1), {
          id: "big",
          name: "big.txt",
          system: "synthetic",
        }),
      /16 MiB/,
    );
  } finally {
    await db`delete from auth.users where id in (${p.ownerId},${q.ownerId})`;
    await db.end();
  }
});
