/**
 * Extração de texto por página de PDF, limitada e segura, com o arquivo tratado
 * como dado não confiável.
 *
 * Isolamento e limite rígido:
 * - A extração roda em um Worker dedicado (bootstrap inline via blob URL) que
 *   pode ser terminado. O tempo limite é imposto por terminate(), então carga
 *   maliciosa com CPU síncrona não ultrapassa o limite rígido. Promise.race
 *   sozinha NÃO limitaria isso: no Deno o pdf.js 6 cai no fake worker (mesma
 *   thread), onde o relógio cooperativo é apenas indicativo.
 * - Sem Worker disponível (ex.: runtime Edge), a extração é RECUSADA com
 *   worker_unavailable e hard_timeout:false. Só um chamador de runtime local,
 *   sob limite externo (subprocesso/servidor), deve optar por
 *   allowMainThreadFallback: true; nesse modo hard_timeout é false e o resultado
 *   nunca é declarado completo por acidente.
 *
 * Cobertura:
 * - Sem OCR. Página sem texto extraído não prova ausência de texto: marcamos
 *   text_absent e nunca afirmamos que o documento não tem OCR.
 * - Imagens, assinaturas, anexos e fórmulas não são interpretados.
 * - Páginas além de maxPages e páginas não extraídas aparecem em omitted_pages.
 * - Documento inválido/criptografado/grande devolve ok:false com error_code;
 *   apenas opções fora do intervalo lançam.
 *
 * Dependência: pdfjs-dist (pdf.js) fixado em PDFJS_VERSION. O workerSrc é o
 * caminho relativo do próprio pacote, resolvido a partir de pdf.mjs; não
 * dependemos de import.meta.resolve para especificadores npm.
 */
import type * as PdfjsModule from "npm:pdfjs-dist@6.4.299/legacy/build/pdf.mjs";
import { type Coverage, HubError } from "./contracts.ts";

/** Versão fixada do pdf.js; qualquer mudança precisa acompanhar deno.lock. */
export const PDFJS_VERSION = "6.4.299";
const PDFJS_MODULE = "npm:pdfjs-dist@6.4.299/legacy/build/pdf.mjs";
/** Caminho relativo ao próprio pdf.mjs; não usar resolve de npm no runtime. */
const PDFJS_WORKER_SRC = "./pdf.worker.mjs";
/** Folga acima de timeoutMs antes de terminar o worker isolado à força. */
export const HARD_TIMEOUT_GRACE_MS = 3_000;

export const DEFAULT_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PDF_MAX_PAGES = 50;
export const MAX_PDF_MAX_PAGES = 500;
export const DEFAULT_PDF_PAGE_CHARS = 20_000;
export const MAX_PDF_PAGE_CHARS = 100_000;
export const DEFAULT_PDF_TOTAL_CHARS = 400_000;
export const MAX_PDF_TOTAL_CHARS = 1_000_000;
export const DEFAULT_PDF_TIMEOUT_MS = 15_000;
export const MAX_PDF_TIMEOUT_MS = 120_000;

const OCR_NOTE =
  "Sem OCR: página sem texto extraído não prova ausência de texto (pode haver texto em imagem, camada não extraível ou formulário).";
const IMAGE_NOTE =
  "Imagens, assinaturas, anexos e fórmulas não são interpretados; apenas a contagem de pinturas de imagem é relatada.";
const ISOLATED_NOTE =
  "Isolamento: worker dedicado e terminável; exceder o limite encerra a thread (limite rígido real).";
const MAIN_THREAD_NOTE =
  "Execução na thread principal (sem worker terminável): o limite de tempo é cooperativo e não limita CPU síncrona; exige limite externo (subprocesso/worker com terminação).";

/**
 * Bootstrap do worker isolado. Neutraliza Worker para forçar o pdf.js ao
 * caminho in-thread dentro DESTA thread descartável, sem criar thread aninhada.
 */
const ISOLATED_WORKER_SOURCE = [
  "globalThis.Worker = undefined;",
  "self.onmessage = async (event) => {",
  "  const job = event.data;",
  "  const describe = (error) => String((error && error.message) || error);",
  "  let mod;",
  "  try { mod = await import(job.moduleUrl); }",
  '  catch (error) { self.postMessage({ id: job.id, phase: "import", error: describe(error) }); return; }',
  "  try {",
  "    const result = await mod.runPdfExtractionInThread(new Uint8Array(job.bytes), job.options);",
  "    self.postMessage({ id: job.id, result });",
  "  } catch (error) {",
  '    self.postMessage({ id: job.id, phase: "extract", error: describe(error) });',
  "  }",
  "};",
].join("\n");

export type PdfExecution = "not_started" | "isolated_worker" | "main_thread";

export type PdfExtractionCode =
  | "empty_input"
  | "oversized"
  | "invalid_pdf"
  | "encrypted"
  | "timeout"
  | "aborted"
  | "worker_unavailable"
  | "pdf_runtime_unavailable"
  | "unreadable";

export interface PdfPageBounds {
  width_pt: number;
  height_pt: number;
  rotate: number;
}

export interface PdfPageText {
  page: number;
  locator: string;
  text: string;
  char_count: number;
  has_text: boolean;
  /** Verdadeiro quando não houve texto extraível; não é prova de página vazia. */
  text_absent: boolean;
  truncated: boolean;
  image_count: number;
  ocr: "not_performed";
  bounds: PdfPageBounds;
}

export interface PdfExtractionIssue {
  scope: "document" | "page";
  page: number | null;
  code: string;
  message: string;
}

export interface PdfTextExtraction {
  kind: "pdf_text_extraction";
  ok: boolean;
  error_code?: PdfExtractionCode;
  coverage: Coverage;
  /** Onde a extração rodou. hard_timeout só é confiável em isolated_worker. */
  execution: PdfExecution;
  /** true somente quando o limite é imposto por terminação de worker. */
  hard_timeout: boolean;
  page_count: number | null;
  pages_returned: number;
  pages: PdfPageText[];
  page_bounds: {
    first_page: number | null;
    last_page: number | null;
    pages_in_document: number | null;
    pages_returned: number;
  };
  omitted_pages: number[];
  errors: PdfExtractionIssue[];
  images_not_interpreted: true;
  images_detected: number;
  ocr: "not_performed";
  pages_without_text: number;
  text_truncated: boolean;
  limits: string[];
  notes: string[];
  content_is_untrusted_data: true;
  byte_length: number;
  elapsed_ms: number;
}

export interface PdfExtractionOptions {
  maxBytes?: number;
  maxPages?: number;
  maxPageChars?: number;
  maxTotalChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Aceita rodar na thread principal quando não há worker terminável. Só para
   * runtime local sob limite externo; mantém hard_timeout:false.
   */
  allowMainThreadFallback?: boolean;
}

type PdfLib = typeof PdfjsModule;

class PdfDeadlineError extends Error {}
class PdfAbortError extends Error {}
class PdfWorkerError extends Error {}

interface ResolvedPdfOptions {
  maxBytes: number;
  maxPages: number;
  maxPageChars: number;
  maxTotalChars: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface IsolatedReply {
  id?: number;
  phase?: "import" | "extract";
  error?: string;
  result?: PdfTextExtraction;
}

interface IsolationHandle {
  worker: Worker;
  terminate: () => void;
}

interface ResultContext {
  byteLength: number;
  startedAt: number;
  limits: string[];
  execution: PdfExecution;
  hardTimeout: boolean;
  pageCount?: number | null;
}

let pdfLibPromise: Promise<PdfLib | null> | undefined;
let isolatedWorkerUrl: string | undefined;

async function loadPdfLib(): Promise<PdfLib | null> {
  if (!pdfLibPromise) {
    pdfLibPromise = (async () => {
      try {
        const mod = await import(PDFJS_MODULE) as PdfLib & { default?: PdfLib };
        const lib = (mod.default ?? mod) as PdfLib;
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
        return lib;
      } catch {
        return null;
      }
    })().then((lib) => {
      if (!lib) pdfLibPromise = undefined;
      return lib;
    });
  }
  return pdfLibPromise;
}

function createIsolatedWorker(): IsolationHandle | null {
  if (typeof Worker !== "function") return null;
  try {
    if (!isolatedWorkerUrl) {
      isolatedWorkerUrl = URL.createObjectURL(
        new Blob([ISOLATED_WORKER_SOURCE], { type: "text/javascript" }),
      );
    }
    const worker = new Worker(isolatedWorkerUrl, { type: "module" });
    return {
      worker,
      terminate: () => {
        try {
          worker.terminate();
        } catch {
          // Já encerrado; terminação é melhor esforço idempotente.
        }
      },
    };
  } catch {
    return null;
  }
}

function collectImageOps(lib: PdfLib): Set<number> {
  const ops = lib.OPS as unknown as Record<string, number | undefined>;
  const names = [
    "paintImageXObject",
    "paintImageXObjectRepeat",
    "paintJpegXObject",
    "paintInlineImageXObject",
    "paintImageMaskXObject",
    "paintImageMaskXObjectRepeat",
  ];
  const found = new Set<number>();
  for (const name of names) {
    const value = ops[name];
    if (typeof value === "number") found.add(value);
  }
  return found;
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
      "invalid_pdf_options",
      `Parâmetro ${name} fora do intervalo permitido (${min}..${max}).`,
    );
  }
  return value;
}

function resolvePdfOptions(options: PdfExtractionOptions): ResolvedPdfOptions {
  return {
    maxBytes: boundedInt("maxBytes", options.maxBytes, DEFAULT_PDF_MAX_BYTES, 1, MAX_PDF_MAX_BYTES),
    maxPages: boundedInt("maxPages", options.maxPages, DEFAULT_PDF_MAX_PAGES, 1, MAX_PDF_MAX_PAGES),
    maxPageChars: boundedInt(
      "maxPageChars",
      options.maxPageChars,
      DEFAULT_PDF_PAGE_CHARS,
      1,
      MAX_PDF_PAGE_CHARS,
    ),
    maxTotalChars: boundedInt(
      "maxTotalChars",
      options.maxTotalChars,
      DEFAULT_PDF_TOTAL_CHARS,
      1,
      MAX_PDF_TOTAL_CHARS,
    ),
    timeoutMs: boundedInt(
      "timeoutMs",
      options.timeoutMs,
      DEFAULT_PDF_TIMEOUT_MS,
      1,
      MAX_PDF_TIMEOUT_MS,
    ),
    signal: options.signal,
  };
}

function baseLimits(options: ResolvedPdfOptions, byteLength: number): string[] {
  return [
    "Somente texto por página; sem OCR e sem interpretação de imagens, assinaturas, anexos ou fórmulas.",
    `Bytes: limite ${options.maxBytes}, recebidos ${byteLength}.`,
    `Páginas: limite ${options.maxPages}.`,
    `Caracteres: ${options.maxPageChars} por página e ${options.maxTotalChars} no total.`,
    `Tempo: ${options.timeoutMs} ms com folga de ${HARD_TIMEOUT_GRACE_MS} ms antes da terminação forçada.`,
  ];
}

function sanitizeText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n");
}

function checkInterruption(signal: AbortSignal | undefined, deadlineAt: number): void {
  if (signal?.aborted) throw new PdfAbortError();
  if (performance.now() >= deadlineAt) throw new PdfDeadlineError();
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  checkInterruption(signal, deadlineAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    const remaining = deadlineAt - performance.now();
    timer = setTimeout(() => reject(new PdfDeadlineError()), Math.max(1, remaining));
    if (signal) {
      if (signal.aborted) {
        reject(new PdfAbortError());
        return;
      }
      onAbort = () => reject(new PdfAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function emptyResult(
  code: PdfExtractionCode,
  coverage: Coverage,
  message: string,
  context: ResultContext,
): PdfTextExtraction {
  return {
    kind: "pdf_text_extraction",
    ok: false,
    error_code: code,
    coverage,
    execution: context.execution,
    hard_timeout: context.hardTimeout,
    page_count: context.pageCount ?? null,
    pages_returned: 0,
    pages: [],
    page_bounds: {
      first_page: null,
      last_page: null,
      pages_in_document: context.pageCount ?? null,
      pages_returned: 0,
    },
    omitted_pages: [],
    errors: [{ scope: "document", page: null, code, message }],
    images_not_interpreted: true,
    images_detected: 0,
    ocr: "not_performed",
    pages_without_text: 0,
    text_truncated: false,
    limits: context.limits,
    notes: [OCR_NOTE, IMAGE_NOTE],
    content_is_untrusted_data: true,
    byte_length: context.byteLength,
    elapsed_ms: Math.round(performance.now() - context.startedAt),
  };
}

/** Locator estável de uma página para uso em proveniência. */
export function pdfPageLocator(page: number): string {
  return `pdf:page:${page}`;
}

/**
 * Texto simples paginado para armazenamento em hub_files.extracted_text.
 * Preserva o locator de cada página e não afirma ausência de conteúdo.
 */
export function pdfExtractionToText(result: PdfTextExtraction): string {
  const parts: string[] = [];
  for (const page of result.pages) {
    parts.push(`[[página ${page.page} ${page.locator}]]`);
    parts.push(
      page.has_text
        ? page.text
        : "(sem texto extraído; pode conter texto em imagem ou camada não extraível — sem OCR)",
    );
  }
  return parts.join("\n");
}

/** Núcleo da extração; roda na thread atual e nunca cria worker. */
async function extractPdfBytesInThread(
  input: Uint8Array,
  options: ResolvedPdfOptions,
): Promise<PdfTextExtraction> {
  const startedAt = performance.now();
  const deadlineAt = startedAt + options.timeoutMs;
  const limits = baseLimits(options, input.byteLength);
  const mainThread: ResultContext = {
    byteLength: input.byteLength,
    startedAt,
    limits,
    execution: "main_thread",
    hardTimeout: false,
  };

  if (input.byteLength === 0) {
    return emptyResult("empty_input", "parsing_error", "Entrada vazia.", {
      ...mainThread,
      byteLength: 0,
    });
  }
  if (input.byteLength > options.maxBytes) {
    return emptyResult(
      "oversized",
      "unavailable",
      "PDF acima do limite de bytes; não processado.",
      mainThread,
    );
  }

  const lib = await loadPdfLib();
  if (!lib) {
    return emptyResult(
      "pdf_runtime_unavailable",
      "unavailable",
      "Runtime de PDF indisponível (pdf.js não pôde ser carregado).",
      mainThread,
    );
  }

  const imageOps = collectImageOps(lib);
  const pages: PdfPageText[] = [];
  const issues: PdfExtractionIssue[] = [];
  const omitted = new Set<number>();
  let totalChars = 0;
  let textTruncated = false;
  let imagesDetected = 0;
  let pageCount: number | null = null;
  let interruptedCode: "timeout" | "aborted" | undefined;
  let finalCoverage: Coverage = "complete";

  const data = new Uint8Array(input.byteLength);
  data.set(input);
  let loadingTask: ReturnType<PdfLib["getDocument"]> | undefined;
  let doc: Awaited<ReturnType<PdfLib["getDocument"]>["promise"]> | undefined;

  try {
    loadingTask = lib.getDocument({
      data,
      useWorkerFetch: false,
      useWasm: false,
      disableFontFace: true,
      stopAtErrors: false,
      verbosity: 0,
    });
    doc = await withDeadline(loadingTask.promise, deadlineAt, options.signal);
    pageCount = doc.numPages;
    limits.push(`Documento: ${pageCount} páginas declaradas.`);

    for (let number = 1; number <= doc.numPages; number++) {
      if (number > options.maxPages) {
        omitted.add(number);
        continue;
      }
      if (totalChars >= options.maxTotalChars) {
        omitted.add(number);
        continue;
      }
      try {
        checkInterruption(options.signal, deadlineAt);
        const page = await withDeadline(doc.getPage(number), deadlineAt, options.signal);
        const viewport = page.getViewport({ scale: 1 }) as {
          width: number;
          height: number;
          rotate?: number;
        };
        const content = await withDeadline(page.getTextContent(), deadlineAt, options.signal);
        let text = "";
        for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
          if (typeof item.str === "string") text += item.str;
          if (item.hasEOL) text += "\n";
        }
        text = sanitizeText(text);

        let imageCount = 0;
        try {
          const operators = await withDeadline(page.getOperatorList(), deadlineAt, options.signal);
          for (const fn of operators.fnArray) if (imageOps.has(fn)) imageCount++;
        } catch (error) {
          if (error instanceof PdfDeadlineError || error instanceof PdfAbortError) throw error;
          issues.push({
            scope: "page",
            page: number,
            code: "image_scan_failed",
            message: "Não foi possível contar imagens desta página.",
          });
        }
        page.cleanup();
        imagesDetected += imageCount;

        let truncated = false;
        if (text.length > options.maxPageChars) {
          text = text.slice(0, options.maxPageChars);
          truncated = true;
        }
        const room = options.maxTotalChars - totalChars;
        if (text.length > room) {
          text = text.slice(0, Math.max(0, room));
          truncated = true;
        }
        if (truncated) textTruncated = true;
        totalChars += text.length;

        pages.push({
          page: number,
          locator: pdfPageLocator(number),
          text,
          char_count: text.length,
          has_text: text.length > 0,
          text_absent: text.length === 0,
          truncated,
          image_count: imageCount,
          ocr: "not_performed",
          bounds: {
            width_pt: Number(viewport.width.toFixed(2)),
            height_pt: Number(viewport.height.toFixed(2)),
            rotate: viewport.rotate ?? 0,
          },
        });
      } catch (error) {
        if (error instanceof PdfDeadlineError || error instanceof PdfAbortError) {
          issues.push({
            scope: "page",
            page: number,
            code: error instanceof PdfAbortError ? "aborted" : "timeout",
            message: error instanceof PdfAbortError
              ? "Extração interrompida pelo sinal recebido."
              : "Tempo limite de extração excedido.",
          });
          omitted.add(number);
          for (let rest = number + 1; rest <= doc.numPages; rest++) omitted.add(rest);
          interruptedCode = error instanceof PdfAbortError ? "aborted" : "timeout";
          break;
        }
        issues.push({
          scope: "page",
          page: number,
          code: "page_unreadable",
          message: "Falha ao extrair esta página.",
        });
        omitted.add(number);
      }
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    let code: PdfExtractionCode = "unreadable";
    let coverage: Coverage = "parsing_error";
    let message = "Falha ao ler o PDF.";
    if (name === "PasswordException") {
      code = "encrypted";
      coverage = "denied";
      message = "PDF protegido por senha; conteúdo não extraído.";
    } else if (name === "InvalidPDFException") {
      code = "invalid_pdf";
      message = "Estrutura de PDF inválida.";
    } else if (error instanceof PdfAbortError) {
      code = "aborted";
      coverage = "timeout";
      message = "Extração interrompida pelo sinal recebido.";
    } else if (error instanceof PdfDeadlineError) {
      code = "timeout";
      coverage = "timeout";
      message = "Tempo limite de extração excedido.";
    } else if (name === "MissingPDFException" || name === "UnexpectedResponseException") {
      code = "unreadable";
      coverage = "unavailable";
      message = "PDF não pôde ser aberto.";
    }
    return emptyResult(code, coverage, message, { ...mainThread, pageCount });
  } finally {
    try {
      if (doc) await doc.cleanup();
    } catch {
      // Recursos do pdf.js; falha de limpeza não altera o resultado.
    }
    try {
      if (loadingTask) await loadingTask.destroy();
    } catch {
      // Encerramento interno do pdf.js; não mascara o resultado.
    }
  }

  if (interruptedCode) finalCoverage = "timeout";
  else if (issues.length > 0 || omitted.size > 0) finalCoverage = "partial";
  const omittedPages = [...omitted].sort((a, b) => a - b);
  const withoutText = pages.filter((page) => !page.has_text).length;

  return {
    kind: "pdf_text_extraction",
    // Interrupção (tempo/sinal) não é sucesso: a cobertura declara a lacuna e as
    // páginas já extraídas permanecem disponíveis com as omissões listadas.
    ok: interruptedCode === undefined,
    ...(interruptedCode ? { error_code: interruptedCode } : {}),
    coverage: finalCoverage,
    execution: "main_thread",
    hard_timeout: false,
    page_count: pageCount,
    pages_returned: pages.length,
    pages,
    page_bounds: {
      first_page: pages.length ? pages[0].page : null,
      last_page: pages.length ? pages[pages.length - 1].page : null,
      pages_in_document: pageCount,
      pages_returned: pages.length,
    },
    omitted_pages: omittedPages,
    errors: issues,
    images_not_interpreted: true,
    images_detected: imagesDetected,
    ocr: "not_performed",
    pages_without_text: withoutText,
    text_truncated: textTruncated,
    limits,
    notes: [OCR_NOTE, IMAGE_NOTE],
    content_is_untrusted_data: true,
    byte_length: input.byteLength,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
}

/**
 * @internal Usado apenas pelo bootstrap do worker isolado; roda na thread atual
 * e nunca cria worker (evita recursão).
 */
export async function runPdfExtractionInThread(
  input: Uint8Array,
  options: PdfExtractionOptions = {},
): Promise<PdfTextExtraction> {
  return await extractPdfBytesInThread(input, resolvePdfOptions(options));
}

async function extractIsolated(
  handle: IsolationHandle,
  input: Uint8Array,
  options: ResolvedPdfOptions,
  startedAt: number,
  limits: string[],
): Promise<PdfTextExtraction> {
  const data = new Uint8Array(input.byteLength);
  data.set(input);
  const hardDeadlineAt = startedAt + options.timeoutMs + HARD_TIMEOUT_GRACE_MS;
  const isolatedLimits = [...limits, ISOLATED_NOTE];
  const context: ResultContext = {
    byteLength: input.byteLength,
    startedAt,
    limits: isolatedLimits,
    execution: "isolated_worker",
    hardTimeout: true,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const reply = new Promise<IsolatedReply>((resolve, reject) => {
    handle.worker.onmessage = (event) => resolve(event.data as IsolatedReply);
    handle.worker.onerror = (event) =>
      reject(new PdfWorkerError(String((event as ErrorEvent).message ?? "worker error")));
    handle.worker.postMessage({
      moduleUrl: new URL("./pdf_text.ts", import.meta.url).href,
      options: {
        maxBytes: options.maxBytes,
        maxPages: options.maxPages,
        maxPageChars: options.maxPageChars,
        maxTotalChars: options.maxTotalChars,
        timeoutMs: options.timeoutMs,
      },
      bytes: data.buffer,
    }, [data.buffer]);
  });
  const gate = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new PdfDeadlineError()),
      Math.max(1, hardDeadlineAt - performance.now()),
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const signal = options.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new PdfAbortError());
      return;
    }
    onAbort = () => reject(new PdfAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const message = await Promise.race([reply, gate, aborted]);
    if (!message.result || message.error !== undefined) {
      const fromImport = message.phase === "import";
      return emptyResult(
        fromImport ? "pdf_runtime_unavailable" : "unreadable",
        fromImport ? "unavailable" : "parsing_error",
        fromImport
          ? "Worker isolado não conseguiu carregar o pdf.js."
          : "Worker isolado falhou ao extrair o PDF.",
        context,
      );
    }
    return {
      ...message.result,
      execution: "isolated_worker",
      hard_timeout: true,
      limits: [...message.result.limits, ISOLATED_NOTE],
    };
  } catch (error) {
    if (error instanceof PdfDeadlineError) {
      return emptyResult(
        "timeout",
        "timeout",
        "Limite rígido excedido: o worker isolado foi terminado.",
        context,
      );
    }
    if (error instanceof PdfAbortError) {
      return emptyResult(
        "aborted",
        "timeout",
        "Extração interrompida pelo sinal recebido; worker isolado terminado.",
        context,
      );
    }
    return emptyResult(
      "pdf_runtime_unavailable",
      "unavailable",
      "Worker isolado falhou ao iniciar.",
      { ...context, execution: "not_started", hardTimeout: false },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Extrai texto por página. Não lança para problemas do documento (entrada
 * inválida, grande, criptografada, tempo excedido): devolve ok:false com
 * error_code, cobertura e erros. Apenas opções inválidas lançam.
 *
 * Com worker terminável (padrão) o resultado traz execution:"isolated_worker" e
 * hard_timeout:true. Sem worker, recusa com worker_unavailable, salvo
 * allowMainThreadFallback:true, que mantém hard_timeout:false.
 */
export async function extractPdfText(
  input: Uint8Array,
  options: PdfExtractionOptions = {},
): Promise<PdfTextExtraction> {
  if (!(input instanceof Uint8Array)) {
    throw new HubError("invalid_pdf_input", "A entrada deve ser Uint8Array.");
  }
  const resolved = resolvePdfOptions(options);
  const startedAt = performance.now();
  const limits = baseLimits(resolved, input.byteLength);
  const preflight: ResultContext = {
    byteLength: input.byteLength,
    startedAt,
    limits,
    execution: "not_started",
    hardTimeout: false,
  };

  if (input.byteLength === 0) {
    return emptyResult("empty_input", "parsing_error", "Entrada vazia.", preflight);
  }
  if (input.byteLength > resolved.maxBytes) {
    return emptyResult(
      "oversized",
      "unavailable",
      "PDF acima do limite de bytes; não processado.",
      preflight,
    );
  }
  if (resolved.signal?.aborted) {
    return emptyResult(
      "aborted",
      "timeout",
      "Extração interrompida pelo sinal recebido.",
      preflight,
    );
  }

  const isolation = createIsolatedWorker();
  if (!isolation) {
    if (options.allowMainThreadFallback !== true) {
      return emptyResult(
        "worker_unavailable",
        "unavailable",
        "Extração exige worker terminável, indisponível neste runtime; use allowMainThreadFallback apenas em runtime local sob limite externo.",
        { ...preflight, execution: "main_thread", limits: [...limits, MAIN_THREAD_NOTE] },
      );
    }
    const fallback = await extractPdfBytesInThread(input, resolved);
    return { ...fallback, limits: [...fallback.limits, MAIN_THREAD_NOTE] };
  }

  try {
    return await extractIsolated(isolation, input, resolved, startedAt, limits);
  } finally {
    isolation.terminate();
  }
}
