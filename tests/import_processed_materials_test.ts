/**
 * Prova da ingestão local de materiais processados (scripts/import_processed_materials.ts)
 * contra o Postgres exclusivo do AraHub (127.0.0.1:55432).
 *
 * A fixture é sintética e gerada no próprio teste (sem dado real, sem rede):
 * dois materiais com bytes + extração + texto, um caso de sha divergente e um
 * caso de nome de arquivo presente em dois módulos. O que se prova aqui:
 *
 * - ingestão idempotente (segunda execução não insere nem duplica observação);
 * - sha256 conferido antes de gravar; divergência recusa a ocorrência;
 * - extração mais fraca nunca substitui a mais forte do mesmo hash;
 * - recuperação por MCP SDK com autenticação sintética: listagem, trecho
 *   profundo com hash fixado, busca no texto, proveniência e a transcrição
 *   local (com `accuracy_verified:false` preservado);
 * - isolamento: outro dono não vê nem lê o material alheio.
 *
 * Donos são aleatórios por execução (mesma convenção dos testes de PDF, que
 * também usam o banco local exclusivo sem apagar linhas).
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { createEdgeHandler } from "../src/edge.ts";
import { Hub } from "../src/domain.ts";
import { sha256Hex } from "../src/migration.ts";
import { importProcessedMaterials } from "../scripts/import_processed_materials.ts";

const DB_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const BASE = "https://fixture.invalid/functions/v1/arahub";
const ISSUER = "https://identity.invalid/auth";
const DEEP_MARKER = "TRECHO-PROFUNDO-MARCADO";
const SEARCH_TERM = "termo-unico-de-busca";

interface Fixture {
  root: string;
  manifestPath: string;
  extractedDir: string;
  structurePath: string;
  docSha: string;
  mediaSha: string;
  ambiguousSha: string;
  docTextLength: number;
}

function filler(length: number, seed: string): string {
  let out = "";
  while (out.length < length) out += seed + " ";
  return out.slice(0, length);
}

/** Monta a fixture sintética em diretório privado (fora de qualquer publicação). */
async function buildFixture(): Promise<Fixture> {
  const root = ".private/test-materials-import-" + crypto.randomUUID().slice(0, 8);
  const sourceDir = root + "/source";
  const extractedDir = root + "/extracted";
  await Deno.mkdir(sourceDir, { recursive: true });
  await Deno.mkdir(extractedDir, { recursive: true });

  const docBytes = new TextEncoder().encode("<p>documento sintético " + SEARCH_TERM + "</p>");
  const mediaBytes = new TextEncoder().encode("bytes-sinteticos-de-midia");
  const ambiguousBytes = new TextEncoder().encode("<p>material com nome repetido</p>");
  const docSha = await sha256Hex(docBytes);
  const mediaSha = await sha256Hex(mediaBytes);
  const ambiguousSha = await sha256Hex(ambiguousBytes);
  await Deno.writeFile(sourceDir + "/ficha-sintetica.html", docBytes);
  await Deno.writeFile(sourceDir + "/gravacao-sintetica.mp4", mediaBytes);
  await Deno.writeFile(sourceDir + "/repetido.html", ambiguousBytes);

  // Texto do documento: o marcador profundo fica depois do primeiro lote, para
  // provar recuperação paginada por offset.
  const docText = filler(9_000, "linha") + "\n" + DEEP_MARKER + " " + SEARCH_TERM + "\n";
  await Deno.mkdir(extractedDir + "/" + docSha, { recursive: true });
  await Deno.writeTextFile(extractedDir + "/" + docSha + "/text.txt", docText);
  await Deno.writeTextFile(
    extractedDir + "/" + docSha + "/extraction.json",
    JSON.stringify(
      {
        kind: "document_text_extraction",
        format: "html",
        coverage: "complete",
        characters: docText.length,
        content_is_untrusted_data: true,
      },
      null,
      2,
    ),
  );

  // Texto da mídia: transcrição local com locadores e limite de acurácia.
  const mediaText = [
    "[asr:pt:1] 0-1500ms primeira linha da transcricao",
    "[asr:pt:2] 1600-3000ms segunda linha da transcricao",
    "",
  ].join("\n");
  await Deno.mkdir(extractedDir + "/" + mediaSha, { recursive: true });
  await Deno.writeTextFile(extractedDir + "/" + mediaSha + "/text.txt", mediaText);
  await Deno.writeTextFile(
    extractedDir + "/" + mediaSha + "/extraction.json",
    JSON.stringify(
      {
        kind: "video_media_extraction",
        coverage: "complete",
        transcript_source: "local_asr",
        asr: "completed_local",
        asr_reviewed: false,
        coverage_scope: "temporal_execution",
        accuracy_verified: false,
        visual_analysis: "not_performed",
        transcription: {
          segment_count: 2,
          accuracy_verified: false,
          source_unreviewed: true,
        },
      },
      null,
      2,
    ),
  );

  await Deno.writeTextFile(
    root + "/manifest.json",
    JSON.stringify(
      {
        kind: "materials_snapshot",
        university_mutation: false,
        observed_at: "2026-10-07T00:00:00Z",
        files: [
          {
            file_id: "9001",
            name: "ficha-sintetica.html",
            mime: "text/html",
            bytes: docBytes.byteLength,
            sha256: docSha,
            path: root + "/source/ficha-sintetica.html",
            origin: "snapshot:teste",
            observed_at: "2026-10-07T00:00:00Z",
            coverage: "complete",
          },
          {
            file_id: "9002",
            name: "gravacao-sintetica.mp4",
            mime: "video/mp4",
            bytes: mediaBytes.byteLength,
            sha256: mediaSha,
            path: root + "/source/gravacao-sintetica.mp4",
            origin: "snapshot:teste",
            observed_at: "2026-10-07T00:00:00Z",
            coverage: "complete",
          },
          {
            file_id: "9003",
            name: "repetido.html",
            mime: "text/html",
            bytes: ambiguousBytes.byteLength,
            sha256: ambiguousSha,
            path: root + "/source/repetido.html",
            origin: "snapshot:teste",
            observed_at: "2026-10-07T00:00:00Z",
            coverage: "complete",
          },
          {
            file_id: "9004",
            name: "ficha-sintetica.html",
            mime: "text/html",
            bytes: docBytes.byteLength,
            sha256: "0".repeat(64),
            path: root + "/source/ficha-sintetica.html",
            origin: "snapshot:teste",
            observed_at: "2026-10-07T00:00:00Z",
            coverage: "complete",
          },
        ],
      },
      null,
      2,
    ),
  );
  await Deno.writeTextFile(
    root + "/structure.json",
    JSON.stringify(
      {
        coverage: "complete",
        data: [{
          id: 4242,
          name: "curso sintético",
          section: 0,
          modules: [
            {
              id: 777,
              modname: "resource",
              contents: [
                { filename: "ficha-sintetica.html" },
                { filename: "ficha-sintetica.html" },
              ],
            },
            { id: 778, modname: "url", contents: [{ filename: "gravacao-sintetica.mp4" }] },
            { id: 779, modname: "resource", contents: [{ filename: "repetido.html" }] },
            { id: 780, modname: "folder", contents: [{ filename: "repetido.html" }] },
          ],
        }],
      },
      null,
      2,
    ),
  );
  return {
    root,
    manifestPath: root + "/manifest.json",
    extractedDir,
    structurePath: root + "/structure.json",
    docSha,
    mediaSha,
    ambiguousSha,
    docTextLength: docText.length,
  };
}

interface SyntheticAuth {
  handler: (request: Request) => Promise<Response>;
  privateKey: CryptoKey;
}

async function syntheticAuth(
  hub: Hub,
  owners: Array<{ owner: string; sid: string }>,
): Promise<SyntheticAuth> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const auth = {
    issuer: ISSUER,
    audience: "authenticated",
    resource: BASE + "/mcp",
    allowedClientIds: ["materials-fixture"],
    key: createLocalJWKSet({
      keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "ES256" }],
    }),
    sessionActive: (owner: string, sid: string) =>
      Promise.resolve(owners.some((entry) => entry.owner === owner && entry.sid === sid)),
  };
  return { handler: createEdgeHandler(hub, auth, BASE + "/"), privateKey };
}

async function connectClient(
  auth: SyntheticAuth,
  owner: string,
  sid: string,
): Promise<Client> {
  const token = await new SignJWT({
    role: "authenticated",
    session_id: sid,
    client_id: "materials-fixture",
  }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(owner).setIssuer(ISSUER)
    .setAudience("authenticated").setIssuedAt().setExpirationTime("10m").sign(auth.privateKey);
  const client = new Client({ name: "materials-fixture", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        auth.handler(new Request(input, init)),
    }),
  );
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

Deno.test("ingestão local: preserva ocorrências/bytes/proveniência e é idempotente", async () => {
  const fixture = await buildFixture();
  const ownerA = crypto.randomUUID();
  const ownerB = crypto.randomUUID();
  const db = createDb(DB_URL);
  const hub = new Hub(db);
  try {
    await db`insert into auth.users(id) values(${ownerA}) on conflict do nothing`;
    await db`insert into auth.users(id) values(${ownerB}) on conflict do nothing`;

    const first = await importProcessedMaterials({
      ownerId: ownerA,
      sourceManifestPath: fixture.manifestPath,
      extractedDir: fixture.extractedDir,
      structurePath: fixture.structurePath,
    });
    assert.equal(first.occurrences, 4);
    assert.equal(first.inserted, 3, "três ocorrências com sha válido");
    assert.equal(first.kept_prior, 0);
    assert.equal(first.observations_inserted, 3);
    assert.equal(first.binaries_verified, 3, "sha conferido no banco após gravar");
    assert.equal(first.relations_upserted, 5, "3 vínculos com o snapshot + 2 com módulos");
    assert.deepEqual(
      first.refusals.map((refusal) => refusal.reason).sort(),
      ["module_match_ambiguous", "sha_mismatch"],
    );
    assert.equal(first.connection_id.length > 0, true);
    assert.equal(
      first.bytes_preserved,
      first.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    const docFile = first.files.find((file) => file.sha256 === fixture.docSha);
    const mediaFile = first.files.find((file) => file.sha256 === fixture.mediaSha);
    assert.ok(docFile && mediaFile);
    assert.equal(docFile.action, "inserted");
    assert.equal(docFile.binary_verified, true);
    assert.equal(docFile.module_relation, "cmid:777", "dedupe do módulo com conteúdo repetido");
    assert.equal(mediaFile.module_relation, "cmid:778");
    const ambiguous = first.files.find((file) => file.sha256 === fixture.ambiguousSha);
    assert.ok(ambiguous);
    assert.equal(ambiguous.module_relation, null, "dois módulos com o mesmo nome: não adivinha");

    const second = await importProcessedMaterials({
      ownerId: ownerA,
      sourceManifestPath: fixture.manifestPath,
      extractedDir: fixture.extractedDir,
      structurePath: fixture.structurePath,
    });
    assert.equal(second.inserted, 0, "segunda execução não insere de novo");
    assert.equal(second.kept_prior, 3, "mesmo hash e mesma força: mantém o guardado");
    assert.equal(second.observations_inserted, 0, "observação idempotente por hash de conteúdo");
    assert.equal(second.relations_upserted, 5);
    assert.equal(second.refusals.length, 2);

    const sidA = crypto.randomUUID();
    const sidB = crypto.randomUUID();
    const auth = await syntheticAuth(hub, [
      { owner: ownerA, sid: sidA },
      { owner: ownerB, sid: sidB },
    ]);
    const clientA = await connectClient(auth, ownerA, sidA);
    const listed = await clientA.callTool({ name: "hub_files", arguments: {} });
    const listedText = textOf(listed);
    assert.ok(listedText.includes(fixture.docSha), "listagem traz o hash do material");
    const listedJson = JSON.parse(listedText) as {
      records: Array<{ id: string; sha256: string; bytes: number }>;
    };
    assert.equal(listedJson.records.length, 3);

    const deep = await clientA.callTool({
      name: "hub_file_text",
      arguments: {
        file_id: docFile.file_id_row,
        sha256: fixture.docSha,
        offset: 9_000,
        limit: 200,
      },
    });
    const deepJson = JSON.parse(textOf(deep)) as {
      excerpt: string;
      text_length: number;
      coverage: string;
      content_is_untrusted_data: boolean;
    };
    assert.ok(
      deepJson.excerpt.includes(DEEP_MARKER),
      "trecho profundo recuperado por offset com hash fixado",
    );
    assert.equal(deepJson.text_length, fixture.docTextLength);
    assert.equal(deepJson.coverage, "text_available");
    assert.equal(deepJson.content_is_untrusted_data, true);

    const wrongHash = await clientA.callTool({
      name: "hub_file_text",
      arguments: { file_id: docFile.file_id_row, sha256: "a".repeat(64) },
    });
    assert.equal(wrongHash.isError, true, "hash divergente não devolve texto");

    const found = await clientA.callTool({
      name: "hub_search_documents",
      arguments: { query: SEARCH_TERM },
    });
    const foundText = textOf(found);
    assert.ok(foundText.includes(fixture.docSha), "busca textual encontra o material");
    assert.ok(foundText.includes(SEARCH_TERM));

    const transcript = await clientA.callTool({
      name: "hub_file_text",
      arguments: { file_id: mediaFile.file_id_row, sha256: fixture.mediaSha, limit: 400 },
    });
    const transcriptJson = JSON.parse(textOf(transcript)) as {
      excerpt: string;
      extraction: { transcript_source?: string; accuracy_verified?: boolean };
    };
    assert.ok(
      transcriptJson.excerpt.includes("[asr:pt:1]"),
      "transcrição recuperável por localizador",
    );
    assert.equal(transcriptJson.extraction.transcript_source, "local_asr");
    assert.equal(
      transcriptJson.extraction.accuracy_verified,
      false,
      "acurácia não verificada é preservada na recuperação",
    );

    const observations = await clientA.callTool({
      name: "hub_observations",
      arguments: { entity_id: docFile.entity_id },
    });
    assert.ok(
      textOf(observations).includes("local-materials-snapshot"),
      "proveniência da ocorrência",
    );

    const clientB = await connectClient(auth, ownerB, sidB);
    const otherList = await clientB.callTool({ name: "hub_files", arguments: {} });
    const otherJson = JSON.parse(textOf(otherList)) as { records: unknown[] };
    assert.equal(otherJson.records.length, 0, "outro dono não vê material alheio");
    const otherRead = await clientB.callTool({
      name: "hub_file_text",
      arguments: { file_id: docFile.file_id_row, sha256: fixture.docSha },
    });
    assert.equal(otherRead.isError, true, "outro dono não lê arquivo alheio");
  } finally {
    await db.end();
    await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("ingestão local: extração mais fraca não substitui a mais forte", async () => {
  const fixture = await buildFixture();
  const owner = crypto.randomUUID();
  const db = createDb(DB_URL);
  try {
    await db`insert into auth.users(id) values(${owner}) on conflict do nothing`;
    const first = await importProcessedMaterials({
      ownerId: owner,
      sourceManifestPath: fixture.manifestPath,
      extractedDir: fixture.extractedDir,
      structurePath: fixture.structurePath,
    });
    const docFile = first.files.find((file) => file.sha256 === fixture.docSha);
    assert.ok(docFile);

    // Execução posterior mais fraca: cobertura parcial e texto curto.
    await Deno.writeTextFile(fixture.extractedDir + "/" + fixture.docSha + "/text.txt", "curto\n");
    await Deno.writeTextFile(
      fixture.extractedDir + "/" + fixture.docSha + "/extraction.json",
      JSON.stringify({ kind: "document_text_extraction", coverage: "partial", characters: 6 }),
    );
    const weaker = await importProcessedMaterials({
      ownerId: owner,
      sourceManifestPath: fixture.manifestPath,
      extractedDir: fixture.extractedDir,
      structurePath: fixture.structurePath,
    });
    const docAfter = weaker.files.find((file) => file.sha256 === fixture.docSha);
    assert.ok(docAfter);
    assert.equal(docAfter.action, "kept_prior", "execução mais fraca não sobrescreve");
    assert.equal(docAfter.text_chars, 6, "o resumo descreve a execução fraca");

    const stored = await db`select char_length(extracted_text) as text_length,
      extraction->>'coverage' as coverage
      from public.hub_files where owner_id=${owner} and id=${docFile.file_id_row}::uuid`;
    assert.equal(stored[0].text_length, fixture.docTextLength, "texto forte permanece gravado");
    assert.equal(stored[0].coverage, "complete", "cobertura forte permanece gravada");
  } finally {
    await db.end();
    await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("ingestão local: simulação não cria identidade nem memória", async () => {
  const fixture = await buildFixture();
  const owner = crypto.randomUUID();
  const db = createDb(DB_URL);
  try {
    const result = await importProcessedMaterials({
      ownerId: owner,
      sourceManifestPath: fixture.manifestPath,
      extractedDir: fixture.extractedDir,
      structurePath: fixture.structurePath,
      dryRun: true,
    });
    assert.ok(result.files.length > 0);
    assert.equal((await db`select id from auth.users where id=${owner}`).length, 0);
    assert.equal(
      (await db`select id from public.hub_connections where owner_id=${owner}`).length,
      0,
    );
  } finally {
    await db.end();
    await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
  }
});
