/**
 * Adaptador Moodle generalizado e independente (Deno/TypeScript).
 *
 * Regras do adaptador:
 * - A origem (esquema + host + subdiretorio) e validada na construcao e fica
 *   vinculada a instancia. Nenhuma URL arbitraria e aceita depois.
 * - Somente funcoes da allowlist auditada e efetivamente implementadas sao
 *   chamadas. Funcoes desconhecidas, de escrita, de recalculo de notas e
 *   qualquer nome com view sao recusadas.
 * - Redirecionamentos desativados, DNS publico verificado, limites de bytes e
 *   tempo aplicados, nenhum segredo devolvido e nenhuma mensagem bruta do
 *   Moodle repassada em erro.
 * - O download so aceita IDs internos registrados pelo proprio adaptador em
 *   leituras anteriores; nao existe proxy de URL arbitraria.
 *
 * A implementacao e nova: baseia-se apenas nas APIs HTTP do Moodle e na
 * auditoria registrada em ../ulisboa-moodle-mcp/security.py e
 * ../ulisboa-moodle-mcp/docs/capabilities.md. Nenhum codigo do projeto irmao
 * foi copiado (nao ha licenca auditada para reutilizacao).
 */

import { HubError } from "../contracts.ts";
import type { Coverage, Provenance } from "../contracts.ts";
import { request as httpsRequest } from "node:https";

// --- Tipos fundamentais ----------------------------------------------------

export type MoodleRecord = Record<string, unknown>;

export type MoodleErrorCode =
  | "moodle_error"
  | "invalid_token"
  | "permission_denied"
  | "function_unavailable"
  | "not_found"
  | "invalid_id"
  | "unsupported_function"
  | "security_error"
  | "http_error"
  | "timeout"
  | "parsing_error"
  | "limit_exceeded"
  | "download_error";

export class MoodleError extends HubError {
  declare readonly code: MoodleErrorCode;
  readonly moodleCode?: string;
  readonly functionName?: string;

  constructor(
    code: MoodleErrorCode,
    message: string,
    options: { status?: number; moodleCode?: string; functionName?: string } = {},
  ) {
    super(code, message, options.status ?? 400);
    this.name = "MoodleError";
    this.moodleCode = options.moodleCode;
    this.functionName = options.functionName;
  }
}

export interface MoodleWarning {
  readonly warningcode?: string;
  readonly item?: string;
  readonly itemid?: number;
  readonly message?: string;
  readonly [key: string]: unknown;
}

export interface MoodlePagination {
  readonly page?: number;
  readonly per_page?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly has_more: boolean;
  readonly total_returned: number;
  readonly total_available?: number;
}

export interface MoodleResult<T> {
  readonly coverage: Coverage;
  readonly data: T | null;
  readonly warnings: readonly MoodleWarning[];
  readonly error_code: MoodleErrorCode | null;
  readonly error_detail?: { moodle_code?: string; function?: string; status?: number };
  readonly observed_at: string;
  readonly empty: boolean;
  readonly truncated: boolean;
  readonly pagination?: MoodlePagination;
}

export interface MoodleIdentity {
  readonly user_id: number;
  readonly username?: string;
  readonly fullname?: string;
  readonly site_url: string;
  readonly site_name?: string;
  readonly release?: string;
  readonly version?: string;
  readonly functions_offered: number;
}

export interface MoodleCapabilities {
  readonly origin: string;
  readonly site_url: string;
  readonly site_name?: string;
  readonly release?: string;
  readonly version?: string;
  readonly user_id: number;
  readonly username?: string;
  readonly audited_functions: readonly string[];
  readonly implemented_functions: readonly string[];
  readonly offered_functions: readonly string[];
  readonly available_functions: readonly string[];
  readonly not_offered_functions: readonly string[];
  readonly blocked_functions: readonly { function: string; reason: string }[];
  readonly academic_read_only: true;
  readonly browser_cookies_used: false;
  readonly redirects_followed: false;
  readonly observed_at: string;
}

export interface MoodleFileRef {
  readonly file_id: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly filesize: number | null;
  readonly url: string;
  readonly provenance?: Provenance;
}

export interface MoodleBinary extends MoodleFileRef {
  readonly byte_length: number;
  readonly sha256: string;
  readonly content_type: string | null;
  readonly bytes: Uint8Array;
  readonly text?: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface MoodleConfig {
  /** Origem com esquema, host e subdiretorio opcional. Ex.: https://elearning.ulisboa.pt */
  readonly origin: string;
  /** Token do servico web Moodle. Nunca e devolvido nem registrado. */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxDownloadBytes?: number;
  readonly userAgent?: string;
}

export interface MoodleDeps {
  /** Injecao de fetch para fixtures/testes. Quando presente, a checagem real de DNS e pulada. */
  readonly fetch?: FetchLike;
  /** Injecao do resolvedor de DNS. Usado para testar rejeicao de rede nao publica. */
  readonly resolveHost?: HostResolver;
}

// --- Allowlist auditada, implementacao e bloqueios -------------------------

/** Funcoes auditadas: security.py ALLOWLIST + docs/capabilities.md. */
export const AUDITED_FUNCTIONS: readonly string[] = Object.freeze([
  "core_webservice_get_site_info",
  "core_enrol_get_users_courses",
  "core_course_get_contents",
  "core_calendar_get_calendar_events",
  "mod_assign_get_assignments",
  "mod_page_get_pages_by_courses",
  "mod_book_get_books_by_courses",
  "mod_resource_get_resources_by_courses",
  "mod_url_get_urls_by_courses",
  "mod_forum_get_forums_by_courses",
  "mod_forum_get_forum_discussions",
  "mod_forum_get_discussion_posts",
  "mod_feedback_get_feedbacks_by_courses",
  "mod_feedback_get_items",
  "core_completion_get_activities_completion_status",
  "core_completion_get_course_completion_status",
]);

/** Funcoes que este adaptador realmente chama. */
export const IMPLEMENTED_FUNCTIONS: readonly string[] = Object.freeze([...AUDITED_FUNCTIONS]);

const IMPLEMENTED_SET: ReadonlySet<string> = new Set(IMPLEMENTED_FUNCTIONS);

/** Funcoes recusadas de proposito, com o motivo auditado. */
export const BLOCKED_FUNCTIONS: readonly { function: string; reason: string }[] = Object.freeze([
  {
    function: "mod_assign_get_submission_status",
    reason:
      "get_assign_feedback_status_renderable chama grade_get_grades e pode recalcular notas e criar registros internos.",
  },
  {
    function: "gradereport_user_get_grade_items",
    reason: "get_report_data chama grade_regrade_final_grades.",
  },
]);

const BLOCKED_SET: ReadonlySet<string> = new Set(BLOCKED_FUNCTIONS.map((item) => item.function));

export function isBlockedFunction(fn: string): boolean {
  return BLOCKED_SET.has(fn);
}

// --- Limites ---------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PAGE = 1000;
export const MAX_PER_PAGE = 100;
export const MAX_COURSE_IDS = 50;
export const MAX_POSTS = 1000;
export const MAX_HTML_CHARS = 1_000_000;
export const MAX_TEXT_CHARS = 100_000;
const MAX_TEXT_DECODE_BYTES = 512 * 1024;

const RESERVED_PARAMS: ReadonlySet<string> = new Set([
  "wstoken",
  "wsfunction",
  "moodlewsrestformat",
]);

const SECRET_KEYS: ReadonlySet<string> = new Set([
  "token",
  "wstoken",
  "privatetoken",
  "sesskey",
  "password",
  "authorization",
  "authtoken",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
]);

const SKIP_KEYS: ReadonlySet<string> = new Set([
  ...SECRET_KEYS,
  "onclick",
  "userpictureurl",
  "userpictureurlsmall",
  "useremail",
  "email",
]);

const HTML_KEYS: ReadonlySet<string> = new Set([
  "summary",
  "intro",
  "content",
  "message",
  "feedback",
  "description",
  "questiontext",
  "definition",
]);

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  vtt: "text/vtt",
};

function nowIso(): string {
  return new Date().toISOString();
}

// --- Origem, DNS e validacao ----------------------------------------------

export interface ParsedOrigin {
  /** Origem canonica, sem barra final. Ex.: https://host/moodle */
  readonly origin: string;
  readonly scheme: string;
  /** Host com porta quando nao padrao. */
  readonly host: string;
  readonly hostname: string;
  /** Subdiretorio canonico comecando com / ou string vazia. */
  readonly subdir: string;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function decodeRepeatedly(raw: string): string {
  let value = raw;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(value);
    } catch {
      throw new MoodleError("security_error", "Caminho com codificacao invalida.");
    }
    if (next === value) break;
    value = next;
  }
  return value;
}

function hasTraversal(decodedPath: string): boolean {
  if (decodedPath.includes("\\")) return true;
  for (const segment of decodedPath.split("/")) {
    if (segment === ".." || segment === ".") return true;
  }
  return false;
}

function normalizeSubdir(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  const decoded = decodeRepeatedly(pathname);
  if (hasTraversal(decoded)) {
    throw new MoodleError("security_error", "Subdiretorio da origem Moodle com traversal.");
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return "";
  return "/" + segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function parseMoodleOrigin(raw: string): ParsedOrigin {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new MoodleError("security_error", "Origem Moodle ausente.");
  }
  const value = raw.trim();
  if (value.includes("\\")) {
    throw new MoodleError("security_error", "Origem Moodle com barra invertida.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MoodleError("security_error", "Origem Moodle invalida.");
  }
  if (url.username || url.password) {
    throw new MoodleError("security_error", "Origem Moodle nao pode conter credenciais.");
  }
  if (url.search || url.hash) {
    throw new MoodleError("security_error", "Origem Moodle nao pode conter query ou fragmento.");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const loopback = isLoopbackHost(url.hostname);
  if (scheme !== "https" && !(scheme === "http" && loopback)) {
    throw new MoodleError("security_error", "A origem Moodle deve usar HTTPS.");
  }
  const defaultPort = scheme === "https" ? "443" : "80";
  if (url.port && url.port !== defaultPort && !loopback) {
    throw new MoodleError("security_error", "Porta explicita nao permitida na origem Moodle.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "") {
    throw new MoodleError("security_error", "Host da origem Moodle ausente.");
  }
  const subdir = normalizeSubdir(url.pathname);
  const host = url.port ? hostname + ":" + url.port : hostname;
  return { origin: scheme + "://" + host + subdir, scheme, host, hostname, subdir };
}

/** Aceita apenas IPv4/IPv6 de alcance global (rejeita loopback, privado, link-local, doc, etc.). */
export function isPublicIp(raw: string): boolean {
  const ip = raw.trim().toLowerCase();
  if (ip === "") return false;
  return ip.includes(":") ? isPublicIpv6(ip) : isPublicIpv4(ip);
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  const a = octets[0];
  const b = octets[1];
  const c = octets[2];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

/**
 * Expande um IPv6 textual (incluindo forma hexadecimal e IPv4 embutido) em 8
 * grupos de 16 bits. Devolve null para formato invalido ou zona.
 */
function parseIpv6(raw: string): number[] | null {
  let value = raw.toLowerCase();
  if (value.includes("%")) return null;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const octets = value.slice(lastColon + 1).split(".");
    if (octets.length !== 4) return null;
    const numbers: number[] = [];
    for (const octet of octets) {
      if (!/^\d{1,3}$/.test(octet)) return null;
      const number = Number(octet);
      if (number > 255) return null;
      numbers.push(number);
    }
    value = value.slice(0, lastColon + 1) +
      ((numbers[0] << 8) | numbers[1]).toString(16) + ":" +
      ((numbers[2] << 8) | numbers[3]).toString(16);
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isPublicIpv6(ip: string): boolean {
  const groups = parseIpv6(ip.replace(/^\[|\]$/g, ""));
  if (!groups) return false;
  const g0 = groups[0];
  const g1 = groups[1];
  const g2 = groups[2];
  const g3 = groups[3];
  const g4 = groups[4];
  const g5 = groups[5];
  const g6 = groups[6];
  const g7 = groups[7];
  if (groups.every((group) => group === 0)) return false; // ::
  if (
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1
  ) {
    return false; // ::1
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    // IPv4-mapeado, IPv4-compativel ou IPv4-traduzido: decide pelo IPv4 embutido,
    // em forma decimal ou hexadecimal.
    return isPublicIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff].join("."));
  }
  if (g0 === 0x0064 && g1 === 0xff9b) return false; // NAT64 64:ff9b::/96 e 64:ff9b:1::/48
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // 100::/64 discard-only
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentacao 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0x0000) return false; // Teredo 2001::/32
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false; // documentacao 3fff::/20
  if (g0 === 0x2002) {
    // 6to4: decide pelo IPv4 embutido nos grupos 2 e 3.
    return isPublicIpv4([(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff].join("."));
  }
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local obsoleto
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      const records = await Deno.resolveDns(hostname, type);
      for (const record of records) out.push(record);
    } catch {
      // Familia ausente ou indisponivel; a outra familia ainda pode resolver.
    }
  }
  return [...new Set(out)];
}

// --- Redacao e sanitizacao -------------------------------------------------

function redactString(value: string, token: string): string {
  let out = value;
  if (token) out = out.split(token).join("[REDACTED]");
  out = out.replace(
    /([?&]?(?:wstoken|token|privatetoken|sesskey|password|access_token|refresh_token)=)[^&\s"'<>]+/gi,
    "$1[REDACTED]",
  );
  out = out.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
  return out;
}

export function redactValue(value: unknown, token: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, token));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue;
      out[key] = redactValue(item, token);
    }
    return out;
  }
  if (typeof value === "string") return redactString(value, token);
  return value;
}

export function sanitizeHtml(
  raw: string,
  maxHtmlChars: number = MAX_HTML_CHARS,
): { html: string; text: string; truncated: boolean } {
  const input = String(raw ?? "").slice(0, maxHtmlChars * 2);
  let html = input.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  html = html.replace(/<(iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  html = html.replace(/<(iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi, "");
  html = html.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/(href|src)\s*=\s*(?:"|')?\s*javascript:[^"'\s>]*/gi, '$1="#"');
  const truncated = input.length > maxHtmlChars;
  html = html.slice(0, maxHtmlChars);
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return { html, text, truncated };
}

// --- Erros -----------------------------------------------------------------

const MOODLE_CODE_MAP: Readonly<Record<string, MoodleErrorCode>> = {
  invalidtoken: "invalid_token",
  accessexception: "permission_denied",
  nopermissions: "permission_denied",
  requireloginerror: "permission_denied",
  servicenotavailable: "function_unavailable",
  invalidrecord: "not_found",
  invalidcourseid: "not_found",
  invalidcoursemodule: "not_found",
  invalidparameter: "parsing_error",
};

const ERROR_MESSAGES: Readonly<Record<MoodleErrorCode, string>> = {
  moodle_error: "O Moodle recusou a consulta.",
  invalid_token: "O token Moodle foi recusado ou expirou.",
  permission_denied: "A conta nao tem permissao para esta leitura.",
  function_unavailable: "A funcao nao e oferecida pelo servico do token.",
  not_found: "O recurso nao foi encontrado nesta conta.",
  invalid_id: "Identificador invalido.",
  unsupported_function: "Funcao fora do adaptador implementado.",
  security_error: "A operacao foi recusada por politica de seguranca.",
  http_error: "Falha de transporte na consulta Moodle.",
  timeout: "Tempo da consulta Moodle excedido.",
  parsing_error: "A resposta do Moodle nao pode ser interpretada.",
  limit_exceeded: "Um limite do adaptador foi excedido.",
  download_error: "Falha no download do arquivo Moodle.",
};

function coverageFor(code: MoodleErrorCode): Coverage {
  switch (code) {
    case "invalid_token":
      return "expired";
    case "permission_denied":
    case "security_error":
      return "denied";
    case "timeout":
      return "timeout";
    case "parsing_error":
      return "parsing_error";
    default:
      return "unavailable";
  }
}

function failureResult<T>(error: unknown): MoodleResult<T> {
  if (error instanceof MoodleError) {
    return {
      coverage: coverageFor(error.code),
      data: null,
      warnings: [],
      error_code: error.code,
      error_detail: {
        moodle_code: error.moodleCode,
        function: error.functionName,
        status: error.status,
      },
      observed_at: nowIso(),
      empty: false,
      truncated: false,
    };
  }
  return {
    coverage: "unavailable",
    data: null,
    warnings: [],
    error_code: "moodle_error",
    observed_at: nowIso(),
    empty: false,
    truncated: false,
  };
}

export function unwrap<T>(result: MoodleResult<T>): T {
  const code = result.error_code ?? "moodle_error";
  if (result.error_code !== null || result.data === null) {
    throw new MoodleError(code, ERROR_MESSAGES[code], {
      moodleCode: result.error_detail?.moodle_code,
      functionName: result.error_detail?.function,
    });
  }
  return result.data;
}

function moodleErrorFromResponse(payload: Record<string, unknown>, fn: string): MoodleError {
  const rawCode = typeof payload.errorcode === "string" ? payload.errorcode.toLowerCase() : "";
  const code = MOODLE_CODE_MAP[rawCode] ?? "moodle_error";
  // Nunca repassar message/debuginfo: podem conter dados ou segredos.
  return new MoodleError(code, ERROR_MESSAGES[code], {
    functionName: fn,
    moodleCode: rawCode || undefined,
  });
}

// --- Utilidades de payload -------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickArray(value: unknown, key: string): unknown[] {
  const record = asRecord(value);
  const items = record?.[key];
  return Array.isArray(items) ? items : [];
}

interface ByteSource {
  readonly stream: AsyncIterable<Uint8Array>;
  cancel(): void;
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseContentLength(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

async function readCapped(
  source: ByteSource,
  declaredLength: number | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (declaredLength !== null && declaredLength > maxBytes) {
    source.cancel();
    throw new MoodleError("limit_exceeded", ERROR_MESSAGES.limit_exceeded);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of source.stream) {
      if (!chunk || chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (total > maxBytes) {
        source.cancel();
        throw new MoodleError("limit_exceeded", ERROR_MESSAGES.limit_exceeded);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    source.cancel();
    throw error;
  }
  return concatBytes(chunks, total);
}

function webBodySource(body: ReadableStream<Uint8Array> | null): ByteSource {
  const reader = body ? body.getReader() : null;
  const stream = (async function* () {
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  })();
  return {
    stream,
    cancel: () => {
      reader?.cancel().catch(() => {});
    },
  };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256HexOfString(value: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(value));
}

function guessMime(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function filenameFromUrl(url: string): string {
  const last = url.split("?")[0].split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function safeFilename(raw: string): string {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/^\s+|\s+$/g, "");
  const limited = cleaned.slice(0, 150);
  return limited === "" ? "arquivo" : limited;
}

function isTextualMime(mime: string | null): boolean {
  if (!mime) return false;
  const value = mime.toLowerCase();
  return (
    value.startsWith("text/") ||
    value === "application/json" ||
    value === "application/xml" ||
    value.endsWith("+json") ||
    value.endsWith("+xml")
  );
}

export function positiveId(value: unknown, label = "id"): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new MoodleError("invalid_id", "Identificador invalido (" + label + ").");
  }
  return value;
}

function validateCourseIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new MoodleError("invalid_id", "Lista de cursos invalida.");
  const ids: number[] = [];
  for (const item of value) {
    const id = positiveId(item, "courseid");
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_COURSE_IDS) {
    throw new MoodleError(
      "limit_exceeded",
      "Maximo de " + MAX_COURSE_IDS + " cursos por consulta.",
    );
  }
  return ids;
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new MoodleError("invalid_id", "Parametro invalido (" + label + ").");
  }
  if (value > max) {
    throw new MoodleError("limit_exceeded", "Parametro acima do limite (" + label + ").");
  }
  return value;
}

export function flattenMoodleParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(key + "[" + index + "]", item));
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(key + "[" + childKey + "]", child);
      }
      return;
    }
    if (typeof value === "boolean") {
      out[key] = value ? "1" : "0";
      return;
    }
    if (typeof value === "number" || typeof value === "string") {
      out[key] = String(value);
      return;
    }
    throw new MoodleError("parsing_error", "Parametro Moodle nao serializavel.");
  };
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_PARAMS.has(key)) {
      throw new MoodleError("security_error", "Parametro reservado recusado.");
    }
    visit(key, value);
  }
  return out;
}

function validateInterval(start: string, end: string): { startTs: number; endTs: number } {
  const hasZone = (value: string): boolean => /(?:z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  if (typeof start !== "string" || typeof end !== "string" || !hasZone(start) || !hasZone(end)) {
    throw new MoodleError("parsing_error", "Use datas ISO 8601 com fuso explicito.");
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new MoodleError("parsing_error", "Intervalo de datas invalido.");
  }
  if (endMs - startMs > 366 * 86_400_000) {
    throw new MoodleError("limit_exceeded", "Intervalo de datas acima de 366 dias.");
  }
  return { startTs: Math.floor(startMs / 1000), endTs: Math.floor(endMs / 1000) };
}

function normalizeComparableUrl(raw: string): { origin: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") return null;
  const host = url.port ? url.hostname.toLowerCase() + ":" + url.port : url.hostname.toLowerCase();
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "/") path = "";
  return { origin: scheme + "://" + host, path };
}

// --- Adaptador -------------------------------------------------------------

interface CallPayload<T> {
  data: T;
  warnings: MoodleWarning[];
  empty?: boolean;
  truncated?: boolean;
  pagination?: MoodlePagination;
}

interface RegisteredFile {
  file_id: string;
  filename: string;
  mimetype: string;
  filesize: number | null;
  url: string;
  provenance?: Provenance;
}

interface SendOptions {
  readonly url: string;
  readonly method: "POST" | "GET";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly maxBytes: number;
  readonly addresses: readonly string[];
  readonly fn: string;
}

interface TransportReply {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value ?? null;
}

/** Escolhe um unico endereco publico ja validado para fixar a conexao. */
function pickPinnedAddress(addresses: readonly string[]): string | null {
  if (addresses.length === 0) return null;
  const ipv4 = addresses.find((address) => !address.includes(":"));
  return ipv4 ?? addresses[0];
}

/**
 * Devolve ao runtime exatamente o endereco validado, em vez de re-resolver o
 * hostname. O hostname original continua sendo usado para Host, SNI e TLS.
 */
function pinnedLookup(
  address: string,
  lookupOptions: unknown,
  callback: (...args: unknown[]) => void,
): void {
  const family = address.includes(":") ? 6 : 4;
  const wantsAll = lookupOptions !== null && typeof lookupOptions === "object" &&
    (lookupOptions as { all?: unknown }).all === true;
  if (wantsAll) callback(null, [{ address, family }]);
  else callback(null, address, family);
}

export class MoodleAdapter {
  private readonly _origin: ParsedOrigin;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxDownloadBytes: number;
  private readonly userAgent: string;
  private readonly _injectedFetch?: FetchLike;
  private readonly _resolver: HostResolver;
  private readonly _checkDns: boolean;

  private identityPromise?: Promise<MoodleIdentity>;
  private identity?: MoodleIdentity;
  private offeredFunctions: ReadonlySet<string> = new Set();
  private availableFunctions: ReadonlySet<string> = new Set();
  private readonly files = new Map<string, RegisteredFile>();

  constructor(config: MoodleConfig, deps: MoodleDeps = {}) {
    this._origin = parseMoodleOrigin(config?.origin ?? "");
    if (typeof config?.token !== "string" || config.token.trim() === "") {
      throw new MoodleError("invalid_token", "Token Moodle ausente.");
    }
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxDownloadBytes = config.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.userAgent = config.userAgent ?? "arahub-moodle-adapter/0.1";
    if (!(this.timeoutMs > 0)) throw new MoodleError("invalid_id", "timeoutMs deve ser positivo.");
    if (!(this.maxResponseBytes > 0)) {
      throw new MoodleError("invalid_id", "maxResponseBytes deve ser positivo.");
    }
    if (!(this.maxDownloadBytes > 0)) {
      throw new MoodleError("invalid_id", "maxDownloadBytes deve ser positivo.");
    }
    this._injectedFetch = deps.fetch;
    this._resolver = deps.resolveHost ?? defaultResolveHost;
    // O DNS e validado no caminho real e sempre que um resolvedor e injetado
    // para teste. Sem resolvedor e com fetch injetado, e fixture pura.
    this._checkDns = deps.resolveHost !== undefined || deps.fetch === undefined;
  }

  get origin(): string {
    return this._origin.origin;
  }

  get auditedFunctions(): readonly string[] {
    return AUDITED_FUNCTIONS;
  }

  get identitySnapshot(): MoodleIdentity | null {
    return this.identity ?? null;
  }

  get availableFunctionsSnapshot(): readonly string[] {
    return [...this.availableFunctions];
  }

  private get restEndpoint(): string {
    return this._origin.origin + "/webservice/rest/server.php";
  }

  private get pluginfileEndpoint(): string {
    return this._origin.origin + "/webservice/pluginfile.php";
  }

  // -- DNS ---------------------------------------------------------------

  /**
   * Revalida o DNS a cada envio, sem cache definitivo. Devolve os enderecos
   * publicos da resolucao atual para fixar a conexao (fecha a janela TOCTOU).
   */
  private async resolveValidatedAddresses(): Promise<readonly string[]> {
    if (!this._checkDns) return [];
    let addresses: readonly string[];
    try {
      addresses = await this._resolver(this._origin.hostname);
    } catch {
      throw new MoodleError("http_error", "Falha ao resolver a origem Moodle.");
    }
    if (!addresses || addresses.length === 0) {
      throw new MoodleError("security_error", "A origem Moodle nao resolveu para enderecos.");
    }
    for (const address of addresses) {
      if (!isPublicIp(address)) {
        throw new MoodleError("security_error", "A origem Moodle resolve para rede nao publica.");
      }
    }
    return addresses;
  }

  // -- Transporte --------------------------------------------------------

  private transportError(error: unknown, fn: string): MoodleError {
    const name = error !== null && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
    if (name === "AbortError" || name === "TimeoutError") {
      return new MoodleError("timeout", ERROR_MESSAGES.timeout, { functionName: fn });
    }
    return new MoodleError("http_error", ERROR_MESSAGES.http_error, { functionName: fn });
  }

  private async post(fn: string, params: Record<string, unknown>): Promise<unknown> {
    const body = flattenMoodleParams(params);
    body["wstoken"] = this.token;
    body["wsfunction"] = fn;
    body["moodlewsrestformat"] = "json";
    // Revalida o DNS e fixa o endereco publico antes de enviar a credencial.
    const addresses = await this.resolveValidatedAddresses();
    const reply = await this.send({
      url: this.restEndpoint,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "accept": "application/json",
        "user-agent": this.userAgent,
      },
      body: new URLSearchParams(body).toString(),
      maxBytes: this.maxResponseBytes,
      addresses,
      fn,
    });
    if (REDIRECT_STATUS.has(reply.status)) {
      throw new MoodleError("security_error", "Redirecionamento recusado na consulta Moodle.", {
        functionName: fn,
        status: reply.status,
      });
    }
    if (reply.status !== 200) {
      throw new MoodleError("http_error", "Falha HTTP na consulta Moodle (" + reply.status + ").", {
        functionName: fn,
        status: reply.status,
      });
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(reply.bytes);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MoodleError("parsing_error", ERROR_MESSAGES.parsing_error, { functionName: fn });
    }
    const record = asRecord(data);
    if (record && (typeof record.errorcode === "string" || typeof record.exception === "string")) {
      throw moodleErrorFromResponse(record, fn);
    }
    return data;
  }

  /**
   * Envia uma requisicao e devolve status, content-type e bytes ja limitados.
   * Caminho real: node:https com lookup fixado nos enderecos publicos validados
   * (Host, SNI e verificacao TLS continuam sendo os do hostname configurado).
   * Caminho de fixture: fetch injetado, sem rede real.
   */
  private async send(options: SendOptions): Promise<TransportReply> {
    if (this._injectedFetch) return await this.sendViaFetch(options);
    return await this.sendViaNode(options);
  }

  private async sendViaFetch(options: SendOptions): Promise<TransportReply> {
    const fetchImpl = this._injectedFetch as FetchLike;
    try {
      const response = await fetchImpl(options.url, {
        method: options.method,
        redirect: "manual",
        headers: { ...options.headers },
        body: options.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const contentType = response.headers.get("content-type");
      if (response.status !== 200) {
        if (response.body) await response.body.cancel().catch(() => {});
        return { status: response.status, contentType, bytes: new Uint8Array(0) };
      }
      const declared = parseContentLength(response.headers.get("content-length"));
      const bytes = await readCapped(webBodySource(response.body), declared, options.maxBytes);
      return { status: 200, contentType, bytes };
    } catch (error) {
      if (error instanceof MoodleError) throw error;
      throw this.transportError(error, options.fn);
    }
  }

  private async sendViaNode(options: SendOptions): Promise<TransportReply> {
    const target = new URL(options.url);
    if (target.protocol !== "https:") {
      // O transporte interno e HTTPS. Origem http de loopback existe apenas para
      // integracao local com fetch injetado.
      throw new MoodleError(
        "http_error",
        "O transporte interno exige HTTPS; injete fetch para http de loopback.",
      );
    }
    const address = pickPinnedAddress(options.addresses);
    if (address === null) {
      // Fail closed: sem endereco validado nao ha conexao, para nao reabrir a
      // janela de DNS entre a validacao e o proprio runtime.
      throw new MoodleError("security_error", "Nenhum endereco publico validado para a origem.");
    }
    const requestOptions: Record<string, unknown> = {
      hostname: target.hostname,
      port: target.port === "" ? 443 : Number(target.port),
      path: target.pathname + target.search,
      method: options.method,
      headers: options.headers,
      lookup: (
        _hostname: string,
        lookupOptions: unknown,
        callback: (...args: unknown[]) => void,
      ) => {
        pinnedLookup(address, lookupOptions, callback);
      },
    };
    return await new Promise<TransportReply>((resolve, reject) => {
      const request = httpsRequest(requestOptions as never, (response) => {
        const status = response.statusCode ?? 0;
        const contentType = firstHeader(response.headers["content-type"]);
        if (status !== 200) {
          response.resume();
          resolve({ status, contentType, bytes: new Uint8Array(0) });
          return;
        }
        const declared = parseContentLength(firstHeader(response.headers["content-length"]));
        readCapped(
          {
            stream: response as unknown as AsyncIterable<Uint8Array>,
            cancel: () => response.destroy(),
          },
          declared,
          options.maxBytes,
        ).then((bytes) => resolve({ status, contentType, bytes })).catch((error) => {
          response.destroy();
          reject(error);
        });
      });
      request.on("error", (error) => reject(this.transportError(error, options.fn)));
      request.setTimeout(this.timeoutMs, () => {
        const timeoutError = new Error("Tempo da consulta Moodle excedido.");
        timeoutError.name = "TimeoutError";
        request.destroy(timeoutError);
      });
      if (options.body !== undefined) request.write(options.body);
      request.end();
    }).catch((error) => {
      if (error instanceof MoodleError) throw error;
      throw this.transportError(error, options.fn);
    });
  }

  private assertImplemented(fn: string): void {
    if (BLOCKED_SET.has(fn)) {
      throw new MoodleError("security_error", "Funcao bloqueada por efeito colateral auditado.", {
        functionName: fn,
      });
    }
    if (!IMPLEMENTED_SET.has(fn) || /(^|_)view(_|$)/.test(fn)) {
      throw new MoodleError("unsupported_function", ERROR_MESSAGES.unsupported_function, {
        functionName: fn,
      });
    }
  }

  private async call(fn: string, params: Record<string, unknown>): Promise<unknown> {
    this.assertImplemented(fn);
    await this.initialize();
    if (!this.availableFunctions.has(fn)) {
      throw new MoodleError("function_unavailable", ERROR_MESSAGES.function_unavailable, {
        functionName: fn,
      });
    }
    return await this.post(fn, params);
  }

  // -- Identidade e descoberta -------------------------------------------

  async initialize(): Promise<MoodleIdentity> {
    if (this.identityPromise === undefined) {
      this.identityPromise = this.loadIdentity().catch((error) => {
        this.identityPromise = undefined;
        throw error;
      });
    }
    return await this.identityPromise;
  }

  private async loadIdentity(): Promise<MoodleIdentity> {
    const raw = await this.post("core_webservice_get_site_info", {});
    const site = asRecord(raw);
    if (!site) throw new MoodleError("parsing_error", "Identidade Moodle invalida.");
    const userId = site.userid;
    if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
      throw new MoodleError("parsing_error", "Identidade Moodle invalida: userid ausente.");
    }
    const rawSiteUrl = site.siteurl;
    if (typeof rawSiteUrl !== "string" || rawSiteUrl.trim() === "") {
      throw new MoodleError("parsing_error", "Identidade Moodle invalida: siteurl ausente.");
    }
    const comparable = normalizeComparableUrl(rawSiteUrl);
    if (!comparable) throw new MoodleError("security_error", "siteurl retornada e invalida.");
    const baseOrigin = this._origin.scheme + "://" + this._origin.host;
    if (comparable.origin !== baseOrigin || comparable.path !== this._origin.subdir) {
      throw new MoodleError("security_error", "Origem Moodle inesperada na identidade do site.");
    }
    const offered = new Set<string>();
    if (Array.isArray(site.functions)) {
      for (const entry of site.functions) {
        const record = asRecord(entry);
        if (record && typeof record.name === "string") offered.add(record.name);
      }
    }
    this.offeredFunctions = offered;
    this.availableFunctions = new Set(
      AUDITED_FUNCTIONS.filter((name) => offered.has(name) && IMPLEMENTED_SET.has(name)),
    );
    const identity: MoodleIdentity = {
      user_id: userId,
      username: typeof site.username === "string"
        ? redactString(site.username, this.token)
        : undefined,
      fullname: typeof site.fullname === "string"
        ? redactString(site.fullname, this.token)
        : undefined,
      site_url: rawSiteUrl,
      site_name: typeof site.sitename === "string"
        ? redactString(site.sitename, this.token)
        : undefined,
      release: typeof site.release === "string" ? site.release : undefined,
      version: typeof site.version === "string" ? site.version : undefined,
      functions_offered: offered.size,
    };
    this.identity = identity;
    return identity;
  }

  async getIdentity(): Promise<MoodleResult<MoodleIdentity>> {
    return await this.run(async () => ({ data: await this.initialize(), warnings: [] }));
  }

  async discover(): Promise<MoodleCapabilities> {
    const identity = await this.initialize();
    const offered = [...this.offeredFunctions].sort();
    const offeredSet = new Set(offered);
    const available = [...this.availableFunctions].sort();
    return {
      origin: this._origin.origin,
      site_url: identity.site_url,
      site_name: identity.site_name,
      release: identity.release,
      version: identity.version,
      user_id: identity.user_id,
      username: identity.username,
      audited_functions: [...AUDITED_FUNCTIONS],
      implemented_functions: [...IMPLEMENTED_FUNCTIONS],
      offered_functions: offered,
      available_functions: available,
      not_offered_functions: AUDITED_FUNCTIONS.filter((name) => !offeredSet.has(name)),
      blocked_functions: BLOCKED_FUNCTIONS.map((item) => ({ ...item })),
      academic_read_only: true,
      browser_cookies_used: false,
      redirects_followed: false,
      observed_at: nowIso(),
    };
  }

  async isAvailable(fn: string): Promise<boolean> {
    await this.initialize();
    return this.availableFunctions.has(fn);
  }

  // -- Normalizacao ------------------------------------------------------

  private splitWarnings(raw: unknown): { data: unknown; warnings: MoodleWarning[] } {
    const record = asRecord(raw);
    const rawWarnings = record?.warnings;
    if (Array.isArray(rawWarnings)) {
      const warnings = rawWarnings
        .map((item) => redactValue(item, this.token))
        .filter((item): item is MoodleWarning => asRecord(item) !== null);
      return { data: raw, warnings };
    }
    return { data: raw, warnings: [] };
  }

  private async normalizeValue(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return await Promise.all(value.map((item) => this.normalizeValue(item)));
    }
    if (value === null || typeof value !== "object") {
      return typeof value === "string" ? redactString(value, this.token) : value;
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      if (key === "fileurl") continue;
      if (SKIP_KEYS.has(key.toLowerCase())) continue;
      out[key] = await this.normalizeValue(item);
      if (typeof item === "string" && HTML_KEYS.has(key.toLowerCase())) {
        const sanitized = sanitizeHtml(item);
        out[key] = sanitized.html;
        out[key + "_text"] = sanitized.text;
      }
    }
    if (typeof obj.fileurl === "string" && obj.type !== "content") {
      try {
        out.file = await this.registerFile(obj);
      } catch (error) {
        out.file_error = error instanceof MoodleError ? error.code : "moodle_error";
      }
    }
    return redactValue(out, this.token);
  }

  private async readArray(
    fn: string,
    params: Record<string, unknown>,
  ): Promise<CallPayload<MoodleRecord[]>> {
    const raw = await this.call(fn, params);
    const { data, warnings } = this.splitWarnings(raw);
    const items = Array.isArray(data) ? data : [];
    const normalized = await this.normalizeValue(items);
    return {
      data: Array.isArray(normalized) ? (normalized as MoodleRecord[]) : [],
      warnings,
      empty: items.length === 0,
    };
  }

  private async run<T>(work: () => Promise<CallPayload<T>>): Promise<MoodleResult<T>> {
    try {
      const payload = await work();
      const warnings = payload.warnings ?? [];
      const empty = payload.empty ??
        (Array.isArray(payload.data) ? payload.data.length === 0 : false);
      const truncated = payload.truncated ?? false;
      // Invariante: um resultado truncado nunca pode continuar "complete".
      return {
        coverage: truncated || warnings.length > 0 ? "partial" : "complete",
        data: payload.data,
        warnings,
        error_code: null,
        observed_at: nowIso(),
        empty,
        truncated,
        pagination: payload.pagination,
      };
    } catch (error) {
      return failureResult<T>(error);
    }
  }

  // -- Leituras ----------------------------------------------------------

  async listCourses(): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const identity = await this.initialize();
      const raw = await this.call("core_enrol_get_users_courses", { userid: identity.user_id });
      const { data, warnings } = this.splitWarnings(raw);
      const items = Array.isArray(data) ? data : [];
      const normalized = await this.normalizeValue(items);
      return {
        data: Array.isArray(normalized) ? (normalized as MoodleRecord[]) : [],
        warnings,
        empty: items.length === 0,
      };
    });
  }

  async getCourseContents(courseId: number): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const id = positiveId(courseId, "courseid");
      const raw = await this.call("core_course_get_contents", { courseid: id });
      const { data, warnings } = this.splitWarnings(raw);
      const sections = Array.isArray(data) ? data : [];
      const normalized = await this.normalizeValue(sections);
      return {
        data: Array.isArray(normalized) ? (normalized as MoodleRecord[]) : [],
        warnings,
        empty: sections.length === 0,
      };
    });
  }

  async getPages(courseIds: readonly number[]): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(courseIds);
      if (ids.length === 0) return { data: [], warnings: [], empty: true };
      return await this.readArray("mod_page_get_pages_by_courses", { courseids: ids });
    });
  }

  async getBooks(courseIds: readonly number[]): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(courseIds);
      if (ids.length === 0) return { data: [], warnings: [], empty: true };
      return await this.readArray("mod_book_get_books_by_courses", { courseids: ids });
    });
  }

  async getResources(courseIds: readonly number[]): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(courseIds);
      if (ids.length === 0) return { data: [], warnings: [], empty: true };
      return await this.readArray("mod_resource_get_resources_by_courses", { courseids: ids });
    });
  }

  async getUrls(courseIds: readonly number[]): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(courseIds);
      if (ids.length === 0) return { data: [], warnings: [], empty: true };
      return await this.readArray("mod_url_get_urls_by_courses", { courseids: ids });
    });
  }

  async getForums(courseIds: readonly number[]): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(courseIds);
      if (ids.length === 0) return { data: [], warnings: [], empty: true };
      return await this.readArray("mod_forum_get_forums_by_courses", { courseids: ids });
    });
  }

  async getFeedbacks(courseIds: readonly number[]): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(courseIds);
      if (ids.length === 0) return { data: [], warnings: [], empty: true };
      return await this.readArray("mod_feedback_get_feedbacks_by_courses", { courseids: ids });
    });
  }

  async getAssignments(courseIds: readonly number[]): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(courseIds);
      if (ids.length === 0) return { data: [], warnings: [], empty: true };
      const raw = await this.call("mod_assign_get_assignments", { courseids: ids });
      const { data, warnings } = this.splitWarnings(raw);
      const courses = pickArray(data, "courses");
      const flat: MoodleRecord[] = [];
      for (const course of courses) {
        const record = asRecord(course);
        if (!record) continue;
        const courseId = record.id;
        for (const assignment of pickArray(record, "assignments")) {
          const item = asRecord(assignment);
          if (!item) continue;
          flat.push({ ...item, course_id: courseId });
        }
      }
      const normalized = await this.normalizeValue(flat);
      return {
        data: Array.isArray(normalized) ? (normalized as MoodleRecord[]) : [],
        warnings,
        empty: flat.length === 0,
      };
    });
  }

  async getFeedbackItems(feedbackId: number): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const id = positiveId(feedbackId, "feedbackid");
      return await this.readArray("mod_feedback_get_items", { feedbackid: id });
    });
  }

  async getForumDiscussions(
    forumId: number,
    options: { page?: number; perPage?: number; sortOrder?: number } = {},
  ): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const id = positiveId(forumId, "forumid");
      const page = boundedInt(options.page, 0, 0, MAX_PAGE, "page");
      const perPage = boundedInt(options.perPage, 20, 1, MAX_PER_PAGE, "perPage");
      const sortOrder = boundedInt(options.sortOrder, 1, 1, 2, "sortOrder");
      const raw = await this.call("mod_forum_get_forum_discussions", {
        forumid: id,
        page,
        perpage: perPage,
        sortorder: sortOrder,
      });
      const { data, warnings } = this.splitWarnings(raw);
      const discussions = pickArray(data, "discussions");
      const normalized = await this.normalizeValue(discussions);
      const list = Array.isArray(normalized) ? (normalized as MoodleRecord[]) : [];
      return {
        data: list,
        warnings,
        empty: discussions.length === 0,
        pagination: {
          page,
          per_page: perPage,
          has_more: discussions.length === perPage,
          total_returned: discussions.length,
        },
      };
    });
  }

  async getDiscussionPosts(
    discussionId: number,
    options: { offset?: number; limit?: number } = {},
  ): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const id = positiveId(discussionId, "discussionid");
      const offset = boundedInt(options.offset, 0, 0, MAX_PAGE * MAX_PER_PAGE, "offset");
      const limit = boundedInt(options.limit, 50, 1, MAX_POSTS, "limit");
      const raw = await this.call("mod_forum_get_discussion_posts", {
        discussionid: id,
        sortby: "created",
        sortdirection: "ASC",
      });
      const { data, warnings } = this.splitWarnings(raw);
      const posts = pickArray(data, "posts");
      const total = posts.length;
      const sliced = posts.slice(offset, offset + limit);
      const truncated = total > offset + limit;
      const normalized = await this.normalizeValue(sliced);
      return {
        data: Array.isArray(normalized) ? (normalized as MoodleRecord[]) : [],
        warnings,
        empty: sliced.length === 0,
        truncated,
        pagination: {
          offset,
          limit,
          has_more: truncated,
          total_returned: sliced.length,
          total_available: total,
        },
      };
    });
  }

  async getActivitiesCompletion(
    courseId: number,
    userId?: number,
  ): Promise<MoodleResult<MoodleRecord>> {
    return await this.run(async () => {
      const id = positiveId(courseId, "courseid");
      const identity = await this.initialize();
      const target = userId === undefined ? identity.user_id : positiveId(userId, "userid");
      const raw = await this.call("core_completion_get_activities_completion_status", {
        courseid: id,
        userid: target,
      });
      const { data, warnings } = this.splitWarnings(raw);
      const normalized = await this.normalizeValue(data);
      const record = asRecord(normalized) ?? {};
      return { data: record, warnings, empty: pickArray(record, "statuses").length === 0 };
    });
  }

  async getCourseCompletion(
    courseId: number,
    userId?: number,
  ): Promise<MoodleResult<MoodleRecord>> {
    return await this.run(async () => {
      const id = positiveId(courseId, "courseid");
      const identity = await this.initialize();
      const target = userId === undefined ? identity.user_id : positiveId(userId, "userid");
      const raw = await this.call("core_completion_get_course_completion_status", {
        courseid: id,
        userid: target,
      });
      const { data, warnings } = this.splitWarnings(raw);
      const normalized = await this.normalizeValue(data);
      return { data: asRecord(normalized) ?? {}, warnings };
    });
  }

  async getCalendarEvents(options: {
    courseIds: readonly number[];
    start: string;
    end: string;
    includeUserEvents?: boolean;
  }): Promise<MoodleResult<MoodleRecord[]>> {
    return await this.run(async () => {
      const ids = validateCourseIds(options.courseIds);
      const { startTs, endTs } = validateInterval(options.start, options.end);
      const raw = await this.call("core_calendar_get_calendar_events", {
        events: { courseids: ids },
        options: {
          timestart: startTs,
          timeend: endTs - 1,
          userevents: options.includeUserEvents ?? true,
          siteevents: false,
        },
      });
      const { data, warnings } = this.splitWarnings(raw);
      const events = pickArray(data, "events");
      const normalized = await this.normalizeValue(events);
      return {
        data: Array.isArray(normalized) ? (normalized as MoodleRecord[]) : [],
        warnings,
        empty: events.length === 0,
      };
    });
  }

  // -- Funcoes bloqueadas ------------------------------------------------

  private blockedResult(fn: string): MoodleResult<never> {
    return {
      coverage: "denied",
      data: null,
      warnings: [],
      error_code: "security_error",
      error_detail: { function: fn },
      observed_at: nowIso(),
      empty: false,
      truncated: false,
    };
  }

  /** Notas proprias: bloqueado por recalculo indireto. Nunca chama o Moodle. */
  async getOwnGrades(_courseId?: number): Promise<MoodleResult<never>> {
    return this.blockedResult("gradereport_user_get_grade_items");
  }

  /** Status de submissao: bloqueado por recalculo indireto. Nunca chama o Moodle. */
  async getSubmissionStatus(_assignmentId?: number): Promise<MoodleResult<never>> {
    return this.blockedResult("mod_assign_get_submission_status");
  }

  // -- Arquivos ----------------------------------------------------------

  private canonicalPluginfileUrl(raw: string): string {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new MoodleError("invalid_id", "URL de arquivo ausente.");
    }
    const value = raw.trim();
    if (value.includes("\\") || value.includes("#")) {
      throw new MoodleError("security_error", "URL de arquivo invalida.");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new MoodleError("security_error", "URL de arquivo invalida.");
    }
    if (url.username || url.password) {
      throw new MoodleError("security_error", "URL de arquivo com credenciais.");
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== this._origin.scheme) {
      throw new MoodleError("security_error", "Esquema de URL de arquivo nao autorizado.");
    }
    if (url.host.toLowerCase() !== this._origin.host.toLowerCase()) {
      throw new MoodleError("security_error", "Host de arquivo nao autorizado.");
    }
    const decoded = decodeRepeatedly(url.pathname);
    if (hasTraversal(decoded)) {
      throw new MoodleError("security_error", "Caminho de arquivo com traversal.");
    }
    const wsPrefix = this._origin.subdir + "/webservice/pluginfile.php";
    const plainPrefix = this._origin.subdir + "/pluginfile.php";
    let rest: string;
    if (decoded.startsWith(wsPrefix)) rest = decoded.slice(wsPrefix.length);
    else if (decoded.startsWith(plainPrefix)) rest = decoded.slice(plainPrefix.length);
    else {
      throw new MoodleError(
        "security_error",
        "Somente pluginfile.php da origem configurada e permitido.",
      );
    }
    rest = rest.replace(/^\/+/, "");
    const encoded = rest
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return encoded === "" ? this.pluginfileEndpoint : this.pluginfileEndpoint + "/" + encoded;
  }

  private async registerFile(obj: Record<string, unknown>): Promise<MoodleFileRef> {
    const canonical = this.canonicalPluginfileUrl(String(obj.fileurl ?? ""));
    const filename = safeFilename(
      typeof obj.filename === "string" && obj.filename !== ""
        ? obj.filename
        : filenameFromUrl(canonical),
    );
    const mimetype = typeof obj.mimetype === "string" && obj.mimetype !== ""
      ? obj.mimetype
      : guessMime(filename);
    const filesize = typeof obj.filesize === "number" && Number.isFinite(obj.filesize)
      ? obj.filesize
      : null;
    const file_id = "f_" + (await sha256HexOfString(canonical));
    const ref: MoodleFileRef = { file_id, filename, mimetype, filesize, url: canonical };
    this.files.set(file_id, { ...ref });
    return ref;
  }

  getRegisteredFile(fileId: string): MoodleFileRef | null {
    const record = this.files.get(fileId);
    if (!record) return null;
    return { ...record };
  }

  listRegisteredFiles(): MoodleFileRef[] {
    return [...this.files.values()].map((record) => ({ ...record }));
  }

  async downloadFile(
    fileId: string,
    options: { maxBytes?: number } = {},
  ): Promise<MoodleResult<MoodleBinary>> {
    return await this.run(async () => {
      const record = this.files.get(fileId);
      if (!record) throw new MoodleError("invalid_id", "Registro interno de arquivo desconhecido.");
      await this.initialize();
      // Revalida o DNS e fixa o endereco publico antes de enviar a credencial.
      const addresses = await this.resolveValidatedAddresses();
      const requested = options.maxBytes === undefined ? this.maxDownloadBytes : boundedInt(
        options.maxBytes,
        this.maxDownloadBytes,
        1,
        Number.MAX_SAFE_INTEGER,
        "maxBytes",
      );
      const limit = Math.min(requested, this.maxDownloadBytes);
      const url = new URL(record.url);
      url.searchParams.set("token", this.token);
      const reply = await this.send({
        url: url.toString(),
        method: "GET",
        headers: { accept: "*/*", "user-agent": this.userAgent },
        maxBytes: limit,
        addresses,
        fn: "download",
      });
      if (REDIRECT_STATUS.has(reply.status)) {
        throw new MoodleError("security_error", "Redirecionamento recusado no download.", {
          status: reply.status,
        });
      }
      if (reply.status !== 200) {
        throw new MoodleError("http_error", "Falha HTTP no download (" + reply.status + ").", {
          status: reply.status,
        });
      }
      const bytes = reply.bytes;
      const contentType = reply.contentType;
      const mimetype = record.mimetype ||
        (contentType ?? "").split(";")[0].trim() ||
        "application/octet-stream";
      let text: string | undefined;
      if (isTextualMime(mimetype) && bytes.byteLength <= MAX_TEXT_DECODE_BYTES) {
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        text = mimetype.toLowerCase().includes("html")
          ? sanitizeHtml(decoded).text
          : decoded.slice(0, MAX_TEXT_CHARS);
      }
      const binary: MoodleBinary = {
        ...record,
        mimetype,
        byte_length: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        content_type: contentType,
        bytes,
        text,
      };
      return { data: binary, warnings: [] };
    });
  }
}
