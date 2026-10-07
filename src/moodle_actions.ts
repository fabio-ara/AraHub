import { createHash } from "node:crypto";
import { z } from "zod";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { asOwner } from "./db.ts";
import { type ArtifactFile, Artifacts } from "./artifacts.ts";
import { PersistentActionStore } from "./approval_store.ts";
import { executeAction } from "./production.ts";
import type { ConnectionService } from "./connections.ts";
import type { MoodleAdapter, MoodleRecord, MoodleResult } from "./adapters/moodle.ts";

export const moodleActionSchema = z.object({
  connection_id: z.string().uuid(),
  course_id: z.number().int().positive(),
  cmid: z.number().int().positive(),
  kind: z.enum(["forum.discussion", "forum.reply", "assignment.submit"]),
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(24000).optional(),
  discussion_id: z.number().int().positive().optional(),
  parent_id: z.number().int().positive().optional(),
  file_ids: z.array(z.string().uuid()).max(10).default([]),
}).strict();
type Input = z.infer<typeof moodleActionSchema>;
type Snapshot = {
  kind: Input["kind"];
  connection: { label: string; origin: string; username: string };
  target: {
    course_id: number;
    course_name: string;
    cmid: number;
    activity_name: string;
    instance_id: number;
    discussion_id?: number;
    parent_id?: number;
  };
  text?: { subject: string; body: string };
  files: ArtifactFile[];
  statement: { text: string; required: boolean };
  expected: {
    epoch: number;
    user_id: number;
    fingerprint: string;
    attempt: number | null;
    status: string | null;
  };
  rules: MoodleRecord;
  prepared_at: string;
  expires_at: string;
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const record = (v: unknown): MoodleRecord =>
  v && typeof v === "object" && !Array.isArray(v) ? v as MoodleRecord : {};
const items = (v: unknown): MoodleRecord[] => Array.isArray(v) ? v.map(record) : [];
const bool = (v: unknown) => v === true || v === 1;
const text = (v: unknown) => typeof v === "string" ? v : "";
// Moodle materializes empty submission plugins after the first status read.
// Ignore only those empty shells; any file, editor content or unknown field
// must still invalidate the approved version when it changes.
export function submissionContentPlugins(value: unknown): MoodleRecord[] {
  return items(value).filter((plugin) =>
    Object.keys(plugin).some((key) =>
      !["type", "name", "fileareas", "editorfields"].includes(key)
    ) ||
    items(plugin.fileareas).some((area) =>
      items(area.files).length > 0 ||
      Object.keys(area).some((key) => !["area", "files"].includes(key))
    ) ||
    items(plugin.editorfields).some((field) =>
      text(field.text).length > 0 ||
      Object.keys(field).some((key) => !["name", "description", "text", "format"].includes(key))
    )
  );
}
function deny(code: string, message: string): never {
  throw new HubError(code, message, 409);
}
const complete = <T>(r: MoodleResult<T>, purpose: string): T => {
  if (r.data === null || r.error_code || r.warnings.length) {
    return deny(
      "preflight_unavailable",
      `Não foi possível conferir ${purpose}; nenhuma escrita foi iniciada.`,
    );
  }
  return r.data;
};
// The server renders only escaped plain text from this first authoring contract.
export const forumHtml = (value: string) =>
  "<p>" +
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(
    '"',
    "&quot;",
  ).replace(/\r\n?/g, "\n").replaceAll("\n", "<br>") + "</p>";

export class MoodleActions {
  constructor(
    private hub: Hub,
    private connections: ConnectionService,
    private actions: PersistentActionStore,
    private artifacts = new Artifacts(hub),
  ) {}

  private async preflight(
    p: Principal,
    input: Input,
  ): Promise<{ snapshot: Snapshot; moodle: MoodleAdapter }> {
    const connection = await this.connections.parent(p, input.connection_id);
    const moodle = await this.connections.moodle(p, input.connection_id),
      identity = await moodle.initialize();
    if (String(identity.user_id) !== connection.provider_subject) {
      deny("identity_changed", "A identidade da conexão mudou.");
    }
    const courses = complete(await moodle.listCourses(), "a inscrição"),
      course = courses.find((c) => c.id === input.course_id);
    if (!course) deny("access_denied", "Curso não encontrado para esta conta.");
    const structure = complete(await moodle.getCourseContents(input.course_id), "a atividade");
    const module = structure.flatMap((s) => items(s.modules)).find((m) => m.id === input.cmid);
    if (!module || module.uservisible === false || module.uservisible === 0) {
      deny("access_denied", "Atividade indisponível para esta conta.");
    }
    const instance = Number(module.instance);
    if (!Number.isSafeInteger(instance) || instance <= 0) {
      deny("invalid_target", "Instância da atividade ausente.");
    }
    const loaded = await Promise.all(
      input.file_ids.map((id) => this.artifacts.load(p, input.connection_id, id)),
    );
    if (new Set(loaded.map((f) => f.name.normalize("NFC").toLowerCase())).size !== loaded.length) {
      deny("duplicate_filename", "Os anexos têm nomes de destino iguais.");
    }
    const files = loaded.map(({ content: _, ...f }) => f);
    const available = await moodle.actionFunctions();
    const now = Date.now() / 1000;
    let rules: MoodleRecord = {},
      statement = { text: "", required: false },
      attempt: number | null = null,
      status: string | null = null;
    if (input.kind === "assignment.submit") {
      if (
        module.modname !== "assign" || input.subject || input.body || input.discussion_id ||
        input.parent_id
      ) deny("invalid_target", "Ação incompatível com o alvo.");
      const list = await moodle.getAssignments([input.course_id]);
      // Partial course visibility may be legitimate; this exact activity must still be present.
      if (!list.data) deny("preflight_unavailable", "Configuração da entrega indisponível.");
      const assignment = list.data.find((a) => a.id === instance);
      if (!assignment) deny("preflight_unavailable", "Configuração da entrega indisponível.");
      if (bool(assignment.teamsubmission)) {
        deny(
          "group_review_required",
          "Entrega em grupo exige validação específica de membros e assentimento.",
        );
      }
      if (
        !available.includes("mod_assign_save_submission") ||
        (bool(assignment.submissiondrafts) && !available.includes("mod_assign_submit_for_grading"))
      ) deny("capability_unavailable", "Operação de entrega não oferecida a esta conta.");
      const configs = items(assignment.configs), fileConfig: Record<string, string> = {};
      for (const c of configs) {
        if (c.plugin === "file" && c.subtype === "assignsubmission") {
          fileConfig[String(c.name)] = String(c.value);
        }
      }
      if (
        fileConfig.enabled !== "1" || !files.length ||
        files.length > Number(fileConfig.maxfilesubmissions ?? 0)
      ) deny("file_limit", "Quantidade de arquivos não aceita pela atividade.");
      const max = Number(fileConfig.maxsubmissionsizebytes ?? 0);
      if (max > 0 && files.some((f) => f.bytes > max)) {
        deny("file_limit", "Arquivo excede o limite configurado da atividade.");
      }
      const allowed = (fileConfig.filetypeslist ?? "").split(",").map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (
        allowed.length && !allowed.includes("*") &&
        files.some((f) =>
          !allowed.includes("." + f.name.split(".").at(-1)) &&
          !allowed.includes(f.name.split(".").at(-1)!)
        )
      ) deny("file_type", "Tipo de arquivo não aceito, ou grupo de formatos ainda não resolvido.");
      statement = {
        text: text(assignment.submissionstatement),
        required: bool(assignment.requiresubmissionstatement),
      };
      if (statement.required && !statement.text) {
        deny("statement_unavailable", "A declaração atual não foi recuperada.");
      }
      if (statement.required && !bool(assignment.submissiondrafts)) {
        deny(
          "statement_route_unverified",
          "Salvar já finaliza esta entrega; a rota de assentimento precisa ser validada antes de escrever.",
        );
      }
      const stateResult = await moodle.getSubmissionStatus(instance);
      if (stateResult.error_code === "security_error") {
        deny(
          "status_policy_blocked",
          "A rota de status permanece bloqueada por efeitos indiretos em notas. O laboratório deve concluir a auditoria antes de habilitar este perfil real.",
        );
      }
      const state = complete(stateResult, "o estado da entrega"),
        last = record(state.lastattempt),
        submission = record(last.submission);
      status = text(submission.status) || "new";
      attempt = Number(submission.attemptnumber ?? 0);
      if (
        bool(last.locked) || !bool(last.submissionsenabled) || !bool(last.caneditowner) ||
        status === "submitted"
      ) deny("submission_locked", "A entrega não está disponível para alteração.");
      // cansubmit controls the final submit button; it is false before the
      // first draft exists. caneditowner expresses the actual write permission.
      const baseCutoff = Number(assignment.cutoffdate || 0);
      const cutoff = baseCutoff > 0 ? Math.max(baseCutoff, Number(last.extensionduedate || 0)) : 0,
        open = Number(assignment.allowsubmissionsfromdate || 0);
      if ((open && open > now) || (cutoff && cutoff < now)) {
        deny("submission_window", "A janela operacional da entrega está fechada.");
      }
      rules = {
        assignment,
        submission: {
          status,
          attempt,
          files: submissionContentPlugins(submission.plugins),
          locked: last.locked ?? false,
          cansubmit: last.cansubmit ?? null,
          canedit: last.canedit ?? null,
          extensionduedate: last.extensionduedate ?? 0,
        },
        course_coverage: list.coverage,
      };
    } else {
      if (module.modname !== "forum" || !input.subject || !input.body) {
        deny("invalid_target", "Fórum, título e texto são obrigatórios.");
      }
      if (input.kind === "forum.discussion" && (input.parent_id || input.discussion_id)) {
        deny("invalid_target", "Novo tópico não aceita post de resposta.");
      }
      if (input.kind === "forum.reply" && (!input.parent_id || !input.discussion_id)) {
        deny("invalid_target", "Escolha a discussão e o post ao qual responder.");
      }
      const forum = complete(await moodle.getForums([input.course_id]), "o fórum").find((f) =>
        f.id === instance
      );
      if (!forum) deny("preflight_unavailable", "Fórum não encontrado na cobertura.");
      const access = complete(await moodle.forumAccess(instance), "as permissões do fórum");
      const posting = input.kind === "forum.discussion"
        ? complete(await moodle.canAddDiscussion(instance), "a disponibilidade de novo tópico")
        : null;
      if (posting && !bool(posting.status)) {
        deny("forum_closed", "Este fórum não aceita novo tópico desta conta agora.");
      }
      if (
        files.length &&
        (posting ? !bool(posting.cancreateattachment) : !bool(access.cancreateattachment))
      ) deny("attachment_denied", "Esta conta não pode anexar arquivos neste fórum.");
      const operation = input.kind === "forum.discussion"
        ? "mod_forum_add_discussion"
        : "mod_forum_add_discussion_post";
      if (!available.includes(operation)) {
        deny("capability_unavailable", "Operação de fórum não oferecida.");
      }
      if (
        (input.kind === "forum.discussion" && !bool(access.canstartdiscussion)) ||
        (input.kind === "forum.reply" && !bool(access.canreplypost))
      ) deny("access_denied", "Esta conta não pode publicar neste fórum.");
      if (Number(module.groupmode ?? 0) !== 0) {
        deny(
          "group_review_required",
          "Fórum com grupos exige escolha e conferência do grupo antes de publicar.",
        );
      }
      if (Number(forum.cutoffdate || 0) > 0 && Number(forum.cutoffdate) < now) {
        deny("forum_closed", "O fórum está fechado.");
      }
      if (
        files.length > Number(forum.maxattachments ?? 0) ||
        files.some((f) => Number(forum.maxbytes) > 0 && f.bytes > Number(forum.maxbytes))
      ) deny("file_limit", "Anexos não aceitos pelo fórum.");
      let discussion: MoodleRecord | null = null, parent: MoodleRecord | null = null;
      if (input.kind === "forum.reply") {
        for (let page = 0; page < 100 && !discussion; page++) {
          const result = await moodle.getForumDiscussions(instance, { page, perPage: 100 });
          const ds = complete(result, "a discussão");
          discussion = ds.find((d) =>
            Number(d.discussion_id ?? d.discussion) === input.discussion_id
          ) ?? null;
          if (!result.pagination?.has_more) break;
        }
        if (!discussion || !bool(discussion.canreply) || bool(discussion.locked)) {
          deny("discussion_unavailable", "Discussão indisponível para resposta.");
        }
        const posts = complete(
          await moodle.getDiscussionPosts(input.discussion_id!, { postId: input.parent_id }),
          "o post",
        );
        parent = posts.find((post) => post.id === input.parent_id) ?? null;
        if (!parent) {
          deny(
            "parent_unavailable",
            "Post não recuperado nessa discussão; amplie a leitura antes de responder.",
          );
        }
      }
      // Fix academic instructions, permissions and parent content, not view counters.
      rules = {
        forum: {
          id: forum.id,
          type: forum.type,
          intro: forum.intro,
          maxbytes: forum.maxbytes,
          maxattachments: forum.maxattachments,
          duedate: forum.duedate,
          cutoffdate: forum.cutoffdate,
          blockafter: forum.blockafter,
          blockperiod: forum.blockperiod,
        },
        access,
        posting,
        discussion: discussion
          ? {
            id: input.discussion_id,
            canreply: discussion.canreply,
            locked: discussion.locked,
            groupid: discussion.groupid,
          }
          : null,
        parent: parent
          ? {
            id: parent.id,
            subject: parent.subject,
            message: parent.message,
            author: parent.author,
          }
          : null,
      };
    }
    const fingerprint = hash({
      module: {
        id: module.id,
        name: module.name,
        description: module.description,
        instance: module.instance,
        modname: module.modname,
        uservisible: module.uservisible,
        groupmode: module.groupmode,
      },
      rules,
    });
    const snapshot: Snapshot = {
      kind: input.kind,
      connection: {
        label: String(connection.label),
        origin: moodle.origin,
        username: identity.username ?? String(identity.user_id),
      },
      target: {
        course_id: input.course_id,
        course_name: text(course!.fullname),
        cmid: input.cmid,
        activity_name: text(module!.name),
        instance_id: instance,
        ...(input.discussion_id ? { discussion_id: input.discussion_id } : {}),
        ...(input.parent_id ? { parent_id: input.parent_id } : {}),
      },
      ...(input.subject && input.body
        ? { text: { subject: input.subject, body: input.body } }
        : {}),
      files,
      statement,
      expected: {
        epoch: Number(connection.oauth_epoch),
        user_id: identity.user_id,
        fingerprint,
        attempt,
        status,
      },
      rules,
      prepared_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    return { snapshot, moodle };
  }

  async prepare(p: Principal, raw: unknown) {
    const input = moodleActionSchema.parse(raw), { snapshot } = await this.preflight(p, input);
    const action = await this.actions.prepare(p, {
      connectionId: input.connection_id,
      operation: "moodle." + input.kind,
      target: `${snapshot.target.course_id}/${snapshot.target.cmid}/${snapshot.target.instance_id}`,
      revision: snapshot.expected.fingerprint,
      content: snapshot,
    });
    return {
      action_id: action.id,
      content_hash: action.hash,
      state: "prepared",
      review: snapshot,
      approval: "authenticated_browser_required",
      external_write: false,
    };
  }

  private async step(
    p: Principal,
    connectionId: string,
    actionId: string,
    stage: string,
    details: MoodleRecord = {},
  ) {
    const content = { action_id: actionId, stage, ...details }, observed = new Date().toISOString();
    await asOwner(this.hub.db, p, async (tx) => {
      const entity =
        (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${p.ownerId},${connectionId},'academic_action',${actionId},${"Ação acadêmica"},${
          tx.json(content)
        }) on conflict(owner_id,connection_id,kind,external_id) do update set state=excluded.state returning id`)[
          0
        ];
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${p.ownerId},${entity.id},${
        tx.json(content)
      },${hash(content)},${
        tx.json({ system: "arahub_action", action_id: actionId, observed_at: observed })
      },'complete',${observed}) on conflict(owner_id,entity_id,content_hash) do nothing`;
    });
  }

  async execute(p: Principal, actionId: string) {
    const view = await this.actions.load(p, actionId);
    if (!view || !view.action.operation.startsWith("moodle.")) {
      deny("not_found", "Ação acadêmica não encontrada.");
    }
    const action = view!.action, snapshot = action.content as Snapshot;
    const prior = await this.actions.result(action.id, p.ownerId);
    if (prior) return { ...prior, action_id: action.id, resent: false };
    if (Date.parse(snapshot.expires_at) <= Date.now()) {
      deny("intent_expired", "A intenção expirou; prepare uma versão atual.");
    }
    const input = moodleActionSchema.parse({
      connection_id: action.connectionId,
      course_id: snapshot.target.course_id,
      cmid: snapshot.target.cmid,
      kind: snapshot.kind,
      ...(snapshot.text ?? {}),
      discussion_id: snapshot.target.discussion_id,
      parent_id: snapshot.target.parent_id,
      file_ids: snapshot.files.map((f) => f.id),
    });
    const current = await this.preflight(p, input), moodle = current.moodle;
    if (
      hash(current.snapshot.expected) !== hash(snapshot.expected) ||
      hash(current.snapshot.files) !== hash(snapshot.files) ||
      hash(current.snapshot.statement) !== hash(snapshot.statement)
    ) {
      deny(
        "preconditions_changed",
        "Alvo, regras, estado ou arquivos mudaram; revise uma nova intenção.",
      );
    }
    const result = await executeAction(p, action, this.actions, async () => {
      try {
        let draftId: number | undefined;
        for (const f of snapshot.files) {
          const binary = await this.artifacts.load(p, action.connectionId, f.id);
          await this.step(p, action.connectionId, action.id, "uploading", {
            file_id: f.id,
            sha256: f.sha256,
          });
          const uploaded = await moodle.uploadDraftFile(f.name, f.mime, binary.content, draftId);
          draftId = uploaded.itemid;
          await this.step(p, action.connectionId, action.id, "draft_uploaded", {
            file_id: f.id,
            itemid: draftId,
          });
        }
        if (snapshot.kind === "assignment.submit") {
          await this.step(p, action.connectionId, action.id, "saving_submission");
          await moodle.saveAssignment(snapshot.target.instance_id, draftId!);
          await this.step(p, action.connectionId, action.id, "submission_saved");
          if (bool(record(snapshot.rules.assignment).submissiondrafts)) {
            await this.step(p, action.connectionId, action.id, "finalizing");
            await moodle.submitAssignment(snapshot.target.instance_id, snapshot.statement.required);
          }
          const state = complete(
            await moodle.getSubmissionStatus(snapshot.target.instance_id),
            "a confirmação da entrega",
          );
          const submission = record(record(state.lastattempt).submission);
          if (
            submission.status !== "submitted" ||
            Number(submission.attemptnumber ?? 0) !== snapshot.expected.attempt
          ) deny("unconfirmed", "O estado final da entrega não foi confirmado.");
          const submittedFiles = items(submission.plugins).flatMap((plugin) =>
            items(plugin.fileareas)
          ).flatMap((area) => items(area.files));
          await this.verifyFiles(moodle, snapshot.files, submittedFiles);
          await this.step(p, action.connectionId, action.id, "confirmed", {
            submission_id: submission.id,
            status: "submitted",
            files: snapshot.files,
            verified_at: new Date().toISOString(),
          });
          return { externalId: String(submission.id) };
        }
        await this.step(p, action.connectionId, action.id, "publishing");
        const sent = snapshot.kind === "forum.discussion"
          ? await moodle.addDiscussion(
            snapshot.target.instance_id,
            snapshot.text!.subject,
            forumHtml(snapshot.text!.body),
            0,
            draftId,
          )
          : await moodle.replyPost(
            snapshot.target.parent_id!,
            snapshot.text!.subject,
            forumHtml(snapshot.text!.body),
            draftId,
          );
        const discussionId = snapshot.kind === "forum.discussion"
          ? Number(sent.discussionid)
          : snapshot.target.discussion_id!;
        const postId = Number(sent.postid);
        if (!Number.isSafeInteger(discussionId) || discussionId <= 0) {
          deny("unconfirmed", "Identificador da publicação não confirmado.");
        }
        const posts = complete(
          await moodle.getDiscussionPosts(
            discussionId,
            Number.isSafeInteger(postId) && postId > 0 ? { postId } : { rootOnly: true },
          ),
          "a publicação enviada",
        );
        const observed = posts.find((post) =>
          Number.isSafeInteger(postId) && postId > 0
            ? post.id === postId
            : Number(post.parentid ?? post.parent ?? 0) === 0
        );
        if (!observed) deny("unconfirmed", "Publicação não localizada na leitura posterior.");
        const author = Number(record(observed.author).id ?? observed.userid),
          parent = Number(observed.parentid ?? observed.parent ?? 0);
        const returnedText = text(observed.message).replace(/<br\s*\/?\s*>/gi, "\n").replace(
          /<[^>]+>/g,
          "",
        ).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll(
          "&amp;",
          "&",
        );
        if (
          author !== snapshot.expected.user_id ||
          text(observed.subject) !== snapshot.text!.subject ||
          returnedText.trim() !== snapshot.text!.body.trim() ||
          (snapshot.kind === "forum.reply" && parent !== snapshot.target.parent_id)
        ) {
          deny(
            "unconfirmed",
            "Conteúdo, autoria ou parent da publicação divergem da versão aprovada.",
          );
        }
        await this.verifyFiles(moodle, snapshot.files, items(observed.attachments));
        await this.step(p, action.connectionId, action.id, "confirmed", {
          post_id: observed.id,
          discussion_id: discussionId,
          files: snapshot.files,
          verified_at: new Date().toISOString(),
        });
        return { externalId: String(observed.id) };
      } catch (error) {
        // Keep a safe diagnostic after the boundary, without provider messages,
        // credentials or a misleading failed/no-effect assertion.
        try {
          await this.step(p, action.connectionId, action.id, "uncertain", {
            error_code: error instanceof HubError ? error.code : "operation_unconfirmed",
            retry_allowed: false,
          });
        } catch { /* The durable action already remains uncertain. */ }
        throw error;
      }
    });
    return {
      ...result,
      action_id: action.id,
      resent: false,
      ...(result.state === "uncertain"
        ? { next: "Não reenviar: consultar recibo e reconciliar o efeito no Moodle." }
        : {}),
    };
  }

  private async verifyFiles(
    moodle: MoodleAdapter,
    expected: ArtifactFile[],
    observed: MoodleRecord[],
  ) {
    if (observed.length !== expected.length) {
      deny("unconfirmed", "Quantidade de anexos diverge da aprovação.");
    }
    for (const file of expected) {
      const candidate = observed.find((f) => f.filename === file.name),
        ref = record(candidate?.file);
      if (!candidate || Number(candidate.filesize) !== file.bytes || !ref.file_id) {
        deny("unconfirmed", "Anexo não pôde ser conferido.");
      }
      const bytes = complete(await moodle.downloadFile(String(ref.file_id)), "os bytes do anexo");
      if (bytes.sha256 !== file.sha256) {
        deny("unconfirmed", "Os bytes do anexo divergem da versão aprovada.");
      }
    }
  }

  async read(p: Principal, actionId: string) {
    const view = await this.actions.load(p, actionId);
    if (!view) deny("not_found", "Ação não encontrada.");
    const events = await asOwner(
      this.hub.db,
      p,
      (tx) =>
        tx`select o.content,o.observed_at from public.hub_observations o join public.hub_entities e on e.owner_id=o.owner_id and e.id=o.entity_id where e.owner_id=${p.ownerId} and e.kind='academic_action' and e.external_id=${actionId} order by o.recorded_at,o.id`,
    );
    return {
      action: view,
      steps: events,
      external_state_verified: view!.state === "succeeded",
      content_is_untrusted_data: true,
    };
  }
}
