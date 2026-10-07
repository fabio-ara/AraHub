import assert from "node:assert/strict";
import type postgres from "postgres";
import { asOwner, createDb, type Db } from "../src/db.ts";
import { Attention } from "../src/attention.ts";
import { PersistentActionStore } from "../src/approval_store.ts";
import { Hub } from "../src/domain.ts";

const LOCAL_DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const NOW = "2026-10-10T00:00:00Z";
const DUE = Math.floor(Date.parse("2026-10-12T15:00:00Z") / 1000);
const CUTOFF = Math.floor(Date.parse("2026-10-16T15:00:00Z") / 1000);

interface ObRow {
  entity: { id: string; kind: string; title: string };
  requirement: { action: string; object: string | null };
  deadlines: Array<{
    field: string;
    label: string;
    observation_id: string | null;
    time: {
      kind: string;
      instant: string | null;
      reason?: string;
      displays?: Array<{ time_zone: string; local: string }>;
    };
  }>;
  deadline_summary: {
    overdue: number;
    upcoming: number;
    nearest: string | null;
    within_horizon: string | null;
  };
  requirements: Array<{
    requirement_key: string;
    action: string | null;
    quantity: { kind: unknown; at_least: unknown } | null;
    deadline: { original_text: unknown; date: unknown; hour_known: boolean } | null;
    source: { excerpt: unknown; observation_id: unknown; content_hash: unknown };
    versions: number;
  }>;
  requirement_deadlines: Array<{
    requirement_key: string;
    deadline: { date: unknown; hour_known: boolean } | null;
  }>;
  colleague_requirements: Array<{
    requirement_key: string;
    required_at_least: unknown;
    observed_distinct_colleagues: unknown;
    observed_meets_at_least: unknown;
  }>;
  colleagues: {
    subject_userid: string;
    distinct_colleagues: number;
    colleagues_answered_by_owner: number;
    observed_posts: number;
    owner_posts: number;
    basis: string;
  } | null;
  provenance: {
    observation_id: string | null;
    content_id: string | null;
    content_hash: string | null;
    coverage: string | null;
    observed_at: unknown;
  };
  state: {
    native_platform: { entity_completion: unknown; tracker: unknown };
    user_report: unknown;
    academic_actions: unknown[];
    submission_evidence: {
      user_report: boolean;
      confirmed_academic_action: boolean;
      native_completion: boolean;
    };
    drafts: Array<{ id: string; version: number }>;
    presented: { content_hash?: unknown } | null;
    read: { content_hash?: unknown } | null;
  };
  basis: string;
  gaps: string[];
}

function findOf(result: { obligations: unknown[] }, id: string): ObRow {
  const found = result.obligations.find((o) => (o as ObRow).entity.id === id) as ObRow | undefined;
  if (!found) throw new Error("obrigação não encontrada: " + id);
  return found;
}

function kindsOf(result: { attention: unknown[] }, id: string): string[] {
  return result.attention
    .filter((item) => (item as { entity_id: string }).entity_id === id)
    .map((item) => (item as { kind: string }).kind);
}

function observe(
  db: Db,
  ownerId: string,
  entityId: string,
  content: unknown,
  hash: string,
  observedAt: string,
) {
  return asOwner(db, { ownerId }, async (tx) => {
    const [source] =
      await tx`select connection_id from public.hub_entities where owner_id=${ownerId} and id=${entityId}`;
    await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
      values(${ownerId},${entityId},${tx.json(content as postgres.JSONValue)},${hash},${
      tx.json({
        system: "moodle",
        connection_id: source.connection_id,
        fixture: true,
        locator: "fixture:attention",
      })
    },'complete',${observedAt}::text::timestamptz)
      on conflict(owner_id,entity_id,content_hash) do nothing`;
  });
}

function relate(db: Db, ownerId: string, from: string, to: string, kind: string) {
  return asOwner(db, { ownerId }, async (tx) => {
    await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
      values(${ownerId},${from},${to},${kind},${
      tx.json({ system: "synthetic", source: "fixture" })
    })`;
  });
}

function setState(db: Db, ownerId: string, entityId: string, patch: unknown) {
  return asOwner(db, { ownerId }, async (tx) => {
    await tx`update public.hub_entities set state=state || ${
      tx.json(patch as postgres.JSONValue)
    }::jsonb
      where owner_id=${ownerId} and id=${entityId}`;
  });
}

Deno.test("FORUM-02: só respostas observadas a dois colegas distintos satisfazem a quantidade", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db), attention = new Attention(hub);
  const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Fórum fixture", null, "7");
    const forum = await hub.entity(owner, conn.id, "forum", "forum:201", "Comentar dois colegas");
    const discussion = await hub.entity(
      owner,
      conn.id,
      "discussion",
      "discussion:301",
      "Discussão",
    );
    await relate(db, owner.ownerId, forum.id, discussion.id, "has_discussion");
    await observe(
      db,
      owner.ownerId,
      forum.id,
      { intro: "Comente dois colegas distintos." },
      "forum-02",
      NOW,
    );
    const obs = (await hub.observations(owner, forum.id)).records[0];
    await attention.recordRequirement(owner, {
      source_entity_id: forum.id,
      requirement_key: "comentarios",
      observation_id: String(obs.id),
      content_hash: "forum-02",
      excerpt: "Comente dois colegas distintos.",
      action: "responder a colegas",
      quantity: { kind: "colleagues_distinct", at_least: 2 },
    });
    const addPost = async (
      id: number,
      author: number,
      parent: number,
      observed = true,
      coverage = "complete",
    ) => {
      const raw = { id, author: { id: author }, parentid: parent, message: "Comentário fixture" };
      const state = {
        post_id: id,
        author_userid: author,
        parent,
        discussion_id: 301,
        provider_record: raw,
      };
      const entity = await hub.entity(owner, conn.id, "post", `post:${id}`, "Post fixture", state);
      await asOwner(db, owner, async (tx) => {
        await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
          values(${owner.ownerId},${discussion.id},${entity.id},'has_post','{}')
          on conflict(owner_id,from_id,to_id,kind) do nothing`;
      });
      if (observed) {
        await asOwner(db, owner, async (tx) => {
          await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage)
          values(${owner.ownerId},${entity.id},${tx.json(raw)},${"post-" + id},${
            tx.json({
              system: "moodle",
              connection_id: conn.id,
              discussion_id: 301,
              post_id: id,
              fixture: true,
            })
          },${coverage})
          on conflict(owner_id,entity_id,content_hash) do nothing`;
        });
      }
      return entity;
    };
    await addPost(1, 7, 0);
    await addPost(2, 11, 0);
    await addPost(3, 12, 0);
    await addPost(4, 13, 0);
    const check = async (expected: number) => {
      const view = await attention.overview(owner, {});
      const obligation = findOf(view, forum.id);
      assert.equal(obligation.colleagues!.distinct_colleagues, 3);
      assert.equal(obligation.colleagues!.colleagues_answered_by_owner, expected);
      assert.equal(obligation.colleague_requirements[0].observed_distinct_colleagues, expected);
      assert.equal(obligation.colleague_requirements[0].observed_meets_at_least, expected >= 2);
    };
    await check(0); // Existing classmates alone do not satisfy participation.
    const ctx = await hub.createContext(owner, "Rascunho de resposta");
    await hub.recordDelta(owner, {
      context_id: ctx.id,
      expected_version: 0,
      idempotency_key: crypto.randomUUID(),
      kind: "artifact",
      evidence_kind: "interpretation",
      content: "Rascunho para responder ao colega 11",
      provenance: [],
      scope: { entity_id: forum.id },
    });
    await addPost(5, 7, 1); // Reply to oneself.
    await addPost(6, 7, 3, false); // State projection without observed publication.
    await check(0);
    const firstReply = await addPost(7, 7, 2);
    await check(1);
    await relate(db, owner.ownerId, forum.id, firstReply.id, "has_post"); // Same post via two graph paths.
    await addPost(7, 7, 2); // Provider replay must be idempotent.
    await addPost(8, 7, 2); // Second real reply to the same classmate still counts one.
    await check(1);
    await addPost(9, 7, 3, true, "partial"); // A preserved post can be valid in a partial page.
    await check(2);
    const final = findOf(await attention.overview(owner, {}), forum.id);
    assert.equal(final.colleagues!.observed_posts, 8); // 1..9 except unobserved 6; graph duplicate excluded.
    assert.equal(final.colleagues!.owner_posts, 5);
    assert.deepEqual((await attention.overview(other, {})).obligations, []);
  } finally {
    await db`delete from auth.users where id in (${owner.ownerId},${other.ownerId})`;
    await db.end();
  }
});

Deno.test("MAT-05: dependências versionadas, contexto/dono, hash vigente e cobertura limitada", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db), attention = new Attention(hub);
  const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Fixture MAT-05", null, "7");
    const foreignConn = await hub.connect(other, "moodle", "Outra conta", null, "8");
    await db`update public.hub_connections set state='connected' where id=${conn.id} and owner_id=${owner.ownerId}`;
    const ctx = await hub.createContext(owner, "Rascunhos A");
    const ctxB = await hub.createContext(owner, "Rascunhos B");
    const task = await hub.entity(owner, conn.id, "assignment", "mat:task", "Tarefa");
    const taskRel = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "mat:relation",
      "Tarefa por relação",
    );
    const source = await hub.entity(owner, conn.id, "resource", "mat:source", "Material");
    const stable = await hub.entity(owner, conn.id, "resource", "mat:stable", "Material estável");
    const unrelated = await hub.entity(
      owner,
      conn.id,
      "resource",
      "mat:unrelated",
      "Material sem vínculo",
    );
    const related = await hub.entity(owner, conn.id, "resource", "mat:related", "Material exigido");
    const foreign = await hub.entity(
      other,
      foreignConn.id,
      "resource",
      "mat:foreign",
      "Fonte privada alheia",
    );
    const oldAt = new Date(Date.now() - 60_000).toISOString();
    const observeVersion = async (
      entityId: string,
      hash: string,
      at: string,
      ownerId = owner.ownerId,
    ) => {
      const content = { requirement: hash };
      await observe(db, ownerId, entityId, content, hash, at);
      await setState(db, ownerId, entityId, { provider_record: content });
      return (await hub.observations({ ownerId }, entityId)).records[0];
    };
    const a = await observeVersion(source.id, "material-v1", oldAt);
    const same = await observeVersion(stable.id, "stable-v1", oldAt);
    const baseRel = await observeVersion(related.id, "related-v1", oldAt);
    const baseUnrelated = await observeVersion(unrelated.id, "unrelated-v1", oldAt);
    const baseForeign = await observeVersion(foreign.id, "foreign-v1", oldAt, other.ownerId);
    await asOwner(db, owner, async (tx) => {
      for (const context of [ctx, ctxB]) {
        for (const entity of [task, taskRel]) {
          await tx`insert into public.hub_context_targets(owner_id,context_id,entity_id)
          values(${owner.ownerId},${context.id},${entity.id})`;
        }
      }
      // Only a hash qualified against the same material can establish a baseline.
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values
        (${owner.ownerId},${taskRel.id},${related.id},'required_material',${
        tx.json({
          source_observation_id: baseRel.id,
          content_hash: "related-v1",
          context_id: ctx.id,
        })
      }),
        (${owner.ownerId},${task.id},${unrelated.id},'required_material',${
        tx.json({ source_observation_id: baseUnrelated.id })
      }),
        (${owner.ownerId},${task.id},${stable.id},'required_material',${
        tx.json({ source_observation_id: a.id, content_hash: "material-v1" })
      })`;
    });
    let version = 0;
    const artifact = (
      target: string,
      provenance: Array<{ system: string; locator: string; version?: string }>,
    ) =>
      hub.recordDelta(owner, {
        idempotency_key: crypto.randomUUID(),
        context_id: ctx.id,
        expected_version: version++,
        kind: "artifact",
        evidence_kind: "interpretation",
        content: "Rascunho fixture",
        scope: { entity_id: target },
        provenance,
      });
    const reference = (
      id: unknown,
      version: string,
    ) => [{ system: "synthetic", locator: `hub:observation:${id}`, version }];
    const draft = await artifact(task.id, reference(a.id, "material-v1"));
    await artifact(task.id, reference(same.id, "stable-v1"));
    await artifact(task.id, reference(a.id, "wrong-hash"));
    await artifact(task.id, reference(baseForeign.id, "foreign-v1"));
    const relationDraft = await artifact(taskRel.id, []);
    const otherContextDraft = await hub.recordDelta(owner, {
      idempotency_key: crypto.randomUUID(),
      context_id: ctxB.id,
      expected_version: 0,
      kind: "artifact",
      evidence_kind: "interpretation",
      content: "Outro contexto",
      scope: { entity_id: task.id },
      provenance: reference(a.id, "material-v1"),
    });
    const changedAt = new Date().toISOString();
    const b = await observeVersion(source.id, "material-v2", changedAt);
    await observeVersion(stable.id, "stable-v1", changedAt); // Same hash, new occurrence.
    await observeVersion(unrelated.id, "unrelated-v2", changedAt);
    await observeVersion(related.id, "related-v2", changedAt);
    await observeVersion(foreign.id, "foreign-v2", changedAt, other.ownerId);
    type Change = {
      entity_id: string;
      draft_id: string;
      context_id: string;
      material_entity_id: string;
      dependency_basis: string;
      baseline: { content_hash: string };
      current: { observation_id: string; content_hash: string };
      source_uncertainties: string[];
    };
    const changes = (view: Awaited<ReturnType<Attention["overview"]>>) =>
      view.attention
        .filter((row) =>
          (row as { kind: string }).kind === "material_dependency_changed"
        ) as Change[];
    const view = await attention.overview(owner, { context_id: ctx.id });
    const alerts = changes(view);
    assert.equal(alerts.length, 2);
    const direct = alerts.find((row) => row.draft_id === draft.id)!;
    assert.equal(direct.entity_id, task.id);
    assert.equal(direct.context_id, ctx.id);
    assert.equal(direct.material_entity_id, source.id);
    assert.equal(direct.baseline.content_hash, "material-v1");
    assert.equal(direct.current.content_hash, "material-v2");
    assert.equal(direct.current.observation_id, b.id);
    assert.deepEqual(direct.source_uncertainties, []);
    assert.equal(
      alerts.find((row) => row.draft_id === relationDraft.id)!.dependency_basis,
      "required_material",
    );
    assert.ok(!JSON.stringify(view).includes(otherContextDraft.id));
    assert.ok(!JSON.stringify(view).includes(foreign.id));
    assert.ok(!JSON.stringify(view).includes(baseForeign.id));
    assert.equal(findOf(view, taskRel.id).state.drafts.length, 1);
    assert.equal(changes(await attention.overview(owner, { context_id: ctxB.id })).length, 1);
    assert.deepEqual(changes(await attention.overview(other, { context_id: ctx.id })), []);

    // A→B→A: current occurrence wins; a past differing snapshot cannot keep the alert alive.
    await observeVersion(source.id, "material-v1", new Date(Date.now() + 1).toISOString());
    const reverted = changes(await attention.overview(owner, { context_id: ctx.id }));
    assert.equal(reverted.length, 1);
    assert.equal(reverted[0].draft_id, relationDraft.id);
    assert.equal((await hub.observations(owner, source.id)).records.length, 3);
    await db`update public.hub_connections set state='revoked' where owner_id=${owner.ownerId} and id=${conn.id}`;
    const uncertain = changes(await attention.overview(owner, { context_id: ctx.id }));
    assert.ok(uncertain[0].source_uncertainties.includes("source_access_not_current"));

    // Sixth older artifact must produce explicit partial coverage, not a false complete claim.
    for (let n = 0; n < 2; n++) await artifact(task.id, []);
    const bounded = await attention.overview(owner, { context_id: ctx.id });
    const boundedTask = findOf(bounded, task.id);
    assert.equal(boundedTask.state.drafts.length, 5);
    assert.ok(boundedTask.gaps.some((gap) => gap.includes("5 rascunhos")));
    // The same bound also applies to explicit source references in one artifact.
    const refs = Array.from({ length: 21 }, () => reference(same.id, "stable-v1")[0]);
    await artifact(taskRel.id, refs);
    const boundedReferences = findOf(
      await attention.overview(owner, { context_id: ctx.id }),
      taskRel.id,
    );
    assert.ok(boundedReferences.gaps.some((gap) => gap.includes("20 referências")));
  } finally {
    await db`delete from auth.users where id in (${owner.ownerId},${other.ownerId})`;
    await db.end();
  }
});

Deno.test("atenção: obrigações com prazos múltiplos e colegas distintos (Postgres sintético)", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db), attention = new Attention(hub);
  const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Moodle sintético", null, "7");
    const forumRecord = { id: 5, name: "Fórum", intro: "Comente dois colegas." };
    const forum = await hub.entity(owner, conn.id, "forum", "moodle:course/1/forum/5", "Fórum", {
      course_id: 1,
      forum_id: 5,
      provider_record: forumRecord,
    });
    await observe(db, owner.ownerId, forum.id, forumRecord, "hash-forum-1", "2026-10-09T10:00:00Z");
    const discussionRecord = { id: 9, name: "Discussão", discussion: 9 };
    const discussion = await hub.entity(
      owner,
      conn.id,
      "discussion",
      "moodle:course/1/forum/5/discussion/9",
      "Discussão",
      { course_id: 1, forum_id: 5, discussion_id: 9, provider_record: discussionRecord },
    );
    await observe(
      db,
      owner.ownerId,
      discussion.id,
      discussionRecord,
      "hash-discussion-1",
      "2026-10-09T10:01:00Z",
    );
    await relate(db, owner.ownerId, forum.id, discussion.id, "has_discussion");
    const posts: Array<Record<string, unknown>> = [
      { post_id: 1, author_userid: 7, parent: 0 },
      { post_id: 2, author_userid: 11, parent: 0 },
      { post_id: 3, author_userid: 12, parent: 0 },
      { post_id: 4, author_userid: 7, parent: 2 },
    ];
    for (const [index, post] of posts.entries()) {
      const state = { course_id: 1, forum_id: 5, discussion_id: 9, ...post };
      const entity = await hub.entity(
        owner,
        conn.id,
        "post",
        "moodle:course/1/forum/5/discussion/9/post/" + post.post_id,
        "Post " + post.post_id,
        state,
      );
      await observe(
        db,
        owner.ownerId,
        entity.id,
        state,
        "hash-post-" + index,
        "2026-10-09T10:02:0" + index + "Z",
      );
      await relate(db, owner.ownerId, discussion.id, entity.id, "has_post");
    }
    const assignmentRecord = { id: 3, name: "Trabalho 1", duedate: DUE, cutoffdate: CUTOFF };
    const assignment = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/3",
      "Trabalho 1",
      { course_id: 1, instance_id: 3, provider_record: assignmentRecord },
    );
    await observe(
      db,
      owner.ownerId,
      assignment.id,
      assignmentRecord,
      "hash-assignment-a",
      "2026-10-09T11:00:00Z",
    );
    const context = await hub.createContext(owner, "Contexto sintético");
    await hub.recordDelta(owner, {
      idempotency_key: "draft-" + crypto.randomUUID(),
      context_id: context.id,
      kind: "artifact",
      content: "Rascunho sintético do trabalho.",
      evidence_kind: "interpretation",
      expected_version: 0,
      provenance: [{ system: "assistant", locator: "hub:context:" + context.id }],
      scope: { entity_id: assignment.id },
    });
    await setState(db, owner.ownerId, assignment.id, {
      user_report: { reported: true, actual_submission_time: null },
    });
    const bareRecord = { id: 4, name: "Trabalho 2" };
    const bare = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/4",
      "Trabalho 2",
      { course_id: 1, instance_id: 4, provider_record: bareRecord },
    );
    await observe(
      db,
      owner.ownerId,
      bare.id,
      bareRecord,
      "hash-assignment-b",
      "2026-10-09T11:05:00Z",
    );

    const result = await attention.overview(owner, {}, { now: NOW });
    assert.equal(result.content_is_untrusted_data, true);
    assert.equal(result.obligations.length, 4);
    assert.equal(result.horizon_days, 7);
    assert.equal(result.reference_instant, "2026-10-10T00:00:00.000Z");

    const forumObligation = findOf(result, forum.id);
    assert.equal(forumObligation.colleagues!.distinct_colleagues, 2);
    assert.equal(forumObligation.colleagues!.colleagues_answered_by_owner, 1);
    assert.equal(forumObligation.colleagues!.observed_posts, 4);
    assert.equal(forumObligation.colleagues!.owner_posts, 2);
    assert.equal(findOf(result, discussion.id).colleagues!.distinct_colleagues, 2);
    assert.equal(findOf(result, discussion.id).colleagues!.colleagues_answered_by_owner, 1);

    const obligation = findOf(result, assignment.id);
    assert.equal(obligation.requirement.action, "entrega");
    assert.equal(obligation.requirement.object, "Trabalho 1");
    assert.equal(obligation.basis, "preserved_observation");
    assert.deepEqual(obligation.deadlines.map((d) => d.field), ["duedate", "cutoffdate"]);
    assert.notEqual(obligation.deadlines[0].label, obligation.deadlines[1].label);
    assert.equal(obligation.deadlines[0].time.kind, "instant");
    assert.equal(obligation.deadlines[0].time.instant, "2026-10-12T15:00:00.000Z");
    assert.equal(obligation.deadlines[1].time.instant, "2026-10-16T15:00:00.000Z");
    assert.deepEqual(
      obligation.deadlines[0].time.displays!.map((d) => d.time_zone),
      ["Europe/Lisbon", "America/Sao_Paulo"],
    );
    assert.equal(obligation.deadline_summary.overdue, 0);
    assert.equal(obligation.deadline_summary.upcoming, 2);
    assert.equal(obligation.deadline_summary.nearest, "2026-10-12T15:00:00.000Z");
    assert.equal(obligation.deadline_summary.within_horizon, "2026-10-12T15:00:00.000Z");
    assert.notEqual(obligation.state.user_report, null);
    assert.equal(obligation.state.drafts.length, 1);
    assert.equal(obligation.state.presented, null);
    assert.equal(obligation.state.read, null);
    assert.equal(obligation.state.native_platform.entity_completion, null);
    assert.equal(obligation.provenance.content_hash, "hash-assignment-a");
    assert.equal(obligation.provenance.coverage, "complete");
    assert.deepEqual(obligation.gaps, []);
    assert.ok(kindsOf(result, assignment.id).includes("not_presented"));
    assert.ok(kindsOf(result, assignment.id).includes("deadline_near"));

    const bareObligation = findOf(result, bare.id);
    assert.equal(bareObligation.deadlines.length, 0);
    assert.equal(bareObligation.gaps.length, 1);
    assert.equal(bareObligation.basis, "preserved_observation");
    assert.ok(kindsOf(result, bare.id).includes("submission_evidence_missing"));

    const foreign = await attention.overview(other, {}, { now: NOW });
    assert.deepEqual(foreign.obligations, []);
    assert.deepEqual(foreign.attention, []);
  } finally {
    await db`delete from auth.users where id in (${owner.ownerId},${other.ownerId})`;
    await db.end();
  }
});

Deno.test("atenção: apresentado/lido local, marca nativa separada e reversão A→B→A", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db), attention = new Attention(hub);
  const owner = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Moodle sintético", null, "7");
    const stableRecord = { id: 3, name: "Trabalho", duedate: DUE };
    const stable = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/3",
      "Trabalho",
      { provider_record: stableRecord },
    );
    await observe(db, owner.ownerId, stable.id, stableRecord, "hash-a", "2026-10-09T12:00:00Z");

    // Marcar sem o hash da versão exigida seria uma corrida: a fonte pode mudar
    // entre a visão apresentada e o registro.
    await assert.rejects(
      attention.markPresented(owner, {
        entities: [{ entity_id: stable.id, content_hash: "hash-outro" }],
      }),
      /mudou desde o conteúdo apresentado/,
    );
    const presented = await attention.markPresented(owner, {
      entities: [{ entity_id: stable.id, content_hash: "hash-a" }],
    });
    assert.equal(presented.moodle_mark, false);
    assert.equal(presented.source_writes, false);
    assert.equal(
      (presented.presented as Array<{ presented: { content_hash: string } }>)[0].presented
        .content_hash,
      "hash-a",
    );
    const afterPresented = await attention.overview(owner, {}, { now: NOW });
    assert.ok(!kindsOf(afterPresented, stable.id).includes("changed_since_presented"));
    assert.ok(!kindsOf(afterPresented, stable.id).includes("not_presented"));

    await assert.rejects(
      attention.acknowledgeRead(owner, { entity_id: stable.id, content_hash: "hash-outro" }),
      /mudou desde o conteúdo lido/,
    );
    const read = await attention.acknowledgeRead(owner, {
      entity_id: stable.id,
      content_hash: "hash-a",
    });
    assert.equal(read.moodle_mark, false);
    assert.equal(read.source_writes, false);
    assert.equal((read.read as { content_hash: string }).content_hash, "hash-a");

    await setState(db, owner.ownerId, stable.id, { completion: true });
    const afterNative = await attention.overview(owner, {}, { now: NOW });
    const nativeObligation = findOf(afterNative, stable.id);
    assert.equal(nativeObligation.state.native_platform.entity_completion, true);
    assert.equal(
      (nativeObligation.state.read as { content_hash: string }).content_hash,
      "hash-a",
    );
    // Conclusão nativa do Moodle não substitui leitura humana nem prova de entrega.
    assert.ok(kindsOf(afterNative, stable.id).includes("submission_evidence_missing"));

    const changedRecord = { id: 3, name: "Trabalho", duedate: CUTOFF };
    await observe(db, owner.ownerId, stable.id, changedRecord, "hash-b", "2026-10-11T12:00:00Z");
    await setState(db, owner.ownerId, stable.id, { provider_record: changedRecord });
    const afterChange = await attention.overview(owner, {}, { now: NOW });
    assert.ok(kindsOf(afterChange, stable.id).includes("changed_since_presented"));
    assert.ok(kindsOf(afterChange, stable.id).includes("changed_since_read"));

    // A→B→A real: as três ocorrências ficam preservadas com datas próprias, o
    // conteúdo vigente volta a ser A e a reversão não se perde.
    const abaRecord = { id: 6, name: "Trabalho revertido", duedate: DUE };
    const aba = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/6",
      "Trabalho revertido",
      { provider_record: abaRecord },
    );
    await observe(db, owner.ownerId, aba.id, abaRecord, "hash-aba-a", "2026-10-09T13:00:00Z");
    await observe(
      db,
      owner.ownerId,
      aba.id,
      {
        id: 6,
        name: "Trabalho revertido",
        duedate: CUTOFF,
      },
      "hash-aba-b",
      "2026-10-10T13:00:00Z",
    );
    await observe(db, owner.ownerId, aba.id, abaRecord, "hash-aba-a", "2026-10-11T13:00:00Z");
    const afterAba = await attention.overview(owner, {}, { now: NOW });
    const abaObligation = findOf(afterAba, aba.id);
    assert.equal(abaObligation.basis, "preserved_observation");
    assert.equal(abaObligation.provenance.content_hash, "hash-aba-a");
    assert.equal(
      new Date(abaObligation.provenance.observed_at as string).toISOString(),
      "2026-10-11T13:00:00.000Z",
    );
    assert.equal(abaObligation.deadlines.length, 1);
    assert.equal(abaObligation.deadlines[0].time.instant, "2026-10-12T15:00:00.000Z");
    assert.deepEqual(abaObligation.gaps, []);
    assert.ok(!kindsOf(afterAba, aba.id).includes("unrecorded_reobservation"));
    // Alteração de estado sem ocorrência correspondente continua sinalizada.
    const drift = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/7",
      "Drift",
      { provider_record: { id: 7, name: "Drift", duedate: DUE } },
    );
    await observe(
      db,
      owner.ownerId,
      drift.id,
      { id: 7, name: "Drift", duedate: CUTOFF },
      "hash-drift-b",
      "2026-10-09T15:00:00Z",
    );
    const afterDrift = await attention.overview(owner, {}, { now: NOW });
    const driftObligation = findOf(afterDrift, drift.id);
    assert.equal(driftObligation.basis, "current_state_with_unrecorded_reobservation");
    assert.ok(driftObligation.gaps.some((gap) => gap.includes("sem ocorrência")));
    assert.ok(kindsOf(afterDrift, drift.id).includes("unrecorded_reobservation"));

    await assert.rejects(attention.overview(owner, { offset: -1 }, { now: NOW }));
  } finally {
    await db`delete from auth.users where id=${owner.ownerId}`;
    await db.end();
  }
});

Deno.test("atenção: obrigações interpretadas e recibo de ação acadêmica (Postgres sintético)", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db), attention = new Attention(hub);
  const owner = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const conn = await hub.connect(owner, "moodle", "Moodle sintético", null, "7");
    const forumRecord = {
      id: 5,
      name: "Fórum",
      intro: "Publique até 10 de outubro e comente ao menos dois colegas até 17 de outubro.",
    };
    const forum = await hub.entity(
      owner,
      conn.id,
      "forum",
      "moodle:course/1/forum/5",
      "Fórum",
      { provider_record: forumRecord },
    );
    const observation = await asOwner(db, owner, async (tx) => {
      const rows =
        await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
        values(${owner.ownerId},${forum.id},${tx.json(forumRecord)},'hash-forum-intro',${
          tx.json({ system: "synthetic", locator: "fixture:forum/5" })
        },'complete',now())
        returning id`;
      return rows[0];
    });
    // Duas obrigações distintas com prazos distintos: nenhuma coluna due_date
    // representa isso, e a hora não é declarada na fonte.
    const first = await attention.recordRequirement(owner, {
      source_entity_id: forum.id,
      requirement_key: "post-inicial",
      observation_id: observation.id,
      content_hash: "hash-forum-intro",
      excerpt: "Publique até 10 de outubro",
      action: "publicar post inicial",
      deadline: { original_text: "10 de outubro", date: "2026-10-10" },
    });
    assert.equal(first.replayed, false);
    assert.equal(first.moodle_write, false);
    const second = await attention.recordRequirement(owner, {
      source_entity_id: forum.id,
      requirement_key: "comentarios-colegas",
      observation_id: observation.id,
      content_hash: "hash-forum-intro",
      excerpt: "comente ao menos dois colegas até 17 de outubro",
      action: "comentar postagens de colegas",
      quantity: { kind: "colleagues_distinct", at_least: 2 },
      deadline: { original_text: "17 de outubro", date: "2026-10-17" },
    });
    assert.notEqual(first.requirement_entity_id, second.requirement_entity_id);
    const replay = await attention.recordRequirement(owner, {
      source_entity_id: forum.id,
      requirement_key: "post-inicial",
      observation_id: observation.id,
      content_hash: "hash-forum-intro",
      excerpt: "Publique até 10 de outubro",
      action: "publicar post inicial",
      deadline: { original_text: "10 de outubro", date: "2026-10-10" },
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.payload_hash, first.payload_hash);
    await assert.rejects(
      attention.recordRequirement(owner, {
        source_entity_id: forum.id,
        requirement_key: "post-inicial",
        observation_id: observation.id,
        content_hash: "hash-desatualizado",
        excerpt: "Publique até 10 de outubro",
        action: "publicar post inicial",
      }),
      /A observação de origem mudou/,
    );

    const discussion = await hub.entity(
      owner,
      conn.id,
      "discussion",
      "moodle:course/1/forum/5/discussion/9",
      "Discussão",
      { discussion_id: 9, provider_record: { id: 9, discussion: 9 } },
    );
    await relate(db, owner.ownerId, forum.id, discussion.id, "has_discussion");
    const posts = [{ post_id: 1, author_userid: 11, parent: 0 }, {
      post_id: 2,
      author_userid: 12,
      parent: 0,
    }];
    for (const post of posts) {
      const state = { discussion_id: 9, forum_id: 5, ...post };
      const entity = await hub.entity(
        owner,
        conn.id,
        "post",
        "moodle:course/1/forum/5/discussion/9/post/" + post.post_id,
        "Post " + post.post_id,
        state,
      );
      await observe(db, owner.ownerId, entity.id, state, "requirement-post-" + post.post_id, NOW);
      await relate(db, owner.ownerId, discussion.id, entity.id, "has_post");
    }

    const result = await attention.overview(owner, {}, { now: NOW });
    const forumObligation = findOf(result, forum.id);
    assert.equal(forumObligation.basis, "preserved_observation");
    assert.equal(forumObligation.deadlines.length, 0);
    assert.equal(forumObligation.requirements.length, 2);
    assert.deepEqual(
      forumObligation.requirements.map((r) => r.requirement_key).sort(),
      ["comentarios-colegas", "post-inicial"],
    );
    assert.equal(forumObligation.requirement_deadlines.length, 2);
    assert.deepEqual(
      forumObligation.requirement_deadlines.map((r) => r.deadline!.date).sort(),
      ["2026-10-10", "2026-10-17"],
    );
    assert.ok(
      forumObligation.requirement_deadlines.every((r) => r.deadline!.hour_known === false),
    );
    assert.equal(
      forumObligation.requirements.find((r) => r.requirement_key === "post-inicial")!
        .source.excerpt,
      "Publique até 10 de outubro",
    );
    assert.equal(forumObligation.colleagues!.distinct_colleagues, 2);
    const comparison = forumObligation.colleague_requirements[0];
    assert.equal(comparison.requirement_key, "comentarios-colegas");
    assert.equal(comparison.required_at_least, 2);
    assert.equal(comparison.observed_distinct_colleagues, 0);
    assert.equal(comparison.observed_meets_at_least, false);
    assert.ok(!kindsOf(result, forum.id).includes("requirement_not_interpreted"));
    assert.deepEqual(forumObligation.gaps, []);

    const assignmentRecord = { id: 8, name: "Trabalho", duedate: DUE };
    const assignment = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/8",
      "Trabalho",
      { course_id: 3, coursemodule: 41, instance_id: 8, provider_record: assignmentRecord },
    );
    await observe(
      db,
      owner.ownerId,
      assignment.id,
      assignmentRecord,
      "hash-assignment-8",
      "2026-10-09T14:00:00Z",
    );
    const beforeReceipt = await attention.overview(owner, {}, { now: NOW });
    assert.ok(kindsOf(beforeReceipt, assignment.id).includes("submission_evidence_missing"));

    // Recibo real: snapshot e alvo vêm do próprio PersistentActionStore.
    // MoodleActions grava target "course/cmid/instance", não um localizador de URL.
    const store = new PersistentActionStore(db, { sessionActive: () => Promise.resolve(true) });
    const prepareReceipt = (
      operation: string,
      target: string,
      revision: string,
      content: unknown,
    ) =>
      store.prepare(owner, {
        connectionId: conn.id,
        operation,
        target,
        revision,
        content,
      });
    const prepared = await prepareReceipt("moodle.assignment.submit", "3/41/8", "rev-1", {
      kind: "assignment.submit",
      connection: { label: "Moodle sintético", origin: "https://moodle.invalid" },
      target: {
        course_id: 3,
        course_name: "Curso",
        cmid: 41,
        activity_name: "Trabalho",
        instance_id: 8,
      },
      expected: { epoch: 1, user_id: 7, fingerprint: "fp", attempt: 1, status: "ok" },
      rules: {},
      prepared_at: "2026-10-09T14:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
    });
    // Desfecho terminal pelo caminho privilegiado do próprio store.
    await db`update public.hub_actions set state='uncertain'
      where owner_id=${owner.ownerId} and id=${prepared.id}`;
    await store.persistResult(prepared, { state: "succeeded", externalId: "synthetic-42" });

    const afterReceipt = await attention.overview(owner, {}, { now: NOW });
    const withReceipt = findOf(afterReceipt, assignment.id);
    assert.equal(withReceipt.state.submission_evidence.confirmed_academic_action, true);
    assert.equal(withReceipt.state.academic_actions.length, 1);
    assert.equal(
      (withReceipt.state.academic_actions[0] as { operation: string }).operation,
      "moodle.assignment.submit",
    );
    assert.ok(!kindsOf(afterReceipt, assignment.id).includes("submission_evidence_missing"));

    // Recibo de outra atividade não conta para esta obrigação.
    const otherReceipt = await prepareReceipt("moodle.forum.reply", "3/99/77", "rev-2", {
      kind: "forum.reply",
      connection: { label: "Moodle sintético", origin: "https://moodle.invalid" },
      target: {
        course_id: 3,
        course_name: "Curso",
        cmid: 99,
        activity_name: "Outro fórum",
        instance_id: 77,
        discussion_id: 5,
        parent_id: 6,
      },
      expected: { epoch: 1, user_id: 7, fingerprint: "fp", attempt: 1, status: "ok" },
      rules: {},
      prepared_at: "2026-10-09T14:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
    });
    await db`update public.hub_actions set state='uncertain'
      where owner_id=${owner.ownerId} and id=${otherReceipt.id}`;
    await store.persistResult(otherReceipt, { state: "succeeded", externalId: "synthetic-43" });
    const afterOtherReceipt = await attention.overview(owner, {}, { now: NOW });
    assert.equal(findOf(afterOtherReceipt, assignment.id).state.academic_actions.length, 1);

    const nativeOnly = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/9",
      "Outro",
      { provider_record: { id: 9, name: "Outro" }, completion: true },
    );
    await observe(
      db,
      owner.ownerId,
      nativeOnly.id,
      { id: 9, name: "Outro" },
      "hash-assignment-9",
      "2026-10-09T14:05:00Z",
    );
    const withNative = await attention.overview(owner, {}, { now: NOW });
    const nativeObligation = findOf(withNative, nativeOnly.id);
    assert.equal(nativeObligation.state.native_platform.entity_completion, true);
    assert.equal(nativeObligation.state.submission_evidence.native_completion, true);
    assert.equal(nativeObligation.state.submission_evidence.confirmed_academic_action, false);
    assert.ok(kindsOf(withNative, nativeOnly.id).includes("submission_evidence_missing"));
  } finally {
    await db`delete from auth.users where id=${owner.ownerId}`;
    await db.end();
  }
});
