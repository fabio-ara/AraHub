import assert from "node:assert/strict";
import { Jobs } from "../src/jobs.ts";
import { Hub } from "../src/domain.ts";
import { createDb } from "../src/db.ts";
import {
  type ApprovalAuthority,
  executeAction,
  prepareAction,
  studyPackage,
} from "../src/production.ts";
Deno.test("A02 A18 A30: jobs recuperáveis, lease exclusivo e cursor só após cobertura completa", async () => {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub"),
    hub = new Hub(db),
    jobs = new Jobs(db),
    a = { ownerId: crypto.randomUUID() },
    b = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
    const c = await hub.connect(a, "moodle", "Fixture", "https://fixture.invalid", "1");
    const j = await jobs.enqueue(a, c.id, "courses");
    await assert.rejects(jobs.enqueue(b, c.id, "courses"));
    assert.equal((await jobs.list(b)).length, 0);
    const claimed = await Promise.all([jobs.claim(a), jobs.claim(a)]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const first = claimed.find(Boolean)!;
    const partial = await jobs.finish(a, j.id, first.attempts, "partial", {
      next: "must-not-advance",
    });
    assert.equal(partial.cursor, null);
    const second = (await jobs.claim(a))!;
    await assert.rejects(jobs.finish(a, j.id, first.attempts, "complete", { next: "bad" }));
    const done = await jobs.finish(a, j.id, second.attempts, "complete", { next: "durable" });
    assert.deepEqual(done.cursor, { next: "durable" });
    assert.equal(await jobs.claim(a), null);
  } finally {
    await db.end();
  }
});
Deno.test("A05 A22 A24: aprovação independente, conteúdo fixado e timeout sem reenvio", async () => {
  const actor = { ownerId: crypto.randomUUID() },
    action = prepareAction(actor, "c", "gmail.send", "recipient-fixture", null, {
      text: "Mensagem",
    });
  let calls = 0;
  let saved: { state: "succeeded" | "uncertain"; externalId?: string } | null = null;
  const denied: ApprovalAuthority = {
    consume: () => Promise.resolve(null),
    persistResult: () => Promise.resolve(),
    result: () => Promise.resolve(null),
  };
  await assert.rejects(
    executeAction(actor, action, denied, () => {
      calls++;
      return Promise.resolve({ externalId: "1" });
    }),
    /Autorize/,
  );
  assert.equal(calls, 0);
  const trusted: ApprovalAuthority = {
    consume: () =>
      Promise.resolve({
        actionId: action.id,
        ownerId: actor.ownerId,
        hash: action.hash,
        source: "trusted_ui",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    persistResult: (_a, r) => {
      saved = r;
      return Promise.resolve();
    },
    result: () => Promise.resolve(saved),
  };
  await assert.rejects(
    executeAction(
      actor,
      { ...action, content: { text: "Alterada" } },
      trusted,
      () => Promise.resolve({ externalId: "1" }),
    ),
    /mudou/,
  );
  const send = () => {
    calls++;
    return Promise.reject(new Error("timeout"));
  };
  assert.equal((await executeAction(actor, action, trusted, send)).state, "uncertain");
  assert.equal((await executeAction(actor, action, trusted, send)).state, "uncertain");
  assert.equal(calls, 1);
  const pack = studyPackage({ id: "a", instruction: "Enunciado" }, [{
    id: "m",
    role: "related",
    locator: "fixture:pdf:1",
    rights: "private",
  }], "Compreender o argumento");
  assert.equal(pack.read_status[0].status, "available_not_confirmed_read");
  assert.equal(pack.aralearn.creation_authorized, false);
});
