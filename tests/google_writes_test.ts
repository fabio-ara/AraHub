import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { PersistentActionStore } from "../src/approval_store.ts";
import { GoogleWrites } from "../src/google_writes.ts";
import type { GoogleConnections } from "../src/google_connections.ts";
import { createHandler } from "../src/http.ts";

Deno.test("A02 A21 A22: produção nativa fixada, aprovação HTTP humana, revisão e envio único", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db);
  const browser = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() },
    mcp = { ...browser, clientId: "approved-fixture" },
    other = { ownerId: crypto.randomUUID() };
  let revision = "rev-1", calls = 0, fail = false, reads = 0;
  const store = new PersistentActionStore(db, {
    sessionActive: (o, s) => Promise.resolve(o === browser.ownerId && s === browser.sessionId),
  });
  const fixture = {
    client: () =>
      Promise.resolve({
        getDocument: () => {
          reads++;
          return Promise.resolve({ documentId: "doc-1", revisionId: revision });
        },
        getPresentation: () =>
          Promise.resolve({ presentationId: "slides-1", revisionId: revision }),
      }),
    tokens: () =>
      Promise.resolve({
        access_token: "synthetic-provider-token",
        expires_at: Date.now() + 60000,
        token_type: "Bearer",
      }),
  } as unknown as GoogleConnections;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.ok(String(input).startsWith("https://docs.googleapis.com/v1/documents/"));
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer synthetic-provider-token",
    );
    assert.equal(init?.redirect, "manual");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.writeControl.requiredRevisionId, "rev-1");
    const pending =
      await db`select state from public.hub_actions where owner_id=${browser.ownerId} order by created_at desc limit 1`;
    assert.equal(pending[0].state, "uncertain");
    if (fail) throw new Error("Synthetic post-send timeout");
    return Response.json({ documentId: "doc-1" });
  };
  const writes = new GoogleWrites(hub, fixture, store, fetcher);
  const handler = createHandler(hub, {
    auth: { issuer: "https://identity.invalid/auth", resource: "https://hub.invalid/mcp" },
    publicUrl: "https://hub.invalid",
    actions: store,
    verify: (req) =>
      Promise.resolve(req.headers.get("Authorization") === "Bearer mcp" ? mcp : browser),
  });
  const approve = (
    action: { id: string; hash: string },
    credential = "browser",
    hash = action.hash,
  ) =>
    handler(
      new Request("https://hub.invalid/api/actions/approve", {
        method: "POST",
        headers: { Origin: "https://hub.invalid", Authorization: `Bearer ${credential}` },
        body: JSON.stringify({ action_id: action.id, content_hash: hash }),
      }),
    );
  try {
    await db`insert into auth.users(id) values(${browser.ownerId}),(${other.ownerId})`;
    const conn = await hub.connect(
      browser,
      "google",
      "Produção sintética",
      null,
      "subject-fixture",
    );
    const scope = "https://www.googleapis.com/auth/documents";
    await db`update public.hub_connections set state='connected',desired_scopes=${
      db.array([scope])
    },granted_scopes=${db.array([scope])} where owner_id=${browser.ownerId} and id=${conn.id}`;
    const action = await writes.prepare(mcp, conn.id, {
      operation: "docs_insert_text",
      resource_id: "doc-1",
      index: 1,
      text: "Versão escolhida",
    });
    assert.equal(action.revision, "rev-1");
    assert.equal(calls, 0);
    assert.equal((await approve(action, "mcp")).status, 403);
    assert.equal((await approve(action, "browser", "0".repeat(64))).status, 409);
    await assert.rejects(writes.execute(mcp, action.id), /Autorize/);
    assert.equal(calls, 0);
    assert.equal((await approve(action)).status, 200);
    revision = "rev-changed";
    await assert.rejects(writes.execute(mcp, action.id), /fonte mudou/);
    assert.equal(calls, 0);
    revision = "rev-1";
    const outcomes = await Promise.allSettled([
      writes.execute(mcp, action.id),
      writes.execute(mcp, action.id),
    ]);
    assert.ok(outcomes.some((x) => x.status === "fulfilled" && x.value.state === "succeeded"));
    assert.equal(calls, 1);
    assert.equal((await writes.execute(mcp, action.id)).state, "succeeded");
    await assert.rejects(writes.execute(other, action.id), /não encontrada/);
    const uncertain = await writes.prepare(mcp, conn.id, {
      operation: "docs_insert_text",
      resource_id: "doc-1",
      index: 1,
      text: "Outra versão",
    });
    await approve(uncertain);
    fail = true;
    assert.equal((await writes.execute(mcp, uncertain.id)).state, "uncertain");
    const readCount = reads;
    assert.equal((await writes.execute(mcp, uncertain.id)).state, "uncertain");
    assert.equal(reads, readCount);
    assert.equal(calls, 2);
    await assert.rejects(
      writes.prepare(mcp, conn.id, { operation: "sheets_create", title: "Planilha" }),
      /capacidade de edição/,
    );
  } finally {
    await db.end();
  }
});
