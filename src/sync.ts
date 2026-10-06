import { Hub } from "./domain.ts";
import { asOwner } from "./db.ts";
import { Jobs } from "./jobs.ts";
import { type Coverage, HubError, type Principal } from "./contracts.ts";
import type { ConnectionService } from "./connections.ts";
import type { MoodleRecord, MoodleResult } from "./adapters/moodle.ts";
import { sha256Hex } from "./migration.ts";

type ClaimedJob = NonNullable<Awaited<ReturnType<Jobs["claim"]>>>;

/**
 * Sincronizacao duravel de conteudo Moodle.
 *
 * - courses() preserva o comportamento anterior: um lote que le os cursos da
 *   conta e grava uma observacao por curso.
 * - courseContent() e um lote dirigido e limitado de um unico curso: estrutura
 *   (secoes e modulos), Page, Book, resource, url, foruns/discussoes/posts,
 *   Feedback e itens, assignments/enunciados/datas e conclusao.
 * - So metodos auditados do adaptador sao chamados. Funcoes ausentes, recusadas
 *   ou bloqueadas viram lacunas de cobertura explicitas; nada e apagado.
 * - Observacoes sao inseridas de forma independente e deduplicadas por hash.
 * - A projecao do provedor no estado da entidade e mesclada (jsonb ||), para nao
 *   sobrescrever dimensoes do usuario (user_report, memoria, edicao).
 */

/** Prefixo do kind do lote dirigido. O id do curso e duravel no proprio job. */
export const COURSE_JOB_PREFIX = "moodle_course:";

export function courseJobKind(courseId: number): string {
  return COURSE_JOB_PREFIX + courseId;
}

export function parseCourseJobKind(kind: string): number | null {
  if (typeof kind !== "string" || !kind.startsWith(COURSE_JOB_PREFIX)) return null;
  const raw = kind.slice(COURSE_JOB_PREFIX.length);
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Limites do lote dirigido. Excedente vira truncamento explicito, nunca perda. */
export const MAX_SYNC_FORUMS = 50;
/** Tamanho da janela de discussoes pedida ao provedor (perpage). */
export const MAX_SYNC_DISCUSSIONS_PER_FORUM = 20;
/** Tamanho da janela de posts por chamada (offset/limit sobre a lista completa). */
export const MAX_SYNC_POSTS_PER_DISCUSSION = 100;
export const MAX_SYNC_FEEDBACKS = 50;
export const MAX_SYNC_FEEDBACK_ITEMS = 100;
/**
 * Orcamento de chamadas do provedor por execucao na fase de foruns/discussoes/
 * posts. Mantem cada execucao bounded para o Edge; a janela seguinte fica no
 * checkpoint. O restante do lote dirigido (estrutura, feedbacks, etc.) tem
 * numero fixo de chamadas.
 */
export const MAX_SYNC_FORUM_CALLS_PER_RUN = 40;
/** Teto de paginas de discussoes por forum (guarda contra has_more patologico). */
export const MAX_SYNC_DISCUSSION_PAGES_PER_FORUM = 50;
/** Kind privado do checkpoint duravel de travessia (owner + conexao + curso). */
export const SYNC_CHECKPOINT_KIND = "sync_checkpoint";

export interface SyncGap {
  readonly stage: string;
  readonly coverage: Coverage;
  readonly error_code: string | null;
  readonly moodle_code: string | null;
}

export interface SyncCourseSummary {
  readonly course_id: number;
  readonly coverage: Coverage;
  readonly gaps: readonly SyncGap[];
  readonly counts: Readonly<Record<string, number>>;
  readonly truncated: boolean;
  readonly observed_at: string;
  readonly bounded: Readonly<Record<string, number>>;
  /** Progresso durável da travessia de fóruns/discussões/posts. */
  readonly checkpoint?: {
    readonly resumed: boolean;
    readonly pending: boolean;
    readonly forum_index: number;
    readonly discussion_page: number;
    readonly discussion_index: number;
    readonly post_offset: number;
  };
}

export interface SyncCourseRun {
  readonly job: Record<string, unknown>;
  readonly directed: boolean;
  readonly summary: SyncCourseSummary;
}

/** Resultado de um lote. `job` fica opcional para o caso ocioso (nenhum lote). */
export interface SyncRunResult {
  readonly state?: "idle";
  readonly job?: Record<string, unknown>;
  readonly directed?: boolean;
  readonly summary?: SyncCourseSummary;
}

export interface SyncOptions {
  /** Orcamento de chamadas da fase de foruns por execucao. Padrao 40. */
  readonly forumCallBudget?: number;
}

/** Ponteiro duravel da travessia de foruns/discussoes/posts de um curso. */
interface ForumCheckpoint {
  readonly version: number;
  readonly course_id: number;
  readonly forum_index: number;
  readonly discussion_page: number;
  readonly discussion_index: number;
  readonly discussion_id: number | null;
  readonly post_offset: number;
  readonly updated_at: string;
}

const COVERAGE_RANK: Readonly<Record<Coverage, number>> = {
  complete: 0,
  partial: 1,
  timeout: 2,
  parsing_error: 3,
  unavailable: 4,
  denied: 5,
  expired: 6,
};

function worstCoverage(list: readonly Coverage[]): Coverage {
  let worst: Coverage = "complete";
  for (const value of list) {
    if (COVERAGE_RANK[value] > COVERAGE_RANK[worst]) worst = value;
  }
  return worst;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asArray(value: unknown): MoodleRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MoodleRecord =>
    item !== null && typeof item === "object" && !Array.isArray(item)
  );
}

function numericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function recordTitle(record: MoodleRecord, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 300);
  }
  return "Item";
}

function jsonable(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function provenanceOf(
  connectionId: string,
  locator: string,
  observedAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    system: "moodle",
    connection_id: connectionId,
    locator,
    observed_at: observedAt,
    ...extra,
  };
}

function evidenceOf(
  connectionId: string,
  locator: string,
  source: string,
  observedAt: string,
): Record<string, unknown> {
  return {
    system: "moodle",
    connection_id: connectionId,
    locator,
    source,
    observed_at: observedAt,
  };
}

/** Autor do post (userid bruto) para validar o accountsubject em rascunhos. */
function postAuthorUserId(record: MoodleRecord): number | null {
  const direct = numericId(record.userid);
  if (direct !== null) return direct;
  const author = record.author;
  if (author !== null && typeof author === "object" && !Array.isArray(author)) {
    const obj = author as MoodleRecord;
    return numericId(obj.id) ?? numericId(obj.userid);
  }
  return null;
}

export class Sync {
  readonly jobs: Jobs;
  private readonly forumCallBudget: number;
  constructor(
    private hub: Hub,
    private connections: ConnectionService,
    options: SyncOptions = {},
  ) {
    this.jobs = new Jobs(hub.db);
    const requested = options.forumCallBudget ?? MAX_SYNC_FORUM_CALLS_PER_RUN;
    this.forumCallBudget = Number.isSafeInteger(requested) && requested > 0
      ? requested
      : MAX_SYNC_FORUM_CALLS_PER_RUN;
  }

  /** Lote de cursos da conta. Comportamento preservado. */
  async courses(p: Principal, connectionId: string) {
    await this.connections.parent(p, connectionId);
    const job = await this.jobs.enqueue(p, connectionId, "moodle_courses");
    return await this.run(p, job.id);
  }

  /**
   * Lote dirigido de um curso. O curso e persistido no kind do job, portanto e
   * retomavel sem depender do processo que enfileirou.
   */
  async courseContent(
    p: Principal,
    connectionId: string,
    courseId: number,
  ): Promise<SyncCourseRun> {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) {
      throw new HubError("invalid_id", "Identificador de curso invalido.", 400);
    }
    await this.connections.parent(p, connectionId);
    const job = await this.jobs.enqueue(p, connectionId, courseJobKind(courseId));
    const outcome = await this.run(p, job.id);
    return outcome as SyncCourseRun;
  }

  /** Alias curto de courseContent. */
  async course(p: Principal, connectionId: string, courseId: number): Promise<SyncCourseRun> {
    return await this.courseContent(p, connectionId, courseId);
  }

  async run(p: Principal, expectedId?: string): Promise<SyncRunResult> {
    const job = await this.jobs.claim(p, expectedId);
    if (!job) return { state: "idle" };
    // A queued job may run before the newly requested one; its receipt makes this explicit.
    const directed = expectedId === undefined || expectedId === job.id;
    try {
      if (job.kind === "moodle_courses") {
        return await this.runCoursesJob(p, job, directed);
      }
      const courseId = parseCourseJobKind(job.kind);
      if (courseId !== null) {
        return await this.runCourseJob(p, job, courseId, directed);
      }
      return {
        job: await this.jobs.finish(p, job.id, job.attempts, "unavailable", null) as Record<
          string,
          unknown
        >,
        directed,
      };
    } catch {
      return {
        job: await this.jobs.finish(p, job.id, job.attempts, "unavailable" as Coverage, null, {
          reason: "A fonte nao pode ser atualizada. A memoria foi preservada.",
        }) as Record<string, unknown>,
        directed,
      };
    }
  }

  // -- Projecao duravel ---------------------------------------------------

  /**
   * Upsert da entidade com mesclagem do estado (jsonb ||). A projecao do
   * provedor atualiza apenas as chaves enviadas; dimensoes do usuario
   * (user_report, memoria, edicao) permanecem intactas.
   */
  private async upsertEntity(
    p: Principal,
    connectionId: string,
    kind: string,
    externalId: string,
    title: string,
    state: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await asOwner(this.hub.db, p, async (tx) => {
      const parent =
        await tx`select id from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId}`;
      if (!parent.length) throw new HubError("not_found", "Registro nao encontrado.", 404);
      const rows =
        await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${p.ownerId},${connectionId},${kind},${externalId},${title},${
          tx.json(jsonable(state))
        }) on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title,state=hub_entities.state || excluded.state returning id,state`;
      return rows[0] as Record<string, unknown>;
    });
  }

  /** Observacao independente, deduplicada por (owner, entity, content_hash). */
  private async observe(
    p: Principal,
    entityId: string,
    content: unknown,
    provenance: Record<string, unknown>,
    coverage: Coverage,
    observedAt: string,
  ): Promise<void> {
    const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(content ?? null)));
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${p.ownerId},${entityId},${
        tx.json(jsonable(content))
      },${hash},${
        tx.json(jsonable(provenance))
      },${coverage},${observedAt}) on conflict(owner_id,entity_id,content_hash) do nothing`;
    });
  }

  private async relate(
    p: Principal,
    fromId: string,
    toId: string,
    kind: string,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${p.ownerId},${fromId},${toId},${kind},${
        tx.json(jsonable(evidence))
      }) on conflict(owner_id,from_id,to_id,kind) do nothing`;
    });
  }

  // -- Checkpoint duravel da travessia de foruns --------------------------

  /**
   * Chave privada do checkpoint: owner_id + connection_id (na unicidade de
   * hub_entities) + formato do external_id por curso.
   */
  private checkpointExternalId(courseId: number): string {
    return "course/" + courseId;
  }

  /** Le o ponteiro duravel; estado ausente ou malformado vira travessia nova. */
  private async loadCheckpoint(
    p: Principal,
    connectionId: string,
    externalId: string,
  ): Promise<ForumCheckpoint | null> {
    const rows = await asOwner(
      this.hub.db,
      p,
      (tx) =>
        tx`select state from public.hub_entities where owner_id=${p.ownerId} and connection_id=${connectionId} and kind=${SYNC_CHECKPOINT_KIND} and external_id=${externalId}`,
    );
    if (!rows.length) return null;
    const state = rows[0].state as Record<string, unknown> | null;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    // Um marcador concluido e inerte: a proxima chamada recomeca a travessia.
    if (state.completed === true) return null;
    const count = (value: unknown): number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const courseId = numericId(state.course_id);
    if (courseId === null) return null;
    return {
      version: 1,
      course_id: courseId,
      forum_index: count(state.forum_index),
      discussion_page: count(state.discussion_page),
      discussion_index: count(state.discussion_index),
      discussion_id: numericId(state.discussion_id),
      post_offset: count(state.post_offset),
      updated_at: typeof state.updated_at === "string" ? state.updated_at : nowIso(),
    };
  }

  /** Grava/substitui o ponteiro duravel. O estado e substituido, nao mesclado. */
  private async saveCheckpoint(
    p: Principal,
    connectionId: string,
    checkpoint: ForumCheckpoint,
  ): Promise<void> {
    await asOwner(this.hub.db, p, async (tx) => {
      const parent =
        await tx`select id from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId}`;
      if (!parent.length) throw new HubError("not_found", "Registro nao encontrado.", 404);
      await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${p.ownerId},${connectionId},${SYNC_CHECKPOINT_KIND},${
        this.checkpointExternalId(checkpoint.course_id)
      },${"Checkpoint de sincronizacao do curso " + checkpoint.course_id},${
        tx.json(jsonable(checkpoint))
      }) on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title,state=excluded.state`;
    });
  }

  /**
   * Reseta o ponteiro somente apos a travessia completa. Nao usa delete porque
   * o papel autenticado tem select/insert/update em hub_entities, mas nao
   * delete; a linha vira um marcador concluido inerte.
   */
  private async completeCheckpoint(
    p: Principal,
    connectionId: string,
    courseId: number,
  ): Promise<void> {
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`update public.hub_entities set title=${
        "Checkpoint concluido do curso " + courseId
      },state=${
        tx.json({ version: 1, course_id: courseId, completed: true, updated_at: nowIso() })
      } where owner_id=${p.ownerId} and connection_id=${connectionId} and kind=${SYNC_CHECKPOINT_KIND} and external_id=${
        this.checkpointExternalId(courseId)
      }`;
    });
  }

  // -- Lote de cursos (preservado) ----------------------------------------

  private async runCoursesJob(
    p: Principal,
    job: ClaimedJob,
    directed: boolean,
  ) {
    const moodle = await this.connections.moodle(p, job.connection_id);
    const result = await moodle.listCourses();
    let count = 0;
    for (const c of result.data ?? []) {
      const externalId = String(c.id);
      const entity = await this.upsertEntity(
        p,
        job.connection_id,
        "course",
        externalId,
        String(c.fullname ?? c.shortname ?? "Curso"),
        { provider_record: c },
      );
      await this.observe(
        p,
        entity.id as string,
        c,
        {
          system: "moodle",
          connection_id: job.connection_id,
          external_id: externalId,
          observed_at: result.observed_at,
        },
        result.coverage,
        result.observed_at,
      );
      count++;
    }
    return {
      job: await this.jobs.finish(p, job.id, job.attempts, result.coverage, {
        completed_at: result.observed_at,
      }, { resources: count, error_code: result.error_code }) as Record<string, unknown>,
      directed,
    };
  }

  // -- Lote dirigido de um curso -----------------------------------------

  private async runCourseJob(
    p: Principal,
    job: ClaimedJob,
    courseId: number,
    directed: boolean,
  ): Promise<SyncCourseRun> {
    const moodle = await this.connections.moodle(p, job.connection_id);
    const connectionId = job.connection_id;
    const gaps: SyncGap[] = [];
    const coverages: Coverage[] = [];
    const counts: Record<string, number> = {};
    let truncated = false;
    let checkpointResumed = false;
    let checkpointPending = false;

    const bump = (key: string, by = 1): void => {
      counts[key] = (counts[key] ?? 0) + by;
    };
    const gapStages = new Set<string>();
    const note = (
      stage: string,
      result: {
        coverage: Coverage;
        error_code: string | null;
        error_detail?: { moodle_code?: string };
      },
    ): void => {
      coverages.push(result.coverage);
      if (result.coverage !== "complete" || result.error_code !== null) {
        if (!gapStages.has(stage)) {
          gapStages.add(stage);
          gaps.push({
            stage,
            coverage: result.coverage,
            error_code: result.error_code,
            moodle_code: result.error_detail?.moodle_code ?? null,
          });
        }
      }
    };

    // Um recorte local (janela limitada) nunca pode continuar "complete".
    const markTruncated = (stage: string): void => {
      truncated = true;
      coverages.push("partial");
      if (!gapStages.has(stage)) {
        gapStages.add(stage);
        gaps.push({ stage, coverage: "partial", error_code: null, moodle_code: null });
      }
    };

    // Curso: resolve o titulo pela listagem da conta (uma chamada limitada).
    const listing = await moodle.listCourses();
    note("courses", listing);
    const courseRecord = (listing.data ?? []).find((c) => numericId(c.id) === courseId) ?? null;
    const courseTitle = courseRecord
      ? recordTitle(courseRecord, "fullname", "shortname")
      : "Curso " + courseId;
    const courseLocator = "moodle:course/" + courseId;
    const courseEntity = await this.upsertEntity(
      p,
      connectionId,
      "course",
      String(courseId),
      courseTitle,
      courseRecord ? { provider_record: courseRecord } : { course_id: courseId },
    );
    const courseEntityId = courseEntity.id as string;
    await this.observe(
      p,
      courseEntityId,
      courseRecord ?? { id: courseId },
      provenanceOf(connectionId, courseLocator, listing.observed_at, {
        external_id: String(courseId),
        course_id: courseId,
      }),
      listing.coverage,
      listing.observed_at,
    );
    bump("courses");

    // Estrutura: secoes e modulos, com indice de modulos para as relacoes.
    const contents = await moodle.getCourseContents(courseId);
    note("structure", contents);
    const moduleIndex = new Map<string, string>();
    for (const section of contents.data ?? []) {
      const sectionId = numericId(section.id);
      if (sectionId === null) continue;
      const sectionLocator = courseLocator + "/section/" + sectionId;
      const sectionEntity = await this.upsertEntity(
        p,
        connectionId,
        "section",
        sectionLocator,
        recordTitle(section, "name", "section"),
        {
          course_id: courseId,
          section_id: sectionId,
          sectionnum: section.section ?? null,
          visible: section.visible ?? null,
          provider_record: section,
        },
      );
      bump("sections");
      await this.observe(
        p,
        sectionEntity.id as string,
        section,
        provenanceOf(connectionId, sectionLocator, contents.observed_at, {
          course_id: courseId,
          section_id: sectionId,
        }),
        contents.coverage,
        contents.observed_at,
      );
      await this.relate(
        p,
        courseEntityId,
        sectionEntity.id as string,
        "has_section",
        evidenceOf(connectionId, courseLocator, "structure", contents.observed_at),
      );
      bump("relations");
      for (const module of asArray(section.modules)) {
        const moduleId = numericId(module.id);
        if (moduleId === null) continue;
        const moduleLocator = courseLocator + "/module/" + moduleId;
        const instance = numericId(module.instance);
        const modname = typeof module.modname === "string" ? module.modname : null;
        const moduleEntity = await this.upsertEntity(
          p,
          connectionId,
          "module",
          moduleLocator,
          recordTitle(module, "name"),
          {
            course_id: courseId,
            section_id: sectionId,
            module_id: moduleId,
            modname,
            instance,
            url: typeof module.url === "string" ? module.url : null,
            visible: module.visible ?? null,
            uservisible: module.uservisible ?? null,
            provider_record: module,
          },
        );
        bump("modules");
        await this.observe(
          p,
          moduleEntity.id as string,
          module,
          provenanceOf(connectionId, moduleLocator, contents.observed_at, {
            course_id: courseId,
            section_id: sectionId,
            module_id: moduleId,
          }),
          contents.coverage,
          contents.observed_at,
        );
        await this.relate(
          p,
          sectionEntity.id as string,
          moduleEntity.id as string,
          "has_module",
          evidenceOf(connectionId, sectionLocator, "structure", contents.observed_at),
        );
        bump("relations");
        moduleIndex.set("cm:" + moduleId, moduleEntity.id as string);
        if (modname !== null && instance !== null) {
          moduleIndex.set(modname + ":" + instance, moduleEntity.id as string);
        }
      }
    }

    // Projecao de uma lista de conteudo, com relacao qualificada ao modulo.
    const persistContent = async (
      kind: string,
      modname: string,
      records: readonly MoodleRecord[],
      result: MoodleResult<MoodleRecord[]>,
      extraState: (record: MoodleRecord) => Record<string, unknown> = () => ({}),
    ): Promise<Map<string, string>> => {
      const ids = new Map<string, string>();
      for (const record of records) {
        const instance = numericId(record.id);
        if (instance === null) continue;
        const locator = courseLocator + "/" + kind + "/" + instance;
        const cmid = numericId(record.coursemodule) ?? numericId(record.cmid);
        const entity = await this.upsertEntity(
          p,
          connectionId,
          kind,
          locator,
          recordTitle(record, "name", "subject"),
          {
            course_id: courseId,
            instance_id: instance,
            coursemodule: cmid,
            module_name: modname,
            provider_record: record,
            ...extraState(record),
          },
        );
        bump(kind + "s");
        await this.observe(
          p,
          entity.id as string,
          record,
          provenanceOf(connectionId, locator, result.observed_at, {
            course_id: courseId,
            instance_id: instance,
          }),
          result.coverage,
          result.observed_at,
        );
        const target = (cmid !== null ? moduleIndex.get("cm:" + cmid) : undefined) ??
          moduleIndex.get(modname + ":" + instance);
        if (target) {
          await this.relate(
            p,
            target,
            entity.id as string,
            "has_content",
            evidenceOf(connectionId, locator, "module_instance", result.observed_at),
          );
        } else {
          await this.relate(
            p,
            courseEntityId,
            entity.id as string,
            "has_content",
            evidenceOf(connectionId, locator, "course_unmatched_module", result.observed_at),
          );
        }
        bump("relations");
        ids.set(String(instance), entity.id as string);
      }
      return ids;
    };

    const pages = await moodle.getPages([courseId]);
    note("pages", pages);
    await persistContent("page", "page", pages.data ?? [], pages);

    const books = await moodle.getBooks([courseId]);
    note("books", books);
    await persistContent("book", "book", books.data ?? [], books);

    const resources = await moodle.getResources([courseId]);
    note("resources", resources);
    await persistContent("resource", "resource", resources.data ?? [], resources);

    const urls = await moodle.getUrls([courseId]);
    note("urls", urls);
    await persistContent("url", "url", urls.data ?? [], urls);

    const forums = await moodle.getForums([courseId]);
    note("forums", forums);
    const forumRecords = (forums.data ?? []).slice(0, MAX_SYNC_FORUMS);
    if ((forums.data ?? []).length > MAX_SYNC_FORUMS) markTruncated("forums");
    const forumIds = await persistContent("forum", "forum", forumRecords, forums);

    // Foruns -> discussoes -> posts.
    //
    // O provedor pagina discussoes (has_more) e o adaptador fatia posts por
    // offset/limit localmente sobre a lista completa. A travessia e duravel em
    // um checkpoint privado por (owner, conexao, curso) em hub_entities(state):
    // forum, pagina de discussoes, indice na pagina, id da discussao e offset
    // de posts. Cada execucao consome no maximo this.forumCallBudget chamadas
    // desta fase; ao esgotar, o checkpoint guarda a proxima janela e a
    // execucao termina partial. Uma falha mantem o ponteiro e o checkpoint so e
    // marcado como concluido quando a travessia termina.
    const checkpointId = this.checkpointExternalId(courseId);
    const checkpoint = await this.loadCheckpoint(p, connectionId, checkpointId);
    checkpointResumed = checkpoint !== null;
    let forumIndex = checkpoint?.forum_index ?? 0;
    let discussionPage = checkpoint?.discussion_page ?? 0;
    let discussionIndex = checkpoint?.discussion_index ?? 0;
    let discussionId = checkpoint?.discussion_id ?? null;
    let postOffset = checkpoint?.post_offset ?? 0;
    if (forumIndex < 0 || forumIndex >= forumRecords.length) {
      forumIndex = 0;
      discussionPage = 0;
      discussionIndex = 0;
      discussionId = null;
      postOffset = 0;
    }

    const perDiscussionPage = Math.min(MAX_SYNC_DISCUSSIONS_PER_FORUM, 100);
    let callsUsed = 0;
    let stoppedStage: string | null = null;
    let pageCache: {
      forumId: number;
      page: number;
      records: MoodleRecord[];
      hasMore: boolean;
      coverage: Coverage;
      observedAt: string;
    } | null = null;

    while (forumIndex < forumRecords.length) {
      const forum = forumRecords[forumIndex];
      const forumId = numericId(forum.id);
      if (forumId === null) {
        forumIndex++;
        discussionPage = 0;
        discussionIndex = 0;
        discussionId = null;
        postOffset = 0;
        pageCache = null;
        continue;
      }

      if (
        pageCache === null || pageCache.forumId !== forumId || pageCache.page !== discussionPage
      ) {
        if (callsUsed >= this.forumCallBudget) {
          stoppedStage = "discussions";
          break;
        }
        callsUsed++;
        const discussions = await moodle.getForumDiscussions(forumId, {
          page: discussionPage,
          perPage: perDiscussionPage,
        });
        note("discussions", discussions);
        pageCache = {
          forumId,
          page: discussionPage,
          records: discussions.data ?? [],
          hasMore: discussions.pagination?.has_more === true,
          coverage: discussions.coverage,
          observedAt: discussions.observed_at,
        };
        // Retoma a discussao exata do checkpoint; nunca pula apos o corte.
        if (discussionId !== null && postOffset > 0) {
          const found = pageCache.records.findIndex((record) =>
            (numericId(record.discussion) ?? numericId(record.id)) === discussionId
          );
          if (found >= 0) discussionIndex = found;
          else postOffset = 0;
        }
      }

      if (discussionIndex >= pageCache.records.length) {
        if (pageCache.hasMore) {
          if (discussionPage + 1 >= MAX_SYNC_DISCUSSION_PAGES_PER_FORUM) {
            stoppedStage = "discussions_pages";
            break;
          }
          discussionPage++;
          discussionIndex = 0;
          discussionId = null;
          postOffset = 0;
          pageCache = null;
          continue;
        }
        forumIndex++;
        discussionPage = 0;
        discussionIndex = 0;
        discussionId = null;
        postOffset = 0;
        pageCache = null;
        continue;
      }

      const discussion = pageCache.records[discussionIndex];
      const currentId = numericId(discussion.discussion) ?? numericId(discussion.id);
      if (currentId === null) {
        discussionIndex++;
        continue;
      }
      discussionId = currentId;
      const discussionLocator = courseLocator + "/forum/" + forumId + "/discussion/" + currentId;
      const forumEntityId = forumIds.get(String(forumId));

      // O upsert e idempotente: em retomada (postOffset>0) recupera o id da
      // discussao sem recontar nem reobservar a entidade.
      const discussionEntity = await this.upsertEntity(
        p,
        connectionId,
        "discussion",
        discussionLocator,
        recordTitle(discussion, "name", "subject"),
        {
          course_id: courseId,
          forum_id: forumId,
          discussion_id: currentId,
          provider_record: discussion,
        },
      );
      if (postOffset === 0) {
        bump("discussions");
        await this.observe(
          p,
          discussionEntity.id as string,
          discussion,
          provenanceOf(connectionId, discussionLocator, pageCache.observedAt, {
            course_id: courseId,
            forum_id: forumId,
            discussion_id: currentId,
          }),
          pageCache.coverage,
          pageCache.observedAt,
        );
        if (forumEntityId) {
          await this.relate(
            p,
            forumEntityId,
            discussionEntity.id as string,
            "has_discussion",
            evidenceOf(
              connectionId,
              discussionLocator,
              "forum_discussions",
              pageCache.observedAt,
            ),
          );
          bump("relations");
        }
      }

      let postsFinished = false;
      while (true) {
        if (callsUsed >= this.forumCallBudget) {
          stoppedStage = "posts";
          break;
        }
        callsUsed++;
        const posts = await moodle.getDiscussionPosts(currentId, {
          offset: postOffset,
          limit: MAX_SYNC_POSTS_PER_DISCUSSION,
        });
        // "truncated" aqui e a existencia da proxima janela de posts, nao perda.
        // So registra lacuna quando ha aviso ou erro real na chamada.
        const paginatingOnly = posts.truncated && posts.error_code === null &&
          posts.warnings.length === 0;
        if (!paginatingOnly) note("posts", posts);
        for (const post of posts.data ?? []) {
          const postId = numericId(post.id);
          if (postId === null) continue;
          const postLocator = discussionLocator + "/post/" + postId;
          const authorUserId = postAuthorUserId(post);
          const postEntity = await this.upsertEntity(
            p,
            connectionId,
            "post",
            postLocator,
            recordTitle(post, "subject"),
            {
              course_id: courseId,
              forum_id: forumId,
              discussion_id: currentId,
              post_id: postId,
              author_userid: authorUserId,
              created: post.created ?? null,
              parent: post.parent ?? null,
              provider_record: post,
            },
          );
          bump("posts");
          await this.observe(
            p,
            postEntity.id as string,
            post,
            provenanceOf(connectionId, postLocator, posts.observed_at, {
              course_id: courseId,
              forum_id: forumId,
              discussion_id: currentId,
              post_id: postId,
              author_userid: authorUserId,
            }),
            posts.coverage,
            posts.observed_at,
          );
          await this.relate(
            p,
            discussionEntity.id as string,
            postEntity.id as string,
            "has_post",
            evidenceOf(connectionId, postLocator, "discussion_posts", posts.observed_at),
          );
          bump("relations");
        }
        if (posts.truncated) {
          postOffset += MAX_SYNC_POSTS_PER_DISCUSSION;
          continue;
        }
        postsFinished = true;
        break;
      }
      if (!postsFinished) break;

      postOffset = 0;
      discussionIndex++;
    }

    if (forumIndex >= forumRecords.length) {
      if (checkpointResumed) await this.completeCheckpoint(p, connectionId, courseId);
      checkpointPending = false;
    } else {
      await this.saveCheckpoint(p, connectionId, {
        version: 1,
        course_id: courseId,
        forum_index: forumIndex,
        discussion_page: discussionPage,
        discussion_index: discussionIndex,
        discussion_id: discussionId,
        post_offset: postOffset,
        updated_at: nowIso(),
      });
      checkpointPending = true;
      markTruncated(stoppedStage ?? "discussions");
    }

    // Feedback e itens exportaveis.
    const feedbacks = await moodle.getFeedbacks([courseId]);
    note("feedbacks", feedbacks);
    const feedbackRecords = (feedbacks.data ?? []).slice(0, MAX_SYNC_FEEDBACKS);
    if ((feedbacks.data ?? []).length > MAX_SYNC_FEEDBACKS) markTruncated("feedbacks");
    const feedbackIds = await persistContent("feedback", "feedback", feedbackRecords, feedbacks);
    for (const feedback of feedbackRecords) {
      const feedbackId = numericId(feedback.id);
      if (feedbackId === null) continue;
      const feedbackEntityId = feedbackIds.get(String(feedbackId));
      const items = await moodle.getFeedbackItems(feedbackId);
      note("feedback_items", items);
      let itemRecords = items.data ?? [];
      if (itemRecords.length > MAX_SYNC_FEEDBACK_ITEMS) {
        markTruncated("feedback_items");
        itemRecords = itemRecords.slice(0, MAX_SYNC_FEEDBACK_ITEMS);
      }
      for (const item of itemRecords) {
        const itemId = numericId(item.id);
        if (itemId === null) continue;
        const locator = courseLocator + "/feedback/" + feedbackId + "/item/" + itemId;
        const itemEntity = await this.upsertEntity(
          p,
          connectionId,
          "feedback_item",
          locator,
          recordTitle(item, "name"),
          {
            course_id: courseId,
            feedback_id: feedbackId,
            item_id: itemId,
            provider_record: item,
          },
        );
        bump("feedback_items");
        await this.observe(
          p,
          itemEntity.id as string,
          item,
          provenanceOf(connectionId, locator, items.observed_at, {
            course_id: courseId,
            feedback_id: feedbackId,
            item_id: itemId,
          }),
          items.coverage,
          items.observed_at,
        );
        if (feedbackEntityId) {
          await this.relate(
            p,
            feedbackEntityId,
            itemEntity.id as string,
            "has_item",
            evidenceOf(connectionId, locator, "feedback_items", items.observed_at),
          );
          bump("relations");
        }
      }
    }

    // Assignments: enunciado e datas.
    const assignments = await moodle.getAssignments([courseId]);
    note("assignments", assignments);
    await persistContent("assignment", "assign", assignments.data ?? [], assignments);

    // Conclusao: por atividade e do curso. Ausencia vira lacuna, nao exclusao.
    const activityCompletion = await moodle.getActivitiesCompletion(courseId);
    note("completion_activities", activityCompletion);
    for (const status of asArray(activityCompletion.data?.statuses)) {
      const cmid = numericId(status.cmid);
      if (cmid === null) continue;
      const locator = courseLocator + "/completion/activity/" + cmid;
      const entity = await this.upsertEntity(
        p,
        connectionId,
        "completion_activity",
        locator,
        "Atividade " + cmid,
        {
          course_id: courseId,
          cmid,
          state: status.state ?? null,
          tracking: status.tracking ?? null,
          timecompleted: status.timecompleted ?? null,
          provider_record: status,
        },
      );
      bump("completion_activities");
      await this.observe(
        p,
        entity.id as string,
        status,
        provenanceOf(connectionId, locator, activityCompletion.observed_at, {
          course_id: courseId,
          cmid,
        }),
        activityCompletion.coverage,
        activityCompletion.observed_at,
      );
      const module = moduleIndex.get("cm:" + cmid);
      if (module) {
        await this.relate(
          p,
          module,
          entity.id as string,
          "tracks_completion",
          evidenceOf(
            connectionId,
            locator,
            "activities_completion",
            activityCompletion.observed_at,
          ),
        );
      } else {
        await this.relate(
          p,
          courseEntityId,
          entity.id as string,
          "has_completion",
          evidenceOf(
            connectionId,
            locator,
            "activities_completion",
            activityCompletion.observed_at,
          ),
        );
      }
      bump("relations");
    }

    const courseCompletion = await moodle.getCourseCompletion(courseId);
    note("course_completion", courseCompletion);
    if (courseCompletion.data) {
      const locator = courseLocator + "/completion";
      const entity = await this.upsertEntity(
        p,
        connectionId,
        "course_completion",
        locator,
        "Conclusao do curso",
        { course_id: courseId, provider_record: courseCompletion.data },
      );
      bump("course_completion");
      await this.observe(
        p,
        entity.id as string,
        courseCompletion.data,
        provenanceOf(connectionId, locator, courseCompletion.observed_at, { course_id: courseId }),
        courseCompletion.coverage,
        courseCompletion.observed_at,
      );
      await this.relate(
        p,
        courseEntityId,
        entity.id as string,
        "has_completion",
        evidenceOf(connectionId, locator, "course_completion", courseCompletion.observed_at),
      );
      bump("relations");
    }

    const coverage = worstCoverage(coverages);
    const observedAt = nowIso();
    const total = Object.entries(counts).reduce(
      (sum, [key, value]) => key === "relations" ? sum : sum + value,
      0,
    );
    const summary: SyncCourseSummary = {
      course_id: courseId,
      coverage,
      gaps,
      counts,
      truncated,
      observed_at: observedAt,
      bounded: {
        forums: MAX_SYNC_FORUMS,
        discussion_pages_per_forum: MAX_SYNC_DISCUSSION_PAGES_PER_FORUM,
        discussions_per_page: Math.min(MAX_SYNC_DISCUSSIONS_PER_FORUM, 100),
        posts_per_page: MAX_SYNC_POSTS_PER_DISCUSSION,
        forum_calls_per_run: this.forumCallBudget,
        feedbacks: MAX_SYNC_FEEDBACKS,
        feedback_items: MAX_SYNC_FEEDBACK_ITEMS,
      },
      checkpoint: {
        resumed: checkpointResumed,
        pending: checkpointPending,
        forum_index: forumIndex,
        discussion_page: discussionPage,
        discussion_index: discussionIndex,
        post_offset: postOffset,
      },
    };
    const cursor = coverage === "complete"
      ? { course_id: courseId, observed_at: observedAt }
      : null;
    const jobRow = await this.jobs.finish(p, job.id, job.attempts, coverage, cursor, {
      course_id: courseId,
      resources: total,
      relations: counts.relations ?? 0,
      gaps: gaps.length,
      truncated,
    });
    return { job: jobRow as Record<string, unknown>, directed, summary };
  }
}
