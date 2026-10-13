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
const DRAFT_LIMIT = 5;
const MATERIAL_REFERENCE_LIMIT = 20;
// Módulos de material/estrutura não são obrigações acionáveis; um módulo cujo
// conteúdo concreto já é projetado por conta própria não vira obrigação
// duplicada (module -> has_content, comparado por IDs).
const NON_ACTIONABLE_MODNAMES: readonly string[] = [
  "resource",
  "url",
  "page",
  "book",
  "folder",
  "label",
  "file",
  "imscp",
];
const MODULE_CONCRETE_CHILD_KINDS: readonly string[] = [
  "assignment",
  "forum",
  "feedback",
  "resource",
  "url",
  "page",
  "book",
  "folder",
  "label",
];
// Como a obrigação interpretada se cumpre. Ausente, deriva do tipo da fonte e da
// quantidade: `colleagues_distinct` implica forum_reply.
const FULFILLMENT_KINDS = [
  "submission",
  "forum_topic",
  "forum_reply",
  "completion",
  "manual",
] as const;
const FORUM_RECEIPT_LIMIT = 20;
// Statuses nativos que afirmam não haver entrega concluída; nunca apagam relato.
const NATIVE_STATUS_NOT_SUBMITTED: readonly string[] = ["new", "draft", "reopened"];

export const attentionFilterSchema = z.object({
  connection_id: z.string().uuid().optional(),
  context_id: z.string().uuid().optional(),
  offset: z.number().int().min(0).optional(),
  // `summary` projeta resultado/exceção (pendente/concluído/incerto) sem
  // inventário extenso; `audit` mantém a visão completa para uso interno.
  view: z.enum(["summary", "audit"]).optional(),
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
  // Como a obrigação se cumpre. Ausente: derivado do tipo da fonte e da quantidade.
  fulfillment: z.enum(FULFILLMENT_KINDS).optional(),
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

/** Relato do titular preservado como delta, vinculado a um alvo qualificado. */
interface AcademicEvent {
  delta_id: string;
  context_id: string;
  kind: string;
  event_type: string | null;
  requirement_key: string | null;
  content: string;
  recorded_at: unknown;
  occurred_at: unknown;
  original_date: unknown;
  reported_distinct_colleagues: number | null;
  entity_id: string | null;
  binding: string;
}

interface ForumEvidence {
  subject_userid: string;
  distinct_colleagues: number;
  colleagues_answered_by_owner: number;
  observed_posts: number;
  owner_posts: number;
  publications: Json[];
  replies: Json[];
  publications_truncated: boolean;
  replies_truncated: boolean;
  basis: string;
  note: string;
}

interface EntityAssessment {
  status: "concluded" | "pending" | "uncertain";
  reasons: string[];
}

function requirementFulfillment(kind: string, payload: Json): string {
  const declared = typeof payload.fulfillment === "string" ? payload.fulfillment : null;
  if (declared !== null && (FULFILLMENT_KINDS as readonly string[]).includes(declared)) {
    return declared;
  }
  const quantity = payload.quantity === undefined ? null : object(payload.quantity);
  if (quantity !== null && quantity.kind === "colleagues_distinct") return "forum_reply";
  if (kind === "assignment") return "submission";
  return "manual";
}

function receipt(basis: string, fields: Json): Json {
  return { basis, ...fields };
}

interface AssessmentEvidence {
  events: AcademicEvent[];
  legacyUserReport: boolean;
  receipts: Json[];
  ownStatus: Json | null;
  forum: ForumEvidence | null;
  nativeCompletion: boolean;
}

/**
 * Avalia cada obrigação interpretada contra as evidências preservadas.
 * Relato e observação contraditória permanecem separados; cobertura parcial não
 * apaga prova positiva; conclusão nativa nunca vira entrega.
 */
function assessRequirements(requirements: Json[], evidence: AssessmentEvidence): Json[] {
  const familyCounts = new Map<string, number>();
  for (const requirement of requirements) {
    const fulfillment = String(requirement.fulfillment ?? "manual");
    familyCounts.set(fulfillment, (familyCounts.get(fulfillment) ?? 0) + 1);
  }
  return requirements.map((requirement) => {
    const key = String(requirement.requirement_key ?? "");
    const fulfillment = String(requirement.fulfillment ?? "manual");
    const quantity = requirement.quantity === null || requirement.quantity === undefined
      ? null
      : object(requirement.quantity);
    // Relato sem chave só vale quando há uma única obrigação dessa família na
    // atividade; caso contrário não se adivinha qual obrigação ele cumpre.
    const ambiguousKeyless = (familyCounts.get(fulfillment) ?? 0) > 1;
    const matches = (types: readonly string[]) =>
      evidence.events.filter((event) =>
        event.event_type !== null && types.includes(event.event_type) &&
        (event.requirement_key === key ||
          (event.requirement_key === null && !ambiguousKeyless))
      );
    const reportReceipts = (events: AcademicEvent[]) =>
      events.map((event) =>
        receipt("user_report_delta", {
          delta_id: event.delta_id,
          context_id: event.context_id,
          event_type: event.event_type,
          requirement_key: event.requirement_key ?? null,
          binding: event.binding,
          recorded_at: event.recorded_at ?? null,
          occurred_at: event.occurred_at ?? null,
          original_date: event.original_date ?? null,
          reported_distinct_colleagues: event.reported_distinct_colleagues,
        })
      );
    const partialProof = (items: Json[]) =>
      items.some((item) =>
          item.coverage !== undefined && item.coverage !== null &&
          item.coverage !== "complete"
        )
        ? ["positive_proof_from_partial_coverage"]
        : [];
    const empty = (state: string, reasons: string[] = [], list: Json[] = []) => ({
      requirement_key: key,
      fulfillment,
      state,
      reasons: [...reasons, ...partialProof(list)],
      evidence: list,
    });

    if (fulfillment === "submission") {
      const reports = matches(["submission"]);
      const list = [...reportReceipts(reports)];
      const actions = evidence.receipts.filter((r) => r.operation === "moodle.assignment.submit");
      const reported = reports.length > 0 || (evidence.legacyUserReport && !ambiguousKeyless);
      if (evidence.legacyUserReport && !ambiguousKeyless && reports.length === 0) {
        list.push(receipt("legacy_state_user_report", { reported: true }));
      }
      for (const action of actions) {
        list.push(receipt("confirmed_academic_action", action));
      }
      const ownStatus = evidence.ownStatus;
      const native = ownStatus !== null && ownStatus.qualified === true &&
          typeof ownStatus.status === "string"
        ? String(ownStatus.status)
        : null;
      if (
        ownStatus !== null && ownStatus.observation !== null && ownStatus.observation !== undefined
      ) {
        list.push(receipt("own_submission_status", {
          status_entity_id: ownStatus.status_entity_id,
          qualified: ownStatus.qualified,
          qualification_reasons: ownStatus.reasons ?? [],
          status: ownStatus.status ?? null,
          observation: ownStatus.observation,
        }));
      }
      const nativeNegative = native !== null && NATIVE_STATUS_NOT_SUBMITTED.includes(native);
      if ((reported || actions.length > 0) && nativeNegative) {
        return {
          ...empty("uncertain", [
            reported
              ? "user_report_contradicts_native_status"
              : "receipt_contradicts_native_status",
          ], list),
          reconciliation: "keep_report_and_native_observation_separate",
        };
      }
      if (ambiguousKeyless && !reported) {
        return empty("uncertain", ["multiple_obligations_require_specific_evidence"], list);
      }
      if (reported || actions.length > 0 || native === "submitted") {
        return empty("satisfied", [], list);
      }
      if (nativeNegative) {
        return empty("pending", ["native_status_reports_not_submitted"], list);
      }
      return empty("pending", [], list);
    }

    if (fulfillment === "forum_topic") {
      const reports = matches(["forum_topic"]);
      const publications = [
        ...evidence.forum?.publications ?? [],
        ...evidence.receipts.filter((r) => r.operation === "moodle.forum.discussion"),
      ];
      const list = [...reportReceipts(reports), ...publications];
      if (ambiguousKeyless && !reports.length) {
        return empty("uncertain", ["multiple_obligations_require_specific_evidence"], list);
      }
      if (publications.length > 0 || reports.length > 0) return empty("satisfied", [], list);
      if (evidence.forum === null) {
        return empty("uncertain", ["connection_subject_unknown"], list);
      }
      return empty("pending", ["no_preserved_owner_publication"], list);
    }

    if (fulfillment === "forum_reply") {
      const reports = matches(["forum_reply"]);
      const replies = evidence.forum?.replies ?? [];
      const list = [...reportReceipts(reports), ...replies];
      const atLeast = quantity !== null && Number.isFinite(Number(quantity.at_least))
        ? Number(quantity.at_least)
        : 1;
      const answered = evidence.forum?.colleagues_answered_by_owner ?? 0;
      const reported = Math.max(0, ...reports.map((r) => r.reported_distinct_colleagues ?? 1));
      if (ambiguousKeyless && reported < atLeast) {
        return empty("uncertain", ["multiple_obligations_require_specific_evidence"], list);
      }
      if (answered >= atLeast || reported >= atLeast) return empty("satisfied", [], list);
      if (evidence.forum === null) {
        return empty("uncertain", ["connection_subject_unknown"], list);
      }
      return {
        ...empty("pending", ["distinct_colleagues_below_required"], list),
        required_at_least: atLeast,
        observed_distinct_colleagues: answered,
      };
    }

    if (fulfillment === "completion") {
      const reports = matches(["completion"]);
      const list = [...reportReceipts(reports)];
      if (evidence.nativeCompletion) {
        list.push(receipt("native_completion", { value: true }));
      }
      if (ambiguousKeyless && !reports.length) {
        return empty("uncertain", ["multiple_obligations_require_specific_evidence"], list);
      }
      if (evidence.nativeCompletion || reports.length > 0) return empty("satisfied", [], list);
      return empty("pending", [], list);
    }

    // manual: só um relato explícito da chave da obrigação confirma; não se infere.
    const keyed = evidence.events.filter((event) =>
      event.requirement_key === key && event.event_type === "completion"
    );
    const list = reportReceipts(keyed);
    if (keyed.length > 0) return empty("satisfied", [], list);
    return empty("pending", ["manual_confirmation_pending"], list);
  });
}

/**
 * Resultado da atividade: concluído quando todas as obrigações interpretadas
 * estão satisfeitas; incerto quando alguma exceção impede afirmar; pendente
 * quando falta cumprir. Fórum sem obrigação interpretada é incerto, não conclusão.
 */
function assessEntity(
  kind: string,
  assessments: Json[],
  submissionEvidencePresent: boolean,
  completionEvidencePresent: boolean,
): EntityAssessment {
  if (assessments.length === 0) {
    if (FORUM_KINDS.includes(kind)) {
      return { status: "uncertain", reasons: ["requirement_not_interpreted"] };
    }
    if (kind === "assignment") {
      return submissionEvidencePresent
        ? { status: "concluded", reasons: [] }
        : { status: "pending", reasons: ["submission_evidence_missing"] };
    }
    return { status: completionEvidencePresent ? "concluded" : "pending", reasons: [] };
  }
  const reasons: string[] = [];
  for (const assessment of assessments) {
    if (assessment.state === "uncertain") {
      for (const reason of (assessment.reasons as string[] | undefined) ?? []) reasons.push(reason);
    }
  }
  if (assessments.some((assessment) => assessment.state === "uncertain")) {
    return { status: "uncertain", reasons: [...new Set(reasons)] };
  }
  if (assessments.every((assessment) => assessment.state === "satisfied")) {
    return { status: "concluded", reasons: [] };
  }
  return { status: "pending", reasons: [] };
}

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
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
   * Postagens preservadas de fórum/discussão. Uma publicação observada com
   * autoria igual ao titular e relação canônica prova o tópico; respostas a
   * colegas exigem o post do outro autor preservado. Cada recibo carrega
   * ID/observação/hash/cobertura/data; não avalia qualidade acadêmica.
   */
  private async forumEvidence(
    tx: postgres.TransactionSql,
    ownerId: string,
    entityId: string,
    subject: string | null,
  ): Promise<ForumEvidence | null> {
    if (subject === null || subject === "") return null;
    const rows = await tx`
      with candidate_posts as (
        select p.id,p.connection_id
        from public.hub_relations r
        join public.hub_entities p on p.owner_id=r.owner_id and p.id=r.to_id and p.kind='post'
        where r.owner_id=${ownerId} and r.from_id=${entityId} and r.kind='has_post'
        union
        select p.id,p.connection_id
        from public.hub_relations rd
        join public.hub_entities d on d.owner_id=rd.owner_id and d.id=rd.to_id and d.kind='discussion'
        join public.hub_relations rp on rp.owner_id=d.owner_id and rp.from_id=d.id and rp.kind='has_post'
        join public.hub_entities p on p.owner_id=rp.owner_id and p.id=rp.to_id and p.kind='post'
        where rd.owner_id=${ownerId} and rd.from_id=${entityId} and rd.kind='has_discussion'
      ), target_posts as (
        select p.id as post_entity_id,p.connection_id,
          o.id as observation_id,o.content_id,o.content_hash,o.coverage,o.observed_at,
          coalesce(o.content->>'id',o.content->>'post_id',o.provenance->>'post_id') as post_id,
          coalesce(o.content->>'discussionid',o.content->>'discussion_id',o.content->>'discussion',o.provenance->>'discussion_id') as discussion_id,
          coalesce(o.content->>'userid',o.content#>>'{author,userid}',o.content#>>'{author,id}',o.content->>'author_userid') as author_id,
          coalesce(o.content->>'parentid',o.content->>'parent') as parent_id
        from candidate_posts p
        join public.hub_entities target on target.owner_id=${ownerId} and target.id=${entityId}
          and target.connection_id=p.connection_id
        join lateral (
          select id,content_id,content,content_hash,coverage,observed_at,provenance
          from public.hub_observation_timeline
          where owner_id=${ownerId} and entity_id=p.id
          order by observed_at desc,id desc limit 1
        ) o on o.coverage in ('complete','partial')
          and o.provenance->>'system'='moodle'
          and o.provenance->>'connection_id'=p.connection_id::text
      )
      select post_entity_id,connection_id,post_id,discussion_id,parent_id,author_id,
        observation_id,content_id,content_hash,coverage,observed_at
      from target_posts order by post_entity_id`;
    // The discussions endpoint exposes the first post's author/id. It already
    // proves a topic even when the posts window has not yet been requested.
    const discussionRows = await tx`
      select d.id as post_entity_id,d.connection_id,
        coalesce(o.content->>'first_post_id',o.content->>'id') as post_id,
        coalesce(o.content->>'discussion_id',o.content->>'discussion',o.provenance->>'discussion_id') as discussion_id,
        '0'::text as parent_id,o.content->>'userid' as author_id,
        o.id as observation_id,o.content_id,o.content_hash,o.coverage,o.observed_at
      from public.hub_entities d
      join public.hub_entities target on target.owner_id=d.owner_id and target.id=${entityId}
        and target.connection_id=d.connection_id
      join lateral (select * from public.hub_observation_timeline
        where owner_id=d.owner_id and entity_id=d.id order by observed_at desc,id desc limit 1) o
        on o.coverage in ('complete','partial') and o.provenance->>'system'='moodle'
          and o.provenance->>'connection_id'=d.connection_id::text
      where d.owner_id=${ownerId} and d.kind='discussion' and o.content->>'userid' ~ '^[1-9][0-9]*$'
        and (d.id=${entityId} or exists (
        select 1 from public.hub_relations r where r.owner_id=d.owner_id
          and r.from_id=${entityId} and r.to_id=d.id and r.kind='has_discussion'))`;
    const numericAuthor = (value: unknown): string | null =>
      typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;
    const candidates = [...discussionRows, ...rows].map((row) => ({
      post_entity_id: String(row.post_entity_id ?? ""),
      connection_id: String(row.connection_id ?? ""),
      post_id: row.post_id === null || row.post_id === undefined ? null : String(row.post_id),
      discussion_id: row.discussion_id === null || row.discussion_id === undefined
        ? null
        : String(row.discussion_id),
      parent_id: row.parent_id === null || row.parent_id === undefined
        ? null
        : String(row.parent_id),
      author_id: numericAuthor(row.author_id),
      observation_id: row.observation_id === null || row.observation_id === undefined
        ? null
        : String(row.observation_id),
      content_id: row.content_id ?? null,
      content_hash: row.content_hash ?? null,
      coverage: row.coverage ?? null,
      observed_at: row.observed_at ?? null,
    }));
    const posts = [...new Map(
      candidates.filter((post) => post.post_id && post.discussion_id)
        .map((post) => [`${post.connection_id}|${post.discussion_id}|${post.post_id}`, post]),
    ).values()];
    const colleagueIds = new Set<string>();
    for (const post of posts) {
      if (post.author_id !== null && post.author_id !== subject) colleagueIds.add(post.author_id);
    }
    // Índice por ID canônico para qualificar o parent da resposta; a mesma
    // postagem alcançada por dois caminhos do grafo não conta duas vezes.
    const byPost = new Map<string, (typeof posts)[number]>();
    for (const post of posts) {
      if (post.post_id === null) continue;
      const key = `${post.connection_id}|${post.discussion_id}|${post.post_id}`;
      if (!byPost.has(key)) byPost.set(key, post);
    }
    const answered = new Set<string>();
    const publications: Json[] = [];
    const replies: Json[] = [];
    for (const post of posts) {
      if (post.author_id !== subject) continue;
      if (post.parent_id === "0") {
        publications.push(receipt("preserved_owner_publication", {
          post_entity_id: post.post_entity_id,
          post_id: post.post_id,
          discussion_id: post.discussion_id,
          author_userid: subject,
          observation_id: post.observation_id,
          content_id: post.content_id,
          content_hash: post.content_hash,
          coverage: post.coverage,
          observed_at: post.observed_at,
        }));
      }
      if (post.parent_id === null || !/^[1-9][0-9]*$/.test(post.parent_id)) continue;
      const parent = byPost.get(
        `${post.connection_id}|${post.discussion_id}|${post.parent_id}`,
      );
      const parentAuthor = parent?.author_id ?? null;
      if (parentAuthor === null || parentAuthor === subject) continue;
      answered.add(parentAuthor);
      replies.push(receipt("preserved_owner_reply", {
        post_entity_id: post.post_entity_id,
        post_id: post.post_id,
        discussion_id: post.discussion_id,
        parent_post_id: post.parent_id,
        colleague_userid: parentAuthor,
        author_userid: subject,
        observation_id: post.observation_id,
        content_id: post.content_id,
        content_hash: post.content_hash,
        coverage: post.coverage,
        observed_at: post.observed_at,
      }));
    }
    return {
      subject_userid: subject,
      distinct_colleagues: colleagueIds.size,
      colleagues_answered_by_owner: answered.size,
      observed_posts: posts.length,
      owner_posts: posts.filter((post) => post.author_id === subject).length,
      publications: publications.slice(0, FORUM_RECEIPT_LIMIT),
      replies: replies.slice(0, FORUM_RECEIPT_LIMIT),
      publications_truncated: publications.length > FORUM_RECEIPT_LIMIT,
      replies_truncated: replies.length > FORUM_RECEIPT_LIMIT,
      basis: "preserved_discussion_posts",
      note:
        "Colegas presentes e colegas respondidos são contadores distintos. Publicação exige post observado com autoria do titular e relação canônica; resposta exige parent de outro autor na mesma discussão/conexão. Não avalia qualidade acadêmica nem participação atual.",
    };
  }

  /** Uma consulta para a página; escopo explícito do artefato prevalece sobre o contexto. */
  private async draftPage(
    tx: postgres.TransactionSql,
    ownerId: string,
    entityIds: string[],
    contextId?: string,
  ) {
    if (!entityIds.length) return [];
    return await tx`
      select target.entity_id,d.id,d.context_id,d.version,d.recorded_at
      from unnest(${tx.array(entityIds)}::uuid[]) target(entity_id)
      cross join lateral (
        select id,context_id,version,recorded_at from public.hub_deltas d
        where d.owner_id=${ownerId} and d.kind='artifact'
          and (${contextId ?? null}::uuid is null or d.context_id=${contextId ?? null}::uuid)
          and (d.scope->>'entity_id'=target.entity_id::text or (
            coalesce(d.scope->>'entity_id','')='' and exists (
              select 1 from public.hub_context_targets t
              where t.owner_id=d.owner_id and t.context_id=d.context_id
                and t.entity_id=target.entity_id and t.active)))
        order by d.recorded_at desc,d.id limit ${DRAFT_LIMIT + 1}
      ) d`;
  }

  /**
   * Dependências versionadas dos rascunhos da página, numa consulta em lote.
   * Um nome, material vizinho ou relação sem versão-base não estabelece dependência.
   * O hash precisa corresponder a uma observação do mesmo dono, inclusive quando
   * o localizador legado aponta ao snapshot deduplicado em vez da ocorrência.
   */
  private async draftMaterials(
    tx: postgres.TransactionSql,
    ownerId: string,
    drafts: Array<{ entity_id: string; id: string }>,
  ) {
    if (!drafts.length) return [];
    return await tx`
      select link.entity_id,d.id as draft_id,d.context_id,
        ref.basis,ref.base_id as referenced_observation_id,
        base.entity_id as material_entity_id,base.id as base_observation_id,
        base.content_id as base_content_id,base.content_hash as base_hash,base.coverage as base_coverage,
        current.id as current_observation_id,current.content_id as current_content_id,
        current.content_hash as current_hash,current.observed_at as current_observed_at,
        current.coverage,source.title,connection.state as connection_state,
        (source.state->'provider_record' = current.content) as matches_current
      from jsonb_to_recordset(${tx.json(drafts)}) link(entity_id uuid,id uuid)
      join public.hub_deltas d on d.owner_id=${ownerId} and d.id=link.id and d.kind='artifact'
      cross join lateral (
        select candidate.*,case when base_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then base_id::uuid else null end as base_uuid from (
          select 'artifact_provenance'::text as basis,
            substring(p->>'locator' from 17) as base_id,p->>'version' as base_hash,
            null::uuid as required_entity_id
          from jsonb_array_elements(d.provenance) p
          where p->>'locator' ~ '^hub:observation:[0-9a-fA-F-]{36}$'
            and coalesce(p->>'version','')<>''
          union all
          select 'required_material',r.evidence->>'source_observation_id',
            r.evidence->>'content_hash',r.to_id
          from public.hub_relations r
          where r.owner_id=d.owner_id and r.from_id=link.entity_id and r.kind='required_material'
            and coalesce(r.evidence->>'source_observation_id','')<>''
            and coalesce(r.evidence->>'content_hash','')<>''
            and (r.evidence->>'context_id' is null or r.evidence->>'context_id'=d.context_id::text)
            and (r.evidence->>'draft_delta_id' is null or r.evidence->>'draft_delta_id'=d.id::text)
        ) candidate
        order by basis,base_id,base_hash,required_entity_id
        limit ${MATERIAL_REFERENCE_LIMIT + 1}
      ) ref
      left join lateral (
        select id,content_id,entity_id,content_hash,coverage from public.hub_observation_timeline o
        where o.owner_id=d.owner_id
          and (o.id=ref.base_uuid or o.content_id=ref.base_uuid)
          and o.content_hash=ref.base_hash
          and (ref.required_entity_id is null or o.entity_id=ref.required_entity_id)
        order by o.observed_at,o.id limit 1
      ) base on true
      left join public.hub_entities source on source.owner_id=d.owner_id and source.id=base.entity_id
      left join public.hub_connections connection on connection.owner_id=d.owner_id and connection.id=source.connection_id
      left join lateral (
        select id,content_id,content_hash,content,observed_at,coverage
        from public.hub_observation_timeline o
        where o.owner_id=d.owner_id and o.entity_id=source.id
        order by o.observed_at desc,o.id desc limit 1
      ) current on true
      order by link.entity_id,d.id,ref.basis,ref.base_id,ref.base_hash,ref.required_entity_id`;
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

  /**
   * Relatos do titular preservados como deltas: `submission_report` legado e os
   * eventos acadêmicos novos. Um relato vale apenas para o alvo explícito do
   * escopo ou para um contexto inequivocamente vinculado a um único alvo ativo;
   * o mesmo relato nunca é espalhado por vários alvos. Correção e retratação
   * retiram somente a projeção da evidência anterior; o histórico permanece.
   */
  private async academicEvents(tx: postgres.TransactionSql, ownerId: string, entityIds: string[]) {
    if (!entityIds.length) return [] as AcademicEvent[];
    // Project one current assertion per target/type/requirement, AFTER excluding
    // corrections. Unrelated newer events can never evict an old milestone.
    const rows = await tx`
      with bindings as (
        select t.context_id, min(t.entity_id::text) as entity_id
        from public.hub_context_targets t where t.owner_id=${ownerId} and t.active
        group by t.context_id having count(distinct t.entity_id)=1
      ), scoped as (
        select d.*,coalesce(nullif(d.scope->>'entity_id',''),b.entity_id) as target_id,
          coalesce(d.scope->>'academic_event','submission') as event_type
        from public.hub_deltas d left join bindings b on b.context_id=d.context_id
        where d.owner_id=${ownerId} and d.evidence_kind='user_report'
          and (d.scope->>'academic_event' in ('submission','forum_topic','forum_reply','completion',
            'deadline_change','requirements_change','feedback_received') or d.kind='submission_report')
          and coalesce(d.scope->>'retracted','false')<>'true'
          and not exists (select 1 from public.hub_deltas s where s.owner_id=d.owner_id
            and s.evidence_kind='user_report' and s.scope->>'supersedes'=d.id::text)
      )
      select distinct on (target_id,event_type,coalesce(scope->>'requirement_key',''))
        id,context_id,kind,content,scope,provenance,recorded_at,target_id,event_type
      from scoped where target_id=any(${tx.array(entityIds)}::text[])
      order by target_id,event_type,coalesce(scope->>'requirement_key',''),recorded_at desc,version desc,id desc`;
    return rows.map((row): AcademicEvent => {
      const scope = object(row.scope);
      const provenance = Array.isArray(row.provenance) ? object(row.provenance[0]) : {};
      return {
        delta_id: String(row.id),
        context_id: String(row.context_id),
        kind: String(row.kind),
        event_type: String(row.event_type),
        requirement_key: typeof scope.requirement_key === "string" ? scope.requirement_key : null,
        content: String(row.content),
        recorded_at: row.recorded_at,
        occurred_at: provenance.occurred_at ?? null,
        original_date: provenance.original_date ?? null,
        reported_distinct_colleagues: scope.reported_distinct_colleagues === undefined
          ? null
          : Number(scope.reported_distinct_colleagues),
        entity_id: String(row.target_id),
        binding: scope.entity_id ? "explicit_target" : "unique_context_target",
      };
    });
  }

  /**
   * Estado nativo da própria entrega, relacionado à atividade por
   * `has_own_submission_status`. Só qualifica com IDs e autoria corretos; nunca
   * consulta o Moodle e nunca apaga relato do titular — contradição é exceção.
   */
  private async ownSubmissionStatusFor(
    tx: postgres.TransactionSql,
    ownerId: string,
    connectionId: string,
    entityId: string,
    state: Json,
    providerSubject: string | null,
  ) {
    const rows = await tx`
      select s.id as status_entity_id,s.state as status_state,
        o.observation_id,o.content_id,o.content,o.content_hash,o.coverage,o.observed_at,o.provenance
      from public.hub_relations r
      join public.hub_entities s on s.owner_id=r.owner_id and s.id=r.to_id
        and s.kind='own_submission_status' and s.connection_id=${connectionId}
      left join lateral (
        select id as observation_id,content_id,content,content_hash,coverage,observed_at,provenance
        from public.hub_observation_timeline
        where owner_id=s.owner_id and entity_id=s.id
        order by observed_at desc,id desc limit 1
      ) o on true
      where r.owner_id=${ownerId} and r.from_id=${entityId}
        and r.kind='has_own_submission_status'
      order by s.id limit 1`;
    const row = rows[0];
    if (!row) return null;
    const statusState = object(row.status_state);
    const content = object(row.content);
    const provenance = object(row.provenance);
    const data = object(content.data);
    const nested = object(object(content.lastattempt).submission).status !== undefined
      ? object(content.lastattempt)
      : object(data.lastattempt);
    const submission = object(nested.submission);
    const reasons: string[] = [];
    if (row.observation_id === null || row.observation_id === undefined) {
      reasons.push("no_preserved_observation");
    }
    if (provenance.system !== "moodle") reasons.push("observation_not_from_moodle");
    if (!["complete", "partial"].includes(String(row.coverage))) {
      reasons.push("invalid_observation_coverage");
    }
    if (String(provenance.connection_id ?? "") !== connectionId) {
      reasons.push("connection_mismatch");
    }
    const observedSubject = provenance.subject_userid === undefined ||
        provenance.subject_userid === null
      ? null
      : String(provenance.subject_userid);
    const submissionUser = numericOrNull(submission.userid);
    if (submission.userid !== undefined && String(submission.userid) !== providerSubject) {
      reasons.push("submission_author_mismatch");
    }
    let authorshipBasis: string | null = null;
    if (providerSubject === null || providerSubject === "") {
      reasons.push("connection_subject_unknown");
    } else if (observedSubject !== null && observedSubject === providerSubject) {
      authorshipBasis = "provenance_subject_userid";
    } else if (
      observedSubject === null && submissionUser !== null &&
      String(submissionUser) === providerSubject
    ) {
      authorshipBasis = "submission_userid";
    } else if (observedSubject !== null) {
      reasons.push("observation_author_mismatch");
    } else {
      reasons.push("author_not_declared");
    }
    const assignmentCourse = numericOrNull(state.course_id);
    const assignmentInstance = numericOrNull(state.instance_id);
    const statusCourse = numericOrNull(statusState.course_id);
    const statusInstance = numericOrNull(statusState.instance_id);
    if (statusCourse === null || assignmentCourse === null || statusCourse !== assignmentCourse) {
      reasons.push("course_id_mismatch");
    }
    if (
      statusInstance === null || assignmentInstance === null ||
      statusInstance !== assignmentInstance
    ) {
      reasons.push("instance_id_mismatch");
    }
    const rawStatus = submission.status;
    return {
      status_entity_id: String(row.status_entity_id),
      qualified: reasons.length === 0,
      reasons,
      authorship_basis: authorshipBasis,
      status: typeof rawStatus === "string" ? rawStatus.toLowerCase() : null,
      submission_userid: submission.userid ?? null,
      course_id: statusState.course_id ?? null,
      instance_id: statusState.instance_id ?? null,
      feedback: content.feedback ?? null,
      observation: row.observation_id === null || row.observation_id === undefined ? null : {
        observation_id: String(row.observation_id),
        content_id: row.content_id ?? null,
        content_hash: row.content_hash ?? null,
        coverage: row.coverage ?? null,
        observed_at: row.observed_at ?? null,
        provenance_system: provenance.system ?? null,
        provenance_connection_id: provenance.connection_id ?? null,
        subject_userid: observedSubject,
      },
      basis: "own_submission_status_entity",
      note:
        "Estado da própria entrega preservado pela raiz; não é novo acesso ao Moodle, não marca leitura e não conclui atividade.",
    };
  }

  /** Obrigações explícitas interpretadas a partir da fonte, com trecho e versões. */
  private async requirementsFor(
    tx: postgres.TransactionSql,
    ownerId: string,
    sourceEntityId: string,
    sourceKind: string,
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
        fulfillment: requirementFulfillment(sourceKind, payload),
        action: typeof payload.action === "string" ? payload.action : null,
        quantity: quantity === null
          ? null
          : { kind: quantity.kind ?? null, at_least: quantity.at_least ?? null },
        deadline: deadline === null ? null : {
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
    const view = a.view ?? "audit";
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
          o.observation_id,o.content_id,o.content_hash,o.coverage,o.observed_at,o.content,o.provenance,o.matches_current,
          previous.content as previous_content,previous.content_hash as previous_content_hash
        from public.hub_entities e
        join public.hub_connections c on c.owner_id=e.owner_id and c.id=e.connection_id
        left join lateral (
          select id as observation_id,content_id,content,content_hash,coverage,observed_at,provenance,
            (e.state->'provider_record' = content) as matches_current
          from public.hub_observation_timeline
          where owner_id=e.owner_id and entity_id=e.id
          order by observed_at desc,id desc limit 1) o on true
        left join lateral (
          select content,content_hash from public.hub_observation_timeline
          where owner_id=e.owner_id and entity_id=e.id and observed_at<o.observed_at
            and content_hash<>o.content_hash
          order by observed_at desc,id desc limit 1) previous on true
        where e.owner_id=${p.ownerId} and e.kind in ${tx(OBLIGATION_KINDS)}
          -- Recursos de material não são obrigações acionáveis e um módulo cujo
          -- conteúdo concreto já é projetado por conta própria não é duplicado
          -- (module -> has_content, comparado por IDs).
          and (e.kind <> 'module' or (
            not exists (
              select 1 from public.hub_relations rm
              join public.hub_entities child on child.owner_id=rm.owner_id and child.id=rm.to_id
              where rm.owner_id=e.owner_id and rm.from_id=e.id and rm.kind='has_content'
                and child.kind in ${tx(MODULE_CONCRETE_CHILD_KINDS)}
            )
            and coalesce(e.state->'provider_record'->>'modname','')
              <> all(${tx.array([...NON_ACTIONABLE_MODNAMES])}::text[])
          ))
          and (${view}='audit' or e.kind<>'discussion' or not exists (
            select 1 from public.hub_relations r join public.hub_entities f
              on f.owner_id=r.owner_id and f.id=r.from_id and f.kind='forum'
            where r.owner_id=e.owner_id and r.to_id=e.id and r.kind='has_discussion'
              and f.connection_id=e.connection_id))
          and (${a.connection_id ?? null}::uuid is null or e.connection_id=${
        a.connection_id ?? null
      }::uuid)
          and (${a.context_id ?? null}::uuid is null or exists (
            select 1 from public.hub_context_targets t
            where t.owner_id=e.owner_id and t.context_id=${a.context_id ?? null}::uuid
              and t.active and (t.entity_id=e.id or exists (
                select 1 from public.hub_relations alias where alias.owner_id=t.owner_id
                  and alias.from_id=t.entity_id and alias.to_id=e.id and alias.kind='has_content'))))
        order by e.title,e.id limit 21 offset ${offset}`;
      const page = rows.slice(0, 20);
      const obligations: unknown[] = [];
      const attention: unknown[] = [];
      const receipts = await this.confirmedActions(tx, p.ownerId);
      const draftRows = await this.draftPage(
        tx,
        p.ownerId,
        page.map((row) => String(row.id)),
        a.context_id,
      );
      const draftsByEntity = new Map<string, Array<(typeof draftRows)[number]>>();
      for (const row of draftRows) {
        const id = String(row.entity_id);
        const list = draftsByEntity.get(id) ?? [];
        list.push(row);
        draftsByEntity.set(id, list);
      }
      const materialRows = await this.draftMaterials(
        tx,
        p.ownerId,
        [...draftsByEntity.values()].flatMap((list) =>
          list.slice(0, DRAFT_LIMIT)
            .map((row) => ({ entity_id: String(row.entity_id), id: String(row.id) }))
        ),
      );
      const materialsByDraft = new Map<string, Array<(typeof materialRows)[number]>>();
      for (const row of materialRows) {
        const key = `${row.entity_id}:${row.draft_id}`;
        const list = materialsByDraft.get(key) ?? [];
        list.push(row);
        materialsByDraft.set(key, list);
      }
      // Relatos do titular preservados como deltas, vinculados por alvo explícito
      // ou contexto inequívoco; o índice por alvo evita espalhar o relato.
      const academic = await this.academicEvents(tx, p.ownerId, page.map((row) => String(row.id)));
      const eventsByEntity = new Map<string, AcademicEvent[]>();
      for (const event of academic) {
        if (event.entity_id === null) continue;
        const list = eventsByEntity.get(event.entity_id) ?? [];
        list.push(event);
        eventsByEntity.set(event.entity_id, list);
      }
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
        const forum = FORUM_KINDS.includes(kind)
          ? await this.forumEvidence(tx, p.ownerId, entityId, subject)
          : null;
        if (FORUM_KINDS.includes(kind) && forum === null) {
          gaps.push(
            "Conta vinculada sem identificador de usuário Moodle na conexão; a contagem de colegas não pode excluir as postagens do próprio titular.",
          );
        }
        if (forum !== null && (forum.publications_truncated || forum.replies_truncated)) {
          gaps.push(
            `Recibos de fórum limitados a ${FORUM_RECEIPT_LIMIT} publicações e ${FORUM_RECEIPT_LIMIT} respostas; os contadores consideram todas as postagens preservadas.`,
          );
        }
        const requirements = await this.requirementsFor(tx, p.ownerId, entityId, kind);
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
        const near = nearest !== null && Date.parse(nearest) - nowMs <= horizonMs ? nearest : null;
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
        const draftCandidates = draftsByEntity.get(entityId) ?? [];
        const drafts = draftCandidates.slice(0, DRAFT_LIMIT).map((
          { id, context_id, version, recorded_at },
        ) => ({ id, context_id, version, recorded_at }));
        let dependencyTruncated = draftCandidates.length > DRAFT_LIMIT;
        const materialChanges: Json[] = [];
        const seenChanges = new Set<string>();
        for (const draft of drafts) {
          const dependencies = materialsByDraft.get(`${entityId}:${draft.id}`) ?? [];
          dependencyTruncated ||= dependencies.length > MATERIAL_REFERENCE_LIMIT;
          for (const dependency of dependencies.slice(0, MATERIAL_REFERENCE_LIMIT)) {
            if (
              !dependency.base_observation_id || !dependency.current_observation_id ||
              dependency.base_hash === dependency.current_hash
            ) continue;
            const key = `${draft.id}:${dependency.material_entity_id}:${dependency.base_hash}`;
            if (seenChanges.has(key)) continue;
            seenChanges.add(key);
            materialChanges.push({
              draft_id: draft.id,
              context_id: draft.context_id,
              material_entity_id: dependency.material_entity_id,
              material_title: dependency.title,
              dependency_basis: dependency.basis,
              baseline: {
                observation_id: dependency.base_observation_id,
                content_id: dependency.base_content_id,
                content_hash: dependency.base_hash,
              },
              current: {
                observation_id: dependency.current_observation_id,
                content_id: dependency.current_content_id,
                content_hash: dependency.current_hash,
                observed_at: dependency.current_observed_at,
                coverage: dependency.coverage,
              },
              source_uncertainties: [
                ...(dependency.base_coverage !== "complete"
                  ? ["baseline_incomplete_coverage"]
                  : []),
                ...(dependency.connection_state !== "connected"
                  ? ["source_access_not_current"]
                  : []),
                ...(dependency.coverage !== "complete" ? ["incomplete_coverage"] : []),
                ...(dependency.matches_current === false ? ["unrecorded_source_change"] : []),
              ],
              basis: "preserved_observations",
              requires_review: true,
            });
          }
        }
        if (dependencyTruncated) {
          gaps.push(
            `Dependências examinadas apenas nos ${DRAFT_LIMIT} rascunhos recentes e ${MATERIAL_REFERENCE_LIMIT} referências por rascunho; consulte hub_history/hub_observations para aprofundar.`,
          );
        }
        const tracker = await this.completionTracker(tx, p.ownerId, entityId);
        const completionFlag = state.completion === undefined ? null : state.completion;
        // Conclusão nativa e status de entrega são sinais distintos do relato.
        const nativeCompletion = completionFlag === true || tracker?.state === 1 ||
          tracker?.state === 2;
        const academicActions = receipts.filter((candidate) =>
          receiptMatchesEntity(candidate, connectionId, state)
        );
        const ownStatus = kind === "assignment" || kind === "module"
          ? await this.ownSubmissionStatusFor(tx, p.ownerId, connectionId, entityId, state, subject)
          : null;
        const events = eventsByEntity.get(entityId) ?? [];
        const suppressed = userReport?.delta_id
          ? await tx`select id from public.hub_deltas
          where owner_id=${p.ownerId} and evidence_kind='user_report'
            and scope->>'supersedes'=${String(userReport.delta_id)} limit 1`
          : [];
        const legacyUserReport = userReport !== null && userReport.reported !== false &&
          !suppressed.length;
        const userReportPresent = legacyUserReport ||
          events.some((event) => event.event_type === "submission");
        const assessments = assessRequirements(
          requirements.length
            ? requirements
            : kind === "assignment"
            ? [{ requirement_key: "submission", fulfillment: "submission" }]
            : [],
          {
            events,
            legacyUserReport,
            receipts: academicActions,
            ownStatus,
            forum,
            nativeCompletion,
          },
        );
        for (let index = 0; index < requirements.length; index++) {
          if (contentHash && requirements[index].source.content_hash !== contentHash) {
            assessments[index] = {
              ...assessments[index],
              state: "uncertain",
              reasons: [
                ...assessments[index].reasons as string[],
                "requirement_source_changed_requires_review",
              ],
            };
          }
        }
        const requirementView = requirements.map((requirement, index) => ({
          ...requirement,
          state: assessments[index].state,
          state_reasons: assessments[index].reasons,
          evidence: assessments[index].evidence,
        }));
        const nativeSubmitted = ownStatus !== null && ownStatus.qualified === true &&
          ownStatus.status === "submitted";
        // Evidência de entrega: relato do titular (delta ou estado legado) ou recibo
        // confirmado. Conclusão nativa não substitui; status próprio "submitted" é
        // prova nativa da entrega da própria conta, separada da conclusão.
        const submissionEvidence = {
          user_report: userReportPresent,
          confirmed_academic_action: academicActions.length > 0,
          native_completion: nativeCompletion,
          own_submission_status: ownStatus === null ? null : {
            qualified: ownStatus.qualified,
            status: ownStatus.status,
            reasons: ownStatus.reasons,
          },
        };
        const submissionEvidencePresent = userReportPresent ||
          academicActions.length > 0 || nativeSubmitted;
        const outcome = assessEntity(
          kind,
          assessments,
          submissionEvidencePresent,
          nativeCompletion || events.some((event) => event.event_type === "completion"),
        );
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
        const previousRecord = object(row.previous_content);
        if (row.previous_content_hash && presented?.content_hash !== contentHash) {
          const changedDeadlines = DEADLINE_FIELDS.filter((field) =>
            previousRecord[field] !== record?.[field]
          );
          if (changedDeadlines.length) {
            item(
              "deadline_changed",
              "Campos de prazo mudaram: " + changedDeadlines.join(", ") + ".",
            );
          }
          if (
            ["intro", "description", "content"].some((field) =>
              previousRecord[field] !== record?.[field]
            )
          ) {
            item(
              "instructions_changed",
              "O conteúdo da atividade mudou; confira as orientações e obrigações afetadas.",
            );
          }
        }
        for (
          const event of events.filter((event) =>
            ["deadline_change", "requirements_change", "feedback_received"].includes(
              event.event_type ?? "",
            )
          )
        ) {
          attention.push({
            entity_id: entityId,
            kind: event.event_type,
            evidence_kind: "user_report",
            delta_id: event.delta_id,
            detail: event.content,
            occurred_at: event.occurred_at,
            original_date: event.original_date,
          });
        }
        if (ownStatus?.qualified && object(ownStatus.feedback).available === true) {
          attention.push({
            entity_id: entityId,
            kind: "feedback_available",
            evidence_kind: "observed",
            detail: "A consulta autorizada informou feedback disponível; o conteúdo não foi lido.",
            observation: ownStatus.observation,
            gradeddate: object(ownStatus.feedback).gradeddate,
          });
        }
        if (presented === null && view === "audit") {
          item(
            "not_presented",
            "Fonte preservada ainda não registrada como apresentada ao titular.",
          );
        } else if (
          presented !== null && contentHash !== null && presented.content_hash !== contentHash
        ) {
          item("changed_since_presented", "A fonte mudou depois de ter sido apresentada.");
        }
        if (read !== null && contentHash !== null && read.content_hash !== contentHash) {
          item("changed_since_read", "A fonte mudou depois da leitura confirmada pelo titular.");
        }
        if (ACCESS_LOST_STATES.includes(connectionState)) {
          item(
            "access_lost",
            "A conexão da fonte não está ativa; a memória preservada continua consultável.",
          );
        }
        if (coverage !== null && coverage !== "complete") {
          item("incomplete_coverage", "A última observação não tem cobertura completa.");
        }
        if (near !== null && (view === "audit" || outcome.status !== "concluded")) {
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
        if (outcome.status === "uncertain") {
          item(
            "academic_uncertain",
            "Resultado incerto: " +
              (outcome.reasons.length ? outcome.reasons.join(", ") : "evidência insuficiente") +
              ".",
          );
        }
        if (ownStatus !== null && ownStatus.qualified !== true) {
          item(
            "own_submission_status_unqualified",
            "Há estado da própria entrega preservado, mas sem IDs/autoria que o qualifiquem; não foi usado como prova. " +
              ownStatus.reasons.join(", "),
          );
        }
        if (
          assessments.some((assessment) =>
            (assessment.reasons as string[]).some((reason) =>
              ["user_report_contradicts_native_status", "receipt_contradicts_native_status"]
                .includes(reason)
            )
          )
        ) {
          item(
            "report_observation_contradiction",
            "O relato ou recibo preservado diverge da observação nativa; as evidências permanecem separadas.",
          );
        }
        if (drift) {
          item(
            "unrecorded_reobservation",
            "A fonte reverteu ou mudou depois da última ocorrência registrada.",
          );
        }
        for (const change of materialChanges) {
          attention.push({
            ...change,
            entity_id: entityId,
            kind: "material_dependency_changed",
            detail:
              "O material preservado mudou em relação à versão vinculada ao rascunho. Revise a dependência; o hash diferente não comprova mudança semântica do requisito nem acesso atual à fonte.",
          });
        }
        const entityView = {
          id: entityId,
          kind,
          title: String(row.title ?? ""),
          external_id: externalId,
          provider: String(row.provider ?? ""),
          connection_state: connectionState,
        };
        if (view === "summary") {
          obligations.push({
            entity: entityView,
            outcome,
            evidence: {
              reported: events.map((event) => ({
                event_type: event.event_type,
                delta_id: event.delta_id,
              })),
              legacy_submission_report: legacyUserReport,
              native_submission_status: ownStatus?.qualified ? ownStatus.status : null,
              observed_topics: forum?.publications ?? [],
              observed_distinct_colleagues: forum?.colleagues_answered_by_owner ?? null,
              native_completion: nativeCompletion,
            },
            requirements: requirementView.map((requirement) => ({
              requirement_key: requirement.requirement_key,
              action: requirement.action,
              fulfillment: requirement.fulfillment,
              state: requirement.state,
              state_reasons: requirement.state_reasons,
              evidence: (requirement.evidence as Json[]).slice(0, 3),
            })),
            deadlines: { overdue, upcoming: upcoming.length, nearest, within_horizon: near },
            provenance: {
              observation_id: observationId,
              content_id: contentId,
              content_hash: contentHash,
              coverage,
              observed_at: row.observed_at ?? null,
            },
            // Sem inventário extenso: o necessário para agir e auditar por ID.
            caveats: [...new Set([...gaps, ...outcome.reasons])].slice(0, 6),
          });
          continue;
        }
        obligations.push({
          entity: entityView,
          outcome,
          requirement: requirementOf(kind, record, observationId),
          // Prazos da fonte e afirmações interpretadas ficam em coleções próprias:
          // uma coluna due_date não representa duas obrigações distintas.
          deadlines,
          requirement_deadlines: requirementDeadlines,
          deadline_summary: { overdue, upcoming: upcoming.length, nearest, within_horizon: near },
          requirements: requirementView,
          colleagues: forum === null ? null : {
            subject_userid: forum.subject_userid,
            distinct_colleagues: forum.distinct_colleagues,
            colleagues_answered_by_owner: forum.colleagues_answered_by_owner,
            observed_posts: forum.observed_posts,
            owner_posts: forum.owner_posts,
            basis: forum.basis,
            note: forum.note,
          },
          colleague_requirements: requirementView
            .filter((r) => r.quantity !== null && r.quantity.kind === "colleagues_distinct")
            .map((r) => ({
              requirement_key: r.requirement_key,
              required_at_least: r.quantity!.at_least,
              observed_distinct_colleagues: forum?.colleagues_answered_by_owner ?? null,
              basis: "observed_owner_replies_to_distinct_colleagues",
              // Comparação numérica explícita; não declara qualidade acadêmica.
              observed_meets_at_least: forum === null
                ? null
                : Number(forum.colleagues_answered_by_owner) >= Number(r.quantity!.at_least),
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
              entity_completion: completionFlag,
              tracker,
              note:
                "Estado nativo do Moodle; não prova leitura humana e não é alterado por esta projeção.",
            },
            user_report: userReport,
            legacy_user_report_active: legacyUserReport,
            academic_events: events.map((event) => ({
              delta_id: event.delta_id,
              context_id: event.context_id,
              kind: event.kind,
              event_type: event.event_type,
              requirement_key: event.requirement_key,
              binding: event.binding,
              recorded_at: event.recorded_at,
              occurred_at: event.occurred_at ?? null,
              original_date: event.original_date ?? null,
            })),
            own_submission_status: ownStatus,
            forum_publications: forum === null ? null : {
              publications: forum.publications,
              replies: forum.replies,
              publications_truncated: forum.publications_truncated,
              replies_truncated: forum.replies_truncated,
            },
            academic_actions: academicActions,
            submission_evidence: submissionEvidence,
            drafts,
            material_changes: materialChanges,
            material_dependencies_coverage: dependencyTruncated
              ? "partial"
              : "complete_for_explicit_references",
            presented,
            read,
          },
          basis,
          gaps,
        });
      }
      return {
        view,
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
      const source = (await tx`select id,connection_id,kind,external_id from public.hub_entities
          where owner_id=${p.ownerId} and id=${a.source_entity_id}`)[0];
      if (!source) throw new HubError("not_found", "Fonte não encontrada.", 404);
      if (String(source.kind) === REQUIREMENT_KIND) {
        throw new HubError(
          "invalid_request",
          "A fonte deve ser um recurso, não uma obrigação.",
          400,
        );
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
        ...(a.fulfillment === undefined ? {} : { fulfillment: a.fulfillment }),
        ...(a.quantity === undefined ? {} : { quantity: a.quantity }),
        ...(a.deadline === undefined ? {} : { deadline: a.deadline }),
      };
      const payloadHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
      const externalId = "hub:requirement:" + a.source_entity_id + "/" + a.requirement_key;
      const requirement =
        (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
        values(${p.ownerId},${source.connection_id},${REQUIREMENT_KIND},${externalId},${
          a.action.slice(0, 300)
        },${tx.json(payload as postgres.JSONValue)})
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
        values(${p.ownerId},${requirementId},${
        tx.json(payload as postgres.JSONValue)
      },${payloadHash},${
        tx.json(provenance as postgres.JSONValue)
      },${observation.coverage},${observedAt})
        on conflict(owner_id,entity_id,content_hash) do nothing`;
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
        values(${p.ownerId},${a.source_entity_id},${requirementId},${REQUIREMENT_RELATION},${
        tx.json(provenance as postgres.JSONValue)
      })
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
          (await tx`select id from public.hub_entities where owner_id=${p.ownerId} and id=${entry.entity_id} for update`)[
            0
          ];
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
        (await tx`select id from public.hub_entities where owner_id=${p.ownerId} and id=${a.entity_id}`)[
          0
        ];
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
