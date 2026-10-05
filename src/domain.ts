import { z } from "zod";
import { studyPackage } from "./production.ts";
import { asOwner, type Db } from "./db.ts";
import { type Delta, HubError, type Principal, type Provider } from "./contracts.ts";
import { preferenceSchema, resolvePreferences } from "./preferences.ts";

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
  context(p: Principal, id?: string) {
    return asOwner(this.db, p, async (tx) => {
      const contexts = id
        ? await tx`select id,title,scope,version,updated_at from public.hub_contexts where owner_id=${p.ownerId} and id=${id}`
        : await tx`select id,title,scope,version,updated_at from public.hub_contexts where owner_id=${p.ownerId} order by updated_at desc limit 20`;
      if (id && !contexts.length) throw new HubError("not_found", "Registro não encontrado.", 404);
      const ids = contexts.map((c) => c.id as string);
      const deltas = ids.length
        ? await tx`select id,context_id,kind,content,evidence_kind,scope,preference,provenance,version,recorded_at from public.hub_deltas where owner_id=${p.ownerId} and context_id in ${
          tx(ids)
        } order by recorded_at desc limit 50`
        : [];
      const connections =
        await tx`select id,provider,label,origin,state,capabilities,desired_scopes,granted_scopes from public.hub_connections where owner_id=${p.ownerId}`;
      return {
        contexts,
        deltas,
        connections,
        coverage: {
          memory: "persisted",
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
        }) order by recorded_at desc limit 21 offset ${offset}`;
      return {
        records: rows.slice(0, 20),
        next_offset: rows.length > 20 ? offset + 20 : null,
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
        ? await tx`select id,entity_id,name,mime_type,sha256,bytes,extraction from public.hub_files where owner_id=${p.ownerId} and entity_id=${entityId} order by name,id limit 21 offset ${offset}`
        : await tx`select id,entity_id,name,mime_type,sha256,bytes,extraction from public.hub_files where owner_id=${p.ownerId} order by name,id limit 21 offset ${offset}`;
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
  fileText(p: Principal, fileId: string, hash: string, offset = 0, limit = 8000) {
    if (
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 ||
      limit > 16000
    ) throw new HubError("invalid_offset", "Trecho inválido.");
    return asOwner(this.db, p, async (tx) => {
      const rows =
        await tx`select id,name,mime_type,sha256,extraction,char_length(extracted_text) as text_length,substring(extracted_text from ${
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
        await tx`select f.id,f.entity_id,f.name,f.sha256,f.extraction,substring(f.extracted_text from greatest(position(lower(${query}) in lower(f.extracted_text))-120,1) for 800) as excerpt from public.hub_files f where f.owner_id=${p.ownerId} and f.extracted_text ilike ${
          "%" + query + "%"
        } order by f.name,f.id limit 21 offset ${offset}`;
      return {
        records: rows.slice(0, 20),
        next_offset: rows.length > 20 ? offset + 20 : null,
        content_is_untrusted_data: true,
      };
    });
  }
  activityPackage(p: Principal, activityId: string, goal: string) {
    return asOwner(this.db, p, async (tx) => {
      const activity =
        (await tx`select id,title,state from public.hub_entities where owner_id=${p.ownerId} and id=${activityId}`)[
          0
        ];
      if (!activity) throw new HubError("not_found", "Atividade não encontrada.", 404);
      const related =
        await tx`select e.id,e.title,r.kind,r.evidence,f.id as file_id,f.sha256 from public.hub_relations r join public.hub_entities e on e.owner_id=r.owner_id and e.id=r.to_id left join public.hub_files f on f.owner_id=e.owner_id and f.entity_id=e.id where r.owner_id=${p.ownerId} and r.from_id=${activityId} and r.kind in ('required','related','suggested','references') order by e.title limit 30`;
      const instruction = typeof activity.state.instruction === "string"
        ? activity.state.instruction
        : null;
      const materials = related.map((r) => ({
        id: r.id,
        role: r.kind === "required"
          ? "required" as const
          : r.kind === "suggested"
          ? "suggested" as const
          : "related" as const,
        locator: r.file_id ? `hub:file:${r.file_id}#${r.sha256}` : `hub:entity:${r.id}`,
        rights: typeof r.evidence.rights === "string"
          ? r.evidence.rights
          : "private source; redistribution not authorized",
      }));
      return {
        ...studyPackage({ id: activityId, instruction: instruction ?? "" }, materials, goal),
        title: activity.title,
        gaps: instruction
          ? []
          : ["Enunciado ainda não preservado. Consulte a fonte antes de produzir o trabalho."],
        truncated: related.length === 30,
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
