/**
 * Testes dirigidos da medicao de sincronizacoes (A30): duracao monotona,
 * amostra de memoria do processo compartilhado e volume real de chamadas ao
 * provedor.
 *
 * SQL real no Postgres exclusivo do AraHub (127.0.0.1:55432) e fixture do
 * provedor injetada (Moodle e Google sinteticos). Sem rede externa, sem
 * credenciais reais e sem conta Google/Moodle conectada. Nenhum mock e
 * apresentado como integracao real.
 *
 * Executar:
 *   deno test --allow-net=127.0.0.1:55432 --allow-env tests/job_metrics_test.ts
 */

import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb, type Db } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import {
  AUDITED_FUNCTIONS,
  type FetchLike as MoodleFetchLike,
  MoodleAdapter,
  type MoodleDeps,
} from "../src/adapters/moodle.ts";
import {
  type FetchLike,
  googleOAuthConfig,
  GoogleReadClient,
  type JsonObject,
  verifierFromJwks,
} from "../src/adapters/google.ts";
import {
  GoogleConnections,
  type GooglePrincipal,
  resolveRequestedScopes,
} from "../src/google_connections.ts";
import { GoogleSync } from "../src/google_sync.ts";
import { Jobs } from "../src/jobs.ts";
import { Sync } from "../src/sync.ts";

const DB_URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const ORIGIN = "https://fixture.invalid/moodle";
const TOKEN = "synthetic-job-metrics-token-not-a-real-secret";
const COURSE_ID = 101;
const CLIENT_ID = "job-metrics-fixture";
const ISSUER = "https://accounts.google.com";

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

// ---------------------------------------------------------------------------
// Fixture Google (Gmail sintetico)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(id: string, historyId: string, subject: string): JsonObject {
  return {
    id,
    threadId: "t-" + id,
    historyId,
    snippet: subject,
    payload: { headers: [{ name: "Subject", value: subject }] },
  };
}

function slicePage<T>(
  items: readonly T[],
  pageToken: string | undefined,
  size: number,
  prefix: string,
): { slice: T[]; next?: string } {
  const start = pageToken && pageToken.startsWith(prefix)
    ? Number(pageToken.slice(prefix.length)) || 0
    : 0;
  const slice = items.slice(start, start + size);
  const nextStart = start + size;
  return nextStart < items.length ? { slice, next: prefix + nextStart } : { slice };
}

interface GoogleFixture {
  messages: JsonObject[];
  pageSize: number;
  failListOnce: boolean;
  providerReads: number;
}

function googleFixture(): GoogleFixture {
  return { messages: [], pageSize: 1, failListOnce: false, providerReads: 0 };
}

function providerFetch(fixture: GoogleFixture): FetchLike {
  return (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return Promise.resolve(jsonResponse({ error: "missing_auth" }, 401));
    }
    fixture.providerReads++;
    if (url.pathname === "/gmail/v1/users/me/messages") {
      if (fixture.failListOnce) {
        fixture.failListOnce = false;
        return Promise.resolve(new Response("upstream error", { status: 503 }));
      }
      const page = slicePage(
        fixture.messages,
        url.searchParams.get("pageToken") ?? undefined,
        fixture.pageSize,
        "gl",
      );
      return Promise.resolve(jsonResponse({
        messages: page.slice.map((item) => ({ id: item.id, threadId: item.threadId })),
        ...(page.next ? { nextPageToken: page.next } : {}),
      }));
    }
    const match = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(.+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const found = fixture.messages.find((item) => item.id === id);
      return Promise.resolve(
        found
          ? jsonResponse(found)
          : jsonResponse({ error: { errors: [{ reason: "notFound" }] } }, 404),
      );
    }
    throw new Error("rota nao mapeada: " + url.pathname);
  };
}

interface GoogleEnv {
  readonly db: Db;
  readonly hub: Hub;
  readonly service: GoogleConnections;
  readonly sign: (claims: Record<string, unknown>) => Promise<string>;
  readonly setTokenResponse: (tokens: unknown) => void;
}

async function googleEnv(fixture: GoogleFixture): Promise<GoogleEnv> {
  const db = createDb(DB_URL);
  const hub = new Hub(db);
  const vault = await TokenVault.fromRawKeys([
    { kid: "fixture", key: crypto.getRandomValues(new Uint8Array(32)) },
  ]);
  const config = googleOAuthConfig({
    clientId: CLIENT_ID,
    redirectUri: "https://hub.fixture.invalid/oauth/google/callback",
  });
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k";
  jwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  let tokenRespond: () => Response = () => jsonResponse({ error: "invalid_grant" }, 400);
  const provider = providerFetch(fixture);
  const fetchImpl: FetchLike = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/token") return Promise.resolve(tokenRespond());
    return provider(input, init);
  };
  const service = new GoogleConnections(hub, vault, config, {
    fetch: fetchImpl,
    verifier: verifierFromJwks(jwks),
    // Honra o transporte observado por execucao composto por client().
    clientFactory: (token, wrapped) =>
      new GoogleReadClient({ accessToken: token, fetch: wrapped ?? fetchImpl }),
  });
  return {
    db,
    hub,
    service,
    sign,
    setTokenResponse: (tokens) => {
      tokenRespond = () => jsonResponse(tokens);
    },
  };
}

async function newGooglePrincipal(db: Db): Promise<GooglePrincipal> {
  const ownerId = crypto.randomUUID();
  await db.unsafe("insert into auth.users(id) values($1)", [ownerId]);
  return { ownerId, sessionId: crypto.randomUUID() };
}

async function authorizeGmail(env: GoogleEnv, p: GooglePrincipal): Promise<string> {
  const scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
  const start = await env.service.start(p, { label: "Conta Google", scopes });
  const nonce = new URL(start.authorization_url).searchParams.get("nonce") as string;
  const idToken = await env.sign({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "google-sub-metrics",
    nonce,
    email: "synthetic@example.invalid",
  });
  env.setTokenResponse({
    access_token: "synthetic-access-marker",
    refresh_token: "synthetic-refresh-marker",
    expires_in: 3600,
    scope: resolveRequestedScopes(scopes).join(" "),
    token_type: "Bearer",
    id_token: idToken,
  });
  const view = await env.service.callback(p, { code: "code-1", state: start.state });
  return view.id;
}

Deno.test("A30 job_metrics: Google conta chamadas reais, erro e retomada por tentativa", async () => {
  const fixture = googleFixture();
  fixture.messages = [message("m1", "100", "A"), message("m2", "200", "B")];
  const env = await googleEnv(fixture);
  try {
    const p = await newGooglePrincipal(env.db);
    const connectionId = await authorizeGmail(env, p);
    fixture.providerReads = 0;
    const sync = new GoogleSync(env.hub, env.service);

    // Paginacao limitada: cada chamada HTTP real entra na contagem.
    const first = await sync.gmail(p, connectionId, { limits: { maxPages: 1 } });
    assert.equal(first.summary.coverage, "partial");
    const firstMetrics = first.summary.metrics as unknown as Record<string, unknown>;
    assertMetricsShape(firstMetrics);
    assert.equal(firstMetrics.calls, fixture.providerReads);
    assert.ok((firstMetrics.calls as number) > 0);

    // Retomada por pageToken: a tentativa seguinte mede so as proprias chamadas.
    const servedBefore = fixture.providerReads;
    const second = await sync.gmail(p, connectionId, { limits: { maxPages: 1 } });
    const secondMetrics = second.summary.metrics as unknown as Record<string, unknown>;
    assertMetricsShape(secondMetrics);
    assert.equal(secondMetrics.calls, fixture.providerReads - servedBefore);
    assert.ok((secondMetrics.calls as number) > 0);
    assert.notEqual(secondMetrics.started_at, firstMetrics.started_at);

    // Uma falha de transporte apos o envio tambem e contada.
    fixture.failListOnce = true;
    const readsBefore = fixture.providerReads;
    const failed = await sync.gmail(p, connectionId, {
      query: "outra-consulta",
      limits: { maxPages: 1 },
    });
    assert.notEqual(failed.summary.coverage, "complete");
    const failedMetrics = failed.summary.metrics as unknown as Record<string, unknown>;
    assertMetricsShape(failedMetrics);
    assert.equal(fixture.providerReads - readsBefore, 1);
    assert.equal(failedMetrics.calls, 1);
  } finally {
    await env.db.end();
  }
});
