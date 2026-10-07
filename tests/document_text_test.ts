/**
 * Provas da extração estruturada de DOCX e HTML (src/document_text.ts).
 *
 * As fixtures são sintéticas e não privadas: os pacotes OOXML são montados no
 * próprio teste (ZIP real, entradas stored e deflate, CRC correto) e o HTML é
 * escrito à mão. Nada é baixado da rede e nenhum conteúdo de terceiro é usado.
 */
import assert from "node:assert/strict";
import {
  crc32,
  documentExtractionToText,
  extractDocumentText,
  extractDocxText,
  extractHtmlText,
  inspectOfficeArchive,
  MAX_TEXT_CHARS,
  sanitizeHtmlDocument,
} from "../src/document_text.ts";
import { HubError } from "../src/contracts.ts";
import {
  extractAudioForAsr,
  extractFrameAt,
  filterOptionValue,
  isGraphSafePath,
  mediaTools,
  parseSubtitleCues,
  probeMediaFile,
  processVideo,
  shouldReuseTranscription,
  transcribeLocal,
} from "../src/material_processor.ts";

// --- Construtor de ZIP válido -----------------------------------------------

interface ZipSpec {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  declaredUncompressed?: number;
  declaredCompressed?: number;
  crcOverride?: number;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  })();
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  await writer.write(copy);
  await writer.close();
  await pump;
  return concat(chunks);
}

const encoder = new TextEncoder();

/** Monta um ZIP com diretório central e EOCD coerentes (compactado ou não). */
async function buildZip(specs: ZipSpec[], deflateAll = false): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const spec of specs) {
    const method: number = spec.method ?? (deflateAll ? 8 : 0);
    const body = method === 8 ? await deflateRaw(spec.data) : spec.data;
    const nameBytes = encoder.encode(spec.name);
    const crc = spec.crcOverride ?? crc32(spec.data);
    const uncompressedSize = spec.declaredUncompressed ?? spec.data.length;
    const compressedSize = spec.declaredCompressed ?? body.length;
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, spec.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, spec.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const directory = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, specs.length, true);
  ev.setUint16(10, specs.length, true);
  ev.setUint32(12, directory.length, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, directory, eocd]);
}

function entry(name: string, xml: string): ZipSpec {
  return { name, data: encoder.encode(xml) };
}

// --- Fixture OOXML ----------------------------------------------------------

const CONTENT_TYPES = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const PACKAGE_RELS =
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS =
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/guia?x=1&amp;y=2" TargetMode="External"/>
<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

const STYLES = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Destaque"><w:name w:val="Destaque"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Aviso"><w:name w:val="Aviso"/><w:basedOn w:val="Destaque"/></w:style>
<w:style w:type="paragraph" w:styleId="Citacao"><w:name w:val="Quote"/></w:style>
</w:styles>`;

const NUMBERING =
  `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const CORE =
  `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>Ficha da Etividade 1</dc:title>
<dc:creator>Autor Sintético</dc:creator>
<cp:lastModifiedBy>Revisor Sintético</cp:lastModifiedBy>
<cp:revision>3</cp:revision>
<dcterms:modified>2026-03-01T10:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Ttulo1"/></w:pPr><w:r><w:t>Ficha da Etividade 1</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Primeiro critério </w:t></w:r><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>com ênfase</w:t></w:r></w:p>
<w:p><w:r><w:t>Veja o </w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:t>guia oficial</w:t></w:r></w:hyperlink><w:r><w:t> e a </w:t></w:r><w:hyperlink w:anchor="sec2"><w:r><w:t>seção 2</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Ttulo2"/></w:pPr><w:r><w:t>Critérios de avaliação</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Cabeçalho mesclado</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Critério A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Peso 40%</w:t></w:r></w:p><w:p><w:r><w:t>Com justificativa</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>continuação</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Referências</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:del><w:r><w:delText>trecho excluído</w:delText></w:r></w:del><w:ins><w:r><w:t>trecho inserido</w:t></w:r></w:ins></w:p>
<w:p><w:r><w:drawing><wp:inline><a:graphic><a:blip r:embed="rId7"/></a:graphic></wp:inline></w:drawing></w:r><w:r><w:t> Figura 1</w:t></w:r></w:p>
<w:p><w:r><w:t>Nota com referência</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Aviso"/></w:pPr><w:r><w:t>Aviso herdado</w:t></w:r></w:p>
<w:sectPr/>
</w:body></w:document>`;

function docxEntries(): ZipSpec[] {
  return [
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry("_rels/.rels", PACKAGE_RELS),
    entry("word/document.xml", DOCUMENT),
    entry("word/_rels/document.xml.rels", DOCUMENT_RELS),
    entry("word/styles.xml", STYLES),
    entry("word/numbering.xml", NUMBERING),
    entry("docProps/core.xml", CORE),
    entry("word/media/image1.png", "PNG-sintético-sem-bytes-reais"),
  ];
}

const DOCUMENT_BYTES = encoder.encode(DOCUMENT);
const STYLES_BYTES = encoder.encode(STYLES);
const NUMBERING_BYTES = encoder.encode(NUMBERING);

// --- DOCX: extração ---------------------------------------------------------

Deno.test("docx: extração estruturada preserva parágrafos, tabelas e links", async () => {
  const bytes = await buildZip(docxEntries());
  const result = await extractDocxText(bytes);
  assert.equal(result.kind, "document_text_extraction");
  assert.equal(result.format, "docx");
  assert.equal(result.ok, true);
  assert.equal(result.coverage, "complete");
  assert.equal(result.execution, "in_process");
  assert.equal(result.content_is_untrusted_data, true);

  const paragraphs = result.blocks.filter((block) => block.type === "paragraph");
  const tables = result.blocks.filter((block) => block.type === "table");
  assert.equal(tables.length, 1);

  const title = paragraphs[0];
  assert.equal(title.locator, "docx:p:1");
  assert.equal(title.text, "Ficha da Etividade 1");
  assert.equal(title.heading_level, 1);
  assert.equal(title.style_id, "Ttulo1");
  assert.equal(title.style_name, "heading 1");

  const firstItem = paragraphs[1];
  assert.equal(firstItem.locator, "docx:p:2");
  assert.deepEqual(firstItem.list, { level: 0, num_id: "1", num_fmt: "decimal" });
  assert.equal(firstItem.text, "Primeiro critério com ênfase");
  assert.equal(firstItem.spans.length, 2);
  assert.equal(firstItem.spans[1].bold, true);
  assert.equal(firstItem.spans[1].italic, true);
  assert.equal(firstItem.spans[1].start, "Primeiro critério ".length);

  const links = paragraphs[2];
  assert.equal(links.links.length, 2);
  assert.equal(links.links[0].locator, "docx:link:1");
  assert.equal(links.links[0].text, "guia oficial");
  assert.equal(links.links[0].kind, "external");
  assert.equal(links.links[0].target, "https://example.org/guia?x=1&y=2");
  assert.equal(links.links[1].kind, "internal");
  assert.equal(links.links[1].anchor, "sec2");
  assert.equal(links.links[1].target, null);

  const heading2 = paragraphs.find((block) => block.text === "Critérios de avaliação");
  assert.ok(heading2);
  assert.equal(heading2.heading_level, 2);

  const inherited = paragraphs.find((block) => block.text === "Aviso herdado");
  assert.ok(inherited);
  assert.equal(inherited.style_id, "Aviso");
  assert.equal(inherited.heading_level, 3, "outline herdado de Destaque (basedOn)");

  const table = tables[0];
  assert.equal(table.locator, "docx:table:1");
  assert.equal(table.rows, 3);
  assert.equal(table.columns, 2);
  assert.equal(table.cells.length, 5);
  const headerCell = table.cells[0];
  assert.equal(headerCell.locator, "docx:table:1:r1:c1");
  assert.equal(headerCell.grid_span, 2);
  assert.equal(headerCell.text, "Cabeçalho mesclado");
  const merged = table.cells.find((cell) => cell.text === "Critério A");
  assert.ok(merged);
  assert.equal(merged.v_merge, "restart");
  const continuation = table.cells.find((cell) => cell.text === "continuação");
  assert.ok(continuation);
  assert.equal(continuation.v_merge, "continue");
  const multiParagraph = table.cells.find((cell) => cell.text.startsWith("Peso 40%"));
  assert.ok(multiParagraph);
  assert.equal(multiParagraph.paragraphs, 2);
  assert.equal(multiParagraph.text, "Peso 40%\nCom justificativa");
  const tableLines = table.text.split("\n");
  assert.equal(tableLines[0], "Cabeçalho mesclado");
  assert.equal(tableLines[1], "Critério A | Peso 40% Com justificativa");
  assert.equal(tableLines[2], "continuação | Referências");

  const fields = paragraphs.find((block) => block.fields.length > 0);
  assert.ok(fields);
  assert.deepEqual(fields.fields, ["PAGE"]);
  assert.equal(result.field_count, 1);

  const revision = paragraphs.find((block) => block.text.includes("trecho inserido"));
  assert.ok(revision);
  assert.equal(revision.text, "trecho inserido");
  assert.ok(result.gaps.includes("texto_excluido_por_revisao_nao_incluido"));

  assert.equal(result.image_count, 1);
  assert.ok(result.gaps.includes("nota_de_rodape_nao_incluida"));
  assert.ok(result.gaps.includes("celula_mesclada_horizontalmente"));
  assert.ok(result.gaps.includes("celula_mesclada_verticalmente"));

  assert.equal(result.metadata.title, "Ficha da Etividade 1");
  assert.equal(result.metadata.creator, "Autor Sintético");
  assert.equal(result.metadata.revision, "3");
  assert.deepEqual(result.parts_read, [
    "word/document.xml",
    "word/_rels/document.xml.rels",
    "word/styles.xml",
    "word/numbering.xml",
    "docProps/core.xml",
  ]);
  assert.equal(
    result.media_type,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  const text = documentExtractionToText(result);
  assert.ok(text.includes("[[docx:p:1]]"));
  assert.ok(text.includes("Ficha da Etividade 1"));
  assert.ok(text.includes("[[docx:link:1]] guia oficial -> https://example.org/guia?x=1&y=2"));
  assert.ok(text.includes("[[tabela 1 docx:table:1]]"));
  assert.ok(text.includes("[docx:table:1:r2:c1] Critério A"));
});

Deno.test("docx: entradas deflate produzem o mesmo resultado que stored", async () => {
  const stored = await extractDocxText(await buildZip(docxEntries()));
  const deflated = await extractDocxText(await buildZip(docxEntries(), true));
  assert.equal(deflated.ok, true);
  assert.equal(deflated.coverage, "complete");
  assert.equal(deflated.block_count, stored.block_count);
  assert.equal(deflated.characters, stored.characters);
  assert.equal(deflated.link_count, stored.link_count);
  assert.equal(deflated.table_count, 1);
});

// --- DOCX: entradas hostis e limites ----------------------------------------

Deno.test("docx: recusa entrada vazia, não-ZIP, excesso e arquivo truncado", async () => {
  const empty = await extractDocxText(new Uint8Array(0));
  assert.equal(empty.ok, false);
  assert.equal(empty.error_code, "empty_input");
  assert.equal(empty.coverage, "parsing_error");
  assert.equal(empty.content_is_untrusted_data, true);

  const notZip = await extractDocxText(encoder.encode("apenas texto, sem pacote"));
  assert.equal(notZip.error_code, "not_a_docx");
  assert.equal(notZip.coverage, "parsing_error");

  const oversized = await extractDocxText(await buildZip(docxEntries()), { maxBytes: 10 });
  assert.equal(oversized.error_code, "oversized");
  assert.equal(oversized.coverage, "unavailable");

  const truncated = await extractDocxText(encoder.encode("PK\u0003\u0004sem-nada-depois"));
  assert.equal(truncated.ok, false);
  assert.equal(truncated.error_code, "invalid_zip");

  const zeroOptions = await buildZip(docxEntries());
  await assert.rejects(
    () => extractDocxText(zeroOptions, { maxBytes: 0 }),
    (error: unknown) => error instanceof HubError && error.code === "invalid_document_options",
  );
});

Deno.test("docx: opções fora do intervalo lançam HubError", async () => {
  await assert.rejects(
    () => extractDocxText(new Uint8Array([0x50, 0x4b]), { maxBlocks: 0 }),
    (error: unknown) => error instanceof HubError && error.code === "invalid_document_options",
  );
  await assert.rejects(
    () => extractDocxText(new Uint8Array([0x50, 0x4b]), { maxTextChars: MAX_TEXT_CHARS + 1 }),
    (error: unknown) => error instanceof HubError,
  );
});

Deno.test("docx: recusa pacote cifrado, método exótico, nome inseguro e duplicado", async () => {
  const encrypted = await buildZip([
    { ...entry("[Content_Types].xml", CONTENT_TYPES), flags: 0x1 },
    entry("word/document.xml", DOCUMENT),
  ]);
  const encryptedResult = await extractDocxText(encrypted);
  assert.equal(encryptedResult.error_code, "document_encrypted");
  assert.equal(encryptedResult.coverage, "denied");

  const duplicated = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry("word/document.xml", DOCUMENT),
    entry("word/document.xml", DOCUMENT),
  ]);
  assert.equal((await extractDocxText(duplicated)).error_code, "unsafe_archive");

  const unsupported = await extractDocxText(
    await buildZip([
      entry("[Content_Types].xml", CONTENT_TYPES),
      { name: "word/document.xml", data: DOCUMENT_BYTES, method: 12 },
    ]),
  );
  assert.equal(unsupported.error_code, "unsupported_compression");
  assert.equal(unsupported.coverage, "unavailable");

  const unsafeName = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry("word/document.xml", DOCUMENT),
    entry("../fora.xml", "<x/>"),
  ]);
  const unsafeResult = await extractDocxText(unsafeName);
  assert.equal(unsafeResult.error_code, "unsafe_archive");

  const absoluteName = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry("word/document.xml", DOCUMENT),
    entry("C:/windows/system32/evil.xml", "<x/>"),
  ]);
  assert.equal((await extractDocxText(absoluteName)).error_code, "unsafe_archive");
});

Deno.test("docx: recusa bomba de descompressão e total declarado acima do limite", async () => {
  const bomb = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    {
      name: "word/document.xml",
      data: DOCUMENT_BYTES,
      method: 8,
      declaredUncompressed: 30 * 1024 * 1024,
    },
  ]);
  const bombResult = await extractDocxText(bomb);
  assert.equal(bombResult.error_code, "zip_limits_exceeded");
  assert.equal(bombResult.coverage, "unavailable");

  const many = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    {
      name: "word/document.xml",
      data: DOCUMENT_BYTES,
      declaredUncompressed: 40 * 1024 * 1024,
      declaredCompressed: 200_000,
    },
    {
      name: "word/styles.xml",
      data: STYLES_BYTES,
      declaredUncompressed: 40 * 1024 * 1024,
      declaredCompressed: 200_000,
    },
    {
      name: "word/numbering.xml",
      data: NUMBERING_BYTES,
      declaredUncompressed: 40 * 1024 * 1024,
      declaredCompressed: 200_000,
    },
  ]);
  assert.equal((await extractDocxText(many)).error_code, "zip_limits_exceeded");
});

Deno.test("docx: CRC e tamanho divergentes são integridade, não leitura", async () => {
  const badCrc = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    { ...entry("word/document.xml", DOCUMENT), crcOverride: 0xdeadbeef },
  ]);
  const crcResult = await extractDocxText(badCrc);
  assert.equal(crcResult.error_code, "zip_integrity");
  assert.equal(crcResult.blocks.length, 0);

  const badSize = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    { ...entry("word/document.xml", DOCUMENT), declaredUncompressed: DOCUMENT_BYTES.length + 7 },
  ]);
  assert.equal((await extractDocxText(badSize)).error_code, "zip_integrity");
});

Deno.test("docx: parte principal ausente e XML malicioso ou truncado", async () => {
  const missing = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry("word/styles.xml", STYLES),
  ]);
  const missingResult = await extractDocxText(missing);
  assert.equal(missingResult.error_code, "missing_document_part");
  assert.equal(missingResult.coverage, "parsing_error");

  const doctype = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry(
      "word/document.xml",
      '<!DOCTYPE w:document [<!ENTITY lol "ha"><!ENTITY lol2 "&lol;&lol;&lol;">]>' +
        "<w:document><w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>",
    ),
  ]);
  const doctypeResult = await extractDocxText(doctype);
  assert.equal(doctypeResult.error_code, "invalid_xml");
  assert.ok(doctypeResult.errors[0].message.includes("DOCTYPE"));
  assert.equal(doctypeResult.characters, 0, "nenhuma entidade foi expandida");

  const mismatched = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry("word/document.xml", "<w:document><w:body><w:p></w:q></w:body></w:document>"),
  ]);
  assert.equal((await extractDocxText(mismatched)).error_code, "invalid_xml");

  const deep = await buildZip([
    entry("[Content_Types].xml", CONTENT_TYPES),
    entry(
      "word/document.xml",
      "<w:document><w:body><w:p>" + "<w:x>".repeat(600) + "</w:x>".repeat(600) +
        "</w:p></w:body></w:document>",
    ),
  ]);
  const deepResult = await extractDocxText(deep);
  assert.equal(deepResult.error_code, "invalid_xml");
  assert.ok(deepResult.errors[0].message.includes("Profundidade"));
});

Deno.test("docx: caixa de texto e campos não resolvidos viram lacuna explícita", async () => {
  const document =
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>Antes</w:t></w:r></w:p>
<w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>dentro da caixa</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>
<w:p><w:r><w:t>Depois</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rIdAusente"><w:r><w:t>link sem relação</w:t></w:r></w:hyperlink></w:p>
</w:body></w:document>`;
  const result = await extractDocxText(
    await buildZip([
      entry("[Content_Types].xml", CONTENT_TYPES),
      entry("word/document.xml", document),
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.coverage, "complete");
  assert.ok(result.gaps.includes("caixa_de_texto_nao_incluida"));
  assert.ok(result.gaps.includes("hyperlink_sem_destino_resolvido"));
  assert.ok(result.gaps.includes("imagens_nao_interpretadas") === false);
  const text = result.blocks
    .filter((block) => block.type === "paragraph")
    .map((block) => block.text)
    .join("|");
  assert.equal(text.includes("dentro da caixa"), false, "texto de caixa não é inventado");
  assert.ok(text.includes("Antes") && text.includes("Depois"));
  const linkParagraph = result.blocks.find((block) =>
    block.type === "paragraph" && block.text.includes("link sem relação")
  );
  assert.ok(linkParagraph);
  if (linkParagraph.type === "paragraph") {
    assert.equal(linkParagraph.links[0].kind, "unknown");
    assert.equal(linkParagraph.links[0].target, null);
  }
});

// --- Detecção de pacote Office ----------------------------------------------

const PPTX_CONTENT_TYPES =
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;

Deno.test("inspectOfficeArchive: identifica DOCX, PPTX, XLSX e macro", async () => {
  const docx = await inspectOfficeArchive(await buildZip(docxEntries()));
  assert.equal(docx.ok, true);
  assert.equal(docx.container, "zip");
  assert.equal(docx.detected, "docx");
  assert.equal(docx.encrypted, false);
  assert.equal(docx.has_content_types, true);
  assert.equal(docx.entry_count, 8);
  assert.deepEqual(docx.main_parts, ["word/document.xml"]);
  assert.equal(docx.macro_enabled, false);
  assert.ok(docx.media_type!.includes("wordprocessingml.document.main"));
  assert.equal(
    docx.content_type_defaults.rels,
    "application/vnd.openxmlformats-package.relationships+xml",
  );
  assert.equal(docx.content_is_untrusted_data, true);

  const pptx = await inspectOfficeArchive(
    await buildZip([
      entry("[Content_Types].xml", PPTX_CONTENT_TYPES),
      entry("ppt/presentation.xml", "<p:presentation/>"),
    ]),
  );
  assert.equal(pptx.ok, true);
  assert.equal(pptx.detected, "pptx");
  assert.deepEqual(pptx.main_parts, ["ppt/presentation.xml"]);
  assert.ok(pptx.media_type!.includes("presentationml.presentation.main"));

  const xlsx = await inspectOfficeArchive(
    await buildZip([
      entry(
        "[Content_Types].xml",
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`,
      ),
      entry("xl/workbook.xml", "<workbook/>"),
    ]),
  );
  assert.equal(xlsx.detected, "xlsx");

  const macro = await inspectOfficeArchive(
    await buildZip([
      ...docxEntries(),
      entry("word/vbaProject.bin", "conteúdo binário sintético"),
    ]),
  );
  assert.equal(macro.detected, "docx");
  assert.equal(macro.macro_enabled, true);
  assert.equal(macro.media_type, "application/vnd.ms-word.document.macroEnabled.12");

  const ambiguous = await inspectOfficeArchive(
    await buildZip([
      entry("[Content_Types].xml", PPTX_CONTENT_TYPES),
      entry("word/document.xml", "<w:document/>"),
      entry("ppt/presentation.xml", "<p:presentation/>"),
    ]),
  );
  assert.equal(ambiguous.detected, "pptx", "o tipo declarado em Content_Types desempata");
});

Deno.test("inspectOfficeArchive: não descomprime o corpo e reporta estados", async () => {
  const exoticBody = await inspectOfficeArchive(
    await buildZip([
      entry("[Content_Types].xml", CONTENT_TYPES),
      { name: "word/document.xml", data: DOCUMENT_BYTES, method: 12 },
      entry("word/styles.xml", STYLES),
    ]),
  );
  assert.equal(exoticBody.ok, true, "o corpo não é lido na inspeção");
  assert.equal(exoticBody.detected, "docx");

  const corruptBody = await inspectOfficeArchive(
    await buildZip([
      entry("[Content_Types].xml", CONTENT_TYPES),
      { ...entry("word/document.xml", DOCUMENT), crcOverride: 0x01020304 },
    ]),
  );
  assert.equal(corruptBody.ok, true, "CRC do corpo não é conferido na inspeção");

  const notZip = await inspectOfficeArchive(encoder.encode("não é pacote"));
  assert.equal(notZip.container, "not_zip");
  assert.equal(notZip.error_code, "not_a_docx");
  assert.equal(notZip.detected, null);

  const empty = await inspectOfficeArchive(new Uint8Array(0));
  assert.equal(empty.error_code, "empty_input");

  const oversized = await inspectOfficeArchive(encoder.encode("PK\u0003\u0004"), { maxBytes: 2 });
  assert.equal(oversized.error_code, "oversized");

  const encrypted = await inspectOfficeArchive(
    await buildZip([
      { ...entry("[Content_Types].xml", CONTENT_TYPES), flags: 0x1 },
      entry("word/document.xml", DOCUMENT),
    ]),
  );
  assert.equal(encrypted.error_code, "document_encrypted");
  assert.equal(encrypted.encrypted, true);
  assert.equal(encrypted.detected, null);

  const noMainPart = await inspectOfficeArchive(
    await buildZip([
      entry("[Content_Types].xml", CONTENT_TYPES),
    ]),
  );
  assert.equal(noMainPart.ok, false);
  assert.equal(noMainPart.error_code, "not_a_docx");
});

// --- HTML de Book/Page ------------------------------------------------------

const BOOK_HTML = `<html><head><meta charset="utf-8"><title>Capítulo 1</title>
<style>p{color:red}</style>
<script>alert("executou")</script>
</head>
<body onload="alert(1)">
<h1>Capítulo 1 — Calendário</h1>
<p>Primeiro parágrafo com <strong>ênfase</strong> e <a href="https://example.org/a?b=1&amp;c=2">link externo</a>.</p>
<p onclick="steal()">Segundo com <a href="javascript:alert(1)">armadilha</a>, <a href="&#106;avascript:alert(2)">ofuscada</a> e <a href="java&#9;script:alert(3)">com tab</a>.</p>
<p><a href="/relativo/pagina">relativo</a>, <a href="mailto:tutor@example.org">e-mail</a> e <a href="https://user:senha@example.org/segredo">com credenciais</a>.</p>
<h2>Listas</h2>
<ul><li>Item um<ul><li>Subitem A</li></ul></li><li>Item dois com <a href="#sec2">âncora</a></li></ul>
<ol><li>Passo 1</li><li>Passo 2</li></ol>
<table><caption>Notas do trabalho</caption><thead><tr><th colspan="2">Peso</th></tr></thead><tbody><tr><td>40%</td><td rowspan="2">Justificar</td></tr><tr><td>30%</td></tr></tbody></table>
<blockquote>Citação textual de apoio.</blockquote>
<pre>linha 1
  linha 2 preservada</pre>
<img src="https://rastreador.example/x.png" alt="Gráfico de notas">
<iframe src="https://rastreador.example/f"></iframe>
<form action="/enviar"><input name="campo" value="x"><button>Enviar</button></form>
<p>Texto literal com &lt;b&gt;marcação&lt;/b&gt; escapada.</p>
<<script>alert(9)</script>
<p>Fim.</p>
</body></html>`;

Deno.test("html: saneia sem executar e preserva estrutura com localizadores", async () => {
  const result = await extractHtmlText(BOOK_HTML);
  assert.equal(result.format, "html");
  assert.equal(result.ok, true);
  assert.equal(result.coverage, "partial");
  assert.equal(result.content_is_untrusted_data, true);
  assert.equal(result.execution, "in_process");

  const sanitized = result.sanitized_html ?? "";
  for (
    const forbidden of [
      "<script",
      "<style",
      "<iframe",
      "<form",
      "<input",
      "<button",
      "onload",
      "onclick",
      "javascript:",
      "rastreador.example",
      "src=",
      "alert(9)",
      "executou",
    ]
  ) {
    assert.equal(
      sanitized.includes(forbidden),
      false,
      "HTML saneado não pode conter " + forbidden,
    );
  }
  assert.ok(sanitized.includes("<h1>Capítulo 1 — Calendário</h1>"));
  assert.ok(sanitized.includes('href="https://example.org/a?b=1&amp;c=2"'));
  assert.ok(sanitized.includes("[imagem: Gráfico de notas]"));
  assert.ok(sanitized.includes("[mídia não interpretada]"));
  assert.equal(sanitized.includes("senha"), false, "credenciais em URL não sobrevivem");

  const removals = result.sanitizer_removals;
  assert.ok(removals.script >= 2, "script do head e o disfarçado <<script>");
  assert.equal(removals.style, 1);
  assert.equal(removals["elemento:iframe"], 1);
  assert.equal(removals["elemento:form"], 1);
  assert.equal(removals["elemento:input"], 1);
  assert.ok(removals.atributo_evento >= 2, "onload do body e onclick do parágrafo");
  assert.equal(
    removals.url_perigosa,
    4,
    "javascript direto, ofuscado por entidade, com tab e URL com credenciais",
  );
  assert.equal(
    removals.url_relativa_mantida_sem_resolucao,
    2,
    "caminho relativo e âncora #sec2 permanecem relativos, sem resolução",
  );
  assert.equal(removals["tag_nao_autorizada:html"], 1);
  assert.equal(
    removals.ancora_sem_destino,
    4,
    "três âncoras javascript e a de credenciais viram texto sem destino",
  );

  const paragraphs = result.blocks.filter((block) => block.type === "paragraph");
  const tables = result.blocks.filter((block) => block.type === "table");
  const title = paragraphs[0];
  assert.equal(title.heading_level, 1);
  assert.equal(title.locator, "html:block:1");
  assert.equal(title.text, "Capítulo 1 — Calendário");

  const trapParagraph = paragraphs.find((block) =>
    block.type === "paragraph" && block.text.startsWith("Segundo com armadilha")
  );
  assert.ok(trapParagraph);
  if (trapParagraph.type === "paragraph") {
    assert.equal(trapParagraph.links.length, 0, "URLs javascript não viram link");
  }

  const relativeParagraph = paragraphs.find((block) =>
    block.type === "paragraph" && block.text.includes("relativo")
  );
  assert.ok(relativeParagraph);
  if (relativeParagraph.type === "paragraph") {
    assert.equal(relativeParagraph.links.length, 2);
    assert.equal(relativeParagraph.links[0].target, "/relativo/pagina");
    assert.equal(relativeParagraph.links[1].target, "mailto:tutor@example.org");
    assert.equal(relativeParagraph.links[1].kind, "external");
  }

  const externalParagraph = paragraphs.find((block) =>
    block.type === "paragraph" && block.text.includes("link externo")
  );
  assert.ok(externalParagraph);
  if (externalParagraph.type === "paragraph") {
    assert.equal(externalParagraph.links[0].target, "https://example.org/a?b=1&c=2");
    assert.equal(externalParagraph.links[0].locator, "html:link:1");
  }

  const anchorItem = paragraphs.find((block) =>
    block.type === "paragraph" && block.text.includes("Item dois")
  );
  assert.ok(anchorItem);
  if (anchorItem.type === "paragraph") {
    assert.equal(anchorItem.list?.num_fmt, "bullet");
    assert.equal(anchorItem.list?.level, 0);
    assert.equal(anchorItem.links[0].kind, "internal");
    assert.equal(anchorItem.links[0].anchor, "sec2");
  }
  const nested = paragraphs.find((block) =>
    block.type === "paragraph" && block.text === "Subitem A"
  );
  assert.ok(nested);
  if (nested.type === "paragraph") assert.equal(nested.list?.level, 1);
  const step = paragraphs.find((block) => block.type === "paragraph" && block.text === "Passo 1");
  assert.ok(step);
  if (step.type === "paragraph") assert.equal(step.list?.num_fmt, "decimal");

  assert.equal(tables.length, 1);
  const table = tables[0];
  assert.equal(table.locator, "html:table:1");
  assert.equal(table.rows, 3);
  assert.equal(table.columns, 2);
  assert.equal(table.cells[0].grid_span, 2);
  assert.equal(table.cells[0].text, "Peso");
  assert.equal(table.cells[0].locator, "html:table:1:r1:c1");
  assert.equal(table.cells[2].v_merge, "restart");
  assert.equal(table.cells[2].text, "Justificar");
  assert.ok(table.text.includes("40% | Justificar"));

  const quote = paragraphs.find((block) =>
    block.type === "paragraph" && block.text.startsWith("Citação")
  );
  assert.ok(quote);
  if (quote.type === "paragraph") {
    assert.equal(quote.quote, true);
    assert.equal(quote.code, false);
  }
  const code = paragraphs.find((block) =>
    block.type === "paragraph" && block.text.includes("linha 2")
  );
  assert.ok(code);
  if (code.type === "paragraph") {
    assert.equal(code.code, true);
    assert.ok(code.text.includes("\n"), "bloco pre preserva quebras");
  }

  assert.equal(result.image_count, 1);
  assert.ok(result.gaps.includes("imagens_nao_interpretadas"));
  assert.ok(result.gaps.includes("html_removido:midia_nao_interpretada"));
  assert.ok(result.gaps.includes("html_removido:url_perigosa"));
  assert.ok(result.gaps.includes("legenda_de_tabela_nao_destacada"));
  assert.ok(result.gaps.includes("celula_mesclada_horizontalmente"));
  assert.ok(result.gaps.includes("celula_mesclada_verticalmente"));
  assert.equal(result.link_count, 4);
});

Deno.test("html: documento limpo fica completo e o despacho reconhece o formato", async () => {
  const clean = await extractHtmlText("<h1>Título</h1><p>Texto simples.</p>");
  assert.equal(clean.coverage, "complete");
  assert.equal(clean.block_count, 2);
  assert.equal(clean.gaps.length, 0);

  const dispatchedHtml = await extractDocumentText(encoder.encode("<p>página</p>"));
  assert.equal(dispatchedHtml.format, "html");
  assert.equal(dispatchedHtml.ok, true);

  const dispatchedDocx = await extractDocumentText(await buildZip(docxEntries()));
  assert.equal(dispatchedDocx.format, "docx");
  assert.equal(dispatchedDocx.coverage, "complete");

  const forcedHtml = await extractDocumentText(encoder.encode("<p>x</p>"), { format: "html" });
  assert.equal(forcedHtml.format, "html");
});

Deno.test("html: codificação declarada, vazio, excesso e truncamento", async () => {
  const latin = concat([
    encoder.encode('<meta charset="windows-1252"><p>a'),
    new Uint8Array([0xe7, 0xe3]),
    encoder.encode("o</p>"),
  ]);
  const decoded = await extractHtmlText(latin);
  assert.equal(decoded.ok, true);
  const text = decoded.blocks
    .filter((block) => block.type === "paragraph")
    .map((block) => block.text)
    .join(" ");
  assert.ok(text.includes("ação"), "windows-1252 decodificado: " + text);
  assert.equal(decoded.metadata.charset, "windows-1252");

  const empty = await extractHtmlText("");
  assert.equal(empty.error_code, "html_empty");

  const oversized = await extractHtmlText("<p>x</p>", { maxBytes: 2 });
  assert.equal(oversized.error_code, "oversized");
  assert.equal(oversized.coverage, "unavailable");

  const truncatedBlocks = await extractHtmlText("<p>um</p><p>dois</p><p>três</p>", {
    maxBlocks: 2,
  });
  assert.equal(truncatedBlocks.blocks_truncated, true);
  assert.equal(truncatedBlocks.coverage, "partial");
  assert.equal(truncatedBlocks.block_count, 2);

  const truncatedHtml = await extractHtmlText("<p>conteúdo longo</p>", { maxSanitizedChars: 8 });
  assert.equal(truncatedHtml.text_truncated, true);
  assert.equal(truncatedHtml.coverage, "partial");
  assert.ok((truncatedHtml.sanitized_html ?? "").length <= 8);
});

Deno.test("html: sanitizeHtmlDocument normaliza e recusa URLs", () => {
  const result = sanitizeHtmlDocument(
    '<p><a href="HTTPS://Example.org/B">b</a> <a href="https://u:p@x/y">credencial</a> ' +
      '<a href="data:text/html;base64,AAAA">data</a> <a href="vbscript:x">vb</a></p>',
  );
  assert.ok(result.html.includes('href="https://example.org/B"'));
  assert.equal(result.html.includes("credencial"), true);
  assert.equal(result.html.includes("u:p@"), false);
  assert.equal(result.html.includes("data:"), false);
  assert.equal(result.html.includes("vbscript"), false);
  assert.equal(result.removals.url_perigosa, 3);
  assert.equal(result.text, "b credencial data vb");
});

// --- Pipeline de mídia (vídeo/áudio) ----------------------------------------
//
// As provas de vídeo geram um MP4 sintético com ffmpeg local e exigem a
// permissão de execução de processo e de escrita em diretório temporário. No
// gate `deno task test` essas permissões não são concedidas, então os passos
// ficam explicitamente ignorados em vez de passar sem executar nada; a prova
// real roda com:
//   deno test --allow-read --allow-write --allow-run=ffmpeg,ffprobe --allow-env \
//     tests/document_text_test.ts
const ffmpegRunnable = (await Deno.permissions.query({ name: "run", command: "ffmpeg" })).state ===
    "granted" &&
  (await Deno.permissions.query({ name: "run", command: "ffprobe" })).state === "granted";
const tempWritable = (await Deno.permissions.query({ name: "write" })).state === "granted";
const mediaReady = ffmpegRunnable && tempWritable;

function srtFixture(): string {
  return [
    "1",
    "00:00:00,500 --> 00:00:02,000",
    "Primeira legenda com ação e coração.",
    "",
    "2",
    "00:00:02,400 --> 00:00:04,750",
    "Segunda linha da legenda.",
    "",
  ].join("\n");
}

Deno.test("mídia: leitura de cues SRT/WebVTT sem DOM e sem executável", () => {
  const srt = parseSubtitleCues(srtFixture(), 2);
  assert.equal(srt.cues.length, 2);
  assert.equal(srt.cues[0].locator, "video:sub:2:1");
  assert.equal(srt.cues[0].start_ms, 500);
  assert.equal(srt.cues[0].end_ms, 2000);
  assert.equal(srt.cues[0].text, "Primeira legenda com ação e coração.");
  assert.equal(srt.cues[1].end_ms, 4750);

  const vtt = parseSubtitleCues(
    [
      "WEBVTT",
      "",
      "NOTE isto é um comentário",
      "",
      "cue-1",
      "00:00.000 --> 00:01.500 align:start position:10%",
      "<v Narrador>Fala com <i>ênfase</i> e {\\an8}marcação.",
      "",
      "00:02.000 --> 00:03.000",
      "Segundo cue.",
      "",
    ].join("\n"),
    7,
  );
  assert.equal(vtt.cues.length, 2);
  assert.equal(vtt.cues[0].start_ms, 0);
  assert.equal(vtt.cues[0].end_ms, 1500);
  assert.equal(vtt.cues[0].text, "Fala com ênfase e marcação.");
  assert.equal(vtt.cues[1].start_ms, 2000);
  assert.equal(vtt.cues[0].locator, "video:sub:7:1");

  const capped = parseSubtitleCues(srtFixture(), 1, { maxCues: 1 });
  assert.equal(capped.cues.length, 1);
  assert.equal(capped.truncated, true);

  const garbage = parseSubtitleCues("isto não é legenda\n\n99:99:99,999 --> x", 0);
  assert.equal(garbage.cues.length, 0);
});

Deno.test({
  name: "mídia: extrai legendas embutidas e declara a lacuna de ASR",
  ignore: !mediaReady,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "arahub-media-" });
    try {
      const subsPath = dir + "/subs.srt";
      const withSubs = dir + "/com-legendas.mp4";
      const withoutSubs = dir + "/sem-legendas.mp4";
      await Deno.writeTextFile(subsPath, srtFixture());
      const common = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x120:rate=10:duration=5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=5",
      ];
      await runFfmpeg([
        ...common,
        "-i",
        subsPath,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:s",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-c:s",
        "mov_text",
        "-shortest",
        withSubs,
      ]);
      await runFfmpeg([
        ...common,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        withoutSubs,
      ]);

      const tools = await mediaTools();
      assert.equal(tools.ffmpeg.available, true);
      assert.equal(tools.ffprobe.available, true);
      assert.equal(tools.run_permission, "granted");
      assert.ok((tools.ffmpeg.version ?? "").startsWith("ffmpeg version"));

      const captioned = await processVideo(withSubs, { checkAsr: true });
      assert.equal(captioned.ok, true);
      assert.equal(captioned.coverage, "complete");
      assert.equal(captioned.transcript_source, "embedded_captions");
      assert.equal(captioned.transcript.length, 2);
      assert.equal(captioned.subtitles.text_track_count, 1);
      assert.equal(captioned.subtitles.image_track_count, 0);
      assert.equal(captioned.probe.video_streams, 1);
      assert.equal(captioned.probe.audio_streams, 1);
      const firstCue = captioned.transcript[0];
      assert.equal(firstCue.start_ms, 500);
      assert.equal(firstCue.end_ms, 2000);
      assert.ok(firstCue.text.startsWith("Primeira legenda"));
      assert.ok(/^video:sub:\d+:1$/.test(firstCue.locator));
      assert.equal(
        captioned.asr,
        "not_attempted",
        "a legenda é da fonte; nenhuma transcrição de fala foi executada",
      );
      assert.equal(captioned.visual_analysis, "not_performed");
      assert.equal(captioned.local_asr?.model_configured, false);
      assert.ok((captioned.local_asr?.note ?? "").length > 20);
      assert.ok(captioned.notes.some((note) => note.includes("Nenhum serviço de transcrição")));

      const silent = await processVideo(withoutSubs);
      assert.equal(silent.ok, true);
      assert.equal(silent.coverage, "partial");
      assert.equal(silent.transcript_source, "none");
      assert.equal(silent.transcript.length, 0);
      assert.equal(silent.subtitles.captions_present, false);
      assert.equal(silent.asr, "not_attempted");
      assert.ok(silent.asr_gap_note.includes("ASR não executado"));
      assert.equal(silent.probe.subtitle_streams, 0);

      const audio = await extractAudioForAsr(withoutSubs, dir + "/audio.wav");
      assert.equal(audio.ok, true);
      assert.equal(audio.format, "wav");
      assert.ok(audio.bytes > 44);

      const frame = await extractFrameAt(withoutSubs, 1_000, dir + "/quadro.png");
      assert.equal(frame.ok, true);
      assert.equal(frame.format, "png");
      assert.ok(frame.bytes > 100);

      const unavailable = await probeMediaFile(dir + "/nao-existe.mp4");
      assert.equal(unavailable.ok, false);
      assert.ok(
        unavailable.error_code === "unreadable" || unavailable.error_code === "empty_input",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

async function runFfmpeg(args: string[]): Promise<void> {
  const command = new Deno.Command("ffmpeg", { args, stdout: "null", stderr: "piped" });
  const output = await command.output();
  if (output.code !== 0) {
    throw new Error(
      "ffmpeg falhou ao gerar a fixture: " +
        new TextDecoder().decode(output.stderr).slice(0, 300),
    );
  }
}

// --- ASR local: escaping, cache e falhas explícitas -------------------------
//
// A barra invertida é montada com String.fromCharCode(92) para que o teste não
// dependa de quantas camadas de escape atravessou até o arquivo.
const BACKSLASH = String.fromCharCode(92);

Deno.test("asr: escaping do grafo de filtros e recusa de caminho inseguro", () => {
  // Medido no ffmpeg 9.0.1: o parser desescapa duas vezes, então o dois-pontos
  // precisa de barra dupla e a barra invertida é normalizada para barra.
  const windowsPath = "C" + ":" + BACKSLASH + "dir" + BACKSLASH + "m.bin";
  assert.equal(filterOptionValue(windowsPath), "C" + BACKSLASH + BACKSLASH + ":/dir/m.bin");
  assert.equal(filterOptionValue("/tmp/a/m.bin"), "/tmp/a/m.bin");
  assert.equal(
    filterOptionValue("C" + ":" + BACKSLASH + "dir with space" + BACKSLASH + "m.bin"),
    "C" + BACKSLASH + BACKSLASH + ":/dir with space/m.bin",
  );

  assert.equal(isGraphSafePath(windowsPath), true);
  assert.equal(isGraphSafePath("C" + ":" + BACKSLASH + "dir,comma" + BACKSLASH + "m.bin"), false);
  assert.equal(isGraphSafePath("C" + ":" + BACKSLASH + "dir;semi" + BACKSLASH + "m.bin"), false);
  assert.equal(isGraphSafePath("C" + ":" + BACKSLASH + "dir[x]" + BACKSLASH + "m.bin"), false);
  assert.equal(
    isGraphSafePath("C" + ":" + BACKSLASH + "dir" + String.fromCharCode(39) + "asp"),
    false,
    "apóstrofo é descartado em silêncio pelo ffmpeg; deve ser recusado",
  );
  assert.equal(isGraphSafePath("C" + ":" + BACKSLASH + "a" + String.fromCharCode(0) + "b"), false);
  assert.equal(isGraphSafePath(""), false);
});

Deno.test("asr: cache só reutiliza com motor, idioma e sha do modelo iguais", () => {
  const expected = {
    engine_version: "ffmpeg-whisper-cpp-2026-10-07.1",
    model_sha256: "a".repeat(64),
    language: "pt",
  };
  assert.equal(shouldReuseTranscription(null, expected), false);
  assert.equal(shouldReuseTranscription(undefined, expected), false);
  assert.equal(shouldReuseTranscription({ ...expected }, expected), true);
  assert.equal(
    shouldReuseTranscription({ ...expected, engine_version: "outro" }, expected),
    false,
  );
  assert.equal(shouldReuseTranscription({ ...expected, language: "en" }, expected), false);
  assert.equal(
    shouldReuseTranscription({ ...expected, model_sha256: "b".repeat(64) }, expected),
    false,
  );
  assert.equal(
    shouldReuseTranscription({ ...expected, model_sha256: null }, expected),
    false,
    "sem sha conhecido não se presume equivalência de modelo",
  );
  assert.equal(
    shouldReuseTranscription({ ...expected }, { ...expected, model_sha256: null }),
    false,
  );
});

Deno.test("asr: modelo ausente e idioma inválido falham sem executar", async () => {
  const missing = await transcribeLocal("arquivo-inexistente.mp4", {
    modelPath: "/caminho/inexistente/ggml-base.bin",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "model_missing");
  assert.equal(missing.segment_count, 0);
  assert.equal(missing.transcript_reviewed, false);
  assert.equal(missing.accuracy_verified, false);
  assert.equal(missing.source_unreviewed, true);
  assert.equal(missing.coverage_scope, "temporal_execution");
  assert.equal(missing.visual_analysis, "not_performed");
  assert.equal(missing.content_is_untrusted_data, true);
  assert.equal(missing.engine, "ffmpeg_whisper_cpp");

  const badLanguage = await transcribeLocal("x.mp4", {
    modelPath: "/qualquer/ggml.bin",
    language: "portugues!",
  });
  assert.equal(badLanguage.ok, false);
  assert.equal(badLanguage.error_code, "invalid_option");
});

Deno.test({
  name: "asr: caminho inseguro é recusado e modelo inválido falha sem fingir transcrição",
  ignore: !mediaReady,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "arahub-asr-" });
    try {
      const unsafeModel = dir + "/model,comma.bin";
      await Deno.writeTextFile(unsafeModel, "conteúdo qualquer");
      const refused = await transcribeLocal(dir + "/entrada.mp4", { modelPath: unsafeModel });
      assert.equal(refused.ok, false);
      assert.equal(refused.error_code, "invalid_option");
      assert.equal(refused.segment_count, 0);

      const fakeModel = dir + "/fake-model.bin";
      await Deno.writeTextFile(fakeModel, "isto não é um modelo ggml");
      const failed = await transcribeLocal(dir + "/entrada.mp4", {
        modelPath: fakeModel,
        destinationPath: dir + "/fake.srt",
        timeoutMs: 60_000,
      });
      assert.equal(failed.ok, false);
      assert.equal(failed.error_code, "asr_failed", "modelo inválido não vira transcrição");
      assert.equal(failed.segment_count, 0);
      assert.equal(failed.model.integrity, "unverified");
      assert.equal(failed.transcript_reviewed, false);
      assert.equal(failed.accuracy_verified, false);
      assert.equal(failed.source_unreviewed, true);
      assert.ok(failed.notes.some((note) => note.includes("Nenhum serviço de transcrição")));
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
