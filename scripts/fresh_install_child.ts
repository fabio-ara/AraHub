// Filho do gate A01. Roda sob um DENO_DIR novo e lock congelado, cria um banco
// local exclusivo, aplica a identidade sintética e as migrations atuais e então
// exercita o servidor MCP pelo SDK oficial em transporte HTTP. Não é implantação
// hospedada nem Auth real: identidade, banco e tokens são sintéticos e locais.
//
// Entrada por ambiente: ARAHUB_FRESH_DB_NAME e ARAHUB_FRESH_MCP_PORT.
// Saída: uma única linha no stdout, prefixada por ARAHUB_FRESH_RESULT, com o JSON
// do resultado. Nada de credencial é impresso.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { createHandler } from "../src/http.ts";
import { createVerifier } from "../src/auth.ts";

const ROOT_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const CLIENT_ID = "fresh-install-client";
const MARKER_A = "instalação limpa: preservar a origem";
const MARKER_B = "instalação limpa: conteúdo do segundo dono";

const dbName = Deno.env.get("ARAHUB_FRESH_DB_NAME") ?? "";
const port = Number(Deno.env.get("ARAHUB_FRESH_MCP_PORT") ?? "0");
if (!/^arahub_fresh_[a-z0-9]{6,40}$/.test(dbName)) {
  throw new Error("Nome de banco sintético inválido para o gate de instalação.");
}
if (!Number.isInteger(port) || port < 8800 || port > 8899) {
  throw new Error("Porta sintética fora do intervalo reservado ao gate.");
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

type Json = Record<string, unknown>;

const checks: { name: string; detail?: string }[] = [];
const passed = (name: string, detail?: string) => checks.push({ name, detail });

const root = createDb(ROOT_URL);
const childUrl = ROOT_URL.replace(/\/arahub$/, "/" + dbName);
let db: ReturnType<typeof createDb> | undefined;
let server: Deno.HttpServer | undefined;
const clients: Client[] = [];

try {
  await root.unsafe(`create database ${dbName}`);
  db = createDb(childUrl);
  await db.unsafe(await Deno.readTextFile(new URL("./local_identity.sql", import.meta.url)));

  const migrations: string[] = [];
  for await (const file of Deno.readDir(new URL("../supabase/migrations/", import.meta.url))) {
    if (file.isFile && file.name.endsWith(".sql")) migrations.push(file.name);
  }
  migrations.sort();
  check(migrations.length > 0, "Nenhuma migration encontrada.");
  for (const file of migrations) {
    const sql = await Deno.readTextFile(new URL(`../supabase/migrations/${file}`, import.meta.url));
    await db.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`insert into public.arahub_migrations(name) values(${file})`;
    });
  }
  passed("migrations_applied", `${migrations.length} migrations em banco novo`);

  // Contrato RLS reaproveitado de validate_clean.ts: nenhuma tabela de memória
  // pode existir sem row-level security forçada.
  const protection =
    await db`select count(*)::integer as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and (n.nspname='arahub_private' or (n.nspname='public' and c.relname like 'hub_%')) and (not c.relrowsecurity or not c.relforcerowsecurity)`;
  check(protection[0].count === 0, "Há tabela de memória sem RLS forçada.");
  passed("rls_verified");

  const ownerA = crypto.randomUUID(), ownerB = crypto.randomUUID();
  const sidA = crypto.randomUUID(), sidB = crypto.randomUUID();
  await db`insert into auth.users(id) values(${ownerA}),(${ownerB})`;
  passed("two_owners_created", "duas identidades sintéticas no mesmo banco novo");

  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const auth = {
    issuer: "https://synthetic.arahub.invalid/auth",
    audience: "authenticated",
    resource: `http://127.0.0.1:${port}/mcp`,
    allowedClientIds: [CLIENT_ID],
    key: createLocalJWKSet({
      keys: [{ ...await exportJWK(publicKey), kid: "fresh", alg: "ES256" }],
    }),
    sessionActive: (owner: string, sid: string) =>
      Promise.resolve((owner === ownerA && sid === sidA) || (owner === ownerB && sid === sidB)),
  };
  const sign = (
    owner: string,
    sid: string,
    options: { client?: string; issuer?: string; exp?: string } = {},
  ) =>
    new SignJWT({
      role: "authenticated",
      session_id: sid,
      client_id: options.client ?? CLIENT_ID,
      user_metadata: { owner_id: "attacker" },
    }).setProtectedHeader({ alg: "ES256", kid: "fresh" }).setSubject(owner).setIssuer(
      options.issuer ?? auth.issuer,
    ).setAudience("authenticated").setIssuedAt().setExpirationTime(options.exp ?? "1h").sign(
      privateKey,
    );

  const hub = new Hub(db);
  server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    createHandler(hub, {
      auth,
      verify: createVerifier(auth),
      publicUrl: `http://127.0.0.1:${port}`,
    }),
  );

  // Superfície de autorização reaproveitada dos contratos públicos: sem token,
  // cliente fora da allowlist e emissor errado são recusados.
  const noToken = await fetch(auth.resource, { method: "POST" });
  check(noToken.status === 401, `Sem token esperado 401, recebido ${noToken.status}.`);
  check(
    /resource_metadata/.test(noToken.headers.get("www-authenticate") ?? ""),
    "Desafio WWW-Authenticate sem resource_metadata.",
  );
  await noToken.body?.cancel();
  for (
    const token of [
      await sign(ownerA, sidA, { client: "wrong-client" }),
      await sign(ownerA, sidA, { exp: "-1h" }),
      await sign(ownerA, sidA, { issuer: "https://wrong.invalid" }),
    ]
  ) {
    const rejected = await fetch(auth.resource, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    check(rejected.status === 401, `Token sintético inválido aceito com ${rejected.status}.`);
    check(!(await rejected.text()).includes(token), "Token refletido na resposta.");
  }
  passed("auth_rejections_verified", "sem token, cliente inválido, expirado e emissor errado");

  const connect = async (token: string) => {
    const client = new Client({ name: "fresh-install-fixture", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(auth.resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Json> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    const parsed = JSON.parse(content[0]?.text ?? "null") as Json;
    check(!result.isError, `${name} falhou: ${content[0]?.text}`);
    return parsed;
  };

  const clientA = await connect(await sign(ownerA, sidA));
  const tools = await clientA.listTools() as {
    tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
  };
  check(tools.tools.some((t) => t.name === "hub_context"), "hub_context ausente na lista MCP.");
  const deltaTool = tools.tools.find((t) => t.name === "hub_record_delta");
  check(deltaTool?.annotations?.readOnlyHint === false, "hub_record_delta sem readOnlyHint=false.");
  passed("mcp_sdk_http_verified", "SDK oficial, transporte StreamableHTTP, ferramentas esperadas");

  const contextA = await call(clientA, "hub_create_context", {
    title: "Instalação limpa A",
    scope: { genre: "forum" },
  });
  const deltaA = {
    context_id: contextA.id as string,
    idempotency_key: crypto.randomUUID(),
    kind: "decision",
    content: MARKER_A,
    evidence_kind: "user_report",
    expected_version: 0,
    provenance: [{ system: "synthetic", locator: "fixture:fresh-install" }],
  };
  const receiptA = await call(clientA, "hub_record_delta", deltaA);
  check(receiptA.version === 1, `Versão inicial esperada 1, recebida ${receiptA.version}.`);
  const replayA = await call(clientA, "hub_record_delta", deltaA);
  check(replayA.id === receiptA.id, "Retry com a mesma chave devolveu outro recibo.");
  passed("idempotency_verified", "retry da mesma idempotency_key devolve o mesmo recibo");

  const resumedA = await call(clientA, "hub_context", { context_id: contextA.id });
  const deltasA = resumedA.deltas as { id: string }[];
  check(deltasA[0]?.id === receiptA.id, "Evento gravado não foi recuperado pelo contexto.");
  check(resumedA.content_is_untrusted_data === true, "Conteúdo recuperado não marcado como dado.");
  const searchA = await call(clientA, "hub_search", { query: MARKER_A });
  check(
    (searchA.records as unknown[]).length >= 1,
    "Busca do próprio dono não encontrou o evento.",
  );
  passed("write_retrieve_verified", "grava, recupera por contexto e por busca");

  const clientB = await connect(await sign(ownerB, sidB));
  const listB = await call(clientB, "hub_context", {});
  check((listB.contexts as unknown[]).length === 0, "O segundo dono enxergou contexto alheio.");
  const foreign = await clientB.callTool({
    name: "hub_context",
    arguments: { context_id: contextA.id },
  });
  const foreignBody = JSON.parse(
    (foreign.content as { text?: string }[])[0]?.text ?? "null",
  ) as Json;
  check(foreign.isError === true, "Leitura de contexto alheio não falhou.");
  check(foreignBody.code === "not_found", `Contexto alheio devolveu ${foreignBody.code}.`);
  const searchB = await call(clientB, "hub_search", { query: MARKER_A });
  check((searchB.records as unknown[]).length === 0, "Busca do segundo dono vazou memória alheia.");

  const contextB = await call(clientB, "hub_create_context", { title: "Instalação limpa B" });
  const receiptB = await call(clientB, "hub_record_delta", {
    context_id: contextB.id as string,
    idempotency_key: crypto.randomUUID(),
    kind: "decision",
    content: MARKER_B,
    evidence_kind: "user_report",
    expected_version: 0,
    provenance: [{ system: "synthetic", locator: "fixture:fresh-install" }],
  });
  check(receiptB.version === 1, "Segundo dono não gravou o próprio evento.");
  const listA = await call(clientA, "hub_context", {});
  check((listA.contexts as unknown[]).length === 1, "Primeiro dono enxergou contexto alheio.");
  const searchB2 = await call(clientB, "hub_search", { query: MARKER_B });
  check((searchB2.records as unknown[]).length >= 1, "Segundo dono perdeu o próprio evento.");
  passed("owner_isolation_verified", "dois donos no mesmo banco novo, sem leitura cruzada");

  const result = {
    database: dbName,
    migrations,
    identity: "local_fixture",
    mcp_transport: "http_streamable_sdk",
    mcp_tools: ["hub_context", "hub_search", "hub_create_context", "hub_record_delta"],
    checks,
    migrations_applied: migrations.length,
    rls_verified: true,
    two_owners_verified: true,
    idempotency_verified: true,
    write_retrieve_verified: true,
    owner_isolation_verified: true,
    auth_rejections_verified: true,
    synthetic_only: true,
    hosted: false,
    auth_real: false,
  };
  console.log("ARAHUB_FRESH_RESULT " + JSON.stringify(result));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await server?.shutdown();
  await db?.end();
  await root.end();
}
