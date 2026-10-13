import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { handleMcp } from "../src/mcp.ts";
import { MoodleMemory } from "../src/moodle_memory.ts";
import { Attention } from "../src/attention.ts";
import type { ConnectionService } from "../src/connections.ts";
import type { MoodleRecord, MoodleResult } from "../src/adapters/moodle.ts";

const DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
function result<T>(data: T, time = "2026-10-13T12:00:00Z"): MoodleResult<T> {
  return {
    data,
    observed_at: time,
    coverage: "complete",
    warnings: [],
    error_code: null,
    empty: false,
    truncated: false,
  };
}

Deno.test("regressão A–E: MCP SDK real salva primeiro e consultas reconciliam no mesmo grafo", async () => {
  const db = createDb(DB), hub = new Hub(db), p = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${p.ownerId})`;
  const connection = await hub.connect(
    p,
    "moodle",
    "Curso sintético",
    "https://fixture.invalid",
    "7",
  );
  let reads = 0;
  const source = {
    getAssignments: () => {
      reads++;
      return Promise.resolve(result([
        { id: 11, course_id: 12, cmid: 101, name: "Etividade 1", duedate: 1791907200 },
      ]));
    },
    getForums: () => {
      reads++;
      return Promise.resolve(result([
        {
          id: 22,
          course: 12,
          cmid: 102,
          name: "Etividade 2",
          intro: "Publique um tópico e responda a dois colegas diferentes.",
        },
      ]));
    },
    getForumDiscussions: () => {
      reads++;
      return Promise.resolve(result([
        {
          id: 201,
          discussion: 77,
          discussion_id: 77,
          userid: 7,
          name: "Minha análise",
          created: 1791892800,
        },
      ]));
    },
    getDiscussionPosts: () => {
      reads++;
      return Promise.resolve(result([
        {
          id: 201,
          discussionid: 77,
          parentid: 0,
          author: { id: 7 },
          subject: "Minha análise",
          message: "Texto sintético",
          timecreated: 1791892800,
        },
      ]));
    },
    getSubmissionStatus: () => {
      reads++;
      return Promise.resolve(result({
        lastattempt: { submission: { userid: 7, status: "new", attemptnumber: 0 } },
        assignment_scope: { course_id: 12, assignment_id: 11, cmid: 101 },
      }));
    },
  };
  const connections = {
    ownStatusPolicies: { enabled: true },
    moodle: (owner: { ownerId: string }, cid: string) => {
      assert.equal(owner.ownerId, p.ownerId);
      assert.equal(cid, connection.id);
      return Promise.resolve(source);
    },
  } as unknown as ConnectionService;
  // Real SDK/HTTP; authenticated principal is injected in this controlled fixture.
  // OAuth/consent/real adapter are exercised separately by existing regression suites.
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 8789, onListen: () => {} },
    (req) => handleMcp(req, hub, p, connections),
  );
  let client = new Client({ name: "academic-regression", version: "1" });
  const connect = () =>
    client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8789/mcp")));
  // Tool results are serialized JSON by the actual MCP server.
  const call = async (name: string, args: Record<string, unknown>) => {
    const value = await client.callTool({ name, arguments: args });
    assert.notEqual(value.isError, true, JSON.stringify(value));
    return JSON.parse((value.content as Array<{ text: string }>)[0].text);
  };
  try {
    await connect();
    const contract = (await client.listTools()).tools;
    const eventTool = contract.find((t: { name: string }) => t.name === "hub_record_event")!;
    assert.match(eventTool.description!, /sem perguntar/);
    assert.equal(eventTool.annotations?.readOnlyHint, false);
    assert.equal(eventTool.annotations?.openWorldHint, false);
    assert.equal(eventTool.annotations?.idempotentHint, true);
    for (const name of ["hub_moodle_content", "hub_moodle_discussions", "hub_moodle_posts"]) {
      assert.equal(
        contract.find((t: { name: string }) => t.name === name)?.annotations?.readOnlyHint,
        false,
      );
    }
    const assignments = await call("hub_moodle_content", {
      connection_id: connection.id,
      course_id: 12,
      kind: "assignments",
    });
    assert.equal(assignments.memory_reconciliation.status, "persisted");
    const assignmentId = assignments.memory_reconciliation.entity_ids[0];
    const before = reads;
    const report = {
      target_entity_id: assignmentId,
      event_type: "submission",
      content: "Entreguei a Etividade 1.",
    };
    const saved = await call("hub_record_event", report);
    assert.equal(saved.evidence_kind, "user_report");
    assert.equal(saved.external_submission, "not_verified");
    assert.equal(saved.memory_commit.replayed, false);
    assert.equal(reads, before, "o relato não depende de consulta nem faz submissão");
    const retry = await call("hub_record_event", report);
    assert.equal(retry.memory_commit.id, saved.memory_commit.id);
    assert.equal(retry.memory_commit.replayed, true);
    const forums = await call("hub_moodle_content", {
      connection_id: connection.id,
      course_id: 12,
      kind: "forums",
    });
    const forumId = forums.memory_reconciliation.entity_ids[0];
    const discussions = await call("hub_moodle_discussions", {
      connection_id: connection.id,
      forum_id: 22,
    });
    assert.equal(discussions.memory_reconciliation.status, "persisted");
    const posts = await call("hub_moodle_posts", {
      connection_id: connection.id,
      discussion_id: 77,
    });
    assert.equal(posts.memory_reconciliation.status, "persisted");
    const post = await hub.entityContext(p, posts.memory_reconciliation.entity_ids[0]);
    assert.equal(post.entity.external_id, "moodle:course/12/forum/22/discussion/77/post/201");
    const evidence =
      await db`select content,provenance from public.hub_observation_timeline where owner_id=${p.ownerId} and entity_id=${post.entity.id}`;
    assert.equal(evidence[0].content.author.id, 7);
    assert.equal(evidence[0].provenance.system, "moodle");
    assert.equal(evidence[0].provenance.connection_id, connection.id);
    await call("hub_moodle_posts", { connection_id: connection.id, discussion_id: 77 });
    assert.equal(
      (await db`select id from public.hub_entities where owner_id=${p.ownerId} and kind='post'`)
        .length,
      1,
    );
    const native = await call("hub_moodle_own_submission_status", {
      connection_id: connection.id,
      course_id: 12,
      assignment_id: 11,
    });
    assert.equal(native.memory_reconciliation.status, "persisted");
    assert.equal(native.data.lastattempt.submission.status, "new");
    assert.equal((await hub.context(p, saved.context_id)).deltas[0].evidence_kind, "user_report");
    // Fresh client and stateless server requests retrieve the same event.
    await client.close();
    client = new Client({ name: "new-conversation", version: "1" });
    await connect();
    const resumed = await call("hub_context", { context_id: saved.context_id });
    assert.equal(resumed.deltas.length, 1);
    assert.equal(resumed.deltas[0].id, saved.memory_commit.id);
    assert.equal(resumed.deltas[0].scope.entity_id, assignmentId);
    const audit = await call("hub_attention", { view: "audit", connection_id: connection.id });
    assert.ok(audit.obligations.some((o: { entity: { id: string } }) => o.entity.id === forumId));
    assert.equal(
      (await db`select id from public.hub_actions where owner_id=${p.ownerId}`).length,
      0,
    );
  } finally {
    await client.close();
    await server.shutdown();
    await db`delete from auth.users where id=${p.ownerId}`;
    await db.end();
  }
});

Deno.test("consultas: lacuna/atraso/IDs divergentes não apagam evidências nem duplicam entidades", async () => {
  const db = createDb(DB), hub = new Hub(db), memory = new MoodleMemory(hub);
  const p = { ownerId: crypto.randomUUID() }, foreign = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${p.ownerId}),(${foreign.ownerId})`;
  const connection = await hub.connect(p, "moodle", "Sintético", "https://fixture.invalid", "7");
  try {
    const query = { kind: "assignments" as const, course_id: 12 };
    const data = (
      date: number,
    ) => [{ id: 11, course_id: 12, cmid: 101, name: "Atividade", duedate: date }];
    const latest = await memory.remember(
      p,
      connection.id,
      query,
      result(data(200), "2026-10-13T13:00:00Z"),
    );
    await memory.remember(p, connection.id, query, result(data(100), "2026-10-13T12:00:00Z"));
    const entity = (await hub.entityContext(p, latest.entity_ids[0])).entity;
    assert.equal(entity.state.provider_record.duedate, 200);
    assert.equal(
      (await db`select id from public.hub_observation_timeline where owner_id=${p.ownerId} and entity_id=${entity.id}`)
        .length,
      2,
    );
    await memory.remember(
      p,
      connection.id,
      query,
      { ...result<MoodleRecord[] | null>(null), coverage: "denied" } as MoodleResult<
        MoodleRecord[]
      >,
    );
    assert.equal((await hub.entityContext(p, entity.id)).entity.state.provider_record.duedate, 200);
    await assert.rejects(
      memory.remember(foreign, connection.id, query, result(data(300))),
      /Conexão não encontrada/,
    );
    const unknown = await memory.remember(
      p,
      connection.id,
      { kind: "posts", discussion_id: 77 },
      result([{ id: 201 }]),
    );
    assert.equal(unknown.status, "target_unresolved");
    const wrong = await memory.remember(
      p,
      connection.id,
      query,
      result([{ id: 11, course_id: 999 }]),
    );
    assert.equal(wrong.entity_ids.length, 0);
    await assert.rejects(
      memory.remember(
        p,
        connection.id,
        { kind: "own_status", course_id: 12, assignment_id: 11 },
        result({
          assignment_scope: { course_id: 12, assignment_id: 11 },
          lastattempt: { submission: { userid: 8, status: "submitted" } },
        }),
      ),
      /não corresponde/,
    );
  } finally {
    await db`delete from auth.users where id in (${p.ownerId},${foreign.ownerId})`;
    await db.end();
  }
});

Deno.test("consultas: A→B→A preserva estrutura e mudanças de prazo/orientação/feedback chegam à atenção", async () => {
  const db = createDb(DB),
    hub = new Hub(db),
    memory = new MoodleMemory(hub),
    attention = new Attention(hub);
  const p = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${p.ownerId})`;
  const connection = await hub.connect(p, "moodle", "Sintético", "https://fixture.invalid", "7");
  try {
    for (const [index, section] of [1, 2, 1].entries()) {
      await memory.remember(
        p,
        connection.id,
        { kind: "structure", course_id: 12 },
        result([{
          id: section,
          name: "Seção " + section,
          modules: [{ id: 101, instance: 11, modname: "assign", name: "Atividade" }],
        }], `2026-10-13T12:0${index}:00Z`),
      );
    }
    const modules = await hub.entities(p, { kind: "module" });
    assert.equal(modules.records.length, 1);
    const moduleId = String(modules.records[0].id);
    const edges = await db`select e.state->>'section_id' as section_id from public.hub_relations r
      join public.hub_entities e on e.owner_id=r.owner_id and e.id=r.from_id
      where r.owner_id=${p.ownerId} and r.to_id=${moduleId} and r.kind='has_module'`;
    assert.deepEqual(edges.map((e) => e.section_id), ["1"]);
    const first = await memory.remember(
      p,
      connection.id,
      { kind: "assignments", course_id: 12 },
      result([
        {
          id: 11,
          course_id: 12,
          cmid: 101,
          name: "Atividade",
          intro: "Versão A",
          duedate: 1791907200,
        },
      ], "2026-10-13T13:00:00Z"),
    );
    await memory.remember(
      p,
      connection.id,
      { kind: "assignments", course_id: 12 },
      result([
        {
          id: 11,
          course_id: 12,
          cmid: 101,
          name: "Atividade",
          intro: "Versão B",
          duedate: 1791993600,
        },
      ], "2026-10-13T14:00:00Z"),
    );
    await memory.remember(
      p,
      connection.id,
      { kind: "own_status", course_id: 12, assignment_id: 11 },
      result({
        assignment_scope: { course_id: 12, assignment_id: 11, cmid: 101 },
        lastattempt: { submission: { userid: 7, status: "draft" } },
        feedback: { available: true, gradeddate: 1791892800 },
      }, "2026-10-13T14:01:00Z"),
    );
    const view = await attention.overview(p, { connection_id: connection.id, view: "summary" });
    const kinds = view.attention.map((a) => (a as { kind: string }).kind);
    assert.ok(kinds.includes("deadline_changed"));
    assert.ok(kinds.includes("instructions_changed"));
    assert.ok(kinds.includes("feedback_available"));
    assert.equal(view.obligations.length, 1);
    assert.equal(
      (view.obligations[0] as { entity: { id: string } }).entity.id,
      first.entity_ids[0],
    );
    assert.equal((await hub.context(p)).deltas.length, 0, "observação não inventa relato");
  } finally {
    await db`delete from auth.users where id=${p.ownerId}`;
    await db.end();
  }
});
