/**
 * Provas da recepção da extração PDF feita pelo cliente (navegador), sem parse
 * na Edge. SQL real contra o Postgres local exclusivo do AraHub e HTTP pelo
 * handler com autenticação sintética.
 *
 * O que se prova: listagem keyset por dono com next_page de retomada; leitura
 * dos bytes com dono/mime/hash/tamanho; commit que valida estritamente o relato
 * do cliente (invariantes, limites e campos extras), deriva cobertura/omissões
 * no servidor, normaliza o texto, preserva a extração melhor sob lock e marca a
 * procedência como browser_client (não corroborada).
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { Materials } from "../src/materials.ts";
import { createHandler } from "../src/http.ts";
import { sha256Hex } from "../src/migration.ts";
import { HubError, type Principal } from "../src/contracts.ts";

const DB_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 bytes de prova");

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface PagePayload {
  page: number;
  locator: string;
  text: string;
  char_count: number;
  has_text: boolean;
  text_absent: boolean;
  truncated: boolean;
  image_count: number;
  ocr: "not_performed";
  bounds: { width_pt: number; height_pt: number; rotate: number };
}

function page(number: number, text: string, extra: Partial<PagePayload> = {}): PagePayload {
  return {
    page: number,
    locator: `pdf:page:${number}`,
    text,
    char_count: text.length,
    has_text: text.length > 0,
    text_absent: text.length === 0,
    truncated: false,
    image_count: 0,
    ocr: "not_performed",
    bounds: { width_pt: 300, height_pt: 200, rotate: 0 },
    ...extra,
  };
}

function payload(opts: {
  pages: PagePayload[];
  byte_length: number;
  page_count?: number | null;
  ok?: boolean;
  error_code?: string;
  coverage?: string;
  text_truncated?: boolean;
}): Record<string, unknown> {
  const pages = opts.pages;
  const pageCount = opts.page_count === undefined ? pages.length : opts.page_count;
  const numbers = pages.map((item) => item.page);
  return {
    kind: "pdf_text_extraction",
    ok: opts.ok ?? true,
    ...(opts.error_code !== undefined ? { error_code: opts.error_code } : {}),
    coverage: opts.coverage ?? "complete",
    execution: "isolated_worker",
    hard_timeout: true,
    page_count: pageCount,
    pages_returned: pages.length,
    pages,
    page_bounds: {
      first_page: numbers.length ? Math.min(...numbers) : null,
      last_page: numbers.length ? Math.max(...numbers) : null,
      pages_in_document: pageCount,
      pages_returned: pages.length,
    },
    omitted_pages: [],
    errors: [],
    images_not_interpreted: true,
    images_detected: pages.reduce((sum, item) => sum + item.image_count, 0),
    ocr: "not_performed",
    pages_without_text: pages.filter((item) => item.text.length === 0).length,
    text_truncated: opts.text_truncated ?? false,
    limits: [],
    notes: [],
    content_is_untrusted_data: true,
    byte_length: opts.byte_length,
    elapsed_ms: 12,
  };
}

function priorExtraction(
  pages: Array<{ page: number; text: string; truncated?: boolean }>,
  pageCount: number | null,
): Record<string, unknown> {
  const built = pages.map((item) => ({
    page: item.page,
    locator: `pdf:page:${item.page}`,
    text: item.text,
    char_count: item.text.length,
    has_text: item.text.length > 0,
    text_absent: item.text.length === 0,
    truncated: item.truncated === true,
    image_count: 0,
    ocr: "not_performed",
    bounds: { width_pt: 300, height_pt: 200, rotate: 0 },
  }));
  return {
    kind: "pdf_text_extraction",
    ok: true,
    coverage: "partial",
    complete: false,
    ...(pageCount !== null ? { page_count: pageCount } : {}),
    pages: built,
  };
}

async function seedFile(
  db: ReturnType<typeof createDb>,
  ownerId: string,
  bytes: Uint8Array,
  overrides: { hash?: string; mime?: string; name?: string; extraction?: unknown } = {},
): Promise<{ fileId: string; hash: string }> {
  const hash = overrides.hash ?? (await sha256Hex(bytes));
  const [connection] =
    await db`insert into public.hub_connections(owner_id,provider,label) values(${ownerId},'migration','fixture pdf cliente') returning id`;
  const [entity] =
    await db`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title) values(${ownerId},${connection.id},'resource',${crypto.randomUUID()},'fixture cliente') returning id`;
  const [file] =
    await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${ownerId},${entity.id},${
      overrides.name ?? "fixture.pdf"
    },${overrides.mime ?? "application/pdf"},${hash},${bytes.byteLength},${
      Buffer.from(bytes)
    },${null},${db.json(JSON.parse(JSON.stringify(overrides.extraction ?? {})))}) returning id`;
  return { fileId: file.id as string, hash };
}

async function seedMany(
  db: ReturnType<typeof createDb>,
  ownerId: string,
  count: number,
  prefix: string,
): Promise<string[]> {
  const [connection] =
    await db`insert into public.hub_connections(owner_id,provider,label) values(${ownerId},'migration','fixture pdf lote') returning id`;
  const [entity] =
    await db`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title) values(${ownerId},${connection.id},'resource',${crypto.randomUUID()},'fixture lote') returning id`;
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const bytes = bytesOf(`%PDF-1.7 ${prefix} ${index}`);
    const hash = await sha256Hex(bytes);
    const [file] =
      await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extraction) values(${ownerId},${entity.id},${`${prefix}-${index}.pdf`},'application/pdf',${hash},${bytes.byteLength},${
        Buffer.from(bytes)
      },${db.json({})}) returning id`;
    ids.push(file.id as string);
  }
  return ids;
}

async function readStored(
  db: ReturnType<typeof createDb>,
  fileId: string,
): Promise<{ extraction: Record<string, unknown>; extracted_text: string | null }> {
  const [row] = await db`select extraction,extracted_text from public.hub_files where id=${fileId}`;
  return row as { extraction: Record<string, unknown>; extracted_text: string | null };
}

function isHubError(code: string) {
  return (error: unknown) => error instanceof HubError && error.code === code;
}

Deno.test("A23: listPdf é keyset só do dono e devolve next_page de retomada (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  const other: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const ownerIds = await seedMany(db, owner.ownerId, 22, "lote");
    const otherIds = await seedMany(db, other.ownerId, 2, "outro");
    const text = await seedFile(db, owner.ownerId, bytesOf("nota"), {
      mime: "text/plain",
      name: "nota.txt",
    });
    const materials = new Materials(hub);

    const first = await materials.listPdf(owner);
    assert.equal(first.files.length, 20);
    assert.ok(first.next_id);
    const firstIds = first.files.map((item) => item.id);
    assert.deepEqual([...firstIds].sort(), firstIds);
    for (const item of first.files) {
      assert.equal(item.next_page, 1);
      assert.equal(item.coverage, "not_extracted");
      assert.equal(typeof item.bytes, "number");
    }
    const second = await materials.listPdf(owner, first.next_id as string);
    assert.equal(second.files.length, 2);
    assert.equal(second.next_id, null);
    const seen = new Set([...firstIds, ...second.files.map((item) => item.id)]);
    assert.equal(seen.size, 22);
    for (const id of ownerIds) assert.ok(seen.has(id));
    for (const id of otherIds) assert.ok(!seen.has(id));
    assert.ok(!seen.has(text.fileId));

    const otherList = await materials.listPdf(other);
    assert.equal(otherList.files.length, 2);
    for (const id of otherIds) assert.ok(otherList.files.some((item) => item.id === id));

    await assert.rejects(
      materials.listPdf({ ownerId: owner.ownerId, clientId: "mcp" }),
      isHubError("client_denied"),
    );
    await assert.rejects(materials.listPdf(owner, "não-uuid"), isHubError("invalid_query"));
  } finally {
    await db.end();
  }
});

Deno.test("A23: listPdf deriva next_page das páginas guardadas sem bloquear livro longo (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const a = await seedFile(db, owner.ownerId, bytesOf("a"), {
      extraction: priorExtraction([{ page: 1, text: "x" }, { page: 2, text: "y" }], 3),
    });
    const b = await seedFile(db, owner.ownerId, bytesOf("b"), {
      extraction: priorExtraction([
        { page: 1, text: "x" },
        { page: 2, text: "y" },
        { page: 3, text: "" },
      ], 3),
    });
    const c = await seedFile(db, owner.ownerId, bytesOf("c"), {
      extraction: priorExtraction([
        { page: 1, text: "x" },
        { page: 2, text: "y", truncated: true },
      ], 3),
    });
    const d = await seedFile(db, owner.ownerId, bytesOf("d"));
    const e = await seedFile(db, owner.ownerId, bytesOf("e"), {
      extraction: priorExtraction([{ page: 1, text: "x" }, { page: 2, text: "y" }], null),
    });
    const f = await seedFile(db, owner.ownerId, bytesOf("f"), {
      extraction: priorExtraction([
        { page: 1, text: "x" },
        { page: 2, text: "y", truncated: true },
        { page: 3, text: "z" },
      ], 3),
    });

    const materials = new Materials(hub);
    const list = await materials.listPdf(owner);
    const byId = new Map(list.files.map((item) => [item.id, item]));
    assert.equal(byId.get(a.fileId)?.next_page, 3);
    assert.equal(byId.get(b.fileId)?.next_page, null);
    // Lacuna (página 3) vem antes de retomada truncada (página 2).
    assert.equal(byId.get(c.fileId)?.next_page, 3);
    assert.equal(byId.get(d.fileId)?.next_page, 1);
    assert.equal(byId.get(e.fileId)?.next_page, 3);
    assert.equal(byId.get(f.fileId)?.next_page, 2);
    assert.equal(byId.get(b.fileId)?.coverage, "partial");
  } finally {
    await db.end();
  }
});

Deno.test("A23: readPdf exige dono, mime, hash e tamanho dos bytes (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  const other: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, PDF_BYTES);
    const materials = new Materials(hub);
    const file = await materials.readPdf(owner, seeded.fileId, seeded.hash);
    assert.equal(file.sha256, seeded.hash);
    assert.equal(file.bytes.byteLength, PDF_BYTES.byteLength);
    assert.deepEqual(Array.from(file.bytes), Array.from(PDF_BYTES));

    await assert.rejects(
      materials.readPdf(owner, seeded.fileId, "0".repeat(64)),
      isHubError("file_changed"),
    );
    await assert.rejects(
      materials.readPdf(other, seeded.fileId, seeded.hash),
      isHubError("not_found"),
    );
    await assert.rejects(
      materials.readPdf({ ownerId: owner.ownerId, clientId: "mcp" }, seeded.fileId, seeded.hash),
      isHubError("client_denied"),
    );

    const text = await seedFile(db, owner.ownerId, bytesOf("nota"), {
      mime: "text/plain",
      name: "nota.txt",
    });
    await assert.rejects(
      materials.readPdf(owner, text.fileId, text.hash),
      isHubError("pdf_required"),
    );

    const forged = await seedFile(db, owner.ownerId, PDF_BYTES, { hash: "f".repeat(64) });
    await assert.rejects(
      materials.readPdf(owner, forged.fileId, "f".repeat(64)),
      isHubError("file_integrity"),
    );

    await db`update public.hub_files set bytes=${
      PDF_BYTES.byteLength + 5
    } where id=${seeded.fileId}`;
    await assert.rejects(
      materials.readPdf(owner, seeded.fileId, seeded.hash),
      isHubError("file_integrity"),
    );
  } finally {
    await db.end();
  }
});

Deno.test("A23: commitClientPdf recusa payload hostil e invariantes sem tocar a memória (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, PDF_BYTES);
    const materials = new Materials(hub);
    const before = await readStored(db, seeded.fileId);
    const base = () => payload({ pages: [page(1, "texto um")], byte_length: PDF_BYTES.byteLength });
    const reject = (value: unknown) =>
      assert.rejects(
        materials.commitClientPdf(owner, seeded.fileId, seeded.hash, value),
        isHubError("invalid_extraction"),
      );

    await reject({ ...base(), client_id: "forjado" });
    await reject({ ...base(), execution: "main_thread" });
    await reject({ ...base(), hard_timeout: false });
    await reject({ ...base(), ocr: "performed" });
    await reject({ ...base(), coverage: "inventado" });
    await reject({ ...base(), page_count: 20_000 });
    await reject({
      ...base(),
      pages: [page(1, "x", { char_count: 99 })],
      pages_returned: 1,
    });
    await reject({
      ...base(),
      pages: [page(1, "x", { locator: "pdf:page:9" })],
      pages_returned: 1,
    });
    await reject({ ...base(), pages: [page(1, "x"), page(1, "y")], pages_returned: 2 });
    await reject({ ...base(), pages: [page(2, "x")], page_count: 1, pages_returned: 1 });
    await reject({ ...base(), byte_length: PDF_BYTES.byteLength + 1 });
    await reject({
      ...base(),
      pages: [
        page(1, "x", { source_url: "https://evil.invalid" } as unknown as Partial<PagePayload>),
      ],
      pages_returned: 1,
    });
    await reject(payload({
      pages: Array.from({ length: 501 }, (_, index) => page(index + 1, "a")),
      byte_length: PDF_BYTES.byteLength,
      page_count: 501,
    }));
    await reject({ ...base(), ok: false });
    await assert.rejects(
      materials.commitClientPdf(
        { ownerId: owner.ownerId, clientId: "mcp" },
        seeded.fileId,
        seeded.hash,
        base(),
      ),
      isHubError("client_denied"),
    );

    const after = await readStored(db, seeded.fileId);
    assert.deepEqual(after.extraction, before.extraction);
    assert.equal(after.extracted_text, before.extracted_text);
  } finally {
    await db.end();
  }
});

Deno.test("A23: commit normaliza o texto, deriva cobertura e marca browser_client (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, PDF_BYTES);
    const materials = new Materials(hub);
    const raw = "linha 1\r\nlinha 2\u0007fim";
    const result = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, raw)],
        byte_length: PDF_BYTES.byteLength,
        coverage: "partial",
      }),
    );
    assert.equal(result.memory_updated, true);
    assert.equal(result.extraction_origin, "browser_client");
    assert.equal(result.provenance.verified, false);
    assert.equal(result.memory.coverage, "complete");
    assert.equal(result.memory.complete, true);

    const stored = await readStored(db, seeded.fileId);
    const memory = stored.extraction as {
      origin: string;
      provenance: { verified: boolean };
      coverage: string;
      notes: string[];
      pages: Array<Record<string, unknown>>;
    };
    assert.equal(memory.origin, "browser_client");
    assert.equal(memory.provenance.verified, false);
    assert.equal(memory.coverage, "complete");
    assert.ok(memory.notes.some((note) => note.includes("não são corroboradas")));
    const normalized = "linha 1\nlinha 2fim";
    assert.equal(memory.pages[0].text, normalized);
    assert.equal(memory.pages[0].char_count, normalized.length);
    assert.equal(memory.pages[0].locator, "pdf:page:1");
    assert.equal(memory.pages[0].has_text, true);

    const persisted = await materials.pdfPage(owner, seeded.fileId, seeded.hash, 1);
    assert.equal(persisted.page.text, normalized);
    assert.equal(persisted.page.locator, "pdf:page:1");
  } finally {
    await db.end();
  }
});

Deno.test("A23: commit completa cobertura parcial e preserva a extração melhor (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, PDF_BYTES);
    const materials = new Materials(hub);

    const partial = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, "um"), page(2, "dois")],
        page_count: 3,
        byte_length: PDF_BYTES.byteLength,
        coverage: "complete",
      }),
    );
    assert.equal(partial.memory.coverage, "partial");
    assert.equal(partial.memory.complete, false);
    assert.deepEqual(partial.extraction.omitted_pages, [3]);

    const full = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, "um"), page(2, "dois"), page(3, "três")],
        page_count: 3,
        byte_length: PDF_BYTES.byteLength,
      }),
    );
    assert.equal(full.memory_updated, true);
    assert.equal(full.memory.complete, true);
    assert.equal(full.memory.pages_added, 1);
    assert.equal(full.memory.pages_from_prior, 2);

    const before = await readStored(db, seeded.fileId);
    const weaker = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, "um")],
        page_count: 3,
        byte_length: PDF_BYTES.byteLength,
      }),
    );
    assert.equal(weaker.memory_updated, false);
    assert.equal(weaker.memory.pages, 3);
    assert.equal(weaker.memory.complete, true);
    const after = await readStored(db, seeded.fileId);
    assert.deepEqual(after.extraction, before.extraction);
    assert.equal(after.extracted_text, before.extracted_text);

    const again = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, "um"), page(2, "dois"), page(3, "três")],
        page_count: 3,
        byte_length: PDF_BYTES.byteLength,
      }),
    );
    assert.equal(again.memory_updated, false);
    const afterAgain = await readStored(db, seeded.fileId);
    assert.deepEqual(afterAgain.extraction, before.extraction);

    const pageThree = await materials.pdfPage(owner, seeded.fileId, seeded.hash, 3);
    assert.equal(pageThree.page.text, "três");
    assert.equal(pageThree.coverage, "complete");
  } finally {
    await db.end();
  }
});

Deno.test("A23: execução de cliente com falha não apaga nem promove a memória (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, PDF_BYTES);
    const materials = new Materials(hub);
    await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, "bom")],
        byte_length: PDF_BYTES.byteLength,
      }),
    );
    const before = await readStored(db, seeded.fileId);
    const failed = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [],
        byte_length: PDF_BYTES.byteLength,
        page_count: 1,
        ok: false,
        error_code: "encrypted",
        coverage: "complete",
      }),
    );
    assert.equal(failed.memory_updated, false);
    assert.equal(failed.extraction.coverage, "denied");
    assert.equal(failed.memory.coverage, "complete");
    const after = await readStored(db, seeded.fileId);
    assert.deepEqual(after.extraction, before.extraction);
  } finally {
    await db.end();
  }
});

Deno.test("A23: commitClientPdf nega bytes adulterados mantendo o hash de metadados (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, PDF_BYTES);
    const materials = new Materials(hub);
    // Mesmo tamanho e mesmo sha256 de metadados, bytes diferentes.
    const tampered = Uint8Array.from(PDF_BYTES);
    tampered[5] = tampered[5] ^ 0xff;
    await db`update public.hub_files set binary_content=${
      Buffer.from(tampered)
    } where id=${seeded.fileId}`;
    await assert.rejects(
      materials.commitClientPdf(
        owner,
        seeded.fileId,
        seeded.hash,
        payload({
          pages: [page(1, "x")],
          byte_length: PDF_BYTES.byteLength,
        }),
      ),
      isHubError("file_integrity"),
    );
    await assert.rejects(
      materials.readPdf(owner, seeded.fileId, seeded.hash),
      isHubError("file_integrity"),
    );
  } finally {
    await db.end();
  }
});

Deno.test("A23: page_count forjado menor não promove cobertura completa (SQL)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, PDF_BYTES);
    const materials = new Materials(hub);
    const first = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, "curto"), page(2, "dois")],
        page_count: 3,
        byte_length: PDF_BYTES.byteLength,
      }),
    );
    assert.equal(first.memory.complete, false);
    const forged = await materials.commitClientPdf(
      owner,
      seeded.fileId,
      seeded.hash,
      payload({
        pages: [page(1, "texto bem mais longo"), page(2, "dois")],
        page_count: 2,
        byte_length: PDF_BYTES.byteLength,
      }),
    );
    assert.equal(forged.memory_updated, true);
    assert.equal(forged.memory.coverage, "partial");
    assert.equal(forged.memory.complete, false);
    const stored = await readStored(db, seeded.fileId);
    assert.equal((stored.extraction as { page_count: number }).page_count, 3);
  } finally {
    await db.end();
  }
});

Deno.test("A23: rotas /api/pdf exigem sessão pessoal, negam MCP e servem os bytes (HTTP)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  const personal: Principal = { ownerId: owner, sessionId: crypto.randomUUID() };
  const mcp: Principal = {
    ownerId: owner,
    sessionId: crypto.randomUUID(),
    clientId: "fixture-mcp",
  };
  const foreign: Principal = { ownerId: other, sessionId: crypto.randomUUID() };
  const handler = createHandler(hub, {
    auth: { issuer: "https://identity.invalid/auth", resource: "https://hub.invalid/mcp" },
    publicUrl: "https://hub.invalid",
    verify: (req) => {
      const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
      if (token === "personal") return Promise.resolve(personal);
      if (token === "mcp") return Promise.resolve(mcp);
      if (token === "other") return Promise.resolve(foreign);
      throw new HubError("unauthorized", "sem sessão", 401);
    },
  });
  const post = (path: string, token: string | null, body: unknown) =>
    handler(
      new Request(`https://hub.invalid${path}`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  try {
    await db`insert into auth.users(id) values(${owner}),(${other})`;
    const seeded = await seedFile(db, owner, PDF_BYTES);

    const config = await handler(new Request("https://hub.invalid/api/config"));
    assert.equal(config.status, 200);
    assert.equal((await config.json()).canExtractPdf, true);

    const anonymous = await post("/api/pdf/list", null, {});
    assert.equal(anonymous.status, 401);
    const deniedMcp = await post("/api/pdf/list", "mcp", {});
    assert.equal(deniedMcp.status, 403);
    assert.equal((await deniedMcp.json()).code, "client_denied");
    const hostileList = await post("/api/pdf/list", "personal", { client_id: "forjado" });
    assert.equal(hostileList.status, 400);

    const listed = await post("/api/pdf/list", "personal", {});
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.equal(listBody.files.length, 1);
    assert.equal(listBody.files[0].id, seeded.fileId);
    assert.equal(listBody.files[0].next_page, 1);
    assert.equal(listBody.next_id, null);
    const foreignList = await post("/api/pdf/list", "other", {});
    assert.equal((await foreignList.json()).files.length, 0);

    const served = await post("/api/pdf/bytes", "personal", {
      file_id: seeded.fileId,
      sha256: seeded.hash,
    });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "application/pdf");
    assert.equal(served.headers.get("content-disposition"), null);
    assert.equal(served.headers.get("cache-control"), "no-store");
    const servedBytes = new Uint8Array(await served.arrayBuffer());
    assert.deepEqual(Array.from(servedBytes), Array.from(PDF_BYTES));
    const bytesMcp = await post("/api/pdf/bytes", "mcp", {
      file_id: seeded.fileId,
      sha256: seeded.hash,
    });
    assert.equal(bytesMcp.status, 403);
    const bytesForeign = await post("/api/pdf/bytes", "other", {
      file_id: seeded.fileId,
      sha256: seeded.hash,
    });
    assert.equal(bytesForeign.status, 404);
    const bytesWrongHash = await post("/api/pdf/bytes", "personal", {
      file_id: seeded.fileId,
      sha256: "0".repeat(64),
    });
    assert.equal(bytesWrongHash.status, 409);

    const commit = await post("/api/pdf/commit", "personal", {
      file_id: seeded.fileId,
      sha256: seeded.hash,
      extraction: payload({ pages: [page(1, "conteúdo http")], byte_length: PDF_BYTES.byteLength }),
    });
    assert.equal(commit.status, 200);
    const commitBody = await commit.json();
    assert.equal(commitBody.memory_updated, true);
    assert.equal(commitBody.extraction_origin, "browser_client");
    assert.equal(commitBody.memory.complete, true);
    const commitMcp = await post("/api/pdf/commit", "mcp", {
      file_id: seeded.fileId,
      sha256: seeded.hash,
      extraction: payload({ pages: [page(1, "x")], byte_length: PDF_BYTES.byteLength }),
    });
    assert.equal(commitMcp.status, 403);
    const hostileCommit = await post("/api/pdf/commit", "personal", {
      file_id: seeded.fileId,
      sha256: seeded.hash,
      extraction: payload({ pages: [page(1, "x")], byte_length: PDF_BYTES.byteLength }),
      client_id: "forjado",
    });
    assert.equal(hostileCommit.status, 400);
    assert.equal((await hostileCommit.json()).code, "invalid_request");

    const persisted = await new Materials(hub).pdfPage(personal, seeded.fileId, seeded.hash, 1);
    assert.equal(persisted.page.text, "conteúdo http");
  } finally {
    await db.end();
  }
});
