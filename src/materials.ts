import { Buffer } from "node:buffer";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { type Coverage, HubError, type Principal } from "./contracts.ts";
import type { ConnectionService } from "./connections.ts";
import type { MoodleRecord } from "./adapters/moodle.ts";
import {
  extractPdfText,
  pdfExtractionToText,
  pdfPageLocator,
  type PdfPageText,
  type PdfTextExtraction,
} from "./pdf_text.ts";
import { sha256Hex } from "./migration.ts";

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
 * Páginas declaradas pelo documento: a execução corrente é a fonte; a extração
 * guardada só entra como reserva quando a execução não declarou contagem.
 */
function declaredPageCount(run: PdfTextExtraction, extraction: unknown): number | null {
  if (typeof run.page_count === "number") return run.page_count;
  const stored = extraction as {
    page_count?: unknown;
    page_bounds?: { pages_in_document?: unknown };
  } | null;
  if (typeof stored?.page_count === "number") return stored.page_count;
  if (typeof stored?.page_bounds?.pages_in_document === "number") {
    return stored.page_bounds.pages_in_document;
  }
  return null;
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
}

function buildStoredExtraction(
  run: PdfTextExtraction,
  merge: PageMerge,
  coverage: Coverage,
  pageCount: number | null,
): StoredPdfExtraction {
  const pages = merge.pages;
  const omitted: number[] = [];
  if (pageCount !== null) {
    for (let number = 1; number <= pageCount; number++) {
      if (!pages.some((page) => page.page === number)) omitted.push(number);
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
    // lock da linha (`for update`). Assim um extrator concorrente que gravou uma
    // extração melhor não é sobrescrito pelo snapshot anterior: o merge é
    // refeito contra a versão travada, e uma execução limitada/indisponível
    // nunca destrói páginas já extraídas do mesmo hash.
    const outcome = await asOwner(this.hub.db, p, async (tx) => {
      const rows =
        await tx`select extraction from public.hub_files where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash} for update`;
      if (!rows.length) {
        throw new HubError("file_changed", "Recupere a versão atual do arquivo.", 409);
      }
      const locked = rows[0].extraction;
      const prior = storedPages(locked);
      const merge = mergePdfPages(prior, result.pages);
      const pageCount = declaredPageCount(result, locked);
      const coverage: Coverage = merge.unchanged && merge.priorCount > 0
        ? priorCoverage(locked, result.coverage)
        : mergedCoverage(merge.pages, pageCount, result);
      let memory_updated = false;
      if (merge.pages.length && !merge.unchanged) {
        const memory = buildStoredExtraction(result, merge, coverage, pageCount);
        await tx`update public.hub_files set extracted_text=${
          pdfExtractionToText(memory)
        },extraction=${
          tx.json(JSON.parse(JSON.stringify(memory)))
        } where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash}`;
        memory_updated = true;
      }
      return {
        memory_updated,
        merge,
        coverage,
      };
    });
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
    const file = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${p.ownerId},${entity.id},${binary.filename},${binary.mimetype},${binary.sha256},${binary.byte_length},${
          Buffer.from(binary.bytes)
        },${binary.text ?? null},${
          tx.json(extraction)
        }) on conflict(owner_id,entity_id,sha256) do update set name=excluded.name returning id,entity_id,sha256,bytes,mime_type,extraction`)[
          0
        ],
    );
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
