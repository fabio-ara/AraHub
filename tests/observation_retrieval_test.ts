import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";

const LOCAL_DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";

Deno.test("observações Moodle: versões paginadas, corpo por trechos e isolamento", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const conn = await hub.connect(
      owner,
      "moodle",
      "Moodle sintético",
      null,
      "observation-fixture",
    );
    const entity = await hub.entity(owner, conn.id, "module", "moodle:course/1/module/9", "Módulo");
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const content = {
        section_id: i < 12 ? 1 : 2,
        text: i === 22 ? "A".repeat(19000) : `versão ${i}`,
      };
      const observedAt = `2026-10-06T00:00:00.${String(i).padStart(6, "0")}Z`;
      const row = await asOwner(db, owner, async (tx) => {
        const inserted =
          await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
          values(${owner.ownerId},${entity.id},${tx.json(content)},${`synthetic-hash-${i}`},${
            tx.json({ system: "synthetic", locator: "fixture:module/9" })
          },'complete',${observedAt}::text::timestamptz) returning id`;
        return inserted[0];
      });
      ids.push(row.id);
    }
    const first = await hub.observations(owner, entity.id);
    assert.equal(first.records.length, 20);
    assert.equal(first.records[0].id, ids[22]);
    assert.equal(first.next_cursor?.id, ids[3]);
    assert.equal(first.next_cursor?.observed_at, "2026-10-06T00:00:00.000003Z");
    const last = await hub.observations(owner, entity.id, first.next_cursor!);
    assert.deepEqual(last.records.map((r) => r.id), [ids[2], ids[1], ids[0]]);
    assert.equal(last.next_cursor, null);
    const chunks: string[] = [];
    let offset = 0;
    do {
      const part = await hub.observationText(owner, ids[22], offset, 8000);
      assert.equal(part.entity_id, entity.id);
      assert.equal(part.text_format, "jsonb_serialization");
      chunks.push(part.excerpt);
      if (part.next_offset === null) break;
      offset = part.next_offset;
    } while (true);
    assert.deepEqual(JSON.parse(chunks.join("")), { section_id: 2, text: "A".repeat(19000) });
    await assert.rejects(hub.observations(other, entity.id), /não encontrado/);
    await assert.rejects(hub.observationText(other, ids[22]), /não encontrado/);
    assert.throws(() => hub.observationText(owner, ids[22], -1), /Trecho inválido/);
  } finally {
    await db`delete from auth.users where id in (${owner.ownerId},${other.ownerId})`;
    await db.end();
  }
});

Deno.test("ocorrências: A→B→A preserva três ocorrências, deduplica bytes e isola por dono", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Moodle sintético", null, "occurrence-fixture");
    const entity = await hub.entity(
      owner,
      conn.id,
      "module",
      "moodle:course/1/module/11",
      "Módulo",
      { provider_record: { v: "A" } },
    );
    const write = (content: { v: string }, hash: string, observedAt: string) =>
      asOwner(db, owner, async (tx) =>
        (await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
          values(${owner.ownerId},${entity.id},${tx.json(content)},${hash},${tx.json({ system: "synthetic", locator: "fixture:module/11" })},'complete',${observedAt}::text::timestamptz)
          on conflict(owner_id,entity_id,content_hash) do nothing returning id`)[0] ?? null);
    const first = await write({ v: "A" }, "hash-A", "2026-10-01T00:00:00Z");
    const second = await write({ v: "B" }, "hash-B", "2026-10-02T00:00:00Z");
    const revisit = await write({ v: "A" }, "hash-A", "2026-10-03T00:00:00Z");
    assert.ok(first?.id);
    assert.ok(second?.id);
    // A revisita não cria novo snapshot, mas registra nova ocorrência temporal.
    assert.equal(revisit, null);
    const timeline = await asOwner(db, owner, async (tx) =>
      await tx`select content_id,content_hash,observed_at from public.hub_observation_timeline
        where owner_id=${owner.ownerId} and entity_id=${entity.id}
        order by observed_at desc,id desc`);
    assert.equal(timeline.length, 3);
    assert.deepEqual(timeline.map((row) => row.content_hash), ["hash-A", "hash-B", "hash-A"]);
    assert.equal(
      new Date(timeline[0].observed_at as string).toISOString(),
      "2026-10-03T00:00:00.000Z",
    );
    assert.equal(
      new Date(timeline[1].observed_at as string).toISOString(),
      "2026-10-02T00:00:00.000Z",
    );
    // As duas ocorrências de A apontam para o mesmo snapshot deduplicado.
    assert.equal(timeline[0].content_id, timeline[2].content_id);
    const snapshots = await asOwner(db, owner, async (tx) =>
      await tx`select count(*)::int as n from public.hub_observations
        where owner_id=${owner.ownerId} and entity_id=${entity.id}`);
    assert.equal(snapshots[0].n, 2);

    // Leitura pela timeline: três versões, mais recente primeiro, com content_id.
    const page = await hub.observations(owner, entity.id);
    assert.equal(page.records.length, 3);
    assert.equal(page.records[0].content_hash, "hash-A");
    assert.equal(
      new Date(page.records[0].observed_at as string).toISOString(),
      "2026-10-03T00:00:00.000Z",
    );
    assert.equal(page.records[0].content_id, page.records[2].content_id);
    assert.equal(page.next_cursor, null);
    const text = await hub.observationText(owner, page.records[0].id as string, 0, 200);
    assert.deepEqual(JSON.parse(text.excerpt), { v: "A" });

    // Diagnóstico de ABA: a última ocorrência é o conteúdo vigente e não há
    // alteração de estado sem ocorrência correspondente.
    const context = await hub.entityContext(owner, entity.id);
    assert.equal(context.observations.length, 3);
    assert.equal(context.source_projection.matches_latest_occurrence, true);
    assert.equal(context.source_projection.unrecorded_change_detected, false);
    assert.equal(
      new Date(context.last_observed_at.value as string).toISOString(),
      new Date(page.records[0].observed_at as string).toISOString(),
    );
    assert.equal(
      new Date(context.last_observed_at.value as string).toISOString(),
      "2026-10-03T00:00:00.000Z",
    );
    assert.equal(context.last_observed_at.precision, "recorded");
    assert.deepEqual(context.gaps, []);

    // Retry idêntico (mesmo hash e mesmo instante) não duplica a ocorrência.
    await write({ v: "A" }, "hash-A", "2026-10-03T00:00:00Z");
    const afterRetry = await asOwner(db, owner, async (tx) =>
      await tx`select count(*)::int as n from public.hub_observation_timeline
        where owner_id=${owner.ownerId} and entity_id=${entity.id}`);
    assert.equal(afterRetry[0].n, 3);

    // Isolamento: outro dono não alcança a entidade nem a ocorrência.
    await assert.rejects(hub.observations(other, entity.id), /não encontrado/);
    await assert.rejects(
      hub.observationText(other, page.records[0].id as string),
      /não encontrado/,
    );
    const foreignTimeline = await asOwner(db, other, async (tx) =>
      await tx`select count(*)::int as n from public.hub_observation_timeline
        where owner_id=${other.ownerId} and entity_id=${entity.id}`);
    assert.equal(foreignTimeline[0].n, 0);
  } finally {
    await db`delete from auth.users where id in (${owner.ownerId},${other.ownerId})`;
    await db.end();
  }
});

Deno.test("ocorrências: escritas concorrentes na mesma entidade preservam ambas", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Moodle sintético", null, "concurrency-fixture");
    const entity = await hub.entity(owner, conn.id, "module", "moodle:course/1/module/12", "Módulo");
    const write = (hash: string, observedAt: string) =>
      asOwner(db, owner, async (tx) =>
        await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
          values(${owner.ownerId},${entity.id},${tx.json({ hash })},${hash},${tx.json({ system: "synthetic", locator: "fixture:module/12" })},'complete',${observedAt}::text::timestamptz)
          on conflict(owner_id,entity_id,content_hash) do nothing`);
    const results = await Promise.allSettled([
      write("hash-c1", "2026-10-04T00:00:00Z"),
      write("hash-c2", "2026-10-05T00:00:00Z"),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    const rows = await asOwner(db, owner, async (tx) =>
      await tx`select content_hash from public.hub_observation_timeline
        where owner_id=${owner.ownerId} and entity_id=${entity.id}
        order by observed_at`);
    assert.deepEqual(rows.map((row) => row.content_hash), ["hash-c1", "hash-c2"]);
  } finally {
    await db`delete from auth.users where id=${owner.ownerId}`;
    await db.end();
  }
});

Deno.test("OAuth: claims com client_id não alcançam memória, ocorrências nem aprovação por SQL direto", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Moodle sintético", null, "oauth-fixture");
    const entity = await hub.entity(owner, conn.id, "module", "moodle:course/1/module/13", "Módulo");
    await asOwner(db, owner, async (tx) => {
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
        values(${owner.ownerId},${entity.id},${tx.json({ v: "oauth" })},'hash-oauth',${tx.json({ system: "synthetic", locator: "fixture:module/13" })},'complete',now())`;
    });
    await db`insert into public.hub_actions(owner_id,connection_id,operation,target,snapshot,content_hash,state)
      values(${owner.ownerId},${conn.id},'moodle.assignment.submit','1/2/3','{}',encode(extensions.digest('{}','sha256'),'hex'),'succeeded')`;

    // Sessão construída à mão: asOwner grava claims vazios e não exercita este gate.
    const session = (claims: Record<string, unknown>) =>
      db.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub',${owner.ownerId},true)`;
        await tx`select set_config('request.jwt.claims',${JSON.stringify(claims)},true)`;
        await tx`set local role authenticated`;
        const rows = await tx`select
          (select count(*)::int from public.hub_entities) as entities,
          (select count(*)::int from public.hub_observations) as observations,
          (select count(*)::int from public.hub_observation_occurrences) as occurrences,
          (select count(*)::int from public.hub_observation_timeline) as timeline,
          (select count(*)::int from public.hub_context_targets) as targets,
          (select count(*)::int from public.hub_actions) as actions,
          (select count(*)::int from public.hub_action_approvals) as approvals`;
        return rows[0] as Record<string, number>;
      });

    // Sessão MCP verificada (sem client_id) enxerga apenas o próprio dono.
    const verified = await session({});
    assert.equal(verified.entities, 1);
    assert.equal(verified.observations, 1);
    assert.equal(verified.occurrences, 1);
    assert.equal(verified.timeline, 1);
    assert.equal(verified.actions, 1);

    // Token OAuth com client_id não enxerga nada, nem pela view da timeline.
    const oauth = await session({ client_id: "oauth-client" });
    assert.equal(oauth.entities, 0);
    assert.equal(oauth.observations, 0);
    assert.equal(oauth.occurrences, 0);
    assert.equal(oauth.timeline, 0);
    assert.equal(oauth.targets, 0);
    assert.equal(oauth.actions, 0);
    assert.equal(oauth.approvals, 0);

    // Nem escrever: não há grant de INSERT no limite de aprovação, e o INSERT de
    // observação cai na policy que exige client_id nulo.
    await assert.rejects(
      db.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub',${owner.ownerId},true)`;
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ client_id: "oauth-client" })},true)`;
        await tx`set local role authenticated`;
        await tx`insert into public.hub_actions(owner_id,connection_id,operation,target,snapshot,content_hash)
          values(${owner.ownerId},${conn.id},'moodle.assignment.submit','9/9/9','{}',encode(extensions.digest('{}','sha256'),'hex'))`;
      }),
      /permission denied|violates row-level security/i,
    );
    await assert.rejects(
      db.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub',${owner.ownerId},true)`;
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ client_id: "oauth-client" })},true)`;
        await tx`set local role authenticated`;
        await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage)
          values(${owner.ownerId},${entity.id},'{"v":"x"}','hash-oauth-2','{}','complete')`;
      }),
      /violates row-level security/i,
    );
    // Nenhuma das tentativas recusadas deixou linha nova.
    const actions = await db`select count(*)::int as n from public.hub_actions where owner_id=${owner.ownerId}`;
    assert.equal(actions[0].n, 1);
    const occurrences = await db`select count(*)::int as n from public.hub_observation_occurrences where owner_id=${owner.ownerId}`;
    assert.equal(occurrences[0].n, 1);
  } finally {
    await db`delete from auth.users where id=${owner.ownerId}`;
    await db.end();
  }
});
