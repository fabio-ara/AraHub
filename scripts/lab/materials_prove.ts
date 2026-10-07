/**
 * Focused MAT-01/04/06 proof. Existing local files only; no provider calls.
 * Prepare the private interactive fixture and Office inventory first.
 * deno run --cached-only --allow-read --allow-write=.private/entrega-1/materials
 *   --allow-env --allow-net=127.0.0.1:55432 scripts/lab/materials_prove.ts
 * --offline omits PostgreSQL/SDK (explicitly recorded, never a passed SDK proof).
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asOwner, createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { handleMcp } from "../../src/mcp.ts";
import { sha256Hex } from "../../src/migration.ts";
import { extractPdfText, pdfExtractionToText } from "../../src/pdf_text.ts";
import { extractDocxText, inspectOfficeArchive } from "../../src/document_text.ts";

const ROOT = ".private/entrega-1";
const OUT = `${ROOT}/materials/final-proofs`;
const DATABASE = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
// Dynamic JSON at the private proof and MCP boundary; assertions below check used fields.
type Json = Record<string, any>;
const checks: Array<{ name: string; passed: true; details: Json }> = [];
const passed = (name: string, details: Json = {}) => checks.push({ name, passed: true, details });
const readJson = async (path: string): Promise<Json> => JSON.parse(await Deno.readTextFile(path));
const write = (name: string, value: unknown) =>
  Deno.writeTextFile(`${OUT}/${name}.json`, JSON.stringify(value, null, 2) + "\n");
const fingerprints: Record<string, string> = {};
const report: Json = {
  generated_at: new Date().toISOString(),
  level: "local_engine_and_mcp_sdk_synthetic_principal",
  source_content_printed: false,
  external_provider_calls: 0,
  host_chatgpt: "not_demonstrated",
  checks,
  fingerprints,
  scenario_acceptance: {
    "MAT-01": "partial: real DOCX/HTML recovery reused; synthetic PDF below; host pending",
    "MAT-04":
      "passed_local_engine_sdk: explicit text scope, bounded read-only fields and visual/OCR gaps; not a host proof",
    "MAT-06": "partial: exports lack table/link/figure; DOCX visual renderer unavailable",
  },
};
let executionComplete = false;
try {
  for (
    const path of [
      "src/pdf_text.ts",
      "src/materials.ts",
      "src/document_text.ts",
      "src/mcp.ts",
      "scripts/lab/materials_prove.ts",
    ]
  ) {
    fingerprints[path] = await sha256Hex(await Deno.readFile(path));
  }

  const recoveryPath = `${ROOT}/materials/mcp-recovery-proof.json`;
  const recovery = await readJson(recoveryPath);
  assert.equal(recovery.wrong_hash_refused, true);
  assert.equal(recovery.isolation.other_owner_read_refused, true);
  assert.equal(recovery.transcript.accuracy_verified, false);
  const doc = await readJson(`${ROOT}/materials/extracted/${recovery.docx.sha256}/extraction.json`);
  assert.equal(doc.format, "docx");
  assert.ok(doc.blocks.some((b: Json) => /^docx:p:\d+$/.test(b.locator)));
  passed("MAT01_existing_real_recovery_and_locator", {
    proof: recoveryPath,
    proof_sha256: await sha256Hex(await Deno.readFile(recoveryPath)),
    binary_sha256: recovery.docx.sha256,
    blocks: doc.block_count,
    tables: doc.table_count,
    note: "Prior SDK run reused; not rerun or promoted to host proof. Real DOCX has no table.",
  });

  const office = JSON.parse(await Deno.readTextFile(`${OUT}/office-structure.json`)) as Json[];
  report.office_inventory_sha256 = await sha256Hex(
    await Deno.readFile(`${OUT}/office-structure.json`),
  );
  for (const item of office) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.ok(["docx", "pptx"].includes(item.kind));
    const bytes = await Deno.readFile(`${ROOT}/connector-${item.sha256}.${item.kind}`);
    assert.equal(await sha256Hex(bytes), item.sha256);
    assert.equal(bytes.length, item.bytes);
    const inspection = await inspectOfficeArchive(bytes);
    assert.equal(inspection.ok, true);
    assert.equal(inspection.detected, item.kind);
    assert.equal(inspection.macro_enabled, false);
    assert.equal(item.xml_valid, true);
    assert.equal(item.crc_valid, true);
    assert.deepEqual(item.broken_internal_relationships, []);
    if (item.kind === "docx") {
      const extraction = await extractDocxText(bytes);
      assert.equal(extraction.ok, true);
      assert.ok(extraction.characters > 0);
      assert.ok(extraction.blocks.every((b) => b.locator.startsWith("docx:")));
      await write("exported-docx-extraction", extraction);
    }
    passed(`MAT06_${item.kind}_pinned_structure`, {
      sha256: item.sha256,
      bytes: bytes.length,
      entries: inspection.entry_count,
      body_parts: item.body_parts.length,
      tables: item.tables,
      hyperlinks: item.hyperlinks,
      figures: item.figures,
      adequacy_for_table_link_figure_scenario: false,
    });
  }

  const pdfPath = `${OUT}/interactive-fixture.pdf`;
  const bytes = await Deno.readFile(pdfPath);
  const hash = await sha256Hex(bytes);
  const inventory = await readJson(`${OUT}/pdf-fixture-inventory.json`);
  assert.equal(hash, inventory.sha256);
  assert.equal(inventory.widget_count, 2);
  assert.equal(inventory.canonical_fields.length, 2);
  assert.equal(inventory.questionnaire_answered, false);
  passed("MAT04_independent_canonical_fields_inventory", { sha256: hash, fields: 2, widgets: 2 });
  const limited = await extractPdfText(bytes, { maxPages: 1 });
  assert.equal(limited.ok, true);
  assert.equal(limited.coverage, "partial");
  assert.deepEqual(limited.omitted_pages, [2]);
  assert.equal(limited.pages[0].locator, "pdf:page:1");
  passed("MAT01_MAT04_pdf_page_limit_and_locator", { coverage: limited.coverage, omitted: [2] });
  const full = await extractPdfText(bytes);
  assert.equal(full.ok, true);
  assert.equal(full.execution, "isolated_worker");
  assert.equal(full.hard_timeout, true);
  assert.equal(full.pages.length, 2);
  assert.equal(full.pages[1].locator, "pdf:page:2");
  assert.equal(full.pages[1].text_absent, true);
  assert.ok(full.pages[1].image_count > 0);
  assert.equal(full.images_not_interpreted, true);
  assert.equal(full.ocr, "not_performed");
  assert.equal(full.coverage_scope, "text_extraction");
  assert.equal(full.visual_analysis, "not_performed");
  assert.equal(full.forms.status, "inspected");
  assert.equal(full.forms.field_count, inventory.canonical_fields.length);
  assert.deepEqual(
    full.forms.fields.map((f) => f.name).sort(),
    inventory.canonical_fields.map((f: Json) => f.name).sort(),
  );
  assert.equal(full.forms.interaction, "not_performed");
  assert.match(pdfExtractionToText(full), /sem texto extraído/);
  await write("pdf-engine-extraction", full);
  passed("MAT04_engine_visual_page_gap", {
    engine_coverage: full.coverage,
    text_absent_pages: [2],
    ocr: full.ocr,
    images_not_interpreted: true,
    field_metadata_exposed: true,
    forms: full.forms,
    coverage_scope: full.coverage_scope,
    questionnaire_answered: false,
    semantic_reading_complete: false,
  });

  if (Deno.args.includes("--offline")) {
    report.sdk = { status: "not_run", reason: "explicit_offline" };
  } else {
    const db = createDb(DATABASE);
    const hub = new Hub(db);
    const owner = { ownerId: crypto.randomUUID() };
    const other = { ownerId: crypto.randomUUID() };
    const clients: Client[] = [];
    let ownersCreated = false;
    const connect = async (principal: typeof owner) => {
      const client = new Client({ name: "materials-local-proof", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            handleMcp(new Request(input, init), hub, principal),
        }),
      );
      return client;
    };
    const call = async (client: Client, name: string, args: Json, errorExpected = false) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(Boolean(result.isError), errorExpected, `${name}: error state`);
      const content = result.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content.find((c) => c.type === "text")!.text!) as Json;
    };
    try {
      await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
      ownersCreated = true;
      const connection = await hub.connect(owner, "migration", "materials-proof", null, null, {
        fixture: true,
      });
      const entity = await hub.entity(owner, connection.id, "material", "mat04", "Synthetic PDF");
      const file = await asOwner(
        db,
        owner,
        async (tx) =>
          (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extraction)
          values(${owner.ownerId},${entity.id},'interactive-fixture.pdf','application/pdf',${hash},${bytes.length},${
            Buffer.from(bytes)
          },'{}'::jsonb) returning id`)[0],
      );
      const a = await connect(owner);
      const run = await call(a, "hub_extract_pdf", {
        file_id: file.id,
        sha256: hash,
        max_pages: 1,
      });
      assert.equal(run.extraction.coverage, "partial");
      const absent = await call(a, "hub_pdf_page", { file_id: file.id, sha256: hash, page: 2 });
      assert.equal(absent.coverage, "page_not_extracted");
      assert.equal(absent.page, null);
      passed("MAT04_sdk_omitted_page_not_read");
      const all = await call(a, "hub_extract_pdf", { file_id: file.id, sha256: hash });
      const page = await call(a, "hub_pdf_page", { file_id: file.id, sha256: hash, page: 2 });
      assert.equal(page.page.text_absent, true);
      assert.equal(page.page.locator, "pdf:page:2");
      assert.equal(page.ocr, "not_performed");
      assert.ok(page.page.image_count > 0);
      assert.equal(all.memory.complete, true);
      assert.equal(all.memory.coverage_scope, "text_extraction");
      assert.equal(all.memory.visual_analysis, "not_performed");
      assert.equal(all.memory.forms.field_count, 2);
      assert.deepEqual(page.forms, all.memory.forms);
      const excerpt = await call(a, "hub_file_text", { file_id: file.id, sha256: hash, limit: 30 });
      assert.deepEqual(excerpt.extraction.forms, all.memory.forms);
      assert.equal(excerpt.extraction.coverage_scope, "text_extraction");
      const restricted = await call(a, "hub_extract_pdf", {
        file_id: file.id,
        sha256: hash,
        max_pages: 1,
      });
      assert.equal(restricted.memory.pages, 2);
      assert.deepEqual(restricted.memory.forms, all.memory.forms);
      passed("MAT04_sdk_image_gap_and_stronger_extraction_retained", {
        memory_complete: all.memory.complete,
        coverage: all.extraction.coverage,
        scope: all.memory.coverage_scope,
        semantic_reading_complete: false,
        fields_exposed: true,
        forms: all.memory.forms,
        images_not_interpreted: true,
      });
      const mismatch = await call(a, "hub_pdf_page", {
        file_id: file.id,
        sha256: "0".repeat(64),
        page: 1,
      }, true);
      assert.equal(mismatch.code, "file_changed");
      const b = await connect(other);
      const denied = await call(
        b,
        "hub_pdf_page",
        { file_id: file.id, sha256: hash, page: 1 },
        true,
      );
      assert.equal(denied.code, "not_found");
      passed("MAT04_sdk_hash_and_owner_isolation");
      const [stored] =
        await db`select encode(extensions.digest(binary_content,'sha256'),'hex') as hash from public.hub_files where id=${file.id}`;
      assert.equal(stored.hash, hash);
      assert.equal(await sha256Hex(await Deno.readFile(pdfPath)), hash);
      passed("MAT04_source_bytes_unchanged_no_form_mutation");
      report.sdk = {
        status: "passed",
        principal: "synthetic_injection",
        transport: "real_mcp_sdk_custom_local_fetch",
        database: "127.0.0.1:55432",
        response: all,
        page,
        field_metadata_gap: false,
      };
    } finally {
      for (const client of clients) await client.close();
      if (ownersCreated) {
        await db`delete from auth.users where id in (${owner.ownerId},${other.ownerId})`;
      }
      await db.end();
    }
  }
  executionComplete = true;
} catch (error) {
  report.failure = { name: error instanceof Error ? error.name : "Error" };
  // Preserve diagnostics privately, never echo source values from assertions.
  await Deno.writeTextFile(`${OUT}/proof-error.log`, String(error));
  Deno.exitCode = 1;
} finally {
  report.execution_complete = executionComplete;
  await write(Deno.args.includes("--offline") ? "proof-offline" : "proof", report);
  console.log(
    JSON.stringify({
      execution_complete: executionComplete,
      checks_passed: checks.length,
      sdk: report.sdk?.status ?? "not_completed",
      scenario_acceptance: "partial_see_private_proof",
    }),
  );
}
