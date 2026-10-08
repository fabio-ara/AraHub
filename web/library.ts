export interface LibraryFile {
  id: string;
  name: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  source: string;
  source_title: string;
  available: boolean;
}
const PART = 1024 * 1024;
const MAX = 128 * PART;

export function safeFileName(name: string) {
  return name.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "").slice(0, 160) || "material.bin";
}

/** Never render active source HTML/SVG as same-origin browser content. */
export function previewMime(mime: string): string | null {
  return [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "audio/mpeg",
      "audio/mp4",
      "audio/ogg",
      "video/mp4",
      "video/webm",
      "text/plain",
    ]
      .includes(mime)
    ? mime
    : null;
}

/** Authenticated bounded parts; incomplete or changed originals are never offered. */
export async function readLibraryFile(
  file: LibraryFile,
  request: (offset: number) => Promise<Response>,
  signal: AbortSignal,
) {
  if (
    !file.available || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  ) throw new Error("Material indisponível.");
  const bytes = new Uint8Array(file.bytes);
  for (let offset = 0; offset < bytes.length; offset += PART) {
    signal.throwIfAborted();
    const response = await request(offset);
    if (
      !response.ok || response.redirected ||
      response.headers.get("content-type")?.split(";")[0] !== "application/octet-stream"
    ) {
      throw new Error("Não foi possível obter o material. Atualize a biblioteca.");
    }
    const expected = Math.min(PART, bytes.length - offset);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Arquivo incompleto.");
    let received = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (received + value.length > expected) throw new Error("Tamanho do arquivo inválido.");
        bytes.set(value, offset + received);
        received += value.length;
      }
    } finally {
      await reader.cancel();
    }
    if (received !== expected) throw new Error("Arquivo incompleto. Tente novamente.");
  }
  signal.throwIfAborted();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hash !== file.sha256) throw new Error("O arquivo mudou. Atualize a biblioteca.");
  return bytes;
}
