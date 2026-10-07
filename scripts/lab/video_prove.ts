/**
 * MAT-02: existing processing output -> exclusive local SQL -> real MCP SDK.
 * No ASR is run here. Only the synthetic video_prove.py fixture is accepted.
 * Retains its private owner/bytes for review; never inspects another Lab fixture.
 *
 * deno run --cached-only --allow-net=127.0.0.1 --allow-env --allow-read --allow-write=.private/evidence/video-mat02 scripts/lab/video_prove.ts
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asOwner, createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { handleMcp } from "../../src/mcp.ts";
import { sha256Hex } from "../../src/migration.ts";
import { importProcessedMaterials } from "../import_processed_materials.ts";

const OUT = ".private/evidence/video-mat02";
const DATABASE = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
// This fixed loopback target cannot be redirected by environment configuration.
type Json = Record<string, any>; // JSON/SDK boundary, narrowed by assertions below.
const read = async (path: string): Promise<Json> => JSON.parse(await Deno.readTextFile(path));
const write = (path: string, value: unknown) =>
  Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
const fixture = await read(`${OUT}/fixture.json`);
assert.equal(fixture.synthetic, true);
assert.equal(fixture.external_service, false);
assert.equal(fixture.source_path, `${OUT}/source/mat02-synthetic.mp4`);
const bytes = await Deno.readFile(fixture.source_path);
assert.equal(bytes.byteLength, fixture.bytes);
assert.ok(bytes.byteLength > 20 * 1024 * 1024);
assert.equal(await sha256Hex(bytes), fixture.sha256);
const extracted = `${OUT}/extracted/${fixture.sha256}`;
const extraction = await read(`${extracted}/extraction.json`);
const text = await Deno.readTextFile(`${extracted}/text.txt`);
const frames = await read(`${extracted}/frames/frames.json`);
const visual = await read(`${OUT}/visual-review.json`);
assert.equal(extraction.ok, true);
assert.equal(extraction.transcript_source, "local_asr");
assert.equal(extraction.probe.text_subtitle_streams, 0);
assert.equal(extraction.transcription.model.integrity, "verified");
assert.equal(
  extraction.transcription.model.sha256,
  (await read(".private/entrega-1/models/MODEL.json")).sha256,
);
assert.equal(extraction.coverage_scope, "temporal_execution");
assert.equal(extraction.accuracy_verified, false);
assert.equal(extraction.asr_reviewed, false);
assert.equal(extraction.transcription.source_unreviewed, true);
assert.equal(extraction.visual_analysis, "not_performed");
assert.equal(visual.source_sha256, fixture.sha256);
assert.equal(visual.complete_video_review, false);
assert.equal(frames.source_sha256, fixture.sha256);
assert.equal(frames.frames.length, 3);
for (const frame of frames.frames) {
  assert.equal(frame.ok, true);
  const png = await Deno.readFile(`${extracted}/frames/frame-${frame.i}.png`);
  assert.equal(await sha256Hex(png), frame.sha256);
  assert.equal(png.length, frame.bytes);
  const inspected = visual.frames.find((item: Json) => item.sha256 === frame.sha256);
  assert.equal(inspected?.at_ms, frame.at_ms);
  assert.equal(inspected?.method, "native_view_image_of_ffmpeg_bytes");
  assert.ok(!text.includes(inspected.observed_label));
}
assert.ok(extraction.transcript.length >= 3);
assert.ok(text.includes("Borboleta") && text.includes("bicicleta"));
const cue = extraction.transcript.find((item: Json) => item.text.includes("Borboleta"));
assert.ok(cue && cue.start_ms >= 12000 && cue.end_ms <= 23000);
const timestamp = `${cue.start_ms}-${cue.end_ms}ms`;
const cueOffset = text.indexOf(`[${cue.locator}]`);
assert.ok(cueOffset >= 0);

let receipt: Json;
try {
  receipt = await read(`${OUT}/owner.json`);
  assert.equal(receipt.fixture_sha256, fixture.sha256);
  assert.equal(receipt.scope, "MAT-02-synthetic-local-only");
  assert.match(receipt.owner_id, /^[a-f0-9-]{36}$/);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  receipt = {
    owner_id: crypto.randomUUID(),
    fixture_sha256: fixture.sha256,
    scope: "MAT-02-synthetic-local-only",
  };
  await write(`${OUT}/owner.json`, receipt);
}
const owner = { ownerId: receipt.owner_id as string };
const other = { ownerId: crypto.randomUUID() };
const db = createDb(DATABASE);
const hub = new Hub(db);
let server: Deno.HttpServer | undefined;
const clients: Client[] = [];
const calls: Json[] = [];
const assertions: string[] = [];
const mark = (value: string) => assertions.push(value);
async function sdk(path: string) {
  const client = new Client({ name: "MAT-02-synthetic-local-proof", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(server!.addr as Deno.NetAddr).port}/${path}/mcp`),
    ),
  );
  return client;
}
async function call(client: Client, name: string, args: Json = {}, expectedError?: string) {
  const raw = await client.callTool({ name, arguments: args });
  const content = raw.content as Array<{ type: string; text?: string }>;
  const result = JSON.parse(content.find((item) => item.type === "text")!.text!);
  calls.push({
    name,
    args,
    principal: client === clients[0] ? "fixture_owner" : "other_owner",
    isError: raw.isError ?? false,
    result,
  });
  if (expectedError) {
    assert.equal(raw.isError, true);
    assert.equal(result.code, expectedError);
  } else assert.notEqual(raw.isError, true, `${name} failed`);
  return result;
}
try {
  // Probe connection before invoking importer; no Docker/reset/migration fallback.
  await db`select 1`;
  await db`insert into auth.users(id) values(${other.ownerId})`;
  let sourceManifest: Json;
  try {
    sourceManifest = await read(`${OUT}/source-manifest.json`);
    assert.equal(sourceManifest.files[0].sha256, fixture.sha256);
    assert.equal(sourceManifest.files[0].path, fixture.source_path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    sourceManifest = {
      observed_at: new Date().toISOString(),
      university_mutation: false,
      synthetic: true,
      files: [{
        file_id: "MAT-02-synthetic-video",
        name: "MAT-02 synthetic video (local TTS)",
        mime: "video/mp4",
        bytes: fixture.bytes,
        sha256: fixture.sha256,
        path: fixture.source_path,
        origin: "urn:arahub:lab:MAT-02:synthetic",
        coverage: extraction.coverage,
      }],
    };
    await write(`${OUT}/source-manifest.json`, sourceManifest);
  }
  const importOptions = {
    ownerId: owner.ownerId,
    dbUrl: DATABASE,
    sourceManifestPath: `${OUT}/source-manifest.json`,
    extractedDir: `${OUT}/extracted`,
    structurePath: null,
  };
  const imported = await importProcessedMaterials(importOptions);
  assert.equal(imported.refusals.length, 0);
  assert.equal(imported.files.length, 1);
  assert.equal(imported.binaries_verified, 1);
  const file = imported.files[0];
  assert.equal(file.coverage, extraction.coverage);
  const replay = await importProcessedMaterials(importOptions);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.observations_inserted, 0);
  assert.equal(replay.kept_prior, 1);
  assert.equal(replay.files[0].file_id_row, file.file_id_row);
  mark("existing_importer_preserves_hash_bytes_coverage_and_replay_identity");
  const stored = await asOwner(db, owner, async (tx) => {
    await tx`set local statement_timeout='30s'`;
    return (await tx`select id,sha256,bytes,octet_length(binary_content) as stored_bytes,encode(extensions.digest(binary_content,'sha256'),'hex') as stored_hash,extraction,extracted_text from public.hub_files where owner_id=${owner.ownerId} and id=${file.file_id_row}`)[
      0
    ];
  });
  assert.equal(stored.stored_hash, fixture.sha256);
  assert.equal(stored.stored_bytes, fixture.bytes);
  assert.equal(stored.extracted_text, text);
  assert.deepEqual(stored.extraction.transcript, extraction.transcript);
  const provenance = await asOwner(
    db,
    owner,
    (tx) =>
      tx`select content_hash,provenance,coverage from public.hub_observations where owner_id=${owner.ownerId} and entity_id=${file.entity_id}`,
  );
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].provenance.sha256, fixture.sha256);
  assert.equal(provenance[0].provenance.provider_read, false);
  assert.equal(provenance[0].provenance.locator, fixture.source_path);
  mark("SQL_original_digest_and_occurrence_provenance_verified");
  server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    // Explicit local principal fixture: this is not Auth/OAuth/host authentication.
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/owner/") && !path.startsWith("/other/")) {
      return new Response(null, { status: 404 });
    }
    return handleMcp(request, hub, path.startsWith("/owner/") ? owner : other);
  });
  const ownSdk = await sdk("owner");
  const otherSdk = await sdk("other");
  const files = await call(ownSdk, "hub_files", { entity_id: file.entity_id });
  assert.equal(files.records.length, 1);
  assert.equal(files.records[0].sha256, fixture.sha256);
  assert.equal(files.records[0].extraction.visual_analysis, "not_performed");
  assert.equal(files.records[0].extraction.accuracy_verified, false);
  const found = await call(ownSdk, "hub_search_documents", { query: timestamp });
  assert.equal(found.records.length, 1);
  assert.equal(found.records[0].id, file.file_id_row);
  assert.ok(found.records[0].excerpt.includes(cue.text));
  const localized = await call(ownSdk, "hub_file_text", {
    file_id: file.file_id_row,
    sha256: fixture.sha256,
    offset: cueOffset,
    limit: 100,
  });
  assert.ok(localized.excerpt.startsWith(`[${cue.locator}] ${timestamp}`));
  assert.ok(localized.excerpt.includes(cue.text));
  assert.equal(localized.content_is_untrusted_data, true);
  assert.equal(localized.extraction.coverage_scope, "temporal_execution");
  assert.equal(localized.extraction.transcription.source_unreviewed, true);
  mark("real_MCP_SDK_search_by_preserved_timestamp_and_hash_pinned_excerpt");
  const pages: string[] = [];
  let offset: number | null = 0;
  for (let page = 0; offset !== null && page < 12; page++) {
    const part = await call(ownSdk, "hub_file_text", {
      file_id: file.file_id_row,
      sha256: fixture.sha256,
      offset,
      limit: 96,
    });
    pages.push(part.excerpt);
    offset = part.next_offset;
  }
  assert.equal(offset, null);
  assert.equal(pages.join(""), text);
  const hidden = await call(otherSdk, "hub_files", { entity_id: file.entity_id });
  assert.equal(hidden.records.length, 0);
  const hiddenSearch = await call(otherSdk, "hub_search_documents", { query: timestamp });
  assert.equal(hiddenSearch.records.length, 0);
  await call(
    otherSdk,
    "hub_file_text",
    { file_id: file.file_id_row, sha256: fixture.sha256 },
    "not_found",
  );
  await call(
    ownSdk,
    "hub_file_text",
    { file_id: file.file_id_row, sha256: "0".repeat(64) },
    "file_changed",
  );
  mark("bounded_pagination_reconstructs_transcript_other_owner_and_wrong_hash_refused");
  const fingerprints: Json = {};
  for (
    const path of [
      "scripts/lab/video_prove.py",
      "scripts/lab/video_prove.ts",
      "scripts/process_materials.ts",
      "scripts/import_processed_materials.ts",
      "src/material_processor.ts",
      "src/mcp.ts",
      "src/domain.ts",
    ]
  ) fingerprints[path] = await sha256Hex(await Deno.readFile(path));
  const proof = {
    scenario: "MAT-02",
    status: "passed_local_synthetic_scope",
    created_at: new Date().toISOString(),
    level: "lab_integration",
    source_provider: "synthetic_local_TTS_and_ffmpeg",
    fixture_sha256: fixture.sha256,
    bytes: fixture.bytes,
    owner_id: owner.ownerId,
    file_id: file.file_id_row,
    entity_id: file.entity_id,
    retained: "synthetic owner and source/extraction/bytes retained locally for review",
    authentication: "principal_injection_fixture_not_OAuth",
    external_network: false,
    assertions,
    imported,
    replay,
    provenance,
    transcript: extraction.transcript,
    coverage: extraction.coverage,
    coverage_scope: extraction.coverage_scope,
    accuracy_verified: false,
    visual_analysis_pipeline: "not_performed",
    visual_review: `${OUT}/visual-review.json`,
    asr_limits: {
      ground_truth: fixture.spoken,
      silent_intervals_ms: fixture.silent_intervals_ms,
      transcription_errors: [
        "abacaxi -> Bacachi",
        "AraHub -> Ara-Hab",
        "Não há conteúdo de curso split with spurious 'Não há como ser.'",
      ],
      approximate_timestamps: true,
      cue_overlap_ms: 1012,
      last_transcript_ms: extraction.transcription.last_ms,
      duration_ms: fixture.duration_ms,
      timeline_ratio: extraction.transcription.timeline_coverage_ratio,
      speech_in_silence_not_inferred: true,
    },
    timestamp_recovery: {
      requested: timestamp,
      cue_locator: cue.locator,
      character_offset: cueOffset,
      native_time_interval_tool: false,
      method:
        "MCP document search for timestamp then hash-pinned paginated excerpt; no video playback",
    },
    gaps: [
      "ASR is unreviewed and contains known lexical/time errors; complete means temporal execution only.",
      "Only three frames inspected externally; no full visual analysis or temporal video understanding.",
      "Native timestamp interval endpoint does not exist; existing MCP text search/read preserves timestamps.",
      "University/real sample and ChatGPT host are outside this run; no new production_read or host_chatgpt proof.",
      "No browser/player/OAuth/protected download is exercised by this local synthetic proof.",
    ],
    frames,
    calls,
    fingerprints,
  };
  await write(`${OUT}/proof.json`, proof);
  console.log(
    JSON.stringify({
      scenario: proof.scenario,
      status: proof.status,
      bytes: fixture.bytes,
      cues: extraction.transcript.length,
      mcp_calls: calls.length,
      assertions: assertions.length,
      evidence: `${OUT}/proof.json`,
    }),
  );
} catch (error) {
  await write(`${OUT}/failure.json`, {
    scenario: "MAT-02",
    status: "failed_local_synthetic",
    error: error instanceof Error ? error.message : "unknown",
    assertions,
    calls,
  });
  throw error;
} finally {
  for (const client of clients) await client.close();
  await server?.shutdown();
  try {
    await db`delete from auth.users where id=${other.ownerId}`;
  } finally {
    await db.end({ timeout: 5 });
  }
}
