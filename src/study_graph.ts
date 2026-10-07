import postgres from "postgres";
import { HubError } from "./contracts.ts";

/**
 * Recorte de grafo do pacote de estudo.
 *
 * `studyGraphPage` substitui apenas a selecao de candidatos e de relacoes de
 * `Hub.activityPackage`. Para fontes nao Moodle mantem o comportamento direto
 * atual. Para uma atividade Moodle preservada descobre, na mesma secao, os
 * materiais irmaos e os expoe como vinculos derivados `section_related`.
 *
 * Paginacao: a resolucao da secao e um probe limitado (LIMIT 2) e a pagina de
 * candidatos usa sentinela/offset em SQL (LIMIT 21 OFFSET n) sobre a uniao
 * deduplicada de vinculos diretos + materiais da secao. As evidencias sao
 * buscadas so para as entidades da pagina. O banco varre os modulos/materiais da
 * secao para ordenar a uniao, mas nenhum corpo, binario ou `provider_record` e
 * lido, e nenhuma linha fora da pagina chega ao processo.
 *
 * Garantias:
 * - entidades e arcos derivados ficam restritos ao dono e a conexao focal;
 * - vinculos diretos continuam podendo atravessar conexoes do mesmo dono;
 * - o derivado nunca e `required`, nunca prova leitura e nunca carrega direitos
 *   de redistribuicao (a evidencia derivada nao tem `rights`);
 * - mais de uma secao candidata (LIMIT 2) nao elege secao: informa ambiguidade e
 *   mantem somente os vinculos diretos.
 */

export const DIRECT_RELATION_KINDS = [
  "required",
  "related",
  "suggested",
  "has_content",
  "references",
];

/**
 * Somente material de leitura da mesma secao. Conclusao, notas, outras
 * atividades, foruns e post pessoal ficam fora.
 */
export const SECTION_MATERIAL_KINDS = ["page", "book", "url", "resource"];

export const SECTION_RELATED_KIND = "section_related";

export const SECTION_COVERAGE_NOTE =
  "section_related e derivado da mesma secao Moodle e restrito ao dono e a conexao focal; nunca vira required/read e nao autoriza redistribuicao.";

export const SECTION_AMBIGUITY_GAP =
  "Mais de uma secao candidata para a atividade; usei somente os vinculos diretos preservados.";

export const SECTION_MISSING_GAP =
  "Secao do modulo nao preservada; material da mesma secao nao foi descoberto.";

export interface StudyGraphEntity {
  id: string;
  connection_id: string;
  kind: string;
  title: string;
}

export interface StudyGraphRelation {
  entity_id: string;
  kind: string;
  evidence: Record<string, unknown>;
}

export interface SectionCoverage {
  mode: "direct" | "section";
  provider: string | null;
  focal_kind: string;
  connection_id: string;
  section_id: string | null;
  section_external_id: string | null;
  section_title: string | null;
  /** 0, 1 ou 2 (2 significa "duas ou mais", por LIMIT 2). */
  section_candidates: number;
  modules_scanned: number;
  derived_entities: number;
  ambiguous: boolean;
  note: string;
}

export interface StudyGraphPage {
  /** Ate 21 entidades (sentinela 20) ordenadas por titulo/id. */
  entities: StudyGraphEntity[];
  /** Relacoes das primeiras 20 entidades: tipos diretos existentes + `section_related`. */
  relations: StudyGraphRelation[];
  next_offset: number | null;
  section_coverage: SectionCoverage;
  gaps: string[];
}

interface SectionRef {
  section_id: string;
  external_id: string;
  title: string;
}

interface DecisionRow {
  provider: string | null;
  focal_kind: string;
  connection_id: string;
  section_candidate_count: number;
  section: SectionRef | null;
  module_resolved: boolean;
}

interface PageRow {
  entities: StudyGraphEntity[];
  relations: StudyGraphRelation[];
  modules_scanned: number;
  derived_entities: number;
}

/** Resolve a secao focal (0, 1 ou >=2) sem ler o grafo inteiro. */
async function resolveSection(
  tx: postgres.TransactionSql,
  ownerId: string,
  activityId: string,
): Promise<DecisionRow | null> {
  const rows = (await tx`
    with section_candidates as (
      -- Focal e modulo: secao -> has_module -> focal.
      select s.id as section_id, s.external_id, s.title
      from public.hub_entities f
      join public.hub_relations r on r.owner_id=f.owner_id and r.to_id=f.id and r.kind='has_module'
      join public.hub_entities s on s.owner_id=r.owner_id and s.id=r.from_id
      where f.owner_id=${ownerId} and f.id=${activityId} and f.kind='module'
        and s.kind='section' and s.connection_id=f.connection_id
        and (f.state->>'section_id' is null or s.state->>'section_id' is null
          or (f.state->>'section_id'=s.state->>'section_id'
            and (f.state->>'course_id' is null or s.state->>'course_id' is null
              or f.state->>'course_id'=s.state->>'course_id')))
      union
      -- Focal e conteudo: modulo -> has_content -> focal, depois a secao do modulo.
      select s.id, s.external_id, s.title
      from public.hub_entities f
      join public.hub_relations cr on cr.owner_id=f.owner_id and cr.to_id=f.id and cr.kind='has_content'
      join public.hub_entities m on m.owner_id=cr.owner_id and m.id=cr.from_id
      join public.hub_relations hr on hr.owner_id=m.owner_id and hr.to_id=m.id and hr.kind='has_module'
      join public.hub_entities s on s.owner_id=hr.owner_id and s.id=hr.from_id
      where f.owner_id=${ownerId} and f.id=${activityId} and f.kind not in ('module','section')
        and m.kind='module' and m.connection_id=f.connection_id
        and s.kind='section' and s.connection_id=f.connection_id
        and (m.state->>'section_id' is null or s.state->>'section_id' is null
          or (m.state->>'section_id'=s.state->>'section_id'
            and (m.state->>'course_id' is null or s.state->>'course_id' is null
              or m.state->>'course_id'=s.state->>'course_id')))
      union
      -- Focal e a propria secao.
      select s.id, s.external_id, s.title
      from public.hub_entities s
      where s.owner_id=${ownerId} and s.id=${activityId} and s.kind='section'
    ),
    section_probe as (select * from section_candidates limit 2)
    select c.provider,
           f.kind as focal_kind,
           f.connection_id,
           (select count(*)::int from section_probe) as section_candidate_count,
           (select jsonb_build_object('section_id',section_id,'external_id',external_id,'title',title)
              from section_probe limit 1) as section,
           (f.kind = 'module' or exists (
              select 1 from public.hub_relations r
              join public.hub_entities m on m.owner_id=r.owner_id and m.id=r.from_id
              where r.owner_id=${ownerId} and r.to_id=${activityId} and r.kind='has_content'
                and m.kind='module' and m.connection_id=f.connection_id)) as module_resolved
    from public.hub_entities f
    join public.hub_connections c on c.owner_id=f.owner_id and c.id=f.connection_id
    where f.owner_id=${ownerId} and f.id=${activityId}`) as unknown as DecisionRow[];
  return rows[0] ?? null;
}

/**
 * Pagina candidatos em SQL e traz as evidencias somente das entidades da pagina.
 * `sectionId` nulo (nao Moodle, sem secao ou ambiguidade) desliga a expansao.
 */
async function graphPage(
  tx: postgres.TransactionSql,
  ownerId: string,
  activityId: string,
  connectionId: string,
  sectionId: string | null,
  offset: number,
): Promise<PageRow> {
  const rows = (await tx`
    with section_modules as (
      select m.id as module_id, m.state as module_state
      from public.hub_relations hr
      join public.hub_entities m on m.owner_id=hr.owner_id and m.id=hr.to_id
      join public.hub_entities s on s.owner_id=hr.owner_id and s.id=hr.from_id
      where hr.owner_id=${ownerId} and hr.from_id=${sectionId} and hr.kind='has_module'
        and m.kind='module' and m.connection_id=${connectionId}
        and s.kind='section' and s.connection_id=${connectionId}
        and (m.state->>'section_id' is null or s.state->>'section_id' is null
          or (m.state->>'section_id'=s.state->>'section_id'
            and (m.state->>'course_id' is null or s.state->>'course_id' is null
              or m.state->>'course_id'=s.state->>'course_id')))
    ),
    direct as (
      select e.id, e.connection_id, e.kind, e.title
      from public.hub_relations r
      join public.hub_entities e on e.owner_id=r.owner_id and e.id=r.to_id
      where r.owner_id=${ownerId} and r.from_id=${activityId}
        and r.kind in ${tx(DIRECT_RELATION_KINDS)}
    ),
    derived as (
      select c.id, c.connection_id, c.kind, c.title
      from section_modules sm
      join public.hub_relations cr on cr.owner_id=${ownerId} and cr.from_id=sm.module_id and cr.kind='has_content'
      join public.hub_entities c on c.owner_id=cr.owner_id and c.id=cr.to_id
      where c.connection_id=${connectionId} and c.kind in ${tx(SECTION_MATERIAL_KINDS)}
        and c.id <> ${activityId}
      union
      -- Materials preservados nao gravam has_content: o vinculo e a igualdade
      -- exata dos IDs decimais (numero ou texto), na mesma conexao; null nao e ID.
      select e.id, e.connection_id, e.kind, e.title
      from section_modules sm
      join public.hub_entities e on e.owner_id=${ownerId} and e.connection_id=${connectionId}
        and e.kind='resource'
      where sm.module_state->>'course_id' ~ '^[1-9][0-9]*$'
        and sm.module_state->>'module_id' ~ '^[1-9][0-9]*$'
        and e.state->>'course_id' = sm.module_state->>'course_id'
        and e.state->>'module_id' = sm.module_state->>'module_id'
        and e.id <> ${activityId}
    ),
    merged as (
      select id, connection_id, kind, title from direct
      union
      select id, connection_id, kind, title from derived
    ),
    candidates as (
      select distinct on (id) id, connection_id, kind, title from merged order by id
    ),
    ordered as (select * from candidates order by title, id),
    page_rows as (select * from ordered limit 21 offset ${offset}),
    page_ids as (select id from page_rows order by title, id limit 20),
    relations_page as (
      select r.to_id as entity_id, r.kind as kind, r.evidence as evidence,
             null::text as module_id, null::text as qualification
      from public.hub_relations r
      where r.owner_id=${ownerId} and r.from_id=${activityId}
        and r.kind in ${tx(DIRECT_RELATION_KINDS)}
        and r.to_id in (select id from page_ids)
      union all
      select c.id, ${SECTION_RELATED_KIND}::text,
             jsonb_build_object(
               'reason','same_section',
               'connection_id',${connectionId}::text,
               'section_id',${sectionId}::text,
               'module_id',sm.module_id,
               'qualification','module_has_content',
               'provenance',jsonb_build_object('section_has_module',hr.evidence,'module_has_content',cr.evidence)),
             sm.module_id::text, 'module_has_content'
      from section_modules sm
      join public.hub_relations cr on cr.owner_id=${ownerId} and cr.from_id=sm.module_id and cr.kind='has_content'
      join public.hub_entities c on c.owner_id=cr.owner_id and c.id=cr.to_id
      join public.hub_relations hr on hr.owner_id=${ownerId} and hr.from_id=${sectionId}
        and hr.to_id=sm.module_id and hr.kind='has_module'
      where c.connection_id=${connectionId} and c.kind in ${tx(SECTION_MATERIAL_KINDS)}
        and c.id in (select id from page_ids) and c.id <> ${activityId}
      union all
      select e.id, ${SECTION_RELATED_KIND}::text,
             jsonb_build_object(
               'reason','same_section',
               'connection_id',${connectionId}::text,
               'section_id',${sectionId}::text,
               'module_id',sm.module_id,
               'qualification','preserved_material',
               'provenance',jsonb_build_object('section_has_module',hr.evidence,'module_has_content',null)),
             sm.module_id::text, 'preserved_material'
      from section_modules sm
      join public.hub_entities e on e.owner_id=${ownerId} and e.connection_id=${connectionId}
        and e.kind='resource'
      join public.hub_relations hr on hr.owner_id=${ownerId} and hr.from_id=${sectionId}
        and hr.to_id=sm.module_id and hr.kind='has_module'
      where sm.module_state->>'course_id' ~ '^[1-9][0-9]*$'
        and sm.module_state->>'module_id' ~ '^[1-9][0-9]*$'
        and e.state->>'course_id' = sm.module_state->>'course_id'
        and e.state->>'module_id' = sm.module_state->>'module_id'
        and e.id in (select id from page_ids) and e.id <> ${activityId}
    )
    select
      coalesce((select jsonb_agg(
        jsonb_build_object('id',id,'connection_id',connection_id,'kind',kind,'title',title)
        order by title,id) from page_rows), '[]'::jsonb) as entities,
      coalesce((select jsonb_agg(
        jsonb_build_object('entity_id',entity_id,'kind',kind,'evidence',evidence)
        order by entity_id,kind,module_id,qualification) from relations_page), '[]'::jsonb) as relations,
      (select count(*)::int from section_modules) as modules_scanned,
      (select count(*)::int from (select distinct id from derived) d) as derived_entities`) as unknown as PageRow[];
  return rows[0] ?? { entities: [], relations: [], modules_scanned: 0, derived_entities: 0 };
}

export async function studyGraphPage(
  tx: postgres.TransactionSql,
  ownerId: string,
  activityId: string,
  offset: number,
): Promise<StudyGraphPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new HubError("invalid_offset", "Página inválida.");
  }
  const decision = await resolveSection(tx, ownerId, activityId);
  if (!decision) throw new HubError("not_found", "Atividade não encontrada.", 404);

  const sectionCount = decision.provider === "moodle"
    ? Number(decision.section_candidate_count ?? 0)
    : 0;
  const ambiguous = sectionCount > 1;
  const section = !ambiguous && sectionCount === 1 ? decision.section ?? null : null;

  const page = await graphPage(
    tx,
    ownerId,
    activityId,
    decision.connection_id,
    section?.section_id ?? null,
    offset,
  );
  const entities = page.entities ?? [];
  const nextOffset = entities.length > 20 ? offset + 20 : null;

  const gaps: string[] = [];
  if (ambiguous) gaps.push(SECTION_AMBIGUITY_GAP);
  else if (decision.provider === "moodle" && decision.module_resolved === true && !section) {
    gaps.push(SECTION_MISSING_GAP);
  }

  return {
    entities,
    relations: page.relations ?? [],
    next_offset: nextOffset,
    section_coverage: {
      mode: section ? "section" : "direct",
      provider: decision.provider ?? null,
      focal_kind: decision.focal_kind,
      connection_id: decision.connection_id,
      section_id: section?.section_id ?? null,
      section_external_id: section?.external_id ?? null,
      section_title: section?.title ?? null,
      section_candidates: sectionCount,
      modules_scanned: Number(page.modules_scanned ?? 0),
      derived_entities: Number(page.derived_entities ?? 0),
      ambiguous,
      note: SECTION_COVERAGE_NOTE,
    },
    gaps,
  };
}
