import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { importStaging, stableUuid } from "../src/importer.ts";
import { gitBlobId, stageRepository, writeCuration } from "../src/migration.ts";

Deno.test("administrative import retries without granting connection UPDATE or crossing owners", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  const source = "fixture-" + crypto.randomUUID();
  const path = ".private/migration/test/import-" + crypto.randomUUID();
  const bytes = new TextEncoder().encode("# Synthetic source\nA draft is not a submission.\n");
  const blob = await gitBlobId(bytes), commit = "2".repeat(40);
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const git = {
      head: () => Promise.resolve({ commit, branch: "main" }),
      tree: () =>
        Promise.resolve([{
          path: "note.md",
          mode: "100644",
          type: "blob" as const,
          sha: blob,
          size: bytes.length,
        }]),
      blob: () => Promise.resolve(bytes),
      isClean: () => Promise.resolve(true),
    };
    const staged = await stageRepository("synthetic", path, { git, sourceLabel: source });
    await writeCuration(path, {
      schema: "arahub.migration.v1",
      batchId: staged.batchId,
      commit,
      generatedAtUtc: new Date().toISOString(),
      records: [{
        id: "cur:draft",
        domain: "Synthetic study",
        kind: "fact",
        epistemic: "observed",
        assertion: "The source describes a draft, not a submission.",
        refs: [{ path: "note.md", commit, lines: "2", excerpt: "A draft is not a submission." }],
      }],
    });
    await stageRepository("synthetic", path, { git, sourceLabel: source });
    const [permission] =
      await db`select has_table_privilege('authenticated','public.hub_connections','UPDATE') as allowed`;
    assert.equal(permission.allowed, false);
    const hub = new Hub(db), first = await importStaging(hub, a, path);
    assert.equal(first.files, 1);
    assert.equal(first.records, 1);
    const replay = await importStaging(hub, a, path);
    assert.equal(replay.records, 0);
    assert.equal(replay.reused, 1);
    assert.equal((await hub.context(b)).contexts.length, 0);
    const [file] =
      await db`select binary_content from public.hub_files where owner_id=${a.ownerId}`;
    assert.deepEqual(new Uint8Array(file.binary_content), bytes);
    // Even a crafted global ID collision may not modify another owner's row.
    const collision = await stableUuid(`${b.ownerId}:migration:${source}`);
    await db`insert into public.hub_connections(id,owner_id,provider,label,provider_subject) values(${collision},${a.ownerId},'migration','Protected original','different-source')`;
    await assert.rejects(importStaging(hub, b, path), /Conexão de migração divergente/);
    const [kept] =
      await db`select label,provider_subject from public.hub_connections where id=${collision}`;
    assert.equal(kept.label, "Protected original");
    assert.equal(kept.provider_subject, "different-source");
    const [after] =
      await db`select has_table_privilege('authenticated','public.hub_connections','UPDATE') as allowed`;
    assert.equal(after.allowed, false);
  } finally {
    await db`delete from public.hub_connections where owner_id in (${a.ownerId},${b.ownerId})`;
    await db`delete from auth.users where id in (${a.ownerId},${b.ownerId})`;
    await db.end();
  }
});
