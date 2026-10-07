/**
 * Testes dirigidos da medicao de sincronizacoes (A30): duracao monotona,
 * amostra de memoria do processo compartilhado e volume real de chamadas ao
 * provedor.
 *
 * SQL real no Postgres exclusivo do AraHub (127.0.0.1:55432) e fixture do
 * provedor injetada (Moodle sintetico). Sem rede externa, sem credenciais
 * reais e sem conta Moodle conectada. Nenhum mock e apresentado como
 * integracao real.
 *
 * Executar:
 *   deno test --allow-net=127.0.0.1:55432 --allow-env tests/job_metrics_test.ts
 */

import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import {
  AUDITED_FUNCTIONS,
  type FetchLike as MoodleFetchLike,
  MoodleAdapter,
  type MoodleDeps,
} from "../src/adapters/moodle.ts";
import { Jobs } from "../src/jobs.ts";
import { Sync } from "../src/sync.ts";

const DB_URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const ORIGIN = "https://fixture.invalid/moodle";
const TOKEN = "synthetic-job-metrics-token-not-a-real-secret";
const COURSE_ID = 101;

// ---------------------------------------------------------------------------
// Fixture Moodle (estado mutavel por teste)
// ---------------------------------------------------------------------------

function moodleBody(fn: string): unknown {
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
        ],
      }];
    case "mod_page_get_pages_by_courses":
      return [{ id: 201, coursemodule: 11, name: "Pagina 1", content: "<p>Ola</p>" }];
    case "mod_forum_get_forums_by_courses":
      return [{ id: 301, course: COURSE_ID, name: "Forum 1", cmid: 12 }];
    case "mod_forum_get_forum_discussions":
      return { discussions: [{ discussion: 501, name: "Discussao 1" }], warnings: [] };
    case "mod_forum_get_discussion_posts":
      return { posts: [{ id: 601, subject: "Post 1", message: "Oi", userid: 42 }], warnings: [] };
    default:
      return [];
  }
}

interface MoodleFixture {
  served: number;
  errorsServed: number;
  pauseFirst?: () => Promise<void>;
  failOnce: Map<string, number>;
}

function moodleFixture(): MoodleFixture {
  return { served: 0, errorsServed: 0, failOnce: new Map() };
}

function moodleFetch(origin: string, fixture: MoodleFixture): MoodleFetchLike {
  const handle = (init?: RequestInit): Response => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    const fn = params.get("wsfunction") ?? "";
    if (fn === "core_webservice_get_site_info") {
      return Response.json({
        userid: 42,
        username: "aluno",
        siteurl: origin,
        release: "4.5.6+",
        functions: AUDITED_FUNCTIONS.map((name) => ({ name })),
      });
    }
    const remaining = fixture.failOnce.get(fn) ?? 0;
    if (remaining > 0) {
      fixture.failOnce.set(fn, remaining - 1);
      fixture.errorsServed++;
      return new Response("upstream error", { status: 503 });
    }
    return Response.json(moodleBody(fn));
  };
  return (_input, init) => {
    fixture.served++;
    if (fixture.pauseFirst) {
      const pause = fixture.pauseFirst;
      fixture.pauseFirst = undefined;
      return pause().then(() => handle(init));
    }
    return Promise.resolve(handle(init));
  };
}

function moodleFactory(resolve: (origin: string) => MoodleFixture) {
  // Honra as deps por execucao (onRequest) e injeta o transporte sintetico.
  return (origin: string, token: string, deps?: MoodleDeps) =>
    new MoodleAdapter({ origin, token }, { ...deps, fetch: moodleFetch(origin, resolve(origin)) });
}

async function moodleEnv(resolve: (origin: string) => MoodleFixture) {
  const db = createDb(DB_URL);
  const hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() };
  await db.unsafe("insert into auth.users(id) values($1)", [owner.ownerId]);
  const vault = await TokenVault.fromRawKeys([
    { kid: "fixture", key: crypto.getRandomValues(new Uint8Array(32)) },
  ]);
  const connections = new ConnectionService(hub, vault, moodleFactory(resolve));
  return { db, hub, owner, connections };
}

function assertMetricsShape(metrics: Record<string, unknown>): void {
  assert.equal(typeof metrics.duration_ms, "number");
  assert.ok(Number.isInteger(metrics.duration_ms));
  assert.ok((metrics.duration_ms as number) >= 0);
  assert.equal(typeof metrics.calls, "number");
  assert.equal(typeof metrics.started_at, "string");
  assert.equal(typeof metrics.finished_at, "string");
  assert.ok(String(metrics.finished_at) >= String(metrics.started_at));
  const memory = metrics.memory as Record<string, unknown>;
  assert.equal(memory.scope, "process_shared");
  // Amostra do processo compartilhado quando o runtime oferece; no Deno, oferece.
  const end = memory.end as Record<string, unknown> | null;
  assert.ok(end, "amostra final de memoria ausente no Deno");
  assert.ok((end!.rss_bytes as number) > 0);
  // Nenhum dado sensivel no relatorio persistido.
  const serialized = JSON.stringify(metrics);
  assert.ok(!serialized.includes(TOKEN), "token vazou no relatorio");
  assert.ok(!/https?:\/\//.test(serialized), "URL vazou no relatorio");
}

Deno.test("A30 job_metrics: Moodle mede chamadas reais, duracao e memoria", async () => {
  const fixture = moodleFixture();
  const { db, hub, owner, connections } = await moodleEnv(() => fixture);
  try {
    const connection = await connections.addMoodle(owner, {
      label: "Fixture",
      origin: ORIGIN,
      token: TOKEN,
    });
    // A criacao da conexao tambem fala com o provedor; zera para medir so o lote.
    fixture.served = 0;
    const sync = new Sync(hub, connections);
    const result = await sync.courseContent(owner, connection.id, COURSE_ID);

    assert.equal(result.job.state, "complete");
    assert.equal(result.summary.coverage, "complete");
    const metrics = result.summary.metrics as unknown as Record<string, unknown>;
    assertMetricsShape(metrics);
    // Contagem real: uma chamada despachada por requisicao efetivamente enviada.
    assert.equal(metrics.calls, fixture.served);
    assert.ok((metrics.calls as number) > 0);
    assert.equal(result.metrics.calls, metrics.calls);

    // O recibo do lote tambem carrega a medicao.
    const jobCoverage = result.job.coverage as Record<string, unknown>;
    const jobMetrics = jobCoverage.metrics as Record<string, unknown>;
    assert.equal(jobMetrics.calls, fixture.served);

    // Jobs.list devolve o coverage persistido, incluindo a medicao.
    const listed = await new Jobs(db).list(owner);
    const row = listed.find((item) => item.id === result.job.id);
    assert.ok(row, "lote nao encontrado em Jobs.list");
    const persisted = (row!.coverage as Record<string, unknown>).metrics as Record<
      string,
      unknown
    >;
    assert.equal(persisted.calls, fixture.served);
    assert.equal(persisted.duration_ms, metrics.duration_ms);
  } finally {
    await db.end();
  }
});

Deno.test("A30 job_metrics: erro do provedor e contado e a retomada mede a proxima tentativa", async () => {
  const fixture = moodleFixture();
  const { db, hub, owner, connections } = await moodleEnv(() => fixture);
  try {
    const connection = await connections.addMoodle(owner, {
      label: "Fixture",
      origin: ORIGIN,
      token: TOKEN,
    });
    fixture.served = 0;
    // A primeira busca de discussoes falha no transporte (503) apos ser enviada.
    fixture.failOnce.set("mod_forum_get_forum_discussions", 1);
    const sync = new Sync(hub, connections);
    const first = await sync.courseContent(owner, connection.id, COURSE_ID);

    assert.notEqual(first.summary.coverage, "complete");
    assert.equal(fixture.errorsServed, 1);
    const firstMetrics = first.summary.metrics as unknown as Record<string, unknown>;
    assertMetricsShape(firstMetrics);
    // A chamada que voltou com erro saiu do processo e entrou na contagem.
    assert.equal(firstMetrics.calls, fixture.served);
    assert.ok((firstMetrics.calls as number) > 0);

    // Retomada: o mesmo lote e reivindicado e executado de novo.
    const servedBefore = fixture.served;
    const second = await sync.run(owner, first.job.id as string);
    assert.ok(second.summary, "retomada sem resumo");
    const secondMetrics = second.summary!.metrics as unknown as Record<string, unknown>;
    assertMetricsShape(secondMetrics);
    assert.equal(secondMetrics.calls, fixture.served - servedBefore);
    assert.ok((secondMetrics.calls as number) > 0);
    // Cada tentativa tem sua propria medicao.
    assert.notEqual(secondMetrics.started_at, firstMetrics.started_at);
  } finally {
    await db.end();
  }
});

Deno.test("A30 job_metrics: execucoes simultaneas nao misturam contagem", async () => {
  const fixtureA = moodleFixture();
  const fixtureB = moodleFixture();
  // Conexoes distintas (origens distintas) escolhem transportes/fixtures distintas.
  const originA = ORIGIN;
  const originB = "https://fixture.invalid/moodle-b";
  const { db, hub, owner, connections } = await moodleEnv((origin) =>
    origin === originB ? fixtureB : fixtureA
  );
  try {
    const connectionA = await connections.addMoodle(owner, {
      label: "A",
      origin: originA,
      token: TOKEN,
    });
    const connectionB = await connections.addMoodle(owner, {
      label: "B",
      origin: originB,
      token: TOKEN,
    });
    fixtureA.served = 0;
    fixtureB.served = 0;
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    // B fica suspenso na primeira chamada enquanto A termina.
    fixtureB.pauseFirst = () => gate;

    const sync = new Sync(hub, connections);
    const promiseA = sync.courseContent(owner, connectionA.id, COURSE_ID);
    const promiseB = sync.courseContent(owner, connectionB.id, COURSE_ID);
    const resultA = await promiseA;
    releaseB();
    const resultB = await promiseB;

    const metricsA = resultA.summary.metrics as unknown as Record<string, unknown>;
    const metricsB = resultB.summary.metrics as unknown as Record<string, unknown>;
    assertMetricsShape(metricsA);
    assertMetricsShape(metricsB);
    // Cada execucao enxerga apenas as proprias chamadas, mesmo sobrepostas.
    assert.equal(metricsA.calls, fixtureA.served);
    assert.equal(metricsB.calls, fixtureB.served);
    assert.ok((metricsA.calls as number) > 0);
    assert.ok((metricsB.calls as number) > 0);
    assert.notEqual(metricsA.calls, fixtureA.served + fixtureB.served);
  } finally {
    await db.end();
  }
});
