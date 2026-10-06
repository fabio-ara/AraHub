import type { PdfTextExtraction } from "../src/pdf_text.ts";

export const PDF_CLIENT_MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 18_000;

/** A dedicated Worker, terminated on every outcome. Bytes never run on the UI thread. */
export async function extractClientPdf(
  bytes: Uint8Array,
  sha256: string,
  maxPages = 50,
  signal?: AbortSignal,
  startPage = 1,
): Promise<PdfTextExtraction> {
  if (bytes.length > PDF_CLIENT_MAX_BYTES || !bytes.length) {
    throw new Error("PDF fora do limite.");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    throw new Error("Limite de páginas inválido.");
  }
  const actual = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0")).join("");
  if (actual !== sha256) throw new Error("O arquivo mudou. Atualize a lista.");
  if (!Number.isSafeInteger(startPage) || startPage < 1 || startPage > 10_000) {
    throw new Error("Página inicial inválida.");
  }
  if (signal?.aborted) throw new Error("Extração cancelada.");
  const worker = new Worker(
    new URL("./pdf-parser.worker.js", import.meta.url),
    { type: "module" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<PdfTextExtraction>((resolve, reject) => {
      abort = () => reject(new Error("Extração cancelada."));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("Tempo de extração excedido.")),
        TIMEOUT_MS,
      );
      worker.onerror = (e) => {
        e.preventDefault();
        reject(new Error("Extração indisponível neste navegador."));
      };
      worker.onmessage = ({ data }) => {
        if (data?.type !== "arahub.pdf.result") return;
        if (!data.result || data.error) {
          reject(new Error("Não foi possível extrair este PDF."));
          return;
        }
        resolve({
          ...data.result,
          execution: "isolated_worker",
          hard_timeout: true,
        });
      };
      // Transfer a copy, keeping the caller's authenticated bytes intact.
      const copy = new Uint8Array(bytes);
      worker.postMessage({
        type: "arahub.pdf.extract",
        bytes: copy.buffer,
        maxPages,
        startPage,
      }, [copy.buffer]);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    worker.terminate();
  }
}
