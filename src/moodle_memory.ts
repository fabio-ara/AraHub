import type { MoodleRecord, MoodleResult } from "./adapters/moodle.ts";
import { asOwner, logicalWriteBytes } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { sha256Hex } from "./migration.ts";

type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue =>
  v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const id = (v: unknown): number | null =>
  Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

export type MoodleQuery =
  | {
    kind: "structure" | "pages" | "books" | "assignments" | "forums" | "resources" | "urls";
    course_id: number;
  }
  | { kind: "discussions"; forum_id: number }
  | { kind: "posts"; discussion_id: number }
  | { kind: "own_status"; course_id: number; assignment_id: number };

/** Preserves authorized query results in the SAME graph/observation namespace as
 * Sync. No network, credentials, scheduled work or external mutations here. */
export class MoodleMemory {
  constructor(private hub: Hub) {}

  async remember<T extends MoodleRecord | MoodleRecord[]>(
    p: Principal,
    connectionId: string,
    query: MoodleQuery,
    result: MoodleResult<T>,
  ) {
    if (!result.data || !["complete", "partial"].includes(result.coverage)) {
      return { status: "not_observed", coverage: result.coverage, entity_ids: [] as string[] };
    }
    return await asOwner(this.hub.db, p, async (tx) => {
      const connection = (await tx`select id,provider_subject from public.hub_connections
        where owner_id=${p.ownerId} and id=${connectionId} and provider='moodle'`)[0];
      if (!connection) throw new HubError("not_found", "Conexão não encontrada.", 404);
      const entityIds: string[] = [];
      const currentIds = new Set<string>();
      const parent = async (kind: string, external: string, title: string, state: RecordValue) => {
        const row =
          (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state)
          values(${p.ownerId},${connectionId},${kind},${external},${title},${tx.json(json(state))})
          on conflict(owner_id,connection_id,kind,external_id) do update
            set state=hub_entities.state || excluded.state returning id`)[0];
        return String(row.id);
      };
      const relate = async (from: string, to: string, kind: string) => {
        await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
          values(${p.ownerId},${from},${to},${kind},${
          tx.json({
            system: "moodle",
            connection_id: connectionId,
            observed_at: result.observed_at,
          })
        }) on conflict(owner_id,from_id,to_id,kind) do update set evidence=excluded.evidence`;
      };
      const snapshot = async (
        kind: string,
        external: string,
        record: MoodleRecord,
        state: RecordValue,
      ) => {
        const title = String(record.name ?? record.subject ?? kind);
        const entity = await parent(kind, external, title, {});
        // Keep a late response in history without replacing a more recent source projection.
        await tx`select id from public.hub_entities where owner_id=${p.ownerId} and id=${entity} for update`;
        const newer = await tx`select id from public.hub_observation_timeline
          where owner_id=${p.ownerId} and entity_id=${entity} and observed_at>${result.observed_at}::timestamptz limit 1`;
        if (!newer.length) {
          currentIds.add(entity);
          await tx`update public.hub_entities set title=${title},state=state || ${
            tx.json(json({
              ...state,
              provider_record: record,
            }))
          }::jsonb where owner_id=${p.ownerId} and id=${entity}`;
        }
        const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(record)));
        await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at)
          values(${p.ownerId},${entity},${tx.json(json(record))},${hash},${
          tx.json({
            system: "moodle",
            connection_id: connectionId,
            locator: external,
            ...state,
            subject_userid: connection.provider_subject,
            observed_at: result.observed_at,
          })
        },${result.coverage},${result.observed_at})
          on conflict(owner_id,entity_id,content_hash) do nothing`;
        entityIds.push(entity);
        return entity;
      };
      const records = Array.isArray(result.data) ? result.data : [];
      if (query.kind === "discussions" || query.kind === "posts") {
        const isDiscussion = query.kind === "discussions";
        const parents = isDiscussion
          ? await tx`select id,state,external_id from public.hub_entities where owner_id=${p.ownerId}
            and connection_id=${connectionId} and kind='forum' and state->>'instance_id'=${
            String(query.forum_id)
          }`
          : await tx`select id,state,external_id from public.hub_entities where owner_id=${p.ownerId}
            and connection_id=${connectionId} and kind='discussion' and state->>'discussion_id'=${
            String(query.discussion_id)
          }`;
        if (parents.length !== 1) {
          return {
            status: "target_unresolved",
            coverage: result.coverage,
            entity_ids: [],
            next_step: isDiscussion ? "hub_moodle_content:forums" : "hub_moodle_discussions",
          };
        }
        const target = parents[0];
        const courseId = id(target.state.course_id);
        const forumId = isDiscussion ? query.forum_id : id(target.state.forum_id);
        if (!courseId || !forumId) {
          return { status: "target_unresolved", entity_ids: [], coverage: result.coverage };
        }
        for (const record of records) {
          const recordId = isDiscussion
            ? id(record.discussion_id ?? record.discussion)
            : id(record.id);
          if (!recordId) continue; // A discussion's `id` is a POST, not a discussion ID.
          if (
            !isDiscussion && id(record.discussionid ?? record.discussion) !== null &&
            id(record.discussionid ?? record.discussion) !== query.discussion_id
          ) continue;
          const discussionId = isDiscussion ? recordId : query.discussion_id;
          const external = `moodle:course/${courseId}/forum/${forumId}/discussion/${discussionId}` +
            (isDiscussion ? "" : `/post/${recordId}`);
          const entity = await snapshot(isDiscussion ? "discussion" : "post", external, record, {
            course_id: courseId,
            forum_id: forumId,
            discussion_id: discussionId,
            ...(isDiscussion ? {} : {
              post_id: recordId,
              author_userid: id(
                record.userid ?? object(record.author).id ?? object(record.author).userid,
              ),
              parent: record.parentid ?? record.parent ?? null,
              created: record.created ?? null,
            }),
          });
          await relate(String(target.id), entity, isDiscussion ? "has_discussion" : "has_post");
        }
      } else if (query.kind === "own_status") {
        const record = object(result.data), scope = object(record.assignment_scope);
        const submission = object(object(record.lastattempt).submission);
        if (
          id(scope.course_id) !== query.course_id ||
          id(scope.assignment_id) !== query.assignment_id ||
          !connection.provider_subject || (submission.userid !== undefined &&
            String(submission.userid) !== connection.provider_subject)
        ) {
          throw new HubError(
            "source_mismatch",
            "O status não corresponde à atividade e conta consultadas.",
            409,
          );
        }
        const external = `moodle:course/${query.course_id}/assignment/${query.assignment_id}`;
        const assignment = await parent("assignment", external, "Trabalho", {
          course_id: query.course_id,
          instance_id: query.assignment_id,
          ...(id(scope.cmid) ? { coursemodule: id(scope.cmid) } : {}),
        });
        const status = await snapshot("own_submission_status", external + "/own-status", record, {
          course_id: query.course_id,
          instance_id: query.assignment_id,
        });
        await relate(assignment, status, "has_own_submission_status");
      } else {
        const courseId = query.course_id, courseLocator = `moodle:course/${courseId}`;
        const course = await parent("course", String(courseId), "Curso", { course_id: courseId });
        if (query.kind === "structure") {
          for (const section of records) {
            const sectionId = id(section.id);
            if (!sectionId) continue;
            const sectionEntity = await snapshot(
              "section",
              `${courseLocator}/section/${sectionId}`,
              section,
              {
                course_id: courseId,
                section_id: sectionId,
                sectionnum: section.section ?? null,
                visible: section.visible ?? null,
              },
            );
            await relate(course, sectionEntity, "has_section");
            for (
              const module of Array.isArray(section.modules)
                ? section.modules as MoodleRecord[]
                : []
            ) {
              const cmid = id(module.id);
              if (!cmid) continue;
              const moduleEntity = await snapshot(
                "module",
                `${courseLocator}/module/${cmid}`,
                module,
                {
                  course_id: courseId,
                  section_id: sectionId,
                  module_id: cmid,
                  instance: id(module.instance),
                  modname: module.modname ?? null,
                  url: module.url ?? null,
                  visible: module.visible ?? null,
                  uservisible: module.uservisible ?? null,
                },
              );
              if (currentIds.has(moduleEntity)) {
                await tx`update public.hub_relations set kind='previous_has_module'
                  where owner_id=${p.ownerId} and to_id=${moduleEntity} and kind='has_module' and from_id<>${sectionEntity}`;
                // Reactivate the old edge on A→B→A, just like Sync.relateModule.
                const reactivated =
                  await tx`update public.hub_relations set kind='has_module',evidence=${
                    tx.json({
                      system: "moodle",
                      connection_id: connectionId,
                      observed_at: result.observed_at,
                    })
                  } where owner_id=${p.ownerId} and from_id=${sectionEntity}
                  and to_id=${moduleEntity} and kind='previous_has_module' returning to_id`;
                if (!reactivated.length) await relate(sectionEntity, moduleEntity, "has_module");
              }
              const children =
                await tx`select id from public.hub_entities where owner_id=${p.ownerId}
                and connection_id=${connectionId} and state->>'course_id'=${String(courseId)}
                and state->>'instance_id'=${String(id(module.instance))}
                and state->>'module_name'=${String(module.modname)} and kind<>'module'`;
              for (const child of children) {
                await relate(moduleEntity, String(child.id), "has_content");
              }
            }
          }
        } else {
          const names = {
            pages: ["page", "page"],
            books: ["book", "book"],
            assignments: ["assignment", "assign"],
            forums: ["forum", "forum"],
            resources: ["resource", "resource"],
            urls: ["url", "url"],
          } as const;
          const [kind, moduleName] = names[query.kind];
          for (const record of records) {
            const instance = id(record.id);
            if (
              !instance || (id(record.course_id ?? record.course) !== null &&
                id(record.course_id ?? record.course) !== courseId)
            ) continue;
            const cmid = id(record.coursemodule ?? record.cmid);
            const entity = await snapshot(kind, `${courseLocator}/${kind}/${instance}`, record, {
              course_id: courseId,
              instance_id: instance,
              coursemodule: cmid,
              module_name: moduleName,
            });
            const modules = await tx`select id from public.hub_entities where owner_id=${p.ownerId}
              and connection_id=${connectionId} and kind='module' and state->>'course_id'=${
              String(courseId)
            }
              and (state->>'module_id'=${cmid === null ? null : String(cmid)}
                or (state->>'instance'=${String(instance)} and state->>'modname'=${moduleName}))`;
            await relate(
              modules.length === 1 ? String(modules[0].id) : course,
              entity,
              "has_content",
            );
          }
        }
      }
      return {
        status: "persisted",
        coverage: result.coverage,
        entity_ids: entityIds,
        attention_tool: "hub_attention",
        external_writes: false,
      };
    }, { logicalBytes: () => logicalWriteBytes({ query, result }) });
  }
}
