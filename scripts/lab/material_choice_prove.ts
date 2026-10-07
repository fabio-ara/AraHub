/**
 * AraHub MIT — MAT03, local SQL + MCP SDK, existing preserved materials only.
 * The consumer judgment is authored by the assistant in a PRIVATE input file;
 * this harness verifies recovery, provenance and persistence, not an automatic
 * academic selection algorithm. It never chooses by filename or suffix.
 *
 * deno run --cached-only --allow-env --allow-read --allow-net=127.0.0.1:55432
 *   --allow-write=.private/entrega-1/materials/choice scripts/lab/material_choice_prove.ts
 * Optional private paths: --comparison=PATH --recovery=PATH --inference=PATH
 * Successful test owner is retained for root's readback; originals are read-only.
 * No downloads/provider credentials/browser. Images must never be saved through
 * UI/menu/shortcut/data/blob; captures only native results and bytes outside UI.
 */
import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asOwner, createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { HubError, type Principal } from "../../src/contracts.ts";
import { handleMcp } from "../../src/mcp.ts";
import { sha256Hex } from "../../src/migration.ts";

// Private proof/SDK JSON boundaries; used fields are checked before any write.
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const root = ".private/entrega-1/materials";
const arg = (name: string, fallback: string) =>
  Deno.args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1) ?? fallback;
const comparisonPath = arg("--comparison", root + "/worksheet-comparison.json");
const recoveryPath = arg("--recovery", root + "/mcp-recovery-proof.json");
const inferencePath = arg("--inference", root + "/choice/consumer-inference.json");
const run = crypto.randomUUID();
const output = root + "/choice/proof-" + run + ".json";
const owner = { ownerId: crypto.randomUUID() }, other = { ownerId: crypto.randomUUID() };
const checks: Json[] = [], clients: Client[] = [], forbiddenBodies: string[] = [];
const report: Json = {
  schema: "arahub.material-choice.local-proof/1",
  scenario: "MAT-03",
  run,
  started_at: new Date().toISOString(),
  status: "running",
  checks,
  level: "lab_integration",
  transport: "real MCP SDK with custom local fetch and synthetic principal",
  database: "127.0.0.1:55432/arahub",
  network_scope: "local PostgreSQL only; no provider service configured",
  consumer:
    "assistant-authored focal question over existing content comparison; no automatic choice algorithm",
  source_bodies_printed: false,
  external_provider_calls: 0,
  downloads: 0,
  hosted: "not_run",
  host_chatgpt: "not_run",
  browser: "not_run",
  user_choice_recorded: false,
  limits: [
    "Existing authorized preservation is reused; no claim of current Moodle instructions fetched now",
    "Question is recorded for a later clarification, not asked of the user during this engineering proof",
    "Metadata evidence contains hashes, origins and checks, never source bodies",
    "The test does not choose an academically correct version or assert a user decision",
  ],
};
const json = async (path: string): Promise<Json> => JSON.parse(await Deno.readTextFile(path));
const textHash = (text: string) => sha256Hex(new TextEncoder().encode(text));
function requireCheck(condition: unknown, name: string, detail: Json = {}) {
  const passed = Boolean(condition);
  checks.push({ name, passed, ...detail });
  if (!passed) throw Error("MAT03_" + name.toUpperCase());
}
async function save() {
  const serialized = JSON.stringify(report, null, 2);
  if (forbiddenBodies.some((body) => body.length > 80 && serialized.includes(body))) {
    throw Error("MAT03_BODY_IN_EVIDENCE");
  }
  await Deno.mkdir(root + "/choice", { recursive: true });
  await Deno.writeTextFile(output, serialized);
}
const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
const hub = new Hub(db);
let ownersCreated = false;
try {
  const comparison = await json(comparisonPath),
    recovery = await json(recoveryPath),
    inference = await json(inferencePath);
  const comparisonHash = await sha256Hex(await Deno.readFile(comparisonPath));
  const recoveryHash = await sha256Hex(await Deno.readFile(recoveryPath));
  const inferenceHash = await sha256Hex(await Deno.readFile(inferencePath));
  report.inputs = {
    comparison: { path: comparisonPath, sha256: comparisonHash },
    recovery: { path: recoveryPath, sha256: recoveryHash },
    inference: { path: inferencePath, sha256: inferenceHash },
  };
  const candidates = comparison.evidence as Json[];
  requireCheck(
    Array.isArray(candidates) && candidates.length >= 2 && candidates.length <= 10 &&
      candidates.every((c) =>
        /^[a-f0-9]{64}$/.test(c.sha256) && Array.isArray(c.occurrences) && c.occurrences.length
      ),
    "private_comparison_shape",
  );
  const hashes = candidates.map((c) => c.sha256);
  requireCheck(new Set(hashes).size === candidates.length, "distinct_binary_versions");
  requireCheck(
    recovery.kind === "local_import_mcp_recovery_proof" &&
      /^[a-f0-9-]{36}$/.test(recovery.owner_id) && recovery.wrong_hash_refused &&
      recovery.observation_provenance_ok && recovery.isolation?.other_owner_read_refused,
    "prior_local_recovery_verified",
  );
  requireCheck(
    inference.actor === "assistant_inference" && inference.mode === "focal_question" &&
      inference.selected_sha256 === null && inference.user_choice_recorded === false &&
      inference.comparison_sha256 === comparisonHash && typeof inference.question === "string" &&
      inference.question.length > 30 && typeof inference.rationale === "string",
    "authored_inference_not_user_choice",
  );
  requireCheck(
    inference.basis.length === candidates.length &&
      candidates.every((c) =>
        inference.basis.some((b: Json) =>
          b.sha256 === c.sha256 && b.has_ert === c.has_ert &&
          b.has_tool_analysis === c.has_tool_analysis && b.occurrence_count === c.occurrences.length
        )
      ),
    "inference_anchored_to_existing_content_comparison",
  );
  const original = { ownerId: recovery.owner_id };
  const readSource = () =>
    asOwner(
      db,
      original,
      (tx) =>
        tx`select f.id as file_id,f.entity_id,f.sha256,f.mime_type,f.bytes,f.binary_content,f.extracted_text,f.extraction,e.kind,e.state
    from public.hub_files f join public.hub_entities e on e.id=f.entity_id and e.owner_id=f.owner_id
    where f.owner_id=${original.ownerId} and f.sha256 in ${tx(hashes)} order by f.id`,
    );
  const rows = await readSource();
  const readObservations = () =>
    asOwner(
      db,
      original,
      (tx) =>
        tx`select id,entity_id,content,content_hash,provenance,coverage,observed_at from public.hub_observations
    where owner_id=${original.ownerId} and entity_id in ${
          tx(rows.map((r) => r.entity_id))
        } order by id`,
    );
  requireCheck(
    rows.length === candidates.reduce((n, c) => n + c.occurrences.length, 0),
    "all_origin_occurrences_present",
    { occurrences: rows.length, distinct_versions: hashes.length },
  );
  const sourceObservations = await readObservations();
  const fingerprint = async (fileRows: Json[], observations: Json[]) =>
    textHash(JSON.stringify({
      files: await Promise.all(fileRows.map(async (r) => ({
        file_id: r.file_id,
        entity_id: r.entity_id,
        sha256: r.sha256,
        binary_hash: await sha256Hex(new Uint8Array(r.binary_content)),
        text_hash: await textHash(r.extracted_text ?? ""),
        extraction_hash: await textHash(JSON.stringify(r.extraction)),
        state_hash: await textHash(JSON.stringify(r.state)),
      }))),
      observations,
    }));
  const before = await fingerprint(rows, sourceObservations);
  for (const candidate of candidates) {
    const diskText = await Deno.readTextFile(candidate.text_locator_file);
    forbiddenBodies.push(diskText);
    const relevant = rows.filter((r) => r.sha256 === candidate.sha256);
    requireCheck(
      relevant.length === candidate.occurrences.length &&
        relevant.every((r) =>
          r.extracted_text === diskText &&
          candidate.occurrences.some((o: Json) => o.origin === r.state.origin)
        ),
      "text_and_origin_match_preserved_comparison",
      {
        sha256: candidate.sha256,
        occurrences: relevant.length,
        text_sha256: await textHash(diskText),
      },
    );
    for (const row of relevant) {
      const origin = new URL(row.state.origin);
      requireCheck(
        origin.protocol === "https:" && !origin.username && !origin.password &&
          ![...origin.searchParams.keys()].some((k) =>
            /token|password|secret|authorization|sesskey/i.test(k)
          ),
        "credential_free_provenance",
      );
      requireCheck(
        await sha256Hex(new Uint8Array(row.binary_content)) === row.sha256,
        "original_binary_hash_verified",
        { sha256: row.sha256 },
      );
    }
  }
  await db`insert into auth.users(id) values(${owner.ownerId}),(${other.ownerId})`;
  ownersCreated = true;
  const connection = await hub.connect(
    owner,
    "migration",
    "MAT03 isolated local evidence",
    null,
    null,
    { synthetic_owner: true, source: "already_preserved_private_materials" },
  );
  const copied: Json[] = [];
  for (const [index, row] of rows.entries()) {
    // All aliases deliberately identical. No original filename enters a choice rule.
    const entity = await hub.entity(
      owner,
      connection.id,
      row.kind,
      "mat03/" + run + "/" + index,
      "Material candidate",
      { ...row.state, local_fixture_copy: true },
    );
    const file = await asOwner(
      db,
      owner,
      async (tx) =>
        (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction)
      values(${owner.ownerId},${entity.id},'material.docx',${row.mime_type},${row.sha256},${row.bytes},${
          Buffer.from(row.binary_content)
        },${row.extracted_text},${tx.json(row.extraction)}) returning id`)[0],
    );
    const observations = sourceObservations.filter((o) => o.entity_id === row.entity_id);
    requireCheck(
      observations.length > 0 &&
        observations.some((o) =>
          o.provenance.sha256 === row.sha256 &&
          typeof o.provenance.locator === "string" && o.provenance.locator.includes(row.sha256)
        ),
      "source_observation_provenance_present",
    );
    for (const observation of observations) {
      await asOwner(
        db,
        owner,
        (tx) =>
          tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
        values(${owner.ownerId},${entity.id},${
            tx.json(observation.content)
          },${observation.content_hash},${
            tx.json({ ...observation.provenance, local_fixture_copy: true })
          },${observation.coverage},${observation.observed_at})`,
      );
    }
    copied.push({
      file_id: file.id,
      entity_id: entity.id,
      sha256: row.sha256,
      origin: row.state.origin,
      source_file_id: row.file_id,
      expected_text: row.extracted_text,
    });
  }
  const connect = async (principal: Principal) => {
    const client = new Client({ name: "mat03-local-choice", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
        fetch: (input: string | URL | Request, init?: RequestInit) =>
          handleMcp(new Request(input, init), hub, principal),
      }),
    );
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Json,
    errorExpected = false,
  ): Promise<Json> => {
    const result = await client.callTool({ name, arguments: args });
    if (Boolean(result.isError) !== errorExpected) throw Error("MAT03_SDK_ERROR_STATE");
    const content = result.content as { type: string; text?: string }[];
    return JSON.parse(content.find((c) => c.type === "text")!.text!);
  };
  const a = await connect(owner), b = await connect(other);
  const listed = await call(a, "hub_files", {});
  requireCheck(
    listed.records.length === copied.length &&
      new Set(listed.records.map((f: Json) => f.name)).size === 1,
    "filename_cues_removed_from_test_aliases",
  );
  report.versions_recovered = [];
  for (const file of copied) {
    let offset = 0, recovered = "", pages = 0, complete = false;
    for (let page = 0; page < 100; page++) {
      const result = await call(a, "hub_file_text", {
        file_id: file.file_id,
        sha256: file.sha256,
        offset,
        limit: 400,
      });
      requireCheck(
        result.sha256 === file.sha256 && typeof result.excerpt === "string" &&
          result.content_is_untrusted_data === true,
        "sdk_hash_pinned_text",
      );
      recovered += result.excerpt;
      pages++;
      if (result.next_offset === null) {
        complete = true;
        break;
      }
      if (result.next_offset <= offset) throw Error("MAT03_PAGINATION_GUARD");
      offset = result.next_offset;
    }
    requireCheck(
      complete && recovered === file.expected_text,
      "sdk_full_text_matches_preservation",
      { sha256: file.sha256, pages, characters: recovered.length },
    );
    const context = await call(a, "hub_entity_context", { entity_id: file.entity_id });
    const versions = await call(a, "hub_observations", { entity_id: file.entity_id });
    requireCheck(
      context.entity.state.origin === file.origin && context.entity.state.sha256 === file.sha256 &&
        versions.records.some((o: Json) =>
          o.provenance.sha256 === file.sha256 &&
          typeof o.provenance.locator === "string" && o.provenance.locator.includes(file.sha256)
        ),
      "sdk_origin_and_version_provenance",
    );
    const blocks = await call(a, "hub_document_blocks", {
      file_id: file.file_id,
      sha256: file.sha256,
      limit: 10,
    });
    const locators = (blocks.blocks ?? []).map((block: Json) => block.locator);
    requireCheck(
      locators.length > 0 &&
        locators.every((l: unknown) => typeof l === "string" && l.startsWith("docx:")),
      "sdk_content_locators_present",
    );
    report.versions_recovered.push({
      file_id: file.file_id,
      entity_id: file.entity_id,
      source_file_id: file.source_file_id,
      sha256: file.sha256,
      origin: file.origin,
      import_observation_locators: versions.records.map((o: Json) => o.provenance.locator),
      text_sha256: await textHash(recovered),
      pages,
      locators,
    });
  }
  const wrong = await call(a, "hub_file_text", {
    file_id: copied[0].file_id,
    sha256: "0".repeat(64),
  }, true);
  const denied = await call(b, "hub_file_text", {
    file_id: copied[0].file_id,
    sha256: copied[0].sha256,
  }, true);
  requireCheck(
    wrong.code === "file_changed" && denied.code === "not_found",
    "hash_and_other_owner_refusals",
  );
  const context = await call(a, "hub_create_context", {
    title: "MAT03 isolated consumer inference",
    scope: { proof_run: run, object_test: "true" },
  });
  const decisionText = inference.rationale + "\n\nPergunta focal: " + inference.question;
  const provenance = [
    ...copied.map((file) => ({ system: "moodle", locator: file.origin, version: file.sha256 })),
    { system: "private_comparison", locator: comparisonPath, version: comparisonHash },
    { system: "assistant_inference", locator: inferencePath, version: inferenceHash },
  ];
  const delta = {
    context_id: context.id,
    expected_version: 0,
    idempotency_key: "MAT03:" + run,
    kind: "decision",
    evidence_kind: "interpretation",
    content: decisionText,
    provenance,
    scope: {
      actor: "assistant_inference",
      decision_type: "focal_question",
      selection_status: "needs_scope_confirmation",
      user_choice_recorded: "false",
      basis: "preserved_content_and_origins",
      comparison_sha256: comparisonHash,
    },
  };
  const recorded = await call(a, "hub_record_delta", delta);
  const replayed = await call(a, "hub_record_delta", delta);
  const history = await call(a, "hub_history", { context_id: context.id });
  const saved = history.records[0];
  requireCheck(
    history.records.length === 1 && saved.content === decisionText && saved.kind === "decision" &&
      saved.evidence_kind === "interpretation" && saved.scope.actor === "assistant_inference" &&
      saved.scope.user_choice_recorded === "false" &&
      saved.scope.selection_status === "needs_scope_confirmation",
    "focal_question_persisted_as_assistant_inference",
  );
  requireCheck(
    provenance.every((p) =>
      saved.provenance.some((q: Json) =>
        q.system === p.system && q.locator === p.locator && q.version === p.version
      )
    ),
    "decision_retains_origins_and_hashes",
  );
  requireCheck(recorded.id === replayed.id && replayed.replayed === true, "delta_idempotent");
  requireCheck(
    await fingerprint(await readSource(), await readObservations()) === before,
    "original_materials_and_observations_unchanged",
  );
  requireCheck(
    await sha256Hex(await Deno.readFile(comparisonPath)) === comparisonHash &&
      await sha256Hex(await Deno.readFile(recoveryPath)) === recoveryHash,
    "original_private_proofs_unchanged",
  );
  report.consumer_decision = {
    mode: "focal_question",
    actor: "assistant_inference",
    schema_evidence_kind: "interpretation",
    inference_path: inferencePath,
    inference_sha256: inferenceHash,
    content_sha256: await textHash(decisionText),
    context_id: context.id,
    delta_id: saved.id,
    version: saved.version,
    selection: null,
    user_choice_recorded: false,
    provenance_count: provenance.length,
  };
  report.fixture = {
    owner_id: owner.ownerId,
    connection_id: connection.id,
    retained: true,
    isolated_from_original_owner: owner.ownerId !== original.ownerId,
  };
  report.original_snapshot_sha256 = before;
  report.runner_sha256 = await sha256Hex(
    await Deno.readFile("scripts/lab/material_choice_prove.ts"),
  );
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.failure = error instanceof HubError
    ? error.code
    : error instanceof Error && /^MAT03_[A-Z_]+$/.test(error.message)
    ? error.message
    : "details_omitted";
} finally {
  for (const client of clients) {
    try {
      await client.close();
    } catch { /* Already closed. */ }
  }
  if (ownersCreated) {
    try {
      await db`delete from auth.users where id=${other.ownerId}`;
      if (report.status !== "pass") await db`delete from auth.users where id=${owner.ownerId}`;
    } catch {
      report.cleanup_failed = true;
      report.status = "fail";
    }
  }
  await db.end();
  report.finished_at = new Date().toISOString();
  await save();
  console.log(
    "MAT03 " + report.status + "; checks=" + checks.filter((c) => c.passed).length +
      "; evidence: " + output,
  );
  if (report.status !== "pass") Deno.exitCode = 1;
}
