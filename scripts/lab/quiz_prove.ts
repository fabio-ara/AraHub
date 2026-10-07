/**
 * AraHub MIT — QUIZ-01/02 against the real isolated Moodle Lab, student REST.
 * No quiz capability is enabled in production. This is not a hosted/MCP quiz UI.
 * deno run --allow-read --allow-env --allow-net=localhost:8480 --allow-run=docker
 *   --allow-write=.private/entrega-1/lab/evidence scripts/lab/quiz_prove.ts --execute
 * Recovery: same private inputs plus --cleanup-only --run=UUID.
 * No browser. Never save/download images via UI/menu/shortcut/data/blob;
 * only native capture returns/bytes outside UI, if ever needed.
 */
import { createHash } from "node:crypto";
import { moodleActionSchema } from "../../src/moodle_actions.ts";
import { AUDITED_FUNCTIONS } from "../../src/adapters/moodle.ts";
import {
  assertLabOrigin,
  assertLabOwnership,
  loadLabManifest,
  MoodleLabAdapter,
} from "./moodle_lab_adapter.ts";

// Provider JSON is checked at the boundary and never serialized into evidence.
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const flag = (name: string) =>
  Deno.args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
const execute = Deno.args.includes("--execute");
const cleanupOnly = Deno.args.includes("--cleanup-only");
if (!execute && !cleanupOnly) {
  console.log("QUIZ: prepared only; explicit --execute required for isolated synthetic attempts.");
  Deno.exit(0);
}
if (execute && cleanupOnly) throw new Error("QUIZ_GUARD_MODE");
if (cleanupOnly && !flag("--run")) throw new Error("QUIZ_GUARD_RECOVERY_RUN");
const run = flag("--run") ?? crypto.randomUUID();
if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run)) throw new Error("QUIZ_GUARD_RUN");
const root = ".private/entrega-1/lab";
const manifest = await loadLabManifest(flag("--manifest") ?? root + "/manifest.lab.json");
const instanceFile = flag("--instance") ?? root + "/instances/arahublab456/instance.json";
assertLabOwnership(manifest, instanceFile);
if (manifest.origin !== "http://localhost:8480" || manifest.project !== "arahublab456") {
  throw new Error("QUIZ_GUARD_ORIGINAL_LAB");
}
const secrets = Object.values(manifest.accounts).map((a) => a.token).filter(Boolean) as string[];
const password = (manifest as unknown as Json).accounts_password;
if (typeof password === "string") secrets.push(password);
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const evidencePath = root + "/evidence/quiz-suite-" + run + "-" +
  new Date().toISOString().replace(/[:.]/g, "") + ".json";
const report: Json = {
  schema: "arahub.lab.quiz-suite/1",
  run,
  instance_id: manifest.instance_id,
  origin: manifest.origin,
  started_at: new Date().toISOString(),
  level: "lab_integration",
  status: "running",
  path:
    "real Moodle REST with student B; native read-only oracle; production policy checked separately",
  authorization:
    "user-authorized synthetic Lab quiz exercise, explicit --execute; not academic consent",
  results: [],
  source_hashes: Object.fromEntries(
    await Promise.all([
      "scripts/lab/quiz_prove.ts",
      "scripts/lab/quiz_fixtures.php",
      "src/adapters/moodle.ts",
      "src/moodle_actions.ts",
    ].map(async (path) => [path, hash(await Deno.readFile(path))])),
  ),
  limits: [
    "No university, hosted, browser or installed-host quiz action proof.",
    "No production quiz operation added; local harness authorization is not product approval.",
    "Timeout uses a temporary student override on the owned quiz; no system clock or cron change.",
    "Native synthetic attempts/history remain for inspection; temporary override/service/tokens are removed.",
  ],
};
const checks: Record<string, Record<string, boolean>> = { "QUIZ-01": {}, "QUIZ-02": {} };
const completed: Record<string, boolean> = { "QUIZ-01": false, "QUIZ-02": false };
const check = (scenario: string, name: string, pass: boolean) => {
  checks[scenario][name] = pass;
};
async function save() {
  report.results = Object.entries(checks).map(([id, checks]) => ({
    id,
    status: !completed[id] ? "incomplete" : Object.values(checks).every(Boolean) ? "pass" : "fail",
    checks,
  }));
  const serialized = JSON.stringify(report, null, 2);
  if (secrets.some((s) => serialized.includes(s))) throw new Error("QUIZ_SECRET_EVIDENCE_REFUSED");
  await Deno.mkdir(root + "/evidence", { recursive: true });
  await Deno.writeTextFile(evidencePath, serialized);
}
async function cli(command: string): Promise<Json> {
  const output = await new Deno.Command("docker", {
    args: [
      "--host",
      "npipe:////./pipe/docker_engine_linux",
      "exec",
      "arahublab456-webserver-1",
      "php",
      "/opt/arahub-lab/tools/quiz_fixtures.php",
      command,
      run,
      manifest.instance_id,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const raw = new TextDecoder().decode(output.stdout);
  const marker = "ARAHUB-QUIZ-JSON:";
  const index = raw.lastIndexOf(marker);
  if (output.code || index < 0) {
    report.helper_failure = { command, exit_code: output.code, stderr_bytes: output.stderr.length };
    throw new Error("QUIZ_HELPER_" + command);
  }
  return JSON.parse(raw.slice(index + marker.length).split("\n")[0]);
}
if (cleanupOnly) {
  report.cleanup = await cli("cleanup");
  report.status = "cleanup_only";
  await save();
  console.log("QUIZ cleanup: " + evidencePath);
  Deno.exit(0);
}
const discoveryFunctions = new Set([
  "core_webservice_get_site_info",
  "core_course_get_contents",
  "mod_quiz_get_quizzes_by_courses",
  "mod_quiz_get_quiz_access_information",
  "mod_quiz_get_user_attempts",
]);
const attemptFunctions = new Set([
  "mod_quiz_start_attempt",
  "mod_quiz_save_attempt",
  "mod_quiz_process_attempt",
  // These getters can advance an expired attempt: never classify them as passive discovery.
  "mod_quiz_get_attempt_data",
]);
const calls: Json[] = [];
let fixture: Json | undefined;
let issued = "";
let cleanupNeeded = false;
const ownedAttempts = new Set<number>();
type Permit = { fn: string; target: number; run: string; userid: number; expires: number };
const permit = (fn: string, target: number): Permit => ({
  fn,
  target,
  run,
  userid: fixture!.student_id,
  expires: Date.now() + 60_000,
});
function parameters(body: URLSearchParams, key: string, value: unknown) {
  if (Array.isArray(value)) value.forEach((v, i) => parameters(body, key + "[" + i + "]", v));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) parameters(body, key + "[" + k + "]", v);
  } else if (value !== undefined && value !== null) body.set(key, String(value));
}
// This transport lives only in the Lab runner. It does not extend the product allowlist.
class QuizStudentClient {
  private http = Deno.createHttpClient({ poolMaxIdlePerHost: 0 });
  close() {
    this.http.close();
  }
  async call(fn: string, args: Json = {}, authorization?: Permit): Promise<Json> {
    assertLabOwnership(manifest, instanceFile);
    if (!fixture || !issued || (!discoveryFunctions.has(fn) && !attemptFunctions.has(fn))) {
      throw new Error("QUIZ_FUNCTION_GUARD");
    }
    const quizIds = Object.values(fixture.quizzes).map((q) => (q as Json).id);
    if (
      (args.courseid !== undefined && args.courseid !== fixture.course_id) ||
      (args.courseids !== undefined &&
        (!Array.isArray(args.courseids) || args.courseids.length !== 1 ||
          args.courseids[0] !== fixture.course_id)) ||
      (args.quizid !== undefined && !quizIds.includes(args.quizid)) ||
      (args.attemptid !== undefined && !ownedAttempts.has(args.attemptid)) || args.forcenew
    ) {
      throw new Error("QUIZ_TARGET_GUARD");
    }
    if (
      attemptFunctions.has(fn) && (!authorization || authorization.fn !== fn ||
        authorization.target !== (args.attemptid ?? args.quizid) || authorization.run !== run ||
        authorization.userid !== fixture.student_id || authorization.expires < Date.now())
    ) {
      throw new Error("QUIZ_EXPLICIT_AUTHORIZATION_REQUIRED");
    }
    const body = new URLSearchParams({
      wstoken: issued,
      wsfunction: fn,
      moodlewsrestformat: "json",
    });
    for (const [k, v] of Object.entries(args)) parameters(body, k, v);
    const record: Json = {
      fn,
      target: args.attemptid ?? args.quizid ?? args.courseid ?? null,
      explicitly_authorized: !!authorization,
      dispatched_at: new Date().toISOString(),
    };
    calls.push(record);
    // No retries, including lost replies from a possibly committed write.
    const reply = await fetch(manifest.rest_endpoint, {
      method: "POST",
      body,
      redirect: "error",
      client: this.http,
      signal: AbortSignal.timeout(25_000),
    });
    if (!reply.ok) throw new Error("QUIZ_HTTP_" + reply.status);
    const data = await reply.json() as Json;
    record.response_received = true;
    if (data.exception) {
      const code = /^[a-z0-9_]+$/i.test(data.errorcode) ? data.errorcode : "details_omitted";
      record.error_code = code;
      throw new Error("QUIZ_MOODLE_" + code);
    }
    record.warning_count = data.warnings?.length ?? 0;
    if (fn === "mod_quiz_start_attempt" && Number.isInteger(data.attempt?.id)) {
      if (data.attempt.userid !== fixture.student_id || data.attempt.quiz !== args.quizid) {
        throw new Error("QUIZ_ATTEMPT_IDENTITY");
      }
      ownedAttempts.add(data.attempt.id);
    }
    return data;
  }
}
let student = new QuizStudentClient();
async function rejected(work: () => unknown, expected: RegExp): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    return error instanceof Error && expected.test(error.message);
  }
}
const attempts = (quizid: number) =>
  student.call("mod_quiz_get_user_attempts", { quizid, status: "all" });
async function saveResponse(attempt: Json) {
  const fn = "mod_quiz_get_attempt_data";
  const data = await student.call(fn, { attemptid: attempt.id, page: 0 }, permit(fn, attempt.id));
  const question = data.questions?.[0];
  const prefix = "q" + attempt.uniqueid + ":" + question?.slot + "_";
  if (
    question?.type !== "multichoice" || question.slot !== 1 ||
    !String(question.html).includes('name="' + prefix + 'answer"') ||
    !Number.isInteger(question.sequencecheck)
  ) throw new Error("QUIZ_QUESTION_FORM_CONTRACT");
  const answer = [
    { name: "slots", value: "1" },
    { name: prefix + ":sequencecheck", value: String(question.sequencecheck) },
    { name: prefix + "answer", value: "0" },
  ];
  const saved = await student.call(
    "mod_quiz_save_attempt",
    { attemptid: attempt.id, data: answer },
    permit("mod_quiz_save_attempt", attempt.id),
  );
  return saved.status === true && saved.warnings.length === 0;
}
try {
  cleanupNeeded = true;
  fixture = await cli("setup");
  report.fixture = fixture;
  if (fixture.student_id !== manifest.accounts.labstudentb.userid || fixture.course_id <= 4) {
    throw new Error("QUIZ_FIXTURE_IDENTITY");
  }
  issued = (await cli("token")).token;
  if (!issued || secrets.includes(issued)) throw new Error("QUIZ_DISPOSABLE_TOKEN_REQUIRED");
  secrets.push(issued);
  const disposableManifest = {
    ...manifest,
    accounts: { labstudentb: { userid: fixture.student_id, token: issued } },
  };
  const productionAdapter = new MoodleLabAdapter(disposableManifest, "labstudentb", instanceFile);
  const identity = await student.call("core_webservice_get_site_info");
  report.moodle_release = identity.release;
  check("QUIZ-01", "real_student_identity", identity.userid === fixture.student_id);
  const manual = fixture.quizzes.manual, timeout = fixture.quizzes.timeout;
  const baseline = await cli("oracle");
  if (baseline.manual.count || baseline.timeout.count) {
    throw new Error("QUIZ_REFUSE_EXISTING_ATTEMPTS");
  }
  const structure = await student.call("core_course_get_contents", { courseid: fixture.course_id });
  const inventory = await student.call("mod_quiz_get_quizzes_by_courses", {
    courseids: [fixture.course_id],
  });
  const access = await student.call("mod_quiz_get_quiz_access_information", { quizid: manual.id });
  await attempts(manual.id);
  await attempts(timeout.id);
  const afterDiscovery = await cli("oracle");
  check(
    "QUIZ-01",
    "inventory_and_structure",
    inventory.quizzes?.length === 2 &&
      [manual, timeout].every((q) =>
        inventory.quizzes.some((v: Json) => v.id === q.id) &&
        (structure as unknown as Json[]).some((s) =>
          s.modules?.some((m: Json) => m.id === q.cmid && m.modname === "quiz")
        )
      ),
  );
  check(
    "QUIZ-01",
    "student_not_teacher_or_preview",
    access.canattempt === true &&
      access.canmanage === false && access.canpreview === false && access.canviewreports === false,
  );
  check(
    "QUIZ-01",
    "discovery_consumes_no_attempt",
    JSON.stringify(baseline) === JSON.stringify(afterDiscovery),
  );
  const deniedBefore = calls.length;
  check(
    "QUIZ-01",
    "start_without_explicit_permission_refused",
    await rejected(
      () => student.call("mod_quiz_start_attempt", { quizid: manual.id }),
      /QUIZ_EXPLICIT_AUTHORIZATION_REQUIRED/,
    ),
  );
  check(
    "QUIZ-01",
    "wrong_target_refused",
    await rejected(
      () =>
        student.call(
          "mod_quiz_start_attempt",
          { quizid: -1 },
          permit("mod_quiz_start_attempt", -1),
        ),
      /QUIZ_TARGET_GUARD/,
    ),
  );
  check(
    "QUIZ-01",
    "wrong_permission_refused",
    await rejected(
      () =>
        student.call(
          "mod_quiz_start_attempt",
          { quizid: manual.id },
          permit("mod_quiz_start_attempt", timeout.id),
        ),
      /QUIZ_EXPLICIT_AUTHORIZATION_REQUIRED/,
    ),
  );
  check("QUIZ-01", "blocked_before_network", calls.length === deniedBefore);
  check(
    "QUIZ-01",
    "external_origin_refused",
    await rejected(() => {
      assertLabOrigin("https://example.invalid:8480");
    }, /fora de loopback/),
  );
  const productionCapabilities = await productionAdapter.discover();
  check(
    "QUIZ-01",
    "offered_quiz_not_production_enabled",
    fixture.service_functions.includes("mod_quiz_start_attempt") &&
      productionCapabilities.offered_functions.includes("mod_quiz_start_attempt") &&
      !productionCapabilities.available_functions.some((fn: string) =>
        fn.startsWith("mod_quiz_")
      ) &&
      !AUDITED_FUNCTIONS.some((fn) => fn.startsWith("mod_quiz_")),
  );
  const coreDenied = ["quiz.start", "quiz.save", "quiz.finish"].every((kind) =>
    !moodleActionSchema.safeParse({
      connection_id: crypto.randomUUID(),
      course_id: fixture!.course_id,
      cmid: manual.cmid,
      kind,
    }).success
  );
  check("QUIZ-01", "production_action_schema_denies_quiz", coreDenied);
  check(
    "QUIZ-01",
    "other_student_history_refused_by_moodle",
    await rejected(() =>
      student.call(
        "mod_quiz_get_user_attempts",
        { quizid: manual.id, userid: manifest.accounts.labstudenta.userid, status: "all" },
      ), /QUIZ_MOODLE_(required_capability_exception|nopermissions)/),
  );
  const started = await student.call(
    "mod_quiz_start_attempt",
    { quizid: manual.id },
    permit("mod_quiz_start_attempt", manual.id),
  );
  const a = started.attempt;
  if (!a?.id || started.warnings.length) throw new Error("QUIZ_START_NOT_CONFIRMED");
  const afterStart = await cli("oracle");
  check(
    "QUIZ-01",
    "explicit_start_one_attempt",
    a.state === "inprogress" && a.preview === 0 &&
      afterStart.manual.count === 1 && afterStart.manual.attempts[0].id === a.id && a.attempt === 1,
  );
  check(
    "QUIZ-01",
    "timer_started",
    a.timestart > 0 && a.timefinish === 0 && a.timecheckstate === a.timestart + 600,
  );
  const initialState = JSON.stringify(afterStart.manual);
  await student.call("mod_quiz_get_quizzes_by_courses", { courseids: [fixture.course_id] });
  await attempts(manual.id);
  check(
    "QUIZ-01",
    "discovery_preserves_running_attempt",
    JSON.stringify((await cli("oracle")).manual) === initialState,
  );
  report.discovery = { before: baseline, after: afterDiscovery, after_start: afterStart };
  completed["QUIZ-01"] = true;
  await save();

  check("QUIZ-02", "save_acknowledged", await saveResponse(a));
  const saved = await cli("oracle");
  student.close();
  student = new QuizStudentClient();
  const reconnected = await student.call(
    "mod_quiz_get_attempt_data",
    { attemptid: a.id, page: 0 },
    permit("mod_quiz_get_attempt_data", a.id),
  );
  const afterReconnect = await cli("oracle");
  check(
    "QUIZ-02",
    "reconnect_same_attempt_and_timer",
    reconnected.attempt.id === a.id &&
      reconnected.attempt.state === "inprogress" && reconnected.attempt.timestart === a.timestart &&
      reconnected.attempt.timecheckstate === a.timecheckstate && afterReconnect.manual.count === 1,
  );
  check(
    "QUIZ-02",
    "saved_response_recovered",
    saved.manual.attempts[0].first_choice_saved === true &&
      reconnected.questions[0].state === "complete" &&
      reconnected.questions[0].hasautosavedstep === true &&
      saved.manual.attempts[0].response_sha256 ===
        afterReconnect.manual.attempts[0].response_sha256,
  );
  const finish = await student.call("mod_quiz_process_attempt", {
    attemptid: a.id,
    finishattempt: 1,
  }, permit("mod_quiz_process_attempt", a.id));
  const finishedList = await attempts(manual.id);
  const finished = await cli("oracle");
  check(
    "QUIZ-02",
    "manual_finish_confirmed",
    finish.state === "finished" && finish.warnings.length === 0 &&
      finishedList.attempts.length === 1 && finishedList.attempts[0].state === "finished" &&
      finished.manual.attempts[0].state === "finished" &&
      finished.manual.attempts[0].timefinish >= a.timestart,
  );
  check(
    "QUIZ-02",
    "finish_preserves_saved_answer",
    finished.manual.attempts[0].first_choice_saved === true &&
      finished.manual.attempts[0].response_sha256 === saved.manual.attempts[0].response_sha256,
  );
  check(
    "QUIZ-02",
    "closed_attempt_refuses_more_saves",
    await rejected(() =>
      student.call(
        "mod_quiz_save_attempt",
        { attemptid: a.id, data: [{ name: "slots", value: "1" }] },
        permit("mod_quiz_save_attempt", a.id),
      ), /QUIZ_MOODLE_attemptalreadyclosed/),
  );
  const exhausted = await student.call(
    "mod_quiz_start_attempt",
    { quizid: manual.id },
    permit("mod_quiz_start_attempt", manual.id),
  );
  check(
    "QUIZ-02",
    "attempt_limit_enforced",
    !exhausted.attempt?.id && exhausted.warnings.length > 0 &&
      (await cli("oracle")).manual.count === 1,
  );

  const b = (await student.call(
    "mod_quiz_start_attempt",
    { quizid: timeout.id },
    permit("mod_quiz_start_attempt", timeout.id),
  )).attempt;
  if (!b?.id) throw new Error("QUIZ_TIMEOUT_START_NOT_CONFIRMED");
  check("QUIZ-02", "timeout_answer_saved", await saveResponse(b));
  const timeoutSaved = await cli("oracle");
  report.timeout_mutation = await cli("expire");
  const expiredBefore = await cli("oracle");
  const timeoutResult = await student.call("mod_quiz_process_attempt", {
    attemptid: b.id,
    timeup: 1,
    finishattempt: 0,
  }, permit("mod_quiz_process_attempt", b.id));
  const timeoutAfter = await cli("oracle");
  const timeoutList = await attempts(timeout.id);
  check(
    "QUIZ-02",
    "real_expired_deadline",
    expiredBefore.timeout.attempts[0].timecheckstate === report.timeout_mutation.deadline &&
      report.timeout_mutation.deadline < Date.now() / 1000 &&
      expiredBefore.timeout.attempts[0].state === "inprogress",
  );
  check(
    "QUIZ-02",
    "timeup_autosubmits",
    timeoutResult.state === "finished" && timeoutResult.warnings.length === 0 &&
      timeoutAfter.timeout.attempts[0].state === "finished" &&
      timeoutList.attempts[0].state === "finished",
  );
  check(
    "QUIZ-02",
    "timeout_preserves_attempt_timer_and_answer",
    timeoutAfter.timeout.count === 1 &&
      timeoutAfter.timeout.attempts[0].id === b.id &&
      timeoutAfter.timeout.attempts[0].timestart === b.timestart &&
      timeoutAfter.timeout.attempts[0].timefinish >= report.timeout_mutation.deadline &&
      timeoutAfter.timeout.attempts[0].timefinish <=
        report.timeout_mutation.deadline + report.timeout_mutation.online_grace_seconds &&
      timeoutAfter.timeout.attempts[0].timefinish === timeoutList.attempts[0].timefinish &&
      timeoutAfter.timeout.attempts[0].first_choice_saved === true &&
      timeoutAfter.timeout.attempts[0].response_sha256 ===
        timeoutSaved.timeout.attempts[0].response_sha256,
  );
  check(
    "QUIZ-02",
    "timeout_closed_save_refused",
    await rejected(() =>
      student.call("mod_quiz_save_attempt", {
        attemptid: b.id,
        data: [{ name: "slots", value: "1" }],
      }, permit("mod_quiz_save_attempt", b.id)), /QUIZ_MOODLE_(attemptalreadyclosed|attempterror)/),
  );
  report.restoration = await cli("restore");
  check(
    "QUIZ-02",
    "deadline_restored",
    report.restoration.override_removed === true &&
      report.restoration.effective_timeclose === 0 &&
      report.restoration.effective_timelimit === 600,
  );
  const finalState = await cli("oracle");
  check(
    "QUIZ-02",
    "restoration_does_not_reopen_attempt",
    finalState.timeout.attempts[0].state === "finished" &&
      finalState.timeout.count === 1 && finalState.manual.count === 1,
  );
  check(
    "QUIZ-02",
    "rejected_save_preserves_finished_answer",
    finalState.timeout.attempts[0].id === b.id &&
      finalState.timeout.attempts[0].timefinish === timeoutAfter.timeout.attempts[0].timefinish &&
      finalState.timeout.attempts[0].response_sha256 ===
        timeoutSaved.timeout.attempts[0].response_sha256,
  );
  report.timeout_semantics =
    "Online finish records processing time within Moodle grace; an expired quiz may reject access before checking closed state.";
  check(
    "QUIZ-02",
    "production_policy_unchanged",
    coreDenied && !AUDITED_FUNCTIONS.some((fn) => fn.startsWith("mod_quiz_")),
  );
  report.states = {
    saved,
    after_reconnect: afterReconnect,
    manual_finished: finished,
    timeout_saved: timeoutSaved,
    expired_before_process: expiredBefore,
    timeout_finished: timeoutAfter,
    final: finalState,
  };
  completed["QUIZ-02"] = true;
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown";
  report.fatal = /^[a-zA-Z0-9_: .-]{1,120}$/.test(message) && !secrets.some((s) =>
      message.includes(s)
    )
    ? message
    : "error_details_omitted";
  // Reconcile once, read-only, after any uncertain write. Never resend an attempt operation.
  if (fixture) {
    try {
      report.failure_oracle = await cli("oracle");
    } catch {
      report.failure_oracle_unavailable = true;
    }
  }
} finally {
  student.close();
  if (cleanupNeeded) {
    try {
      report.cleanup = await cli("cleanup");
    } catch {
      report.cleanup_failed = true;
    }
  }
  report.calls = calls;
  report.finished_at = new Date().toISOString();
  report.status = !report.fatal && !report.cleanup_failed &&
      Object.values(completed).every(Boolean) &&
      Object.values(checks).every((group) =>
        Object.keys(group).length && Object.values(group).every(Boolean)
      )
    ? "pass"
    : "fail";
  await save();
  console.log("QUIZ-01/02: " + report.status + "; evidence: " + evidencePath);
}
if (report.status !== "pass") Deno.exitCode = 1;
