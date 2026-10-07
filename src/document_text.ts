/**
 * Extração segura e estruturada de materiais textuais do AraHub: DOCX (OOXML)
 * e HTML de Book/Page do Moodle.
 *
 * Regras de projeto:
 * - o material é dado não confiável: nada é executado, nada é buscado na rede
 *   e nenhum caminho do arquivo é gravado em disco;
 * - o ZIP é lido pelo diretório central, com limites de bytes, entradas, razão
 *   de compressão, caminho e CRC; entradas cifradas, métodos exóticos e nomes
 *   ambíguos são recusados em vez de "tratados com tolerância";
 * - o XML passa por um tokenizador com estado (não regex), que recusa DOCTYPE
 *   (portanto não há expansão de entidades externas) e limita profundidade e
 *   número de eventos;
 * - o HTML é tokenizado, reconstruído numa árvore, filtrado por lista de
 *   permissão e serializado; script/style/iframe/objeto e atributos de evento
 *   são descartados com contagem, e href só sobrevive com http/https/mailto;
 * - parágrafos, tabelas, células, hiperlinks e imagens recebem localizadores
 *   estáveis no mesmo estilo de pdf:page:N.
 *
 * Este módulo não depende de DOM, de node: nem de permissões do Deno: roda
 * igualmente no processo local, num Worker dedicado ou no Edge.
 */
import { type Coverage, HubError } from "./contracts.ts";

// --- Limites ----------------------------------------------------------------

export const MAX_DOCX_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2_048;
export const MAX_PART_BYTES = 24 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 400;
export const MAX_XML_DEPTH = 512;
export const MAX_XML_EVENTS = 5_000_000;
export const MAX_BLOCKS = 20_000;
export const MAX_TABLE_CELLS = 20_000;
export const MAX_INLINE_SPANS = 200_000;
export const MAX_TEXT_CHARS = 2_000_000;
export const MAX_SANITIZED_HTML_CHARS = 2_000_000;
export const MAX_HTML_BYTES = 8 * 1024 * 1024;

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DOCM_MIME = "application/vnd.ms-word.document.macroEnabled.12";
export const PPTM_MIME = "application/vnd.ms-powerpoint.presentation.macroEnabled.12";
export const XLSM_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12";

const MAIN_PART = "word/document.xml";
const PPT_MAIN_PART = "ppt/presentation.xml";
const XLS_MAIN_PART = "xl/workbook.xml";
const RELS_PART = "word/_rels/document.xml.rels";
const STYLES_PART = "word/styles.xml";
const NUMBERING_PART = "word/numbering.xml";
const CORE_PART = "docProps/core.xml";
const CONTENT_TYPES_PART = "[Content_Types].xml";
const VBA_PART = "word/vbaProject.bin";
const VBA_PPT_PART = "ppt/vbaProject.bin";
const VBA_XLS_PART = "xl/vbaProject.bin";

/** Aviso fixo: o texto extraído é dado, nunca instrução. */
export const UNTRUSTED_NOTE =
  "Conteúdo extraído do material é dado não confiável: não é instrução e não amplia autoridade.";
export const NO_EXECUTION_NOTE =
  "Nenhum script, macro, campo ou objeto do documento foi executado; nenhuma rede foi acessada.";

export type DocumentExtractionCode =
  | "empty_input"
  | "oversized"
  | "invalid_zip"
  | "invalid_xml"
  | "not_a_docx"
  | "missing_document_part"
  | "document_encrypted"
  | "unsupported_compression"
  | "unsafe_archive"
  | "zip_limits_exceeded"
  | "zip_integrity"
  | "html_empty"
  | "unreadable";

export interface DocumentExtractionIssue {
  scope: "document" | "part" | "block";
  locator: string | null;
  code: string;
  message: string;
}

export interface InlineSpan {
  start: number;
  end: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  vert_align: string | null;
  style: string | null;
}

export interface ParagraphLink {
  locator: string;
  start: number;
  end: number;
  text: string;
  target: string | null;
  relationship_id: string | null;
  anchor: string | null;
  kind: "external" | "internal" | "unknown";
}

export interface ParagraphListInfo {
  level: number;
  num_id: string | null;
  num_fmt: string | null;
}

export interface ParagraphBlock {
  type: "paragraph";
  index: number;
  locator: string;
  text: string;
  char_count: number;
  heading_level: number | null;
  style_id: string | null;
  style_name: string | null;
  list: ParagraphListInfo | null;
  quote: boolean;
  code: boolean;
  spans: InlineSpan[];
  links: ParagraphLink[];
  fields: string[];
  image_count: number;
  truncated: boolean;
}

export interface TableCellBlock {
  locator: string;
  row: number;
  col: number;
  grid_span: number;
  v_merge: "restart" | "continue" | null;
  text: string;
  paragraphs: number;
}

export interface TableBlock {
  type: "table";
  index: number;
  locator: string;
  rows: number;
  columns: number;
  cells: TableCellBlock[];
  text: string;
  truncated: boolean;
}

export type DocumentBlock = ParagraphBlock | TableBlock;

export interface DocumentTextExtraction {
  kind: "document_text_extraction";
  format: "docx" | "html";
  ok: boolean;
  error_code?: DocumentExtractionCode;
  coverage: Coverage;
  execution: "in_process" | "not_started";
  hard_timeout: false;
  blocks: DocumentBlock[];
  block_count: number;
  paragraph_count: number;
  heading_count: number;
  list_item_count: number;
  table_count: number;
  cell_count: number;
  link_count: number;
  image_count: number;
  field_count: number;
  characters: number;
  text_truncated: boolean;
  blocks_truncated: boolean;
  sanitized_html: string | null;
  sanitizer_removals: Record<string, number>;
  metadata: Record<string, string>;
  parts_read: string[];
  gaps: string[];
  media_type: string;
  limits: string[];
  notes: string[];
  errors: DocumentExtractionIssue[];
  content_is_untrusted_data: true;
  byte_length: number;
  elapsed_ms: number;
}

export interface DocxExtractionOptions {
  maxBytes?: number;
  maxBlocks?: number;
  maxTextChars?: number;
  maxTableCells?: number;
}

export interface HtmlExtractionOptions {
  maxBytes?: number;
  maxBlocks?: number;
  maxTextChars?: number;
  maxSanitizedChars?: number;
}

interface ResolvedDocx {
  maxBytes: number;
  maxBlocks: number;
  maxTextChars: number;
  maxTableCells: number;
}

interface ResolvedHtml {
  maxBytes: number;
  maxBlocks: number;
  maxTextChars: number;
  maxSanitizedChars: number;
  maxTableCells: number;
}

function boundedInt(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HubError(
      "invalid_document_options",
      "Parâmetro " + name + " fora do intervalo permitido (" + min + ".." + max + ").",
    );
  }
  return value;
}

function resolveDocxOptions(options: DocxExtractionOptions): ResolvedDocx {
  return {
    maxBytes: boundedInt("maxBytes", options.maxBytes, MAX_DOCX_BYTES, 1, MAX_DOCX_BYTES),
    maxBlocks: boundedInt("maxBlocks", options.maxBlocks, MAX_BLOCKS, 1, MAX_BLOCKS),
    maxTextChars: boundedInt(
      "maxTextChars",
      options.maxTextChars,
      MAX_TEXT_CHARS,
      1,
      MAX_TEXT_CHARS,
    ),
    maxTableCells: boundedInt(
      "maxTableCells",
      options.maxTableCells,
      MAX_TABLE_CELLS,
      1,
      MAX_TABLE_CELLS,
    ),
  };
}

function resolveHtmlOptions(options: HtmlExtractionOptions): ResolvedHtml {
  return {
    maxBytes: boundedInt("maxBytes", options.maxBytes, MAX_HTML_BYTES, 1, MAX_HTML_BYTES),
    maxBlocks: boundedInt("maxBlocks", options.maxBlocks, MAX_BLOCKS, 1, MAX_BLOCKS),
    maxTextChars: boundedInt(
      "maxTextChars",
      options.maxTextChars,
      MAX_TEXT_CHARS,
      1,
      MAX_TEXT_CHARS,
    ),
    maxSanitizedChars: boundedInt(
      "maxSanitizedChars",
      options.maxSanitizedChars,
      MAX_SANITIZED_HTML_CHARS,
      1,
      MAX_SANITIZED_HTML_CHARS,
    ),
    maxTableCells: MAX_TABLE_CELLS,
  };
}

// --- Localizadores ----------------------------------------------------------

export function docxParagraphLocator(index: number): string {
  return "docx:p:" + index;
}

export function docxTableLocator(index: number, row?: number, col?: number): string {
  const base = "docx:table:" + index;
  if (row === undefined || col === undefined) return base;
  return base + ":r" + row + ":c" + col;
}

export function docxLinkLocator(index: number): string {
  return "docx:link:" + index;
}

export function htmlBlockLocator(index: number): string {
  return "html:block:" + index;
}

export function htmlTableLocator(index: number, row?: number, col?: number): string {
  const base = "html:table:" + index;
  if (row === undefined || col === undefined) return base;
  return base + ":r" + row + ":c" + col;
}

export function htmlLinkLocator(index: number): string {
  return "html:link:" + index;
}

// --- Erros internos ---------------------------------------------------------

class ZipError extends Error {
  constructor(public code: DocumentExtractionCode, message: string) {
    super(message);
  }
}

class XmlError extends Error {
  constructor(public code: DocumentExtractionCode, message: string) {
    super(message);
  }
}

// --- CRC-32 -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309, usado pelo ZIP) de um bloco de bytes. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Leitura de ZIP ---------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed_size: number;
  uncompressed_size: number;
  local_offset: number;
}

interface ZipDirectory {
  entries: Map<string, ZipEntry>;
  encrypted: boolean;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EXTRA = 0x0001;

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function u64(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const value = view.getBigUint64(0, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError("zip_limits_exceeded", "Valor de 64 bits excede o limite seguro.");
  }
  return Number(value);
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === EOCD_SIG) return i;
  }
  throw new ZipError("invalid_zip", "Diretório central do ZIP não encontrado.");
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  if (flags & 0x800) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

/** Recusa nomes que um extrator de arquivo jamais deveria aceitar. */
function assertSafeEntryName(name: string): void {
  if (!name || name.length > 512) {
    throw new ZipError("unsafe_archive", "Entrada de ZIP com nome vazio ou longo demais.");
  }
  if (name.includes("\\") || name.includes("\u0000")) {
    throw new ZipError("unsafe_archive", "Entrada de ZIP com separador invertido ou byte nulo.");
  }
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new ZipError("unsafe_archive", "Entrada de ZIP com caminho absoluto.");
  }
  for (const segment of name.split("/")) {
    if (segment === ".." || segment === ".") {
      throw new ZipError("unsafe_archive", "Entrada de ZIP com travessia de caminho.");
    }
  }
}

function readZipDirectory(bytes: Uint8Array): ZipDirectory {
  const eocd = findEocd(bytes);
  let total = u16(bytes, eocd + 10);
  let cdSize = u32(bytes, eocd + 12);
  let cdOffset = u32(bytes, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locatorAt = eocd - 20;
    if (locatorAt < 0 || u32(bytes, locatorAt) !== EOCD64_LOCATOR_SIG) {
      throw new ZipError("invalid_zip", "ZIP64 sem localizador válido.");
    }
    const zip64At = u64(bytes, locatorAt + 8);
    if (zip64At + 56 > bytes.length || u32(bytes, zip64At) !== EOCD64_SIG) {
      throw new ZipError("invalid_zip", "Registro ZIP64 inválido.");
    }
    total = u64(bytes, zip64At + 32);
    cdSize = u64(bytes, zip64At + 40);
    cdOffset = u64(bytes, zip64At + 48);
  }
  if (total > MAX_ARCHIVE_ENTRIES) {
    throw new ZipError(
      "zip_limits_exceeded",
      "ZIP com " + total + " entradas excede o limite de " + MAX_ARCHIVE_ENTRIES + ".",
    );
  }
  if (cdOffset + cdSize > bytes.length) {
    throw new ZipError("invalid_zip", "Diretório central aponta para fora do arquivo.");
  }

  const entries = new Map<string, ZipEntry>();
  let encrypted = false;
  let read = 0;
  let offset = cdOffset;
  let declaredTotal = 0;
  while (read < total) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== CENTRAL_SIG) {
      throw new ZipError("invalid_zip", "Entrada do diretório central malformada.");
    }
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const crc = u32(bytes, offset + 16);
    let compressedSize = u32(bytes, offset + 20);
    let uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    let localOffset = u32(bytes, offset + 42);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const name = decodeZipName(nameBytes, flags);
    assertSafeEntryName(name);

    if (
      uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff
    ) {
      let cursor = 0;
      let found = false;
      while (cursor + 4 <= extra.length) {
        const headerId = u16(extra, cursor);
        const size = u16(extra, cursor + 2);
        const body = extra.subarray(cursor + 4, cursor + 4 + size);
        if (headerId === ZIP64_EXTRA) {
          let at = 0;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = u64(body, at);
            at += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(body, at);
            at += 8;
          }
          if (localOffset === 0xffffffff) localOffset = u64(body, at);
          found = true;
        }
        cursor += 4 + size;
      }
      if (!found) throw new ZipError("invalid_zip", "Marcador ZIP64 sem campo estendido.");
    }

    if (flags & 0x1) encrypted = true;
    if (entries.has(name)) {
      throw new ZipError("unsafe_archive", "Entrada de ZIP duplicada: " + name + ".");
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ZipError(
        "zip_limits_exceeded",
        "ZIP declara " + declaredTotal + " bytes descomprimidos, acima do limite.",
      );
    }
    if (
      uncompressedSize > MAX_PART_BYTES &&
      uncompressedSize > compressedSize * MAX_COMPRESSION_RATIO + 1024 * 1024
    ) {
      throw new ZipError(
        "zip_limits_exceeded",
        "Entrada com razão de compressão atípica (possível bomba de descompressão).",
      );
    }
    entries.set(name, {
      name,
      method,
      flags,
      crc,
      compressed_size: compressedSize,
      uncompressed_size: uncompressedSize,
      local_offset: localOffset,
    });
    read++;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, encrypted };
}

async function inflateRawCapped(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ZipError("zip_limits_exceeded", "Saída descomprimida excede o limite da parte.");
      }
      chunks.push(value);
    }
  })();
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  try {
    await writer.write(copy);
    await writer.close();
  } catch {
    // O consumidor pode ter cancelado a leitura ao exceder o limite.
  }
  await pump;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function readZipEntry(
  bytes: Uint8Array,
  directory: ZipDirectory,
  name: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const entry = directory.entries.get(name);
  if (!entry) throw new ZipError("missing_document_part", "Parte " + name + " ausente no arquivo.");
  if (entry.flags & 0x1) {
    throw new ZipError("document_encrypted", "Parte " + name + " está cifrada no ZIP.");
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(
      "unsupported_compression",
      "Parte " + name + " usa método de compressão " + entry.method +
        " não suportado (apenas stored/deflate).",
    );
  }
  if (entry.uncompressed_size > maxBytes) {
    throw new ZipError(
      "zip_limits_exceeded",
      "Parte " + name + " declara " + entry.uncompressed_size + " bytes acima do limite.",
    );
  }
  const offset = entry.local_offset;
  if (offset + 30 > bytes.length || u32(bytes, offset) !== LOCAL_SIG) {
    throw new ZipError("invalid_zip", "Cabeçalho local de " + name + " malformado.");
  }
  const localFlags = u16(bytes, offset + 6);
  if (localFlags & 0x1) {
    throw new ZipError("document_encrypted", "Parte " + name + " está cifrada no cabeçalho local.");
  }
  const localNameLength = u16(bytes, offset + 26);
  const localExtraLength = u16(bytes, offset + 28);
  const dataStart = offset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressed_size;
  if (dataEnd > bytes.length) {
    throw new ZipError("invalid_zip", "Dados de " + name + " apontam para fora do arquivo.");
  }
  const raw = bytes.subarray(dataStart, dataEnd);
  let out: Uint8Array;
  if (entry.method === 0) {
    if (raw.length > maxBytes) {
      throw new ZipError("zip_limits_exceeded", "Parte " + name + " excede o limite.");
    }
    out = new Uint8Array(raw);
  } else {
    out = await inflateRawCapped(raw, maxBytes);
  }
  if (entry.uncompressed_size !== 0 && out.length !== entry.uncompressed_size) {
    throw new ZipError(
      "zip_integrity",
      "Parte " + name + " tem tamanho descomprimido divergente do declarado.",
    );
  }
  if (entry.crc !== 0 && crc32(out) !== entry.crc) {
    throw new ZipError("zip_integrity", "CRC de " + name + " não confere.");
  }
  return out;
}

// --- Tokenizador/árvore XML -------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

function xmlNode(name: string): XmlNode {
  return { name, attrs: {}, text: "", children: [] };
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeEntityAt(text: string, start: number): { value: string; next: number } | null {
  const end = text.indexOf(";", start);
  if (end < 0 || end - start > 12) return null;
  const body = text.slice(start + 1, end);
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const code = Number.parseInt(body.slice(2), 16);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
    if (code >= 0xd800 && code <= 0xdfff) return { value: "\ufffd", next: end + 1 };
    return { value: String.fromCodePoint(code), next: end + 1 };
  }
  if (body.startsWith("#")) {
    const code = Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
    if (code >= 0xd800 && code <= 0xdfff) return { value: "\ufffd", next: end + 1 };
    return { value: String.fromCodePoint(code), next: end + 1 };
  }
  const named = XML_NAMED_ENTITIES[body];
  return named === undefined ? null : { value: named, next: end + 1 };
}

function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf("&", i);
    if (amp < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    const decoded = decodeEntityAt(text, amp);
    if (decoded) {
      out += decoded.value;
      i = decoded.next;
    } else {
      out += "&";
      i = amp + 1;
    }
  }
  return out;
}

function parseAttributes(raw: string, from: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = from;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;
    const nameStart = i;
    while (i < raw.length && !/[\s=]/.test(raw[i])) i++;
    const name = raw.slice(nameStart, i);
    while (i < raw.length && /\s/.test(raw[i])) i++;
    let value = "";
    if (raw[i] === "=") {
      i++;
      while (i < raw.length && /\s/.test(raw[i])) i++;
      const quote = raw[i];
      if (quote === '"' || quote === "'") {
        const end = raw.indexOf(quote, i + 1);
        if (end < 0) {
          value = raw.slice(i + 1);
          i = raw.length;
        } else {
          value = raw.slice(i + 1, end);
          i = end + 1;
        }
      } else {
        const start = i;
        while (i < raw.length && !/[\s]/.test(raw[i])) i++;
        value = raw.slice(start, i);
      }
    }
    if (name) attrs[name] = decodeXmlText(value);
  }
  return attrs;
}

/**
 * Tokeniza XML bem formado para uma árvore leve. Recusa DOCTYPE (portanto sem
 * entidades externas nem expansão de subconjunto interno) e limita profundidade,
 * eventos e tamanho. Não é um parser de HTML: a marcação precisa fechar.
 */
export function parseXmlTree(xml: string): XmlNode {
  const root = xmlNode("#root");
  const stack: XmlNode[] = [root];
  let i = 0;
  let events = 0;
  const n = xml.length;
  const appendText = (value: string) => {
    if (!value) return;
    stack[stack.length - 1].text += value;
  };

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      appendText(decodeXmlText(xml.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeXmlText(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("invalid_xml", "Comentário XML não terminado.");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("invalid_xml", "CDATA não terminado.");
      appendText(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("invalid_xml", "Instrução de processamento não terminada.");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      throw new XmlError(
        "invalid_xml",
        "DOCTYPE/declaração de entidade recusada: entidades externas não são resolvidas.",
      );
    }
    if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt);
      if (end < 0) throw new XmlError("invalid_xml", "Tag de fechamento não terminada.");
      const name = xml.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) {
        throw new XmlError("invalid_xml", "Fechamento </" + name + "> não corresponde à abertura.");
      }
      i = end + 1;
      continue;
    }

    let cursor = lt + 1;
    let quote = "";
    let end = -1;
    while (cursor < n) {
      const ch = xml[cursor];
      if (quote) {
        if (ch === quote) quote = "";
        cursor++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cursor++;
        continue;
      }
      if (ch === "<") break;
      if (ch === ">") {
        end = cursor;
        break;
      }
      cursor++;
    }
    if (end < 0) {
      // Marcação malformada: recomeça no próximo "<", sem consumir o resto.
      i = cursor < n ? cursor : n;
      continue;
    }
    let raw = xml.slice(lt + 1, end).trim();
    let selfClosing = false;
    if (raw.endsWith("/")) {
      selfClosing = true;
      raw = raw.slice(0, -1);
    }
    let nameEnd = 0;
    while (nameEnd < raw.length && !/[\s/]/.test(raw[nameEnd])) nameEnd++;
    const name = raw.slice(0, nameEnd);
    if (!name) {
      i = end + 1;
      continue;
    }
    events++;
    if (events > MAX_XML_EVENTS) {
      throw new XmlError("invalid_xml", "Documento XML com eventos acima do limite.");
    }
    const node = xmlNode(name);
    node.attrs = parseAttributes(raw, nameEnd);
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length + 1 > MAX_XML_DEPTH) {
        throw new XmlError("invalid_xml", "Profundidade de XML acima do limite.");
      }
      stack.push(node);
    }
    i = end + 1;
  }
  if (stack.length !== 1) {
    throw new XmlError("invalid_xml", "Documento XML terminou com tags abertas.");
  }
  return root;
}

// --- DOCX: partes auxiliares ------------------------------------------------

interface DocxStyle {
  style_id: string;
  name: string | null;
  outline_level: number | null;
  based_on: string | null;
}

interface DocxRel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function isW(node: XmlNode, local: string): boolean {
  return node.name === "w:" + local;
}

function childW(node: XmlNode, local: string): XmlNode | null {
  return node.children.find((child) => isW(child, local)) ?? null;
}

function wVal(node: XmlNode | null, attr = "w:val"): string | null {
  if (!node) return null;
  const value = node.attrs[attr];
  return value === undefined ? null : value;
}

function onOff(node: XmlNode | null): boolean {
  if (!node) return false;
  const value = wVal(node);
  if (value === null) return true;
  const lower = value.toLowerCase();
  return value !== "0" && lower !== "false" && lower !== "off";
}

function findWDeep(node: XmlNode, local: string): boolean {
  if (isW(node, local)) return true;
  return node.children.some((child) => findWDeep(child, local));
}

function readStyles(root: XmlNode): Map<string, DocxStyle> {
  const styles = new Map<string, DocxStyle>();
  const visit = (node: XmlNode) => {
    for (const child of node.children) {
      if (!isW(child, "style")) {
        visit(child);
        continue;
      }
      const styleId = child.attrs["w:styleId"];
      if (!styleId) continue;
      const pPr = childW(child, "pPr");
      const outline = pPr ? Number.parseInt(wVal(childW(pPr, "outlineLvl")) ?? "", 10) : NaN;
      styles.set(styleId, {
        style_id: styleId,
        name: wVal(childW(child, "name")),
        outline_level: Number.isInteger(outline) && outline >= 0 && outline <= 8 ? outline : null,
        based_on: wVal(childW(child, "basedOn")),
      });
    }
  };
  visit(root);
  return styles;
}

function resolveOutline(
  style: DocxStyle | undefined,
  styles: Map<string, DocxStyle>,
): number | null {
  let current = style;
  for (let depth = 0; current && depth < 16; depth++) {
    if (current.outline_level !== null) return current.outline_level;
    current = current.based_on ? styles.get(current.based_on) : undefined;
  }
  return null;
}

function readNumbering(root: XmlNode | null): Map<string, string> {
  const formats = new Map<string, string>();
  if (!root) return formats;
  const abstractNodes: XmlNode[] = [];
  const numNodes: XmlNode[] = [];
  const visit = (node: XmlNode) => {
    for (const child of node.children) {
      if (isW(child, "abstractNum")) abstractNodes.push(child);
      else if (isW(child, "num")) numNodes.push(child);
      visit(child);
    }
  };
  visit(root);
  const abstract = new Map<string, string>();
  for (const node of abstractNodes) {
    const id = node.attrs["w:abstractNumId"];
    const level = childW(node, "lvl");
    const fmt = level ? wVal(childW(level, "numFmt")) : null;
    if (id && fmt) abstract.set(id, fmt);
  }
  for (const node of numNodes) {
    const numId = node.attrs["w:numId"];
    const abstractId = wVal(childW(node, "abstractNumId"));
    if (numId && abstractId && abstract.has(abstractId)) {
      formats.set(numId, abstract.get(abstractId)!);
    }
  }
  return formats;
}

function readRels(root: XmlNode | null): Map<string, DocxRel> {
  const rels = new Map<string, DocxRel>();
  if (!root) return rels;
  const visit = (node: XmlNode) => {
    for (const child of node.children) {
      if (localName(child.name) === "Relationship") {
        const id = child.attrs.Id;
        if (id) {
          const target = child.attrs.Target ?? "";
          rels.set(id, {
            id,
            type: child.attrs.Type ?? "",
            target,
            external: (child.attrs.TargetMode ?? "").toLowerCase() === "external" ||
              /^[a-z][a-z0-9+.-]*:/i.test(target),
          });
        }
      }
      visit(child);
    }
  };
  visit(root);
  return rels;
}

const CORE_METADATA_KEYS = new Set([
  "title",
  "subject",
  "creator",
  "description",
  "lastModifiedBy",
  "revision",
  "created",
  "modified",
  "category",
  "keywords",
  "language",
]);

function readCoreMetadata(root: XmlNode | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root) return out;
  const visit = (node: XmlNode) => {
    for (const child of node.children) {
      const local = localName(child.name);
      if (CORE_METADATA_KEYS.has(local) && child.text.trim()) {
        out[local] = child.text.trim().slice(0, 2_000);
      }
      visit(child);
    }
  };
  visit(root);
  return out;
}

// --- DOCX: corpo ------------------------------------------------------------

interface InlineAccumulator {
  text: string;
  spans: InlineSpan[];
  links: ParagraphLink[];
  fields: string[];
  imageCount: number;
  deletedCount: number;
  truncated: boolean;
}

interface DocxWalkContext {
  styles: Map<string, DocxStyle>;
  numbering: Map<string, string>;
  rels: Map<string, DocxRel>;
  options: ResolvedDocx;
  blocks: DocumentBlock[];
  gaps: Set<string>;
  issues: DocumentExtractionIssue[];
  counters: {
    paragraph: number;
    table: number;
    link: number;
    cells: number;
    images: number;
    fields: number;
  };
  textChars: number;
  blocksTruncated: boolean;
  textTruncated: boolean;
  spansTruncated: boolean;
}

function freshAccumulator(): InlineAccumulator {
  return {
    text: "",
    spans: [],
    links: [],
    fields: [],
    imageCount: 0,
    deletedCount: 0,
    truncated: false,
  };
}

function runPropertiesSpan(rPr: XmlNode | null, start: number, style: string | null): InlineSpan {
  return {
    start,
    end: start,
    bold: onOff(rPr ? childW(rPr, "b") : null),
    italic: onOff(rPr ? childW(rPr, "i") : null),
    underline: onOff(rPr ? childW(rPr, "u") : null),
    strike: onOff(rPr ? childW(rPr, "strike") : null) ||
      onOff(rPr ? childW(rPr, "dstrike") : null),
    vert_align: rPr ? wVal(childW(rPr, "vertAlign")) : null,
    style,
  };
}

function readRunContent(
  run: XmlNode,
  acc: InlineAccumulator,
  ctx: DocxWalkContext,
  depth: number,
): void {
  for (const child of run.children) {
    if (acc.text.length > ctx.options.maxTextChars) {
      acc.truncated = true;
      ctx.textTruncated = true;
      return;
    }
    if (isW(child, "t")) {
      acc.text += child.text;
    } else if (isW(child, "delText")) {
      ctx.gaps.add("texto_excluido_por_revisao_nao_incluido");
    } else if (isW(child, "instrText")) {
      const code = child.text.trim();
      if (code) {
        acc.fields.push(code);
        ctx.counters.fields++;
      }
    } else if (isW(child, "tab")) {
      acc.text += "\t";
    } else if (isW(child, "br") || isW(child, "cr")) {
      acc.text += "\n";
    } else if (isW(child, "noBreakHyphen")) {
      acc.text += "-";
    } else if (isW(child, "sym")) {
      ctx.gaps.add("simbolo_especial_nao_interpretado");
    } else if (isW(child, "drawing") || isW(child, "pict") || isW(child, "object")) {
      acc.imageCount++;
      ctx.counters.images++;
      if (findWDeep(child, "txbxContent")) ctx.gaps.add("caixa_de_texto_nao_incluida");
      if (isW(child, "object")) ctx.gaps.add("objeto_incorporado_nao_interpretado");
    } else if (isW(child, "footnoteReference")) {
      ctx.gaps.add("nota_de_rodape_nao_incluida");
    } else if (isW(child, "endnoteReference")) {
      ctx.gaps.add("nota_final_nao_incluida");
    } else if (depth < 32 && child.children.length) {
      readRunContent(child, acc, ctx, depth + 1);
    }
  }
}

function walkInline(
  node: XmlNode,
  acc: InlineAccumulator,
  ctx: DocxWalkContext,
  depth: number,
): void {
  if (depth > 64 || acc.truncated) {
    acc.truncated = true;
    return;
  }
  for (const child of node.children) {
    if (acc.text.length > ctx.options.maxTextChars) {
      acc.truncated = true;
      ctx.textTruncated = true;
      return;
    }
    if (isW(child, "r")) {
      const rPr = childW(child, "rPr");
      const span = runPropertiesSpan(
        rPr,
        acc.text.length,
        rPr ? wVal(childW(rPr, "rStyle")) : null,
      );
      readRunContent(child, acc, ctx, depth);
      span.end = acc.text.length;
      if (span.end > span.start) {
        if (acc.spans.length >= MAX_INLINE_SPANS) ctx.spansTruncated = true;
        else acc.spans.push(span);
      }
    } else if (isW(child, "hyperlink")) {
      const start = acc.text.length;
      const relId = child.attrs["r:id"] ?? null;
      const anchor = child.attrs["w:anchor"] ?? null;
      const rel = relId ? ctx.rels.get(relId) ?? null : null;
      walkInline(child, acc, ctx, depth + 1);
      const target = rel?.target ?? null;
      const kind: ParagraphLink["kind"] = anchor
        ? "internal"
        : rel
        ? (rel.external ? "external" : "internal")
        : "unknown";
      ctx.counters.link++;
      acc.links.push({
        locator: docxLinkLocator(ctx.counters.link),
        start,
        end: acc.text.length,
        text: acc.text.slice(start),
        target,
        relationship_id: relId,
        anchor,
        kind,
      });
      if (!target && !anchor) ctx.gaps.add("hyperlink_sem_destino_resolvido");
    } else if (isW(child, "ins")) {
      walkInline(child, acc, ctx, depth + 1);
    } else if (isW(child, "del")) {
      acc.deletedCount++;
      ctx.gaps.add("texto_excluido_por_revisao_nao_incluido");
    } else if (isW(child, "sdt") || isW(child, "smartTag") || isW(child, "customXml")) {
      walkInline(childW(child, "sdtContent") ?? child, acc, ctx, depth + 1);
    } else if (isW(child, "fldSimple")) {
      const instr = child.attrs["w:instr"];
      if (instr) {
        acc.fields.push(instr);
        ctx.counters.fields++;
      }
      walkInline(child, acc, ctx, depth + 1);
    } else if (isW(child, "subDoc")) {
      ctx.gaps.add("subdocumento_nao_incluido");
    } else if (isW(child, "AltChunk")) {
      ctx.gaps.add("parte_alternativa_altChunk_nao_incluida");
    } else if (isW(child, "drawing") || isW(child, "pict") || isW(child, "object")) {
      acc.imageCount++;
      ctx.counters.images++;
      if (findWDeep(child, "txbxContent")) ctx.gaps.add("caixa_de_texto_nao_incluida");
      if (isW(child, "object")) ctx.gaps.add("objeto_incorporado_nao_interpretado");
    } else if (isW(child, "commentReference")) {
      ctx.gaps.add("comentario_nao_incluido");
    } else if (isW(child, "footnoteReference")) {
      ctx.gaps.add("nota_de_rodape_nao_incluida");
    } else if (isW(child, "endnoteReference")) {
      ctx.gaps.add("nota_final_nao_incluida");
    } else if (
      isW(child, "bookmarkStart") || isW(child, "bookmarkEnd") ||
      isW(child, "proofErr") || isW(child, "commentRangeStart") ||
      isW(child, "commentRangeEnd") || isW(child, "bookmarkEnd")
    ) {
      continue;
    } else if (child.children.length) {
      walkInline(child, acc, ctx, depth + 1);
    }
  }
}

function headingLevel(
  styleId: string | null,
  style: DocxStyle | null,
  ctx: DocxWalkContext,
): number | null {
  const explicit = resolveOutline(style ?? undefined, ctx.styles);
  if (explicit !== null) return explicit + 1;
  const candidate = styleId ?? style?.name ?? null;
  if (!candidate) return null;
  const match = /^(?:heading|t[íi]tulo)\s*([1-9])$/i.exec(candidate.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

function sanitizeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function readParagraph(node: XmlNode, ctx: DocxWalkContext, depth: number): ParagraphBlock {
  const index = ++ctx.counters.paragraph;
  const pPr = childW(node, "pPr");
  const styleId = pPr ? wVal(childW(pPr, "pStyle")) : null;
  const style = styleId ? ctx.styles.get(styleId) ?? null : null;
  const numPr = pPr ? childW(pPr, "numPr") : null;
  const numId = numPr ? wVal(childW(numPr, "numId")) : null;
  const level = numPr ? Number.parseInt(wVal(childW(numPr, "ilvl")) ?? "0", 10) : NaN;
  const list: ParagraphListInfo | null = numId
    ? {
      level: Number.isInteger(level) && level >= 0 && level <= 8 ? level : 0,
      num_id: numId,
      num_fmt: ctx.numbering.get(numId) ?? null,
    }
    : null;

  const acc = freshAccumulator();
  walkInline(node, acc, ctx, depth);
  const declaredOutline = pPr ? Number.parseInt(wVal(childW(pPr, "outlineLvl")) ?? "", 10) : NaN;
  const heading = Number.isInteger(declaredOutline) && declaredOutline >= 0 && declaredOutline <= 8
    ? declaredOutline + 1
    : headingLevel(styleId, style, ctx);

  let text = sanitizeText(acc.text);
  if (text.length > ctx.options.maxTextChars) {
    text = text.slice(0, ctx.options.maxTextChars);
    ctx.textTruncated = true;
  }
  ctx.textChars += text.length;
  const truncated = acc.truncated || text.length < acc.text.length;
  if (truncated) ctx.textTruncated = true;

  const styleName = style?.name ?? null;
  return {
    type: "paragraph",
    index,
    locator: docxParagraphLocator(index),
    text,
    char_count: text.length,
    heading_level: heading,
    style_id: styleId,
    style_name: styleName,
    list,
    quote: /^(quote|intense quote|cita[çc][ãa]o)$/i.test(styleName ?? ""),
    code: /^(code|html preformatted|plain text|texto simples)$/i.test(styleName ?? ""),
    spans: acc.spans,
    links: acc.links,
    fields: acc.fields,
    image_count: acc.imageCount,
    truncated,
  };
}

function readCellText(cell: XmlNode, ctx: DocxWalkContext): { text: string; paragraphs: number } {
  const parts: string[] = [];
  let paragraphs = 0;
  for (const child of cell.children) {
    if (isW(child, "p")) {
      paragraphs++;
      const acc = freshAccumulator();
      walkInline(child, acc, ctx, 0);
      parts.push(sanitizeText(acc.text).trim());
      if (acc.fields.length) ctx.counters.fields += 0;
    } else if (isW(child, "tbl")) {
      ctx.gaps.add("tabela_aninhada_em_celula_nao_incluida");
    } else if (isW(child, "sdt") || isW(child, "customXml")) {
      const content = childW(child, "sdtContent") ?? child;
      const nested = readCellText(content, ctx);
      if (nested.text) parts.push(nested.text);
      paragraphs += nested.paragraphs;
    } else if (isW(child, "txbxContent")) {
      ctx.gaps.add("caixa_de_texto_nao_incluida");
    }
  }
  return { text: parts.join("\n").trim(), paragraphs };
}

function readTable(node: XmlNode, ctx: DocxWalkContext): TableBlock {
  const index = ++ctx.counters.table;
  const rows: TableCellBlock[][] = [];
  let columns = 0;
  let truncated = false;
  const rowNodes = node.children.filter((child) => isW(child, "tr"));
  for (const rowNode of rowNodes) {
    const rowIndex = rows.length + 1;
    const cells: TableCellBlock[] = [];
    let col = 1;
    for (const cellNode of rowNode.children.filter((child) => isW(child, "tc"))) {
      const tcPr = childW(cellNode, "tcPr");
      const gridSpan = tcPr ? Number.parseInt(wVal(childW(tcPr, "gridSpan")) ?? "1", 10) : 1;
      const vMergeNode = tcPr ? childW(tcPr, "vMerge") : null;
      const vMergeValue = wVal(vMergeNode);
      const vMerge: TableCellBlock["v_merge"] = vMergeNode === null
        ? null
        : vMergeValue === null || vMergeValue === "continue"
        ? "continue"
        : vMergeValue === "restart"
        ? "restart"
        : null;
      const span = Number.isInteger(gridSpan) && gridSpan >= 1 && gridSpan <= 64 ? gridSpan : 1;
      if (ctx.counters.cells >= ctx.options.maxTableCells) {
        truncated = true;
        ctx.blocksTruncated = true;
        break;
      }
      ctx.counters.cells++;
      const content = readCellText(cellNode, ctx);
      cells.push({
        locator: docxTableLocator(index, rowIndex, col),
        row: rowIndex,
        col,
        grid_span: span,
        v_merge: vMerge,
        text: content.text,
        paragraphs: content.paragraphs,
      });
      if (span > 1) ctx.gaps.add("celula_mesclada_horizontalmente");
      if (vMerge === "continue") ctx.gaps.add("celula_mesclada_verticalmente");
      col += span;
    }
    columns = Math.max(columns, col - 1);
    rows.push(cells);
    if (truncated) break;
  }
  const text = rows
    .map((cells) => cells.map((cell) => cell.text.replace(/\n/g, " ")).join(" | "))
    .join("\n");
  return {
    type: "table",
    index,
    locator: docxTableLocator(index),
    rows: rows.length,
    columns,
    cells: rows.flat(),
    text: text.slice(0, ctx.options.maxTextChars),
    truncated,
  };
}

function walkBody(container: XmlNode, ctx: DocxWalkContext, depth: number): void {
  if (depth > 32) {
    ctx.gaps.add("aninhamento_profundo_nao_interpretado");
    return;
  }
  for (const child of container.children) {
    if (isW(child, "p")) {
      if (ctx.blocks.length >= ctx.options.maxBlocks) {
        ctx.blocksTruncated = true;
        continue;
      }
      const block = readParagraph(child, ctx, depth);
      if (block.text || block.image_count || block.fields.length || block.links.length) {
        ctx.blocks.push(block);
      }
    } else if (isW(child, "tbl")) {
      if (ctx.blocks.length >= ctx.options.maxBlocks) {
        ctx.blocksTruncated = true;
        continue;
      }
      ctx.blocks.push(readTable(child, ctx));
    } else if (isW(child, "sdt") || isW(child, "customXml")) {
      walkBody(childW(child, "sdtContent") ?? child, ctx, depth + 1);
    } else if (isW(child, "txbxContent")) {
      ctx.gaps.add("caixa_de_texto_nao_incluida");
    } else if (child.children.length) {
      walkBody(child, ctx, depth + 1);
    }
  }
}

// --- DOCX: API pública ------------------------------------------------------

interface ResultContext {
  byteLength: number;
  startedAt: number;
  limits: string[];
}

const COVERAGE_BY_CODE: Partial<Record<DocumentExtractionCode, Coverage>> = {
  empty_input: "parsing_error",
  oversized: "unavailable",
  invalid_zip: "parsing_error",
  invalid_xml: "parsing_error",
  not_a_docx: "parsing_error",
  missing_document_part: "parsing_error",
  document_encrypted: "denied",
  unsupported_compression: "unavailable",
  unsafe_archive: "unavailable",
  zip_limits_exceeded: "unavailable",
  zip_integrity: "parsing_error",
  html_empty: "parsing_error",
  unreadable: "parsing_error",
};

function errorResult(
  format: "docx" | "html",
  code: DocumentExtractionCode,
  message: string,
  context: ResultContext,
  coverage: Coverage = COVERAGE_BY_CODE[code] ?? "parsing_error",
): DocumentTextExtraction {
  return {
    kind: "document_text_extraction",
    format,
    ok: false,
    error_code: code,
    coverage,
    execution: "not_started",
    hard_timeout: false,
    blocks: [],
    block_count: 0,
    paragraph_count: 0,
    heading_count: 0,
    list_item_count: 0,
    table_count: 0,
    cell_count: 0,
    link_count: 0,
    image_count: 0,
    field_count: 0,
    characters: 0,
    text_truncated: false,
    blocks_truncated: false,
    sanitized_html: null,
    sanitizer_removals: {},
    metadata: {},
    parts_read: [],
    gaps: [],
    media_type: format === "docx" ? DOCX_MIME : "text/html",
    limits: context.limits,
    notes: [UNTRUSTED_NOTE, NO_EXECUTION_NOTE],
    errors: [{ scope: "document", locator: null, code, message }],
    content_is_untrusted_data: true,
    byte_length: context.byteLength,
    elapsed_ms: Math.round(performance.now() - context.startedAt),
  };
}

function docxLimits(options: ResolvedDocx): string[] {
  return [
    "Somente a estrutura declarada no OOXML: sem executar macros, campos ou objetos, sem rede e sem OCR.",
    "Bytes do arquivo: limite " + options.maxBytes + ".",
    "Blocos: até " + options.maxBlocks + "; caracteres: até " + options.maxTextChars + ".",
    "Células de tabela: até " + options.maxTableCells + ".",
    "Entradas do pacote: até " + MAX_ARCHIVE_ENTRIES + ".",
  ];
}

/**
 * Extrai estrutura e texto de um DOCX em memória: parágrafos (com estilo,
 * nível de título e listas), tabelas/células, hiperlinks resolvidos por
 * relacionamento e contagem de imagens. Devolve localizadores estáveis.
 */
export async function extractDocxText(
  input: Uint8Array,
  options: DocxExtractionOptions = {},
): Promise<DocumentTextExtraction> {
  if (!(input instanceof Uint8Array)) {
    throw new HubError("invalid_document_input", "A entrada deve ser Uint8Array.");
  }
  const resolved = resolveDocxOptions(options);
  const startedAt = performance.now();
  const limits = docxLimits(resolved);
  const context: ResultContext = { byteLength: input.byteLength, startedAt, limits };
  if (input.byteLength === 0) {
    return errorResult("docx", "empty_input", "Entrada vazia.", context);
  }
  if (input.byteLength > resolved.maxBytes) {
    return errorResult(
      "docx",
      "oversized",
      "DOCX acima do limite de bytes; não processado.",
      context,
    );
  }
  if (!(input[0] === 0x50 && input[1] === 0x4b)) {
    return errorResult(
      "docx",
      "not_a_docx",
      "O arquivo não tem assinatura de pacote ZIP/OOXML.",
      context,
    );
  }

  try {
    const directory = readZipDirectory(input);
    if (directory.encrypted) {
      return errorResult(
        "docx",
        "document_encrypted",
        "O pacote OOXML está cifrado; o conteúdo não foi extraído.",
        context,
      );
    }
    if (!directory.entries.has(MAIN_PART)) {
      return errorResult(
        "docx",
        "missing_document_part",
        "Pacote ZIP sem a parte obrigatória " + MAIN_PART + ".",
        context,
      );
    }
    const partsRead: string[] = [];
    const readPart = async (name: string): Promise<string | null> => {
      if (!directory.entries.has(name)) return null;
      const bytes = await readZipEntry(input, directory, name, MAX_PART_BYTES);
      partsRead.push(name);
      return new TextDecoder("utf-8").decode(bytes);
    };

    const documentXml = await readPart(MAIN_PART);
    const relsXml = await readPart(RELS_PART);
    const stylesXml = await readPart(STYLES_PART);
    const numberingXml = await readPart(NUMBERING_PART);
    const coreXml = await readPart(CORE_PART);

    const documentRoot = parseXmlTree(documentXml ?? "");
    const body = documentRoot.children.flatMap((node) => node.children).find((node) =>
      isW(node, "body")
    );
    if (!body) {
      return errorResult("docx", "invalid_xml", "document.xml sem elemento w:body.", context);
    }
    const styles = stylesXml ? readStyles(parseXmlTree(stylesXml)) : new Map<string, DocxStyle>();
    const numbering = numberingXml
      ? readNumbering(parseXmlTree(numberingXml))
      : new Map<string, string>();
    const rels = relsXml ? readRels(parseXmlTree(relsXml)) : new Map<string, DocxRel>();
    const metadata = coreXml ? readCoreMetadata(parseXmlTree(coreXml)) : {};

    const ctx: DocxWalkContext = {
      styles,
      numbering,
      rels,
      options: resolved,
      blocks: [],
      gaps: new Set<string>(),
      issues: [],
      counters: { paragraph: 0, table: 0, link: 0, cells: 0, images: 0, fields: 0 },
      textChars: 0,
      blocksTruncated: false,
      textTruncated: false,
      spansTruncated: false,
    };
    walkBody(body, ctx, 0);

    let paragraphCount = 0;
    let headingCount = 0;
    let listCount = 0;
    let tableCount = 0;
    let cellCount = 0;
    let characters = 0;
    for (const block of ctx.blocks) {
      if (block.type === "table") {
        tableCount++;
        cellCount += block.cells.length;
        characters += block.text.length;
        continue;
      }
      paragraphCount++;
      if (block.heading_level !== null) headingCount++;
      if (block.list) listCount++;
      characters += block.char_count;
    }

    const notes = [UNTRUSTED_NOTE, NO_EXECUTION_NOTE];
    if (ctx.spansTruncated) {
      notes.push("Formatação inline parcialmente omitida por limite de trechos.");
    }
    if (!ctx.blocks.length) {
      notes.push("Nenhum bloco de conteúdo foi encontrado no corpo do documento.");
    }

    return {
      kind: "document_text_extraction",
      format: "docx",
      ok: true,
      coverage: ctx.blocksTruncated || ctx.textTruncated ? "partial" : "complete",
      execution: "in_process",
      hard_timeout: false,
      blocks: ctx.blocks,
      block_count: ctx.blocks.length,
      paragraph_count: paragraphCount,
      heading_count: headingCount,
      list_item_count: listCount,
      table_count: tableCount,
      cell_count: cellCount,
      link_count: ctx.counters.link,
      image_count: ctx.counters.images,
      field_count: ctx.counters.fields,
      characters,
      text_truncated: ctx.textTruncated,
      blocks_truncated: ctx.blocksTruncated,
      sanitized_html: null,
      sanitizer_removals: {},
      metadata,
      parts_read: partsRead,
      gaps: [...ctx.gaps].sort(),
      media_type: DOCX_MIME,
      limits: [
        ...limits,
        "Partes lidas: " + partsRead.length + " de " + directory.entries.size +
        " entradas do pacote.",
      ],
      notes,
      errors: ctx.issues,
      content_is_untrusted_data: true,
      byte_length: input.byteLength,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    if (error instanceof ZipError || error instanceof XmlError) {
      return errorResult("docx", error.code, error.message, context);
    }
    return errorResult(
      "docx",
      "unreadable",
      "Falha ao ler o DOCX sem classificação específica.",
      context,
    );
  }
}

// --- Detecção de pacote Office (para artifacts.ts / upload) -----------------

export interface OfficeArchiveInspection {
  container: "zip" | "not_zip";
  ok: boolean;
  error_code?: DocumentExtractionCode;
  encrypted: boolean;
  entry_count: number;
  has_content_types: boolean;
  content_type_defaults: Record<string, string>;
  content_type_overrides: Record<string, string>;
  main_parts: string[];
  detected: "docx" | "pptx" | "xlsx" | null;
  macro_enabled: boolean;
  media_type: string | null;
  limits: string[];
  notes: string[];
  content_is_untrusted_data: true;
  byte_length: number;
}

export interface OfficeArchiveOptions {
  maxBytes?: number;
}

const OFFICE_MAIN_PARTS: ReadonlyArray<{
  part: string;
  kind: "docx" | "pptx" | "xlsx";
  marker: string;
  media_type: string;
  macro_media_type: string;
  vba: string;
}> = [
  {
    part: MAIN_PART,
    kind: "docx",
    marker: "wordprocessingml.document.main",
    media_type: DOCX_MIME,
    macro_media_type: DOCM_MIME,
    vba: VBA_PART,
  },
  {
    part: PPT_MAIN_PART,
    kind: "pptx",
    marker: "presentationml.presentation.main",
    media_type: PPTX_MIME,
    macro_media_type: PPTM_MIME,
    vba: VBA_PPT_PART,
  },
  {
    part: XLS_MAIN_PART,
    kind: "xlsx",
    marker: "spreadsheetml.sheet.main",
    media_type: XLSX_MIME,
    macro_media_type: XLSM_MIME,
    vba: VBA_XLS_PART,
  },
];

function readContentTypes(xml: string): {
  defaults: Record<string, string>;
  overrides: Record<string, string>;
} {
  const defaults: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  const root = parseXmlTree(xml);
  const visit = (node: XmlNode) => {
    for (const child of node.children) {
      const local = localName(child.name);
      if (local === "Default" && child.attrs.Extension && child.attrs.ContentType) {
        defaults[child.attrs.Extension.toLowerCase()] = child.attrs.ContentType;
      } else if (local === "Override" && child.attrs.PartName && child.attrs.ContentType) {
        overrides[child.attrs.PartName] = child.attrs.ContentType;
      }
      visit(child);
    }
  };
  visit(root);
  return { defaults, overrides };
}

/**
 * Inspeção compacta e limitada de um pacote Office já em memória, para o
 * resolvedor de upload/artifacts identificar DOCX/PPTX/XLSX (e variantes com
 * macro) sem executar nada e sem reabrir o arquivo. Só lê o diretório central,
 * `[Content_Types].xml` e a presença da parte principal; não descomprime o
 * corpo do documento.
 */
export async function inspectOfficeArchive(
  input: Uint8Array,
  options: OfficeArchiveOptions = {},
): Promise<OfficeArchiveInspection> {
  if (!(input instanceof Uint8Array)) {
    throw new HubError("invalid_document_input", "A entrada deve ser Uint8Array.");
  }
  const maxBytes = boundedInt("maxBytes", options.maxBytes, MAX_DOCX_BYTES, 1, MAX_DOCX_BYTES);
  const base: OfficeArchiveInspection = {
    container: "zip",
    ok: false,
    encrypted: false,
    entry_count: 0,
    has_content_types: false,
    content_type_defaults: {},
    content_type_overrides: {},
    main_parts: [],
    detected: null,
    macro_enabled: false,
    media_type: null,
    limits: [
      "Somente diretório central, [Content_Types].xml e existência da parte principal.",
      "Entradas do pacote: até " + MAX_ARCHIVE_ENTRIES + "; bytes: até " + maxBytes + ".",
    ],
    notes: [UNTRUSTED_NOTE, NO_EXECUTION_NOTE],
    content_is_untrusted_data: true,
    byte_length: input.byteLength,
  };
  if (input.byteLength === 0) {
    return { ...base, container: "not_zip", error_code: "empty_input" };
  }
  if (input.byteLength > maxBytes) {
    return { ...base, container: "not_zip", error_code: "oversized" };
  }
  if (!(input[0] === 0x50 && input[1] === 0x4b)) {
    return { ...base, container: "not_zip", error_code: "not_a_docx" };
  }
  try {
    const directory = readZipDirectory(input);
    base.entry_count = directory.entries.size;
    base.encrypted = directory.encrypted;
    let contentTypes:
      | { defaults: Record<string, string>; overrides: Record<string, string> }
      | null = null;
    if (directory.entries.has(CONTENT_TYPES_PART)) {
      const xml = new TextDecoder("utf-8").decode(
        await readZipEntry(input, directory, CONTENT_TYPES_PART, 4 * 1024 * 1024),
      );
      contentTypes = readContentTypes(xml);
      base.has_content_types = true;
      base.content_type_defaults = contentTypes.defaults;
      base.content_type_overrides = contentTypes.overrides;
    }
    const candidates = OFFICE_MAIN_PARTS.filter((candidate) =>
      directory.entries.has(candidate.part)
    );
    base.main_parts = candidates.map((candidate) => candidate.part);
    const chosen = candidates.length === 1
      ? candidates[0]
      : candidates.find((candidate) =>
        Object.values(contentTypes?.overrides ?? {}).some((type) => type.includes(candidate.marker))
      ) ?? candidates[0];
    if (chosen) {
      const override = contentTypes?.overrides["/" + chosen.part];
      const macroByName = directory.entries.has(chosen.vba) ||
        (override ?? "").toLowerCase().includes("macroenabled");
      base.detected = chosen.kind;
      base.macro_enabled = macroByName;
      base.media_type = override !== undefined &&
          (!macroByName || override.toLowerCase().includes("macroenabled"))
        ? override
        : (macroByName ? chosen.macro_media_type : chosen.media_type);
    } else if (contentTypes) {
      const macro = Object.values(contentTypes.overrides).some((type) =>
        type.toLowerCase().includes("macroenabled")
      );
      base.macro_enabled = macro;
    }
    if (directory.encrypted) {
      return { ...base, error_code: "document_encrypted", detected: null, media_type: null };
    }
    if (!chosen) {
      return { ...base, error_code: "not_a_docx" };
    }
    return { ...base, ok: true };
  } catch (error) {
    if (error instanceof ZipError || error instanceof XmlError) {
      return { ...base, container: "zip", error_code: error.code };
    }
    return { ...base, error_code: "unreadable" };
  }
}

// --- Serialização de texto e despacho ---------------------------------------

/**
 * Texto simples com marcadores de localizador, no mesmo espírito de
 * `pdfExtractionToText`: cada bloco mantém o localizador para proveniência.
 */
export function documentExtractionToText(result: DocumentTextExtraction): string {
  const parts: string[] = [];
  for (const block of result.blocks) {
    if (block.type === "table") {
      parts.push("[[tabela " + block.index + " " + block.locator + "]]");
      for (const cell of block.cells) {
        parts.push("[" + cell.locator + "] " + (cell.text || "(célula sem texto)"));
      }
      continue;
    }
    parts.push("[[" + block.locator + "]]");
    parts.push(block.text || "(parágrafo sem texto extraído)");
    for (const link of block.links) {
      parts.push(
        "[[" + link.locator + "]] " + link.text + " -> " + (link.target ?? "(sem destino)"),
      );
    }
  }
  return parts.join("\n");
}

export const DOCUMENT_FORMATS = ["docx", "html"] as const;
export type DocumentFormat = typeof DOCUMENT_FORMATS[number];

/** Despacho por assinatura de bytes: OOXML (ZIP) vai para DOCX; o resto, HTML. */
export async function extractDocumentText(
  input: Uint8Array,
  options: { format?: DocumentFormat | "auto" } & DocxExtractionOptions & HtmlExtractionOptions =
    {},
): Promise<DocumentTextExtraction> {
  const format = options.format ?? "auto";
  if (format === "docx") return await extractDocxText(input, options);
  if (format === "html") return await extractHtmlText(input, options);
  if (input.length >= 2 && input[0] === 0x50 && input[1] === 0x4b) {
    return await extractDocxText(input, options);
  }
  return await extractHtmlText(input, options);
}

// --- HTML: tokenizador e árvore ---------------------------------------------

export const MAX_HTML_DEPTH = 256;
export const MAX_HTML_NODES = 200_000;

interface HtmlElement {
  name: string;
  attrs: Record<string, string>;
  children: Array<HtmlElement | string>;
}

const HTML_NAMES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
  iexcl: "\u00a1",
  cent: "\u00a2",
  pound: "\u00a3",
  sect: "\u00a7",
  copy: "\u00a9",
  reg: "\u00ae",
  deg: "\u00b0",
  plusmn: "\u00b1",
  middot: "\u00b7",
  laquo: "\u00ab",
  raquo: "\u00bb",
  frac14: "\u00bc",
  frac12: "\u00bd",
  frac34: "\u00be",
  iquest: "\u00bf",
  times: "\u00d7",
  divide: "\u00f7",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  hellip: "\u2026",
  larr: "\u2190",
  rarr: "\u2192",
  harr: "\u2194",
  minus: "\u2212",
  ne: "\u2260",
  le: "\u2264",
  ge: "\u2265",
  euro: "\u20ac",
  trade: "\u2122",
  agrave: "\u00e0",
  aacute: "\u00e1",
  acirc: "\u00e2",
  atilde: "\u00e3",
  ccedil: "\u00e7",
  eacute: "\u00e9",
  ecirc: "\u00ea",
  iacute: "\u00ed",
  oacute: "\u00f3",
  ocirc: "\u00f4",
  otilde: "\u00f5",
  uacute: "\u00fa",
};

function decodeHtmlText(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf("&", i);
    if (amp < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    const end = text.indexOf(";", amp);
    if (end < 0 || end - amp > 12) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const body = text.slice(amp + 1, end);
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      out += Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code >= 0xd800 && code <= 0xdfff ? 0xfffd : code)
        : "&#" + body + ";";
    } else if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      out += Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code >= 0xd800 && code <= 0xdfff ? 0xfffd : code)
        : "&#" + body + ";";
    } else if (HTML_NAMES[body] !== undefined) {
      out += HTML_NAMES[body];
    } else {
      out += "&" + body + ";";
    }
    i = end + 1;
  }
  return out;
}

const HTML_VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

const HTML_BLOCK_LEVEL = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function parseHtmlAttributes(raw: string, from: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = from;
  while (i < raw.length) {
    while (i < raw.length && /[\s]/.test(raw[i])) i++;
    if (i >= raw.length) break;
    const nameStart = i;
    while (i < raw.length && !/[\s=/]/.test(raw[i])) i++;
    const name = raw.slice(nameStart, i).toLowerCase();
    while (i < raw.length && /[\s]/.test(raw[i])) i++;
    let value = "";
    if (raw[i] === "=") {
      i++;
      while (i < raw.length && /[\s]/.test(raw[i])) i++;
      const quote = raw[i];
      if (quote === '"' || quote === "'") {
        const end = raw.indexOf(quote, i + 1);
        if (end < 0) {
          value = raw.slice(i + 1);
          i = raw.length;
        } else {
          value = raw.slice(i + 1, end);
          i = end + 1;
        }
      } else {
        const start = i;
        while (i < raw.length && !/[\s>]/.test(raw[i])) i++;
        value = raw.slice(start, i);
      }
    }
    if (name && !(name in attrs)) attrs[name] = decodeHtmlText(value);
  }
  return attrs;
}

/** URL de HTML após remover controles/espaços que o navegador ignora no esquema. */
function normalizeUrlPrefix(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
}

interface HtmlTreeResult {
  root: HtmlElement;
  truncated: boolean;
}

/**
 * Constrói uma árvore HTML a partir da marcação, com autofechamento simples
 * (li/p/td/th/tr/dt/dd/option), elementos void e elementos de texto bruto.
 * Não executa nada e não resolve entidades externas.
 */
export function buildHtmlTree(html: string): HtmlTreeResult {
  const root: HtmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  let nodes = 0;
  let truncated = false;
  let i = 0;
  const n = html.length;
  const top = () => stack[stack.length - 1];
  const appendText = (value: string) => {
    if (!value) return;
    const target = top();
    const last = target.children[target.children.length - 1];
    if (typeof last === "string") target.children[target.children.length - 1] = last + value;
    else target.children.push(value);
  };
  const openElement = (element: HtmlElement) => {
    nodes++;
    if (nodes > MAX_HTML_NODES) {
      truncated = true;
      return false;
    }
    top().children.push(element);
    if (stack.length + 1 > MAX_HTML_DEPTH) {
      truncated = true;
      return false;
    }
    stack.push(element);
    return true;
  };
  const closeNamed = (name: string) => {
    for (let index = stack.length - 1; index >= 1; index--) {
      if (stack[index].name === name) {
        stack.length = index;
        return;
      }
    }
  };
  const impliedClose = (name: string) => {
    const current = top().name;
    if (name === "li" && current === "li") closeNamed("li");
    else if (name === "dt" && (current === "dt" || current === "dd")) closeNamed(current);
    else if (name === "dd" && (current === "dt" || current === "dd")) closeNamed(current);
    else if (name === "option" && current === "option") closeNamed("option");
    else if ((name === "td" || name === "th") && (current === "td" || current === "th")) {
      closeNamed(current);
    } else if (name === "tr" && (current === "td" || current === "th" || current === "tr")) {
      closeNamed(current);
    } else if (HTML_BLOCK_LEVEL.has(name) && current === "p") {
      closeNamed("p");
    }
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      appendText(decodeHtmlText(html.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeHtmlText(html.slice(i, lt)));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      if (end < 0) break;
      const name = html.slice(lt + 2, end).trim().toLowerCase().split(/[\s]/)[0] ?? "";
      if (name) closeNamed(name);
      i = end + 1;
      continue;
    }

    let cursor = lt + 1;
    let quote = "";
    let end = -1;
    while (cursor < n) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = "";
        cursor++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cursor++;
        continue;
      }
      if (ch === "<") break;
      if (ch === ">") {
        end = cursor;
        break;
      }
      cursor++;
    }
    if (end < 0) {
      // Marcação malformada (ex.: "<<script>"): recomeça no próximo "<".
      if (cursor >= n) break;
      i = cursor;
      continue;
    }
    let raw = html.slice(lt + 1, end).trim();
    let selfClosing = false;
    if (raw.endsWith("/")) {
      selfClosing = true;
      raw = raw.slice(0, -1);
    }
    let nameEnd = 0;
    while (nameEnd < raw.length && !/[\s/]/.test(raw[nameEnd])) nameEnd++;
    const name = raw.slice(0, nameEnd).toLowerCase();
    if (!name) {
      i = end + 1;
      continue;
    }
    const attrs = parseHtmlAttributes(raw, nameEnd);
    i = end + 1;

    if (HTML_RAW_TEXT.has(name)) {
      const closeIndex = html.toLowerCase().indexOf("</" + name, i);
      const rawEnd = closeIndex < 0 ? n : closeIndex;
      const rawText = html.slice(i, rawEnd);
      const element: HtmlElement = { name, attrs, children: [] };
      if (name === "title" || name === "textarea") element.children.push(decodeHtmlText(rawText));
      nodes++;
      top().children.push(element);
      if (closeIndex < 0) i = n;
      else {
        const closeEnd = html.indexOf(">", closeIndex);
        i = closeEnd < 0 ? n : closeEnd + 1;
      }
      continue;
    }
    if (HTML_VOID.has(name) || selfClosing) {
      nodes++;
      if (nodes > MAX_HTML_NODES) {
        truncated = true;
        break;
      }
      top().children.push({ name, attrs, children: [] });
      continue;
    }
    impliedClose(name);
    if (!openElement({ name, attrs, children: [] })) break;
  }
  return { root, truncated };
}

// --- HTML: saneamento por lista de permissão --------------------------------

const HTML_ALLOWED = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
]);

/** Sem src/srcset: a imagem permanece referência textual, nunca buscada. */
const HTML_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  abbr: ["title"],
  img: ["alt"],
  li: ["value"],
  ol: ["start", "type"],
  q: ["cite"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "scope", "headers"],
  time: ["datetime"],
};

const HTML_DROP = new Set([
  "applet",
  "audio",
  "base",
  "basefont",
  "bgsound",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "optgroup",
  "option",
  "param",
  "plaintext",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
]);

const HTML_SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

export interface HtmlSanitizeResult {
  html: string;
  text: string;
  root: HtmlElement;
  removals: Record<string, number>;
  images: number;
  truncated: boolean;
}

function countRemoval(removals: Record<string, number>, key: string): void {
  removals[key] = (removals[key] ?? 0) + 1;
}

const HTML_COUNTED_WHEN_DROPPED = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "param",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "track",
  "video",
]);

function countEventAttributes(element: HtmlElement, removals: Record<string, number>): void {
  for (const key of Object.keys(element.attrs)) {
    if (key.startsWith("on")) countRemoval(removals, "atributo_evento");
  }
}

/** Conta o que foi descartado junto de um subárvore removida, sem manter nada. */
function countDroppedSubtree(element: HtmlElement, removals: Record<string, number>): void {
  countEventAttributes(element, removals);
  for (const child of element.children) {
    if (typeof child === "string") continue;
    const name = child.name.toLowerCase();
    if (HTML_COUNTED_WHEN_DROPPED.has(name)) {
      countRemoval(removals, name === "script" || name === "style" ? name : "elemento:" + name);
    }
    countDroppedSubtree(child, removals);
  }
}

function safeLinkTarget(
  value: string,
): { value: string | null; relative: boolean; reason: "empty" | "dangerous" | null } {
  const normalized = normalizeUrlPrefix(value);
  if (!normalized) return { value: null, relative: false, reason: "empty" };
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized);
  if (!scheme) return { value, relative: true, reason: null };
  if (!HTML_SAFE_SCHEMES.has(scheme[1] + ":")) {
    return { value: null, relative: false, reason: "dangerous" };
  }
  if (scheme[1] === "http" || scheme[1] === "https") {
    try {
      const url = new URL(value.trim());
      if (url.username || url.password) {
        return { value: null, relative: false, reason: "dangerous" };
      }
      return { value: url.href, relative: false, reason: null };
    } catch {
      return { value: null, relative: false, reason: "dangerous" };
    }
  }
  return { value: value.trim(), relative: false, reason: null };
}

function sanitizeElement(
  element: HtmlElement,
  removals: Record<string, number>,
  state: { images: number; nodes: number; truncated: boolean },
  depth: number,
): HtmlElement | null {
  if (element.name === "#root") {
    const root: HtmlElement = { name: "#root", attrs: {}, children: [] };
    for (const child of element.children) {
      const kept = typeof child === "string"
        ? (child.trim() ? child : "")
        : sanitizeElement(child, removals, state, depth + 1);
      if (kept) root.children.push(kept);
    }
    return root;
  }
  const name = element.name.toLowerCase();
  if (element.name.startsWith("#") || name === "") return null;
  if (HTML_DROP.has(name)) {
    countRemoval(removals, name === "script" || name === "style" ? name : "elemento:" + name);
    countDroppedSubtree(element, removals);
    if (
      name === "video" || name === "audio" || name === "canvas" || name === "object" ||
      name === "embed" || name === "iframe"
    ) {
      countRemoval(removals, "midia_nao_interpretada");
      return { name: "span", attrs: {}, children: ["[mídia não interpretada]"] };
    }
    return null;
  }
  if (!HTML_ALLOWED.has(name)) {
    // Elemento fora da lista mas não perigoso: mantém os filhos, descarta o nó.
    countRemoval(removals, "tag_nao_autorizada:" + name);
    countEventAttributes(element, removals);
    const wrapper: HtmlElement = { name: "span", attrs: {}, children: [] };
    for (const child of element.children) {
      const kept = typeof child === "string"
        ? child
        : sanitizeElement(child, removals, state, depth + 1);
      if (kept) wrapper.children.push(kept);
    }
    return wrapper.children.length ? wrapper : null;
  }
  state.nodes++;
  if (state.nodes > MAX_HTML_NODES || depth > MAX_HTML_DEPTH) {
    state.truncated = true;
    return null;
  }
  const attrs: Record<string, string> = {};
  const allowed = HTML_ATTRS[name] ?? [];
  for (const key of Object.keys(element.attrs)) {
    if (!allowed.includes(key) && key.startsWith("on")) countRemoval(removals, "atributo_evento");
  }
  for (const key of allowed) {
    const value = element.attrs[key];
    if (value === undefined) continue;
    if (key === "href" || key === "cite") {
      const safe = safeLinkTarget(value);
      if (safe.value === null) {
        if (safe.reason === "dangerous") countRemoval(removals, "url_perigosa");
        continue;
      }
      if (safe.relative) countRemoval(removals, "url_relativa_mantida_sem_resolucao");
      attrs[key] = safe.value;
      continue;
    }
    attrs[key] = value.slice(0, 2_000);
  }
  if (name === "a" && attrs.href === undefined) {
    // Âncora sem destino (href ausente, vazio ou recusado): vira texto simples.
    countRemoval(removals, "ancora_sem_destino");
    const wrapper: HtmlElement = { name: "span", attrs: {}, children: [] };
    for (const child of element.children) {
      const nested = typeof child === "string"
        ? sanitizeText(child.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""))
        : sanitizeElement(child, removals, state, depth + 1);
      if (nested) wrapper.children.push(nested);
    }
    return wrapper.children.length ? wrapper : null;
  }
  const kept: HtmlElement = { name, attrs, children: [] };
  if (name === "img") {
    state.images++;
    kept.children.push(element.attrs.alt ? "[imagem: " + element.attrs.alt + "]" : "[imagem]");
    return kept;
  }
  for (const child of element.children) {
    if (typeof child === "string") {
      const sanitized = sanitizeText(
        child.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""),
      );
      if (sanitized) kept.children.push(sanitized);
      continue;
    }
    const nested = sanitizeElement(child, removals, state, depth + 1);
    if (nested) kept.children.push(nested);
  }
  return kept;
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function serializeElement(
  element: HtmlElement,
  limit: number,
  state: { length: number; truncated: boolean },
): string {
  if (state.truncated) return "";
  const parts: string[] = [];
  const push = (value: string) => {
    if (state.truncated) return;
    if (state.length + value.length > limit) {
      state.truncated = true;
      return;
    }
    state.length += value.length;
    parts.push(value);
  };
  if (element.name === "#root") {
    for (const child of element.children) {
      push(
        typeof child === "string" ? escapeHtmlText(child) : serializeElement(child, limit, state),
      );
    }
    return parts.join("");
  }
  const attrs = Object.entries(element.attrs)
    .map(([key, value]) => " " + key + '="' + escapeHtmlAttr(value) + '"')
    .join("");
  if (
    element.name === "img" || element.name === "br" || element.name === "hr" ||
    element.name === "col"
  ) {
    push("<" + element.name + attrs + ">");
    for (const child of element.children) {
      push(
        typeof child === "string" ? escapeHtmlText(child) : serializeElement(child, limit, state),
      );
    }
    return parts.join("");
  }
  push("<" + element.name + attrs + ">");
  for (const child of element.children) {
    push(typeof child === "string" ? escapeHtmlText(child) : serializeElement(child, limit, state));
  }
  push("</" + element.name + ">");
  return parts.join("");
}

function textOfElement(element: HtmlElement, preserveWhitespace: boolean, limit: number): string {
  const parts: string[] = [];
  let length = 0;
  const preformatted = preserveWhitespace || element.name === "pre";
  for (const child of element.children) {
    if (length > limit) break;
    if (typeof child === "string") {
      const value = preformatted ? child : child.replace(/\s+/g, " ");
      parts.push(value);
      length += value.length;
    } else {
      const nested = textOfElement(child, preformatted, limit);
      const separator = nested && parts.length ? " " : "";
      parts.push(separator + nested);
      length += nested.length + separator.length;
    }
  }
  const joined = parts.join("");
  return preserveWhitespace ? joined.trim() : joined.replace(/\s+/g, " ").trim();
}

/**
 * Filtra HTML por lista de permissão e devolve a árvore limpa, o HTML
 * serializado e as remoções contadas. Nada é executado, nem buscado: sem src,
 * sem atributos de evento, sem javascript:/data: em href.
 */
export function sanitizeHtmlDocument(
  html: string,
  maxChars: number = MAX_SANITIZED_HTML_CHARS,
): HtmlSanitizeResult {
  const built = buildHtmlTree(html);
  const removals: Record<string, number> = {};
  const state = { images: 0, nodes: 0, truncated: built.truncated };
  const root = sanitizeElement(built.root, removals, state, 0) ??
    { name: "#root", attrs: {}, children: [] } as HtmlElement;
  const serialized = { length: 0, truncated: false };
  const serializedHtml = serializeElement(root, maxChars, serialized);
  return {
    html: serializedHtml,
    text: textOfElement(root, false, MAX_TEXT_CHARS),
    root,
    removals,
    images: state.images,
    truncated: state.truncated || serialized.truncated,
  };
}

// --- HTML: blocos com localizadores -----------------------------------------

interface HtmlWalkContext {
  options: ResolvedHtml;
  blocks: DocumentBlock[];
  gaps: Set<string>;
  removals: Record<string, number>;
  counters: { block: number; table: number; link: number; cells: number; images: number };
  blocksTruncated: boolean;
  textTruncated: boolean;
}

interface InlineTextState {
  text: string;
  links: ParagraphLink[];
  fields: string[];
}

function pushInlineText(state: InlineTextState, value: string, preserve: boolean): void {
  if (!value) return;
  if (preserve) {
    state.text += value;
    return;
  }
  let collapsed = value.replace(/\s+/g, " ");
  if (state.text === "" || state.text.endsWith(" ")) collapsed = collapsed.replace(/^ +/, "");
  if (collapsed === "" || collapsed === " " && state.text === "") return;
  state.text += collapsed;
}

function collectInline(
  element: HtmlElement,
  ctx: HtmlWalkContext,
  state: InlineTextState,
  preserve: boolean,
  skipBlocks: boolean,
): void {
  for (const child of element.children) {
    if (typeof child === "string") {
      pushInlineText(state, child, preserve || element.name === "pre");
      continue;
    }
    const name = child.name;
    if (skipBlocks && HTML_BLOCK_LEVEL.has(name)) continue;
    if (name === "a") {
      const start = state.text.length;
      collectInline(child, ctx, state, preserve, skipBlocks);
      const href = child.attrs.href ?? null;
      ctx.counters.link++;
      state.links.push({
        locator: htmlLinkLocator(ctx.counters.link),
        start,
        end: state.text.length,
        text: state.text.slice(start),
        target: href,
        relationship_id: null,
        anchor: href && href.startsWith("#") ? href.slice(1) : null,
        kind: href === null ? "unknown" : href.startsWith("#") ? "internal" : "external",
      });
      continue;
    }
    if (name === "br") {
      state.text += preserve ? "\n" : " ";
      continue;
    }
    if (name === "img") {
      ctx.counters.images++;
    }
    collectInline(child, ctx, state, preserve, skipBlocks);
  }
}

function htmlBlockText(
  element: HtmlElement,
  ctx: HtmlWalkContext,
  skipBlocks = false,
): { text: string; links: ParagraphLink[] } {
  const state: InlineTextState = { text: "", links: [], fields: [] };
  collectInline(element, ctx, state, element.name === "pre", skipBlocks);
  const text = state.text.replace(/\s+$/, "").replace(/^\s+/, "");
  return {
    text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
    links: state.links,
  };
}

function emitHtmlParagraph(
  element: HtmlElement,
  ctx: HtmlWalkContext,
  extras: {
    heading_level?: number | null;
    list?: ParagraphListInfo | null;
    quote?: boolean;
    code?: boolean;
  },
  skipBlocks = false,
): void {
  if (ctx.blocks.length >= ctx.options.maxBlocks) {
    ctx.blocksTruncated = true;
    return;
  }
  const { text, links } = htmlBlockText(element, ctx, skipBlocks);
  if (!text && !links.length) return;
  if (element.children.some((child) => typeof child !== "string" && child.name === "table")) {
    ctx.gaps.add("tabela_dentro_de_paragrafo_nao_destacada");
  }
  ctx.counters.block++;
  ctx.blocks.push({
    type: "paragraph",
    index: ctx.counters.block,
    locator: htmlBlockLocator(ctx.counters.block),
    text,
    char_count: text.length,
    heading_level: extras.heading_level ?? null,
    style_id: null,
    style_name: null,
    list: extras.list ?? null,
    quote: extras.quote === true,
    code: extras.code === true || element.name === "pre",
    spans: [],
    links,
    fields: [],
    image_count: 0,
    truncated: false,
  });
}

function emitHtmlTable(element: HtmlElement, ctx: HtmlWalkContext): void {
  if (ctx.blocks.length >= ctx.options.maxBlocks) {
    ctx.blocksTruncated = true;
    return;
  }
  const index = ++ctx.counters.table;
  const rows: TableCellBlock[][] = [];
  let columns = 0;
  let truncated = false;
  for (const child of element.children) {
    if (typeof child !== "string" && child.name === "caption") {
      ctx.gaps.add("legenda_de_tabela_nao_destacada");
      emitHtmlParagraph(child, ctx, {});
    }
  }
  const rowNodes: HtmlElement[] = [];
  const gatherRows = (node: HtmlElement) => {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      if (child.name === "tr") rowNodes.push(child);
      else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
        gatherRows(child);
      }
    }
  };
  gatherRows(element);
  for (const rowNode of rowNodes) {
    const rowIndex = rows.length + 1;
    const cells: TableCellBlock[] = [];
    let col = 1;
    for (const cellNode of rowNode.children) {
      if (typeof cellNode === "string") continue;
      if (cellNode.name !== "td" && cellNode.name !== "th") continue;
      if (ctx.counters.cells >= ctx.options.maxTableCells) {
        truncated = true;
        ctx.blocksTruncated = true;
        break;
      }
      ctx.counters.cells++;
      const colspan = Number.parseInt(cellNode.attrs.colspan ?? "1", 10);
      const rowspan = Number.parseInt(cellNode.attrs.rowspan ?? "1", 10);
      const span = Number.isInteger(colspan) && colspan >= 1 && colspan <= 64 ? colspan : 1;
      // A célula é bloco folha: seu texto inclui o que estiver dentro (p, div,
      // span), sem risco de duplicação, porque os filhos da célula não viram
      // blocos próprios.
      const text = htmlBlockText(cellNode, ctx, false).text;
      cells.push({
        locator: htmlTableLocator(index, rowIndex, col),
        row: rowIndex,
        col,
        grid_span: span,
        v_merge: Number.isInteger(rowspan) && rowspan > 1 ? "restart" : null,
        text,
        paragraphs: 1,
      });
      if (span > 1) ctx.gaps.add("celula_mesclada_horizontalmente");
      if (Number.isInteger(rowspan) && rowspan > 1) ctx.gaps.add("celula_mesclada_verticalmente");
      col += span;
    }
    columns = Math.max(columns, col - 1);
    rows.push(cells);
    if (truncated) break;
  }
  const text = rows
    .map((cells) => cells.map((cell) => cell.text.replace(/\n/g, " ")).join(" | "))
    .join("\n");
  ctx.blocks.push({
    type: "table",
    index,
    locator: htmlTableLocator(index),
    rows: rows.length,
    columns,
    cells: rows.flat(),
    text: text.slice(0, ctx.options.maxTextChars),
    truncated,
  });
}

const HTML_HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Percorre apenas os contêineres que viram blocos próprios dentro de um item de
 * lista ou parágrafo (listas aninhadas, tabelas e outros blocos), de modo que o
 * texto inline já capturado pelo bloco pai não seja duplicado.
 */
function walkNestedListBlocks(
  element: HtmlElement,
  ctx: HtmlWalkContext,
  list: ParagraphListInfo | null,
  depth: number,
): void {
  for (const child of element.children) {
    if (typeof child === "string") continue;
    if (child.name === "ul" || child.name === "ol") {
      const numFmt = child.name === "ol"
        ? (child.attrs.type === "a" ? "lowerLetter" : "decimal")
        : "bullet";
      walkHtmlBlocks(child, ctx, {
        level: (list?.level ?? -1) + 1,
        num_id: null,
        num_fmt: numFmt,
      }, depth + 1);
    } else if (child.name === "table") {
      emitHtmlTable(child, ctx);
    } else if (HTML_BLOCK_LEVEL.has(child.name) && child.children.length) {
      // Somente contêineres de bloco: o texto inline do pai já foi capturado,
      // e descer num <span>/<b>/<a> duplicaria o mesmo trecho.
      walkHtmlBlocks(child, ctx, list, depth + 1);
    }
  }
}

const HTML_PASSTHROUGH = new Set([
  "article",
  "aside",
  "body",
  "details",
  "div",
  "dl",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "section",
  "span",
  "summary",
  "#root",
]);

function walkHtmlBlocks(
  element: HtmlElement,
  ctx: HtmlWalkContext,
  list: ParagraphListInfo | null,
  depth: number,
): void {
  if (depth > MAX_HTML_DEPTH) {
    ctx.gaps.add("aninhamento_profundo_nao_interpretado");
    return;
  }
  for (const child of element.children) {
    if (typeof child === "string") {
      const text = child.replace(/\s+/g, " ").trim();
      if (text) emitHtmlParagraph({ name: "p", attrs: {}, children: [text] }, ctx, { list });
      continue;
    }
    const name = child.name;
    if (HTML_HEADINGS.has(name)) {
      emitHtmlParagraph(child, ctx, { heading_level: Number.parseInt(name.slice(1), 10) }, true);
      continue;
    }
    if (name === "p") {
      emitHtmlParagraph(child, ctx, { list }, true);
      walkNestedListBlocks(child, ctx, list, depth + 1);
      continue;
    }
    if (name === "li") {
      const parentList = list ?? { level: 0, num_id: null, num_fmt: "bullet" };
      emitHtmlParagraph(child, ctx, { list: parentList }, true);
      walkNestedListBlocks(child, ctx, parentList, depth + 1);
      continue;
    }
    if (name === "ul" || name === "ol") {
      const numFmt = name === "ol"
        ? (child.attrs.type === "a" ? "lowerLetter" : "decimal")
        : "bullet";
      walkHtmlBlocks(
        child,
        ctx,
        { level: (list?.level ?? -1) + 1, num_id: null, num_fmt: numFmt },
        depth + 1,
      );
      continue;
    }
    if (name === "blockquote") {
      emitHtmlParagraph(child, ctx, { quote: true }, true);
      // O texto inline vira citação; parágrafos/listas internos viram blocos
      // próprios, em vez de se perderem dentro da citação.
      walkNestedListBlocks(child, ctx, list, depth + 1);
      continue;
    }
    if (name === "pre") {
      emitHtmlParagraph(child, ctx, { code: true }, true);
      continue;
    }
    if (name === "table") {
      emitHtmlTable(child, ctx);
      continue;
    }
    if (name === "a") {
      emitHtmlParagraph(child, ctx, {});
      continue;
    }
    if (
      name === "caption" || name === "col" || name === "colgroup" || name === "hr" || name === "br"
    ) {
      if (name === "caption") {
        ctx.gaps.add("legenda_de_tabela_nao_destacada");
        emitHtmlParagraph(child, ctx, {});
      }
      continue;
    }
    if (name === "dt" || name === "dd") {
      emitHtmlParagraph(child, ctx, {
        list: {
          level: (list?.level ?? -1) + 1,
          num_id: null,
          num_fmt: name === "dt" ? "term" : "definition",
        },
      }, true);
      continue;
    }
    if (HTML_PASSTHROUGH.has(name) || !HTML_ALLOWED.has(name)) {
      walkHtmlBlocks(child, ctx, list, depth + 1);
      continue;
    }
    emitHtmlParagraph(child, ctx, { list });
  }
}

function decodeHtmlBytes(bytes: Uint8Array): { html: string; charset: string } {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.:+-]+)/i.exec(head);
  let charset = meta ? meta[1].toLowerCase() : "utf-8";
  if (charset === "utf8") charset = "utf-8";
  if (!/^[a-z0-9_.:+-]+$/.test(charset)) charset = "utf-8";
  try {
    return { html: new TextDecoder(charset).decode(bytes), charset };
  } catch {
    return { html: new TextDecoder("utf-8").decode(bytes), charset: "utf-8" };
  }
}

function htmlLimits(options: ResolvedHtml): string[] {
  return [
    "Somente leitura: nenhum script, estilo ou atributo de evento é executado ou buscado.",
    "Bytes do HTML: limite " + options.maxBytes + ".",
    "Blocos: até " + options.maxBlocks +
    "; caracteres por bloco: até " + options.maxTextChars + ".",
    "HTML saneado: até " + options.maxSanitizedChars + " caracteres.",
  ];
}

/**
 * Extrai blocos estruturados de um HTML de Book/Page: títulos, parágrafos,
 * itens de lista, citações, blocos de código, tabelas/células e hiperlinks,
 * com HTML saneado (sem script/evento/URL perigosa) e localizadores estáveis.
 */
export async function extractHtmlText(
  input: Uint8Array | string,
  options: HtmlExtractionOptions = {},
): Promise<DocumentTextExtraction> {
  const resolved = resolveHtmlOptions(options);
  const startedAt = performance.now();
  const limits = htmlLimits(resolved);
  let bytes: Uint8Array;
  let html: string;
  if (typeof input === "string") {
    html = input;
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
    html = "";
  } else {
    throw new HubError("invalid_document_input", "A entrada deve ser string ou Uint8Array.");
  }
  const context: ResultContext = { byteLength: bytes.byteLength, startedAt, limits };
  if (bytes.byteLength === 0) {
    return errorResult("html", "html_empty", "HTML vazio.", context);
  }
  if (bytes.byteLength > resolved.maxBytes) {
    return errorResult(
      "html",
      "oversized",
      "HTML acima do limite de bytes; não processado.",
      context,
    );
  }
  try {
    const decoded = typeof input === "string" ? { html, charset: "utf-8" } : decodeHtmlBytes(bytes);
    const sanitized = sanitizeHtmlDocument(decoded.html, resolved.maxSanitizedChars);

    const ctx: HtmlWalkContext = {
      options: resolved,
      blocks: [],
      gaps: new Set<string>(),
      removals: sanitized.removals,
      counters: { block: 0, table: 0, link: 0, cells: 0, images: 0 },
      blocksTruncated: false,
      textTruncated: false,
    };
    walkHtmlBlocks(sanitized.root, ctx, null, 0);
    for (const [key, count] of Object.entries(sanitized.removals)) {
      if (count <= 0) continue;
      if (key === "script" || key === "style") continue;
      ctx.gaps.add("html_removido:" + key);
    }
    if (sanitized.images > 0) ctx.gaps.add("imagens_nao_interpretadas");

    let paragraphCount = 0;
    let headingCount = 0;
    let listCount = 0;
    let tableCount = 0;
    let cellCount = 0;
    let linkCount = 0;
    let characters = 0;
    for (const block of ctx.blocks) {
      if (block.type === "table") {
        tableCount++;
        cellCount += block.cells.length;
        characters += block.text.length;
        continue;
      }
      paragraphCount++;
      if (block.heading_level !== null) headingCount++;
      if (block.list) listCount++;
      linkCount += block.links.length;
      characters += block.char_count;
    }
    const semanticGap = [...ctx.gaps].some((gap) =>
      gap.startsWith("html_removido:") || gap.startsWith("midia") ||
      gap === "imagens_nao_interpretadas" || gap.startsWith("celula_mesclada") ||
      gap === "aninhamento_profundo_nao_interpretado"
    );
    const notes = [UNTRUSTED_NOTE, NO_EXECUTION_NOTE];
    if (!ctx.blocks.length) notes.push("Nenhum bloco de conteúdo foi encontrado no HTML.");
    if (decoded.charset !== "utf-8") notes.push("Codificação declarada: " + decoded.charset + ".");

    return {
      kind: "document_text_extraction",
      format: "html",
      ok: true,
      coverage: ctx.blocksTruncated || sanitized.truncated || semanticGap ? "partial" : "complete",
      execution: "in_process",
      hard_timeout: false,
      blocks: ctx.blocks,
      block_count: ctx.blocks.length,
      paragraph_count: paragraphCount,
      heading_count: headingCount,
      list_item_count: listCount,
      table_count: tableCount,
      cell_count: cellCount,
      link_count: linkCount,
      image_count: sanitized.images,
      field_count: 0,
      characters,
      text_truncated: sanitized.truncated,
      blocks_truncated: ctx.blocksTruncated,
      sanitized_html: sanitized.html,
      sanitizer_removals: sanitized.removals,
      metadata: decoded.charset === "utf-8" ? {} : { charset: decoded.charset },
      parts_read: [],
      gaps: [...ctx.gaps].sort(),
      media_type: "text/html",
      limits,
      notes,
      errors: [],
      content_is_untrusted_data: true,
      byte_length: bytes.byteLength,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    if (error instanceof XmlError || error instanceof ZipError) {
      return errorResult("html", error.code, error.message, context);
    }
    return errorResult(
      "html",
      "unreadable",
      "Falha ao ler o HTML sem classificação específica.",
      context,
    );
  }
}
