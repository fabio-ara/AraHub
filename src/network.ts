import { HubError } from "./contracts.ts";
export async function boundedBody(
  req: Request,
  maxBytes: number,
  timeoutMs = 10_000,
): Promise<string> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    throw new HubError("limit_exceeded", "A chamada excedeu o limite de tamanho.", 413);
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HubError("request_timeout", "A leitura da chamada expirou.", 408));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HubError("limit_exceeded", "A chamada excedeu o limite de tamanho.", 413);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, pos);
    pos += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
