/**
 * Provas SQL reais dos métodos de PDF de `src/materials.ts` contra o Postgres
 * local exclusivo do AraHub (127.0.0.1:55432).
 *
 * Os PDFs são sintéticos, gerados no próprio processo (sem dados reais, sem
 * rede externa, sem navegador e sem download de imagens): três páginas reais
 * (texto Latin-1 com acentos, texto não latino por nomes de glifos e uma página
 * só com imagem) e um PDF criptografado para forçar execução sem páginas.
 *
 * O que se prova aqui, e não em `tests/pdf_text_test.ts`: propriedade (RLS por
 * dono), hash/bytes, limites de página, leitura por página a partir da memória
 * gravada e a preservação da extração anterior melhor quando um retry é
 * limitado, mais fraco ou não devolve páginas.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { createEdgeHandler } from "../src/edge.ts";
import { Hub } from "../src/domain.ts";
import { Materials } from "../src/materials.ts";
import { sha256Hex } from "../src/migration.ts";
import { HubError, type Principal } from "../src/contracts.ts";

const DB_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const LATIN_PAGE_TEXT = "Relatório AraHub página 1: ação e coração";

/** Codifica texto como bytes Latin-1 (um byte por code unit). */
function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** Monta um PDF com tabela xref correta a partir dos objetos 1..n. */
function assemblePdf(objects: string[], trailerExtra = ""): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (text: string) => {
    const bytes = latin1(text);
    parts.push(bytes);
    size += bytes.length;
  };
  push("%PDF-1.7\n");
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = size;
    push(`${i} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefStart = size;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${objects.length} /Root 1 0 R${
      trailerExtra ? " " + trailerExtra : ""
    } >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return joinBytes(parts);
}

/** PDF de três páginas: texto Latin-1, texto por glifos e página só com imagem. */
function buildFixturePdf(): Uint8Array {
  const pageCount = 3;
  const objects: string[] = [];
  const kids: string[] = [];
  for (let i = 1; i <= pageCount; i++) kids.push(`${2 + i} 0 R`);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`;
  const fontWinAnsi = 3 + 2 * pageCount;
  const fontDifferences = fontWinAnsi + 1;
  const imageObject = fontDifferences + 1;
  const latinContent = `BT /F1 14 Tf 20 150 Td (${LATIN_PAGE_TEXT}) Tj ET`;
  const unicodeContent = "BT /F2 14 Tf 20 150 Td (ABCDEF) Tj ET";
  const imageContent = "q 20 0 0 20 20 120 cm /Im1 Do Q";
  for (let i = 1; i <= pageCount; i++) {
    const pageObject = 2 + i;
    const contentObject = 2 + pageCount + i;
    const imagePage = i === pageCount;
    const resources = imagePage
      ? `<< /XObject << /Im1 ${imageObject} 0 R >> >>`
      : `<< /Font << /${i === 1 ? "F1" : "F2"} ${
        i === 1 ? fontWinAnsi : fontDifferences
      } 0 R >> >>`;
    objects[pageObject] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources ${resources} /Contents ${contentObject} 0 R >>`;
    const content = i === 1 ? latinContent : imagePage ? imageContent : unicodeContent;
    objects[contentObject] = `<< /Length ${
      latin1(content).length
    } >>\nstream\n${content}\nendstream`;
  }
  objects[fontWinAnsi] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[fontDifferences] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /StandardEncoding /Differences [65 /alpha /beta /Omega /afii10017 /eacute /ntilde] >> >>";
  const imageBytes = "ABCDEFGHIJKL";
  objects[imageObject] =
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imageBytes.length} >>\nstream\n${imageBytes}\nendstream`;
  return assemblePdf(objects);
}

/** PDF com dicionário /Encrypt; pdf.js exige senha e não extrai páginas. */
function buildEncryptedPdf(): Uint8Array {
  const hex = (count: number) =>
    Array.from({ length: count }, (_, i) => ((i * 37) % 256).toString(16).padStart(2, "0")).join(
      "",
    );
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  const stream = "BT /F1 12 Tf 20 100 Td (segredo) Tj ET";
  objects[4] = `<< /Length ${latin1(stream).length} >>\nstream\n${stream}\nendstream`;
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[6] = `<< /Filter /Standard /V 1 /R 2 /O <${hex(32)}> /U <${hex(32)}> /P -44 >>`;
  return assemblePdf(objects, `/Encrypt 6 0 R /ID [<${hex(16)}> <${hex(16)}>]`);
}

/** Extração anterior sintética, para modelar o estado já guardado de um hash. */
function priorStoredExtraction(
  pages: Array<{ page: number; text: string; truncated?: boolean }>,
  coverage = "complete",
) {
  const built = pages.map((page) => ({
    page: page.page,
    locator: `pdf:page:${page.page}`,
    text: page.text,
    char_count: page.text.length,
    has_text: page.text.length > 0,
    text_absent: page.text.length === 0,
    truncated: page.truncated === true,
    image_count: 0,
    ocr: "not_performed",
    bounds: { width_pt: 300, height_pt: 200, rotate: 0 },
  }));
  return {
    kind: "pdf_text_extraction",
    ok: true,
    coverage,
    complete: coverage === "complete",
    text_available: true,
    execution: "isolated_worker",
    hard_timeout: true,
    page_count: built.length,
    pages_returned: built.length,
    pages: built,
    page_bounds: {
      first_page: built[0].page,
      last_page: built[built.length - 1].page,
      pages_in_document: built.length,
      pages_returned: built.length,
    },
    omitted_pages: [],
    errors: [],
    images_not_interpreted: true,
    images_detected: 0,
    ocr: "not_performed",
    pages_without_text: 0,
    text_truncated: false,
    limits: [],
    notes: [],
    content_is_untrusted_data: true,
    byte_length: 0,
    elapsed_ms: 0,
  };
}

function priorStoredText(pages: Array<{ page: number; text: string }>): string {
  return pages.map((page) => `[[página ${page.page} pdf:page:${page.page}]]\n${page.text}`).join(
    "\n",
  );
}

async function seedFile(
  db: ReturnType<typeof createDb>,
  ownerId: string,
  bytes: Uint8Array,
  overrides: {
    hash?: string;
    mime?: string;
    name?: string;
    extraction?: unknown;
    extractedText?: string | null;
  } = {},
): Promise<{ fileId: string; hash: string }> {
  const hash = overrides.hash ?? (await sha256Hex(bytes));
  const [connection] =
    await db`insert into public.hub_connections(owner_id,provider,label) values(${ownerId},'migration','fixture pdf') returning id`;
  const [entity] =
    await db`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title) values(${ownerId},${connection.id},'resource',${crypto.randomUUID()},'fixture PDF') returning id`;
  const [file] =
    await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${ownerId},${entity.id},${
      overrides.name ?? "fixture.pdf"
    },${overrides.mime ?? "application/pdf"},${hash},${bytes.byteLength},${Buffer.from(bytes)},${
      overrides.extractedText ?? null
    },${
      // db.json serializa como jsonb; o round-trip evita dupla codificação.
      db.json(JSON.parse(JSON.stringify(overrides.extraction ?? {})))}) returning id`;
  return { fileId: file.id as string, hash };
}

async function readStored(
  db: ReturnType<typeof createDb>,
  fileId: string,
): Promise<{ extraction: Record<string, unknown>; extracted_text: string | null; bytes: number }> {
  const [row] =
    await db`select extraction,extracted_text,octet_length(binary_content)::integer as bytes from public.hub_files where id=${fileId}`;
  return row as {
    extraction: Record<string, unknown>;
    extracted_text: string | null;
    bytes: number;
  };
}

function isHubError(code: string) {
  return (error: unknown) => error instanceof HubError && error.code === code;
}

Deno.test("A05 A23: extractPdf grava páginas do PDF preservado e pdfPage lê por página (SQL real)", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() },
    other: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, pdf, { hash });
    // Sem ConnectionService: arquivo já preservado é extraível/legível offline.
    const materials = new Materials(hub);

    const result = await materials.extractPdf(owner, seeded.fileId, hash);
    assert.equal(result.memory_updated, true);
    assert.equal(result.content_is_untrusted_data, true);
    assert.equal(result.extraction.kind, "pdf_text_extraction");
    assert.equal(result.extraction.ok, true);
    assert.equal(result.extraction.error_code, undefined);
    assert.equal(result.extraction.coverage, "complete");
    assert.equal(result.extraction.execution, "isolated_worker");
    assert.equal(result.extraction.hard_timeout, true);
    assert.equal(result.extraction.ocr, "not_performed");
    assert.equal(result.extraction.page_count, 3);
    assert.equal(result.extraction.pages_returned, 3);
    assert.deepEqual(result.extraction.omitted_pages, []);
    // O run devolve páginas sem o texto; o texto fica só na memória privada.
    assert.ok(result.extraction.pages.every((page) => !("text" in page)));
    assert.equal(result.memory.complete, true);
    assert.equal(result.memory.text_available, true);
    assert.equal(result.memory.pages, 3);
    assert.equal(result.memory.pages_added, 3);
    assert.equal(result.memory.pages_updated, 0);
    assert.equal(result.memory.pages_from_prior, 0);

    const stored = await readStored(db, seeded.fileId);
    assert.equal(stored.bytes, pdf.byteLength);
    const memory = stored.extraction as {
      coverage: string;
      complete: boolean;
      text_available: boolean;
      pages: Array<Record<string, unknown>>;
    };
    assert.equal(memory.coverage, "complete");
    assert.equal(memory.complete, true);
    assert.equal(memory.text_available, true);
    assert.equal(memory.pages.length, 3);
    assert.equal(memory.pages[0].locator, "pdf:page:1");
    assert.equal(memory.pages[0].text, LATIN_PAGE_TEXT);
    assert.equal(memory.pages[0].has_text, true);
    assert.equal(memory.pages[2].text, "");
    assert.equal(memory.pages[2].has_text, false);
    assert.equal(memory.pages[2].image_count, 1);
    assert.match(stored.extracted_text ?? "", /\[\[página 1 pdf:page:1\]\]/);
    assert.match(stored.extracted_text ?? "", /sem texto extraído/);

    const listed = await hub.files(owner);
    const summary = listed.records.find((file) => file.id === seeded.fileId)?.extraction;
    assert.equal(summary?.coverage, "complete");
    assert.equal(summary?.page_count, 3);
    assert.equal(Object.hasOwn(summary ?? {}, "pages"), false);
    assert.equal(JSON.stringify(listed).includes(LATIN_PAGE_TEXT), false);

    const page1 = await materials.pdfPage(owner, seeded.fileId, hash, 1);
    assert.equal(page1.page.page, 1);
    assert.equal(page1.page.locator, "pdf:page:1");
    assert.equal(page1.page.text, LATIN_PAGE_TEXT);
    assert.equal(page1.coverage, "complete");
    assert.equal(page1.ocr, "not_performed");
    assert.equal(page1.content_is_untrusted_data, true);
    assert.ok(page1.limits.some((limit: string) => limit.includes("sem OCR")));

    const page3 = await materials.pdfPage(owner, seeded.fileId, hash, 3);
    assert.equal(page3.page.has_text, false);
    assert.equal(page3.page.text_absent, true);
    assert.equal(page3.page.image_count, 1);

    const page9 = await materials.pdfPage(owner, seeded.fileId, hash, 9);
    assert.equal(page9.page, null);
    assert.equal(page9.coverage, "page_not_extracted");

    await assert.rejects(materials.pdfPage(owner, seeded.fileId, hash, 0), /Página inválida/);
    await assert.rejects(materials.pdfPage(owner, seeded.fileId, hash, 1.5), /Página inválida/);

    // Isolamento por dono: nenhuma linha vaza para outro principal.
    await assert.rejects(materials.extractPdf(other, seeded.fileId, hash), isHubError("not_found"));
    await assert.rejects(
      materials.pdfPage(other, seeded.fileId, hash, 1),
      isHubError("not_found"),
    );
    const visible = await hub.files(other);
    assert.equal(visible.records.length, 0);
  } finally {
    await db.end();
  }
});

Deno.test("A05: hash divergente e bytes adulterados recusam sem tocar a memória guardada", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, pdf, { hash });
    const materials = new Materials(hub);
    await materials.extractPdf(owner, seeded.fileId, hash);
    const before = await readStored(db, seeded.fileId);

    await assert.rejects(
      materials.extractPdf(owner, seeded.fileId, "0".repeat(64)),
      isHubError("file_changed"),
    );
    await assert.rejects(
      materials.pdfPage(owner, seeded.fileId, "0".repeat(64), 1),
      isHubError("file_changed"),
    );

    // sha256 registrado igual ao informado, mas os bytes não conferem.
    const fakeHash = "f".repeat(64);
    const forged = await seedFile(db, owner.ownerId, pdf, { hash: fakeHash });
    await assert.rejects(
      materials.extractPdf(owner, forged.fileId, fakeHash),
      isHubError("file_integrity"),
    );

    const text = await seedFile(db, owner.ownerId, latin1("não é pdf"), {
      mime: "text/plain",
      name: "nota.txt",
    });
    await assert.rejects(
      materials.extractPdf(owner, text.fileId, text.hash),
      isHubError("pdf_required"),
    );

    const after = await readStored(db, seeded.fileId);
    assert.deepEqual(after.extraction, before.extraction);
    assert.equal(after.extracted_text, before.extracted_text);
  } finally {
    await db.end();
  }
});

Deno.test("A23: limite de páginas declara lacuna e a execução seguinte completa a cobertura", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, pdf);
    const materials = new Materials(hub);

    const limited = await materials.extractPdf(owner, seeded.fileId, hash, 2);
    assert.equal(limited.extraction.coverage, "partial");
    assert.equal(limited.extraction.pages_returned, 2);
    assert.deepEqual(limited.extraction.omitted_pages, [3]);
    assert.equal(limited.memory.complete, false);
    assert.equal(limited.memory.pages, 2);
    assert.equal(limited.memory_updated, true);

    const gap = await materials.pdfPage(owner, seeded.fileId, hash, 3);
    assert.equal(gap.page, null);
    assert.equal(gap.coverage, "page_not_extracted");

    const full = await materials.extractPdf(owner, seeded.fileId, hash);
    assert.equal(full.memory_updated, true);
    assert.equal(full.memory.complete, true);
    assert.equal(full.memory.pages, 3);
    assert.equal(full.memory.pages_added, 1);
    assert.equal(full.memory.pages_from_prior, 2);
    assert.equal(full.extraction.coverage, "complete");

    const stored = await readStored(db, seeded.fileId);
    const memory = stored.extraction as {
      coverage: string;
      merge: { pages_added: number; pages_retained: number[]; prior_pages: number };
      pages: Array<Record<string, unknown>>;
    };
    assert.equal(memory.coverage, "complete");
    assert.equal(memory.pages.length, 3);
    assert.equal(memory.merge.pages_added, 1);
    assert.equal(memory.merge.prior_pages, 2);
    assert.deepEqual(memory.merge.pages_retained, [1, 2]);
    assert.match(stored.extracted_text ?? "", /\[\[página 3 pdf:page:3\]\]/);

    const filled = await materials.pdfPage(owner, seeded.fileId, hash, 3);
    assert.equal(filled.page.page, 3);
    assert.equal(filled.page.has_text, false);
  } finally {
    await db.end();
  }
});

Deno.test("A23: retry limitado preserva a extração anterior melhor do mesmo hash", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, pdf);
    const materials = new Materials(hub);

    const full = await materials.extractPdf(owner, seeded.fileId, hash);
    assert.equal(full.memory.complete, true);
    const before = await readStored(db, seeded.fileId);

    // Retry limitado: uma única página, o resto declarado como lacuna.
    const retry = await materials.extractPdf(owner, seeded.fileId, hash, 1);
    assert.equal(retry.extraction.pages_returned, 1);
    assert.equal(retry.extraction.coverage, "partial");
    assert.deepEqual(retry.extraction.omitted_pages, [2, 3]);
    assert.equal(retry.memory_updated, false);
    assert.equal(retry.memory.pages, 3);
    assert.equal(retry.memory.complete, true);
    assert.equal(retry.memory.pages_from_prior, 1);

    const after = await readStored(db, seeded.fileId);
    assert.deepEqual(after.extraction, before.extraction);
    assert.equal(after.extracted_text, before.extracted_text);
    assert.match(after.extracted_text ?? "", /\[\[página 3 pdf:page:3\]\]/);

    const page3 = await materials.pdfPage(owner, seeded.fileId, hash, 3);
    assert.equal(page3.page.page, 3);
    assert.equal(page3.coverage, "complete");
  } finally {
    await db.end();
  }
});

Deno.test("A23: um decode posterior mais fraco não apaga texto anterior do mesmo hash", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    // Estado anterior melhor: a página 1 tem mais texto do que o decode atual.
    const priorText = LATIN_PAGE_TEXT + " (trecho adicional preservado)";
    const priorPages = [
      { page: 1, text: priorText },
      { page: 2, text: "αβΩАéñ" },
    ];
    const seeded = await seedFile(db, owner.ownerId, pdf, {
      extraction: priorStoredExtraction(priorPages),
      extractedText: priorStoredText(priorPages),
    });
    const materials = new Materials(hub);

    const result = await materials.extractPdf(owner, seeded.fileId, hash);
    assert.equal(result.memory_updated, true);
    assert.equal(result.memory.complete, true);
    assert.equal(result.memory.pages, 3);
    assert.equal(result.memory.pages_from_prior, 2);
    assert.equal(result.memory.pages_added, 1);

    const after = await readStored(db, seeded.fileId);
    const memory = after.extraction as {
      coverage: string;
      pages: Array<Record<string, unknown>>;
      merge: { pages_retained: number[] };
    };
    assert.equal(memory.coverage, "complete");
    assert.equal(memory.pages[0].text, priorText);
    assert.equal(memory.pages[0].char_count, priorText.length);
    assert.deepEqual(memory.merge.pages_retained, [1, 2]);
    assert.match(after.extracted_text ?? "", /trecho adicional preservado/);
    assert.match(after.extracted_text ?? "", /\[\[página 3 pdf:page:3\]\]/);
  } finally {
    await db.end();
  }
});

Deno.test("A23: execução sem páginas não apaga a extração anterior do mesmo hash", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildEncryptedPdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    // O estado anterior é semeado diretamente para modelar uma extração já
    // guardada; a execução corrente, esta sim real, não devolve páginas.
    const priorPages = [{ page: 1, text: "anterior um" }, { page: 2, text: "anterior dois" }];
    const seeded = await seedFile(db, owner.ownerId, pdf, {
      extraction: priorStoredExtraction(priorPages),
      extractedText: priorStoredText(priorPages),
    });
    const materials = new Materials(hub);
    const before = await readStored(db, seeded.fileId);

    const result = await materials.extractPdf(owner, seeded.fileId, hash);
    assert.equal(result.extraction.ok, false);
    assert.equal(result.extraction.error_code, "encrypted");
    assert.equal(result.extraction.coverage, "denied");
    assert.equal(result.extraction.pages_returned, 0);
    assert.equal(result.memory_updated, false);
    assert.equal(result.memory.pages, 2);
    assert.equal(result.memory.complete, true);
    assert.equal(result.memory.text_available, true);

    const after = await readStored(db, seeded.fileId);
    assert.deepEqual(after.extraction, before.extraction);
    assert.equal(after.extracted_text, before.extracted_text);

    const page = await materials.pdfPage(owner, seeded.fileId, hash, 1);
    assert.equal(page.page.text, "anterior um");
    assert.equal(page.coverage, "complete");
  } finally {
    await db.end();
  }
});

Deno.test("A05: sem ConnectionService os caminhos Moodle recusam explicitamente", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const materials = new Materials(hub);
    await assert.rejects(
      materials.preserveMoodle(owner, crypto.randomUUID(), 123, "f_" + "a".repeat(64)),
      isHubError("connection_unavailable"),
    );
  } finally {
    await db.end();
  }
});

Deno.test("A23: página truncada retida não declara cobertura completa", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    // Estado anterior com uma página truncada e mais texto que o decode atual:
    // a página truncada é retida, então a cobertura não pode virar "completa".
    const truncatedText = "x".repeat(120) + LATIN_PAGE_TEXT;
    const priorPages = [
      { page: 1, text: truncatedText, truncated: true },
      { page: 2, text: "αβΩАéñ" },
    ];
    const seeded = await seedFile(db, owner.ownerId, pdf, {
      extraction: priorStoredExtraction(priorPages, "partial"),
      extractedText: priorStoredText(priorPages),
    });
    const materials = new Materials(hub);

    const result = await materials.extractPdf(owner, seeded.fileId, hash);
    // A execução corrente é limpa (sem erro nem corte), mas a página truncada
    // retida impede declarar a memória completa.
    assert.deepEqual(result.extraction.errors, []);
    assert.equal(result.extraction.text_truncated, false);
    assert.equal(result.memory_updated, true);
    assert.equal(result.memory.pages, 3);
    assert.equal(result.memory.pages_added, 1);
    assert.equal(result.memory.complete, false);
    assert.equal(result.memory.coverage, "partial");

    const stored = await readStored(db, seeded.fileId);
    const memory = stored.extraction as {
      coverage: string;
      complete: boolean;
      pages: Array<Record<string, unknown>>;
    };
    assert.equal(memory.coverage, "partial");
    assert.equal(memory.complete, false);
    assert.equal(memory.pages.length, 3);
    assert.equal(memory.pages[0].truncated, true);
    assert.equal(memory.pages[0].text, truncatedText);
  } finally {
    await db.end();
  }
});

Deno.test("A23: extratores concorrentes do mesmo hash não perdem a extração melhor", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner: Principal = { ownerId: crypto.randomUUID() };
  try {
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    await db`insert into auth.users(id) values(${owner.ownerId})`;
    const seeded = await seedFile(db, owner.ownerId, pdf);
    const materials = new Materials(hub);

    // O extrator limitado e o completo disputam a mesma linha; o merge sob lock
    // garante que a versão de 3 páginas sobreviva independentemente da ordem.
    const [, full] = await Promise.all([
      materials.extractPdf(owner, seeded.fileId, hash, 2),
      materials.extractPdf(owner, seeded.fileId, hash),
    ]);
    assert.equal(full.memory.pages, 3);

    const stored = await readStored(db, seeded.fileId);
    const memory = stored.extraction as { coverage: string; pages: unknown[] };
    assert.equal(memory.pages.length, 3);
    assert.equal(memory.coverage, "complete");
    assert.match(stored.extracted_text ?? "", /\[\[página 3 pdf:page:3\]\]/);
  } finally {
    await db.end();
  }
});

/** Conteúdo JSON devolvido pelas ferramentas MCP (texto é dado do proprietário). */
function payloadOf(result: unknown) {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}") as {
    code?: string;
    sha256?: string;
    content_is_untrusted_data?: boolean;
    memory?: { pages?: number; complete?: boolean };
    extraction?: { coverage?: string; pages_returned?: number };
    page?: { text?: string; locator?: string; has_text?: boolean; image_count?: number } | null;
  };
}

Deno.test("A23: cliente MCP SDK lê páginas do PDF e novo cliente retoma sem ConnectionService", async () => {
  const db = createDb(DB_URL), hub = new Hub(db);
  const owner = crypto.randomUUID(), sid = crypto.randomUUID();
  const base = "https://fixture.invalid/functions/v1/arahub";
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  // Identidade e HTTP sintéticos explícitos: JWKS local, dono e sessão fixados.
  const auth = {
    issuer: "https://identity.invalid/auth",
    audience: "authenticated",
    resource: `${base}/mcp`,
    allowedClientIds: ["pdf-fixture"],
    key: createLocalJWKSet({
      keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "ES256" }],
    }),
    sessionActive: (o: string, s: string) => Promise.resolve(o === owner && s === sid),
  };
  // Sem ConnectionService: as ferramentas de PDF atendem arquivos preservados.
  const handler = createEdgeHandler(hub, auth, base + "/");
  const token = await new SignJWT({
    role: "authenticated",
    session_id: sid,
    client_id: "pdf-fixture",
  }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(owner).setIssuer(auth.issuer)
    .setAudience(auth.audience).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const connect = async () => {
    const client = new Client({ name: "pdf-fixture", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(auth.resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: (input: string | URL | Request, init?: RequestInit) =>
          handler(new Request(input, init)),
      }),
    );
    return client;
  };
  try {
    await db`insert into auth.users(id) values(${owner})`;
    const pdf = buildFixturePdf(), hash = await sha256Hex(pdf);
    const seeded = await seedFile(db, owner, pdf, { hash });

    const client = await connect();
    const tools = (await client.listTools()).tools.map((tool: { name: string }) => tool.name);
    assert.ok(tools.includes("hub_extract_pdf"));
    assert.ok(tools.includes("hub_pdf_page"));

    const extracted = await client.callTool({
      name: "hub_extract_pdf",
      arguments: { file_id: seeded.fileId, sha256: hash },
    });
    assert.equal(extracted.isError, undefined);
    const run = payloadOf(extracted);
    assert.equal(run.sha256, hash);
    assert.equal(run.extraction?.coverage, "complete");
    assert.equal(run.extraction?.pages_returned, 3);
    assert.equal(run.memory?.complete, true);

    const page1 = payloadOf(
      await client.callTool({
        name: "hub_pdf_page",
        arguments: { file_id: seeded.fileId, sha256: hash, page: 1 },
      }),
    );
    assert.equal(page1.page?.text, LATIN_PAGE_TEXT);
    assert.equal(page1.page?.locator, "pdf:page:1");
    assert.equal(page1.content_is_untrusted_data, true);
    const page2 = payloadOf(
      await client.callTool({
        name: "hub_pdf_page",
        arguments: { file_id: seeded.fileId, sha256: hash, page: 2 },
      }),
    );
    assert.equal(page2.page?.text, "αβΩАéñ");
    await client.close();

    // Cliente novo retoma a página a partir da memória já gravada.
    const resumed = await connect();
    const page3 = payloadOf(
      await resumed.callTool({
        name: "hub_pdf_page",
        arguments: { file_id: seeded.fileId, sha256: hash, page: 3 },
      }),
    );
    assert.equal(page3.page?.has_text, false);
    assert.equal(page3.page?.image_count, 1);

    const wrongPage = await resumed.callTool({
      name: "hub_pdf_page",
      arguments: { file_id: seeded.fileId, sha256: "0".repeat(64), page: 1 },
    });
    assert.equal(wrongPage.isError, true);
    assert.equal(payloadOf(wrongPage).code, "file_changed");
    const wrongExtract = await resumed.callTool({
      name: "hub_extract_pdf",
      arguments: { file_id: seeded.fileId, sha256: "0".repeat(64) },
    });
    assert.equal(wrongExtract.isError, true);
    assert.equal(payloadOf(wrongExtract).code, "file_changed");
    await resumed.close();
  } finally {
    await db.end();
  }
});
