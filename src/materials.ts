import { Buffer } from "node:buffer";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { type Coverage, HubError, type Principal } from "./contracts.ts";
import type { ConnectionService } from "./connections.ts";
import type { MoodleRecord } from "./adapters/moodle.ts";
import {
  DEFAULT_PDF_MAX_BYTES,
  extractPdfText,
  MAX_PDF_MAX_PAGES,
  MAX_PDF_PAGE_CHARS,
  MAX_PDF_TOTAL_CHARS,
  pdfExtractionToText,
  pdfPageLocator,
  type PdfPageText,
  type PdfTextExtraction,
} from "./pdf_text.ts";
import { sha256Hex } from "./migration.ts";
import { z } from "zod";

/** Limites da extração relatada pelo cliente (navegador). */
const MAX_CLIENT_PAGES = MAX_PDF_MAX_PAGES; // 500 páginas por lote
const MAX_CLIENT_PAGE_CHARS = MAX_PDF_PAGE_CHARS; // 100 000 por página
const MAX_CLIENT_TOTAL_CHARS = MAX_PDF_TOTAL_CHARS; // 1 000 000 no total
const MAX_CLIENT_DOCUMENT_PAGES = 10_000; // documento declarado
const COVERAGE_VALUES = new Set<string>([
  "complete",
  "partial",
  "denied",
  "unavailable",
  "expired",
  "timeout",
  "parsing_error",
]);
const ERROR_COVERAGE: Record<string, Coverage> = {
  empty_input: "parsing_error",
  invalid_pdf: "parsing_error",
  unreadable: "parsing_error",
  encrypted: "denied",
  timeout: "timeout",
  aborted: "timeout",
  oversized: "unavailable",
  worker_unavailable: "unavailable",
  pdf_runtime_unavailable: "unavailable",
};
/** Nota fixa: a extração do cliente não é corroborada pelo servidor. */
const CLIENT_UNVERIFIED_NOTE =
  "Extração relatada pelo cliente (navegador): a autenticidade e a completude não são corroboradas pelo servidor; o texto permanece dado não confiável e não verificado.";
const CLIENT_LIMIT_NOTE =
  "Execução no navegador: 50 páginas por padrão (máximo 500 por lote), 20 000 caracteres por página (máximo 100 000) e 400 000 no total (máximo 1 000 000).";

const finiteNumber = z.number().finite();
const pdfIssueSchema = z.object({
  scope: z.enum(["document", "page"]),
  page: z.number().int().min(1).max(MAX_CLIENT_DOCUMENT_PAGES).nullable(),
  code: z.string().min(1).max(100),
  message: z.string().max(2_000),
}).strict();
const pdfPageSchema = z.object({
  page: z.number().int().min(1).max(MAX_CLIENT_DOCUMENT_PAGES),
  locator: z.string().min(1).max(200),
  text: z.string().max(MAX_CLIENT_PAGE_CHARS),
  char_count: z.number().int().min(0).max(MAX_CLIENT_PAGE_CHARS),
  has_text: z.boolean(),
  text_absent: z.boolean(),
  truncated: z.boolean(),
  image_count: z.number().int().min(0).max(1_000_000),
  ocr: z.literal("not_performed"),
  bounds: z.object({
    width_pt: finiteNumber.min(0).max(1_000_000),
    height_pt: finiteNumber.min(0).max(1_000_000),
    rotate: z.number().int().min(-360).max(360),
  }).strict(),
}).strict();
const clientExtractionSchema = z.object({
  kind: z.literal("pdf_text_extraction"),
  ok: z.boolean(),
  error_code: z.enum([
    "empty_input",
    "oversized",
    "invalid_pdf",
    "encrypted",
    "timeout",
    "aborted",
    "worker_unavailable",
    "pdf_runtime_unavailable",
    "unreadable",
  ]).optional(),
  coverage: z.enum([
    "complete",
    "partial",
    "denied",
    "unavailable",
    "expired",
    "timeout",
    "parsing_error",
  ]),
  execution: z.literal("isolated_worker"),
  hard_timeout: z.literal(true),
  page_count: z.number().int().min(0).max(MAX_CLIENT_DOCUMENT_PAGES).nullable(),
  pages_returned: z.number().int().min(0).max(MAX_CLIENT_PAGES),
  pages: z.array(pdfPageSchema).max(MAX_CLIENT_PAGES),
  page_bounds: z.object({
    first_page: z.number().int().min(1).max(MAX_CLIENT_DOCUMENT_PAGES).nullable(),
    last_page: z.number().int().min(1).max(MAX_CLIENT_DOCUMENT_PAGES).nullable(),
    pages_in_document: z.number().int().min(0).max(MAX_CLIENT_DOCUMENT_PAGES).nullable(),
    pages_returned: z.number().int().min(0).max(MAX_CLIENT_PAGES),
  }).strict(),
  omitted_pages: z.array(z.number().int().min(1).max(MAX_CLIENT_DOCUMENT_PAGES)).max(
    MAX_CLIENT_DOCUMENT_PAGES,
  ),
  errors: z.array(pdfIssueSchema).max(2_000),
  images_not_interpreted: z.literal(true),
  images_detected: z.number().int().min(0).max(100_000_000),
  ocr: z.literal("not_performed"),
  pages_without_text: z.number().int().min(0).max(MAX_CLIENT_PAGES),
  text_truncated: z.boolean(),
  limits: z.array(z.string().max(1_000)).max(64),
  notes: z.array(z.string().max(2_000)).max(64),
  content_is_untrusted_data: z.literal(true),
  byte_length: z.number().int().min(0).max(DEFAULT_PDF_MAX_BYTES),
  elapsed_ms: finiteNumber.min(0).max(3_600_000),
}).strict();
type ClientExtraction = z.infer<typeof clientExtractionSchema>;

function invalidExtraction(message: string): HubError {
  return new HubError("invalid_extraction", message, 422);
}

/** Esta rota é da sessão pessoal da interface; MCP não grava fingindo cliente. */
function assertClientSession(p: Principal): void {
  if (p.clientId) {
    throw new HubError(
      "client_denied",
      "Esta rota exige uma sessão pessoal da interface; uma sessão MCP não grava extrações em nome do cliente.",
      403,
    );
  }
}

function listCoverage(extraction: unknown): string {
  const coverage = (extraction as { coverage?: unknown } | null | undefined)?.coverage;
  return typeof coverage === "string" && COVERAGE_VALUES.has(coverage) ? coverage : "not_extracted";
}

function storedPageCount(extraction: unknown): number | null {
  const stored = extraction as {
    page_count?: unknown;
    page_bounds?: { pages_in_document?: unknown };
  } | null;
  for (const value of [stored?.page_count, stored?.page_bounds?.pages_in_document]) {
    if (
      typeof value === "number" && Number.isInteger(value) && value >= 1 &&
      value <= MAX_CLIENT_DOCUMENT_PAGES
    ) return value;
  }
  return null;
}

/**
 * Primeira página ausente ou truncada da memória guardada, para o cliente
 * retomar do ponto certo. Sem páginas guardadas, começa em 1; sem total
 * declarado, continua depois da última página conhecida; completo devolve null.
 * Uma página sem texto (text_absent) foi extraída e não conta como lacuna.
 */
function nextPageFor(extraction: unknown): number | null {
  const pages = storedPages(extraction);
  if (!pages.length) return 1;
  const present = new Set(pages.map((page) => page.page));
  const truncated = new Set(
    pages.filter((page) => page.truncated === true).map((page) => page.page),
  );
  const declared = storedPageCount(extraction);
  const limit = declared ?? Math.max(...present);
  for (let number = 1; number <= limit; number++) {
    if (!present.has(number)) return number; // lacunas primeiro
  }
  for (let number = 1; number <= limit; number++) {
    if (truncated.has(number)) return number; // depois retomadas truncadas
  }
  return declared === null ? limit + 1 : null;
}

function sanitizeClientText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(
    /\r\n?/g,
    "\n",
  );
}

function parseClientExtraction(raw: unknown): ClientExtraction {
  try {
    return clientExtractionSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw invalidExtraction(
        "A extração enviada não tem o formato aceito (campos ausentes, tipos inválidos ou campos extras).",
      );
    }
    throw error;
  }
}

/** Confere invariantes que o zod não expressa; não corrige, recusa. */
function validateClientExtraction(input: ClientExtraction): void {
  if (input.pages_returned !== input.pages.length) {
    throw invalidExtraction("O número de páginas relatado não corresponde à lista enviada.");
  }
  const seen = new Set<number>();
  let chars = 0, withoutText = 0, images = 0;
  for (const page of input.pages) {
    if (seen.has(page.page)) {
      throw invalidExtraction("Há páginas repetidas na extração; os índices precisam ser únicos.");
    }
    seen.add(page.page);
    if (input.page_count !== null && page.page > input.page_count) {
      throw invalidExtraction("Uma página excede o total de páginas declarado no documento.");
    }
    if (page.char_count !== page.text.length) {
      throw invalidExtraction(
        "A contagem de caracteres de uma página não corresponde ao texto enviado.",
      );
    }
    if (page.locator !== pdfPageLocator(page.page)) {
      throw invalidExtraction("O localizador de uma página não corresponde ao formato pdf:page:N.");
    }
    if (
      page.has_text !== (page.text.length > 0) || page.text_absent !== (page.text.length === 0)
    ) throw invalidExtraction("Os indicadores de texto de uma página não correspondem ao texto.");
    chars += page.text.length;
    if (page.text.length === 0) withoutText++;
    images += page.image_count;
  }
  if (chars > MAX_CLIENT_TOTAL_CHARS) {
    throw invalidExtraction("O texto enviado excede o limite total de caracteres.");
  }
  if (input.images_detected !== images) {
    throw invalidExtraction("A contagem de imagens não corresponde às páginas enviadas.");
  }
  if (input.pages_without_text !== withoutText) {
    throw invalidExtraction("A contagem de páginas sem texto não corresponde às páginas enviadas.");
  }
  if (input.ok === false && input.error_code === undefined) {
    throw invalidExtraction("Uma execução com falha precisa informar o código do erro.");
  }
}

/** Deriva a extração guardável a partir do relato do cliente, sem confiar nele. */
function normalizeClientExtraction(
  input: ClientExtraction,
  storedBytes: number,
): PdfTextExtraction {
  const ordered = [...input.pages].sort((a, b) => a.page - b.page);
  const pages: PdfPageText[] = ordered.map((page) => {
    const text = sanitizeClientText(page.text);
    return {
      page: page.page,
      locator: pdfPageLocator(page.page),
      text,
      char_count: text.length,
      has_text: text.length > 0,
      text_absent: text.length === 0,
      truncated: page.truncated || text.length >= MAX_CLIENT_PAGE_CHARS,
      image_count: page.image_count,
      ocr: "not_performed",
      bounds: {
        width_pt: page.bounds.width_pt,
        height_pt: page.bounds.height_pt,
        rotate: page.bounds.rotate,
      },
    };
  });
  const totalChars = pages.reduce((sum, page) => sum + page.char_count, 0);
  const errors: PdfTextExtraction["errors"] = input.errors.map((issue) => ({
    scope: issue.scope,
    page: issue.page,
    code: issue.code,
    message: issue.message,
  }));
  // Uma execução que se declarou falha nunca pode virar "completa" no servidor.
  if (!input.ok && !errors.some((issue) => issue.scope === "document")) {
    errors.unshift({
      scope: "document",
      page: null,
      code: input.error_code ?? "unreadable",
      message: "A execução no cliente relatou falha; resultado tratado como dado não verificado.",
    });
  }
  const omitted: number[] = [];
  if (input.page_count !== null) {
    const present = new Set(pages.map((page) => page.page));
    for (let number = 1; number <= input.page_count; number++) {
      if (!present.has(number)) omitted.push(number);
    }
  }
  const coverage: Coverage = !input.ok
    ? (ERROR_COVERAGE[input.error_code ?? ""] ?? "parsing_error")
    : pages.length > 0
    ? "complete"
    : "partial";
  return {
    kind: "pdf_text_extraction",
    ok: input.ok,
    ...(input.error_code !== undefined ? { error_code: input.error_code } : {}),
    coverage,
    execution: "isolated_worker",
    hard_timeout: true,
    page_count: input.page_count,
    pages_returned: pages.length,
    pages,
    page_bounds: {
      first_page: pages.length ? pages[0].page : null,
      last_page: pages.length ? pages[pages.length - 1].page : null,
      pages_in_document: input.page_count,
      pages_returned: pages.length,
    },
    omitted_pages: omitted,
    errors,
    images_not_interpreted: true,
    images_detected: pages.reduce((sum, page) => sum + page.image_count, 0),
    ocr: "not_performed",
    pages_without_text: pages.filter((page) => !page.has_text).length,
    text_truncated: input.text_truncated || pages.some((page) => page.truncated) ||
      totalChars >= MAX_CLIENT_TOTAL_CHARS,
    limits: [...input.limits, CLIENT_LIMIT_NOTE],
    notes: [...input.notes, CLIENT_UNVERIFIED_NOTE],
    content_is_untrusted_data: true,
    byte_length: storedBytes,
    elapsed_ms: input.elapsed_ms,
  };
}

function locate(value: unknown, fileId: string, parent?: MoodleRecord): MoodleRecord | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = locate(child, fileId, parent);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const row = value as MoodleRecord;
  if (row.file_id === fileId) return parent ?? row;
  const module = typeof row.modname === "string" ? row : parent;
  for (const child of Object.values(row)) {
    const found = locate(child, fileId, module);
    if (found) return found;
  }
  return null;
}

/** Página já guardada em hub_files.extraction; o texto continua sendo dado. */
type StoredPage = Partial<PdfPageText> & { page: number };

function storedPages(extraction: unknown): StoredPage[] {
  if (!extraction || typeof extraction !== "object") return [];
  const pages = (extraction as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return [];
  const found: StoredPage[] = [];
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const number = (page as { page?: unknown }).page;
    if (!Number.isInteger(number) || (number as number) < 1) continue;
    found.push(page as StoredPage);
  }
  return found;
}

/** Página sem texto vale zero; entre duas com texto, mais caracteres vencem. */
function pageScore(page: StoredPage): number {
  if (page.has_text === false) return 0;
  if (typeof page.char_count === "number") return page.char_count;
  return typeof page.text === "string" ? page.text.length : 0;
}

function pageHasText(page: StoredPage): boolean {
  return page.has_text !== false && pageScore(page) > 0;
}

interface PageMerge {
  pages: StoredPage[];
  unchanged: boolean;
  added: number;
  updated: number;
  retained: number[];
  priorCount: number;
}

/**
 * Merge por número de página entre a extração guardada e a nova execução.
 * Regras: a página com mais caracteres vence, de modo que um decode posterior
 * mais fraco (limite, timeout, indisponibilidade) nunca apaga texto já
 * extraído do mesmo hash; empate mantém a versão guardada, para que um retry
 * idêntico não reescreva a memória.
 */
function mergePdfPages(prior: StoredPage[], run: PdfPageText[]): PageMerge {
  const byPage = new Map<number, { page: StoredPage; fromPrior: boolean }>();
  for (const page of prior) byPage.set(page.page, { page, fromPrior: true });
  let added = 0, updated = 0;
  const retained: number[] = [];
  for (const incoming of run) {
    const current = byPage.get(incoming.page);
    if (!current) {
      byPage.set(incoming.page, { page: incoming, fromPrior: false });
      added++;
    } else if (pageScore(incoming) > pageScore(current.page)) {
      byPage.set(incoming.page, { page: incoming, fromPrior: false });
      updated++;
    } else {
      retained.push(incoming.page);
    }
  }
  const ordered = [...byPage.values()].sort((a, b) => a.page.page - b.page.page);
  return {
    pages: ordered.map((entry) => entry.page),
    unchanged: ordered.length === prior.length && ordered.every((entry) => entry.fromPrior),
    added,
    updated,
    retained: retained.sort((a, b) => a - b),
    priorCount: prior.length,
  };
}

function priorCoverage(extraction: unknown, fallback: Coverage): Coverage {
  const coverage = (extraction as { coverage?: unknown } | null)?.coverage;
  return typeof coverage === "string" ? coverage as Coverage : fallback;
}

/**
 * Pages declaradas pelo documento sob lock: a execução corrente é a fonte,
 * mas a contagem guardada do MESMO hash nunca é reduzida. Assim um relato com
 * page_count forjado menor não promove cobertura completa.
 */
function mergedPageCount(run: PdfTextExtraction, extraction: unknown): number | null {
  const runCount = typeof run.page_count === "number" ? run.page_count : null;
  const storedCount = storedPageCount(extraction);
  if (runCount === null) return storedCount;
  if (storedCount === null) return runCount;
  return Math.max(runCount, storedCount);
}

/**
 * Cobertura da memória retida: completa só quando todas as páginas declaradas
 * estão presentes, nenhuma delas ficou truncada e a execução não relatou erro
 * de documento/página nem corte de texto. Imagem, assinatura ou anexo nunca
 * promovem cobertura; um decode com erro não vira "completo" por herança.
 */
function mergedCoverage(
  pages: StoredPage[],
  pageCount: number | null,
  run: PdfTextExtraction,
): Coverage {
  if (!pages.length) return run.coverage;
  const truncated = pages.some((page) => page.truncated === true);
  const covered = pageCount !== null && pages.length === pageCount && !truncated &&
    run.errors.length === 0 && run.text_truncated === false;
  return covered ? "complete" : "partial";
}

interface StoredPdfExtraction extends PdfTextExtraction {
  complete: boolean;
  text_available: boolean;
  merge: Record<string, unknown>;
  origin?: string;
  provenance?: Record<string, unknown>;
}

/** Anotação de origem acrescentada à memória sem tocar nos campos derivados. */
interface MergeExtra {
  origin?: string;
  provenance?: Record<string, unknown>;
  notes?: string[];
}

function buildStoredExtraction(
  run: PdfTextExtraction,
  merge: PageMerge,
  coverage: Coverage,
  pageCount: number | null,
  extra: MergeExtra = {},
): StoredPdfExtraction {
  const pages = merge.pages;
  const omitted: number[] = [];
  if (pageCount !== null) {
    const present = new Set(pages.map((page) => page.page));
    for (let number = 1; number <= pageCount; number++) {
      if (!present.has(number)) omitted.push(number);
    }
  }
  const images = pages.reduce(
    (sum, page) => sum + (typeof page.image_count === "number" ? page.image_count : 0),
    0,
  );
  const stored: StoredPdfExtraction = {
    ...run,
    kind: "pdf_text_extraction",
    ok: pages.length > 0,
    coverage,
    complete: coverage === "complete",
    text_available: pages.some(pageHasText),
    page_count: pageCount,
    pages_returned: pages.length,
    pages: pages.map((page) => ({ locator: pdfPageLocator(page.page), ...page })) as PdfPageText[],
    page_bounds: {
      first_page: pages.length ? pages[0].page : null,
      last_page: pages.length ? pages[pages.length - 1].page : null,
      pages_in_document: pageCount,
      pages_returned: pages.length,
    },
    omitted_pages: omitted,
    images_detected: images,
    pages_without_text: pages.filter((page) => !pageHasText(page)).length,
    text_truncated: pages.some((page) => page.truncated === true),
    notes: [...run.notes, ...(extra.notes ?? [])],
    merge: {
      strategy: "merge_page_text_keep_more_chars",
      run_coverage: run.coverage,
      run_ok: run.ok,
      run_error_code: run.error_code ?? null,
      run_pages: run.pages.length,
      prior_pages: merge.priorCount,
      pages_added: merge.added,
      pages_updated: merge.updated,
      pages_retained: merge.retained,
    },
    content_is_untrusted_data: true,
  };
  if (extra.origin !== undefined) stored.origin = extra.origin;
  if (extra.provenance !== undefined) stored.provenance = extra.provenance;
  // A memória só declara erro da última execução quando ela mesma está incompleta.
  if (coverage === "complete" || run.error_code === undefined) delete stored.error_code;
  else stored.error_code = run.error_code;
  return stored;
}

/** A file locator comes only from a fresh authorized course response, never an arbitrary URL. */
export class Materials {
  /** `connections` é opcional: extração/leitura de páginas servem arquivos já
   * preservados offline; só os caminhos Moodle exigem a conexão autorizada. */
  constructor(private hub: Hub, private connections?: ConnectionService) {}
  /**
   * Merge da execução com a memória guardada sob lock da linha. Compartilhado
   * por extractPdf (execução local) e commitClientPdf (extração do navegador):
   * a página com mais texto vence, um retry mais fraco nunca apaga o que já
   * existe e a cobertura é sempre derivada no servidor.
   */
  private async mergePdfExtraction(
    p: Principal,
    fileId: string,
    hash: string,
    run: PdfTextExtraction,
    extra: MergeExtra = {},
    options: { verifyBinary?: boolean } = {},
  ) {
    return await asOwner(this.hub.db, p, async (tx) => {
      // O digest binário é conferido no mesmo lock do merge: metadados não
      // bastam se os bytes preservados do dono foram adulterados.
      const rows = options.verifyBinary
        ? await tx`select extraction,encode(extensions.digest(binary_content,'sha256'),'hex') as binary_sha from public.hub_files where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash} for update`
        : await tx`select extraction from public.hub_files where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash} for update`;
      if (!rows.length) {
        throw new HubError("file_changed", "Recupere a versão atual do arquivo.", 409);
      }
      if (options.verifyBinary && rows[0].binary_sha !== hash) {
        throw new HubError(
          "file_integrity",
          "Os bytes preservados não correspondem ao hash registrado.",
          409,
        );
      }
      const locked = rows[0].extraction;
      const prior = storedPages(locked);
      const merge = mergePdfPages(prior, run.pages);
      // Nunca reduzir a contagem declarada do mesmo hash.
      const pageCount = mergedPageCount(run, locked);
      const coverage: Coverage = merge.unchanged && merge.priorCount > 0
        ? priorCoverage(locked, run.coverage)
        : mergedCoverage(merge.pages, pageCount, run);
      let memory_updated = false;
      if (merge.pages.length && !merge.unchanged) {
        const memory = buildStoredExtraction(run, merge, coverage, pageCount, extra);
        await tx`update public.hub_files set extracted_text=${
          pdfExtractionToText(memory)
        },extraction=${
          tx.json(JSON.parse(JSON.stringify(memory)))
        } where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash}`;
        memory_updated = true;
      }
      return { memory_updated, merge, coverage };
    });
  }
  async extractPdf(p: Principal, fileId: string, hash: string, maxPages = 50) {
    const stored = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`select id,mime_type,sha256,binary_content,bytes from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`)[
          0
        ],
    );
    if (!stored) throw new HubError("not_found", "Arquivo não encontrado.", 404);
    if (stored.sha256 !== hash) {
      throw new HubError("file_changed", "Recupere a versão atual do arquivo.", 409);
    }
    if (stored.mime_type !== "application/pdf" || !stored.binary_content) {
      throw new HubError("pdf_required", "Este registro não contém um PDF preservado.");
    }
    const bytes = new Uint8Array(stored.binary_content);
    if (await sha256Hex(bytes) !== hash) {
      throw new HubError("file_integrity", "Os bytes não correspondem ao hash registrado.", 409);
    }
    const result = await extractPdfText(bytes, { maxPages });
    // A execução roda fora da transação; a leitura-merge-escrita acontece sob
    // lock da linha no método compartilhado com a extração do cliente. Assim um
    // extrator concorrente que gravou uma extração melhor não é sobrescrito
    // pelo snapshot anterior, e uma execução limitada/indisponível nunca
    // destrói páginas já extraídas do mesmo hash.
    const outcome = await this.mergePdfExtraction(p, fileId, hash, result);
    return {
      file_id: fileId,
      sha256: hash,
      memory_updated: outcome.memory_updated,
      extraction: { ...result, pages: result.pages.map(({ text: _text, ...page }) => page) },
      memory: {
        coverage: outcome.coverage,
        complete: outcome.coverage === "complete",
        text_available: outcome.merge.pages.some(pageHasText),
        pages: outcome.merge.pages.length,
        pages_from_prior: outcome.merge.retained.length,
        pages_added: outcome.merge.added,
        pages_updated: outcome.merge.updated,
        ocr: "not_performed" as const,
      },
      content_is_untrusted_data: true,
    };
  }
  async pdfPage(p: Principal, fileId: string, hash: string, pageNumber: number) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new HubError("invalid_page", "Página inválida.");
    }
    const file = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`select id,name,sha256,extraction from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`)[
          0
        ],
    );
    if (!file) throw new HubError("not_found", "Arquivo não encontrado.", 404);
    if (file.sha256 !== hash) {
      throw new HubError("file_changed", "Recupere a versão atual do arquivo.", 409);
    }
    const page = (file.extraction.pages ?? []).find((row: { page: number }) =>
      row.page === pageNumber
    );
    return {
      file_id: fileId,
      name: file.name,
      sha256: hash,
      page: page ?? null,
      coverage: page ? file.extraction.coverage : "page_not_extracted",
      limits: file.extraction.limits ?? [],
      ocr: file.extraction.ocr ?? "not_performed",
      content_is_untrusted_data: true,
    };
  }
  /**
   * Lista os PDFs preservados do dono em keyset id ASC (lote de 20). O campo
   * next_page marca a primeira página ausente ou truncada da memória, para o
   * cliente retomar a extração no navegador; completo devolve null.
   */
  async listPdf(p: Principal, after?: string) {
    assertClientSession(p);
    if (after !== undefined && !/^[0-9a-f-]{36}$/i.test(after)) {
      throw new HubError("invalid_query", "Cursor inválido.", 400);
    }
    return await asOwner(this.hub.db, p, async (tx) => {
      const rows = after
        ? await tx`select id,name,sha256,bytes::integer as bytes, jsonb_build_object('coverage', extraction->'coverage', 'page_count', extraction->'page_count', 'page_bounds', extraction->'page_bounds', 'pages', case when jsonb_typeof(extraction->'pages')='array' then (select coalesce(jsonb_agg(jsonb_build_object('page', pg->'page', 'truncated', coalesce(pg->'truncated','false'::jsonb))), '[]'::jsonb) from jsonb_array_elements(extraction->'pages') as pg) else '[]'::jsonb end) as extraction from public.hub_files where owner_id=${p.ownerId} and mime_type=${"application/pdf"} and binary_content is not null and bytes <= ${DEFAULT_PDF_MAX_BYTES} and id > ${after}::uuid order by id limit 21`
        : await tx`select id,name,sha256,bytes::integer as bytes, jsonb_build_object('coverage', extraction->'coverage', 'page_count', extraction->'page_count', 'page_bounds', extraction->'page_bounds', 'pages', case when jsonb_typeof(extraction->'pages')='array' then (select coalesce(jsonb_agg(jsonb_build_object('page', pg->'page', 'truncated', coalesce(pg->'truncated','false'::jsonb))), '[]'::jsonb) from jsonb_array_elements(extraction->'pages') as pg) else '[]'::jsonb end) as extraction from public.hub_files where owner_id=${p.ownerId} and mime_type=${"application/pdf"} and binary_content is not null and bytes <= ${DEFAULT_PDF_MAX_BYTES} order by id limit 21`;
      return {
        files: rows.slice(0, 20).map((row) => ({
          id: row.id as string,
          name: row.name as string,
          sha256: row.sha256 as string,
          bytes: row.bytes as number,
          coverage: listCoverage(row.extraction),
          next_page: nextPageFor(row.extraction),
        })),
        next_id: rows.length > 20 ? (rows[19].id as string) : null,
      };
    });
  }
  /** Bytes do PDF preservado do dono, para extração no cliente. */
  async readPdf(p: Principal, fileId: string, hash: string) {
    assertClientSession(p);
    const stored = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`select name,mime_type,sha256,bytes,octet_length(binary_content)::integer as binary_bytes,binary_content from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`)[
          0
        ],
    );
    if (!stored) throw new HubError("not_found", "Arquivo não encontrado.", 404);
    if (stored.mime_type !== "application/pdf" || !stored.binary_content) {
      throw new HubError("pdf_required", "Este registro não contém um PDF preservado.");
    }
    if (stored.sha256 !== hash) {
      throw new HubError("file_changed", "Recupere a versão atual do arquivo.", 409);
    }
    const bytes = new Uint8Array(stored.binary_content);
    if (bytes.byteLength > DEFAULT_PDF_MAX_BYTES) {
      throw new HubError("file_too_large", "O PDF preservado excede o limite de 20 MiB.", 413);
    }
    if (bytes.byteLength !== stored.binary_bytes || stored.binary_bytes !== Number(stored.bytes)) {
      throw new HubError("file_integrity", "Os bytes não correspondem ao tamanho registrado.", 409);
    }
    if (await sha256Hex(bytes) !== hash) {
      throw new HubError("file_integrity", "Os bytes não correspondem ao hash registrado.", 409);
    }
    return { name: stored.name as string, sha256: hash, bytes };
  }
  /**
   * Recebe a extração feita pelo cliente no navegador. A autenticidade não é
   * corroborável: validamos a forma do relato, derivamos cobertura/omissões e
   * marcamos a origem como browser_client. O merge sob lock garante que nunca
   * apagamos uma extração melhor do mesmo hash.
   */
  async commitClientPdf(p: Principal, fileId: string, hash: string, extraction: unknown) {
    assertClientSession(p);
    const input = parseClientExtraction(extraction);
    validateClientExtraction(input);
    const stored = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`select mime_type,sha256,bytes,octet_length(binary_content)::integer as binary_bytes from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`)[
          0
        ],
    );
    if (!stored) throw new HubError("not_found", "Arquivo não encontrado.", 404);
    if (stored.sha256 !== hash) {
      throw new HubError("file_changed", "Recupere a versão atual do arquivo.", 409);
    }
    if (stored.mime_type !== "application/pdf" || typeof stored.binary_bytes !== "number") {
      throw new HubError("pdf_required", "Este registro não contém um PDF preservado.");
    }
    if (stored.binary_bytes > DEFAULT_PDF_MAX_BYTES) {
      throw new HubError("file_too_large", "O PDF preservado excede o limite de 20 MiB.", 413);
    }
    if (stored.binary_bytes !== Number(stored.bytes)) {
      throw new HubError("file_integrity", "Os bytes não correspondem ao tamanho registrado.", 409);
    }
    if (input.byte_length !== stored.binary_bytes) {
      throw invalidExtraction("O tamanho relatado não corresponde aos bytes preservados do dono.");
    }
    const run = normalizeClientExtraction(input, stored.binary_bytes);
    const outcome = await this.mergePdfExtraction(p, fileId, hash, run, {
      origin: "browser_client",
      provenance: {
        system: "browser_client",
        origin: "browser_client",
        verified: false,
        note: CLIENT_UNVERIFIED_NOTE,
      },
      notes: [CLIENT_UNVERIFIED_NOTE],
    }, { verifyBinary: true });
    return {
      file_id: fileId,
      sha256: hash,
      memory_updated: outcome.memory_updated,
      extraction: {
        ...run,
        pages: run.pages.map(({ text: _text, ...page }) => page),
      },
      memory: {
        coverage: outcome.coverage,
        complete: outcome.coverage === "complete",
        text_available: outcome.merge.pages.some(pageHasText),
        pages: outcome.merge.pages.length,
        pages_from_prior: outcome.merge.retained.length,
        pages_added: outcome.merge.added,
        pages_updated: outcome.merge.updated,
        ocr: "not_performed" as const,
      },
      extraction_origin: "browser_client" as const,
      provenance: {
        system: "browser_client",
        origin: "browser_client",
        verified: false,
        note: CLIENT_UNVERIFIED_NOTE,
      },
      content_is_untrusted_data: true,
    };
  }
  async preserveMoodle(p: Principal, connectionId: string, courseId: number, fileId: string) {
    const connections = this.connections;
    if (!connections) {
      throw new HubError(
        "connection_unavailable",
        "Preservação Moodle exige conexão autorizada; arquivos já preservados seguem legíveis offline.",
        409,
      );
    }
    const moodle = await connections.moodle(p, connectionId);
    const contents = await moodle.getCourseContents(courseId);
    if (!contents.data) {
      throw new HubError(
        "source_unavailable",
        "Não foi possível conferir o material no curso.",
        409,
      );
    }
    const ref = moodle.getRegisteredFile(fileId), module = locate(contents.data, fileId);
    if (!ref || !module) {
      throw new HubError("not_found", "Material não encontrado na cobertura deste curso.", 404);
    }
    const downloaded = await moodle.downloadFile(fileId);
    if (!downloaded.data) {
      return {
        source_refresh: { coverage: downloaded.coverage, error_code: downloaded.error_code },
        memory_commit: null,
      };
    }
    const binary = downloaded.data;
    const entity = await this.hub.entity(p, connectionId, "resource", fileId, ref.filename, {
      course_id: courseId,
      module_id: module.id ?? null,
      source_locator: ref.url,
      source_coverage: contents.coverage,
    });
    // Decode/extraction limits are explicit; preserving the bytes does not prove a PDF was read.
    const textual = binary.text !== undefined;
    const extraction = {
      method: textual ? "moodle_adapter_text" : "none",
      text_available: textual,
      complete: false,
      limits: textual
        ? ["Texto simples com limite do adaptador; layout, fórmulas e imagens não interpretados."]
        : ["Binário preservado; extração por página ainda não disponível."],
      source_coverage: downloaded.coverage,
    };
    // The Edge runtime cannot serialize a large bytea parameter without
    // exceeding its worker memory limit. Keep one transaction and append
    // bounded parameters; a failed request rolls back the incomplete file.
    const file = await asOwner(this.hub.db, p, async (tx) => {
      const stored =
        (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${p.ownerId},${entity.id},${binary.filename},${binary.mimetype},${binary.sha256},${binary.byte_length},decode('', 'hex'),${
          binary.text ?? null
        },${
          tx.json(extraction)
        }) on conflict(owner_id,entity_id,sha256) do update set name=excluded.name returning id,entity_id,sha256,bytes,mime_type,extraction,octet_length(binary_content)::integer as stored_bytes`)[
          0
        ];
      if (!stored) {
        throw new HubError("material_unavailable", "Não foi possível guardar o arquivo.", 503);
      }
      const storedBytes = Number(stored.stored_bytes);
      if (storedBytes !== binary.byte_length) {
        if (storedBytes !== 0) {
          throw new HubError(
            "material_conflict",
            "Arquivo já guardado com tamanho divergente.",
            409,
          );
        }
        const chunkBytes = 1024 * 1024;
        for (let offset = 0; offset < binary.byte_length; offset += chunkBytes) {
          const chunk = Buffer.from(binary.bytes.subarray(offset, offset + chunkBytes));
          await tx`update public.hub_files set binary_content = binary_content || ${chunk}::bytea where owner_id=${p.ownerId} and id=${stored.id}`;
        }
      }
      const verified =
        (await tx`select octet_length(binary_content)::integer as stored_bytes,encode(extensions.digest(binary_content,'sha256'),'hex') as stored_sha from public.hub_files where owner_id=${p.ownerId} and id=${stored.id}`)[
          0
        ];
      if (
        !verified || Number(verified.stored_bytes) !== binary.byte_length ||
        verified.stored_sha !== binary.sha256
      ) throw new HubError("material_conflict", "Verificação do arquivo guardado falhou.", 409);
      return stored;
    });
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${p.ownerId},${entity.id},${
        tx.json({ file_id: file.id, sha256: binary.sha256, bytes: binary.byte_length })
      },${binary.sha256},${
        tx.json({
          system: "moodle",
          connection_id: connectionId,
          course_id: courseId,
          locator: ref.url,
          observed_at: downloaded.observed_at,
        })
      },${downloaded.coverage},${downloaded.observed_at}) on conflict(owner_id,entity_id,content_hash) do nothing`;
    });
    return {
      memory_commit: file,
      source_refresh: { coverage: downloaded.coverage, observed_at: downloaded.observed_at },
      content_is_untrusted_data: true,
    };
  }
}
