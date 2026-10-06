/**
 * Testes locais da sincronizacao duravel de leitura do Google.
 *
 * SQL real no Postgres exclusivo do AraHub (127.0.0.1:55432) e fixture do provedor
 * injetada (fetch sintetico nos endpoints oficiais). Sem OAuth real, sem conta
 * Google conectada, sem rede externa e sem escrita remota. Nenhum mock e
 * apresentado como integracao real.
 *
 * Executar:
 *   deno test --allow-net=127.0.0.1:55432 --allow-env tests/google_sync_test.ts
 */

import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb, type Db } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { HubError } from "../src/contracts.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
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

const DB_URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const CLIENT_ID = "google-sync-fixture";
const ISSUER = "https://accounts.google.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Fixture do provedor (estado mutavel por teste)
// ---------------------------------------------------------------------------

interface Fixture {
  pauseRead?: () => Promise<void>;
  gmailMessages: JsonObject[];
  gmailListPageSize: number;
  gmailListCalls: number;
  historyRecords: JsonObject[];
  historyExpired: boolean;
  historyPageSize: number;
  historyId: string;
  calendarEvents: JsonObject[];
  calendarDelta: JsonObject[];
  calendarInvalidSyncToken: boolean;
  calendarPageSize: number;
  calendarSyncToken: string;
  driveStart: string;
  driveNewStart: string;
  driveChanges: JsonObject[];
  driveChangePageSize: number;
  driveExpired: boolean;
  driveFiles: JsonObject[];
  driveFilePageSize: number;
  driveChangesCalls: number;
  historyCalls: Array<{ startHistoryId: string | null; pageToken: string | null }>;
  calendarCalls: Array<{
    syncToken: string | null;
    pageToken: string | null;
    timeMin: string | null;
    timeMax: string | null;
  }>;
  providerReads: number;
}

function baseFixture(): Fixture {
  return {
    gmailMessages: [],
    gmailListPageSize: 50,
    gmailListCalls: 0,
    historyRecords: [],
    historyExpired: false,
    historyPageSize: 50,
    historyId: "0",
    calendarEvents: [],
    calendarDelta: [],
    calendarInvalidSyncToken: false,
    calendarPageSize: 50,
    calendarSyncToken: "sync-0",
    driveStart: "sp-0",
    driveNewStart: "sp-0b",
    driveChanges: [],
    driveChangePageSize: 50,
    driveExpired: false,
    driveFiles: [],
    driveFilePageSize: 50,
    driveChangesCalls: 0,
    historyCalls: [],
    calendarCalls: [],
    providerReads: 0,
  };
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

function file(id: string, name: string): JsonObject {
  return { id, name, mimeType: "application/pdf", modifiedTime: "2026-10-01T00:00:00Z" };
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

function providerFetch(fixture: Fixture): FetchLike {
  return (input, init) => {
    if (fixture.pauseRead) {
      const pause = fixture.pauseRead;
      fixture.pauseRead = undefined;
      return pause().then(() => providerFetch(fixture)(input, init));
    }
    const url = new URL(String(input));
    const host = url.hostname;
    fixture.providerReads++;
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return Promise.resolve(jsonResponse({ error: "missing_auth" }, 401));
    }
    if (host === "gmail.googleapis.com") {
      if (url.pathname === "/gmail/v1/users/me/messages") {
        fixture.gmailListCalls++;
        const page = slicePage(
          fixture.gmailMessages,
          url.searchParams.get("pageToken") ?? undefined,
          fixture.gmailListPageSize,
          "gl",
        );
        return Promise.resolve(jsonResponse({
          messages: page.slice.map((m) => ({ id: m.id, threadId: m.threadId })),
          ...(page.next ? { nextPageToken: page.next } : {}),
        }));
      }
      if (url.pathname === "/gmail/v1/users/me/history") {
        if (fixture.historyExpired) {
          return Promise.resolve(
            jsonResponse({ error: { errors: [{ reason: "notFound" }] } }, 404),
          );
        }
        fixture.historyCalls.push({
          startHistoryId: url.searchParams.get("startHistoryId"),
          pageToken: url.searchParams.get("pageToken"),
        });
        const page = slicePage(
          fixture.historyRecords,
          url.searchParams.get("pageToken") ?? undefined,
          fixture.historyPageSize,
          "gh",
        );
        return Promise.resolve(jsonResponse({
          history: page.slice,
          ...(page.next ? { nextPageToken: page.next } : {}),
          historyId: fixture.historyId,
        }));
      }
      const match = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(.+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const found = fixture.gmailMessages.find((m) => m.id === id);
        if (!found) {
          return Promise.resolve(
            jsonResponse({ error: { errors: [{ reason: "notFound" }] } }, 404),
          );
        }
        return Promise.resolve(jsonResponse(found));
      }
      throw new Error("rota gmail nao mapeada: " + url.pathname);
    }
    if (host === "www.googleapis.com") {
      if (/^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(url.pathname)) {
        const syncToken = url.searchParams.get("syncToken");
        fixture.calendarCalls.push({
          syncToken,
          pageToken: url.searchParams.get("pageToken"),
          timeMin: url.searchParams.get("timeMin"),
          timeMax: url.searchParams.get("timeMax"),
        });
        if (syncToken) {
          if (fixture.calendarInvalidSyncToken) {
            return Promise.resolve(
              jsonResponse({ error: { errors: [{ reason: "fullSyncRequired" }] } }, 410),
            );
          }
          const page = slicePage(
            fixture.calendarDelta,
            url.searchParams.get("pageToken") ?? undefined,
            fixture.calendarPageSize,
            "ce",
          );
          return Promise.resolve(jsonResponse({
            items: page.slice,
            ...(page.next
              ? { nextPageToken: page.next }
              : { nextSyncToken: fixture.calendarSyncToken }),
          }));
        }
        const page = slicePage(
          fixture.calendarEvents,
          url.searchParams.get("pageToken") ?? undefined,
          fixture.calendarPageSize,
          "ce",
        );
        return Promise.resolve(jsonResponse({
          items: page.slice,
          ...(page.next
            ? { nextPageToken: page.next }
            : { nextSyncToken: fixture.calendarSyncToken }),
        }));
      }
      if (url.pathname === "/drive/v3/changes/startPageToken") {
        return Promise.resolve(jsonResponse({ startPageToken: fixture.driveStart }));
      }
      if (url.pathname === "/drive/v3/changes") {
        fixture.driveChangesCalls++;
        if (fixture.driveExpired) {
          return Promise.resolve(
            jsonResponse({ error: { errors: [{ reason: "notFound" }] } }, 410),
          );
        }
        const page = slicePage(
          fixture.driveChanges,
          url.searchParams.get("pageToken") ?? undefined,
          fixture.driveChangePageSize,
          "dc",
        );
        return Promise.resolve(jsonResponse({
          changes: page.slice,
          ...(page.next ? { nextPageToken: page.next } : {}),
          newStartPageToken: fixture.driveNewStart,
        }));
      }
      if (url.pathname === "/drive/v3/files") {
        const page = slicePage(
          fixture.driveFiles,
          url.searchParams.get("pageToken") ?? undefined,
          fixture.driveFilePageSize,
          "df",
        );
        return Promise.resolve(jsonResponse({
          files: page.slice,
          ...(page.next ? { nextPageToken: page.next } : {}),
        }));
      }
      throw new Error("rota googleapis nao mapeada: " + url.pathname);
    }
    throw new Error("host nao mapeado: " + host);
  };
}

// ---------------------------------------------------------------------------
// Ambiente (SQL local + servico Google com fetch injetado)
// ---------------------------------------------------------------------------

interface Env {
  readonly db: Db;
  readonly hub: Hub;
  readonly service: GoogleConnections;
  readonly sign: (claims: Record<string, unknown>) => Promise<string>;
  readonly setTokenResponse: (tokens: unknown) => void;
}

async function makeEnv(fixture: Fixture): Promise<Env> {
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
    clientFactory: (token) => new GoogleReadClient({ accessToken: token, fetch: fetchImpl }),
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

async function newPrincipal(db: Db): Promise<GooglePrincipal> {
  const ownerId = crypto.randomUUID();
  await db.unsafe("insert into auth.users(id) values($1)", [ownerId]);
  return { ownerId, sessionId: crypto.randomUUID() };
}

async function authorize(
  env: Env,
  p: GooglePrincipal,
  opts: { readonly scopes: readonly string[]; readonly sub?: string },
): Promise<string> {
  const start = await env.service.start(p, { label: "Conta Google", scopes: opts.scopes });
  const nonce = new URL(start.authorization_url).searchParams.get("nonce") as string;
  const idToken = await env.sign({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: opts.sub ?? "google-sub-1",
    nonce,
    email: "synthetic@example.invalid",
  });
  const granted = resolveRequestedScopes(opts.scopes).join(" ");
  env.setTokenResponse({
    access_token: "synthetic-access-marker",
    refresh_token: "synthetic-refresh-marker",
    expires_in: 3600,
    scope: granted,
    token_type: "Bearer",
    id_token: idToken,
  });
  const view = await env.service.callback(p, { code: "code-1", state: start.state });
  return view.id;
}

async function countEntities(db: Db, ownerId: string, kind: string): Promise<number> {
  return (await db`select count(*)::int as n from public.hub_entities where owner_id=${ownerId} and kind=${kind}`)[
    0
  ]
    .n as number;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

Deno.test("Google sync: processo concorrente não muda descritor nem executa a mesma chave", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [message("message-1", "900", "Fixture")];
  fixture.historyId = "900";
  const env = await makeEnv(fixture);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => entered = resolve);
  let running: Promise<unknown> | undefined;
  try {
    const p = await newPrincipal(env.db);
    const connectionId = await authorize(env, p, { scopes: ["gmail_read"] });
    fixture.pauseRead = async () => {
      entered();
      await blocked;
    };
    running = new GoogleSync(env.hub, env.service).gmail(p, connectionId, {
      query: "label:fixture",
    });
    await reading;
    const jobs = await new Jobs(env.db).list(p);
    const active = jobs.find((job) => job.state === "running")!;
    const before = (await new GoogleSync(env.hub, env.service).state(p, connectionId)).states;
    await assert.rejects(
      new GoogleSync(env.hub, env.service).gmail(p, connectionId, {
        query: "label:fixture",
        rebuild: true,
      }),
      (e: unknown) => e instanceof HubError && e.code === "sync_busy",
    );
    const queued = await new Jobs(env.db).enqueue(p, connectionId, active.kind);
    assert.deepEqual(await new GoogleSync(env.hub, env.service).run(p, queued.id), {
      state: "idle",
    });
    assert.deepEqual(
      (await new GoogleSync(env.hub, env.service).state(p, connectionId)).states,
      before,
    );
    release();
    const complete = await running as { summary: { coverage: string } };
    assert.equal(complete.summary.coverage, "complete");
    const resumed = await new GoogleSync(env.hub, env.service).run(p, queued.id);
    assert.ok("summary" in resumed);
    assert.equal(resumed.summary.coverage, "complete");
    assert.equal(await countEntities(env.db, p.ownerId, "gmail_message"), 1);
  } finally {
    release();
    await running?.catch(() => {});
    await env.db.end();
  }
});

Deno.test("Gmail: consulta dirigida, history incremental e reconstrucao apos expiracao", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [message("m1", "100", "Assunto 1"), message("m2", "200", "Assunto 2")];
  fixture.historyId = "200";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    const first = await sync.gmail(a, connectionId, {
      query: "from:professor",
      limits: { maxPages: 5, maxItems: 100 },
    });
    assert.equal(first.summary.coverage, "complete");
    assert.equal(first.summary.mode, "initial");
    assert.equal(first.summary.cursor, "200");
    assert.equal(first.summary.cursor_kind, "history_id");
    assert.equal(first.summary.counts.gmail_messages, 2);
    assert.equal(first.job.state, "complete");
    assert.equal(await countEntities(env.db, a.ownerId, "gmail_message"), 2);

    const subject = (await env
      .db`select title,state from public.hub_entities where owner_id=${a.ownerId} and kind='gmail_message' and external_id='m1'`)[
        0
      ];
    assert.equal(subject.title, "Assunto 1");
    assert.equal(subject.state.history_id, "100");
    const obsBefore = (await env
      .db`select count(*)::int as n from public.hub_observations where owner_id=${a.ownerId}`)[0]
      .n as number;

    // Idempotencia: repetir nao duplica observacoes nem entidades.
    const again = await sync.gmail(a, connectionId, {
      query: "from:professor",
      limits: { maxPages: 5, maxItems: 100 },
    });
    assert.equal(again.summary.mode, "incremental");
    assert.equal(again.summary.cursor, "200");
    const obsAfter = (await env
      .db`select count(*)::int as n from public.hub_observations where owner_id=${a.ownerId}`)[0]
      .n as number;
    assert.equal(obsAfter, obsBefore);

    // Incremental: nova mensagem entra por history.
    fixture.gmailMessages.push(message("m3", "300", "Assunto 3"));
    fixture.historyRecords = [{
      id: "300",
      messagesAdded: [{ message: { id: "m3", threadId: "t-m3" } }],
    }];
    fixture.historyId = "300";
    const inc = await sync.gmail(a, connectionId, { query: "from:professor" });
    assert.equal(inc.summary.mode, "incremental");
    assert.equal(inc.summary.coverage, "complete");
    assert.equal(inc.summary.cursor, "300");
    assert.equal(inc.summary.counts.gmail_messages, 1);
    assert.equal(inc.summary.counts.gmail_history, 1);

    // Expiracao do history: reconstrucao limitada por consulta, cursor refeito.
    fixture.historyExpired = true;
    fixture.gmailMessages.push(message("m4", "400", "Assunto 4"));
    const rebuilt = await sync.gmail(a, connectionId, { query: "from:professor" });
    assert.equal(rebuilt.summary.rebuilt, true);
    assert.equal(rebuilt.summary.mode, "rebuild");
    assert.equal(rebuilt.summary.coverage, "complete");
    assert.equal(rebuilt.summary.cursor, "400");
    assert.ok(rebuilt.summary.gaps.some((gap) => gap.error_code === "history_expired"));
    assert.equal(await countEntities(env.db, a.ownerId, "gmail_message"), 4);
  } finally {
    await env.db.end();
  }
});

Deno.test("Gmail: paginacao limitada nao avanca o cursor e grava checkpoint retomavel", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [
    message("m1", "100", "A"),
    message("m2", "200", "B"),
    message("m3", "300", "C"),
  ];
  fixture.gmailListPageSize = 1;
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    const partial = await sync.gmail(a, connectionId, {
      query: "x",
      limits: { maxPages: 1, maxItems: 100 },
    });
    assert.equal(partial.summary.coverage, "partial");
    assert.equal(partial.summary.cursor, null);
    assert.notEqual(partial.summary.resume, null);
    assert.notEqual(partial.job.state, "complete");
    assert.equal(await countEntities(env.db, a.ownerId, "gmail_message"), 1);

    // O dono amplia o limite (root estende o lote) e a retomada continua do checkpoint.
    const full = await sync.gmail(a, connectionId, {
      query: "x",
      limits: { maxPages: 10, maxItems: 100 },
    });
    assert.equal(full.summary.coverage, "complete");
    assert.equal(full.summary.cursor, "300");
    assert.equal(await countEntities(env.db, a.ownerId, "gmail_message"), 3);
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

Deno.test("Calendar: syncToken invalido reconstroi janela preservando recorrencia e dia inteiro", async () => {
  const fixture = baseFixture();
  fixture.calendarEvents = [
    {
      id: "ev-rec",
      summary: "Aula semanal",
      start: { dateTime: "2026-10-06T10:00:00-03:00" },
      end: { dateTime: "2026-10-06T12:00:00-03:00" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
      status: "confirmed",
    },
    {
      id: "ev-allday",
      summary: "Feriado",
      start: { date: "2026-10-12" },
      end: { date: "2026-10-13" },
      status: "confirmed",
    },
    {
      id: "ev-cancel",
      summary: "Cancelado",
      start: { dateTime: "2026-10-07T08:00:00-03:00" },
      end: { dateTime: "2026-10-07T09:00:00-03:00" },
      status: "cancelled",
    },
  ];
  fixture.calendarSyncToken = "sync-1";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["calendar_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    const first = await sync.calendar(a, connectionId, {
      calendar_id: "primary",
      limits: { maxPages: 5, maxItems: 100 },
    });
    assert.equal(first.summary.coverage, "complete");
    assert.equal(first.summary.mode, "initial");
    assert.equal(first.summary.cursor, "sync-1");
    assert.equal(first.summary.cursor_kind, "sync_token");
    assert.equal(first.summary.counts.calendar_events, 3);
    assert.equal(first.summary.counts.calendar_cancelled, 1);

    const rec = (await env
      .db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='calendar_event' and external_id='primary/ev-rec'`)[
        0
      ];
    assert.equal(rec.state.all_day, false);
    assert.deepEqual(rec.state.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=TU"]);
    const allDay = (await env
      .db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='calendar_event' and external_id='primary/ev-allday'`)[
        0
      ];
    assert.equal(allDay.state.all_day, true);

    // Incremental valido avanca o cursor.
    fixture.calendarSyncToken = "sync-2";
    fixture.calendarDelta = [{
      id: "ev-new",
      summary: "Novo",
      start: { dateTime: "2026-10-08T10:00:00-03:00" },
      end: { dateTime: "2026-10-08T11:00:00-03:00" },
      status: "confirmed",
    }];
    const inc = await sync.calendar(a, connectionId, { calendar_id: "primary" });
    assert.equal(inc.summary.mode, "incremental");
    assert.equal(inc.summary.coverage, "complete");
    assert.equal(inc.summary.cursor, "sync-2");
    assert.equal(inc.summary.counts.calendar_events, 1);

    // syncToken invalido: reconstrucao limitada; nada e apagado.
    fixture.calendarInvalidSyncToken = true;
    fixture.calendarSyncToken = "sync-3";
    const rebuilt = await sync.calendar(a, connectionId, { calendar_id: "primary" });
    assert.equal(rebuilt.summary.rebuilt, true);
    assert.equal(rebuilt.summary.coverage, "complete");
    assert.equal(rebuilt.summary.cursor, "sync-3");
    assert.ok(rebuilt.summary.gaps.some((gap) => gap.error_code === "full_sync_required"));
    const stillRec = (await env
      .db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='calendar_event' and external_id='primary/ev-rec'`)[
        0
      ];
    assert.deepEqual(stillRec.state.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=TU"]);
    assert.equal(stillRec.state.all_day, false);
    const stillAllDay = (await env
      .db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='calendar_event' and external_id='primary/ev-allday'`)[
        0
      ];
    assert.equal(stillAllDay.state.all_day, true);
    const cancelled = (await env
      .db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='calendar_event' and external_id='primary/ev-cancel'`)[
        0
      ];
    assert.equal(cancelled.state.status, "cancelled");
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Retomada real por pageToken (history.list / events.list)
// ---------------------------------------------------------------------------

Deno.test("Gmail: history.list retoma por pageToken sem repetir pagina nem pular item", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [
    message("m1", "100", "A"),
    message("m2", "200", "B"),
    message("m3", "300", "C"),
  ];
  fixture.historyId = "300";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    // Cursor historyId estabelecido por leitura inicial completa.
    const initial = await sync.gmail(a, connectionId, {
      query: "x",
      limits: { maxPages: 5, maxItems: 100 },
    });
    assert.equal(initial.summary.cursor, "300");

    // Tres paginas de history, uma por chamada (maxPages=1).
    fixture.historyRecords = [
      { id: "301", messagesAdded: [{ message: { id: "m1", threadId: "t-m1" } }] },
      { id: "302", messagesAdded: [{ message: { id: "m2", threadId: "t-m2" } }] },
      { id: "303", messagesAdded: [{ message: { id: "m3", threadId: "t-m3" } }] },
    ];
    fixture.historyPageSize = 1;
    fixture.historyId = "303";
    const limits = { maxPages: 1, maxItems: 100 };

    const first = await sync.gmail(a, connectionId, { query: "x", limits });
    assert.equal(first.summary.coverage, "partial");
    assert.equal(first.summary.cursor, "300");
    assert.equal(first.summary.counts.gmail_history, 1);
    assert.equal((first.summary.resume as Record<string, unknown>).page_token, "gh1");

    const second = await sync.gmail(a, connectionId, { query: "x", limits });
    assert.equal(second.summary.coverage, "partial");
    assert.equal(second.summary.cursor, "300");
    assert.equal(second.summary.counts.gmail_history, 1);
    assert.equal((second.summary.resume as Record<string, unknown>).page_token, "gh2");

    const third = await sync.gmail(a, connectionId, { query: "x", limits });
    assert.equal(third.summary.coverage, "complete");
    assert.equal(third.summary.cursor, "303");
    assert.equal(third.summary.cursor_kind, "history_id");
    assert.equal(third.summary.resume, null);

    // Cada pagina pedida exatamente uma vez, sob o mesmo startHistoryId.
    assert.deepEqual(fixture.historyCalls.map((call) => call.pageToken), [null, "gh1", "gh2"]);
    assert.deepEqual(
      fixture.historyCalls.map((call) => call.startHistoryId),
      ["300", "300", "300"],
    );
    // Nenhum item pulado: as tres entidades de history foram gravadas.
    assert.equal(await countEntities(env.db, a.ownerId, "gmail_history"), 3);
    // Cursor so avancou na chamada que completou a janela.
    const persisted = (await env
      .db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='google_sync_state'`)[
        0
      ];
    assert.equal(persisted.state.cursor, "303");
  } finally {
    await env.db.end();
  }
});

Deno.test("Calendar: events.list incremental retoma por pageToken com o mesmo syncToken", async () => {
  const fixture = baseFixture();
  fixture.calendarSyncToken = "sync-1";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["calendar_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    const initial = await sync.calendar(a, connectionId, {
      calendar_id: "primary",
      limits: { maxPages: 5, maxItems: 100 },
    });
    assert.equal(initial.summary.cursor, "sync-1");
    fixture.calendarCalls.length = 0;

    fixture.calendarDelta = [
      { id: "d1", summary: "D1", start: { date: "2026-10-10" }, status: "confirmed" },
      { id: "d2", summary: "D2", start: { date: "2026-10-11" }, status: "confirmed" },
      { id: "d3", summary: "D3", start: { date: "2026-10-12" }, status: "confirmed" },
    ];
    fixture.calendarPageSize = 1;
    fixture.calendarSyncToken = "sync-2";
    const limits = { maxPages: 1, maxItems: 100 };

    const first = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(first.summary.mode, "incremental");
    assert.equal(first.summary.coverage, "partial");
    assert.equal(first.summary.cursor, "sync-1");
    assert.equal((first.summary.resume as Record<string, unknown>).page_token, "ce1");

    const second = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(second.summary.coverage, "partial");
    assert.equal(second.summary.cursor, "sync-1");
    assert.equal((second.summary.resume as Record<string, unknown>).page_token, "ce2");

    const third = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(third.summary.coverage, "complete");
    assert.equal(third.summary.cursor, "sync-2");
    assert.equal(third.summary.cursor_kind, "sync_token");
    assert.equal(third.summary.resume, null);

    // A paginacao reusa o mesmo syncToken; cada pagina aparece uma vez.
    assert.deepEqual(fixture.calendarCalls.map((call) => call.syncToken), [
      "sync-1",
      "sync-1",
      "sync-1",
    ]);
    assert.deepEqual(fixture.calendarCalls.map((call) => call.pageToken), [null, "ce1", "ce2"]);
    assert.equal(await countEntities(env.db, a.ownerId, "calendar_event"), 3);
  } finally {
    await env.db.end();
  }
});

Deno.test("Calendar: janela de leitura retoma por pageToken mantendo timeMin/timeMax", async () => {
  const fixture = baseFixture();
  fixture.calendarEvents = [
    { id: "e1", summary: "E1", start: { date: "2026-10-10" }, status: "confirmed" },
    { id: "e2", summary: "E2", start: { date: "2026-10-11" }, status: "confirmed" },
    { id: "e3", summary: "E3", start: { date: "2026-10-12" }, status: "confirmed" },
  ];
  fixture.calendarPageSize = 1;
  fixture.calendarSyncToken = "sync-r";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["calendar_read"] });
    const sync = new GoogleSync(env.hub, env.service);
    const limits = { maxPages: 1, maxItems: 100 };

    const first = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(first.summary.mode, "initial");
    assert.equal(first.summary.coverage, "partial");
    assert.equal(first.summary.cursor, null);
    assert.equal((first.summary.resume as Record<string, unknown>).page_token, "ce1");

    const second = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(second.summary.coverage, "partial");
    assert.equal(second.summary.cursor, null);
    assert.equal((second.summary.resume as Record<string, unknown>).page_token, "ce2");

    const third = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(third.summary.coverage, "complete");
    assert.equal(third.summary.cursor, "sync-r");
    assert.equal(third.summary.resume, null);

    assert.deepEqual(fixture.calendarCalls.map((call) => call.pageToken), [null, "ce1", "ce2"]);
    // A janela nao muda entre retomadas (pageToken exige a mesma consulta).
    const windows = fixture.calendarCalls.map((call) => call.timeMin + "|" + call.timeMax);
    assert.equal(new Set(windows).size, 1);
    assert.equal(await countEntities(env.db, a.ownerId, "calendar_event"), 3);
  } finally {
    await env.db.end();
  }
});

Deno.test("Calendar: syncToken expirado reconstroi em paginas preservando cursor anterior", async () => {
  const fixture = baseFixture();
  fixture.calendarSyncToken = "sync-1";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["calendar_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    const initial = await sync.calendar(a, connectionId, {
      calendar_id: "primary",
      limits: { maxPages: 5, maxItems: 100 },
    });
    assert.equal(initial.summary.cursor, "sync-1");
    fixture.calendarCalls.length = 0;

    fixture.calendarInvalidSyncToken = true;
    fixture.calendarEvents = [
      { id: "r1", summary: "R1", start: { date: "2026-10-10" }, status: "confirmed" },
      { id: "r2", summary: "R2", start: { date: "2026-10-11" }, status: "confirmed" },
      { id: "r3", summary: "R3", start: { date: "2026-10-12" }, status: "confirmed" },
    ];
    fixture.calendarPageSize = 1;
    fixture.calendarSyncToken = "sync-9";
    const limits = { maxPages: 1, maxItems: 100 };

    const first = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(first.summary.mode, "rebuild");
    assert.equal(first.summary.rebuilt, true);
    assert.equal(first.summary.coverage, "partial");
    assert.equal(first.summary.cursor, "sync-1");
    assert.ok(first.summary.gaps.some((gap) => gap.error_code === "full_sync_required"));
    assert.equal((first.summary.resume as Record<string, unknown>).page_token, "ce1");

    const second = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(second.summary.mode, "rebuild");
    assert.equal(second.summary.rebuilt, true);
    assert.equal(second.summary.cursor, "sync-1");

    const third = await sync.calendar(a, connectionId, { calendar_id: "primary", limits });
    assert.equal(third.summary.coverage, "complete");
    assert.equal(third.summary.cursor, "sync-9");
    assert.equal(third.summary.resume, null);

    // O probe incremental (410) ocorre uma vez; as paginas de rebuild seguem em sequencia.
    const rebuildCalls = fixture.calendarCalls.filter((call) => call.syncToken === null);
    assert.deepEqual(rebuildCalls.map((call) => call.pageToken), [null, "ce1", "ce2"]);
    assert.equal(await countEntities(env.db, a.ownerId, "calendar_event"), 3);
  } finally {
    await env.db.end();
  }
});

Deno.test("Gmail: truncamento por message_limit na pagina retoma sem pular nem relistar", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [message("m1", "100", "A")];
  fixture.historyId = "100";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    // O descritor (message_limit) define a chave; a leitura inicial usa o mesmo.
    const input = { query: "x", message_limit: 1, limits: { maxPages: 5, maxItems: 100 } };
    const initial = await sync.gmail(a, connectionId, input);
    assert.equal(initial.summary.cursor, "100");

    // Uma pagina de history com dois ids; message_limit=1 deixa o segundo pendente.
    fixture.gmailMessages.push(message("m2", "200", "B"));
    fixture.historyRecords = [{
      id: "201",
      messagesAdded: [
        { message: { id: "m1", threadId: "t-m1" } },
        { message: { id: "m2", threadId: "t-m2" } },
      ],
    }];
    fixture.historyPageSize = 50;
    fixture.historyId = "201";

    const first = await sync.gmail(a, connectionId, input);
    assert.equal(first.summary.coverage, "partial");
    assert.equal(first.summary.cursor, "100");
    assert.equal(first.summary.truncated, true);
    assert.equal(first.summary.counts.gmail_history, 1);
    assert.equal(first.summary.counts.gmail_messages, 1);
    const resume = first.summary.resume as Record<string, unknown>;
    assert.deepEqual(resume.pending_ids, ["m2"]);
    assert.equal(resume.history_complete, true);

    const second = await sync.gmail(a, connectionId, input);
    assert.equal(second.summary.coverage, "complete");
    assert.equal(second.summary.cursor, "201");
    assert.equal(second.summary.counts.gmail_messages, 1);
    assert.equal(second.summary.resume, null);
    // A pagina ja completa nao foi relistada.
    assert.equal(fixture.historyCalls.length, 1);
    // Nenhum item pulado.
    assert.equal(await countEntities(env.db, a.ownerId, "gmail_message"), 2);
  } finally {
    await env.db.end();
  }
});

Deno.test("Gmail: pending_ids da leitura inicial nao relista a pagina apos esvaziar", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [message("m1", "100", "A"), message("m2", "200", "B")];
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);
    const input = { query: "x", message_limit: 1, limits: { maxPages: 5, maxItems: 100 } };

    // A pagina unica e listada por completo; message_limit=1 deixa m2 pendente.
    const first = await sync.gmail(a, connectionId, input);
    assert.equal(first.summary.coverage, "partial");
    assert.equal(first.summary.cursor, null);
    const resume = first.summary.resume as Record<string, unknown>;
    assert.deepEqual(resume.pending_ids, ["m2"]);
    assert.equal(resume.listing_complete, true);
    assert.equal(resume.next_history_id, "100");
    assert.equal(fixture.gmailListCalls, 1);

    const second = await sync.gmail(a, connectionId, input);
    assert.equal(second.summary.coverage, "complete");
    assert.equal(second.summary.cursor, "200");
    assert.equal(second.summary.resume, null);
    // A listagem ja concluida nao e refeita depois de drenar os pendentes.
    assert.equal(fixture.gmailListCalls, 1);
    assert.equal(await countEntities(env.db, a.ownerId, "gmail_message"), 2);
  } finally {
    await env.db.end();
  }
});

Deno.test("Gmail: historyId decimal acima de 2^53 preserva precisao exata no cursor", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [
    message("m1", "9007199254740993", "A"), // 2^53 + 1
    message("m2", "9007199254740995", "B"), // 2^53 + 3
    message("m3", "10000000000000000", "C"), // 17 digitos (maior por comprimento)
  ];
  fixture.gmailListPageSize = 1;
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);
    const limits = { maxPages: 1, maxItems: 100 };

    const first = await sync.gmail(a, connectionId, { query: "x", limits });
    assert.equal(first.summary.coverage, "partial");
    assert.equal(first.summary.cursor, null);
    assert.equal(
      (first.summary.resume as Record<string, unknown>).next_history_id,
      "9007199254740993",
    );

    // Comparacao exata como string: nao arredonda 2^53+3 para 2^53+4.
    const second = await sync.gmail(a, connectionId, { query: "x", limits });
    assert.equal(second.summary.coverage, "partial");
    assert.equal(
      (second.summary.resume as Record<string, unknown>).next_history_id,
      "9007199254740995",
    );

    const third = await sync.gmail(a, connectionId, { query: "x", limits });
    assert.equal(third.summary.coverage, "complete");
    assert.equal(third.summary.cursor, "10000000000000000");
    assert.equal(third.summary.cursor_kind, "history_id");
  } finally {
    await env.db.end();
  }
});

Deno.test("Estado duravel: state() projeta updated_at do jsonb e nao usa coluna inexistente", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [message("m1", "100", "A")];
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);
    const run = await sync.gmail(a, connectionId, {
      query: "x",
      limits: { maxPages: 5, maxItems: 100 },
    });
    const externalId = run.summary.key;

    const all = await sync.state(a, connectionId);
    assert.equal(all.states.length, 1);
    assert.equal(all.states[0].external_id, externalId);
    assert.equal(
      all.states[0].updated_at,
      (all.states[0].state as Record<string, unknown>).updated_at,
    );

    const one = await sync.state(a, connectionId, externalId);
    assert.equal(one.states.length, 1);
    assert.equal(one.states[0].external_id, externalId);
    assert.equal(typeof one.states[0].updated_at, "string");
  } finally {
    await env.db.end();
  }
});

Deno.test("Drive: startPageToken, changes incrementais e reconstrucao por cursor expirado", async () => {
  const fixture = baseFixture();
  fixture.driveFiles = [file("f1", "Notas"), file("f2", "TCC")];
  fixture.driveStart = "sp-1";
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["drive_read"] });
    const sync = new GoogleSync(env.hub, env.service);

    const first = await sync.drive(a, connectionId, { limits: { maxPages: 5, maxItems: 100 } });
    assert.equal(first.summary.coverage, "complete");
    assert.equal(first.summary.mode, "initial");
    assert.equal(first.summary.cursor, "sp-1");
    assert.equal(first.summary.counts.drive_files, 2);
    assert.equal(fixture.driveChangesCalls, 0);

    // Changes incrementais avancam o cursor.
    fixture.driveNewStart = "sp-2";
    fixture.driveChanges = [{
      id: "c1",
      fileId: "f3",
      changeType: "file",
      time: "2026-10-05T12:00:00Z",
      file: { id: "f3", name: "Artigo", mimeType: "application/pdf" },
    }];
    const inc = await sync.drive(a, connectionId, { limits: { maxPages: 5, maxItems: 100 } });
    assert.equal(inc.summary.mode, "incremental");
    assert.equal(inc.summary.coverage, "complete");
    assert.equal(inc.summary.cursor, "sp-2");
    assert.equal(inc.summary.counts.drive_changes, 1);
    assert.equal(fixture.driveChangesCalls, 1);

    // Cursor expirado: reconstrucao limitada por selecao + novo start token.
    fixture.driveExpired = true;
    fixture.driveStart = "sp-3";
    const rebuilt = await sync.drive(a, connectionId, { limits: { maxPages: 5, maxItems: 100 } });
    assert.equal(rebuilt.summary.rebuilt, true);
    assert.equal(rebuilt.summary.coverage, "complete");
    assert.equal(rebuilt.summary.cursor, "sp-3");
    assert.ok(rebuilt.summary.gaps.some((gap) => gap.error_code === "sync_token_expired"));

    // Remocao e observada, nunca apagada.
    fixture.driveExpired = false;
    fixture.driveNewStart = "sp-4";
    fixture.driveChanges = [{
      id: "c2",
      fileId: "f1",
      removed: true,
      time: "2026-10-05T13:00:00Z",
    }];
    const removed = await sync.drive(a, connectionId, { limits: { maxPages: 5, maxItems: 100 } });
    assert.equal(removed.summary.counts.drive_removed, 1);
    assert.equal(await countEntities(env.db, a.ownerId, "drive_file"), 3);
    const kept = (await env
      .db`select state from public.hub_entities where owner_id=${a.ownerId} and kind='drive_change' and external_id='c2'`)[
        0
      ];
    assert.equal(kept.state.removed, true);
  } finally {
    await env.db.end();
  }
});

Deno.test("Drive selecionado (drive.file) usa apenas selecao limitada e nao tenta changes", async () => {
  const fixture = baseFixture();
  fixture.driveFiles = [file("f1", "Doc do app")];
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["selected_files"] });
    const sync = new GoogleSync(env.hub, env.service);
    const run = await sync.drive(a, connectionId, { limits: { maxPages: 5, maxItems: 100 } });
    assert.equal(run.summary.coverage, "complete");
    assert.equal(run.summary.cursor, null);
    assert.equal(run.summary.counts.drive_files, 1);
    assert.equal(run.summary.counts.drive_changes ?? 0, 0);
    assert.equal(fixture.driveChangesCalls, 0);
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Capacidade e isolamento
// ---------------------------------------------------------------------------

Deno.test("Capacidade ausente vira lacuna explicita sem falsa confirmacao", async () => {
  const fixture = baseFixture();
  fixture.calendarEvents = [{ id: "ev-1", summary: "Aula", start: { date: "2026-10-12" } }];
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);
    const run = await sync.calendar(a, connectionId, { calendar_id: "primary" });
    assert.equal(run.summary.coverage, "denied");
    assert.equal(run.summary.cursor, null);
    assert.equal(run.summary.counts.calendar_events ?? 0, 0);
    assert.ok(run.summary.gaps.some((gap) => gap.error_code === "scope_required"));
    assert.equal(await countEntities(env.db, a.ownerId, "calendar_event"), 0);
  } finally {
    await env.db.end();
  }
});

Deno.test("Isolamento: outro dono nao executa nem ve entidades da conexao alheia", async () => {
  const fixture = baseFixture();
  fixture.gmailMessages = [message("m1", "100", "A")];
  const env = await makeEnv(fixture);
  try {
    const a = await newPrincipal(env.db);
    const b = await newPrincipal(env.db);
    const connectionId = await authorize(env, a, { scopes: ["gmail_read"] });
    const sync = new GoogleSync(env.hub, env.service);
    await sync.gmail(a, connectionId, { query: "x" });
    await assert.rejects(
      sync.gmail(b, connectionId, { query: "x" }),
      (error: unknown) => error instanceof HubError && error.code === "not_found",
    );
    assert.equal(await countEntities(env.db, b.ownerId, "gmail_message"), 0);
    assert.equal(
      (await env
        .db`select count(*)::int as n from public.hub_entities where owner_id=${b.ownerId}`)[0]
        .n,
      0,
    );
    await assert.rejects(
      sync.state(b, connectionId),
      (error: unknown) => error instanceof HubError && error.code === "not_found",
    );
  } finally {
    await env.db.end();
  }
});
