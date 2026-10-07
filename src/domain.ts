import { z } from "zod";
import { type StudyFile, type StudyMaterial, studyPackage, type StudyRole } from "./production.ts";
import { asOwner, type Db } from "./db.ts";
import { type Delta, HubError, type Principal, type Provider } from "./contracts.ts";
import { preferenceSchema, resolvePreferences } from "./preferences.ts";
import { studyGraphPage } from "./study_graph.ts";

export const deltaSchema = z.object({
  idempotency_key: z.string().min(8).max(200),
  context_id: z.string().uuid(),
  kind: z.enum([
    "decision",
    "correction",
    "preference",
    "submission_report",
    "artifact",
    "experience",
  ]),
  content: z.string().min(1).max(32000),
  evidence_kind: z.enum(["user_report", "observed", "interpretation", "hypothesis"]),
  expected_version: z.number().int().min(0),
  provenance: z.array(
    z.object({
      system: z.string().max(80),
      locator: z.string().max(2000),
      version: z.string().max(200).optional(),
      excerpt: z.string().max(4000).optional(),
      observed_at: z.string().optional(),
      occurred_at: z.string().optional(),
      original_date: z.string().optional(),
    }).strict(),
  ).max(30),
  scope: z.record(z.string().max(200)).optional(),
  preference: preferenceSchema.optional(),
}).strict();

export class Hub {
  constructor(readonly db: Db) {}
  /** Logical owner-only storage, never the shared project's billable database size. */
  usage(p: Principal) {
    return asOwner(this.db, p, async (tx) => {
      const [counts] = await tx`select
        (select count(*)::integer from public.hub_contexts where owner_id=${p.ownerId}) as contexts,
        (select count(*)::integer from public.hub_connections where owner_id=${p.ownerId}) as connections,
        (select count(*)::integer from public.hub_entities where owner_id=${p.ownerId}) as entities,
        (select count(*)::integer from public.hub_deltas where owner_id=${p.ownerId}) as deltas,
        (select count(*)::integer from public.hub_jobs where owner_id=${p.ownerId}) as jobs`;
      const [files] = await tx`select count(*)::integer as files,
        coalesce(sum(bytes),0)::text as declared_file_bytes,
        coalesce(sum(octet_length(binary_content)),0)::text as preserved_binary_bytes,
        coalesce(sum(octet_length(extracted_text)),0)::text as extracted_text_utf8_bytes
        from public.hub_files where owner_id=${p.ownerId}`;
      return {
        observed_at: new Date().toISOString(),
        counts: { ...counts, files: files.files },
        storage: {
          declared_file_bytes: files.declared_file_bytes,
          preserved_binary_bytes: files.preserved_binary_bytes,
          extracted_text_utf8_bytes: files.extracted_text_utf8_bytes,
          measurement: "owner_logical_bytes",
          byte_values: "decimal_strings",
        },
        note:
          "Representações distintas do proprietário; não incluem índices, WAL, Auth, TOAST ou outros usuários. Não são tamanho físico/faturável do banco nem saldo de cota.",
      };
    });
  }
  createContext(p: Principal, title: string, scope: Record<string, string> = {}) {
    if (!title.trim() || title.length > 300) {
      throw new HubError("invalid_title", "Título inválido.");
    }
    return asOwner(
      this.db,
      p,
      async (tx) =>
        (await tx`insert into public.hub_contexts(owner_id,title,scope) values(${p.ownerId},${title},${
          tx.json(scope)
        }) returning id,title,scope,version`)[0],
    );
  }
  recordDelta(p: Principal, input: Delta) {
    const delta = deltaSchema.parse(input);
    if (
      delta.preference && (delta.kind !== "preference" ||
        (delta.preference.supersedes.length && delta.evidence_kind !== "user_report"))
    ) {
      throw new HubError(
        "invalid_preference",
        "Superação exige uma preferência explicitamente declarada.",
      );
    }
    return asOwner(
      this.db,
      p,
      async (tx) =>
        (await tx`select public.hub_record_delta(${tx.json(delta)}) as receipt`)[0].receipt,
    );
  }
  async commitAndRefresh(p: Principal, input: Delta, refresh: () => Promise<unknown>) {
    const receipt = await this.recordDelta(p, input);
    try {
      return {
        memory_commit: receipt,
        source_refresh: { status: "complete", result: await refresh() },
      };
    } catch {
      return {
        memory_commit: receipt,
        source_refresh: {
          status: "failed",
          message: "A memória foi salva; a fonte não foi atualizada.",
        },
      };
    }
  }
  context(p: Principal, id?: string, offset = 0, deltaOffset = 0) {
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(deltaOffset) || deltaOffset < 0 || (id && offset !== 0)
    ) throw new HubError("invalid_offset", "Página de contexto inválida.");
    return asOwner(this.db, p, async (tx) => {
      const candidates = id
        ? await tx`select id,title,scope,version,updated_at from public.hub_contexts where owner_id=${p.ownerId} and id=${id}`
        : await tx`select id,title,scope,version,updated_at from public.hub_contexts where owner_id=${p.ownerId} order by updated_at desc,id limit 21 offset ${offset}`;
      const contexts = candidates.slice(0, 20);
      if (id && !contexts.length) throw new HubError("not_found", "Registro não encontrado.", 404);
      const ids = contexts.map((c) => c.id as string);
      const deltas = ids.length
        ? await tx`select id,context_id,kind,content,evidence_kind,scope,preference,provenance,version,recorded_at from public.hub_deltas where owner_id=${p.ownerId} and context_id in ${
          tx(ids)
        } order by recorded_at desc,id limit 51 offset ${deltaOffset}`
        : [];
      const connections =
        await tx`select id,provider,label,origin,state,capabilities,desired_scopes,granted_scopes from public.hub_connections where owner_id=${p.ownerId}`;
      return {
        contexts,
        deltas: deltas.slice(0, 50),
        next_offset: candidates.length > 20 ? offset + 20 : null,
        deltas_next_offset: deltas.length > 50 ? deltaOffset + 50 : null,
        history_tool: "hub_history",
        connections,
        coverage: {
          memory: "persisted",
          contexts: candidates.length > 20 ? "partial" : "complete",
          deltas: deltas.length > 50 ? "partial" : "complete",
          sources:
            "See connection state; a historical memory does not prove current source refresh.",
        },
        content_is_untrusted_data: true,
      };
    });
  }
  search(p: Principal, query: string, offset = 0) {
    if (!query.trim() || query.length > 300 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new HubError("invalid_query", "Consulta inválida.");
    }
    return asOwner(this.db, p, async (tx) => {
      const rows =
        await tx`select id,context_id,kind,content,evidence_kind,scope,preference,provenance,version from public.hub_deltas where owner_id=${p.ownerId} and (to_tsvector('simple',content) @@ plainto_tsquery('simple',${query}) or content ilike ${
          "%" + query + "%"
        }) order by recorded_at desc,id limit 21 offset ${offset}`;
      const contexts =
        await tx`select id,title,scope,version,updated_at from public.hub_contexts where owner_id=${p.ownerId} and title ilike ${
          "%" + query + "%"
        } order by updated_at desc,id limit 21 offset ${offset}`;
      return {
        records: rows.slice(0, 20),
        contexts: contexts.slice(0, 20),
        next_offset: rows.length > 20 || contexts.length > 20 ? offset + 20 : null,
        record_next_offset: rows.length > 20 ? offset + 20 : null,
        context_next_offset: contexts.length > 20 ? offset + 20 : null,
        content_is_untrusted_data: true,
      };
    });
  }
  preferences(p: Principal, scope: Record<string, string>, at?: string) {
    const checkedScope = z.record(z.string().max(200)).parse(scope);
    const instant = at ? z.string().datetime({ offset: true }).parse(at) : new Date().toISOString();
    return asOwner(this.db, p, async (tx) => {
      const all =
        await tx`select id,context_id,content,evidence_kind,scope,preference,provenance,version,recorded_at from public.hub_deltas where owner_id=${p.ownerId} and kind='preference' and scope <@ ${
          tx.json(checkedScope)
        } order by recorded_at desc,id limit 201`;
      return resolvePreferences(all, instant);
    });
  }
  connect(
    p: Principal,
    provider: Provider,
    label: string,
    origin: string | null,
    subject: string | null,
    capabilities: object = {},
  ) {
    return asOwner(
      this.db,
      p,
      async (tx) =>
        (await tx`insert into public.hub_connections(owner_id,provider,label,origin,provider_subject,capabilities) values(${p.ownerId},${provider},${label},${origin},${subject},${
          tx.json(JSON.parse(JSON.stringify(capabilities)))
        }) returning id,provider,label,state`)[0],
    );
  }
  entity(
    p: Principal,
    connectionId: string,
    kind: string,
    externalId: string,
    title: string,
    state: Record<string, unknown> = {},
  ) {
    return asOwner(this.db, p, async (tx) => {
      // Explicit parent ownership check before FK avoids leaking foreign connection existence.
      const parent =
        await tx`select id from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId}`;
      if (!parent.length) throw new HubError("not_found", "Registro não encontrado.", 404);
      return (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${p.ownerId},${connectionId},${kind},${externalId},${title},${
        tx.json(JSON.parse(JSON.stringify(state)))
      }) on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title,state=excluded.state returning id,connection_id,kind,external_id,title,state`)[
        0
      ];
    });
  }
  history(p: Principal, contextId: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HubError("invalid_offset", "Página inválida.");
    }
    return asOwner(this.db, p, async (tx) => {
      const parent =
        await tx`select id,version from public.hub_contexts where owner_id=${p.ownerId} and id=${contextId}`;
      if (!parent.length) throw new HubError("not_found", "Registro não encontrado.", 404);
      const rows =
        await tx`select id,context_id,kind,content,evidence_kind,scope,preference,provenance,version,recorded_at from public.hub_deltas where owner_id=${p.ownerId} and context_id=${contextId} order by version desc limit 21 offset ${offset}`;
      return {
        context: parent[0],
        records: rows.slice(0, 20),
        next_offset: rows.length > 20 ? offset + 20 : null,
        content_is_untrusted_data: true,
      };
    });
  }
  files(p: Principal, entityId?: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HubError("invalid_offset", "Página inválida.");
    }
    return asOwner(this.db, p, async (tx) => {
      const rows = entityId
        ? await tx`select id,entity_id,name,mime_type,sha256,bytes,extraction - 'pages' as extraction from public.hub_files where owner_id=${p.ownerId} and entity_id=${entityId} order by name,id limit 21 offset ${offset}`
        : await tx`select id,entity_id,name,mime_type,sha256,bytes,extraction - 'pages' as extraction from public.hub_files where owner_id=${p.ownerId} order by name,id limit 21 offset ${offset}`;
      return { records: rows.slice(0, 20), next_offset: rows.length > 20 ? offset + 20 : null };
    });
  }
  entities(
    p: Principal,
    filter: { connection_id?: string; kind?: string; query?: string; offset?: number } = {},
  ) {
    const offset = filter.offset ?? 0;
    if (
      !Number.isSafeInteger(offset) || offset < 0 || (filter.query?.length ?? 0) > 300 ||
      (filter.kind?.length ?? 0) > 80
    ) throw new HubError("invalid_query", "Consulta inválida.");
    return asOwner(this.db, p, async (tx) => {
      const rows =
        await tx`select id,connection_id,kind,external_id,title from public.hub_entities where owner_id=${p.ownerId} and (${
          filter.connection_id ?? null
        }::uuid is null or connection_id=${filter.connection_id ?? null}::uuid) and (${
          filter.kind ?? null
        }::text is null or kind=${filter.kind ?? null}) and (${
          filter.query ?? null
        }::text is null or title ilike ${
          "%" + (filter.query ?? "") + "%"
        }) order by title,id limit 21 offset ${offset}`;
      return {
        records: rows.slice(0, 20),
        next_offset: rows.length > 20 ? offset + 20 : null,
        content_is_untrusted_data: true,
      };
    });
  }
  entityContext(p: Principal, id: string) {
    return asOwner(this.db, p, async (tx) => {
      const entity =
        (await tx`select id,connection_id,kind,external_id,title,state from public.hub_entities where owner_id=${p.ownerId} and id=${id}`)[
          0
        ];
      if (!entity) throw new HubError("not_found", "Registro não encontrado.", 404);
      const observations =
        await tx`select id,content_hash,provenance,coverage,occurred_at,source_modified_at,observed_at,recorded_at from public.hub_observations where owner_id=${p.ownerId} and entity_id=${id} order by observed_at desc limit 5`;
      const relations =
        await tx`select from_id,to_id,kind,evidence from public.hub_relations where owner_id=${p.ownerId} and (from_id=${id} or to_id=${id}) order by from_id,to_id limit 31`;
      return {
        entity,
        observations,
        relations: relations.slice(0, 30),
        relations_truncated: relations.length > 30,
        content_is_untrusted_data: true,
      };
    });
  }
  /** All preserved source versions stay reachable beyond the entity preview. */
  observations(p: Principal, entityId: string, after?: { observed_at: string; id: string }) {
    if (
      after &&
      (Number.isNaN(Date.parse(after.observed_at)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after.id))
    ) throw new HubError("invalid_cursor", "Continuação inválida.");
    return asOwner(this.db, p, async (tx) => {
      const entity =
        await tx`select id,connection_id,kind,external_id,title from public.hub_entities where owner_id=${p.ownerId} and id=${entityId}`;
      if (!entity.length) throw new HubError("not_found", "Registro não encontrado.", 404);
      const rows = after
        ? await tx`select id,content_hash,provenance,coverage,occurred_at,source_modified_at,observed_at,recorded_at,
          to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_observed_at
          from public.hub_observations where owner_id=${p.ownerId} and entity_id=${entityId}
          and (observed_at,id)<(${after.observed_at}::text::timestamptz,${after.id}::uuid)
          order by observed_at desc,id desc limit 21`
        : await tx`select id,content_hash,provenance,coverage,occurred_at,source_modified_at,observed_at,recorded_at,
          to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_observed_at
          from public.hub_observations where owner_id=${p.ownerId} and entity_id=${entityId}
          order by observed_at desc,id desc limit 21`;
      const last = rows[19];
      return {
        entity: entity[0],
        records: rows.slice(0, 20),
        next_cursor: rows.length > 20
          ? { observed_at: last.cursor_observed_at as string, id: last.id as string }
          : null,
        content_is_untrusted_data: true,
      };
    });
  }
  /** Read one version in bounded JSON text chunks; the source hash is not a hash of JSONB serialization. */
  observationText(p: Principal, id: string, offset = 0, limit = 8000) {
    if (
      !Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 16000
    ) throw new HubError("invalid_offset", "Trecho inválido.");
    return asOwner(this.db, p, async (tx) => {
      const rows = await tx`select id,entity_id,content_hash,provenance,coverage,
        occurred_at,source_modified_at,observed_at,recorded_at,
        char_length(content::text) as text_length,
        substring(content::text from ${offset + 1}::integer for ${limit}::integer) as excerpt
        from public.hub_observations where owner_id=${p.ownerId} and id=${id}`;
      if (!rows.length) throw new HubError("not_found", "Registro não encontrado.", 404);
      const row = rows[0] as {
        id: string;
        entity_id: string;
        content_hash: string;
        provenance: unknown;
        coverage: string;
        occurred_at: unknown;
        source_modified_at: unknown;
        observed_at: unknown;
        recorded_at: unknown;
        text_length: number;
        excerpt: string;
      };
      return {
        ...row,
        text_format: "jsonb_serialization",
        next_offset: row.text_length > offset + limit ? offset + limit : null,
        content_is_untrusted_data: true,
      };
    });
  }
  fileText(p: Principal, fileId: string, hash: string, offset = 0, limit = 8000) {
    if (
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 ||
      limit > 16000
    ) throw new HubError("invalid_offset", "Trecho inválido.");
    return asOwner(this.db, p, async (tx) => {
      const rows =
        await tx`select id,name,mime_type,sha256,extraction - 'pages' as extraction,char_length(extracted_text) as text_length,substring(extracted_text from ${
          offset + 1
        }::integer for ${limit}::integer) as excerpt from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`;
      if (!rows.length) throw new HubError("not_found", "Arquivo não encontrado.", 404);
      const row = rows[0];
      if (row.sha256 !== hash) {
        throw new HubError(
          "file_changed",
          "O arquivo mudou. Recupere o novo registro antes de ler.",
          409,
        );
      }
      return {
        ...row,
        excerpt: row.excerpt,
        next_offset: row.text_length > offset + limit ? offset + limit : null,
        coverage: row.excerpt !== null ? "text_available" : "binary_without_extraction",
        content_is_untrusted_data: true,
      };
    });
  }
  searchDocuments(p: Principal, query: string, offset = 0) {
    if (!query.trim() || query.length > 300 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new HubError("invalid_query", "Consulta inválida.");
    }
    return asOwner(this.db, p, async (tx) => {
      const rows =
        await tx`select f.id,f.entity_id,f.name,f.sha256,f.extraction - 'pages' as extraction,substring(f.extracted_text from greatest(position(lower(${query}) in lower(f.extracted_text))-120,1) for 800) as excerpt from public.hub_files f where f.owner_id=${p.ownerId} and f.extracted_text ilike ${
          "%" + query + "%"
        } order by f.name,f.id limit 21 offset ${offset}`;
      return {
        records: rows.slice(0, 20),
        next_offset: rows.length > 20 ? offset + 20 : null,
        content_is_untrusted_data: true,
      };
    });
  }
  activityPackage(p: Principal, activityId: string, goal: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HubError("invalid_offset", "Página inválida.");
    }
    return asOwner(this.db, p, async (tx) => {
      const activity =
        (await tx`select id,title,state from public.hub_entities where owner_id=${p.ownerId} and id=${activityId}`)[
          0
        ];
      if (!activity) throw new HubError("not_found", "Atividade não encontrada.", 404);
      // Agrupa por entidade antes de paginar: uma entidade pode ter várias
      // relações (tipos) e vários arquivos/versões, mas produz um só material.
      const graph = await studyGraphPage(tx, p.ownerId, activityId, offset);
      const related = graph.entities;
      const page = related.slice(0, 20);
      const nextOffset = related.length > 20 ? offset + 20 : null;
      const ids = page.map((e) => e.id as string);
      type ObservationRow = {
        observation_id: string;
        entity_id: string;
        content_hash: string;
        provenance: unknown;
        coverage: string;
        occurred_at: unknown;
        source_modified_at: unknown;
        observed_at: unknown;
        recorded_at: unknown;
      };
      type FileRow = {
        id: string;
        entity_id: string;
        name: string;
        mime_type: string;
        sha256: string;
        bytes: number | string;
        text_available: boolean;
        text_length: number | null;
        extraction: Record<string, unknown>;
      };
      const relations = graph.relations;
      const observations = (ids.length
        ? await tx`select distinct on (o.entity_id) o.id as observation_id,o.entity_id,o.content_hash,o.provenance,o.coverage,o.occurred_at,o.source_modified_at,o.observed_at,o.recorded_at from public.hub_observations o where o.owner_id=${p.ownerId} and o.entity_id in ${
          tx(ids)
        } order by o.entity_id,o.observed_at desc,o.recorded_at desc`
        : []) as unknown as ObservationRow[];
      const files = (ids.length
        ? await tx`select f.id,f.entity_id,f.name,f.mime_type,f.sha256,f.bytes,(f.extracted_text is not null) as text_available,char_length(f.extracted_text) as text_length,jsonb_build_object('coverage',f.extraction->'coverage','page_count',f.extraction->'page_count','has_extraction',f.extraction <> '{}'::jsonb) as extraction from public.hub_files f where f.owner_id=${p.ownerId} and f.entity_id in ${
          tx(ids)
        } order by f.entity_id,f.name,f.id`
        : []) as unknown as FileRow[];

      // Precedência explícita: uma relação mais forte define o papel; o conjunto
      // completo de tipos fica em relation_kinds para não perder proveniência.
      // 'has_content' é vínculo estrutural do Sync (module→pages/book/assignment)
      // e nunca vira 'required'.
      const precedence: readonly string[] = [
        "required",
        "related",
        "suggested",
        "has_content",
        "section_related",
        "references",
      ];
      const roleOf = (kind: string | undefined): StudyRole | "reference" =>
        kind === "required"
          ? "required"
          : kind === "suggested"
          ? "suggested"
          : kind === "references"
          ? "reference"
          : "related"; // related e has_content: material relacionado, nunca required.
      const kinds = new Map<string, string[]>();
      const rightsByRelation = new Map<string, Record<string, string>>();
      for (const relation of relations) {
        const entityId = relation.entity_id;
        const list = kinds.get(entityId) ?? [];
        if (!list.includes(relation.kind)) {
          list.push(relation.kind);
        }
        kinds.set(entityId, list);
        const evidence = relation.evidence ?? {};
        if (typeof evidence.rights === "string") {
          const declared = rightsByRelation.get(entityId) ?? {};
          declared[relation.kind] = evidence.rights;
          rightsByRelation.set(entityId, declared);
        }
      }
      const observed = new Map<string, ObservationRow>();
      for (const observation of observations) {
        observed.set(observation.entity_id, observation);
      }
      const filesByEntity = new Map<string, FileRow[]>();
      for (const file of files) {
        const entityId = file.entity_id;
        const list = filesByEntity.get(entityId) ?? [];
        list.push(file);
        filesByEntity.set(entityId, list);
      }

      const materials: StudyMaterial[] = [];
      const references: StudyMaterial[] = [];
      for (const entity of page) {
        const entityId = entity.id as string;
        const relationKinds = (kinds.get(entityId) ?? []).slice().sort(
          (x, y) =>
            precedence.indexOf(x) - precedence.indexOf(y),
        );
        const observation = observed.get(entityId) ?? null;
        const studyFiles: StudyFile[] = (filesByEntity.get(entityId) ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          mime_type: f.mime_type,
          sha256: f.sha256,
          bytes: f.bytes,
          locator: `hub:file:${f.id}#${f.sha256}`,
          text_available: f.text_available === true,
          text_length: f.text_length,
          extraction: f.extraction ?? {},
        }));
        const selectionRequired = studyFiles.length > 1;
        // Direitos podem divergir por tipo de relação: preserva o mapa e não
        // escolhe silenciosamente; o fallback nega redistribuição até revisão.
        const rightsByKind = rightsByRelation.get(entityId) ?? {};
        // Direitos acompanham os tipos de relação de cada entrada; o mapa completo
        // fica em rights_by_relation para revisão humana.
        const rightsFor = (kindsForEntry: string[]) => {
          const declared = new Set<string>();
          for (const kind of kindsForEntry) {
            const value = rightsByKind[kind];
            if (typeof value === "string") {
              declared.add(value);
            }
          }
          const distinct = [...declared];
          return {
            rights: distinct.length === 1
              ? distinct[0]
              : "private source; redistribution not authorized",
            rights_requires_review: distinct.length > 1,
          };
        };
        // Cobertura agregada só existe com observação; com várias versões e sem
        // observação, eleger a cobertura de um arquivo seria escolher versão.
        const aggregatedCoverage = observation
          ? observation.coverage as string
          : selectionRequired
          ? null
          : (studyFiles[0]?.extraction.coverage as string | null | undefined) ?? null;
        const entry: Omit<StudyMaterial, "role" | "rights" | "rights_requires_review"> = {
          id: entityId,
          title: entity.title as string,
          // Só elege um arquivo quando existe exatamente um; com várias versões
          // o localizador volta à entidade e selection_required pede a escolha.
          locator: studyFiles.length === 1 ? studyFiles[0].locator : `hub:entity:${entityId}`,
          rights_by_relation: rightsByKind,
          relation_kinds: relationKinds,
          relation_evidence: relations.filter((r) =>
            r.entity_id === entityId
          ).map((r) => ({
            kind: r.kind,
            evidence: r.evidence,
          })),
          coverage: aggregatedCoverage,
          provenance: observation ? observation.provenance : null,
          // Metadados da observação; o corpo fica recuperável por hub:entity:
          // para o pacote não duplicar a fonte integral na resposta.
          observation: observation
            ? {
              id: observation.observation_id,
              content_hash: observation.content_hash,
              provenance: observation.provenance,
              coverage: observation.coverage,
              occurred_at: observation.occurred_at,
              source_modified_at: observation.source_modified_at,
              observed_at: observation.observed_at,
              recorded_at: observation.recorded_at,
              locator: `hub:entity:${entityId}`,
            }
            : null,
          files: studyFiles,
          file_count: studyFiles.length,
          selection_required: selectionRequired,
        };
        // Bibliografia preservada mesmo quando a mesma entidade também é material;
        // material de has_content/related/suggested continua disponível sem 'required'.
        if (relationKinds.includes("references")) {
          references.push({ ...entry, ...rightsFor(["references"]), role: "reference" });
        }
        const materialKinds: string[] = [];
        for (const kind of relationKinds) {
          if (kind !== "references") {
            materialKinds.push(kind);
          }
        }
        if (materialKinds.length) {
          materials.push({
            ...entry,
            ...rightsFor(materialKinds),
            role: roleOf(materialKinds[0]),
          });
        }
      }

      const instruction = typeof activity.state.instruction === "string"
        ? activity.state.instruction
        : null;
      // O enunciado nativo do Moodle vem em state.provider_record.intro (HTML).
      // É exposto como descrição da fonte (dado bruto, sem executar) e nunca
      // promovido automaticamente a enunciado explícito.
      const providerRecord = activity.state.provider_record;
      const intro = providerRecord && typeof providerRecord === "object" &&
          typeof (providerRecord as Record<string, unknown>).intro === "string"
        ? (providerRecord as Record<string, string>).intro
        : null;
      const sourceDescription = intro === null ? null : {
        format: "html" as const,
        text: intro,
        origin: `hub:entity:${activityId}`,
        field: "provider_record.intro",
        content_is_untrusted_data: true,
      };
      const instructionGap = sourceDescription
        ? "Enunciado explícito não preservado; a descrição da fonte é dado bruto, não executado."
        : "Enunciado ainda não preservado. Consulte a fonte antes de produzir o trabalho.";
      return {
        ...studyPackage({ id: activityId, instruction: instruction ?? "" }, materials, goal),
        title: activity.title,
        references,
        source_description: sourceDescription,
        page: { offset, limit: 20, next_offset: nextOffset },
        next_offset: nextOffset,
        gaps: [...(instruction ? [] : [instructionGap]), ...graph.gaps],
        section_coverage: graph.section_coverage,
        limitations: [
          "Material de seção é relacionado pela estrutura preservada, não leitura obrigatória ou confirmada. Cursos inteiros e bibliografia em texto livre não são inferidos.",
        ],
        truncated: nextOffset !== null,
      };
    });
  }
  exportMemory(p: Principal) {
    return asOwner(this.db, p, async (tx) => {
      const tables = [
        "hub_connections",
        "hub_contexts",
        "hub_entities",
        "hub_observations",
        "hub_deltas",
        "hub_relations",
        "hub_files",
        "hub_jobs",
        "hub_context_targets",
      ] as const;
      const result: Record<string, unknown> = { format: "arahub-export-v1", owner_id: p.ownerId };
      for (const name of tables) {
        result[name] = await tx`select * from ${tx("public." + name)} where owner_id=${p.ownerId}`;
      }
      return result; // private credentials are deliberately outside this export.
    });
  }
}

export function reconcileActivity(
  prior: Record<string, unknown>,
  event: { kind: string; value?: unknown; authorMatches?: boolean },
) {
  const state = { ...prior };
  if (event.kind === "submission_report") {
    state.user_report = { reported: true, actual_submission_time: null };
  }
  if (event.kind === "completion") state.completion = event.value;
  if (event.kind === "reopened") state.availability = "reopened";
  if (event.kind === "grade") state.evaluation = event.value;
  if (event.kind === "forum_post" && event.authorMatches) state.forum_publication = event.value;
  return state;
}
export function selectActivity(ids: string[]) {
  if (ids.length !== 1) {
    throw new HubError("ambiguous_activity", "Qual atividade você entregou?", 409);
  }
  return ids[0];
}
export function formatInstant(instant: string, zone: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: zone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(instant));
}
