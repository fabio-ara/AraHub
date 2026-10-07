import { z } from "zod";
import type postgres from "postgres";
import { asOwner } from "./db.ts";
import type { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { normalizeTime } from "./time_context.ts";
import { sha256Hex } from "./migration.ts";

/**
 * Projeção de atenção e obrigações sobre as tabelas já existentes.
 *
 * Reutiliza entidades, observações, relações, alvos de contexto e deltas já
 * preservados; não cria esquema novo. Apresentado/lido são estados locais
 * gravados em hub_entities.state, nunca marca de leitura nem conclusão no
 * Moodle. O conteúdo recuperado é dado, não instrução.
 */

const OBLIGATION_KINDS = ["assignment", "forum", "discussion", "feedback", "module"] as const;
const FORUM_KINDS: readonly string[] = ["forum", "discussion"];
const DEADLINE_KINDS: readonly string[] = ["assignment", "module", "feedback"];
const DEADLINE_FIELDS = [
  "duedate",
  "cutoffdate",
  "allowsubmissionsfromdate",
  "gradingduedate",
] as const;
const DEADLINE_LABELS: Record<string, string> = {
  duedate: "prazo de entrega",
  cutoffdate: "limite aceito pela plataforma",
  allowsubmissionsfromdate: "abertura de envio",
  gradingduedate: "prazo de correção",
};
const DISPLAY_ZONES = ["Europe/Lisbon", "America/Sao_Paulo"];
const DEFAULT_HORIZON_DAYS = 7;
const ACCESS_LOST_STATES: readonly string[] = ["expired", "revoked", "denied"];
const REQUIREMENT_KIND = "academic_requirement";
const REQUIREMENT_RELATION = "states_requirement";
const REQUIREMENT_MAX_PER_SOURCE = 10;
const ACTION_RECEIPT_LIMIT = 200;

export const attentionFilterSchema = z.object({
  connection_id: z.string().uuid().optional(),
  context_id: z.string().uuid().optional(),
  offset: z.number().int().min(0).optional(),
}).strict();

export const markPresentedSchema = z.object({
  // Cada item exige o hash da versão mostrada: marcar só a entidade suporia que
  // a fonte não mudou entre a leitura da visão e o registro do apresentado.
  entities: z.array(
    z.object({
      entity_id: z.string().uuid(),
      content_hash: z.string().min(1).max(200),
    }).strict(),
  ).min(1).max(20),
}).strict();

export const acknowledgeReadSchema = z.object({
  entity_id: z.string().uuid(),
  content_hash: z.string().min(1).max(200),
}).strict();

export const recordRequirementSchema = z.object({
  source_entity_id: z.string().uuid(),
  // Chave curta e estável do enunciado, escolhida por quem interpreta. Não há
  // quantidade fixa: um fórum pode ter duas ou mais obrigações distintas.
  requirement_key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,60}$/),
  observation_id: z.string().uuid(),
  content_hash: z.string().min(1).max(200),
  excerpt: z.string().min(1).max(2000),
  action: z.string().min(1).max(500),
  quantity: z.object({
    kind: z.literal("colleagues_distinct"),
    at_least: z.number().int().min(1).max(200),
  }).strict().optional(),
  // Hora só existe se a fonte declarar; preserva-se o texto original e, quando
  // resolvível, a data. Hora ausente permanece ausente.
  deadline: z.object({
    original_text: z.string().min(1).max(500),
    date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).optional(),
  }).strict().optional(),
}).strict();

type Json = Record<string, unknown>;

interface DeadlineTime {
  original: unknown;
  kind: string;
  instant: string | null;
  reason?: string;
  displays?: Array<{ time_zone: string; local: string }>;
}

interface Deadline {
  field: string;
  label: string;
  original: unknown;
  observation_id: string | null;
  time: DeadlineTime;
}

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

function numericOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Correspondência qualificada de recibo acadêmico: mesma conexão e mesmos
 * course/cmid/instance do snapshot canônico. MoodleActions grava target textual
 * "course/cmid/instance", não localizador de URL, então a comparação usa o alvo
 * do snapshot. Discussão/parentesco só restringem quando ambos os lados os declaram.
 */
function receiptMatchesEntity(receipt: Json, connectionId: string, state: Json): boolean {
  if (String(receipt.connection_id ?? "") !== connectionId) return false;
  const course = numericOrNull(state.course_id);
  const cmid = numericOrNull(state.coursemodule ?? state.cmid);
  const instance = numericOrNull(state.instance_id);
  if (course === null || cmid === null || instance === null) return false;
  if (
    numericOrNull(receipt.course_id) !== course || numericOrNull(receipt.cmid) !== cmid ||
    numericOrNull(receipt.instance_id) !== instance
  ) return false;
  const discussion = numericOrNull(state.discussion_id);
  if (
    numericOrNull(receipt.discussion_id) !== null && discussion !== null &&
    numericOrNull(receipt.discussion_id) !== discussion
  ) return false;
  const parent = numericOrNull(state.post_id ?? state.parent_id);
  if (
    numericOrNull(receipt.parent_id) !== null && parent !== null &&
    numericOrNull(receipt.parent_id) !== parent
  ) return false;
  return true;
}

/** Segundos Unix positivos viram instante; zero/ausente/inválido nunca viram data. */
function epochInstant(raw: unknown): string | null {
  const seconds = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^[0-9]+$/.test(raw)
    ? Number(raw)
    : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) return null;
  return new Date(seconds * 1000).toISOString();
}

function requirementOf(kind: string, record: Json | null, observationId: string | null) {
  const action = kind === "assignment"
    ? "entrega"
    : kind === "forum" || kind === "discussion"
    ? "participacao"
    : kind === "feedback"
    ? "resposta"
    : "conferir_atividade";
  return {
    action,
    action_basis: "module_kind" as const,
    module_name: typeof record?.modname === "string" ? record.modname : null,
    object: typeof record?.name === "string"
      ? record.name
      : typeof record?.subject === "string"
      ? record.subject
      : null,
    observation_id: observationId,
  };
}

function deadlinesOf(kind: string, record: Json | null, observationId: string | null): Deadline[] {
  if (!DEADLINE_KINDS.includes(kind) || record === null) return [];
  const deadlines: Deadline[] = [];
  for (const field of DEADLINE_FIELDS) {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === 0 || raw === "0") continue;
    const instant = epochInstant(raw);
    deadlines.push({
      field,
      label: DEADLINE_LABELS[field],
      original: raw,
      observation_id: observationId,
      time: instant === null
        ? {
          original: raw,
          kind: "unresolved",
          instant: null,
          reason: "invalid_epoch_seconds",
        }
        : normalizeTime(
          { dateTime: instant, source_epoch_seconds: raw },
          DISPLAY_ZONES,
        ) as DeadlineTime,
    });
  }
  return deadlines;
}

export class Attention {
  constructor(private hub: Hub) {}

  /**
   * Colegas distintos em postagens preservadas, excluindo a conta vinculada.
   * O segundo contador só considera respostas da conta a post de outro autor.
   */
  private async colleagues(
    tx: postgres.TransactionSql,
    ownerId: string,
    entityId: string,
    subject: string | null,
  ) {
    if (subject === null || subject === "") return null;
    const rows = await tx`
      with target_posts as (
        select p.state as st
        from public.hub_relations r
        join public.hub_entities p on p.owner_id=r.owner_id and p.id=r.to_id and p.kind='post'
        where r.owner_id=${ownerId} and r.from_id=${entityId} and r.kind='has_post'
        union all
        select p.state as st
        from public.hub_relations rd
        join public.hub_entities d on d.owner_id=rd.owner_id and d.id=rd.to_id and d.kind='discussion'
        join public.hub_relations rp on rp.owner_id=d.owner_id and rp.from_id=d.id and rp.kind='has_post'
        join public.hub_entities p on p.owner_id=rp.owner_id and p.id=rp.to_id and p.kind='post'
        where rd.owner_id=${ownerId} and rd.from_id=${entityId} and rd.kind='has_discussion'
      )
      select
        (select count(distinct st->>'author_userid') from target_posts
          where st->>'author_userid' is not null and st->>'author_userid' <> '0'
            and st->>'author_userid' <> ${subject})::int as distinct_colleagues,
        (select count(*) from target_posts)::int as observed_posts,
        (select count(*) from target_posts where st->>'author_userid' = ${subject})::int as owner_posts,
        (select count(distinct q.st->>'author_userid')
          from target_posts o
          join target_posts q on q.st->>'discussion_id' = o.st->>'discussion_id'
            and q.st->>'post_id' = o.st->>'parent'
          where o.st->>'author_userid' = ${subject} and coalesce(o.st->>'parent','0') <> '0'
            and q.st->>'author_userid' is not null
            and q.st->>'author_userid' <> ${subject})::int as colleagues_answered`;
    const row = rows[0];
    return {
      subject_userid: subject,
      distinct_colleagues: Number(row?.distinct_colleagues ?? 0),
      colleagues_answered_by_owner: Number(row?.colleagues_answered ?? 0),
      observed_posts: Number(row?.observed_posts ?? 0),
      owner_posts: Number(row?.owner_posts ?? 0),
      basis: "preserved_discussion_posts",
      note:
        "Colegas contados por autor distinto nas postagens preservadas; não mede participação atual, exigência do enunciado nem leitura.",
    };
  }

  /** Rascunhos ligados à atividade por escopo direto ou por alvo de contexto ativo. */
  private async drafts(tx: postgres.TransactionSql, ownerId: string, entityId: string) {
    const rows = await tx`
      select d.id,d.version,d.recorded_at
      from public.hub_deltas d
      where d.owner_id=${ownerId} and d.kind='artifact'
        and (d.scope->>'entity_id'=${entityId} or exists (
          select 1 from public.hub_context_targets t
          where t.owner_id=d.owner_id and t.context_id=d.context_id
            and t.entity_id=${entityId} and t.active))
      order by d.recorded_at desc,d.id limit 5`;
    return rows;
  }

  /** Estado nativo de conclusão relacionado ao módulo; nunca é leitura humana. */
  private async completionTracker(
    tx: postgres.TransactionSql,
    ownerId: string,
    entityId: string,
  ) {
    const rows = await tx`
      select ca.state
      from public.hub_relations r
      join public.hub_entities ca on ca.owner_id=r.owner_id and ca.id=r.to_id
        and ca.kind='completion_activity'
      where r.owner_id=${ownerId} and r.from_id=${entityId} and r.kind='tracks_completion'
      order by ca.id limit 1`;
    const rawState = rows[0]?.state;
    if (rawState === undefined || rawState === null) return null;
    const record = object(rawState);
    return {
      state: record.state ?? null,
      timecompleted: record.timecompleted ?? null,
      basis: "moodle_completion_tracker",
    };
  }

  /** Obrigações explícitas interpretadas a partir da fonte, com trecho e versões. */
  private async requirementsFor(
    tx: postgres.TransactionSql,
    ownerId: string,
    sourceEntityId: string,
  ) {
    const rows = await tx`
      select r.id,r.external_id,r.state,
        o.observation_id,o.content_hash,o.observed_at,o.provenance,o.content,
        (select count(*)::int from public.hub_observation_timeline v
          where v.owner_id=r.owner_id and v.entity_id=r.id) as versions
      from public.hub_relations rel
      join public.hub_entities r on r.owner_id=rel.owner_id and r.id=rel.to_id
        and r.kind=${REQUIREMENT_KIND}
      left join lateral (
        select id as observation_id,content_id,content,content_hash,observed_at,provenance
        from public.hub_observation_timeline
        where owner_id=r.owner_id and entity_id=r.id
        order by observed_at desc,id desc limit 1) o on true
      where rel.owner_id=${ownerId} and rel.from_id=${sourceEntityId}
        and rel.kind=${REQUIREMENT_RELATION}
      order by r.external_id limit ${REQUIREMENT_MAX_PER_SOURCE}`;
    return rows.map((row) => {
      const externalId = String(row.external_id ?? "");
      const key = externalId.slice(externalId.lastIndexOf("/") + 1);
      const payload = row.content === undefined || row.content === null
        ? object(row.state)
        : object(row.content);
      const provenance = object(row.provenance);
      const quantity = payload.quantity === undefined ? null : object(payload.quantity);
      const deadline = payload.deadline === undefined ? null : object(payload.deadline);
      return {
        requirement_entity_id: String(row.id),
        requirement_observation_id: row.observation_id ?? null,
        requirement_key: key,
        action: typeof payload.action === "string" ? payload.action : null,
        quantity: quantity === null
          ? null
          : { kind: quantity.kind ?? null, at_least: quantity.at_least ?? null },
        deadline: deadline === null
          ? null
          : {
            original_text: deadline.original_text ?? null,
            date: deadline.date ?? null,
            // Hora ausente permanece ausente: não há campo de hora na afirmação.
            hour_known: false,
          },
        source: {
          observation_id: provenance.source_observation_id ?? null,
          content_hash: provenance.source_content_hash ?? null,
          excerpt: provenance.excerpt ?? null,
          interpretation: provenance.interpretation ?? null,
          interpreted_at: provenance.interpreted_at ?? null,
        },
        observed_at: row.observed_at ?? null,
        content_hash: row.content_hash ?? null,
        versions: Number(row.versions ?? 0),
      };
    });
  }

  /** Recibos confirmados de ação acadêmica, com o alvo canônico do snapshot. */
  private async confirmedActions(
    tx: postgres.TransactionSql,
    ownerId: string,
  ): Promise<Json[]> {
    const rows = await tx`
      select id,connection_id,operation,target,snapshot,external_id,updated_at
      from public.hub_actions
      where owner_id=${ownerId} and state='succeeded'
      order by updated_at desc limit ${ACTION_RECEIPT_LIMIT}`;
    const receipts: Json[] = [];
    for (const row of rows) {
      let envelope: Json = {};
      try {
        envelope = object(JSON.parse(String(row.snapshot ?? "")));
      } catch {
        envelope = {};
      }
      const target = object(object(envelope.content).target);
      receipts.push({
        action_id: String(row.id),
        connection_id: String(row.connection_id ?? envelope.connectionId ?? ""),
        operation: String(row.operation ?? envelope.operation ?? ""),
        target: String(row.target ?? envelope.target ?? ""),
        external_id: row.external_id ?? null,
        updated_at: row.updated_at ?? null,
        course_id: numericOrNull(target.course_id),
        cmid: numericOrNull(target.cmid),
        instance_id: numericOrNull(target.instance_id),
        discussion_id: numericOrNull(target.discussion_id),
        parent_id: numericOrNull(target.parent_id),
      });
    }
    return receipts;
  }

  /** Visão de obrigações e de mudanças relevantes; não atualiza a fonte nem agenda nada. */
  async overview(
    p: Principal,
    input: z.input<typeof attentionFilterSchema>,
    options: { now?: string } = {},
  ) {
    const a = attentionFilterSchema.parse(input);
    const offset = a.offset ?? 0;
    const nowMs = options.now === undefined ? Date.now() : Date.parse(options.now);
    if (!Number.isFinite(nowMs)) {
      throw new HubError("invalid_time", "Instante de referência inválido.");
    }
    const horizonMs = DEFAULT_HORIZON_DAYS * 86400000;
    return await asOwner(this.hub.db, p, async (tx) => {
      const rows = await tx`
        select e.id,e.kind,e.title,e.external_id,e.connection_id,e.state,
          c.provider,c.state as connection_state,c.provider_subject,
          o.observation_id,o.content_hash,o.coverage,o.observed_at,o.content,o.provenance,o.matches_current
        from public.hub_entities e
        join public.hub_connections c on c.owner_id=e.owner_id and c.id=e.connection_id
        left join lateral (
          select id as observation_id,content_id,content,content_hash,coverage,observed_at,provenance,
            (e.state->'provider_record' = content) as matches_current
          from public.hub_observation_timeline
          where owner_id=e.owner_id and entity_id=e.id
          order by observed_at desc,id desc limit 1) o on true
        where e.owner_id=${p.ownerId} and e.kind in ${tx(OBLIGATION_KINDS)}
          and (${a.connection_id ?? null}::uuid is null or e.connection_id=${a.connection_id ?? null}::uuid)
          and (${a.context_id ?? null}::uuid is null or exists (
            select 1 from public.hub_context_targets t
            where t.owner_id=e.owner_id and t.context_id=${a.context_id ?? null}::uuid
              and t.entity_id=e.id and t.active))
        order by e.title,e.id limit 21 offset ${offset}`;
      const page = rows.slice(0, 20);
      const obligations: unknown[] = [];
      const attention: unknown[] = [];
      const receipts = await this.confirmedActions(tx, p.ownerId);
      for (const row of page) {
        const entityId = String(row.id);
        const kind = String(row.kind);
        const externalId = String(row.external_id ?? "");
        const connectionId = String(row.connection_id ?? "");
        const contentId = row.content_id ?? null;
        const state = object(row.state);
        const providerRecord = state.provider_record === undefined
          ? null
          : object(state.provider_record);
        const observationId = row.observation_id === null || row.observation_id === undefined
          ? null
          : String(row.observation_id);
        const observed = observationId === null ? null : object(row.content);
        const drift = row.matches_current === false;
        const record = drift ? (providerRecord ?? observed) : (observed ?? providerRecord);
        const basis = observationId === null
          ? (providerRecord ? "unverified_state_projection" : "no_content")
          : drift
          ? "current_state_with_unrecorded_reobservation"
          : "preserved_observation";
        const gaps: string[] = [];
        if (basis === "unverified_state_projection") {
          gaps.push(
            "Sem observação preservada; a projeção do estado não foi verificada contra a fonte.",
          );
        }
        if (drift) {
          gaps.push(
            "A fonte mudou sem ocorrência de observação correspondente; a projeção usa o estado vigente e não afirma a data da mudança.",
          );
        }
        const deadlines = deadlinesOf(kind, record, observationId);
        const subject = typeof row.provider_subject === "string" ? row.provider_subject : null;
        const colleagues = FORUM_KINDS.includes(kind)
          ? await this.colleagues(tx, p.ownerId, entityId, subject)
          : null;
        if (FORUM_KINDS.includes(kind) && colleagues === null) {
          gaps.push(
            "Conta vinculada sem identificador de usuário Moodle na conexão; a contagem de colegas não pode excluir as postagens do próprio titular.",
          );
        }
        const requirements = await this.requirementsFor(tx, p.ownerId, entityId);
        if (!deadlines.length && !requirements.length) {
          gaps.push(
            "Nenhum prazo de campo preservado e nenhuma obrigação interpretada; prazo em prosa exige recordRequirement com trecho, não regex.",
          );
        }
        const requirementDeadlines = requirements.filter((r) => r.deadline !== null);
        const instants = deadlines
          .map((d) => d.time.instant)
          .filter((value): value is string => typeof value === "string")
          .map((value) => Date.parse(value));
        const overdue = instants.filter((ms) => ms < nowMs).length;
        const upcoming = instants.filter((ms) => ms >= nowMs).sort((x, y) => x - y);
        const nearest = upcoming.length ? new Date(upcoming[0]).toISOString() : null;
        const near = nearest !== null && Date.parse(nearest) - nowMs <= horizonMs
          ? nearest
          : null;
        const userReport = state.user_report === undefined ? null : object(state.user_report);
        const presented = state.attention_presented === undefined
          ? null
          : object(state.attention_presented);
        const read = state.attention_read === undefined ? null : object(state.attention_read);
        const contentHash = row.content_hash === null || row.content_hash === undefined
          ? null
          : String(row.content_hash);
        const coverage = row.coverage === null || row.coverage === undefined
          ? null
          : String(row.coverage);
        const connectionState = String(row.connection_state ?? "");
        const drafts = await this.drafts(tx, p.ownerId, entityId);
        const tracker = await this.completionTracker(tx, p.ownerId, entityId);
        const nativeCompletion = state.completion === undefined ? null : state.completion;
        const academicActions = receipts.filter((receipt) =>
          receiptMatchesEntity(receipt, connectionId, state)
        );
        // Evidência de entrega: relato do titular ou recibo confirmado de ação
        // acadêmica. Conclusão nativa do Moodle é sinal separado e não substitui.
        const submissionEvidence = {
          user_report: userReport !== null,
          confirmed_academic_action: academicActions.length > 0,
          native_completion: nativeCompletion === true || tracker?.state === 1 ||
            tracker?.state === 2,
        };
        const submissionEvidencePresent = submissionEvidence.user_report ||
          submissionEvidence.confirmed_academic_action;
        const item = (itemKind: string, detail: string) => {
          attention.push({
            entity_id: entityId,
            kind: itemKind,
            detail,
            observation_id: observationId,
            content_id: contentId,
            content_hash: contentHash,
          });
        };
        if (presented === null) {
          item("not_presented", "Fonte preservada ainda não registrada como apresentada ao titular.");
        } else if (contentHash !== null && presented.content_hash !== contentHash) {
          item("changed_since_presented", "A fonte mudou depois de ter sido apresentada.");
        }
        if (read !== null && contentHash !== null && read.content_hash !== contentHash) {
          item("changed_since_read", "A fonte mudou depois da leitura confirmada pelo titular.");
        }
        if (ACCESS_LOST_STATES.includes(connectionState)) {
          item("access_lost", "A conexão da fonte não está ativa; a memória preservada continua consultável.");
        }
        if (coverage !== null && coverage !== "complete") {
          item("incomplete_coverage", "A última observação não tem cobertura completa.");
        }
        if (near !== null) {
          item(
            "deadline_near",
            "Há prazo preservado dentro da janela de atenção de " + DEFAULT_HORIZON_DAYS + " dias.",
          );
        }
        if (FORUM_KINDS.includes(kind) && requirements.length === 0) {
          item(
            "requirement_not_interpreted",
            "Fórum sem obrigação interpretada registrada; o enunciado em prosa exige recordRequirement com trecho.",
          );
        }
        if (kind === "assignment" && !submissionEvidencePresent) {
          item(
            "submission_evidence_missing",
            "Sem relato do titular nem recibo confirmado de ação acadêmica; evidência de entrega ainda ausente.",
          );
        }
        if (drift) {
          item("unrecorded_reobservation", "A fonte reverteu ou mudou depois da última ocorrência registrada.");
        }
        obligations.push({
          entity: {
            id: entityId,
            kind,
            title: String(row.title ?? ""),
            external_id: externalId,
            provider: String(row.provider ?? ""),
            connection_state: connectionState,
          },
          requirement: requirementOf(kind, record, observationId),
          // Prazos da fonte e afirmações interpretadas ficam em coleções próprias:
          // uma coluna due_date não representa duas obrigações distintas.
          deadlines,
          requirement_deadlines: requirementDeadlines,
          deadline_summary: { overdue, upcoming: upcoming.length, nearest, within_horizon: near },
          requirements,
          colleagues,
          colleague_requirements: requirements
            .filter((r) => r.quantity !== null && r.quantity.kind === "colleagues_distinct")
            .map((r) => ({
              requirement_key: r.requirement_key,
              required_at_least: r.quantity!.at_least,
              observed_distinct_colleagues: colleagues?.distinct_colleagues ?? null,
              // Comparação numérica explícita; não declara qualidade acadêmica.
              observed_meets_at_least: colleagues === null
                ? null
                : Number(colleagues.distinct_colleagues) >= Number(r.quantity!.at_least),
            })),
          provenance: {
            observation_id: observationId,
            content_id: contentId,
            content_hash: contentHash,
            coverage,
            observed_at: row.observed_at ?? null,
            recorded_provenance: row.provenance ?? null,
          },
          state: {
            native_platform: {
              entity_completion: nativeCompletion,
              tracker,
              note:
                "Estado nativo do Moodle; não prova leitura humana e não é alterado por esta projeção.",
            },
            user_report: userReport,
            academic_actions: academicActions,
            submission_evidence: submissionEvidence,
            drafts,
            presented,
            read,
          },
          basis,
          gaps,
        });
      }
      return {
        scope: {
          connection_id: a.connection_id ?? null,
          context_id: a.context_id ?? null,
          obligation_kinds: OBLIGATION_KINDS,
        },
        obligations,
        attention,
        page: { offset, limit: 20, next_offset: rows.length > 20 ? offset + 20 : null },
        next_offset: rows.length > 20 ? offset + 20 : null,
        horizon_days: DEFAULT_HORIZON_DAYS,
        reference_instant: new Date(nowMs).toISOString(),
        content_is_untrusted_data: true,
        limitations: [
          "Apresentado e lido são estados locais do AraHub; nenhum marca leitura ou conclusão no Moodle.",
          "Obrigações interpretadas entram por recordRequirement com trecho e observação de origem; não há regex nem quantidade fixa de obrigações.",
          "Hora ausente na fonte permanece ausente; afirmação de prazo sem data não vira instante.",
          "A quantidade de colegas conta autores distintos preservados e é comparada numericamente, sem declarar qualidade ou conclusão.",
          "Recibo de ação acadêmica só conta quando o alvo preservado casa exatamente com o localizador da obrigação e o estado é succeeded.",
          "A projeção não atualiza a fonte, não agenda execução e não envia notificação.",
        ],
      };
    });
  }

  /**
   * Registra uma obrigação explícita interpretada do enunciado, com trecho e
   * observação de origem. Versiona como observação da entidade academic_requirement
   * e relaciona a fonte; repetir o mesmo conteúdo é idempotente.
   */
  async recordRequirement(p: Principal, input: z.input<typeof recordRequirementSchema>) {
    const a = recordRequirementSchema.parse(input);
    return await asOwner(this.hub.db, p, async (tx) => {
      const source =
        (await tx`select id,connection_id,kind,external_id from public.hub_entities
          where owner_id=${p.ownerId} and id=${a.source_entity_id}`)[0];
      if (!source) throw new HubError("not_found", "Fonte não encontrada.", 404);
      if (String(source.kind) === REQUIREMENT_KIND) {
        throw new HubError("invalid_request", "A fonte deve ser um recurso, não uma obrigação.", 400);
      }
      const observation = (await tx`select id,content_id,content_hash,coverage
        from public.hub_observation_timeline
        where owner_id=${p.ownerId} and entity_id=${a.source_entity_id}
          and id=${a.observation_id}`)[0];
      if (!observation) {
        throw new HubError("not_found", "Observação de origem não encontrada nessa fonte.", 404);
      }
      if (String(observation.content_hash) !== a.content_hash) {
        throw new HubError(
          "version_conflict",
          "A observação de origem mudou; interprete a versão corrente e preserve o trecho.",
          409,
        );
      }
      const payload = {
        action: a.action,
        ...(a.quantity === undefined ? {} : { quantity: a.quantity }),
        ...(a.deadline === undefined ? {} : { deadline: a.deadline }),
      };
      const payloadHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
      const externalId = "hub:requirement:" + a.source_entity_id + "/" + a.requirement_key;
      const requirement = (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
        values(${p.ownerId},${source.connection_id},${REQUIREMENT_KIND},${externalId},${a.action.slice(0, 300)},${tx.json(payload as postgres.JSONValue)})
        on conflict(owner_id,connection_id,kind,external_id)
          do update set title=excluded.title,state=hub_entities.state || excluded.state
        returning id`)[0];
      const requirementId = String(requirement.id);
      const observedAt = new Date().toISOString();
      const provenance = {
        system: "interpretation",
        locator: "hub:entity:" + a.source_entity_id,
        source_observation_id: a.observation_id,
        source_content_id: observation.content_id ?? null,
        source_content_hash: a.content_hash,
        excerpt: a.excerpt,
        interpretation: "model_reported",
        interpreted_at: observedAt,
        observed_at: observedAt,
      };
      const prior = (await tx`select id,observed_at from public.hub_observations
        where owner_id=${p.ownerId} and entity_id=${requirementId}
          and content_hash=${payloadHash}`)[0] ?? null;
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
        values(${p.ownerId},${requirementId},${tx.json(payload as postgres.JSONValue)},${payloadHash},${tx.json(provenance as postgres.JSONValue)},${observation.coverage},${observedAt})
        on conflict(owner_id,entity_id,content_hash) do nothing`;
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
        values(${p.ownerId},${a.source_entity_id},${requirementId},${REQUIREMENT_RELATION},${tx.json(provenance as postgres.JSONValue)})
        on conflict(owner_id,from_id,to_id,kind) do nothing`;
      return {
        requirement_entity_id: requirementId,
        requirement_key: a.requirement_key,
        external_id: externalId,
        source: {
          entity_id: a.source_entity_id,
          observation_id: a.observation_id,
          content_id: observation.content_id ?? null,
          content_hash: a.content_hash,
          excerpt: a.excerpt,
        },
        payload_hash: payloadHash,
        replayed: prior !== null,
        observed_at: prior?.observed_at ?? observedAt,
        interpretation: "model_reported",
        moodle_write: false,
        source_writes: false,
      };
    });
  }

  /** Marca o que o assistente apresentou. Nunca marca leitura ou conclusão no Moodle. */
  markPresented(p: Principal, input: z.input<typeof markPresentedSchema>) {
    const a = markPresentedSchema.parse(input);
    const seen = new Set<string>();
    return asOwner(this.hub.db, p, async (tx) => {
      const presented: unknown[] = [];
      for (const entry of a.entities) {
        if (seen.has(entry.entity_id)) {
          throw new HubError("invalid_request", "Entidade repetida no lote.", 400);
        }
        seen.add(entry.entity_id);
        // Seria a entidade: observação concorrente não entra entre a conferência
        // do hash e a gravação do que foi efetivamente apresentado.
        const entity =
          (await tx`select id from public.hub_entities where owner_id=${p.ownerId} and id=${entry.entity_id} for update`)[0];
        if (!entity) throw new HubError("not_found", "Registro não encontrado.", 404);
        const observation = (await tx`select id,content_id,content_hash,coverage,observed_at
          from public.hub_observation_timeline where owner_id=${p.ownerId} and entity_id=${entry.entity_id}
          order by observed_at desc,id desc limit 1`)[0] ?? null;
        if (!observation) {
          throw new HubError(
            "not_found",
            "Sem observação preservada para registrar apresentação.",
            404,
          );
        }
        if (observation.content_hash !== entry.content_hash) {
          throw new HubError(
            "version_conflict",
            "A fonte mudou desde o conteúdo apresentado; recupere a versão atual antes de registrar.",
            409,
          );
        }
        const mark = {
          observation_id: observation.id,
          content_id: observation.content_id ?? null,
          content_hash: entry.content_hash,
          coverage: observation.coverage,
          observed_at: observation.observed_at,
          presented_at: new Date().toISOString(),
        };
        const updated = (await tx`update public.hub_entities
          set state=state || ${tx.json({ attention_presented: mark })}::jsonb
          where owner_id=${p.ownerId} and id=${entry.entity_id}
          returning state->'attention_presented' as presented`)[0];
        presented.push({ entity_id: entry.entity_id, presented: updated?.presented ?? null });
      }
      return {
        presented,
        note:
          "Apresentado é registro local; não prova leitura humana, não marca lido no Moodle e não suprime novidade posterior.",
        moodle_mark: false,
        source_writes: false,
      };
    });
  }

  /** Confirma leitura humana da versão efetivamente mostrada; não é marca de leitura no Moodle. */
  acknowledgeRead(p: Principal, input: z.input<typeof acknowledgeReadSchema>) {
    const a = acknowledgeReadSchema.parse(input);
    return asOwner(this.hub.db, p, async (tx) => {
      const entity =
        (await tx`select id from public.hub_entities where owner_id=${p.ownerId} and id=${a.entity_id}`)[0];
      if (!entity) throw new HubError("not_found", "Registro não encontrado.", 404);
      const observation = (await tx`select content_id,content_hash,observed_at
        from public.hub_observation_timeline where owner_id=${p.ownerId} and entity_id=${a.entity_id}
        order by observed_at desc,id desc limit 1`)[0] ?? null;
      if (!observation) {
        throw new HubError("not_found", "Sem observação preservada para confirmar leitura.", 404);
      }
      if (observation.content_hash !== a.content_hash) {
        throw new HubError(
          "version_conflict",
          "A fonte mudou desde o conteúdo lido; recupere a versão atual antes de confirmar.",
          409,
        );
      }
      const mark = {
        content_id: observation.content_id ?? null,
        content_hash: a.content_hash,
        observed_at: observation.observed_at,
        acknowledged_at: new Date().toISOString(),
      };
      await tx`update public.hub_entities
        set state=state || ${tx.json({ attention_read: mark })}::jsonb
        where owner_id=${p.ownerId} and id=${a.entity_id}`;
      return {
        entity_id: a.entity_id,
        read: mark,
        note: "Leitura confirmada pelo titular no AraHub; não é marca de leitura no Moodle.",
        moodle_mark: false,
        source_writes: false,
      };
    });
  }
}
