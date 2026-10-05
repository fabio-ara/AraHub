/**
 * AraHub — migração reprodutível com curadoria rastreável.
 *
 * Este módulo implementa a fundação da etapa 5 do plano: fixar a origem
 * (branch/commit), inventariar cada arquivo com hash/tamanho/codificação/linhas,
 * preservar os bytes brutos num CAS local, verificar a origem antes de fechar o
 * lote, relacionar registros curados com trechos de origem, e exportar/restaurar
 * um lote privado com manifesto, hashes e relações.
 *
 * Invariantes:
 * - Nada aqui lê ou escreve serviços externos; o CAS é local.
 * - Nenhum segredo é copiado para um export (arquivos com nome sensível são
 *   excluídos; strings com forma de token são redigidas).
 * - O inventário é determinístico: mesmo commit + mesma árvore produzem o mesmo
 *   `batchId` e as mesmas chaves, tornando a reexecução idempotente.
 * - A data do commit não é usada como data de acontecimento; isso é
 *   responsabilidade da curadoria.
 *
 * Licença MIT. Não contém dados pessoais nem caminhos privados.
 */

export const MIGRATION_SCHEMA_VERSION = "arahub.migration.v1" as const;

/** Representação do conteúdo dentro do inventário. */
export type EntryKind = "text" | "binary" | "symlink" | "gitlink";
/** Estado do item em relação à preservação de bytes. */
export type EntryStatus = "complete" | "partial" | "missing" | "unprocessed";
/** Codificação detectada para conteúdo textual. */
export type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "binary";
export type Eol = "lf" | "crlf" | "mixed" | "none";

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
  readonly size: number;
}

/** Porta de leitura do Git. O padrão usa o binário `git`; testes podem injetar. */
export interface GitPort {
  head(source: string): Promise<{ commit: string; branch: string }>;
  tree(source: string, commit: string): Promise<GitTreeEntry[]>;
  blob(source: string, sha: string): Promise<Uint8Array>;
  isClean(source: string): Promise<boolean>;
}

export interface ExternalLink {
  readonly url: string;
  readonly count: number;
}

export interface InventoryEntry {
  readonly path: string;
  readonly kind: EntryKind;
  readonly status: EntryStatus;
  readonly encoding: TextEncoding;
  readonly eol: Eol;
  readonly bytes: number;
  readonly lines: number | null;
  readonly gitMode: string;
  readonly gitBlobSha: string | null;
  readonly sha256: string;
  readonly casKey: string | null;
  readonly links: ExternalLink[];
}

export interface InventoryTotals {
  readonly files: number;
  readonly text: number;
  readonly binary: number;
  readonly symlink: number;
  readonly gitlink: number;
  readonly bytes: number;
  readonly lines: number;
  readonly links: number;
}

export interface Inventory {
  readonly schema: typeof MIGRATION_SCHEMA_VERSION;
  readonly sourceLabel: string;
  readonly branch: string;
  readonly commit: string;
  readonly commitShort: string;
  readonly clean: boolean;
  readonly generatedAtUtc: string;
  readonly batchId: string;
  readonly entries: InventoryEntry[];
  readonly totals: InventoryTotals;
}

export type RelationKind = "derived_from" | "references" | "supersedes" | "related_to";

export interface Relation {
  readonly from: string;
  readonly to: string;
  readonly kind: RelationKind;
  readonly note?: string;
}

export interface ManifestFile extends InventoryEntry {
  /** Hash efetivamente escrito no CAS do export (pode diferir se houve redação). */
  readonly exportedSha256?: string;
  readonly redacted?: boolean;
}

export interface StagingManifest {
  readonly schema: typeof MIGRATION_SCHEMA_VERSION;
  readonly sourceLabel: string;
  readonly branch: string;
  readonly commit: string;
  readonly commitShort: string;
  readonly clean: boolean;
  readonly generatedAtUtc: string;
  readonly batchId: string;
  readonly totals: InventoryTotals;
  readonly files: ManifestFile[];
  readonly relations: Relation[];
  readonly curationIds: string[];
  readonly manifestHash: string;
}

export interface StageOptions {
  readonly sourceLabel?: string;
  readonly git?: GitPort;
  readonly now?: () => Date;
  readonly onProgress?: (progress: { done: number; total: number; path: string }) => void;
}

export interface StageResult {
  readonly batchId: string;
  readonly manifestPath: string;
  readonly casDir: string;
  readonly added: number;
  readonly reused: number;
  readonly resumed: boolean;
  readonly totals: InventoryTotals;
}

export class MigrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

// ---------------------------------------------------------------------------
// Utilitários de caminho, bytes e hash
// ---------------------------------------------------------------------------

/** Junta segmentos usando "/" (aceito pelo Deno no Windows). */
export function joinPath(...parts: string[]): string {
  const cleaned = parts
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "")
    );
  return cleaned.join("/");
}

/** Diretório pai de um caminho em estilo posix. */
export function dirname(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index);
}

// ---------------------------------------------------------------------------
// Validação estrita (manifestos e exports são entradas não confiáveis)
// ---------------------------------------------------------------------------

const SHA256_RE = /^[0-9a-f]{64}$/;
const BATCH_ID_RE = /^[0-9a-f]{32}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Verdadeiro para um `sha256` em hexadecimal minúsculo. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

/** Verdadeiro para um `batchId` estável (32 hex). */
export function isBatchId(value: unknown): value is string {
  return typeof value === "string" && BATCH_ID_RE.test(value);
}

/**
 * Aceita apenas caminhos relativos posix sem traversal: nada de absolutos,
 * letras de unidade, barras invertidas, NUL, segmentos vazios, `.` ou `..`.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.includes("\u0000")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

const ENTRY_KINDS = new Set(["text", "binary", "symlink", "gitlink"]);
const RELATION_KINDS = new Set(["derived_from", "references", "supersedes", "related_to"]);

/** Problemas estruturais de um manifesto; lista vazia significa válido. */
export function validateManifest(manifest: StagingManifest): string[] {
  const problems: string[] = [];
  if (manifest?.schema !== MIGRATION_SCHEMA_VERSION) problems.push("schema inválido");
  if (!isBatchId(manifest?.batchId)) problems.push("batchId inválido");
  if (typeof manifest?.commit !== "string" || !COMMIT_RE.test(manifest.commit)) {
    problems.push("commit inválido");
  }
  if (typeof manifest?.branch !== "string") problems.push("branch inválido");
  if (!isSha256Hex(manifest?.manifestHash)) problems.push("manifestHash inválido");
  if (!Array.isArray(manifest?.files)) {
    problems.push("files inválido");
    return problems;
  }
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file?.path)) problems.push(`path inválido: ${String(file?.path)}`);
    if (!ENTRY_KINDS.has(file?.kind)) problems.push(`kind inválido: ${String(file?.path)}`);
    if (file?.casKey !== null && !isSha256Hex(file?.casKey)) {
      problems.push(`casKey inválido: ${String(file?.path)}`);
    }
    if (file?.kind !== "gitlink" && !isSha256Hex(file?.sha256)) {
      problems.push(`sha256 inválido: ${String(file?.path)}`);
    }
    if (file?.exportedSha256 !== undefined && !isSha256Hex(file.exportedSha256)) {
      problems.push(`exportedSha256 inválido: ${String(file?.path)}`);
    }
  }
  for (const relation of Array.isArray(manifest?.relations) ? manifest.relations : []) {
    if (typeof relation?.from !== "string" || !isSafeRelativePath(relation?.to)) {
      problems.push("relação inválida");
    }
    if (!RELATION_KINDS.has(relation?.kind)) problems.push("tipo de relação inválido");
  }
  return problems;
}

export function assertValidManifest(manifest: StagingManifest): void {
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    throw new MigrationError("invalid_manifest", problems.join("; "));
  }
}

/** Problemas estruturais de um inventário; lista vazia significa válido. */
export function validateInventory(inventory: Inventory): string[] {
  const problems: string[] = [];
  if (inventory?.schema !== MIGRATION_SCHEMA_VERSION) problems.push("schema inválido");
  if (!isBatchId(inventory?.batchId)) problems.push("batchId inválido");
  if (typeof inventory?.commit !== "string" || !COMMIT_RE.test(inventory.commit)) {
    problems.push("commit inválido");
  }
  if (!Array.isArray(inventory?.entries)) {
    problems.push("entries inválido");
    return problems;
  }
  for (const entry of inventory.entries) {
    if (!isSafeRelativePath(entry?.path)) problems.push(`path inválido: ${String(entry?.path)}`);
    if (entry?.casKey !== null && !isSha256Hex(entry?.casKey)) {
      problems.push(`casKey inválido: ${String(entry?.path)}`);
    }
  }
  return problems;
}

export function assertValidInventory(inventory: Inventory): void {
  const problems = validateInventory(inventory);
  if (problems.length > 0) {
    throw new MigrationError("invalid_inventory", problems.join("; "));
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Copia bytes para um ArrayBuffer próprio, aceito por `crypto.subtle.digest`. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return copy.buffer;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  return toHex(new Uint8Array(digest));
}

/** Identificador de blob do Git (sha1 de "blob <n>\0" + conteúdo). */
export async function gitBlobId(data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.length}\u0000`);
  const buffer = new Uint8Array(header.length + data.length);
  buffer.set(header, 0);
  buffer.set(data, header.length);
  const digest = await crypto.subtle.digest("SHA-1", toArrayBuffer(buffer));
  return toHex(new Uint8Array(digest));
}

export interface TextInfo {
  readonly text: string | null;
  readonly encoding: TextEncoding;
  readonly eol: Eol;
  readonly lines: number | null;
}

function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf + lf + cr === 0) return "none";
  if (crlf > 0 && lf === 0 && cr === 0) return "crlf";
  if (lf > 0 && crlf === 0 && cr === 0) return "lf";
  return "mixed";
}

/** Divide em linhas preservando conteúdo, sem terminadores. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Detecta se os bytes são texto e devolve codificação, EOL e contagem de linhas. */
export function analyzeText(bytes: Uint8Array): TextInfo {
  const binary: TextInfo = { text: null, encoding: "binary", eol: "none", lines: null };
  if (bytes.length === 0) return { text: "", encoding: "utf-8", eol: "none", lines: 0 };

  let text: string;
  let encoding: TextEncoding;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8-bom";
    const body = bytes.subarray(3);
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return binary;
    }
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    try {
      text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    } catch {
      return binary;
    }
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    try {
      text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    } catch {
      return binary;
    }
  } else {
    // NUL sem BOM conhecido indica binário.
    if (bytes.includes(0)) return binary;
    encoding = "utf-8";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return binary;
    }
  }

  const lines = text.length === 0 ? 0 : splitLines(text).length;
  return { text, encoding, eol: detectEol(text), lines };
}

const URL_RE = /https?:\/\/[^\s<>"'`\)\]\}]+/g;

/** Extrai URLs absolutas http(s) e agrega por valor. */
export function extractLinks(text: string): ExternalLink[] {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Localiza um trecho no texto e devolve o intervalo de linhas (1-based).
 * Retorna `null` quando o trecho não é encontrado.
 */
export function findLineRange(text: string, excerpt: string): LineRange | null {
  if (excerpt.length === 0) return null;
  const index = text.indexOf(excerpt);
  if (index < 0) return null;
  const start = (text.slice(0, index).match(/\r\n|\r|\n/g) ?? []).length + 1;
  const spans = (excerpt.match(/\r\n|\r|\n/g) ?? []).length;
  return { start, end: start + spans };
}

// ---------------------------------------------------------------------------
// JSON canônico e hashing de manifesto
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function hashManifest(
  manifest: Omit<StagingManifest, "manifestHash"> | StagingManifest,
): Promise<string> {
  const { manifestHash: _ignored, ...rest } = manifest as StagingManifest;
  return await sha256Hex(new TextEncoder().encode(canonicalJson(rest)));
}

// ---------------------------------------------------------------------------
// Porta Git padrão
// ---------------------------------------------------------------------------

async function runGit(source: string, args: string[]): Promise<Uint8Array> {
  const command = new Deno.Command("git", {
    args: ["-C", source, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    const message = new TextDecoder().decode(stderr).trim();
    throw new MigrationError("git_failed", `git ${args.join(" ")} falhou: ${message}`);
  }
  return stdout;
}

/** Porta que executa o binário `git` (requer --allow-run=git). */
export function systemGitPort(): GitPort {
  return {
    async head(source) {
      const commit = new TextDecoder().decode(await runGit(source, ["rev-parse", "HEAD"])).trim();
      const branch = new TextDecoder().decode(
        await runGit(source, ["rev-parse", "--abbrev-ref", "HEAD"]),
      ).trim();
      return { commit, branch };
    },
    async tree(source, commit) {
      const raw = await runGit(source, ["ls-tree", "-r", "-l", "-z", commit]);
      const text = new TextDecoder().decode(raw);
      const entries: GitTreeEntry[] = [];
      for (const record of text.split("\u0000")) {
        if (record.length === 0) continue;
        const tab = record.indexOf("\t");
        if (tab < 0) continue;
        const meta = record.slice(0, tab).split(/\s+/);
        const path = record.slice(tab + 1);
        const size = Number.parseInt(meta[3] ?? "-1", 10);
        entries.push({
          path,
          mode: meta[0],
          type: meta[1] as GitTreeEntry["type"],
          sha: meta[2],
          size: Number.isNaN(size) ? -1 : size,
        });
      }
      return entries;
    },
    blob(source, sha) {
      return runGit(source, ["cat-file", "blob", sha]);
    },
    async isClean(source) {
      const raw = await runGit(source, ["status", "--porcelain", "-uno"]);
      return new TextDecoder().decode(raw).trim().length === 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Inventário
// ---------------------------------------------------------------------------

async function buildEntry(
  source: string,
  entry: GitTreeEntry,
  git: GitPort,
): Promise<InventoryEntry> {
  if (entry.type === "commit" || entry.mode === "160000") {
    return {
      path: entry.path,
      kind: "gitlink",
      status: "complete",
      encoding: "binary",
      eol: "none",
      bytes: 0,
      lines: null,
      gitMode: entry.mode,
      gitBlobSha: entry.sha,
      sha256: "",
      casKey: null,
      links: [],
    };
  }

  const bytes = await git.blob(source, entry.sha);
  const sha256 = await sha256Hex(bytes);
  const info = analyzeText(bytes);
  const isSymlink = entry.mode === "120000";
  return {
    path: entry.path,
    kind: isSymlink ? "symlink" : info.encoding === "binary" ? "binary" : "text",
    status: "complete",
    encoding: info.encoding,
    eol: info.eol,
    bytes: bytes.length,
    lines: info.lines,
    gitMode: entry.mode,
    gitBlobSha: entry.sha,
    sha256,
    casKey: sha256,
    links: info.text ? extractLinks(info.text) : [],
  };
}

function computeTotals(entries: InventoryEntry[]): InventoryTotals {
  return {
    files: entries.length,
    text: entries.filter((entry) => entry.kind === "text").length,
    binary: entries.filter((entry) => entry.kind === "binary").length,
    symlink: entries.filter((entry) => entry.kind === "symlink").length,
    gitlink: entries.filter((entry) => entry.kind === "gitlink").length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    lines: entries.reduce((sum, entry) => sum + (entry.lines ?? 0), 0),
    links: entries.reduce((sum, entry) => sum + entry.links.length, 0),
  };
}

/** Chave estável do lote: mesmo commit + mesma árvore ⇒ mesmo batchId. */
export async function computeBatchId(commit: string, entries: InventoryEntry[]): Promise<string> {
  const fingerprint = entries
    .map((entry) => `${entry.gitMode}\t${entry.path}\t${entry.gitBlobSha ?? "-"}\t${entry.sha256}`)
    .sort()
    .join("\n");
  const digest = await sha256Hex(new TextEncoder().encode(`${commit}\n${fingerprint}`));
  return digest.slice(0, 32);
}

/** Lê a origem e monta o inventário, sem escrever nada. */
export async function loadInventory(
  source: string,
  options: StageOptions = {},
): Promise<Inventory> {
  const git = options.git ?? systemGitPort();
  const now = options.now ?? (() => new Date());
  const { commit, branch } = await git.head(source);
  const clean = await git.isClean(source);
  const tree = (await git.tree(source, commit)).filter((entry) => entry.type !== "tree");
  const entries: InventoryEntry[] = [];
  const ordered = [...tree].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of ordered) entries.push(await buildEntry(source, entry, git));
  return {
    schema: MIGRATION_SCHEMA_VERSION,
    sourceLabel: options.sourceLabel ?? "source",
    branch,
    commit,
    commitShort: commit.slice(0, 12),
    clean,
    generatedAtUtc: now().toISOString(),
    batchId: await computeBatchId(commit, entries),
    entries,
    totals: computeTotals(entries),
  };
}

// ---------------------------------------------------------------------------
// Redação de segredos
// ---------------------------------------------------------------------------

export const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)credentials[^/]*\.json$/i,
  /(^|\/)client_secret[^/]*\.json$/i,
  /(^|\/)service-account[^/]*\.json$/i,
];

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?<=(?:api[_-]?key|secret|token|password|passwd|senha)["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-.]{16,}/gi,
];

export function isSecretPath(path: string): boolean {
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export interface RedactionResult {
  readonly text: string;
  readonly hits: number;
}

/** Substitui valores com forma de segredo por marcador. */
export function redactSecrets(text: string): RedactionResult {
  let hits = 0;
  let output = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, () => {
      hits += 1;
      return "[REDACTED]";
    });
  }
  return { text: output, hits };
}

// ---------------------------------------------------------------------------
// CAS local
// ---------------------------------------------------------------------------

export function casPath(casDir: string, key: string): string {
  if (!isSha256Hex(key)) {
    throw new MigrationError("invalid_cas_key", `chave CAS inválida: ${String(key)}`);
  }
  return joinPath(casDir, key.slice(0, 2), key);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export type CasWriteOutcome = "written" | "reused" | "repaired";

/**
 * Cria o objeto de forma atômica (`createNew`) e confere a integridade.
 * Se já existir com o conteúdo esperado, reutiliza; se estiver corrompido por
 * uma escrita interrompida, substitui por rename atômico.
 */
async function writeBytesVerified(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<CasWriteOutcome> {
  await Deno.mkdir(dirname(path), { recursive: true });
  try {
    await Deno.writeFile(path, bytes, { createNew: true });
    return "written";
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const existing = await Deno.readFile(path);
  if ((await sha256Hex(existing)) === expectedSha256) return "reused";
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, path);
  return "repaired";
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(tmp, path);
}

export async function readJson<T>(path: string): Promise<T> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface ProgressState {
  readonly batchId: string;
  readonly sourceLabel: string;
  readonly done: string[];
  readonly updatedAtUtc: string;
}

export function progressPath(destination: string, batchId: string): string {
  if (!isBatchId(batchId)) {
    throw new MigrationError("invalid_batch_id", `batchId inválido: ${String(batchId)}`);
  }
  return joinPath(destination, "state", `${batchId}.progress.json`);
}

/**
 * Executa o staging de uma origem para um destino local.
 *
 * - Escreve `inventory.json`, `manifest.json` e o CAS em `cas/<aa>/<sha256>`.
 * - Reexecutar o mesmo commit reutiliza objetos (idempotente).
 * - Um lote interrompido é retomado pelo arquivo de progresso.
 */
export async function stageRepository(
  source: string,
  destination: string,
  options: StageOptions = {},
): Promise<StageResult> {
  const inventory = await loadInventory(source, options);
  assertValidInventory(inventory);
  const git = options.git ?? systemGitPort();
  const casDir = joinPath(destination, "cas");
  const statePath = progressPath(destination, inventory.batchId);

  let done = new Set<string>();
  let resumed = false;
  if (await exists(statePath)) {
    try {
      const state = await readJson<ProgressState>(statePath);
      if (state.batchId === inventory.batchId) {
        done = new Set(state.done);
        resumed = done.size > 0;
      }
    } catch {
      done = new Set();
    }
  }

  let added = 0;
  let reused = 0;
  const total = inventory.entries.filter((entry) => entry.casKey).length;
  let processed = 0;
  for (const entry of inventory.entries) {
    if (!entry.casKey || entry.kind === "gitlink") continue;
    const target = casPath(casDir, entry.casKey);
    const bytes = await git.blob(source, entry.gitBlobSha as string);
    const outcome = await writeBytesVerified(target, bytes, entry.sha256);
    if (outcome === "reused") reused += 1;
    else added += 1;
    done.add(entry.path);
    processed += 1;
    options.onProgress?.({ done: processed, total, path: entry.path });
  }

  await writeJsonAtomic(
    statePath,
    {
      batchId: inventory.batchId,
      sourceLabel: inventory.sourceLabel,
      done: [...done].sort(),
      updatedAtUtc: inventory.generatedAtUtc,
    } satisfies ProgressState,
  );

  const curationIds = await listCurationIds(destination);
  const knownPaths = new Set(inventory.entries.map((entry) => entry.path));
  const relations = (await collectCurationRelations(destination)).filter((relation) =>
    knownPaths.has(relation.to)
  );
  const baseManifest: Omit<StagingManifest, "manifestHash"> = {
    schema: MIGRATION_SCHEMA_VERSION,
    sourceLabel: inventory.sourceLabel,
    branch: inventory.branch,
    commit: inventory.commit,
    commitShort: inventory.commitShort,
    clean: inventory.clean,
    generatedAtUtc: inventory.generatedAtUtc,
    batchId: inventory.batchId,
    totals: inventory.totals,
    files: inventory.entries,
    relations,
    curationIds,
  };
  const manifest: StagingManifest = {
    ...baseManifest,
    manifestHash: await hashManifest(baseManifest),
  };

  await writeJsonAtomic(joinPath(destination, "inventory.json"), inventory);
  await writeJsonAtomic(joinPath(destination, "manifest.json"), manifest);

  return {
    batchId: inventory.batchId,
    manifestPath: joinPath(destination, "manifest.json"),
    casDir,
    added,
    reused,
    resumed,
    totals: inventory.totals,
  };
}

// ---------------------------------------------------------------------------
// Curadoria
// ---------------------------------------------------------------------------

export type CurationKind =
  | "fact"
  | "reported"
  | "inferred"
  | "unknown"
  | "preference"
  | "argument"
  | "state"
  | "version"
  | "source_note";

export type Epistemic = "observed" | "reported" | "inferred" | "unknown";
export type DatePrecision = "day" | "month" | "range" | "year" | "vague" | "none";

export interface CuratedDate {
  readonly value: string;
  readonly precision: DatePrecision;
  readonly timezone?: string;
  readonly note?: string;
}

export interface CuratedReference {
  readonly path: string;
  readonly commit: string;
  readonly lines: string;
  readonly excerpt: string;
}

export interface CuratedVersion {
  readonly label: string;
  readonly status:
    | "draft"
    | "proposed"
    | "approved_by_owner"
    | "published"
    | "submitted"
    | "verified";
  readonly note?: string;
}

export interface CurationRecord {
  readonly id: string;
  readonly domain: string;
  readonly kind: CurationKind;
  readonly epistemic: Epistemic;
  readonly assertion: string;
  readonly date?: CuratedDate;
  readonly versions?: CuratedVersion[];
  readonly scope?: Record<string, string>;
  readonly refs: CuratedReference[];
}

export interface CurationPayload {
  readonly schema: typeof MIGRATION_SCHEMA_VERSION;
  readonly batchId: string;
  readonly commit: string;
  readonly generatedAtUtc: string;
  readonly records: CurationRecord[];
  readonly notes?: string[];
}

export function validateCurationRecord(record: CurationRecord): string[] {
  const problems: string[] = [];
  if (!record.id) problems.push("id ausente");
  if (!record.assertion) problems.push(`${record.id}: assertion ausente`);
  if (!record.refs || record.refs.length === 0) {
    problems.push(`${record.id}: sem referências de origem`);
  }
  for (const ref of record.refs ?? []) {
    if (!ref.path || !ref.lines || !ref.excerpt) {
      problems.push(`${record.id}: referência incompleta`);
    }
  }
  return problems;
}

export async function writeCuration(
  destination: string,
  payload: CurationPayload,
): Promise<string> {
  const problems = payload.records.flatMap(validateCurationRecord);
  if (problems.length > 0) {
    throw new MigrationError("invalid_curation", problems.join("; "));
  }
  const path = joinPath(destination, "curation", `${payload.batchId}.json`);
  await writeJsonAtomic(path, payload);
  return path;
}

export async function loadCuration(destination: string): Promise<CurationPayload[]> {
  const dir = joinPath(destination, "curation");
  const payloads: CurationPayload[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      payloads.push(await readJson<CurationPayload>(joinPath(dir, entry.name)));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return payloads.sort((a, b) => a.batchId.localeCompare(b.batchId));
}

async function listCurationIds(destination: string): Promise<string[]> {
  const payloads = await loadCuration(destination);
  return payloads.flatMap((payload) => payload.records.map((record) => record.id)).sort();
}

export async function collectCurationRelations(destination: string): Promise<Relation[]> {
  const payloads = await loadCuration(destination);
  const relations: Relation[] = [];
  for (const payload of payloads) {
    for (const record of payload.records) {
      for (const ref of record.refs) {
        relations.push({ from: record.id, to: ref.path, kind: "derived_from" });
      }
    }
  }
  return relations.sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
}

// ---------------------------------------------------------------------------
// Verificação
// ---------------------------------------------------------------------------

export interface VerifyIssue {
  readonly code: string;
  readonly detail: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly batchId: string;
  readonly checked: number;
  readonly missing: number;
  readonly corrupted: number;
  readonly blobMismatch: number;
  readonly extra: number;
  readonly relationsOk: boolean;
  readonly manifestHashOk: boolean;
  readonly issues: VerifyIssue[];
}

export async function verifyStaging(destination: string): Promise<VerifyResult> {
  const manifest = await readJson<StagingManifest>(joinPath(destination, "manifest.json"));
  assertValidManifest(manifest);
  const issues: VerifyIssue[] = [];
  const casDir = joinPath(destination, "cas");
  let checked = 0;
  let missing = 0;
  let corrupted = 0;
  let blobMismatch = 0;

  for (const file of manifest.files) {
    if (!file.casKey || file.kind === "gitlink") continue;
    checked += 1;
    const expected = file.exportedSha256 ?? file.sha256;
    const target = casPath(casDir, file.casKey);
    if (!(await exists(target))) {
      missing += 1;
      issues.push({ code: "missing_cas", detail: file.path });
      continue;
    }
    const bytes = await Deno.readFile(target);
    const actual = await sha256Hex(bytes);
    if (actual !== expected) {
      corrupted += 1;
      issues.push({ code: "corrupted_cas", detail: file.path });
    }
    if (file.gitBlobSha && !file.redacted) {
      const blobId = await gitBlobId(bytes);
      if (blobId !== file.gitBlobSha) {
        blobMismatch += 1;
        issues.push({ code: "blob_mismatch", detail: file.path });
      }
    }
  }

  const known = new Set(
    manifest.files.filter((file) => file.casKey).map((file) => file.casKey as string),
  );
  let extra = 0;
  try {
    for await (const shard of Deno.readDir(casDir)) {
      if (!shard.isDirectory) continue;
      for await (const object of Deno.readDir(joinPath(casDir, shard.name))) {
        if (!object.isFile) continue;
        // Objetos de outros lotes no mesmo CAS são legítimos: contam-se como
        // `extra`, sem serem tratados como corrupção nem entrarem em `ok`.
        if (!known.has(object.name)) extra += 1;
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const paths = new Set(manifest.files.map((file) => file.path));
  let relationsOk = true;
  for (const relation of manifest.relations) {
    if (!paths.has(relation.to)) {
      relationsOk = false;
      issues.push({ code: "dangling_relation", detail: `${relation.from} -> ${relation.to}` });
    }
  }

  const { manifestHash: _ignored, ...rest } = manifest;
  const manifestHashOk = (await hashManifest(rest)) === manifest.manifestHash;
  if (!manifestHashOk) issues.push({ code: "manifest_hash", detail: manifest.batchId });

  return {
    ok: missing === 0 && corrupted === 0 && blobMismatch === 0 && relationsOk && manifestHashOk,
    batchId: manifest.batchId,
    checked,
    missing,
    corrupted,
    blobMismatch,
    extra,
    relationsOk,
    manifestHashOk,
    issues,
  };
}

export interface OriginCheck {
  readonly recordedCommit: string;
  readonly recordedBranch: string;
  readonly currentCommit: string | null;
  readonly currentBranch: string | null;
  readonly changed: boolean;
  readonly clean: boolean | null;
  readonly note: string;
}

/** Confere se a origem mudou desde o último staging. */
export async function verifyOrigin(
  destination: string,
  source: string,
  options: { git?: GitPort } = {},
): Promise<OriginCheck> {
  const manifest = await readJson<StagingManifest>(joinPath(destination, "manifest.json"));
  assertValidManifest(manifest);
  const git = options.git ?? systemGitPort();
  try {
    const { commit, branch } = await git.head(source);
    const clean = await git.isClean(source);
    const changed = commit !== manifest.commit;
    return {
      recordedCommit: manifest.commit,
      recordedBranch: manifest.branch,
      currentCommit: commit,
      currentBranch: branch,
      changed,
      clean,
      note: changed
        ? "origem avançou; reconciliar delta antes do corte"
        : "origem inalterada no commit registrado",
    };
  } catch (error) {
    return {
      recordedCommit: manifest.commit,
      recordedBranch: manifest.branch,
      currentCommit: null,
      currentBranch: null,
      changed: false,
      clean: null,
      note: `origem indisponível: ${(error as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Exportação e restauração
// ---------------------------------------------------------------------------

export interface ExportResult {
  readonly exportDir: string;
  readonly batchId: string;
  readonly files: number;
  readonly bytes: number;
  readonly excluded: number;
  readonly redactedFiles: number;
  readonly redactions: number;
}

/**
 * Exporta um lote privado com manifesto, hashes e relações.
 * Arquivos com nome sensível são excluídos e o conteúdo textual é redigido.
 */
export async function exportStaging(destination: string, exportDir: string): Promise<ExportResult> {
  const manifest = await readJson<StagingManifest>(joinPath(destination, "manifest.json"));
  assertValidManifest(manifest);
  const inventory = await readJson<Inventory>(joinPath(destination, "inventory.json"));
  assertValidInventory(inventory);
  if (inventory.batchId !== manifest.batchId) {
    throw new MigrationError("batch_mismatch", "inventário e manifesto divergem no lote");
  }
  const casDir = joinPath(destination, "cas");
  const exportCas = joinPath(exportDir, "cas");

  const files: ManifestFile[] = [];
  let excluded = 0;
  let redactedFiles = 0;
  let redactions = 0;
  let bytes = 0;
  const relations = manifest.relations.filter((relation) => {
    const file = manifest.files.find((entry) => entry.path === relation.to);
    if (!file) return false;
    if (isSecretPath(file.path)) return false;
    return true;
  });

  for (const file of manifest.files) {
    if (isSecretPath(file.path)) {
      excluded += 1;
      continue;
    }
    if (!file.casKey || file.kind === "gitlink") {
      files.push({ ...file });
      continue;
    }
    const raw = await Deno.readFile(casPath(casDir, file.casKey));
    let exported = raw;
    let redacted = false;
    if (file.kind === "text" || file.kind === "symlink") {
      const decoded = new TextDecoder("utf-8").decode(raw);
      const result = redactSecrets(decoded);
      if (result.hits > 0) {
        exported = new TextEncoder().encode(result.text);
        redacted = true;
        redactedFiles += 1;
        redactions += result.hits;
      }
    }
    const target = casPath(exportCas, file.casKey);
    const exportedSha256 = await sha256Hex(exported);
    await writeBytesVerified(target, exported, exportedSha256);
    bytes += exported.length;
    files.push(
      redacted ? { ...file, redacted: true, exportedSha256 } : { ...file },
    );
  }

  const base: Omit<StagingManifest, "manifestHash"> = {
    ...manifest,
    files,
    relations,
  };
  const exportManifest: StagingManifest = { ...base, manifestHash: await hashManifest(base) };

  await writeJsonAtomic(joinPath(exportDir, "manifest.json"), exportManifest);
  await writeJsonAtomic(joinPath(exportDir, "inventory.json"), {
    ...inventory,
    entries: inventory.entries.filter((entry) => !isSecretPath(entry.path)),
  });

  const curationDir = joinPath(destination, "curation");
  try {
    for await (const entry of Deno.readDir(curationDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const payload = await readJson<CurationPayload>(joinPath(curationDir, entry.name));
      const records = payload.records.map((record) => {
        const result = redactSecrets(JSON.stringify(record));
        if (result.hits > 0) redactions += result.hits;
        return JSON.parse(result.text) as CurationRecord;
      });
      await writeJsonAtomic(joinPath(exportDir, "curation", entry.name), { ...payload, records });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  await Deno.writeTextFile(
    joinPath(exportDir, "RESTORE.md"),
    [
      "# Lote de migração privado",
      "",
      "Restaurar com `deno task migration:stage -- restore --in <este diretório> --to <destino>`.",
      "O destino é verificado automaticamente após a restauração.",
      "Arquivos com nome sensível foram excluídos; valores com forma de segredo",
      "foram redigidos e registrados em `exportedSha256`.",
      "",
    ].join("\n"),
  );

  await writeJsonAtomic(joinPath(exportDir, "export-report.json"), {
    schema: MIGRATION_SCHEMA_VERSION,
    batchId: manifest.batchId,
    files: files.length,
    bytes,
    excluded,
    redactedFiles,
    redactions,
  });

  return {
    exportDir,
    batchId: manifest.batchId,
    files: files.length,
    bytes,
    excluded,
    redactedFiles,
    redactions,
  };
}

export interface RestoreResult {
  readonly batchId: string;
  readonly files: number;
  readonly written: number;
  readonly reused: number;
  readonly repaired: number;
  readonly verify: VerifyResult;
}

export interface RestoreOptions {
  /** Origem Git para reconferir o commit antes de escrever. */
  readonly source?: string;
  readonly git?: GitPort;
  /** Permite restaurar mesmo que a origem tenha avançado. */
  readonly allowOriginChange?: boolean;
  /** Exige um lote específico. */
  readonly expectedBatchId?: string;
}

async function readDestinationManifest(destination: string): Promise<StagingManifest | null> {
  try {
    const manifest = await readJson<StagingManifest>(joinPath(destination, "manifest.json"));
    assertValidManifest(manifest);
    return manifest;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/**
 * Restaura um export em um destino local e verifica a integridade.
 *
 * - Valida manifesto/inventário e o `manifestHash` antes de ler ou escrever.
 * - Confere o `sha256` de cada objeto do export antes de copiá-lo.
 * - Recusa um destino que já contenha outro lote (colisão não sobrescreve).
 * - Reutiliza objetos idênticos e repara escritas interrompidas.
 */
export async function restoreStaging(
  exportDir: string,
  destination: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const manifest = await readJson<StagingManifest>(joinPath(exportDir, "manifest.json"));
  assertValidManifest(manifest);
  const { manifestHash: _ignored, ...rest } = manifest;
  if ((await hashManifest(rest)) !== manifest.manifestHash) {
    throw new MigrationError("manifest_hash_mismatch", "manifesto do export não confere");
  }
  if (options.expectedBatchId !== undefined && options.expectedBatchId !== manifest.batchId) {
    throw new MigrationError("batch_mismatch", "lote do export difere do esperado");
  }
  if (options.source) {
    const git = options.git ?? systemGitPort();
    const { commit } = await git.head(options.source);
    if (commit !== manifest.commit && options.allowOriginChange !== true) {
      throw new MigrationError(
        "origin_changed",
        "origem mudou desde o lote; reconfirme antes de restaurar",
      );
    }
  }

  const inventory = await readJson<Inventory>(joinPath(exportDir, "inventory.json"));
  assertValidInventory(inventory);
  if (inventory.batchId !== manifest.batchId) {
    throw new MigrationError("batch_mismatch", "inventário do export difere do manifesto");
  }

  const existing = await readDestinationManifest(destination);
  if (existing && existing.batchId !== manifest.batchId) {
    throw new MigrationError(
      "destination_batch_mismatch",
      "o destino já contém outro lote; use um destino vazio ou o lote correspondente",
    );
  }

  const sourceCas = joinPath(exportDir, "cas");
  const targetCas = joinPath(destination, "cas");

  let files = 0;
  let written = 0;
  let reused = 0;
  let repaired = 0;

  // Passagem 1: confere existência e hash de todos os objetos do export antes
  // de escrever qualquer byte no destino.
  const objects: { casKey: string; bytes: Uint8Array; expected: string }[] = [];
  for (const file of manifest.files) {
    if (!file.casKey || file.kind === "gitlink") continue;
    const source = casPath(sourceCas, file.casKey);
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(source);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new MigrationError("restore_missing", `objeto ausente no export: ${file.casKey}`);
      }
      throw error;
    }
    const expected = file.exportedSha256 ?? file.sha256;
    if ((await sha256Hex(bytes)) !== expected) {
      throw new MigrationError(
        "export_object_mismatch",
        `objeto do export não confere: ${file.path}`,
      );
    }
    objects.push({ casKey: file.casKey, bytes, expected });
  }

  // Passagem 2: escreve/reutiliza/repara os objetos no destino.
  for (const object of objects) {
    const outcome = await writeBytesVerified(
      casPath(targetCas, object.casKey),
      object.bytes,
      object.expected,
    );
    if (outcome === "written") written += 1;
    else if (outcome === "reused") reused += 1;
    else repaired += 1;
    files += 1;
  }

  await writeJsonAtomic(joinPath(destination, "inventory.json"), inventory);
  await writeJsonAtomic(joinPath(destination, "manifest.json"), manifest);

  const curationDir = joinPath(exportDir, "curation");
  try {
    for await (const entry of Deno.readDir(curationDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const payload = await readJson<CurationPayload>(joinPath(curationDir, entry.name));
      if (payload.batchId !== manifest.batchId) {
        throw new MigrationError("batch_mismatch", `curadoria de outro lote: ${entry.name}`);
      }
      await writeJsonAtomic(joinPath(destination, "curation", entry.name), payload);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  await writeJsonAtomic(
    progressPath(destination, manifest.batchId),
    {
      batchId: manifest.batchId,
      sourceLabel: manifest.sourceLabel,
      done: manifest.files.map((file) => file.path).sort(),
      updatedAtUtc: new Date().toISOString(),
    } satisfies ProgressState,
  );

  return {
    batchId: manifest.batchId,
    files,
    written,
    reused,
    repaired,
    verify: await verifyStaging(destination),
  };
}
