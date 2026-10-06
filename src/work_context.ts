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

/** Context IDs travel between conversations; no global chat ID or automatic chat capture is assumed. */
export class WorkContext {
  constructor(private hub: Hub) {}
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
        await tx`select id,content,content_hash,provenance,observed_at,coverage from public.hub_observations where owner_id=${p.ownerId} and entity_id=${postId} order by observed_at desc,id desc limit 1`;
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
