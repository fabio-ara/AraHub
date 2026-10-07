// AraHub (MIT). Casos reais complementares, chamados pelo harness SDK/HTTP.
import type { MoodleLabAdapter } from "./moodle_lab_adapter.ts";
import { sha256Hex } from "../../src/migration.ts";
// JSON do SDK/REST permanece dinâmico neste harness; asserções conferem o contrato.
type R = Record<string, any>;
export async function runExtendedCases(c: {
  targets: R;
  call: (name: string, input: R) => Promise<R>;
  approved: (prepared: R) => Promise<void>;
  prepareAssign: (target: any, ids?: string[]) => Promise<R>;
  preserve: (name: string, bytes: Uint8Array) => Promise<string>;
  oracle: (id: number) => Promise<R>;
  cli: (op: string, ...args: string[]) => Promise<R>;
  evidence: (name: string, value: R) => void;
  writes: string[];
  connectionId: string;
  connectionCId: string;
  fileCId: string;
  studentUserId: number | null;
  source: Uint8Array;
  pdf: Uint8Array;
  fileId: string;
  adapter: MoodleLabAdapter;
  adapterC: MoodleLabAdapter;
  forumOnly?: boolean;
  groupsOnly?: boolean;
  warningOnly?: boolean;
  setTransport: (value: typeof fetch | undefined) => void;
}) {
  const t = c.targets;
  const execute = (prepared: R) =>
    c.call("hub_execute_moodle_action", { action_id: prepared.action_id });
  const read = (prepared: R) => c.call("hub_action", { action_id: prepared.action_id });
  const submit = async (prepared: R) => {
    await c.approved(prepared);
    return await execute(prepared);
  };
  const submission = async (id: number, adapter = c.adapter) => {
    const status = await adapter.getSubmissionStatus(id);
    if (!status.data) throw new Error("Status Lab indisponível: " + status.error_code);
    return (status.data as R).lastattempt as R;
  };

  if (c.warningOnly) {
    const target = t.assignments.warning;
    const prepared = await c.prepareAssign(target);
    await c.approved(prepared);
    const before = await c.oracle(target.id);
    let sends = 0, status = 0;
    let warningCodes: string[] = [];
    c.setTransport(async (input, init) => {
      const params = new URLSearchParams(
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
          ? init.body
          : "",
      );
      if (params.get("wsfunction") === "mod_assign_save_submission") {
        sends++;
        await c.cli("warning-close", String(target.id));
        const response = await fetch(input, init);
        status = response.status;
        const body = await response.clone().json();
        warningCodes = Array.isArray(body) ? body.map((w: R) => String(w.warningcode)) : [];
        return response;
      }
      return fetch(input, init);
    });
    const at = c.writes.length;
    let first: R, second: R;
    try {
      first = await execute(prepared);
      second = await execute(prepared);
    } finally {
      c.setTransport(undefined);
    }
    const after = await c.oracle(target.id);
    const files = await c.cli("assignment-files", String(target.id));
    const writes = c.writes.slice(at);
    c.evidence("assignment_http200_real_warning", {
      injection: "close_owned_target_after_preflight_before_real_save",
      http_status: status,
      warning_codes: warningCodes,
      first_state: first!.state,
      second_state: second!.state,
      save_requests: sends,
      provider_writes: writes,
      before: before.submissions,
      after: after.submissions,
      submitted_files: files.files,
      passed: status === 200 && warningCodes.includes("couldnotsavesubmission") && sends === 1 &&
        first!.state === "uncertain" && second!.state === "uncertain" &&
        !writes.includes("mod_assign_submit_for_grading") && files.files.length === 0 &&
        !after.submissions.some((s: R) => s.status === "submitted"),
    });
    return;
  }
  if (!c.forumOnly) {
    // ASSIGN-04: due acadêmico passado e cutoff futuro estão expostos separadamente.
    {
      const at = c.writes.length, prepared = await c.prepareAssign(t.assignments.due_cutoff);
      const assignment = prepared.review?.rules?.assignment ?? {};
      const now = Date.now() / 1000;
      c.evidence("assignment_due_vs_cutoff", {
        state: prepared.state,
        due: assignment.duedate,
        cutoff: assignment.cutoffdate,
        instruction_preserved: String(assignment.intro).includes("não autoriza atraso"),
        provider_writes: c.writes.slice(at),
        academic_permission_inferred: false,
        passed: prepared.state === "prepared" && assignment.duedate < now &&
          assignment.cutoffdate > now &&
          String(assignment.intro).includes("não autoriza atraso") && c.writes.length === at,
      });
    }

    // ASSIGN-05: só B tem extensão; C usa conexão e token próprios.
    {
      const target = t.assignments.extension;
      const b = await c.prepareAssign(target);
      const at = c.writes.length;
      const other = await c.call("hub_prepare_moodle_action", {
        connection_id: c.connectionCId,
        course_id: t.course,
        cmid: target.cmid,
        kind: "assignment.submit",
        file_ids: [c.fileCId],
      });
      const stateB = await submission(target.id), stateC = await submission(target.id, c.adapterC);
      const noWritesC = c.writes.length === at;
      const result = b.action_id ? await submit(b) : {};
      const verified = await c.oracle(target.id);
      c.evidence("assignment_individual_extension", {
        extended_user: c.studentUserId,
        extension_b: stateB.extensionduedate,
        extension_c: stateC.extensionduedate,
        b_state: result.state,
        c_code: other.code,
        c_action_created: Boolean(other.action_id),
        c_provider_writes: noWritesC ? [] : ["unexpected"],
        independent_submissions: verified.submissions,
        passed: Number(stateB.extensionduedate) > Date.now() / 1000 &&
          !Number(stateC.extensionduedate) &&
          ["submission_locked", "submission_window"].includes(other.code) && !other.action_id &&
          noWritesC &&
          result.state === "succeeded" && verified.submissions.some((s: R) =>
            s.status === "submitted"
          ),
      });
    }

    // ASSIGN-06: maxattempts=1 bloqueia reenvio; docente reabre o mesmo attempt por API nativa.
    {
      const target = t.assignments.reopen;
      const first = await submit(await c.prepareAssign(target));
      const before = await c.oracle(target.id), at = c.writes.length;
      const blocked = await c.prepareAssign(target);
      const untouched = await c.oracle(target.id);
      const noWrites = c.writes.length === at;
      const reopened = await c.cli("reopen", String(target.id));
      const draft = await c.oracle(target.id);
      const prepared = await c.prepareAssign(target);
      const second = prepared.action_id ? await submit(prepared) : {};
      const after = await c.oracle(target.id);
      c.evidence("assignment_single_attempt_reopen", {
        first_state: first.state,
        locked_code: blocked.code,
        writes_while_locked: noWrites ? [] : ["unexpected"],
        native_reopen: reopened,
        before: before.submissions,
        draft: draft.submissions,
        after: after.submissions,
        second_state: second.state,
        maxattempts: prepared.review?.rules?.assignment?.maxattempts,
        reopen_kind: "revert_to_draft_same_attempt",
        passed: first.state === "succeeded" && blocked.code === "submission_locked" && noWrites &&
          JSON.stringify(before) === JSON.stringify(untouched) &&
          reopened.reverted_to_draft === true &&
          draft.submissions[0]?.status === "draft" && second.state === "succeeded" &&
          after.submission_rows === 1 && after.submissions[0]?.attemptnumber === 0 &&
          after.submissions[0]?.status === "submitted",
      });
    }

    // ASSIGN-08: draft A passa a B, e o oráculo de arquivos confirma digest e ausência de anexo extra.
    {
      const target = t.assignments.replace;
      const upload = await c.adapter.uploadDraftFile(
        "versao-anterior.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        c.source,
      );
      await c.adapter.saveAssignment(target.id, upload.itemid);
      const before = await c.cli("assignment-files", String(target.id));
      const pdfId = await c.preserve("versao-final.pdf", c.pdf);
      const result = await submit(await c.prepareAssign(target, [pdfId]));
      const after = await c.cli("assignment-files", String(target.id));
      c.evidence("assignment_replace_existing_file", {
        before: before.files,
        after: after.files,
        state: result.state,
        passed: before.files.length === 1 && before.files[0].name === "versao-anterior.docx" &&
          result.state === "succeeded" && after.files.length === 1 &&
          after.files[0].name === "versao-final.pdf" &&
          after.files[0].sha256 === await sha256Hex(c.pdf),
      });
    }
  }
  // FORUM-04 complemento: leitura limitada ao grupo certo, execução conservadora.
  if (t.forums.separate) {
    const f = t.forums.separate;
    const ownB = await c.adapter.getDiscussionPosts(f.groups.b.id);
    const wrongB = await c.adapter.getDiscussionPosts(f.groups.c.id);
    const ownC = await c.adapterC.getDiscussionPosts(f.groups.c.id);
    const wrongC = await c.adapterC.getDiscussionPosts(f.groups.b.id);
    const at = c.writes.length, before = await c.cli("forum-oracle", String(f.id));
    const prepare = (connectionId: string, group: R) =>
      c.call("hub_prepare_moodle_action", {
        connection_id: connectionId,
        course_id: t.course,
        cmid: f.cmid,
        kind: "forum.reply",
        discussion_id: group.id,
        parent_id: group.root,
        subject: "Resposta no grupo",
        body: "Texto sintético.",
        file_ids: [],
      });
    const b = await prepare(c.connectionId, f.groups.b);
    const wrong = await prepare(c.connectionId, f.groups.c);
    const after = await c.cli("forum-oracle", String(f.id));
    const contains = (v: typeof ownB, id: number) =>
      Boolean(v.data?.some((p) => Number(p.id) === id));
    c.evidence("forum_separate_groups_student_access", {
      b_reads_own: contains(ownB, f.groups.b.root),
      b_reads_other: contains(wrongB, f.groups.c.root),
      c_reads_own: contains(ownC, f.groups.c.root),
      c_reads_other: contains(wrongC, f.groups.b.root),
      wrong_b_error: wrongB.error_code,
      wrong_c_error: wrongC.error_code,
      prepare_own_code: b.code,
      prepare_other_code: wrong.code,
      provider_writes: c.writes.slice(at),
      posts_before: before.count,
      posts_after: after.count,
      passed: contains(ownB, f.groups.b.root) && contains(ownC, f.groups.c.root) &&
        !contains(wrongB, f.groups.c.root) && !contains(wrongC, f.groups.b.root) &&
        b.code === "group_review_required" && wrong.code === "group_review_required" &&
        c.writes.length === at && JSON.stringify(before) === JSON.stringify(after),
    });
  }
  if (c.groupsOnly) return;
  const forum = t.forums.general;
  const prepareReply = (parent: number, subject: string) =>
    c.call("hub_prepare_moodle_action", {
      connection_id: c.connectionId,
      course_id: t.course,
      cmid: forum.cmid,
      kind: "forum.reply",
      discussion_id: forum.discussion,
      parent_id: parent,
      subject,
      body: "Contribuição sintética para a prova.",
      file_ids: [],
    });
  const measure = async (label: string) => {
    const sync = await c.call("hub_sync_moodle_course", {
      connection_id: c.connectionId,
      course_id: t.course,
    });
    const attention = await c.call("hub_attention", { connection_id: c.connectionId });
    const found = (attention.obligations ?? []).find((o: R) =>
      o.entity?.kind === "forum" && o.entity?.title === "Negativa general"
    );
    const native = await c.cli("forum-oracle", String(forum.id));
    const posts = native.posts as R[];
    const repliedAuthors = new Set(
      posts.filter((p) => Number(p.userid) === c.studentUserId).flatMap((p) => {
        const parent = posts.find((q) => Number(q.id) === Number(p.parent));
        return parent && Number(parent.userid) !== c.studentUserId ? [Number(parent.userid)] : [];
      }),
    );
    console.log(
      JSON.stringify({
        stage: "forum_two_distinct",
        label,
        observed: found?.colleagues?.colleagues_answered_by_owner ?? null,
      }),
    );
    return {
      label,
      sync_state: sync.job?.state ?? sync.state,
      observed: found?.colleagues?.colleagues_answered_by_owner ?? null,
      database_distinct_answered: repliedAuthors.size,
      post_count: posts.length,
    };
  };
  // FORUM-02: intenção, própria resposta e duplicata não aumentam colegas respondidos.
  {
    const stages: R[] = [];
    stages.push(await measure("baseline"));
    await prepareReply(forum.peer, "Rascunho não publicado");
    stages.push(await measure("draft_only"));
    const own = await prepareReply(forum.peer, "Primeiro colega");
    const first = await submit(own);
    stages.push(await measure("first_colleague"));
    const posts = (await c.cli("forum-oracle", String(forum.id))).posts as R[];
    const ownPost = posts.find((p) =>
      Number(p.userid) === c.studentUserId && p.subject === "Primeiro colega"
    )!;
    await submit(await prepareReply(Number(ownPost.id), "Resposta própria"));
    stages.push(await measure("self_reply"));
    const duplicate = await prepareReply(forum.peer, "Outra resposta ao mesmo colega");
    await submit(duplicate);
    const at = c.writes.length;
    const repeated = await execute(duplicate);
    const noRetry = c.writes.length === at;
    stages.push(await measure("same_colleague_and_duplicate_execute"));
    const second = await submit(await prepareReply(forum.peer2, "Segundo colega distinto"));
    stages.push(await measure("second_colleague"));
    const expected = [0, 0, 1, 1, 1, 2];
    c.evidence("forum_two_distinct_colleagues", {
      stages,
      first_state: first.state,
      second_state: second.state,
      repeated_state: repeated.state,
      no_retry: noRetry,
      expected_counts: expected,
      passed: first.state === "succeeded" && second.state === "succeeded" && noRetry &&
        stages.every((s, i) =>
          s.observed === expected[i] && s.database_distinct_answered === expected[i]
        ),
    });
  }

  // FORUM-06: lock depois de aprovar impede write; não se cria tópico alternativo.
  {
    const prepared = await prepareReply(forum.peer, "Resposta após fechamento");
    await c.approved(prepared);
    const before = await c.cli("forum-oracle", String(forum.id));
    const lock = await c.cli("forum-close", String(forum.discussion));
    const at = c.writes.length;
    const result = await execute(prepared);
    const after = await c.cli("forum-oracle", String(forum.id));
    const action = await read(prepared);
    c.evidence("forum_closed_after_approval", {
      lock,
      code: result.code,
      action_state: action.action?.state,
      provider_writes: c.writes.slice(at),
      posts_before: before.count,
      posts_after: after.count,
      passed:
        ["discussion_unavailable", "preconditions_changed", "forum_closed"].includes(result.code) &&
        c.writes.length === at && JSON.stringify(before) === JSON.stringify(after),
    });
  }
}
