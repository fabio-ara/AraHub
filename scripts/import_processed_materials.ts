/**
 * Ingestão local dos materiais já processados no banco **exclusivo** do AraHub
 * (127.0.0.1:55432). Lê o manifesto de origem (ocorrência/hash) e a extração
 * preservada em `extracted/<sha256>/`, e grava ocorrência, origem, bytes,
 * texto, representação e proveniência em `hub_files`/`hub_entities`/
 * `hub_observations`/`hub_relations`.
 *
 * Regras:
 * - fonte isolada `provider='migration'` com origem própria do snapshot; nenhuma
 *   permissão Moodle é exigida, porque isto é ingestão de snapshot, não acesso
 *   ao provedor;
 * - idempotência qualificada por origem/hash: entidade por `external_id`,
 *   arquivo por (dono, entidade, sha256), observação por hash de conteúdo;
 * - o sha256 dos bytes é conferido **antes** de gravar e reconferido no banco
 *   depois de gravar; divergência recusa a ocorrência, não "corrige";
 * - extração mais fraca nunca substitui a mais forte do mesmo hash (mesma regra
 *   do merge de PDF), e a cobertura declarada não é promovida pela importação;
 * - binário de até 64 MiB em um único INSERT local é válido (o limite de
 *   fatiamento existia para o Edge, não para este banco);
 * - nada de rede externa, nada de audiovisual em diretório público ou log.
 *
 * Uso:
 *   deno run --allow-net=127.0.0.1:55432 --allow-read --allow-write=.private \
 *     --allow-env scripts/import_processed_materials.ts [--dry-run] [--limit N]
 */
import { Buffer } from "node:buffer";
import type { JSONValue } from "postgres";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { sha256Hex } from "../src/migration.ts";

export const DEFAULT_DB_URL = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
export const SNAPSHOT_ORIGIN = "local-materials-snapshot";
export const SNAPSHOT_SUBJECT = "entrega-1-materials";
export const SNAPSHOT_EXTERNAL_ID = "snapshot:entrega-1/materials";

/** Cobertura mais forte vale mais; empate mantém o que já está gravado. */
const COVERAGE_RANK: Record<string, number> = {
  complete: 5,
  partial: 4,
  timeout: 3,
  expired: 3,
  unavailable: 2,
  denied: 2,
  parsing_error: 1,
};

export function extractionStrength(extraction: unknown, textLength: number | null): number {
  const coverage = (extraction as { coverage?: unknown } | null | undefined)?.coverage;
  const rank = typeof coverage === "string" ? COVERAGE_RANK[coverage] ?? 0 : 0;
  const chars = Math.max(0, Math.min(textLength ?? 0, 999_999_999));
  return rank * 1_000_000_000 + chars;
}

export interface SourceOccurrence {
  file_id?: string | number;
  name?: string;
  mime?: string;
  bytes?: number;
  sha256: string;
  path: string;
  origin?: string;
  observed_at?: string;
  coverage?: string;
}

export interface ImportOptions {
  ownerId: string;
  dbUrl?: string;
  sourceManifestPath?: string;
  extractedDir?: string;
  structurePath?: string | null;
  dryRun?: boolean;
  limit?: number | null;
  maxBinaryBytes?: number;
}

export interface ImportedOccurrence {
  i: number;
  file_id: string | null;
  name: string;
  sha256: string;
  bytes: number;
  mime: string;
  entity_id: string;
  file_id_row: string | null;
  coverage: string;
  text_chars: number;
  action: "inserted" | "updated" | "kept_prior" | "dry_run";
  module_relation: string | null;
  observation_inserted: boolean;
  binary_verified: boolean | null;
}

export interface ImportRefusal {
  i: number;
  name: string;
  reason: string;
  detail: string;
}

export interface ImportSummary {
  owner_id: string;
  connection_id: string;
  snapshot_entity_id: string;
  occurrences: number;
  inserted: number;
  updated: number;
  kept_prior: number;
  unchanged: number;
  refusals: ImportRefusal[];
  observations_inserted: number;
  relations_upserted: number;
  entities: number;
  bytes_preserved: number;
  binaries_verified: number;
  coverage: Record<string, number>;
  files: ImportedOccurrence[];
}

function localOnly(url: string): void {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432") {
    throw new Error(
      "Esta ingestão só permite o banco local exclusivo do AraHub (127.0.0.1:55432).",
    );
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

function resolvePath(path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/")) return path;
  return Deno.cwd().replace(/\\/g, "/") + "/" + path.replace(/^\\.\//, "");
}

/** Índice filename → módulo, montado do snapshot de estrutura (sem inventar). */
interface ModuleRef {
  course_id: number | null;
  section: number | null;
  module_id: number | null;
  modname: string;
  filename: string;
}

function indexModules(structure: Record<string, unknown> | null): {
  byFilename: Map<string, ModuleRef[]>;
  courseId: number | null;
  modules: ModuleRef[];
} {
  const byFilename = new Map<string, ModuleRef[]>();
  const modules: ModuleRef[] = [];
  const sections = Array.isArray(structure?.data)
    ? structure.data as Record<string, unknown>[]
    : [];
  const courseId = typeof sections[0]?.id === "number" ? sections[0].id as number : null;
  for (const section of sections) {
    const sectionIndex = typeof section.section === "number" ? section.section as number : null;
    const list = Array.isArray(section.modules) ? section.modules as Record<string, unknown>[] : [];
    for (const module of list) {
      const contents = Array.isArray(module.contents)
        ? module.contents as Record<string, unknown>[]
        : [];
      const ref: ModuleRef = {
        course_id: courseId,
        section: sectionIndex,
        module_id: typeof module.id === "number" ? module.id as number : null,
        modname: typeof module.modname === "string" ? module.modname : "desconhecido",
        filename: contents.length && typeof contents[0].filename === "string"
          ? contents[0].filename
          : "",
      };
      modules.push(ref);
      // Um módulo pode declarar vários conteúdos com o mesmo nome (ou repetir o
      // mesmo arquivo); o vínculo é por módulo, então deduplica pelo id do
      // módulo para não fabricar ambiguidade onde existe um único módulo.
      for (const content of contents) {
        if (typeof content.filename !== "string") continue;
        const key = content.filename;
        const bucket = byFilename.get(key) ?? [];
        const moduleKey = String(ref.module_id ?? ref.modname + ":" + ref.section);
        if (
          bucket.some((entry) =>
            String(entry.module_id ?? entry.modname + ":" + entry.section) === moduleKey
          )
        ) {
          continue;
        }
        bucket.push(ref);
        byFilename.set(key, bucket);
      }
    }
  }
  return { byFilename, courseId, modules };
}

const ALLOWED_COVERAGE = new Set([
  "complete",
  "partial",
  "denied",
  "unavailable",
  "expired",
  "timeout",
  "parsing_error",
]);

function safeCoverage(value: unknown, fallback: unknown): string {
  if (typeof value === "string" && ALLOWED_COVERAGE.has(value)) return value;
  if (typeof fallback === "string" && ALLOWED_COVERAGE.has(fallback)) return fallback;
  return "unavailable";
}

/**
 * Tipo de módulo declarado na própria origem (pluginfile: `mod_<tipo>`).
 * É evidência do caminho da URL, não afirma vínculo com um módulo específico.
 */
export function originModuleType(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  const segment = origin.split("/").find((part) => part.startsWith("mod_"));
  return segment ? segment.slice(4) : null;
}

/** O cliente exige JSONValue; normaliza objetos montados em tempo de execução. */
function asJson(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

/** Executa a ingestão. Devolve o resumo; nunca lança por ocorrência ruim. */
export async function importProcessedMaterials(
  options: ImportOptions,
): Promise<ImportSummary> {
  const url = options.dbUrl ?? Deno.env.get("LOCAL_DATABASE_URL") ?? DEFAULT_DB_URL;
  localOnly(url);
  const manifestPath = options.sourceManifestPath ?? ".private/entrega-1/materials/manifest.json";
  const extractedDir = options.extractedDir ?? ".private/entrega-1/materials/extracted";
  const structurePath = options.structurePath === undefined
    ? ".private/entrega-1/materials/structure.json"
    : options.structurePath;
  const maxBinaryBytes = options.maxBinaryBytes ?? 64 * 1024 * 1024;
  const dryRun = options.dryRun === true;
  const manifest = await readJson(manifestPath);
  if (!manifest) throw new Error("Manifesto de origem não encontrado: " + manifestPath);
  const declared = Array.isArray(manifest.files) ? manifest.files as SourceOccurrence[] : [];
  const structure = structurePath === null ? null : await readJson(structurePath);
  const index = indexModules(structure);
  const selected = options.limit === null || options.limit === undefined
    ? declared
    : declared.slice(0, Math.max(0, options.limit));

  const principal = { ownerId: options.ownerId };
  const db = createDb(url);
  const hub = new Hub(db);
  const summary: ImportSummary = {
    owner_id: options.ownerId,
    connection_id: "",
    snapshot_entity_id: "",
    occurrences: selected.length,
    inserted: 0,
    updated: 0,
    kept_prior: 0,
    unchanged: 0,
    refusals: [],
    observations_inserted: 0,
    relations_upserted: 0,
    entities: 0,
    bytes_preserved: 0,
    binaries_verified: 0,
    coverage: {},
    files: [],
  };
  try {
    // `--dry-run` valida bytes/sha e não escreve nada (nem conexão/entidade).
    if (!dryRun) {
      await db`insert into auth.users(id) values(${options.ownerId}) on conflict do nothing`;
      // Conexões são protegidas: `authenticated` tem INSERT/SELECT, mas não UPDATE
      // (revogado por migration). Por isso a idempotência aqui é SELECT + INSERT,
      // e não ON CONFLICT DO UPDATE.
      const connection = await asOwner(db, principal, async (tx) => {
        const existing = await tx`select id,label from public.hub_connections
        where owner_id=${options.ownerId} and provider='migration'
          and origin=${SNAPSHOT_ORIGIN} and provider_subject=${SNAPSHOT_SUBJECT}`;
        if (existing.length) return existing[0];
        return (await tx`insert into public.hub_connections(owner_id,provider,label,origin,provider_subject,capabilities,state)
        values(${options.ownerId},'migration','Materiais processados (snapshot local)',${SNAPSHOT_ORIGIN},${SNAPSHOT_SUBJECT},${
          tx.json({ read: true, snapshot: true, external_network: false })
        },'connected') returning id,label`)[0];
      });
      summary.connection_id = connection.id as string;
      const snapshot = await hub.entity(
        principal,
        summary.connection_id,
        "snapshot",
        SNAPSHOT_EXTERNAL_ID,
        "Snapshot local de materiais processados",
        {
          source: "migration",
          origin: SNAPSHOT_ORIGIN,
          manifest: manifestPath,
          declared_occurrences: declared.length,
          university_mutation: manifest.university_mutation === true,
          observed_at: typeof manifest.observed_at === "string" ? manifest.observed_at : null,
        },
      );
      summary.snapshot_entity_id = snapshot.id as string;
      summary.entities++;
    }

    let position = 0;
    for (const occurrence of selected) {
      position++;
      const name = occurrence.name ?? "";
      const sourcePath = resolvePath(occurrence.path ?? "");
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(sourcePath);
      } catch {
        summary.refusals.push({
          i: position,
          name,
          reason: "source_missing",
          detail: "bytes de origem ausentes no caminho declarado",
        });
        continue;
      }
      const sha = await sha256Hex(bytes);
      if (sha !== occurrence.sha256) {
        summary.refusals.push({
          i: position,
          name,
          reason: "sha_mismatch",
          detail: "sha256 dos bytes difere do manifesto; ocorrência recusada",
        });
        continue;
      }
      if (bytes.byteLength > maxBinaryBytes) {
        summary.refusals.push({
          i: position,
          name,
          reason: "oversized_binary",
          detail: "bytes acima do teto do INSERT único local",
        });
        continue;
      }
      const extractedPath = extractedDir + "/" + sha;
      const extraction = await readJson(extractedPath + "/extraction.json");
      const text = await readTextOrNull(extractedPath + "/text.txt");
      const coverage = safeCoverage(
        (extraction as { coverage?: unknown } | null)?.coverage,
        occurrence.coverage,
      );
      const mime = occurrence.mime ?? "application/octet-stream";
      const fileId = occurrence.file_id === undefined ? null : String(occurrence.file_id);
      const externalId = fileId === null ? "sha:" + sha : "file:" + fileId;
      const matches = index.byFilename.get(name) ?? [];
      const moduleMatch = matches.length === 1 ? matches[0] : null;
      const moduleCandidates = matches.map((match) => ({
        cmid: match.module_id,
        modname: match.modname,
        section: match.section,
      }));
      const observedAt = occurrence.observed_at ?? new Date().toISOString();
      const strength = extractionStrength(extraction, text === null ? null : text.length);
      const importBlock = {
        origin: occurrence.origin ?? null,
        observed_at: observedAt,
        source_path: occurrence.path ?? null,
        snapshot: SNAPSHOT_ORIGIN,
        occurrence: position,
      };
      const fileExtraction = { ...(extraction ?? {}), import: importBlock };

      if (dryRun) {
        summary.coverage[coverage] = (summary.coverage[coverage] ?? 0) + 1;
        summary.files.push({
          i: position,
          file_id: fileId,
          name,
          sha256: sha,
          bytes: bytes.byteLength,
          mime,
          entity_id: "",
          file_id_row: null,
          coverage,
          text_chars: text === null ? 0 : text.length,
          action: "dry_run",
          module_relation: moduleMatch === null ? null : "cmid:" + moduleMatch.module_id,
          observation_inserted: false,
          binary_verified: null,
        });
        continue;
      }

      const outcome = await asOwner(db, principal, async (tx) => {
        const entity =
          (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
          values(${options.ownerId},${summary.connection_id},'resource',${externalId},${
            name || sha
          },${
            tx.json(asJson({
              origin: occurrence.origin ?? null,
              mime,
              bytes: bytes.byteLength,
              sha256: sha,
              observed_at: observedAt,
              coverage,
              representation: {
                kind: (extraction as { kind?: unknown } | null)?.kind ?? null,
                format: (extraction as { format?: unknown } | null)?.format ?? null,
                text_available: text !== null,
                source: "extracted/<sha256>",
              },
              origin_module_type: originModuleType(occurrence.origin),
              module_candidates: moduleMatch === null && moduleCandidates.length > 1
                ? moduleCandidates
                : [],
              source: { provider: "migration", snapshot: SNAPSHOT_ORIGIN },
            }))
          })
          on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title,state=excluded.state
          returning id`)[0];
        const entityId = entity.id as string;
        let moduleEntityId: string | null = null;
        if (moduleMatch !== null && moduleMatch.module_id !== null) {
          moduleEntityId =
            (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
            values(${options.ownerId},${summary.connection_id},'module',${
              "cmid:" + moduleMatch.module_id
            },${moduleMatch.modname},${
              tx.json({
                modname: moduleMatch.modname,
                section: moduleMatch.section,
                course_id: moduleMatch.course_id,
              })
            })
            on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title,state=excluded.state
            returning id`)[0].id as string;
        }

        const prior = await tx`select extraction,char_length(extracted_text) as text_length
          from public.hub_files where owner_id=${options.ownerId} and entity_id=${entityId} and sha256=${sha} for update`;
        let action: ImportedOccurrence["action"] = "inserted";
        let fileRowId: string | null = null;
        if (prior.length === 0) {
          fileRowId =
            (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction)
            values(${options.ownerId},${entityId},${
              name || sha
            },${mime},${sha},${bytes.byteLength},${Buffer.from(bytes)},${text},${
              tx.json(fileExtraction)
            }) returning id`)[0].id as string;
        } else if (
          strength > extractionStrength(prior[0].extraction, prior[0].text_length as number | null)
        ) {
          fileRowId =
            (await tx`update public.hub_files set name=${
              name || sha
            },mime_type=${mime},bytes=${bytes.byteLength},binary_content=${
              Buffer.from(bytes)
            },extracted_text=${text},extraction=${tx.json(fileExtraction)}
            where owner_id=${options.ownerId} and entity_id=${entityId} and sha256=${sha} returning id`)[
              0
            ]
              .id as string;
          action = "updated";
        } else {
          action = "kept_prior";
          fileRowId = (await tx`select id from public.hub_files
            where owner_id=${options.ownerId} and entity_id=${entityId} and sha256=${sha}`)[0]
            .id as string;
        }

        const content = {
          kind: "material_occurrence",
          external_id: externalId,
          name: name || sha,
          mime,
          bytes: bytes.byteLength,
          sha256: sha,
          coverage,
          origin: occurrence.origin ?? null,
          representation: (extraction as { kind?: unknown } | null)?.kind ?? null,
          snapshot: SNAPSHOT_ORIGIN,
        };
        const contentHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(content)));
        const observation =
          await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
          values(${options.ownerId},${entityId},${tx.json(asJson(content))},${contentHash},${
            tx.json(asJson({
              system: "migration",
              origin: SNAPSHOT_ORIGIN,
              locator: occurrence.path ?? null,
              sha256: sha,
              observed_at: observedAt,
              coverage,
              extraction_kind: (extraction as { kind?: unknown } | null)?.kind ?? null,
              provider_read: false,
            }))
          },${coverage},${observedAt})
          on conflict(owner_id,entity_id,content_hash) do nothing returning id`;
        const link = async (
          fromId: string,
          toId: string,
          kind: string,
          evidence: Record<string, unknown>,
        ) => {
          await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
            values(${options.ownerId},${fromId},${toId},${kind},${tx.json(asJson(evidence))})
            on conflict(owner_id,from_id,to_id,kind) do update set evidence=excluded.evidence`;
        };
        await link(entityId, summary.snapshot_entity_id, "preserved_from_snapshot", {
          reason: "ocorrência importada do snapshot local de materiais",
          source_path: occurrence.path ?? null,
          observed_at: observedAt,
          coverage,
          sha256: sha,
        });
        let relations = 1;
        if (moduleEntityId !== null && moduleMatch !== null) {
          await link(entityId, moduleEntityId, "material_of_module", {
            reason: "nome de arquivo casa com o conteúdo de exatamente um módulo do snapshot",
            filename: name,
            modname: moduleMatch.modname,
            section: moduleMatch.section,
            cmid: moduleMatch.module_id,
          });
          relations++;
        }
        const stored =
          await tx`select encode(extensions.digest(binary_content,'sha256'),'hex') as stored_sha,
          octet_length(binary_content) as stored_bytes
          from public.hub_files where owner_id=${options.ownerId} and id=${fileRowId}`;
        const binaryVerified = stored.length > 0 && stored[0].stored_sha === sha &&
          Number(stored[0].stored_bytes) === bytes.byteLength;
        return {
          entityId,
          fileRowId,
          action,
          observationInserted: observation.length > 0,
          relations,
          binaryVerified,
        };
      });

      summary.entities++;
      summary.observations_inserted += outcome.observationInserted ? 1 : 0;
      summary.relations_upserted += outcome.relations;
      if (outcome.action === "inserted" || outcome.action === "updated") {
        summary.bytes_preserved += bytes.byteLength;
      }
      if (outcome.binaryVerified) summary.binaries_verified++;
      if (outcome.action === "inserted") summary.inserted++;
      else if (outcome.action === "updated") summary.updated++;
      else summary.kept_prior++;
      summary.coverage[coverage] = (summary.coverage[coverage] ?? 0) + 1;
      summary.files.push({
        i: position,
        file_id: fileId,
        name,
        sha256: sha,
        bytes: bytes.byteLength,
        mime,
        entity_id: outcome.entityId,
        file_id_row: outcome.fileRowId,
        coverage,
        text_chars: text === null ? 0 : text.length,
        action: outcome.action,
        module_relation: moduleMatch === null ? null : "cmid:" + moduleMatch.module_id,
        observation_inserted: outcome.observationInserted,
        binary_verified: outcome.binaryVerified,
      });
      if (matches.length > 1) {
        summary.refusals.push({
          i: position,
          name,
          reason: "module_match_ambiguous",
          detail: matches.length + " módulos com o mesmo nome de conteúdo (" +
            moduleCandidates.map((candidate) => candidate.modname + ":" + candidate.cmid).join(
              ",",
            ) +
            "); vínculo não afirmado",
        });
      }
    }
    return summary;
  } finally {
    await db.end();
  }
}

function parseArgs(argv: string[]): { dryRun: boolean; limit: number | null; ownerPath: string } {
  let dryRun = false;
  let limit: number | null = null;
  let ownerPath = ".private/local-owner.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--limit") limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (argv[i] === "--owner") ownerPath = argv[++i] ?? ownerPath;
  }
  return { dryRun, limit, ownerPath };
}

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const owner = JSON.parse(await Deno.readTextFile(args.ownerPath)) as { ownerId: string };
  const summary = await importProcessedMaterials({
    ownerId: owner.ownerId,
    dryRun: args.dryRun,
    limit: args.limit,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = ".private/entrega-1/materials/import-" + stamp + ".json";
  await Deno.mkdir(".private/entrega-1/materials", { recursive: true });
  await Deno.writeTextFile(
    evidencePath,
    JSON.stringify({ ...summary, evidence: evidencePath }, null, 2) + "\n",
  );
  console.log(JSON.stringify({
    occurrences: summary.occurrences,
    inserted: summary.inserted,
    updated: summary.updated,
    kept_prior: summary.kept_prior,
    refusals: summary.refusals.length,
    observations_inserted: summary.observations_inserted,
    relations_upserted: summary.relations_upserted,
    bytes_preserved: summary.bytes_preserved,
    binaries_verified: summary.binaries_verified,
    coverage: summary.coverage,
    connection_id: summary.connection_id,
    snapshot_entity_id: summary.snapshot_entity_id,
    evidence: evidencePath,
  }));
}
