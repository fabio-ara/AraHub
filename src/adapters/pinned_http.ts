/** HTTPS/1.1 over a DNS-pinned TCP socket for runtimes without node:https lookup. */

export class PinnedHttpError extends Error {
  constructor(readonly code: "limit_exceeded" | "parsing_error" | "timeout") {
    super(code);
    this.name = "PinnedHttpError";
  }
}

export interface PinnedHttpReply {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

interface Reader {
  read(buffer: Uint8Array): Promise<number | null>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");
const HEADER_LIMIT = 64 * 1024;
const LINE_LIMIT = 8 * 1024;

function join(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

class BufferedReader {
  private buffer = new Uint8Array(0);
  private position = 0;

  constructor(private source: Reader) {}

  private async refill(): Promise<boolean> {
    const next = new Uint8Array(64 * 1024);
    const count = await this.source.read(next);
    if (count === null) return false;
    if (count <= 0 || count > next.length) throw new PinnedHttpError("parsing_error");
    const remaining = this.buffer.subarray(this.position);
    this.buffer = new Uint8Array(remaining.length + count);
    this.buffer.set(remaining);
    this.buffer.set(next.subarray(0, count), remaining.length);
    this.position = 0;
    return true;
  }

  async line(maxLength = LINE_LIMIT): Promise<string> {
    while (true) {
      for (let i = this.position; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          if (i - this.position > maxLength) throw new PinnedHttpError("parsing_error");
          const line = decoder.decode(this.buffer.subarray(this.position, i));
          this.position = i + 2;
          return line;
        }
      }
      if (this.buffer.length - this.position > maxLength) {
        throw new PinnedHttpError("parsing_error");
      }
      if (!await this.refill()) throw new PinnedHttpError("parsing_error");
    }
  }

  async exact(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.position === this.buffer.length && !await this.refill()) {
        throw new PinnedHttpError("parsing_error");
      }
      const count = Math.min(length - offset, this.buffer.length - this.position);
      out.set(this.buffer.subarray(this.position, this.position + count), offset);
      this.position += count;
      offset += count;
    }
    return out;
  }

  async untilEof(maxBytes: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const available = this.buffer.subarray(this.position);
      if (available.length) {
        total += available.length;
        if (total > maxBytes) throw new PinnedHttpError("limit_exceeded");
        chunks.push(available.slice());
        this.position = this.buffer.length;
      }
      if (!await this.refill()) break;
    }
    return join(chunks, total);
  }
}

/** Parses a single HTTP/1.1 response; no redirects or decompression. */
export async function readPinnedHttpResponse(
  source: Reader,
  maxBytes: number,
): Promise<PinnedHttpReply> {
  const reader = new BufferedReader(source);
  const statusLine = await reader.line();
  const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/.exec(statusLine);
  if (!match) throw new PinnedHttpError("parsing_error");
  const status = Number(match[1]);
  const headers = new Map<string, string>();
  let headerBytes = statusLine.length + 2;
  while (true) {
    const line = await reader.line();
    headerBytes += line.length + 2;
    if (headerBytes > HEADER_LIMIT) throw new PinnedHttpError("parsing_error");
    if (line === "") break;
    const separator = line.indexOf(":");
    if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, separator))) {
      throw new PinnedHttpError("parsing_error");
    }
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name) && ["content-length", "transfer-encoding"].includes(name)) {
      throw new PinnedHttpError("parsing_error");
    }
    headers.set(name, value);
  }
  const contentType = headers.get("content-type") ?? null;
  if (status !== 200) return { status, contentType, bytes: new Uint8Array() };
  const encoding = headers.get("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "identity") throw new PinnedHttpError("parsing_error");
  const transfer = headers.get("transfer-encoding")?.toLowerCase();
  const declared = headers.get("content-length");
  if (transfer && (transfer !== "chunked" || declared !== undefined)) {
    throw new PinnedHttpError("parsing_error");
  }
  if (transfer === "chunked") {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const sizeLine = await reader.line();
      const hex = sizeLine.split(";", 1)[0].trim();
      if (!/^[0-9a-fA-F]+$/.test(hex)) throw new PinnedHttpError("parsing_error");
      const size = Number.parseInt(hex, 16);
      if (!Number.isSafeInteger(size)) throw new PinnedHttpError("parsing_error");
      if (size === 0) {
        let trailerBytes = 0;
        while (true) {
          const trailer = await reader.line();
          trailerBytes += trailer.length + 2;
          if (trailerBytes > HEADER_LIMIT) throw new PinnedHttpError("parsing_error");
          if (trailer === "") break;
        }
        break;
      }
      total += size;
      if (total > maxBytes) throw new PinnedHttpError("limit_exceeded");
      chunks.push(await reader.exact(size));
      const ending = await reader.exact(2);
      if (ending[0] !== 13 || ending[1] !== 10) throw new PinnedHttpError("parsing_error");
    }
    return { status, contentType, bytes: join(chunks, total) };
  }
  if (declared !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(declared)) throw new PinnedHttpError("parsing_error");
    const length = Number(declared);
    if (!Number.isSafeInteger(length)) throw new PinnedHttpError("parsing_error");
    if (length > maxBytes) throw new PinnedHttpError("limit_exceeded");
    return { status, contentType, bytes: await reader.exact(length) };
  }
  return { status, contentType, bytes: await reader.untilEof(maxBytes) };
}

async function writeAll(conn: Deno.TlsConn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await conn.write(bytes.subarray(offset));
    if (written <= 0) throw new PinnedHttpError("parsing_error");
    offset += written;
  }
}

export async function sendPinnedHttp(options: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string | Uint8Array;
  address: string;
  maxBytes: number;
  timeoutMs: number;
}): Promise<PinnedHttpReply> {
  const target = new URL(options.url);
  if (target.protocol !== "https:" || target.username || target.password || target.hash) {
    throw new PinnedHttpError("parsing_error");
  }
  const body = options.body === undefined
    ? new Uint8Array()
    : typeof options.body === "string"
    ? encoder.encode(options.body)
    : options.body;
  const lines = [
    `${options.method} ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    "Connection: close",
    "Accept-Encoding: identity",
  ];
  for (const [name, value] of Object.entries(options.headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value) ||
      ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(
        name.toLowerCase(),
      )
    ) {
      throw new PinnedHttpError("parsing_error");
    }
    lines.push(`${name}: ${value}`);
  }
  if (options.body !== undefined) lines.push(`Content-Length: ${body.length}`);
  const head = encoder.encode(lines.join("\r\n") + "\r\n\r\n");
  let raw: Deno.TcpConn | undefined;
  let tls: Deno.TlsConn | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    try {
      raw = await Deno.connect({
        hostname: options.address,
        port: target.port ? Number(target.port) : 443,
      }) as Deno.TcpConn;
      if (timedOut) throw new PinnedHttpError("timeout");
      tls = await Deno.startTls(raw, { hostname: target.hostname, alpnProtocols: ["http/1.1"] });
      if (timedOut) throw new PinnedHttpError("timeout");
      await writeAll(tls, head);
      if (body.length) await writeAll(tls, body);
      return await readPinnedHttpResponse(tls, options.maxBytes);
    } finally {
      try {
        tls?.close();
      } catch { /* Already closed. */ }
      try {
        raw?.close();
      } catch { /* Ownership passed to TLS. */ }
    }
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            tls?.close();
          } catch { /* Already closed. */ }
          try {
            raw?.close();
          } catch { /* Already closed. */ }
          reject(new PinnedHttpError("timeout"));
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
