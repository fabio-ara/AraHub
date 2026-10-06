/**
 * Testes locais do lote dirigido de conteudo Moodle: SQL real no Postgres
 * exclusivo do AraHub (127.0.0.1:55432) e fixture do provedor injetada.
 * Sem rede externa, sem credenciais reais e sem dados pessoais.
 */

import assert from "node:assert/strict";
import { asOwner, createDb, withJobLease } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { HubError } from "../src/contracts.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { AUDITED_FUNCTIONS, MoodleAdapter } from "../src/adapters/moodle.ts";
import { courseJobKind, Sync, type SyncCourseSummary } from "../src/sync.ts";
import { WorkContext } from "../src/work_context.ts";

const DB_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const ORIGIN = "https://fixture.invalid/moodle";
const TOKEN = "synthetic-sync-token-not-a-real-secret";
const COURSE_ID = 101;

Deno.test("A11 A12 A14: refresh reabre disponibilidade sem apagar relato ou impor progresso monotônico", async () => {
  const { db, hub, a, vault } = await setup();
  let visible = false;
  try {
    const connections = new ConnectionService(
      hub,
      vault,
      factory({
        core_course_get_contents: () => [{
          id: 1,
          name: "Seção",
          section: 1,
          modules: [
            { id: 13, name: "Tarefa", modname: "assign", instance: 401, uservisible: visible },
          ],
        }],
      }),
    );
    const connection = await connections.addMoodle(a, {
      label: "Fixture",
      origin: ORIGIN,
      token: TOKEN,
    });
    const sync = new Sync(hub, connections), work = new WorkContext(hub);
    await sync.courseContent(a, connection.id, COURSE_ID);
    const module =
      (await db`select id from public.hub_entities where owner_id=${a.ownerId} and kind='module'`)[
        0
      ];
    const context = await hub.createContext(a, "Relato sintético");
    await work.bind(a, { context_id: context.id, entity_ids: [module.id], expected_version: 0 });
    const report = await work.reportSubmission(a, {
      context_id: context.id,
      expected_version: 1,
      idempotency_key: crypto.randomUUID(),
      content: "[DADO SINTÉTICO] Pronto, entreguei.",
    });
    visible = true;
    await sync.courseContent(a, connection.id, COURSE_ID);
    const reopened = await hub.entityContext(a, module.id);
    assert.equal(reopened.entity.state.uservisible, true);
    assert.equal(reopened.entity.state.user_report.delta_id, report.memory_commit.id);
    assert.equal(reopened.entity.state.user_report.actual_submission_time, null);
    assert.equal(reopened.entity.state.submitted, undefined);
    const observed =
      await db`select content from public.hub_observations where owner_id=${a.ownerId} and entity_id=${module.id}`;
    assert.deepEqual(observed.map((o) => o.content.uservisible).sort(), [false, true]);
    visible = false;
    await sync.courseContent(a, connection.id, COURSE_ID);
    const unavailableAgain = await hub.entityContext(a, module.id);
    assert.equal(unavailableAgain.entity.state.uservisible, false);
    assert.equal(unavailableAgain.entity.state.user_report.delta_id, report.memory_commit.id);
    assert.equal((await hub.history(a, context.id)).records.length, 1);
  } finally {
    await db.end();
  }
});

function defaultBody(fn: string): unknown {
  switch (fn) {
    case "core_enrol_get_users_courses":
      return [{ id: COURSE_ID, fullname: "Curso Fixture", shortname: "CF" }];
    case "core_course_get_contents":
      return [{
        id: 1,
        name: "Secao 1",
        section: 1,
        modules: [
          { id: 11, name: "Pagina 1", modname: "page", instance: 201 },
          { id: 12, name: "Forum 1", modname: "forum", instance: 301 },
          { id: 13, name: "Tarefa 1", modname: "assign", instance: 401 },
          { id: 14, name: "Livro 1", modname: "book", instance: 202 },
        ],
      }];
    case "mod_page_get_pages_by_courses":
      return [{ id: 201, coursemodule: 11, name: "Pagina 1", content: "<p>Ola</p>" }];
    case "mod_book_get_books_by_courses":
      return [{
        id: 202,
        coursemodule: 14,
        name: "Livro 1",
        chapters: [{ id: 1, title: "Cap 1" }],
      }];
    case "mod_resource_get_resources_by_courses":
      return [{
        id: 203,
        coursemodule: 15,
        name: "Recurso 1",
        contents: [{
          type: "file",
          filename: "a.pdf",
          fileurl: ORIGIN + "/webservice/pluginfile.php/7/mod_resource/content/0/a.pdf",
        }],
      }];
    case "mod_url_get_urls_by_courses":
      return [{ id: 204, coursemodule: 16, name: "Link 1", externalurl: "https://example.com/x" }];
    case "mod_forum_get_forums_by_courses":
      return [{ id: 301, course: COURSE_ID, name: "Forum 1", cmid: 12 }];
    case "mod_forum_get_forum_discussions":
      return { discussions: [{ discussion: 501, name: "Discussao 1" }], warnings: [] };
    case "mod_forum_get_discussion_posts":
      return { posts: [{ id: 601, subject: "Post 1", message: "Oi", userid: 42 }], warnings: [] };
    case "mod_feedback_get_feedbacks_by_courses":
      return [{ id: 701, course: COURSE_ID, name: "Feedback 1", coursemodule: 17 }];
    case "mod_feedback_get_items":
      return [{ id: 801, name: "Pergunta 1", typ: "text" }];
    case "mod_assign_get_assignments":
      return {
        courses: [{
          id: COURSE_ID,
          assignments: [{
            id: 401,
            name: "Tarefa 1",
            duedate: 1700000000,
            intro: "<p>Enunciado</p>",
          }],
        }],
      };
    case "core_completion_get_activities_completion_status":
      return { statuses: [{ cmid: 11, state: 1, timecompleted: 1700000001, tracking: 1 }] };
    case "core_completion_get_course_completion_status":
      return { completed: false, completionstatus: { state: 0 } };
    default:
      return [];
  }
}

function factory(
  overrides: Record<string, unknown | ((params: URLSearchParams) => unknown)> = {},
  offered: readonly string[] = AUDITED_FUNCTIONS,
) {
  return (origin: string, token: string) =>
    new MoodleAdapter({ origin, token }, {
      fetch: (_input, init) => {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const fn = params.get("wsfunction") ?? "";
        if (fn === "core_webservice_get_site_info") {
          return Promise.resolve(Response.json({
            userid: 42,
            username: "aluno",
            siteurl: origin,
            release: "4.5.6+",
            functions: offered.map((name) => ({ name })),
          }));
        }
        const raw = Object.prototype.hasOwnProperty.call(overrides, fn)
          ? overrides[fn]
          : defaultBody(fn);
        const body = typeof raw === "function"
          ? (raw as (params: URLSearchParams) => unknown)(params)
          : raw;
        return Promise.resolve(Response.json(body));
      },
    });
}

async function setup() {
  const db = createDb(DB_URL);
  const hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  const b = { ownerId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${a.ownerId}),(${b.ownerId})`;
  const vault = await TokenVault.fromRawKeys([{
    kid: "fixture",
    key: crypto.getRandomValues(new Uint8Array(32)),
  }]);
  return { db, hub, a, b, vault };
}

Deno.test("A16 A18 A30: lote dirigido preserva hierarquia, dedup e isolamento", async () => {
  const { db, hub, a, b, vault } = await setup();
  try {
    const connections = new ConnectionService(hub, vault, factory());
    const connection = await connections.addMoodle(a, {
      label: "Fixture",
      origin: ORIGIN,
      token: TOKEN,
    });
    const sync = new Sync(hub, connections);
    const first = await sync.courseContent(a, connection.id, COURSE_ID);
    assert.equal(first.job.state, "complete");
    assert.equal(first.summary.coverage, "complete");
    assert.equal(first.summary.gaps.length, 0);
    assert.equal(first.summary.truncated, false);
    // Travessia concluida em uma execucao nao deixa checkpoint pendente.
    const checkpointRows = await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='sync_checkpoint'",
      [a.ownerId],
    );
    assert.equal(checkpointRows[0].n, 0);

    const counts = first.summary.counts;
    const expected: Record<string, number> = {
      courses: 1,
      sections: 1,
      modules: 4,
      pages: 1,
      books: 1,
      resources: 1,
      urls: 1,
      forums: 1,
      discussions: 1,
      posts: 1,
      feedbacks: 1,
      feedback_items: 1,
      assignments: 1,
      completion_activities: 1,
      course_completion: 1,
    };
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(counts[key], value, "contagem " + key);
    }

    const kinds = new Set(
      (await db`select distinct kind from public.hub_entities where owner_id=${a.ownerId}`)
        .map((row) => row.kind as string),
    );
    for (
      const kind of [
        "course",
        "section",
        "module",
        "page",
        "book",
        "resource",
        "url",
        "forum",
        "discussion",
        "post",
        "feedback",
        "feedback_item",
        "assignment",
        "completion_activity",
        "course_completion",
      ]
    ) {
      assert.ok(kinds.has(kind), "entidade " + kind);
    }

    const relationKinds = new Set(
      (await db`select distinct kind from public.hub_relations where owner_id=${a.ownerId}`)
        .map((row) => row.kind as string),
    );
    for (
      const kind of [
        "has_section",
        "has_module",
        "has_content",
        "has_discussion",
        "has_post",
        "has_item",
        "tracks_completion",
        "has_completion",
      ]
    ) {
      assert.ok(relationKinds.has(kind), "relacao " + kind);
    }

    const postRow =
      (await db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='post'`)[
        0
      ];
    assert.equal(postRow.state.author_userid, 42);
    assert.equal((postRow.state.provider_record as Record<string, unknown>).userid, 42);

    const before = await db`select
      (select count(*)::int from public.hub_observations where owner_id=${a.ownerId}) as observations,
      (select count(*)::int from public.hub_entities where owner_id=${a.ownerId}) as entities`;
    const second = await sync.courseContent(a, connection.id, COURSE_ID);
    assert.equal(second.job.state, "complete");
    const after = await db`select
      (select count(*)::int from public.hub_observations where owner_id=${a.ownerId}) as observations,
      (select count(*)::int from public.hub_entities where owner_id=${a.ownerId}) as entities`;
    assert.equal(after[0].observations, before[0].observations);
    assert.equal(after[0].entities, before[0].entities);

    const coursesRun = await sync.courses(a, connection.id) as { job?: { state?: string } };
    assert.equal(coursesRun.job?.state, "complete");

    await assert.rejects(sync.courseContent(b, connection.id, COURSE_ID));
    assert.equal(
      (await db`select count(*)::int as n from public.hub_entities where owner_id=${b.ownerId}`)[0]
        .n,
      0,
    );
  } finally {
    await db.end();
  }
});

Deno.test("A18: capacidade ausente vira lacuna explicita sem apagar conteudo", async () => {
  const { db, hub, a, vault } = await setup();
  try {
    const offered = AUDITED_FUNCTIONS.filter((name) =>
      name !== "mod_book_get_books_by_courses" &&
      name !== "core_completion_get_course_completion_status"
    );
    const overrides: Record<string, unknown> = {
      core_completion_get_activities_completion_status: {
        exception: "moodle_exception",
        errorcode: "nocriteriaset",
        message: "sem criterio",
      },
    };
    const connections = new ConnectionService(hub, vault, factory(overrides, offered));
    const connection = await connections.addMoodle(a, {
      label: "Parcial",
      origin: ORIGIN,
      token: TOKEN,
    });
    const sync = new Sync(hub, connections);
    const run = await sync.courseContent(a, connection.id, COURSE_ID);
    assert.equal(run.summary.coverage, "unavailable");
    assert.equal(run.job.state, "partial");
    const stages = run.summary.gaps.map((gap) => gap.stage);
    assert.ok(stages.includes("books"));
    assert.ok(stages.includes("course_completion"));
    assert.ok(stages.includes("completion_activities"));
    assert.equal(
      run.summary.gaps.find((gap) => gap.stage === "books")?.error_code,
      "function_unavailable",
    );
    assert.equal(
      run.summary.gaps.find((gap) => gap.stage === "completion_activities")?.moodle_code,
      "nocriteriaset",
    );
    assert.equal(run.summary.counts.pages, 1);
    assert.equal(run.summary.counts.books ?? 0, 0);
    assert.equal(run.summary.counts.course_completion ?? 0, 0);

    const again = await sync.courseContent(a, connection.id, COURSE_ID);
    assert.equal(again.summary.counts.pages, 1);
    assert.equal(
      (await db`select count(*)::int as n from public.hub_entities where owner_id=${a.ownerId} and kind='page'`)[
        0
      ]
        .n,
      1,
    );
  } finally {
    await db.end();
  }
});

// Fixture paginada: 2 paginas de discussoes e uma discussao com >100 posts.
const DISCUSSIONS_PAGE_0 = Array.from({ length: 20 }, (_, index) => ({
  discussion: 500 + index,
  name: "Discussao " + (500 + index),
}));
const DISCUSSIONS_PAGE_1 = Array.from({ length: 3 }, (_, index) => ({
  discussion: 520 + index,
  name: "Discussao " + (520 + index),
}));
const BIG_POSTS = Array.from({ length: 150 }, (_, index) => ({
  id: 6000 + index,
  subject: "Post " + index,
  message: "mensagem",
  userid: 42,
  created: 1700000000 + index,
}));
function smallPosts(discussionId: number): unknown[] {
  return [0, 1].map((k) => ({
    id: discussionId * 100 + k,
    subject: "P " + k,
    message: "m",
    userid: 7,
  }));
}
const paginationOverrides: Record<string, (params: URLSearchParams) => unknown> = {
  mod_forum_get_forum_discussions: (params) => {
    const page = Number(params.get("page") ?? "0");
    const discussions = page <= 0 ? DISCUSSIONS_PAGE_0 : page === 1 ? DISCUSSIONS_PAGE_1 : [];
    return { discussions, warnings: [] };
  },
  mod_forum_get_discussion_posts: (params) => {
    const discussionId = Number(params.get("discussionid"));
    return {
      posts: discussionId === 500 ? BIG_POSTS : smallPosts(discussionId),
      warnings: [],
    };
  },
};

// Orcamento minusculo: forca varias execucoes bounded e um checkpoint no meio de
// uma janela de posts (prova que a retomada nao pula apos o corte).
const TINY_BUDGET = 2;

async function driveToCompletion(
  hub: Hub,
  connections: ConnectionService,
  owner: { ownerId: string },
  connectionId: string,
  limit = 40,
): Promise<{ state: string; summaries: SyncCourseSummary[] }> {
  const summaries: SyncCourseSummary[] = [];
  let state = "partial";
  for (let i = 0; i < limit; i++) {
    // A primeira execucao usa orcamento minimo para forcar um checkpoint no meio
    // de uma janela de posts; as demais usam um passo maior, ainda bounded.
    const budget = i === 0 ? TINY_BUDGET : 12;
    // Nova instancia a cada chamada: simula reinicio do processo.
    const sync = new Sync(hub, connections, { forumCallBudget: budget });
    const run = await sync.courseContent(owner, connectionId, COURSE_ID);
    summaries.push(run.summary);
    state = run.job.state as string;
    if (state === "complete") break;
  }
  return { state, summaries };
}

Deno.test("A18: checkpoint retoma paginas e discussao >100 posts apos reinicio", async () => {
  const { db, hub, a, vault } = await setup();
  try {
    const connections = new ConnectionService(hub, vault, factory(paginationOverrides));
    const connection = await connections.addMoodle(a, {
      label: "Paginado",
      origin: ORIGIN,
      token: TOKEN,
    });
    const { state, summaries } = await driveToCompletion(hub, connections, a, connection.id);
    assert.equal(state, "complete");
    assert.ok(summaries.length > 1, "a travessia precisou de mais de uma execucao");
    // Checkpoint gravado no meio de uma janela de posts (offset > 0).
    assert.ok(
      summaries.some((s) => s.checkpoint?.pending === true && s.checkpoint.post_offset > 0),
      "houve retomada da janela de posts sem pular o corte",
    );
    assert.ok(
      summaries.some((s) => s.truncated && s.checkpoint?.pending),
      "houve janela pendente",
    );
    const last = summaries[summaries.length - 1];
    assert.equal(last.checkpoint?.resumed, true, "o ultimo lote retomou o checkpoint");
    assert.equal(last.truncated, false);
    assert.equal(last.coverage, "complete");

    const discussions = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='discussion'",
      [a.ownerId],
    ))[0].n;
    assert.equal(discussions, 23);
    const bigPosts = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='post' and state->>'discussion_id'='500'",
      [a.ownerId],
    ))[0].n;
    assert.equal(bigPosts, 150);
    const allPosts = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='post'",
      [a.ownerId],
    ))[0].n;
    assert.equal(allPosts, 150 + 22 * 2);

    // Reset so apos a janela completa: marcador concluido inerte, nunca removido.
    const cp = (await db.unsafe(
      "select state from public.hub_entities where owner_id=$1 and kind='sync_checkpoint'",
      [a.ownerId],
    ))[0];
    assert.equal(cp.state.completed, true);
  } finally {
    await db.end();
  }
});

Deno.test("A30: lote novo apos 5 tentativas retoma o estado duravel", async () => {
  const { db, hub, a, vault } = await setup();
  try {
    const connections = new ConnectionService(hub, vault, factory(paginationOverrides));
    const connection = await connections.addMoodle(a, {
      label: "Cinco",
      origin: ORIGIN,
      token: TOKEN,
    });
    const sync = new Sync(hub, connections, { forumCallBudget: TINY_BUDGET });
    const enqueued = await sync.jobs.enqueue(a, connection.id, courseJobKind(COURSE_ID));
    let last: { job?: { state?: string } } = {};
    for (let i = 0; i < 5; i++) {
      last = await sync.run(a, enqueued.id) as { job?: { state?: string } };
    }
    assert.equal(last.job?.state, "failed");

    // O ponteiro duravel sobrevive aos 5 lotes queimados.
    const stored = (await db.unsafe(
      "select state from public.hub_entities where owner_id=$1 and kind='sync_checkpoint'",
      [a.ownerId],
    ))[0];
    assert.ok(stored, "o checkpoint sobreviveu as 5 tentativas");
    assert.notEqual(stored.state.completed, true);
    assert.ok(
      Number(stored.state.forum_index) > 0 ||
        Number(stored.state.discussion_index) > 0 ||
        Number(stored.state.post_offset) > 0,
      "houve progresso duravel antes da falha",
    );

    // Um lote novo (attempts zerados) retoma o checkpoint e conclui.
    const { state, summaries } = await driveToCompletion(hub, connections, a, connection.id);
    assert.equal(state, "complete");
    assert.equal(summaries[0].checkpoint?.resumed, true);
    const bigPosts = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='post' and state->>'discussion_id'='500'",
      [a.ownerId],
    ))[0].n;
    assert.equal(bigPosts, 150);
  } finally {
    await db.end();
  }
});

/** Grava um checkpoint duravel como o proprio fluxo faz (papel autenticado). */
async function seedCheckpoint(
  db: ReturnType<typeof createDb>,
  owner: { ownerId: string },
  connectionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await asOwner(
    db,
    owner,
    (tx) =>
      tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
      values(${owner.ownerId},${connectionId},'sync_checkpoint',${
        "course/" + COURSE_ID
      },${"seed"},${
        tx.json(JSON.parse(JSON.stringify(state)))
      }) on conflict(owner_id,connection_id,kind,external_id) do update set state=excluded.state`,
  );
}

// Fixture com mais de 50 foruns: cada forum tem 1 discussao e 1 post. Prova que
// a lista completa e percorrida ao longo de varias execucoes bounded, sem o
// antigo corte permanente nos primeiros 50.
const MANY_FORUMS = 55;
const manyForumsOverrides: Record<string, (params: URLSearchParams) => unknown> = {
  mod_forum_get_forums_by_courses: () =>
    Array.from({ length: MANY_FORUMS }, (_, index) => ({
      id: 3000 + index,
      course: COURSE_ID,
      name: "Forum " + index,
      cmid: 100 + index,
    })),
  mod_forum_get_forum_discussions: (params) => {
    if (Number(params.get("page") ?? "0") > 0) return { discussions: [], warnings: [] };
    const forumId = Number(params.get("forumid"));
    return {
      discussions: [{ discussion: forumId * 10, name: "Disc " + forumId }],
      warnings: [],
    };
  },
  mod_forum_get_discussion_posts: (params) => {
    const discussionId = Number(params.get("discussionid"));
    return {
      posts: [{ id: discussionId * 100 + 1, subject: "P", message: "m", userid: 7 }],
      warnings: [],
    };
  },
};

Deno.test("A18: lista com mais de 50 foruns e percorrida por completo em varias execucoes", async () => {
  const { db, hub, a, vault } = await setup();
  try {
    const connections = new ConnectionService(hub, vault, factory(manyForumsOverrides));
    const connection = await connections.addMoodle(a, {
      label: "Muitos foruns",
      origin: ORIGIN,
      token: TOKEN,
    });
    const { state, summaries } = await driveToCompletion(hub, connections, a, connection.id);
    assert.equal(state, "complete");
    assert.ok(summaries.length > 1, "a travessia precisou de mais de uma execucao");
    const forums = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='forum'",
      [a.ownerId],
    ))[0].n;
    assert.equal(forums, MANY_FORUMS);
    const beyond = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='discussion' and state->>'forum_id'='3054'",
      [a.ownerId],
    ))[0].n;
    assert.equal(beyond, 1, "o 55o forum, alem do antigo corte de 50, foi percorrido");
    const posts = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='post'",
      [a.ownerId],
    ))[0].n;
    assert.equal(posts, MANY_FORUMS);
    assert.ok(
      summaries.every((s) => s.gaps.every((gap) => gap.stage !== "forums")),
      "nenhuma execucao reportou lacuna de foruns",
    );
    const cp = (await db.unsafe(
      "select state from public.hub_entities where owner_id=$1 and kind='sync_checkpoint'",
      [a.ownerId],
    ))[0];
    assert.equal(cp.state.completed, true);
  } finally {
    await db.end();
  }
});

// Fixture com paginas de discussoes bem alem do antigo teto de 50 (a pagina 50
// devolve perpage cheio, logo ha_more=true; a 51 fecha). O ponto de partida e um
// checkpoint duravel em discussion_page=50.
const deepPageOverrides: Record<string, (params: URLSearchParams) => unknown> = {
  mod_forum_get_forum_discussions: (params) => {
    const page = Number(params.get("page") ?? "0");
    if (page === 50) {
      return {
        discussions: Array.from({ length: 20 }, (_, index) => ({
          discussion: 7000 + index,
          name: "D " + (7000 + index),
        })),
        warnings: [],
      };
    }
    if (page === 51) return { discussions: [{ discussion: 7050, name: "D 7050" }], warnings: [] };
    return { discussions: [], warnings: [] };
  },
  mod_forum_get_discussion_posts: (params) => {
    const discussionId = Number(params.get("discussionid"));
    return {
      posts: [{ id: discussionId * 10 + 1, subject: "P", message: "m", userid: 7 }],
      warnings: [],
    };
  },
};

Deno.test("A18: retoma pagina de discussoes alem do antigo teto de 50", async () => {
  const { db, hub, a, vault } = await setup();
  try {
    const connections = new ConnectionService(hub, vault, factory(deepPageOverrides));
    const connection = await connections.addMoodle(a, {
      label: "Paginas profundas",
      origin: ORIGIN,
      token: TOKEN,
    });
    await seedCheckpoint(db, a, connection.id, {
      version: 1,
      course_id: COURSE_ID,
      forum_id: 301,
      forum_index: 0,
      discussion_page: 50,
      discussion_index: 0,
      discussion_id: null,
      post_offset: 0,
      updated_at: new Date().toISOString(),
    });
    const { state, summaries } = await driveToCompletion(hub, connections, a, connection.id);
    assert.equal(state, "complete");
    assert.equal(summaries[0].checkpoint?.resumed, true);
    assert.ok(
      summaries.some((s) => s.checkpoint?.pending === true && s.checkpoint.discussion_page >= 50),
      "houve janela pendente em pagina >= 50",
    );
    const discussions = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='discussion'",
      [a.ownerId],
    ))[0].n;
    assert.equal(discussions, 21);
    const cp = (await db.unsafe(
      "select state from public.hub_entities where owner_id=$1 and kind='sync_checkpoint'",
      [a.ownerId],
    ))[0];
    assert.equal(cp.state.completed, true);
  } finally {
    await db.end();
  }
});

// Ponteiro gravado na ordem antiga (o forum B era o indice 1). O provedor agora
// devolve [B, A]: retomar pela posicao pularia B. A guarda por forum_id recomeca.
const reorderOverrides: Record<string, (params: URLSearchParams) => unknown> = {
  mod_forum_get_forums_by_courses: () => [
    { id: 3002, course: COURSE_ID, name: "Forum B", cmid: 22 },
    { id: 3001, course: COURSE_ID, name: "Forum A", cmid: 21 },
  ],
  mod_forum_get_forum_discussions: (params) => {
    if (Number(params.get("page") ?? "0") > 0) return { discussions: [], warnings: [] };
    const forumId = Number(params.get("forumid"));
    return {
      discussions: [{ discussion: forumId * 10, name: "Disc " + forumId }],
      warnings: [],
    };
  },
  mod_forum_get_discussion_posts: (params) => {
    const discussionId = Number(params.get("discussionid"));
    return {
      posts: [{ id: discussionId * 100 + 1, subject: "P", message: "m", userid: 7 }],
      warnings: [],
    };
  },
};

Deno.test("A18: reordenacao de foruns nao pula forum pendente", async () => {
  const { db, hub, a, vault } = await setup();
  try {
    const connections = new ConnectionService(hub, vault, factory(reorderOverrides));
    const connection = await connections.addMoodle(a, {
      label: "Reordenado",
      origin: ORIGIN,
      token: TOKEN,
    });
    await seedCheckpoint(db, a, connection.id, {
      version: 1,
      course_id: COURSE_ID,
      forum_id: 3002,
      forum_index: 1,
      discussion_page: 0,
      discussion_index: 0,
      discussion_id: null,
      post_offset: 0,
      updated_at: new Date().toISOString(),
    });
    const sync = new Sync(hub, connections);
    const run = await sync.courseContent(a, connection.id, COURSE_ID);
    assert.equal(run.job.state, "complete");
    const forums = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='forum'",
      [a.ownerId],
    ))[0].n;
    assert.equal(forums, 2);
    const pendingForum = (await db.unsafe(
      "select count(*)::int as n from public.hub_entities where owner_id=$1 and kind='discussion' and state->>'discussion_id'='30020'",
      [a.ownerId],
    ))[0].n;
    assert.equal(pendingForum, 1, "o forum pendente nao foi pulado apos a reordenacao");
  } finally {
    await db.end();
  }
});

// Integracao do lease no caminho do Sync: o escopo ocupado fica idle e a posse
// perdida nao consegue finalizar o lote (a escrita seguinte e cercada).
Deno.test("A30: lease serializa o escopo e cerca a posse perdida", async () => {
  const { db, hub, a, vault } = await setup();
  try {
    const connections = new ConnectionService(hub, vault, factory());
    const connection = await connections.addMoodle(a, {
      label: "Lease",
      origin: ORIGIN,
      token: TOKEN,
    });
    const sync = new Sync(hub, connections);
    const first = await sync.jobs.enqueue(a, connection.id, courseJobKind(COURSE_ID));
    const second = await sync.jobs.enqueue(a, connection.id, courseJobKind(COURSE_ID));
    const held = await sync.jobs.claim(a, first.id);
    assert.ok(held, "posse inicial do escopo");

    // Lote irmao do mesmo escopo nao e reivindicado: o run devolve idle.
    const busy = await sync.run(a, second.id) as { state?: string };
    assert.equal(busy.state, "idle");

    // A posse antiga perde o lease; a retomada apos a expiracao vence.
    const stale = withJobLease(a, held.id, held.attempts);
    await db`update public.hub_jobs set lease_until=now()-interval '1 minute'
      where owner_id=${a.ownerId} and id=${held.id}`;
    const retaken = await sync.jobs.claim(a, first.id);
    assert.ok(retaken, "retomada apos a expiracao do lease");
    assert.equal(retaken.attempts, held.attempts + 1);

    // A posse perdida nao finaliza o lote: a escrita e cercada antes do papel.
    await assert.rejects(
      sync.jobs.finish(stale, held.id, held.attempts, "complete", null),
      (error: unknown) => error instanceof HubError && error.code === "job_conflict",
      "a posse perdida nao pode finalizar o lote",
    );
    const done = await sync.jobs.finish(
      withJobLease(a, retaken.id, retaken.attempts),
      retaken.id,
      retaken.attempts,
      "unavailable",
      null,
    ) as { state?: string };
    assert.equal(done.state, "partial");
  } finally {
    await db.end();
  }
});
