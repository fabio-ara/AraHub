// Only loaded in a disposable, same-origin module Worker. No credentials enter it.
import * as pdfjs from "npm:pdfjs-dist@6.4.299/build/pdf.mjs";
import { WorkerMessageHandler } from "npm:pdfjs-dist@6.4.299/build/pdf.worker.mjs";
import { runPdfExtractionInThread } from "../src/pdf_text.ts";

// The pdf.js internal fake worker remains inside this terminable outer Worker.
Object.assign(globalThis, {
  Worker: undefined,
  pdfjsWorker: { WorkerMessageHandler },
});
globalThis.onmessage = async (event: MessageEvent) => {
  if (event.data?.type !== "arahub.pdf.extract") return;
  try {
    const { bytes, maxPages, startPage } = event.data;
    const result = await runPdfExtractionInThread(new Uint8Array(bytes), {
      maxPages,
      startPage,
    }, pdfjs);
    globalThis.postMessage({ type: "arahub.pdf.result", result });
  } catch {
    globalThis.postMessage({
      type: "arahub.pdf.result",
      error: "Não foi possível extrair este PDF.",
    });
  }
};
