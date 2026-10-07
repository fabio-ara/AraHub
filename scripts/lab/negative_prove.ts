/**
 * Moodle Lab do AraHub — provas NEGATIVAS P0 (scripts/lab/negative_prove.ts, MIT).
 *
 * Alvos: o laboratório JÁ existente, com tokens de estudante. Não abre navegador,
 * não roda reset/up/seed geral e não encerra processos.
 *
 * Casos:
 *  ACT-04 — timeout real DEPOIS do efeito: o adapter de lab envia por HTTP de
 *           verdade e então perde a resposta; o recibo fica incerto, o efeito
 *           existe no Moodle e não há reenvio; o oráculo faz leitura independente.
 *  ACT-05 — duas execuções concorrentes da MESMA ação aprovada produzem efeito
 *           único.
 *  ACT-02 — bytes do artifact alterados após aprovação HTTP são recusados.
 *  ACT-03 — precondições alteradas de propósito após a preparação bloqueiam a
 *           execução antes do efeito.
 *
 * A autenticação do AraHub é fixture sintética (ES256 local) e isso fica explícito
 * na evidência. Nada de imagem via UI: a regra de handoff continua valendo.
 *
 * Uso:
 *   deno run -A scripts/lab/negative_prove.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { PersistentActionStore } from "../../src/approval_store.ts";
import { createVerifier } from "../../src/auth.ts";
import { createHandler } from "../../src/http.ts";
import { Artifacts } from "../../src/artifacts.ts";
import { Buffer } from "node:buffer";
import { sha256Hex } from "../../src/migration.ts";
import { runExtendedCases } from "./negative_extended.ts";
import type { ConnectionService } from "../../src/connections.ts";
import type { Principal } from "../../src/contracts.ts";
import {
  assertLabOrigin,
  assertLabOwnership,
  loadLabManifest,
  MoodleLabAdapter,
} from "./moodle_lab_adapter.ts";

const positional = Deno.args.filter((arg) => !arg.startsWith("--"));
const phase = Deno.args.includes("--extended") || Deno.args.includes("--groups-only") ||
    Deno.args.includes("--warning-only")
  ? "extended"
  : "base";
const manifestPath = positional[0] ?? ".private/entrega-1/lab/manifest.lab.json";
const instanceFile = positional[1] ?? ".private/entrega-1/lab/instances/arahublab456/instance.json";
const dbUrl = Deno.env.get("LOCAL_DATABASE_URL") ??
  "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const dbTarget = new URL(dbUrl);
assertLabOrigin(`http://${dbTarget.host}`);

const manifest = await loadLabManifest(manifestPath);
assertLabOwnership(manifest, instanceFile);
const labRoot = manifestPath.replace(/[/\\][^/\\]+$/, "");
const instanceRoot = instanceFile.replace(/[/\\][^/\\]+$/, "");
const sourceRoot = instanceRoot.replace(/[/\\]instances[/\\][^/\\]+$/, "");
const instanceVersion = JSON.parse(Deno.readTextFileSync(instanceFile)).moodle_version;
if (!["4.5.6", "4.5.15"].includes(instanceVersion)) {
  throw new Error("Versão de Lab não reconhecida");
}
const studentUserId = manifest.accounts.labstudentb.userid;
const studentToken = manifest.accounts.labstudentb.token!;
const teacherToken = manifest.accounts.labteacher.token!;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
type Target = { id: number; cmid: number };
type ForumTarget = Target & { discussion: number; root: number; peer: number };
type NegativeFixtures = {
  course: number;
  assignments: Record<string, Target>;
  forums: Record<string, ForumTarget>;
};

// --- Sondas do laboratório (leitura/estado sintético via helper público) ---------
function composeArgs(): string[] {
  const project = manifest.project;
  return [
    "compose",
    "--project-name",
    project,
    "--env-file",
    instanceRoot + "/lab.env",
    "-f",
    sourceRoot + "/src/moodle-docker/base.yml",
    "-f",
    sourceRoot + "/src/moodle-docker/service.mail.yml",
    "-f",
    sourceRoot + "/src/moodle-docker/db.pgsql.yml",
    "-f",
    sourceRoot + "/src/moodle-docker/webserver.port.yml",
    "-f",
    labRoot + "/compose/local.yml",
  ];
}

async function labCli(args: string[]): Promise<Record<string, unknown>> {
  const command = new Deno.Command("docker", {
    args: [
      ...composeArgs(),
      "exec",
      "-T",
      "webserver",
      "php",
      "/opt/arahub-lab/tools/moodle_lab.php",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) throw new Error(`helper ${args[0]} falhou (exit ${output.code})`);
  const text = new TextDecoder().decode(output.stdout);
  const marker = "ARAHUB-LAB-JSON:";
  const index = text.lastIndexOf(marker);
  if (index < 0) throw new Error("helper sem marcador JSON: " + text.slice(-200));
  return JSON.parse(text.slice(index + marker.length).split("\n")[0]);
}
const negativeCli = (op: string, ...args: string[]) =>
  labCli(["negative", op, manifest.instance_id, run, ...args]);

async function labRest(
  token: string,
  fn: string,
  params: string[] = [],
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json" });
  for (const p of params) {
    const i = p.indexOf("=");
    body.append(p.slice(0, i), p.slice(i + 1));
  }
  const reply = await fetch(manifest.rest_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  const payload = await reply.json() as Record<string, unknown>;
  if (typeof payload.exception === "string") {
    throw new Error(fn + " → " + payload.errorcode + ": " + payload.message);
  }
  return payload;
}

async function cmidFor(instance: number, modname: string, course: number): Promise<number> {
  const contents = await labRest(studentToken, "core_course_get_contents", [
    "courseid=" + course,
  ]);
  for (
    const section of contents as unknown as Array<
      { modules?: Array<{ id: number; instance: number; modname: string }> }
    >
  ) {
    const found = (section.modules ?? []).find((m) =>
      Number(m.instance) === instance && m.modname === modname
    );
    if (found) return Number(found.id);
  }
  throw new Error("cmid nao encontrado para a instancia " + instance);
}

/** Envia de verdade e, para o alvo escolhido, perde a resposta. */
function losingTransport(target: string) {
  let sent = 0;
  const transport: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
      ? init.body.toString()
      : "";
    if (body.includes("wsfunction=" + target)) {
      sent++;
      await fetch(input as RequestInfo, init);
      throw new DOMException("resposta perdida (sintetico)", "TimeoutError");
    }
    return await fetch(input as RequestInfo, init);
  };
  return { transport, sent: () => sent };
}

const steps: Array<Record<string, unknown>> = [];
const evidence = (step: string, data: Record<string, unknown>) => {
  steps.push({ step, ...data });
  console.log(
    JSON.stringify({ step, ...(typeof data.passed === "boolean" ? { passed: data.passed } : {}) }),
  );
};
let failure: string | null = null;
let server: Deno.HttpServer | null = null;
let client: Client | null = null;
const db = createDb(dbUrl);
const hub = new Hub(db);
const owner = crypto.randomUUID();
const sid = crypto.randomUUID();
const browser: Principal = { ownerId: owner, sessionId: sid };

// --- Prova unitária: guardas de origem, sem tocar o laboratório ------------------
const unitCases: Array<Record<string, unknown>> = [];
for (
  const [name, origin, expectOk] of [
    ["institutional", "https://elearning.ulisboa.pt/webservice/rest/server.php", false],
    ["prefix_lookalike", "http://127.evil.com:8480", false],
    ["credentials", "http://lab:lab@127.0.0.1:8480", false],
    ["default_port", "http://127.0.0.1", false],
    ["subdirectory", "http://127.0.0.1:8480/moodle", false],
    ["loopback_ok", manifest.origin, true],
  ] as const
) {
  let ok = false;
  try {
    assertLabOrigin(origin);
    ok = true;
  } catch {
    ok = false;
  }
  unitCases.push({ name, expected_accept: expectOk, observed_accept: ok, passed: ok === expectOk });
}
evidence("unit.origin_guards", {
  cases: unitCases,
  passed: unitCases.every((c) => c.passed),
  calls_lab: false,
});

let fetchOverride: typeof fetch | undefined;
const writes: string[] = [];
const observedFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== new URL(manifest.origin).origin) {
    throw new Error("Origem divergente no transporte Lab");
  }
  const params = new URLSearchParams(
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
      ? init.body
      : "",
  );
  const fn = params.get("wsfunction") ?? "";
  if (url.pathname === "/webservice/upload.php") writes.push("upload");
  if (
    [
      "mod_assign_save_submission",
      "mod_assign_submit_for_grading",
      "mod_forum_add_discussion",
      "mod_forum_add_discussion_post",
    ].includes(fn)
  ) writes.push(fn);
  return (fetchOverride ?? fetch)(input, { ...init, redirect: "error" });
};

try {
  // Estrita: apenas lê rótulos e marcador; nunca inicializa/recupera a instalação.
  const guard = await new Deno.Command("pwsh", {
    args: [
      "-NoProfile",
      "-Command",
      `. ./scripts/lab/aralab-lib.ps1 -MoodleVersion '${instanceVersion}'; Assert-LabOwnership`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!guard.success) {
    throw new Error("Guarda estrita de containers/volumes/marcador recusou o Lab");
  }
  evidence("lab_ownership", { passed: true, mode: "strict_without_bootstrap" });
  const targets = await negativeCli("init", phase) as unknown as NegativeFixtures;
  evidence("isolated_targets", {
    run,
    course_id: targets.course,
    assignments: targets.assignments,
    forums: targets.forums,
    student: "labstudentb",
    student_a_untouched: true,
  });
  await db`insert into auth.users(id) values(${owner})`;
  const connection = await hub_connect();
  const connectionC = await hub.connect(
    browser,
    "moodle",
    "Moodle Lab estudante C",
    manifest.origin,
    String(manifest.accounts.labstudentc.userid),
    {},
  );
  const context = await hubContext();
  const artifacts = new Artifacts(hub);

  async function hub_connect() {
    return await hub.connect(
      browser,
      "moodle",
      "Moodle Lab (sintético)",
      manifest.origin,
      String(studentUserId),
      {},
    );
  }
  async function hubContext() {
    return await hub.createContext(browser, "Laboratório sintético (negativas)");
  }

  const source = Deno.readFileSync(labRoot + "/out/ficha-leitura-sintetica.docx");
  const stored = await artifacts.preserve(browser, connection.id, context.id, source, {
    id: "lab-negativas-docx",
    name: "ficha-negativas.docx",
    system: "lab_fixture",
  });
  const fileId = stored.id as string;
  evidence("fixture", {
    connection_id: connection.id,
    context_id: context.id,
    artifact_id: fileId,
    bytes: source.length,
    origin: "lab_fixture",
  });

  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const port = 8830 + Math.floor(Math.random() * 40);
  const publicUrl = "http://127.0.0.1:" + port;
  const authFixture = {
    issuer: "https://synthetic.invalid/auth",
    audience: "authenticated",
    resource: publicUrl + "/mcp",
    allowedClientIds: ["lab-negative"],
    key: createLocalJWKSet({
      keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "ES256" }],
    }),
    sessionActive: (o: string, s: string) => Promise.resolve(o === owner && s === sid),
  };
  const sign = (clientId: string | null) =>
    new SignJWT({
      role: "authenticated",
      session_id: sid,
      ...(clientId ? { client_id: clientId } : {}),
    }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(owner)
      .setIssuer(authFixture.issuer).setAudience("authenticated").setIssuedAt()
      .setExpirationTime("1h").sign(privateKey);
  const mcpToken = await sign("lab-negative");
  const browserToken = await sign(null);
  evidence("auth_fixture", {
    kind: "synthetic_local_es256",
    issuer: authFixture.issuer,
    audience: authFixture.audience,
    resource: authFixture.resource,
    allowed_client_ids: authFixture.allowedClientIds,
    approval_principal: "session principal (sem client_id)",
    note: "fixture sintética; nenhum token real participa",
  });

  const actions = new PersistentActionStore(db, {
    sessionActive: (o, s) => Promise.resolve(o === owner && s === sid),
  });
  const connections = {
    parent: async (_p: Principal, id: string) => ({
      id,
      label: "Moodle Lab (sintético)",
      provider_subject: String(
        id === connectionC.id ? manifest.accounts.labstudentc.userid : studentUserId,
      ),
      oauth_epoch: 0,
    }),
    moodle: async (_p: Principal, id: string) =>
      new MoodleLabAdapter(
        manifest,
        id === connectionC.id ? "labstudentc" : "labstudentb",
        instanceFile,
        observedFetch,
      ),
  } as unknown as ConnectionService;

  server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    createHandler(hub, {
      auth: authFixture,
      publicUrl,
      verify: createVerifier(authFixture),
      connections,
      actions,
    }),
  );

  client = new Client({ name: "lab-negative", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(authFixture.resource), {
      requestInit: { headers: { Authorization: "Bearer " + mcpToken } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client!.callTool({ name, arguments: args });
    const content = r.content as { text: string }[];
    return JSON.parse(content[0].text);
  };
  const approveHttp = async (actionId: string, hash: string, accepted: boolean) => {
    const r = await fetch(publicUrl + "/api/actions/approve", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + browserToken },
      body: JSON.stringify({
        action_id: actionId,
        content_hash: hash,
        statement_accepted: accepted,
      }),
    });
    return { status: r.status, body: await r.json() };
  };

  const oracle = (id: number) => labCli(["oracle", String(id), String(studentUserId)]);
  const statuses = (value: Record<string, unknown>) =>
    (value.submissions as Array<{ status: string }>).map((s) => s.status);
  const prepareAssign = (target: Target, ids = [fileId]) =>
    call("hub_prepare_moodle_action", {
      connection_id: connection.id,
      course_id: targets.course,
      cmid: target.cmid,
      kind: "assignment.submit",
      file_ids: ids,
    });
  const preserve = async (name: string, bytes: Uint8Array) =>
    (await artifacts.preserve(
      browser,
      connection.id,
      context.id,
      bytes,
      { id: name, name, system: "lab_fixture" },
    )).id as string;
  const approved = async (prepared: Record<string, any>) => {
    if (!prepared.action_id) throw new Error("prepare recusado: " + prepared.code);
    const result = await approveHttp(prepared.action_id, prepared.content_hash, true);
    if (result.status !== 200) throw new Error("aprovação HTTP recusada: " + result.body?.code);
  };

  if (phase === "base") {
    // ---------------- ACT-04: timeout real depois do efeito ----------------------
    {
      const assignId = targets.assignments.timeout.id;
      const losing = losingTransport("mod_assign_submit_for_grading");
      fetchOverride = losing.transport;
      const prepared = await call("hub_prepare_moodle_action", {
        connection_id: connection.id,
        course_id: targets.course,
        cmid: targets.assignments.timeout.cmid,
        kind: "assignment.submit",
        file_ids: [fileId],
      });
      await approveHttp(prepared.action_id, prepared.content_hash, true);
      const first = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
      const second = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
      const oracle = await labCli(["oracle", String(assignId), String(studentUserId)]);
      fetchOverride = undefined;
      evidence("act_04_timeout_after_effect", {
        first_state: first.state ?? null,
        second_state: second.state ?? null,
        provider_sends: losing.sent(),
        lab_statuses: (oracle.submissions as Array<{ status: string }>).map((s) => s.status),
        lab_submission_rows: oracle.submission_rows,
        passed: first.state === "uncertain" && second.state === "uncertain" &&
          losing.sent() === 1 && oracle.submission_rows === 1 &&
          (oracle.submissions as Array<{ status: string }>).every((s) => s.status === "submitted"),
      });
    }

    // ---------------- ACT-05: execuções concorrentes ----------------------------
    {
      const subject = "Concorrencia sintetica " + Date.now();
      const discussions = await labRest(studentToken, "mod_forum_get_forum_discussions", [
        "forumid=" + targets.forums.general.id,
      ]);
      const peer = (discussions.discussions as Array<{ discussion: number }>)[0].discussion;
      const prepared = await call("hub_prepare_moodle_action", {
        connection_id: connection.id,
        course_id: targets.course,
        cmid: targets.forums.general.cmid,
        kind: "forum.reply",
        discussion_id: peer,
        parent_id: ((await labRest(studentToken, "mod_forum_get_discussion_posts", [
          "discussionid=" + peer,
        ])).posts as Array<{ id: number }>)[0].id,
        subject,
        body: "Réplica sintética concorrente.",
        file_ids: [],
      });
      await approveHttp(prepared.action_id, prepared.content_hash, true);
      const results = await Promise.allSettled([
        call("hub_execute_moodle_action", { action_id: prepared.action_id }),
        call("hub_execute_moodle_action", { action_id: prepared.action_id }),
      ]);
      const states = results.map((r) =>
        r.status === "fulfilled"
          ? (r.value.state ?? null)
          : "error:" + String(r.reason).slice(0, 60)
      );
      const posts = await labRest(studentToken, "mod_forum_get_discussion_posts", [
        "discussionid=" + peer,
      ]);
      const withSubject = (posts.posts as Array<{ subject: string }>).filter((p) =>
        p.subject === subject
      ).length;
      evidence("act_05_concurrent", {
        states,
        codes: results.map((r) =>
          r.status === "fulfilled" ? (r.value.code ?? null) : "transport_error"
        ),
        replies_with_subject: withSubject,
        passed: withSubject === 1,
      });
    }

    // ACT-02: troca real do conteúdo do artifact depois da aprovação. Injeta uma
    // revisão íntegra no storage local sintético (bytes+digest); não é um mock Moodle.
    {
      const id = await preserve(
        "revisao.txt",
        new TextEncoder().encode("Conteúdo sintético versão A."),
      );
      const prepared = await prepareAssign(targets.assignments.content, [id]);
      await approved(prepared);
      const before = await oracle(targets.assignments.content.id);
      const first = await artifacts.load(browser, connection.id, id);
      const bytes = new TextEncoder().encode("Conteúdo sintético versão B após aprovação.");
      const nextHash = await sha256Hex(bytes);
      await db`update public.hub_files set binary_content=${
        Buffer.from(bytes)
      },bytes=${bytes.length},sha256=${nextHash}
      where owner_id=${owner} and id=${id}`;
      const changed = await artifacts.load(browser, connection.id, id);
      const at = writes.length;
      const executed = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
      const after = await oracle(targets.assignments.content.id);
      evidence("act_02_file_changed_after_approval", {
        injection: "synthetic_local_artifact_revision_after_http_approval",
        hash_before: first.sha256,
        hash_after: changed.sha256,
        execute_code: executed.code,
        provider_writes: writes.slice(at),
        submission_rows_before: before.submission_rows,
        submission_rows_after: after.submission_rows,
        statuses_after: statuses(after),
        passed: first.sha256 !== changed.sha256 &&
          executed.code === "preconditions_changed" && writes.length === at &&
          JSON.stringify(before) === JSON.stringify(after),
      });
    }

    // ACT-03: alteração intencional da configuração do próprio alvo, não um shell vazio.
    {
      const target = targets.assignments.config;
      const prepared = await prepareAssign(target);
      await approved(prepared);
      const before = await oracle(target.id);
      const changed = await negativeCli("config", String(target.id));
      const at = writes.length;
      const executed = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
      const after = await oracle(target.id);
      evidence("act_03_target_config_changed", {
        change: changed,
        execute_code: executed.code,
        provider_writes: writes.slice(at),
        statuses_after: statuses(after),
        passed: changed.before !== changed.after &&
          executed.code === "preconditions_changed" && writes.length === at &&
          JSON.stringify(before) === JSON.stringify(after),
      });
    }

    const pdf = Deno.readFileSync(labRoot + "/out/texto-base-sintetico.pdf");
    const pdfA = await preserve("primeiro.pdf", pdf);
    const pdfB = await preserve("segundo.pdf", pdf);
    // Controles de formato, contagem, tamanho e grupo usam configurações Moodle reais.
    for (
      const [name, target, ids, expected] of [
        ["assignment_pdf_only_docx", targets.assignments.pdf_only, [fileId], "file_type"],
        ["assignment_one_file_two_pdfs", targets.assignments.pdf_only, [pdfA, pdfB], "file_limit"],
        ["assignment_size_quota", targets.assignments.quota, [fileId], "file_limit"],
        [
          "assignment_group_assent_refused",
          targets.assignments.group,
          [fileId],
          "group_review_required",
        ],
      ] as const
    ) {
      const before = await oracle(target.id), at = writes.length;
      const prepared = await prepareAssign(target, [...ids]);
      const after = await oracle(target.id);
      evidence(name, {
        assignment_id: target.id,
        cmid: target.cmid,
        prepare_code: prepared.code,
        action_created: Boolean(prepared.action_id),
        provider_writes: writes.slice(at),
        submission_rows_before: before.submission_rows,
        submission_rows_after: after.submission_rows,
        passed: prepared.code === expected && !prepared.action_id && writes.length === at &&
          JSON.stringify(before) === JSON.stringify(after),
      });
    }
    // Controle positivo: mesmo alvo PDF aceita um PDF, para descartar recusa genérica.
    {
      const at = writes.length,
        prepared = await prepareAssign(targets.assignments.pdf_only, [pdfA]);
      evidence("assignment_pdf_positive_control", {
        state: prepared.state,
        provider_writes: writes.slice(at),
        passed: prepared.state === "prepared" && writes.length === at,
      });
    }

    // Sem botão: execute sem aprovação deve parar; depois da aprovação HTTP só save
    // finaliza. Confirmamos com REST estudante e oráculo PHP independente.
    {
      const target = targets.assignments.no_submit_button;
      const prepared = await prepareAssign(target);
      const before = await oracle(target.id), at = writes.length;
      const denied = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
      const afterDenied = await oracle(target.id);
      evidence("assignment_no_button_unapproved", {
        execute_code: denied.code,
        provider_writes: writes.slice(at),
        statuses: statuses(afterDenied),
        passed: !denied.state && writes.length === at &&
          JSON.stringify(before) === JSON.stringify(afterDenied),
      });
      await approved(prepared);
      const sentAt = writes.length;
      const executed = await call("hub_execute_moodle_action", { action_id: prepared.action_id });
      const after = await oracle(target.id);
      const state = await labRest(studentToken, "mod_assign_get_submission_status", [
        "assignid=" + target.id,
      ]);
      const studentStatus =
        (state.lastattempt as { submission: { status: string } }).submission.status;
      const sent = writes.slice(sentAt);
      evidence("assignment_no_button_approved_save_finalizes", {
        state: executed.state,
        provider_writes: sent,
        student_status: studentStatus,
        independent_statuses: statuses(after),
        submission_rows: after.submission_rows,
        passed: executed.state === "succeeded" && studentStatus === "submitted" &&
          after.submission_rows === 1 && statuses(after)[0] === "submitted" &&
          sent.filter((fn) => fn === "mod_assign_save_submission").length === 1 &&
          !sent.includes("mod_assign_submit_for_grading"),
      });
    }

    // Avisos: prova com disponibilidade efetiva, não somente flag de capacidade.
    {
      const target = targets.forums.news;
      const cmid = await cmidFor(target.id, "forum", targets.course);
      const access = await labRest(studentToken, "mod_forum_get_forum_access_information", [
        "forumid=" + target.id,
      ]);
      const availability = await labRest(studentToken, "mod_forum_can_add_discussion", [
        "forumid=" + target.id,
      ]);
      for (const kind of ["forum.discussion", "forum.reply"] as const) {
        const before = await negativeCli("forum-oracle", String(target.id)), at = writes.length;
        const prepared = await call("hub_prepare_moodle_action", {
          connection_id: connection.id,
          course_id: targets.course,
          cmid,
          kind,
          ...(kind === "forum.reply"
            ? { discussion_id: target.discussion, parent_id: target.root }
            : {}),
          subject: "Aviso sintético estudante",
          body: "Não deve ser publicado.",
          file_ids: [],
        });
        const after = await negativeCli("forum-oracle", String(target.id));
        evidence("forum_news_student_refused_" + kind.split(".")[1], {
          canstartdiscussion_flag: access.canstartdiscussion,
          availability_status: availability.status,
          prepare_code: prepared.code,
          provider_writes: writes.slice(at),
          posts_before: before.count,
          posts_after: after.count,
          passed:
            ["forum_closed", "access_denied", "discussion_unavailable"].includes(prepared.code) &&
            !prepared.action_id && writes.length === at &&
            JSON.stringify(before) === JSON.stringify(after),
        });
      }
    }
    // Q&A: o conteúdo do colega existe no banco, mas não pode ser lido pelo aluno B
    // antes de contribuir. Nenhuma resposta descartável para liberar acesso.
    {
      const target = targets.forums.qanda, at = writes.length;
      const before = await negativeCli("forum-oracle", String(target.id));
      const access = await labRest(studentToken, "mod_forum_get_forum_access_information", [
        "forumid=" + target.id,
      ]);
      const student = await labRest(studentToken, "mod_forum_get_discussion_posts", [
        "discussionid=" + target.discussion,
      ]);
      const teacher = await labRest(teacherToken, "mod_forum_get_discussion_posts", [
        "discussionid=" + target.discussion,
      ]);
      const after = await negativeCli("forum-oracle", String(target.id));
      const posts = (v: Record<string, unknown>) =>
        v.posts as Array<{ id: number; message: string; subject: string }>;
      const independent = (before.posts as Array<{ id: number; message: string }>).find((p) =>
        Number(p.id) === target.peer
      )!;
      const peerStudent = posts(student).find((p) => p.id === target.peer);
      const peerTeacher = posts(teacher).find((p) => p.id === target.peer);
      const studentHasContent = Boolean(
        peerStudent?.message.includes("Conteúdo condicionado sintético"),
      );
      evidence("forum_qanda_conditioned_read", {
        canviewqandawithoutposting: access.canviewqandawithoutposting,
        peer_id: target.peer,
        peer_in_database: Boolean(independent),
        peer_visible_teacher: Boolean(peerTeacher),
        student_receives_peer_content: studentHasContent,
        student_post_ids: posts(student).map((p) => p.id),
        provider_writes: writes.slice(at),
        posts_before: before.count,
        posts_after: after.count,
        passed: access.canviewqandawithoutposting === false && Boolean(independent) &&
          Boolean(peerTeacher?.message.includes("Conteúdo condicionado sintético")) &&
          !studentHasContent &&
          writes.length === at && JSON.stringify(before) === JSON.stringify(after),
      });
    }
  } else {
    const fileC = await artifacts.preserve(browser, connectionC.id, context.id, source, {
      id: "fixture-c",
      name: "fixture-c.docx",
      system: "lab_fixture",
    });
    await runExtendedCases({
      forumOnly: Deno.args.includes("--forum-only") || Deno.args.includes("--groups-only"),
      groupsOnly: Deno.args.includes("--groups-only"),
      warningOnly: Deno.args.includes("--warning-only"),
      setTransport: (value: typeof fetch | undefined) => {
        fetchOverride = value;
      },
      targets,
      call,
      approved,
      prepareAssign,
      preserve,
      oracle,
      cli: negativeCli,
      evidence,
      writes,
      connectionId: connection.id,
      connectionCId: connectionC.id,
      fileCId: fileC.id,
      studentUserId,
      source,
      fileId,
      pdf: Deno.readFileSync(labRoot + "/out/texto-base-sintetico.pdf"),
      adapter: new MoodleLabAdapter(manifest, "labstudentb", instanceFile, observedFetch),
      adapterC: new MoodleLabAdapter(manifest, "labstudentc", instanceFile, observedFetch),
    });
  }
} catch (error) {
  failure = (error as Error).message;
  evidence("error", { message: failure });
} finally {
  try {
    await client?.close();
  } catch { /* já fechado */ }
  try {
    await server?.shutdown();
  } catch { /* já desligado */ }
  try {
    await db`delete from auth.users where id=${owner}`;
  } catch { /* limpeza best-effort */ }
  await db.end();
}

const failedSteps = steps.filter((s) => s.passed === false).map((s) => s.step);
if (failedSteps.length) {
  failure = [failure, "Asserções falharam: " + failedSteps.join(", ")].filter(Boolean).join("; ");
}
const payload = {
  schema: "arahub.moodle-lab.negative-prove/1",
  instance_id: manifest.instance_id,
  origin: manifest.origin,
  transport: "mcp-sdk-streamable-http",
  phase,
  when: new Date().toISOString(),
  failed: failure,
  failed_steps: failedSteps,
  steps,
};
const outPath = labRoot + "/evidence/negative-" + (phase === "extended" ? "extended-" : "") +
  new Date().toISOString().replace(/[:.]/g, "") + ".json";
await Deno.mkdir(labRoot + "/evidence", { recursive: true });
Deno.writeTextFileSync(outPath, JSON.stringify(payload, null, 2));
console.log("evidência:", outPath);
for (const s of steps) console.log(JSON.stringify(s));
if (failure) {
  console.error("FALHA:", failure);
  Deno.exit(1);
}
