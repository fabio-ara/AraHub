/**
 * Testes da fronteira durável de aprovação contra o Postgres local (dados sintéticos).
 * Cobrem concorrência real, sessão expirada/revogada, isolamento por dono, recusa de
 * client_id MCP pela Data API, integridade criptográfica do snapshot e preservação de
 * resultado incerto. Sem efeito externo: o envio é injetável.
 * Executar: deno test --allow-net=127.0.0.1:55432 --allow-env tests/approval_store_test.ts
 */

import assert from "node:assert/strict";
import postgres from "postgres";
import { createDb, type Db } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { HubError, type Principal } from "../src/contracts.ts";
import { executeAction, prepareAction, type PreparedAction } from "../src/production.ts";
import { type ActionState, PersistentActionStore } from "../src/approval_store.ts";

const DB_URL = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Env {
  readonly db: Db;
  readonly hub: Hub;
  readonly store: PersistentActionStore;
  readonly nowMs: { value: number };
  readonly sessions: Map<string, boolean>;
  setSession(sessionId: string, active: boolean): void;
}

async function makeEnv(opts: { ttlMs?: number } = {}): Promise<Env> {
  const db = createDb(DB_URL);
  const hub = new Hub(db);
  const sessions = new Map<string, boolean>();
  // O relógio real evita conflito com executeAction (production.ts), que compara a
  // expiração com Date.now(); os testes de validade deslocam este valor explicitamente.
  const nowMs = { value: Date.now() };
  const store = new PersistentActionStore(db, {
    sessionActive: (ownerId, sessionId) =>
      Promise.resolve(UUID_RE.test(ownerId) && (sessions.get(sessionId) ?? true)),
    now: () => nowMs.value,
    approvalTtlMs: opts.ttlMs,
  });
  return {
    db,
    hub,
    store,
    nowMs,
    sessions,
    setSession: (sessionId, active) => {
      sessions.set(sessionId, active);
    },
  };
}

async function newOwner(db: Db): Promise<Principal> {
  const ownerId = crypto.randomUUID();
  await db.unsafe("insert into auth.users(id) values($1)", [ownerId]);
  return { ownerId, sessionId: crypto.randomUUID() };
}

async function newConnection(env: Env, ownerId: string): Promise<string> {
  const row = await env.hub.connect({ ownerId }, "google", "Fixture", null, null, {});
  return row.id as string;
}

async function makeAction(
  env: Env,
  owner: Principal,
  connectionId: string,
  content: unknown = { text: "Conteúdo da ação" },
): Promise<PreparedAction> {
  return await env.store.prepare(owner, {
    connectionId,
    operation: "moodle.submit",
    target: "assignment-fixture",
    revision: "v3",
    content,
  });
}

function isHub(code: string) {
  return (error: unknown) => error instanceof HubError && error.code === code;
}

/** Executa um bloco como role authenticated com claims sintéticos, como o PostgREST faria. */
async function asJwt(
  db: Db,
  sub: string,
  clientId: string | null,
  fn: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  await db.begin(async (tx) => {
    await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
    await tx.unsafe("select set_config('request.jwt.claims',$1,true)", [
      clientId === null ? "{}" : JSON.stringify({ client_id: clientId }),
    ]);
    await tx.unsafe("set local role authenticated");
    await fn(tx);
  });
}

// ---------------------------------------------------------------------------
// Preparação, hash canônico e isolamento por dono
// ---------------------------------------------------------------------------

Deno.test("prepare fixa o snapshot canônico, confere o hash e isola por dono", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db), b = await newOwner(env.db);
    const connA = await newConnection(env, a.ownerId), connB = await newConnection(env, b.ownerId);
    const action = await makeAction(env, a, connA, { subject: "Oi", nested: { z: 1, a: 2 } });
    assert.equal(action.ownerId, a.ownerId);
    assert.equal(action.hash.length, 64);
    // A ordem de chaves importa: o hash tem que bater com a serialização de prepareAction.
    assert.equal(
      prepareAction(a, connA, "moodle.submit", "assignment-fixture", "v3", action.content).hash,
      action.hash,
    );
    const view = await env.store.load(a, action.id);
    assert.ok(view);
    assert.equal(view.state, "prepared");
    assert.equal(view.approval, null);
    assert.equal(view.action.hash, action.hash);
    assert.deepEqual(view.action.content, { subject: "Oi", nested: { z: 1, a: 2 } });
    // RLS + filtro por dono: B não enxerga nem lista a ação de A.
    assert.equal(await env.store.load(b, action.id), null);
    assert.deepEqual(await env.store.list(b), []);
    // Dono da ação não pode apontar para conexão de terceiro.
    await assert.rejects(
      env.store.prepare(a, {
        connectionId: connB,
        operation: "moodle.submit",
        target: "x",
        content: {},
      }),
      isHub("not_found"),
    );
    // Credenciais nunca entram na ação.
    await assert.rejects(
      env.store.prepare(a, {
        connectionId: connA,
        operation: "gmail.send",
        target: "x",
        content: { to: "x", access_token: "segredo" },
      }),
      isHub("credentials_in_action"),
    );
    await assert.rejects(
      env.store.prepare(a, {
        connectionId: connA,
        operation: "gmail.send",
        target: "x",
        content: { headers: { Authorization: "Bearer abc" } },
      }),
      isHub("credentials_in_action"),
    );
    // Ação inexistente não vira erro nem vaza existência.
    assert.equal(await env.store.load(a, crypto.randomUUID()), null);
    await assert.rejects(env.store.approve(a, crypto.randomUUID()), isHub("not_found"));
  } finally {
    await env.db.end();
  }
});

Deno.test("list filtra por estado e limita o resultado", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const first = await makeAction(env, a, conn);
    const second = await makeAction(env, a, conn, { text: "Outra" });
    await env.store.approve(a, first.id);
    const approved = await env.store.list(a, { states: ["approved"] });
    assert.equal(approved.length, 1);
    assert.equal(approved[0].action.id, first.id);
    const prepared = await env.store.list(a, { states: ["prepared"] });
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].action.id, second.id);
    assert.equal((await env.store.list(a, { limit: 1 })).length, 1);
    const all = await env.store.list(a);
    assert.equal(all.length, 2);
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Aprovação: navegador, sessão e validade fixa
// ---------------------------------------------------------------------------

Deno.test("aprovar exige navegador com sessão ativa e não estende a validade", async () => {
  const env = await makeEnv({ ttlMs: 60000 });
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    // Cliente MCP (client_id) não aprova, mesmo sendo o dono.
    await assert.rejects(
      env.store.approve({ ...a, clientId: "mcp-client" }, action.id),
      isHub("browser_required"),
    );
    await assert.rejects(
      env.store.deny({ ...a, clientId: "mcp-client" }, action.id),
      isHub("browser_required"),
    );
    // Sem sessão ou com sessão inativa não aprova.
    await assert.rejects(
      env.store.approve({ ownerId: a.ownerId }, action.id),
      isHub("session_required"),
    );
    const dead = { ownerId: a.ownerId, sessionId: crypto.randomUUID() };
    env.setSession(dead.sessionId as string, false);
    await assert.rejects(env.store.approve(dead, action.id), isHub("session_required"));
    const receipt = await env.store.approve(a, action.id);
    assert.equal(receipt.source, "trusted_ui");
    assert.equal(receipt.actionId, action.id);
    assert.equal(receipt.ownerId, a.ownerId);
    assert.equal(receipt.hash, action.hash);
    assert.ok(Date.parse(receipt.expiresAt) > env.nowMs.value);
    // Reaprovação dentro da validade devolve a MESMA data fixada.
    const again = await env.store.approve(a, action.id);
    assert.equal(again.expiresAt, receipt.expiresAt);
    const view = await env.store.load(a, action.id);
    assert.ok(view);
    assert.equal(view.state, "approved");
    assert.ok(view.approval);
    assert.equal(view.approval.decision, "approved");
    assert.equal(view.approval.decidedHash, action.hash);
    assert.equal(view.approval.decidedRevision, "v3");
    assert.equal(view.approval.expiresAt, receipt.expiresAt);
    assert.equal(view.approval.consumedAt, null);
  } finally {
    await env.db.end();
  }
});

Deno.test("negar remove a possibilidade de execução e a nova decisão substitui", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    await env.store.deny(a, action.id);
    const denied = await env.store.load(a, action.id);
    assert.ok(denied);
    assert.equal(denied.state, "denied");
    assert.equal(denied.approval?.decision, "denied");
    assert.equal(denied.approval?.expiresAt, null);
    assert.equal(await env.store.consume(action, a), null);
    await assert.rejects(
      executeAction(a, action, env.store, () => Promise.resolve({ externalId: "x" })),
      /Autorize/,
    );
    // Reaprovar depois de negar é uma decisão humana nova e válida.
    const receipt = await env.store.approve(a, action.id);
    assert.equal(receipt.hash, action.hash);
    assert.equal((await env.store.load(a, action.id))?.state, "approved");
  } finally {
    await env.db.end();
  }
});

Deno.test("aprovação vencida não consome e uma nova decisão fixa outra validade", async () => {
  const env = await makeEnv({ ttlMs: 2000 });
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    const first = await env.store.approve(a, action.id);
    assert.equal(Date.parse(first.expiresAt), env.nowMs.value + 2000);
    env.nowMs.value += 3000;
    // Vencida: não consome nem permite envio.
    assert.equal(await env.store.consume(action, a), null);
    await assert.rejects(
      executeAction(a, action, env.store, () => Promise.resolve({ externalId: "x" })),
      /Autorize/,
    );
    const renewed = await env.store.approve(a, action.id);
    assert.notEqual(renewed.expiresAt, first.expiresAt);
    assert.ok(Date.parse(renewed.expiresAt) > env.nowMs.value);
    const receipt = await env.store.consume(action, a);
    assert.ok(receipt);
    assert.equal(receipt.expiresAt, renewed.expiresAt);
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Consumo: uso único, atômico e sem duplo envio
// ---------------------------------------------------------------------------

Deno.test("consume concorrente entrega um único recibo e marca incerto", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    await env.store.approve(a, action.id);
    const results = await Promise.all([
      env.store.consume(action, a),
      env.store.consume(action, a),
      env.store.consume(action, a),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await env.store.result(action.id, a.ownerId))?.state, "uncertain");
    const view = await env.store.load(a, action.id);
    assert.ok(view);
    assert.equal(view.state, "uncertain");
    assert.ok(view.approval?.consumedAt);
    // O recibo vencedor pertence ao dono e ao conteúdo aprovado.
    const won = results.find(Boolean);
    assert.ok(won);
    assert.equal(won.ownerId, a.ownerId);
    assert.equal(won.hash, action.hash);
    assert.equal(won.source, "trusted_ui");
    // Um consumo posterior nunca obtém novo recibo.
    assert.equal(await env.store.consume(action, a), null);
  } finally {
    await env.db.end();
  }
});

Deno.test("executeAction envia uma vez e preserva o estado incerto sem reenviar", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn, { text: "Entrega única" });
    await env.store.approve(a, action.id);
    const loaded = (await env.store.load(a, action.id))?.action;
    assert.ok(loaded);
    let calls = 0;
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    const started = new Promise<void>((resolve) => entered = resolve);
    const send = () => {
      calls++;
      entered();
      return gate.then(() => ({ externalId: "ext-1" }));
    };
    const pending = executeAction(a, loaded, env.store, send);
    pending.catch(() => {}); // evita rejeição não tratada se uma asserção anterior falhar
    await started;
    assert.equal(calls, 1);
    // Enquanto o envio está em voo, a ação já está incerta: uma segunda execução não reenvia.
    const detour = await executeAction(a, loaded, env.store, () => {
      calls++;
      return Promise.resolve({ externalId: "ext-nunca" });
    });
    assert.equal(detour.state, "uncertain");
    assert.equal(calls, 1);
    release();
    const terminal = await pending;
    assert.equal(terminal.state, "succeeded");
    assert.equal(terminal.externalId, "ext-1");
    assert.equal(calls, 1);
    // Desfecho durável: terceira chamada devolve o resultado, sem novo envio.
    const replay = await executeAction(a, loaded, env.store, () => {
      calls++;
      return Promise.resolve({ externalId: "ext-2" });
    });
    assert.equal(replay.state, "succeeded");
    assert.equal(replay.externalId, "ext-1");
    assert.equal(calls, 1);
    assert.equal((await env.store.result(action.id, a.ownerId))?.externalId, "ext-1");
  } finally {
    await env.db.end();
  }
});

Deno.test("conteúdo trocado após a aprovação não é executado", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn, { text: "Aprovado" });
    await env.store.approve(a, action.id);
    // Reescrita privilegiada coerente (snapshot + hash) mudaria o conteúdo executável.
    const tampered = JSON.stringify({
      connectionId: conn,
      operation: "moodle.submit",
      target: "assignment-fixture",
      revision: "v3",
      content: { text: "ALTERADO" },
    });
    await env.db.unsafe(
      "update public.hub_actions set snapshot=$1, content_hash=encode(extensions.digest($1,'sha256'),'hex') where id=$2",
      [tampered, action.id],
    );
    // O hash aprovado não corresponde mais ao conteúdo: sem consumo, sem envio.
    assert.equal(await env.store.consume(action, a), null);
    let calls = 0;
    await assert.rejects(
      executeAction(a, action, env.store, () => {
        calls++;
        return Promise.resolve({ externalId: "x" });
      }),
      /Autorize/,
    );
    assert.equal(calls, 0);
  } finally {
    await env.db.end();
  }
});

// ---------------------------------------------------------------------------
// Fronteira SQL: RLS, client_id MCP e CHECK criptográfico
// ---------------------------------------------------------------------------

Deno.test("sessão expirada ou revogada invalida a aprovação já concedida", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    await env.store.approve(a, action.id);
    env.setSession(a.sessionId as string, false);
    assert.equal(await env.store.consume(action, a), null);
    assert.equal(await env.store.result(action.id, a.ownerId), null);
    const view = await env.store.load(a, action.id);
    assert.ok(view);
    assert.equal(view.state, "approved");
    assert.equal(view.approval?.consumedAt, null);
    await assert.rejects(
      executeAction(a, action, env.store, () => Promise.resolve({ externalId: "x" })),
      /Autorize/,
    );
  } finally {
    await env.db.end();
  }
});

Deno.test("cliente MCP com client_id não lê nem muta a fronteira pela Data API", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    // O próprio dono vê a ação como navegador (sem client_id).
    await asJwt(env.db, a.ownerId, null, async (tx) => {
      const rows = await tx.unsafe("select id from public.hub_actions where owner_id=$1", [
        a.ownerId,
      ]);
      assert.equal(rows.length, 1);
    });
    // MCP não enxerga.
    await asJwt(env.db, a.ownerId, "mcp-client", async (tx) => {
      const rows = await tx.unsafe("select id from public.hub_actions where owner_id=$1", [
        a.ownerId,
      ]);
      assert.equal(rows.length, 0);
    });
    // MCP não insere ação.
    await assert.rejects(
      asJwt(env.db, a.ownerId, "mcp-client", async (tx) => {
        await tx.unsafe(
          "insert into public.hub_actions(owner_id,connection_id,operation,target,snapshot,content_hash) values($1,$2,$3,$4,$5,encode(extensions.digest($5,'sha256'),'hex'))",
          [a.ownerId, conn, "op", "t", "{}"],
        );
      }),
    );
    // MCP não aprova.
    await assert.rejects(
      asJwt(env.db, a.ownerId, "mcp-client", async (tx) => {
        await tx.unsafe(
          "insert into public.hub_action_approvals(action_id,owner_id,approver_session_id,decided_hash,decided_revision,decision,expires_at) values($1,$2,$3,$4,'v3','approved',now()+interval '1 hour')",
          [action.id, a.ownerId, crypto.randomUUID(), action.hash],
        );
      }),
    );
    // MCP não muda estado: sem grant de escrita, é negação de privilégio.
    await assert.rejects(
      asJwt(env.db, a.ownerId, "mcp-client", async (tx) => {
        await tx.unsafe("update public.hub_actions set state='approved' where id=$1", [action.id]);
      }),
    );
    // Navegador (sem client_id) também não escreve pela Data API: só o caminho privilegiado muta.
    await assert.rejects(
      asJwt(env.db, a.ownerId, null, async (tx) => {
        await tx.unsafe(
          "insert into public.hub_action_approvals(action_id,owner_id,approver_session_id,decided_hash,decided_revision,decision,expires_at) values($1,$2,$3,$4,'v3','approved',now()+interval '1 hour')",
          [action.id, a.ownerId, crypto.randomUUID(), action.hash],
        );
      }),
    );
    await assert.rejects(
      asJwt(env.db, a.ownerId, null, async (tx) => {
        await tx.unsafe(
          "update public.hub_actions set state='succeeded',external_id='forjado' where id=$1",
          [action.id],
        );
      }),
    );
    await assert.rejects(
      asJwt(env.db, a.ownerId, null, async (tx) => {
        await tx.unsafe(
          "insert into public.hub_actions(id,owner_id,connection_id,operation,target,snapshot,content_hash) values($1,$2,$3,$4,$5,$6,$7)",
          [crypto.randomUUID(), a.ownerId, conn, "op", "t", "{}", "0".repeat(64)],
        );
      }),
    );
    // B (sem client_id) também não vê a ação de A.
    const b = await newOwner(env.db);
    await asJwt(env.db, b.ownerId, null, async (tx) => {
      const rows = await tx.unsafe("select id from public.hub_actions where owner_id=$1", [
        a.ownerId,
      ]);
      assert.equal(rows.length, 0);
    });
    assert.equal((await env.store.load(a, action.id))?.state, "prepared");
  } finally {
    await env.db.end();
  }
});

Deno.test("CHECK criptográfico recusa hash incoerente com o snapshot", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    await assert.rejects(
      env.db.unsafe(
        "insert into public.hub_actions(owner_id,connection_id,operation,target,snapshot,content_hash) values($1,$2,$3,$4,$5,$6)",
        [a.ownerId, conn, "op", "t", "{}", "0".repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    const action = await makeAction(env, a, conn);
    await assert.rejects(
      env.db.unsafe("update public.hub_actions set snapshot=$1 where id=$2", ["{}", action.id]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
  } finally {
    await env.db.end();
  }
});

Deno.test("approve com expectedHash divergente recusa sem mutar (TOCTOU)", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    await assert.rejects(
      env.store.approve(a, action.id, { expectedHash: "f".repeat(64) }),
      isHub("content_changed"),
    );
    await assert.rejects(
      env.store.approve(a, action.id, { expectedRevision: "outra" }),
      isHub("content_changed"),
    );
    assert.equal((await env.store.load(a, action.id))?.state, "prepared");
    const receipt = await env.store.approve(a, action.id, {
      expectedHash: action.hash,
      expectedRevision: "v3",
    });
    assert.equal(receipt.hash, action.hash);
    assert.equal((await env.store.load(a, action.id))?.state, "approved");
  } finally {
    await env.db.end();
  }
});

Deno.test("expõe os campos públicos esperados para integração HTTP/MCP", async () => {
  const env = await makeEnv();
  try {
    const a = await newOwner(env.db);
    const conn = await newConnection(env, a.ownerId);
    const action = await makeAction(env, a, conn);
    const view = await env.store.load(a, action.id);
    assert.ok(view);
    const state: ActionState = view.state;
    assert.deepEqual(Object.keys(view).sort(), [
      "action",
      "approval",
      "createdAt",
      "externalId",
      "state",
      "updatedAt",
    ]);
    assert.equal(state, "prepared");
    assert.equal(typeof env.store.prepare, "function");
    assert.equal(typeof env.store.approve, "function");
    assert.equal(typeof env.store.deny, "function");
    assert.equal(typeof env.store.consume, "function");
    assert.equal(typeof env.store.result, "function");
    assert.equal(typeof env.store.persistResult, "function");
  } finally {
    await env.db.end();
  }
});
