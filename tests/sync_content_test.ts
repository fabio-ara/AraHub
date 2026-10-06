/**
 * Testes locais do lote dirigido de conteudo Moodle: SQL real no Postgres
 * exclusivo do AraHub (127.0.0.1:55432) e fixture do provedor injetada.
 * Sem rede externa, sem credenciais reais e sem dados pessoais.
 */

import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { AUDITED_FUNCTIONS, MoodleAdapter } from "../src/adapters/moodle.ts";
import { courseJobKind, Sync, type SyncCourseSummary } from "../src/sync.ts";

const DB_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const ORIGIN = "https://fixture.invalid/moodle";
const TOKEN = "synthetic-sync-token-not-a-real-secret";
const COURSE_ID = 101;

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
