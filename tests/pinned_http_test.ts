import assert from "node:assert/strict";
import { PinnedHttpError, readPinnedHttpResponse } from "../src/adapters/pinned_http.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function splitReader(response: string, width: number) {
  const bytes = encoder.encode(response);
  let offset = 0;
  return {
    read(buffer: Uint8Array): Promise<number | null> {
      if (offset === bytes.length) return Promise.resolve(null);
      const count = Math.min(width, buffer.length, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + count));
      offset += count;
      return Promise.resolve(count);
    },
  };
}

Deno.test("pinned HTTP reads a split content-length response", async () => {
  const reply = await readPinnedHttpResponse(
    splitReader(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"a":1}',
      3,
    ),
    32,
  );
  assert.equal(reply.status, 200);
  assert.equal(reply.contentType, "application/json");
  assert.equal(decoder.decode(reply.bytes), '{"a":1}');
});

Deno.test("pinned HTTP decodes chunked responses with boundaries split", async () => {
  const reply = await readPinnedHttpResponse(
    splitReader(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;ext=1\r\nde\r\n0\r\nX-End: yes\r\n\r\n",
      1,
    ),
    5,
  );
  assert.equal(decoder.decode(reply.bytes), "abcde");
});

Deno.test("pinned HTTP bounds EOF bodies and rejects ambiguous framing", async () => {
  const reply = await readPinnedHttpResponse(
    splitReader("HTTP/1.1 200 OK\r\n\r\nabc", 2),
    3,
  );
  assert.equal(decoder.decode(reply.bytes), "abc");
  await assert.rejects(
    () => readPinnedHttpResponse(splitReader("HTTP/1.1 200 OK\r\n\r\nabcd", 2), 3),
    (error: unknown) => error instanceof PinnedHttpError && error.code === "limit_exceeded",
  );
  await assert.rejects(
    () =>
      readPinnedHttpResponse(
        splitReader(
          "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
          8,
        ),
        10,
      ),
    (error: unknown) => error instanceof PinnedHttpError && error.code === "parsing_error",
  );
});

Deno.test("pinned HTTP exposes redirect status without reading a redirect body", async () => {
  const reply = await readPinnedHttpResponse(
    splitReader("HTTP/1.1 302 Found\r\nLocation: http://internal.invalid/\r\n\r\nprivate", 5),
    1,
  );
  assert.equal(reply.status, 302);
  assert.equal(reply.bytes.length, 0);
});
