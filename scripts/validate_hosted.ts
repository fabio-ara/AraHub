// Validador hospedado real: sessões reais do Supabase Auth e cliente MCP SDK
// sobre HTTPS. Não cria nem apaga usuários, não gera JWT sintético, não executa
// escrita acadêmica e nunca imprime segredos. A configuração (endpoints e
// credenciais temporárias) vem de um JSON protegido; a evidência privada sai
// somente em .private/evidence/.
//
// Uso:
//   deno run --allow-net --allow-read --allow-write=.private/evidence \
//     scripts/validate_hosted.ts .private/hosted-validation.json
//   deno run --allow-read scripts/validate_hosted.ts --check-config <arquivo>
//
// Estrutura do JSON (placeholders; nunca versionar o arquivo real):
// {
//   "api_base": "https://<host-do-projeto>/functions/v1/arahub",
//   "supabase_url": "https://<projeto>.supabase.co",
//   "publishable_key": "<chave-publicavel-do-projeto>",
//   "mcp_client_id": "<client-id-oauth-registrado>",
//   "users": [
//     { "email": "<usuario-temporario-1>", "password": "<senha-1>" },
//     { "email": "<usuario-temporario-2>", "password": "<senha-2>" }
//   ],
//   "mcp_tokens": [
//     { "email": "<usuario-temporario-1>", "access_token": "<token-oauth-1>" },
//     { "email": "<usuario-temporario-2>", "access_token": "<token-oauth-2>" }
//   ],
//   "revoke": true
// }

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";

interface Outcome {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function sanitize(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[token]")
    .slice(0, 300);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface Claims {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  role?: unknown;
  session_id?: unknown;
  client_id?: unknown;
}

// Lê claims apenas para diagnóstico; a assinatura é sempre verificada no servidor.
function jwtClaims(token: string): Claims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token de acesso não é um JWT de três partes.");
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Claims;
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new Error(`Resposta excedeu ${cap} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function findRepoRoot(start: string): Promise<string | null> {
  let dir = start;
  for (let hop = 0; hop < 64; hop++) {
    try {
      await Deno.stat(join(dir, ".git"));
      return dir;
    } catch {
      // Diretório ausente ou sem permissão de leitura: segue subindo.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const userSchema = z.object({ email: z.string().min(3), password: z.string().min(1) }).strict();
const tokenSchema = z.union([
  z.string().min(20),
  z.object({ email: z.string().min(3), access_token: z.string().min(20) }).strict(),
]);
const configSchema = z.object({
  api_base: z.string().url(),
  supabase_url: z.string().url(),
  publishable_key: z.string().min(20),
  mcp_client_id: z.string().min(1).optional(),
  users: z.array(userSchema).length(2),
  mcp_tokens: z.array(tokenSchema).max(2).optional(),
  revoke: z.boolean().optional(),
  timeout_ms: z.number().int().min(1000).max(60000).optional(),
  max_body_bytes: z.number().int().min(1024).max(4_000_000).optional(),
}).strict();

interface Runtime {
  apiBase: string;
  supabaseUrl: string;
  publishableKey: string;
  clientId?: string;
  users: { email: string; password: string }[];
  tokens: { email?: string; accessToken: string }[];
  revoke: boolean;
  timeoutMs: number;
  maxBody: number;
}

function requireHttps(raw: string, label: string, originOnly: boolean): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} exige HTTPS sem credenciais, consulta ou fragmento.`);
  }
  if (originOnly && url.pathname !== "/") {
    throw new Error(`${label} deve ser apenas a origem, sem caminho.`);
  }
  if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error(`${label} deve apontar para o alvo hospedado, não para loopback.`);
  }
  return url;
}

function normalizeConfig(raw: unknown): Runtime {
  const parsed = configSchema.parse(raw);
  const supabase = requireHttps(parsed.supabase_url, "supabase_url", true);
  const api = requireHttps(parsed.api_base, "api_base", false);
  const apiBase = api.origin + api.pathname.replace(/\/+$/, "");
  return {
    apiBase,
    supabaseUrl: supabase.origin,
    publishableKey: parsed.publishable_key,
    clientId: parsed.mcp_client_id,
    users: parsed.users.map((u) => ({ email: u.email, password: u.password })),
    tokens: (parsed.mcp_tokens ?? []).map((t) =>
      typeof t === "string" ? { accessToken: t } : { email: t.email, accessToken: t.access_token }
    ),
    revoke: parsed.revoke ?? true,
    timeoutMs: parsed.timeout_ms ?? 20000,
    maxBody: parsed.max_body_bytes ?? 262144,
  };
}

async function loadConfig(path: string): Promise<Runtime> {
  const resolved = resolve(path);
  const root = await findRepoRoot(Deno.cwd());
  if (root && resolved.toLowerCase().startsWith(root.toLowerCase() + sep)) {
    const relative = resolved.slice(root.length + 1).replace(/\\/g, "/").toLowerCase();
    if (!relative.startsWith(".private/")) {
      throw new Error(
        "Configuração com segredos deve ficar em .private/ dentro do repositório (ver .gitignore).",
      );
    }
  }
  const text = await Deno.readTextFile(resolved);
  return normalizeConfig(parseJson(text));
}

const USAGE = `Validador hospedado do AraHub (HTTPS, sessões reais).

  deno run --allow-net --allow-read --allow-write=.private/evidence \\
    scripts/validate_hosted.ts <config.json>
  deno run --allow-read scripts/validate_hosted.ts --check-config <config.json>

O arquivo JSON traz endpoints, chave publicável, client ID e usuários/tokens
temporários. Nenhum segredo é impresso. Fases executadas, na ordem: disco/health,
duas sessões pessoais, negativas de autenticação, MCP com token OAuth autorizado,
isolamento entre dois donos e revogação de sessão.`;

function rpcInitialize() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arahub-hosted-validation", version: "1.0.0" },
    },
  };
}

const args = Deno.args.filter((a) => a !== "");
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  Deno.exit(0);
}
const checkOnly = args.includes("--check-config");
const positional = args.filter((a) => !a.startsWith("--"));
const configPath = positional[0] ?? Deno.env.get("ARAHUB_HOSTED_CONFIG") ??
  ".private/hosted-validation.json";

if (checkOnly) {
  const config = await loadConfig(configPath);
  console.log(
    `Configuração válida: ${config.users.length} usuários, ${config.tokens.length} token(s) ` +
      `OAuth, revogação ${config.revoke ? "ativa" : "omitida"}.`,
  );
  Deno.exit(0);
}

const runtime = await loadConfig(configPath);
const outcomes: Outcome[] = [];
let failed = false;
const record = (name: string, status: "pass" | "fail" | "skip", detail?: string) => {
  outcomes.push({ name, status, detail: detail ? sanitize(detail) : undefined });
  if (status === "fail") failed = true;
};
const expect = (name: string, condition: boolean, detail: string) =>
  record(name, condition ? "pass" : "fail", condition ? undefined : detail);

interface CallOptions {
  method?: string;
  token?: string;
  json?: unknown;
  headers?: Record<string, string>;
  cap?: number;
}
interface CallResult {
  status: number;
  headers: Headers;
  text: string;
}

async function call(url: string, opts: CallOptions = {}): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readCapped(res, opts.cap ?? runtime.maxBody);
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

interface Session {
  token: string;
  sub: string;
  claims: Claims;
}

async function signIn(user: { email: string; password: string }): Promise<Session> {
  const res = await call(`${runtime.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: runtime.publishableKey },
    json: { email: user.email, password: user.password },
    cap: 65536,
  });
  if (res.status !== 200) {
    const error = parseJson(res.text) as { error?: unknown } | null;
    const code = typeof error?.error === "string" ? `, ${error.error}` : "";
    throw new Error(`Autenticação recusada (HTTP ${res.status}${code}).`);
  }
  const body = parseJson(res.text) as { access_token?: unknown } | null;
  if (!body || typeof body.access_token !== "string") {
    throw new Error("Resposta de autenticação sem token de acesso.");
  }
  const claims = jwtClaims(body.access_token);
  if (
    claims.role !== "authenticated" || typeof claims.sub !== "string" || !uuid(claims.sub) ||
    typeof claims.session_id !== "string"
  ) {
    throw new Error("Sessão sem claims esperados (role/sub/session_id).");
  }
  return { token: body.access_token, sub: claims.sub, claims };
}

async function connectMcp(token: string): Promise<Client> {
  const client = new Client({ name: "arahub-hosted-validation", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${runtime.apiBase}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function mcpCall(client: Client, name: string, toolArgs: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: toolArgs });
  const content = res.content as Array<{ text?: string }> | undefined;
  const text = content?.find((c) => typeof c.text === "string")?.text ?? "{}";
  const value = (parseJson(text) ?? {}) as Record<string, unknown>;
  return { isError: res.isError === true, value };
}

interface OwnerState {
  index: number;
  sub: string;
  token: string;
  client: Client;
  contextId: string;
  receiptId: string;
}

const clients: Client[] = [];
const markers = [0, 1].map(() => `arahub-validacao-${crypto.randomUUID()}`);
const evidenceDir = ".private/evidence";

try {
  const personal = [await signIn(runtime.users[0]), await signIn(runtime.users[1])];
  expect(
    "duas sessões pessoais distintas",
    personal[0].sub !== personal[1].sub,
    "mesmo sub nos dois usuários",
  );
  const audience = personal[0].claims.aud;
  expect(
    "sessão pessoal com audience authenticated",
    audience === "authenticated" || (Array.isArray(audience) && audience.includes("authenticated")),
    "claim aud inesperada",
  );

  const health = await call(`${runtime.apiBase}/health`);
  expect("health responde 200", health.status === 200, `HTTP ${health.status}`);

  const discoveryRes = await call(`${runtime.apiBase}/.well-known/oauth-protected-resource`);
  const discovery = parseJson(discoveryRes.text) as {
    resource?: unknown;
    authorization_servers?: unknown;
  } | null;
  expect("discovery responde 200", discoveryRes.status === 200, `HTTP ${discoveryRes.status}`);
  expect(
    "discovery aponta para o recurso MCP",
    discovery?.resource === `${runtime.apiBase}/mcp`,
    "resource divergente do endpoint configurado",
  );
  const servers = Array.isArray(discovery?.authorization_servers)
    ? (discovery!.authorization_servers as unknown[]).map(String)
    : [];
  expect(
    "discovery anuncia o issuer da sessão",
    servers.includes(String(personal[0].claims.iss)),
    "issuer do token ausente no discovery",
  );

  const noToken = await call(`${runtime.apiBase}/mcp`, {
    method: "POST",
    json: rpcInitialize(),
    headers: { Accept: "application/json, text/event-stream" },
  });
  expect("MCP sem token responde 401", noToken.status === 401, `HTTP ${noToken.status}`);
  expect(
    "401 anuncia resource_metadata",
    (noToken.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
    "cabeçalho WWW-Authenticate ausente",
  );
  const personalAtMcp = await call(`${runtime.apiBase}/mcp`, {
    method: "POST",
    token: personal[0].token,
    json: rpcInitialize(),
    headers: { Accept: "application/json, text/event-stream" },
  });
  expect(
    "MCP recusa sessão pessoal sem client_id",
    personalAtMcp.status === 401,
    `HTTP ${personalAtMcp.status} (esperado 401)`,
  );
  const invalidToken = await call(`${runtime.apiBase}/api/context`, { token: "nao-e-um-token" });
  expect(
    "API pessoal recusa token inválido",
    invalidToken.status === 401,
    `HTTP ${invalidToken.status}`,
  );
  const personalOk = await call(`${runtime.apiBase}/api/context`, { token: personal[0].token });
  expect(
    "API pessoal aceita a sessão real",
    personalOk.status === 200,
    `HTTP ${personalOk.status}`,
  );
  const personalBody = parseJson(personalOk.text) as { content_is_untrusted_data?: unknown } | null;
  expect(
    "contexto marca conteúdo como dado não confiável",
    personalBody?.content_is_untrusted_data === true,
    "sinal content_is_untrusted_data ausente",
  );

  const ownerTokens: (string | null)[] = [null, null];
  for (const token of runtime.tokens) {
    let sub: string | null = null;
    try {
      const claims = jwtClaims(token.accessToken);
      if (typeof claims.sub === "string") sub = claims.sub;
    } catch {
      sub = null;
    }
    const index = sub ? personal.findIndex((session) => session.sub === sub) : -1;
    if (index >= 0) {
      ownerTokens[index] = token.accessToken;
      const claims = jwtClaims(token.accessToken);
      expect(
        `token OAuth do dono ${index + 1} traz client_id`,
        typeof claims.client_id === "string" && claims.client_id.length > 0,
        "claim client_id ausente",
      );
      if (runtime.clientId) {
        expect(
          `client_id do token do dono ${index + 1} corresponde ao configurado`,
          claims.client_id === runtime.clientId,
          "client_id divergente do registrado",
        );
      }
    } else {
      record(
        "token OAuth corresponde a um usuário temporário",
        "fail",
        "sub do token não casa com nenhuma sessão pessoal",
      );
    }
  }

  if (ownerTokens.every((token) => token === null)) {
    record(
      "MCP autorizado com OAuth real",
      "skip",
      "sem mcp_tokens no arquivo; gerar consentimento OAuth dos dois usuários e reexecutar a fase MCP",
    );
    record("isolamento de memória entre dois donos", "skip", "depende da fase MCP");
  } else {
    const owners: OwnerState[] = [];
    for (let index = 0; index < ownerTokens.length; index++) {
      const token = ownerTokens[index];
      if (!token) continue;
      const client = await connectMcp(token);
      clients.push(client);
      const listed = await client.listTools();
      expect(
        `MCP lista ferramentas (dono ${index + 1})`,
        listed.tools.some((tool: { name: string }) => tool.name === "hub_context"),
        "hub_context ausente na listagem",
      );
      const created = await mcpCall(client, "hub_create_context", {
        title: `Validação hospedada ${markers[index]}`,
        scope: { validation: markers[index] },
      });
      const contextId = typeof created.value.id === "string" ? created.value.id : "";
      expect(
        `MCP cria contexto (dono ${index + 1})`,
        !created.isError && uuid(contextId),
        "hub_create_context falhou",
      );
      const receipt = await mcpCall(client, "hub_record_delta", {
        idempotency_key: crypto.randomUUID(),
        context_id: contextId,
        kind: "decision",
        content: `Marcador de validação hospedada ${markers[index]}`,
        evidence_kind: "user_report",
        expected_version: 0,
        provenance: [{ system: "validation", locator: markers[index] }],
      });
      const receiptId = typeof receipt.value.id === "string" ? receipt.value.id : "";
      expect(
        `MCP grava delta idempotente (dono ${index + 1})`,
        !receipt.isError && uuid(receiptId),
        "hub_record_delta falhou",
      );
      const searched = await mcpCall(client, "hub_search", { query: markers[index] });
      const records = Array.isArray(searched.value.records) ? searched.value.records : [];
      expect(
        `MCP recupera o próprio marcador (dono ${index + 1})`,
        records.some((row) => (row as { id?: unknown }).id === receiptId),
        "marcador próprio não recuperado",
      );
      const viaPersonal = await call(`${runtime.apiBase}/api/context`, { token });
      expect(
        `token OAuth aceito na API pessoal (dono ${index + 1})`,
        viaPersonal.status === 200,
        `HTTP ${viaPersonal.status}`,
      );
      owners.push({ index, sub: personal[index].sub, token, client, contextId, receiptId });
    }

    if (owners.length === 2) {
      const [first, second] = owners;
      const foreignRead = await mcpCall(second.client, "hub_context", {
        context_id: first.contextId,
      });
      const foreignCode = (foreignRead.value as { code?: unknown }).code;
      expect(
        "segundo dono não lê contexto do primeiro",
        foreignRead.isError && foreignCode === "not_found",
        `resposta inesperada: ${foreignCode ?? "sem código"}`,
      );
      const foreignSearch = await mcpCall(second.client, "hub_search", {
        query: markers[first.index],
      });
      const foreignRecords = Array.isArray(foreignSearch.value.records)
        ? foreignSearch.value.records
        : [];
      expect(
        "busca do segundo dono ignora marcador do primeiro",
        foreignRecords.length === 0,
        "marcador estrangeiro retornado",
      );

      const personalContext = await call(`${runtime.apiBase}/api/context`, {
        token: personal[first.index].token,
      });
      const personalContextBody = parseJson(personalContext.text) as {
        contexts?: Array<{ id?: unknown }>;
      } | null;
      const contextIds = (personalContextBody?.contexts ?? []).map((c) => c.id);
      expect(
        "API pessoal do dono 1 lista apenas o próprio contexto",
        contextIds.includes(first.contextId) && !contextIds.includes(second.contextId),
        "contextos cruzados na API pessoal",
      );
      const exportFirst = await call(`${runtime.apiBase}/api/export`, {
        token: personal[first.index].token,
        cap: Math.max(runtime.maxBody, 1_048_576),
      });
      const exportSecond = await call(`${runtime.apiBase}/api/export`, {
        token: personal[second.index].token,
        cap: Math.max(runtime.maxBody, 1_048_576),
      });
      expect(
        "exportação do dono 1 contém só o próprio marcador",
        exportFirst.status === 200 && exportFirst.text.includes(markers[first.index]) &&
          !exportFirst.text.includes(markers[second.index]) &&
          !exportFirst.text.includes(second.contextId),
        "marcador cruzado na exportação do dono 1",
      );
      expect(
        "exportação do dono 2 contém só o próprio marcador",
        exportSecond.status === 200 && exportSecond.text.includes(markers[second.index]) &&
          !exportSecond.text.includes(markers[first.index]) &&
          !exportSecond.text.includes(first.contextId),
        "marcador cruzado na exportação do dono 2",
      );
    } else {
      record(
        "isolamento de memória entre dois donos",
        "skip",
        "apenas um token OAuth válido presente",
      );
    }
  }

  let revocation: Record<string, unknown> = { performed: false };
  if (!runtime.revoke) {
    record(
      "sessão revogada é recusada",
      "skip",
      "revoke desativado; passos manuais em docs/VALIDACAO-HOSPEDADA.md",
    );
  } else {
    try {
      const fresh = await signIn(runtime.users[0]);
      const before = await call(`${runtime.apiBase}/api/context`, { token: fresh.token });
      const logout = await call(`${runtime.supabaseUrl}/auth/v1/logout`, {
        method: "POST",
        token: fresh.token,
        headers: { apikey: runtime.publishableKey },
      });
      if (before.status !== 200 || ![200, 204].includes(logout.status)) {
        record(
          "sessão revogada é recusada",
          "skip",
          `encerramento indisponível (pré ${before.status}, logout ${logout.status}); executar a sequência manual`,
        );
        revocation = { performed: false, pre_status: before.status, logout_status: logout.status };
      } else {
        const after = await call(`${runtime.apiBase}/api/context`, { token: fresh.token });
        expect(
          "sessão revogada é recusada",
          after.status === 401,
          `HTTP ${after.status} após logout (esperado 401)`,
        );
        revocation = {
          performed: true,
          pre_status: before.status,
          logout_status: logout.status,
          post_status: after.status,
        };
      }
    } catch (error) {
      record(
        "sessão revogada é recusada",
        "skip",
        `encerramento falhou: ${error instanceof Error ? error.message : "erro desconhecido"}`,
      );
    }
  }

  const passed = outcomes.filter((o) => o.status === "pass").length;
  const skipped = outcomes.filter((o) => o.status === "skip").length;
  const failedCount = outcomes.filter((o) => o.status === "fail").length;

  await Deno.mkdir(evidenceDir, { recursive: true });
  const evidencePath = `${evidenceDir}/hosted-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(
    evidencePath,
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        api_base: runtime.apiBase,
        supabase_url: runtime.supabaseUrl,
        hosted: true,
        synthetic_jwt: false,
        created_or_deleted_users: false,
        secrets_written: false,
        counts: { pass: passed, fail: failedCount, skip: skipped },
        owners: personal.map((session, index) => ({
          index: index + 1,
          sub: session.sub,
          has_oauth_token: ownerTokens[index] !== null,
        })),
        contexts: markers.map((marker, index) => ({ marker, index: index + 1 })),
        revocation,
        checks: outcomes,
      },
      null,
      2,
    ) + "\n",
    { createNew: true },
  );

  console.log(`Validação hospedada: ${passed} pass, ${failedCount} fail, ${skipped} skip`);
  for (const outcome of outcomes.filter((o) => o.status !== "pass")) {
    console.log(
      `- ${outcome.status.toUpperCase()}: ${outcome.name}${
        outcome.detail ? ` — ${outcome.detail}` : ""
      }`,
    );
  }
  console.log(`Evidência privada: ${evidencePath}`);
  Deno.exitCode = failed ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : "erro desconhecido";
  record("execução", "fail", message);
  await Deno.mkdir(evidenceDir, { recursive: true }).catch(() => {});
  const evidencePath = `${evidenceDir}/hosted-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(
    evidencePath,
    JSON.stringify(
      { recorded_at: new Date().toISOString(), hosted: true, checks: outcomes },
      null,
      2,
    ) + "\n",
    { createNew: true },
  ).catch(() => {});
  console.error(`Falha na validação: ${sanitize(message)}`);
  Deno.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => {});
}
