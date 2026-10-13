import { z } from "zod";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { sha256Hex } from "./migration.ts";

export const targetSchema = z.object({
  context_id: z.string().uuid(),
  entity_ids: z.array(z.string().uuid()).max(20),
  expected_version: z.number().int().min(0),
}).strict();
export const submissionReportSchema = z.object({
  context_id: z.string().uuid(),
  idempotency_key: z.string().min(8).max(200),
  expected_version: z.number().int().min(0),
  content: z.string().min(1).max(32000),
  target_entity_id: z.string().uuid().optional(),
}).strict();
const activityKinds = ["activity", "module", "assignment", "assign", "forum", "feedback"];

export const academicEventSchema = z.object({
  content: z.string().trim().min(1).max(32000),
  event_type: z.enum([
    "submission",
    "forum_topic",
    "forum_reply",
    "completion",
    "deadline_change",
    "requirements_change",
    "feedback_received",
  ]),
  context_id: z.string().uuid().optional(),
  target_entity_id: z.string().uuid().optional(),
  requirement_key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,60}$/).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  original_date: z.string().max(200).optional(),
  occurrence_key: z.string().min(1).max(120).optional(),
  reported_distinct_colleagues: z.number().int().min(1).max(200).optional(),
  idempotency_key: z.string().min(8).max(200).optional(),
  expected_version: z.number().int().min(0).optional(),
  supersedes: z.string().uuid().optional(),
  retract: z.boolean().optional(),
}).strict();

/** Context IDs travel between conversations; no global chat ID or automatic chat capture is assumed. */
export class WorkContext {
  constructor(private hub: Hub) {}
  /** An explicit tool invocation, never passive chat capture. Append under the
   * context lock; corrections still require the version the client reviewed. */
  async recordEvent(p: Principal, input: z.infer<typeof academicEventSchema>) {
    const a = academicEventSchema.parse(input);
    if (a.reported_distinct_colleagues !== undefined && a.event_type !== "forum_reply") {
      throw new HubError(
        "invalid_quantity",
        "Quantidade de colegas só se aplica a respostas no fórum.",
      );
    }
    if (!a.context_id && !a.target_entity_id) {
      throw new HubError(
        "ambiguous_activity",
        "Identifique a atividade ou o contexto do relato.",
        409,
      );
    }
    if ((a.supersedes && a.expected_version === undefined) || (a.retract && !a.supersedes)) {
      throw new HubError(
        "version_required",
        "Correção exige o registro anterior e a versão revisada.",
        409,
      );
    }
    return await asOwner(this.hub.db, p, async (tx) => {
      // Serializes automatic context creation and semantic retries for this owner.
      // Ordinary recordDelta/bind calls are also fenced by the context row lock.
      await tx`select pg_advisory_xact_lock(hashtextextended(${p.ownerId + ":academic-events"},0))`;
      let context = a.context_id
        ? (await tx`select id,title,version from public.hub_contexts
          where owner_id=${p.ownerId} and id=${a.context_id} for update`)[0]
        : undefined;
      if (a.context_id && !context) {
        throw new HubError("not_found", "Contexto não encontrado.", 404);
      }
      const candidates = a.target_entity_id
        ? [a.target_entity_id]
        : (await tx`select entity_id from public.hub_context_targets
          where owner_id=${p.ownerId} and context_id=${a.context_id!} and active`)
          .map((r) => String(r.entity_id));
      const resolved = new Map<string, { id: string; title: string; connection_id: string }>();
      for (const id of candidates) {
        let entity = (await tx`select id,title,kind,connection_id from public.hub_entities
          where owner_id=${p.ownerId} and id=${id}`)[0];
        if (!entity || !activityKinds.includes(entity.kind)) {
          throw new HubError("not_found", "Atividade não encontrada.", 404);
        }
        if (entity.kind === "module") {
          const contents = await tx`select e.id,e.title,e.kind,e.connection_id
            from public.hub_relations r join public.hub_entities e
              on e.owner_id=r.owner_id and e.id=r.to_id
            where r.owner_id=${p.ownerId} and r.from_id=${id} and r.kind='has_content'
              and e.connection_id=${entity.connection_id}
              and e.kind in ('assignment','forum','feedback')`;
          if (contents.length > 1) {
            throw new HubError("ambiguous_activity", "Módulo com atividades distintas.", 409);
          }
          if (contents.length === 1) entity = contents[0];
        }
        resolved.set(String(entity.id), {
          id: String(entity.id),
          title: String(entity.title),
          connection_id: String(entity.connection_id),
        });
      }
      if (resolved.size !== 1) {
        throw new HubError(
          "ambiguous_activity",
          "Qual atividade corresponde ao acontecimento?",
          409,
        );
      }
      const entity = [...resolved.values()][0];
      if (a.requirement_key) {
        const requirements = await tx`select r.id from public.hub_relations rel
          join public.hub_entities r on r.owner_id=rel.owner_id and r.id=rel.to_id
          where rel.owner_id=${p.ownerId} and rel.from_id=${entity.id}
            and rel.kind='states_requirement' and r.kind='academic_requirement'
            and regexp_replace(r.external_id,'^.*/','')=${a.requirement_key}`;
        if (requirements.length !== 1) {
          throw new HubError("not_found", "Obrigação não encontrada na atividade.", 404);
        }
      }
      const normalize = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
      const hash = (value: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
      const identity = {
        entity_id: entity.id,
        event_type: a.event_type,
        requirement_key: a.requirement_key ?? null,
        occurrence: a.occurrence_key ?? a.occurred_at ?? a.original_date ?? null,
        supersedes: a.supersedes ?? null,
        retract: a.retract ?? false,
        reported_distinct_colleagues: a.reported_distinct_colleagues ?? null,
        // A milestone is the same event when retold. New attempts use occurrence_key.
        content: ["submission", "forum_topic", "completion"].includes(a.event_type) && !a.supersedes
          ? null
          : normalize(a.content),
      };
      const eventIdentity = await hash(identity);
      const fingerprint = await hash({ ...identity, content: normalize(a.content) });
      const key = a.idempotency_key ?? `academic-event:${eventIdentity}`;
      const priors =
        await tx`select id,context_id,version,scope,idempotency_key from public.hub_deltas
        where owner_id=${p.ownerId} and (idempotency_key=${key} or scope->>'event_identity'=${eventIdentity})
        order by recorded_at,id`;
      const keyed = priors.find((r) => r.idempotency_key === key);
      if (
        keyed && (keyed.scope.event_identity !== eventIdentity ||
          (a.idempotency_key && keyed.scope.event_fingerprint !== fingerprint))
      ) {
        throw new HubError(
          "idempotency_conflict",
          "A chave já identifica outro acontecimento.",
          409,
        );
      }
      const prior = keyed ?? priors[0];
      if (prior) {
        if (
          prior.scope.event_identity !== eventIdentity ||
          (a.idempotency_key && prior.scope.event_fingerprint !== fingerprint)
        ) {
          throw new HubError(
            "idempotency_conflict",
            "A chave já identifica outro acontecimento.",
            409,
          );
        }
        const successors = await tx`select id from public.hub_deltas where owner_id=${p.ownerId}
          and scope->>'supersedes'=${String(prior.id)}`;
        return {
          memory_commit: { id: prior.id, version: prior.version, replayed: true },
          context_id: prior.context_id,
          target_entity_id: entity.id,
          event_type: a.event_type,
          evidence_kind: "user_report",
          external_submission: "not_verified",
          superseded_by: successors.map((r) => r.id),
          current: successors.length === 0,
        };
      }
      // Reuse an existing legacy delivery milestone, rather than creating a
      // competing event merely because the client adopted the composite tool.
      if (
        a.event_type === "submission" && !a.supersedes && !a.idempotency_key &&
        !a.occurrence_key && !a.occurred_at && !a.original_date && !a.requirement_key
      ) {
        const legacy = (await tx`select d.id,d.context_id,d.version from public.hub_deltas d
          where d.owner_id=${p.ownerId} and d.kind='submission_report' and d.evidence_kind='user_report'
            and d.scope->>'event_identity' is null and coalesce(d.scope->>'retracted','false')<>'true'
            and (d.scope->>'entity_id'=${entity.id} or (coalesce(d.scope->>'entity_id','')='' and
              (select count(*) from public.hub_context_targets t where t.owner_id=d.owner_id
                and t.context_id=d.context_id and t.active)=1 and exists (
                select 1 from public.hub_context_targets t where t.owner_id=d.owner_id
                  and t.context_id=d.context_id and t.entity_id=${entity.id} and t.active)))
            and not exists (select 1 from public.hub_deltas s where s.owner_id=d.owner_id
              and s.evidence_kind='user_report' and s.scope->>'supersedes'=d.id::text)
          order by d.recorded_at desc,d.id desc limit 1`)[0];
        if (legacy) {
          return {
            memory_commit: { id: legacy.id, version: legacy.version, replayed: true },
            context_id: legacy.context_id,
            target_entity_id: entity.id,
            event_type: a.event_type,
            evidence_kind: "user_report",
            external_submission: "not_verified",
            legacy_match: true,
          };
        }
      }
      if (!context) {
        const contexts = await tx`select distinct c.id from public.hub_context_targets t
          join public.hub_contexts c on c.owner_id=t.owner_id and c.id=t.context_id
          where t.owner_id=${p.ownerId} and t.active and (t.entity_id=${entity.id}
            or t.entity_id=${a.target_entity_id!})`;
        if (contexts.length > 1) {
          throw new HubError(
            "ambiguous_context",
            "Mais de um contexto está vinculado; indique o contexto atual.",
            409,
          );
        }
        if (contexts.length) {
          context = (await tx`select id,title,version from public.hub_contexts
            where owner_id=${p.ownerId} and id=${contexts[0].id} for update`)[0];
        } else {
          context = (await tx`insert into public.hub_contexts(owner_id,title,scope)
            values(${p.ownerId},${entity.title},${tx.json({ entity_id: entity.id })})
            returning id,title,version`)[0];
        }
      }
      if (a.expected_version !== undefined && context.version !== a.expected_version) {
        throw new HubError(
          "version_conflict",
          "Recupere a versão corrente antes de corrigir a evidência.",
          409,
        );
      }
      if (a.supersedes) {
        const previous = (await tx`select id from public.hub_deltas
          where owner_id=${p.ownerId} and id=${a.supersedes} and context_id=${context.id}
            and scope->>'entity_id'=${entity.id} and evidence_kind='user_report'
            and coalesce(scope->>'requirement_key','')=${a.requirement_key ?? ""}
            and (scope->>'academic_event'=${a.event_type}
              or (kind='submission_report' and ${a.event_type}='submission'))`)[0];
        const superseded = await tx`select id from public.hub_deltas where owner_id=${p.ownerId}
          and scope->>'supersedes'=${a.supersedes}`;
        if (!previous || superseded.length) {
          throw new HubError(
            "version_conflict",
            "O relato anterior não é a versão vigente desta atividade.",
            409,
          );
        }
      }
      await tx`insert into public.hub_context_targets(owner_id,context_id,entity_id)
        values(${p.ownerId},${context.id},${entity.id})
        on conflict(owner_id,context_id,entity_id) do update set active=true`;
      const scope: Record<string, string> = {
        entity_id: entity.id,
        academic_event: a.event_type,
        event_identity: eventIdentity,
        event_fingerprint: fingerprint,
        ...(a.requirement_key ? { requirement_key: a.requirement_key } : {}),
        ...(a.supersedes ? { supersedes: a.supersedes } : {}),
        ...(a.retract ? { retracted: "true" } : {}),
        ...(a.occurrence_key ? { occurrence_key: a.occurrence_key } : {}),
        ...(a.reported_distinct_colleagues !== undefined
          ? { reported_distinct_colleagues: String(a.reported_distinct_colleagues) }
          : {}),
      };
      const delta = {
        context_id: context.id,
        expected_version: context.version,
        idempotency_key: key,
        kind: a.supersedes
          ? "correction"
          : a.event_type === "submission"
          ? "submission_report"
          : "experience",
        content: a.content,
        evidence_kind: "user_report",
        scope,
        provenance: [{
          system: "user_report",
          locator: `hub:context:${context.id}`,
          ...(a.occurred_at ? { occurred_at: a.occurred_at } : {}),
          ...(a.original_date ? { original_date: a.original_date } : {}),
        }],
      };
      const receipt =
        (await tx`select public.hub_record_delta(${tx.json(delta)}) as receipt`)[0].receipt;
      return {
        memory_commit: receipt,
        context_id: context.id,
        target_entity_id: entity.id,
        event_type: a.event_type,
        evidence_kind: "user_report",
        external_submission: "not_verified",
      };
    });
  }
  async targets(p: Principal, contextId: string) {
    z.string().uuid().parse(contextId);
    return await asOwner(this.hub.db, p, async (tx) => {
      const context =
        (await tx`select id,title,version from public.hub_contexts where owner_id=${p.ownerId} and id=${contextId}`)[
          0
        ];
      if (!context) throw new HubError("not_found", "Contexto não encontrado.", 404);
      const targets =
        await tx`select e.id,e.title,e.kind,e.connection_id from public.hub_context_targets t join public.hub_entities e on e.owner_id=t.owner_id and e.id=t.entity_id where t.owner_id=${p.ownerId} and t.context_id=${contextId} and t.active order by e.title,e.id`;
      return {
        context,
        targets,
        resolution: targets.length === 1 ? "unique" : targets.length ? "ambiguous" : "unbound",
      };
    });
  }
  async bind(p: Principal, input: z.infer<typeof targetSchema>) {
    const a = targetSchema.parse(input);
    const ids = [...new Set(a.entity_ids)];
    return await asOwner(this.hub.db, p, async (tx) => {
      const context =
        (await tx`select id,version from public.hub_contexts where owner_id=${p.ownerId} and id=${a.context_id} for update`)[
          0
        ];
      if (!context) throw new HubError("not_found", "Contexto não encontrado.", 404);
      if (context.version !== a.expected_version) {
        throw new HubError("version_conflict", "Recupere a versão corrente do contexto.", 409);
      }
      if (ids.length) {
        const entities =
          await tx`select id,kind from public.hub_entities where owner_id=${p.ownerId} and id in ${
            tx(ids)
          }`;
        if (
          entities.length !== ids.length || entities.some((e) => !activityKinds.includes(e.kind))
        ) {
          throw new HubError("not_found", "Atividade não encontrada.", 404);
        }
      }
      await tx`update public.hub_context_targets set active=false where owner_id=${p.ownerId} and context_id=${a.context_id}`;
      for (const id of ids) {
        await tx`insert into public.hub_context_targets(owner_id,context_id,entity_id) values(${p.ownerId},${a.context_id},${id}) on conflict(owner_id,context_id,entity_id) do update set active=true,bound_at=now()`;
      }
      const updated =
        (await tx`update public.hub_contexts set version=version+1,updated_at=now() where owner_id=${p.ownerId} and id=${a.context_id} returning id,version`)[
          0
        ];
      return {
        context: updated,
        active_entity_ids: ids,
        resolution: ids.length === 1 ? "unique" : ids.length ? "ambiguous" : "unbound",
      };
    });
  }
  async reportSubmission(p: Principal, input: z.infer<typeof submissionReportSchema>) {
    const a = submissionReportSchema.parse(input);
    const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(a)));
    return await asOwner(this.hub.db, p, async (tx) => {
      const context =
        (await tx`select id,version from public.hub_contexts where owner_id=${p.ownerId} and id=${a.context_id} for update`)[
          0
        ];
      if (!context) throw new HubError("not_found", "Contexto não encontrado.", 404);
      const prior =
        (await tx`select id,context_id,kind,scope,version from public.hub_deltas where owner_id=${p.ownerId} and idempotency_key=${a.idempotency_key}`)[
          0
        ];
      if (prior) {
        if (
          prior.context_id !== a.context_id || prior.kind !== "submission_report" ||
          prior.scope.report_fingerprint !== fingerprint
        ) {
          throw new HubError("idempotency_conflict", "A chave já pertence a outro relato.", 409);
        }
        return {
          memory_commit: { id: prior.id, version: prior.version, replayed: true },
          target_entity_id: prior.scope.entity_id,
          evidence_kind: "user_report",
          actual_submission_time: null,
          external_submission: "not_verified",
        };
      }
      if (context.version !== a.expected_version) {
        throw new HubError("version_conflict", "Recupere a versão corrente do contexto.", 409);
      }
      const candidates =
        await tx`select entity_id from public.hub_context_targets where owner_id=${p.ownerId} and context_id=${a.context_id} and active`;
      let entityId = a.target_entity_id;
      if (entityId && !candidates.some((c) => c.entity_id === entityId)) {
        throw new HubError(
          "unbound_activity",
          "Vincule essa atividade ao contexto antes de registrar o relato.",
          409,
        );
      }
      if (!entityId) {
        if (candidates.length !== 1) {
          throw new HubError(
            "ambiguous_activity",
            candidates.length
              ? "Qual das atividades deste contexto você entregou?"
              : "Qual atividade você entregou? Vincule-a ao contexto.",
            409,
          );
        }
        entityId = candidates[0].entity_id as string;
      }
      const delta = {
        ...a,
        kind: "submission_report",
        evidence_kind: "user_report",
        scope: { entity_id: entityId, report_fingerprint: fingerprint },
        provenance: [{ system: "user_report", locator: `hub:context:${a.context_id}` }],
      };
      // The optional routing argument is represented by the resolved qualified target, not a free source claim.
      delete (delta as Record<string, unknown>).target_entity_id;
      const receipt =
        (await tx`select public.hub_record_delta(${tx.json(delta)}) as receipt`)[0].receipt;
      await tx`update public.hub_entities set state=state || ${
        tx.json({
          user_report: { reported: true, delta_id: receipt.id, actual_submission_time: null },
        })
      }::jsonb where owner_id=${p.ownerId} and id=${entityId}`;
      return {
        memory_commit: receipt,
        target_entity_id: entityId,
        evidence_kind: "user_report",
        actual_submission_time: null,
        external_submission: "not_verified",
      };
    });
  }
  async compareForumDraft(p: Principal, draftId: string, postId: string) {
    z.string().uuid().parse(draftId);
    z.string().uuid().parse(postId);
    return await asOwner(this.hub.db, p, async (tx) => {
      const draft =
        (await tx`select id,context_id,content,version from public.hub_deltas where owner_id=${p.ownerId} and id=${draftId} and kind='artifact'`)[
          0
        ];
      const post =
        (await tx`select e.id,e.kind,e.state,e.connection_id,c.provider_subject from public.hub_entities e join public.hub_connections c on c.owner_id=e.owner_id and c.id=e.connection_id where e.owner_id=${p.ownerId} and e.id=${postId} and c.provider='moodle'`)[
          0
        ];
      if (!draft || !post || !["forum_post", "post"].includes(post.kind)) {
        throw new HubError("not_found", "Versão ou publicação não encontrada.", 404);
      }
      const observations =
        await tx`select id,content,content_hash,provenance,observed_at,coverage from public.hub_observation_timeline where owner_id=${p.ownerId} and entity_id=${postId} order by observed_at desc,id desc limit 1`;
      if (!observations.length) return { state: "not_observed", matches_selected: false };
      const observation = observations[0], record = observation.content;
      const author = record.userid ?? record.author?.userid ?? record.author?.id;
      const message = record.message;
      // Only audited Moodle plaintext observations qualify, never a state field submitted by a model.
      if (
        observation.provenance.system !== "moodle" ||
        observation.provenance.connection_id !== post.connection_id ||
        observation.coverage !== "complete" ||
        typeof message !== "string" || !["string", "number"].includes(typeof author) ||
        !post.provider_subject
      ) {
        return { state: "evidence_incomplete", matches_selected: false };
      }
      return {
        ...comparePublishedText(draft.content, message, String(author) === post.provider_subject),
        selected_draft: { id: draft.id, version: draft.version, context_id: draft.context_id },
        published_observation: {
          id: observation.id,
          content_hash: observation.content_hash,
          observed_at: observation.observed_at,
          coverage: observation.coverage,
          connection_id: post.connection_id,
          entity_id: post.id,
        },
        content_is_untrusted_data: true,
      };
    });
  }
}

/** Conservative comparison. Whitespace normalization is stated; differences never prove another draft. */
export function comparePublishedText(selected: string, observed: string, authorMatches: boolean) {
  if (!authorMatches) return { state: "other_author", matches_selected: false };
  const normalize = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();
  return {
    state: normalize(selected) === normalize(observed)
      ? "matches_selected"
      : "differs_from_selected",
    matches_selected: normalize(selected) === normalize(observed),
    comparison: "NFC and whitespace only; no semantic equivalence inferred",
  };
}
