/**
 * Testes de fixture do adaptador Moodle. Sem rede real: o fetch e o resolvedor
 * de DNS sao injetados. Dependencia unica: node:assert/strict.
 */

import assert from "node:assert/strict";
import {
  AUDITED_FUNCTIONS,
  BLOCKED_FUNCTIONS,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  flattenMoodleParams,
  IMPLEMENTED_FUNCTIONS,
  isBlockedFunction,
  isPublicIp,
  MAX_COURSE_IDS,
  MoodleAdapter,
  type MoodleConfig,
  MoodleError,
  parseMoodleOrigin,
  positiveId,
  sanitizeHtml,
  unwrap,
} from "../src/adapters/moodle.ts";

const ORIGIN = "https://moodle.example";
const SUBDIR_ORIGIN = "https://moodle.example/ava";
const TOKEN = "fixture-token-not-a-real-secret";

const DEFAULT_OFFERED: string[] = [
  ...AUDITED_FUNCTIONS,
  "mod_assign_get_submission_status",
  "gradereport_user_get_grade_items",
  "core_course_view_course",
];

type Handler = (url: string, params: URLSearchParams) => Response | Promise<Response>;

interface RecordedCall {
  url: string;
  params: URLSearchParams;
  init: RequestInit;
}

class FakeTransport {
  readonly calls: RecordedCall[] = [];
  private readonly handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const params = new URLSearchParams(body);
    this.calls.push({ url, params, init: init ?? {} });
    return await this.handler(url, params);
  };

  functionsCalled(): string[] {
    return this.calls.map((call) => call.params.get("wsfunction") ?? "").filter((name) =>
      name !== ""
    );
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function siteInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userid: 42,
    username: "aluno",
    fullname: "Aluno Teste",
    sitename: "Moodle Fixture",
    siteurl: ORIGIN,
    release: "4.5.6+",
    version: "2025081900",
    functions: DEFAULT_OFFERED.map((name) => ({ name, version: "4.5", available: true })),
    ...overrides,
  };
}

function siteFirst(inner: Handler, offered: string[] = DEFAULT_OFFERED): Handler {
  return async (url, params) => {
    if (params.get("wsfunction") === "core_webservice_get_site_info") {
      return json({ ...siteInfo(), functions: offered.map((name) => ({ name })) });
    }
    return await inner(url, params);
  };
}

function adapterWith(
  handler: Handler,
  config: Partial<MoodleConfig> = {},
): { adapter: MoodleAdapter; transport: FakeTransport } {
  const transport = new FakeTransport(handler);
  const adapter = new MoodleAdapter(
    { origin: ORIGIN, token: TOKEN, ...config },
    { fetch: transport.fetch },
  );
  return { adapter, transport };
}

// --- Origem ---------------------------------------------------------------

Deno.test("origem: aceita HTTPS e normaliza subdiretorio", () => {
  assert.equal(parseMoodleOrigin("https://moodle.example").origin, "https://moodle.example");
  assert.equal(parseMoodleOrigin("https://moodle.example/").origin, "https://moodle.example");
  assert.equal(parseMoodleOrigin("https://moodle.example/ava/").origin, SUBDIR_ORIGIN);
  assert.equal(
    parseMoodleOrigin("http://127.0.0.1:8787/moodle").origin,
    "http://127.0.0.1:8787/moodle",
  );
});

Deno.test("origem: recusa esquema, credenciais, query, porta e traversal", () => {
  assert.throws(() => parseMoodleOrigin("http://moodle.example"), MoodleError);
  assert.throws(() => parseMoodleOrigin("https://user:pass@moodle.example"), MoodleError);
  assert.throws(() => parseMoodleOrigin("https://moodle.example/?x=1"), MoodleError);
  assert.throws(() => parseMoodleOrigin("https://moodle.example#frag"), MoodleError);
  assert.throws(() => parseMoodleOrigin("https://moodle.example:8443"), MoodleError);
  assert.throws(() => parseMoodleOrigin("https://moodle.example/a%2f..%2fb"), MoodleError);
  assert.throws(() => parseMoodleOrigin("https://moodle.example/%252e%252e/x"), MoodleError);
});

Deno.test("isPublicIp distingue alcance global", () => {
  assert.equal(isPublicIp("93.184.216.34"), true);
  assert.equal(isPublicIp("2606:2800:220:1::1"), true);
  assert.equal(isPublicIp("127.0.0.1"), false);
  assert.equal(isPublicIp("10.1.2.3"), false);
  assert.equal(isPublicIp("192.168.1.1"), false);
  assert.equal(isPublicIp("169.254.169.254"), false);
  assert.equal(isPublicIp("::1"), false);
  assert.equal(isPublicIp("fe80::1"), false);
  assert.equal(isPublicIp("fe80::"), false);
  assert.equal(isPublicIp("fd00::1"), false);
  assert.equal(isPublicIp("fec0::1"), false);
  assert.equal(isPublicIp("2001:db8::1"), false);
  assert.equal(isPublicIp("2001::1"), false);
  assert.equal(isPublicIp("100::1"), false);
  assert.equal(isPublicIp("3fff::1"), false);
  assert.equal(isPublicIp("64:ff9b::a00:1"), false);
  assert.equal(isPublicIp("::"), false);
  assert.equal(isPublicIp("0:0:0:0:0:0:0:1"), false);
  // IPv4 embutido em IPv6, decimal e hexadecimal.
  assert.equal(isPublicIp("::ffff:8.8.8.8"), true);
  assert.equal(isPublicIp("::8.8.8.8"), true);
  assert.equal(isPublicIp("::ffff:7f00:1"), false);
  assert.equal(isPublicIp("0:0:0:0:0:ffff:127.0.0.1"), false);
  assert.equal(isPublicIp("::127.0.0.1"), false);
  assert.equal(isPublicIp("2002:0808:0808::"), true);
  assert.equal(isPublicIp("2002:7f00:1::"), false);
  assert.equal(isPublicIp("gggg::1"), false);
  assert.equal(isPublicIp("not-an-ip"), false);
});

// --- Identidade e descoberta ---------------------------------------------

Deno.test("identidade: valida siteurl e userid", async () => {
  const { adapter } = adapterWith(siteFirst(() => json([])));
  const identity = unwrap(await adapter.getIdentity());
  assert.equal(identity.user_id, 42);
  assert.equal(identity.site_url, ORIGIN);
  assert.equal(identity.release, "4.5.6+");
  assert.equal((await adapter.discover()).user_id, 42);
});

Deno.test("identidade: recusa siteurl de outra origem", async () => {
  const { adapter } = adapterWith(() => json({ ...siteInfo(), siteurl: "https://evil.example" }));
  const result = await adapter.getIdentity();
  assert.equal(result.coverage, "denied");
  assert.equal(result.error_code, "security_error");
});

Deno.test("identidade: recusa userid ausente ou invalido", async () => {
  const { adapter } = adapterWith(() => json({ ...siteInfo(), userid: 0 }));
  const result = await adapter.getIdentity();
  assert.equal(result.coverage, "parsing_error");
  assert.equal(result.error_code, "parsing_error");
});

Deno.test("descoberta: interseccao auditada, oferecida e implementada", async () => {
  const { adapter } = adapterWith(siteFirst(() => json([])));
  const capabilities = await adapter.discover();
  assert.deepEqual(capabilities.available_functions, [...AUDITED_FUNCTIONS].sort());
  assert.deepEqual(capabilities.implemented_functions, [...IMPLEMENTED_FUNCTIONS]);
  assert.deepEqual(capabilities.not_offered_functions, []);
  assert.equal(capabilities.blocked_functions.length, BLOCKED_FUNCTIONS.length);
  assert.equal(capabilities.academic_read_only, true);
  assert.equal(capabilities.redirects_followed, false);
  assert.equal(
    IMPLEMENTED_FUNCTIONS.some((name) => /(^|_)view(_|$)/.test(name)),
    false,
  );
  assert.equal(await adapter.isAvailable("core_course_view_course"), false);
});

Deno.test("descoberta: funcao auditada nao oferecida fica indisponivel", async () => {
  const offered = ["core_webservice_get_site_info", "core_enrol_get_users_courses"];
  const { adapter } = adapterWith(siteFirst(() => json([]), offered));
  const capabilities = await adapter.discover();
  assert.deepEqual(
    [...capabilities.available_functions].sort(),
    [
      "core_enrol_get_users_courses",
      "core_webservice_get_site_info",
    ].sort(),
  );
  assert.ok(capabilities.not_offered_functions.includes("mod_page_get_pages_by_courses"));
  const pages = await adapter.getPages([1]);
  assert.equal(pages.coverage, "unavailable");
  assert.equal(pages.error_code, "function_unavailable");
});

// --- Segredos -------------------------------------------------------------

Deno.test("token nunca aparece em retorno nem em erro", async () => {
  const { adapter } = adapterWith(siteFirst(() => json([])));
  const identity = await adapter.getIdentity();
  assert.ok(!JSON.stringify(identity).includes(TOKEN));

  const leaky = adapterWith(() =>
    json({
      exception: "moodle_exception",
      errorcode: "invalidtoken",
      message: "Token " + TOKEN + " invalido",
    })
  );
  const result = await leaky.adapter.getIdentity();
  assert.equal(result.error_code, "invalid_token");
  assert.equal(result.coverage, "expired");
  assert.ok(!JSON.stringify(result).includes(TOKEN));

  await assert.rejects(
    async () => await leaky.adapter.initialize(),
    (error: unknown) => {
      assert.ok(error instanceof MoodleError);
      assert.ok(!String((error as Error).message).includes(TOKEN));
      return true;
    },
  );
});

// --- Erros e cobertura ----------------------------------------------------

Deno.test("erros do Moodle mapeiam cobertura distinta", async () => {
  const denied = adapterWith(
    siteFirst(() =>
      json({ exception: "moodle_exception", errorcode: "accessexception", message: "negado" })
    ),
  );
  const list = await denied.adapter.listCourses();
  assert.equal(list.coverage, "denied");
  assert.equal(list.error_code, "permission_denied");

  const unavailable = adapterWith(
    siteFirst(() =>
      json({
        exception: "moodle_exception",
        errorcode: "servicenotavailable",
        message: "indisponivel",
      })
    ),
  );
  const pages = await unavailable.adapter.getPages([1]);
  assert.equal(pages.coverage, "unavailable");
  assert.equal(pages.error_code, "function_unavailable");

  const nocriteria = adapterWith(
    siteFirst(() =>
      json({ exception: "moodle_exception", errorcode: "nocriteriaset", message: "sem criterio" })
    ),
  );
  const completion = await nocriteria.adapter.getCourseCompletion(2);
  assert.equal(completion.coverage, "unavailable");
  assert.equal(completion.error_detail?.moodle_code, "nocriteriaset");
});

Deno.test("timeout, parsing_error e limite de bytes", async () => {
  const timeout = adapterWith(() => {
    throw new DOMException("tempo esgotado", "AbortError");
  });
  const timedOut = await timeout.adapter.getIdentity();
  assert.equal(timedOut.coverage, "timeout");
  assert.equal(timedOut.error_code, "timeout");

  const broken = adapterWith(() => new Response("nao e json", { status: 200 }));
  const parsed = await broken.adapter.getIdentity();
  assert.equal(parsed.coverage, "parsing_error");

  const capped = adapterWith(siteFirst(() => json([])), { maxResponseBytes: 16 });
  const limited = await capped.adapter.getIdentity();
  assert.equal(limited.error_code, "limit_exceeded");
  assert.equal(limited.coverage, "unavailable");
});

Deno.test("redirecionamento recusado e redirect manual", async () => {
  const { adapter, transport } = adapterWith(() =>
    new Response(null, { status: 302, headers: { location: ORIGIN + "/login/index.php" } })
  );
  const result = await adapter.getIdentity();
  assert.equal(result.coverage, "denied");
  assert.equal(result.error_code, "security_error");
  assert.equal(transport.calls[0].init.redirect, "manual");
});

Deno.test("DNS nao publico e recusado antes de qualquer requisicao", async () => {
  const adapter = new MoodleAdapter(
    { origin: ORIGIN, token: TOKEN },
    { resolveHost: async () => ["10.0.0.5"] },
  );
  const result = await adapter.getIdentity();
  assert.equal(result.coverage, "denied");
  assert.equal(result.error_code, "security_error");

  const empty = new MoodleAdapter({ origin: ORIGIN, token: TOKEN }, {
    resolveHost: async () => [],
  });
  assert.equal((await empty.getIdentity()).error_code, "security_error");
});

Deno.test("DNS e revalidado a cada envio: public muda para private e recusa", async () => {
  const sequence: string[][] = [["93.184.216.34"], ["10.0.0.5"]];
  let resolutions = 0;
  const transport = new FakeTransport(siteFirst(() => json([])));
  const adapter = new MoodleAdapter(
    { origin: ORIGIN, token: TOKEN },
    {
      fetch: transport.fetch,
      resolveHost: async () => {
        const value = sequence[Math.min(resolutions, sequence.length - 1)];
        resolutions++;
        return value;
      },
    },
  );
  const first = await adapter.getIdentity();
  assert.equal(first.coverage, "complete");
  assert.equal(resolutions, 1);

  const second = await adapter.listCourses();
  assert.equal(second.coverage, "denied");
  assert.equal(second.error_code, "security_error");
  assert.equal(resolutions, 2);
  assert.equal(transport.functionsCalled().includes("core_enrol_get_users_courses"), false);

  // A validacao nao fica em cache: uma nova chamada que envia credencial
  // resolve de novo.
  const third = await adapter.listCourses();
  assert.equal(third.error_code, "security_error");
  assert.equal(resolutions, 3);
});

// --- Parametros e paginacao ----------------------------------------------

Deno.test("parametros achatados e nada bloqueado e chamado", async () => {
  const { adapter, transport } = adapterWith(siteFirst(() => json([])));
  const result = await adapter.getPages([5, 7]);
  assert.equal(result.coverage, "complete");
  assert.equal(result.empty, true);
  const call = transport.calls.find((item) =>
    item.params.get("wsfunction") === "mod_page_get_pages_by_courses"
  );
  assert.ok(call);
  assert.equal(call.params.get("courseids[0]"), "5");
  assert.equal(call.params.get("courseids[1]"), "7");
  assert.equal(call.params.get("moodlewsrestformat"), "json");
  assert.equal(call.params.get("wstoken"), TOKEN);
  const called = transport.functionsCalled();
  assert.equal(called.some((name) => name === "mod_assign_get_submission_status"), false);
  assert.equal(called.some((name) => name === "gradereport_user_get_grade_items"), false);
  assert.equal(called.some((name) => /(^|_)view(_|$)/.test(name)), false);
});

Deno.test("flattenMoodleParams recusa parametro reservado e aninhados", () => {
  assert.deepEqual(flattenMoodleParams({ a: 1, b: true, c: [2, 3], d: { e: "x" } }), {
    a: "1",
    b: "1",
    "c[0]": "2",
    "c[1]": "3",
    "d[e]": "x",
  });
  assert.throws(() => flattenMoodleParams({ wstoken: "x" }), MoodleError);
});

Deno.test("positiveId e limites de cursos", async () => {
  assert.equal(positiveId(3), 3);
  assert.throws(() => positiveId(0), MoodleError);
  assert.throws(() => positiveId(-1), MoodleError);
  assert.throws(() => positiveId(1.5), MoodleError);
  assert.throws(() => positiveId("1"), MoodleError);

  const { adapter } = adapterWith(siteFirst(() => json([])));
  const tooMany = Array.from({ length: MAX_COURSE_IDS + 1 }, (_, index) => index + 1);
  const result = await adapter.getPages(tooMany);
  assert.equal(result.error_code, "limit_exceeded");
  assert.equal(result.coverage, "unavailable");
});

Deno.test("forum: paginacao de discussoes e validacao de limites", async () => {
  const discussions = [1, 2, 3].map((id) => ({ discussion: id, name: "d" + id }));
  const { adapter } = adapterWith(siteFirst(() => json({ discussions, warnings: [] })));
  const page = await adapter.getForumDiscussions(9, { page: 0, perPage: 3 });
  assert.equal(page.data?.length, 3);
  assert.equal(page.pagination?.has_more, true);
  assert.equal(page.pagination?.per_page, 3);

  const badPage = await adapter.getForumDiscussions(9, { page: -1 });
  assert.equal(badPage.error_code, "invalid_id");
  const badPerPage = await adapter.getForumDiscussions(9, { perPage: 500 });
  assert.equal(badPerPage.error_code, "limit_exceeded");
});

Deno.test("posts: offset/limit com truncamento e cobertura parcial", async () => {
  const posts = [1, 2, 3, 4, 5].map((id) => ({ id, subject: "p" + id }));
  const { adapter } = adapterWith(siteFirst(() => json({ posts, warnings: [] })));
  const result = await adapter.getDiscussionPosts(11, { offset: 1, limit: 2 });
  assert.equal(result.coverage, "partial");
  assert.equal(result.truncated, true);
  assert.equal(result.data?.length, 2);
  assert.equal(result.pagination?.total_available, 5);
  assert.equal(result.pagination?.has_more, true);
  const all = await adapter.getDiscussionPosts(11, { offset: 0, limit: 50 });
  assert.equal(all.coverage, "complete");
  assert.equal(all.truncated, false);
  assert.equal(all.data?.length, 5);
  for (const outcome of [result, all]) {
    // Invariante: nunca existe truncated=true junto de coverage "complete".
    assert.equal(outcome.truncated && outcome.coverage === "complete", false);
    if (outcome.truncated) assert.equal(outcome.coverage, "partial");
    if (outcome.coverage === "complete") assert.equal(outcome.truncated, false);
  }
});

Deno.test("avisos do Moodle marcam cobertura parcial", async () => {
  const { adapter } = adapterWith(
    siteFirst(() =>
      json({
        courses: [{ id: 1, assignments: [{ id: 3, name: "T1" }] }],
        warnings: [{ warningcode: "1", message: "acesso" }],
      })
    ),
  );
  const result = await adapter.getAssignments([1]);
  assert.equal(result.coverage, "partial");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.data?.length, 1);
  assert.equal(result.data?.[0].course_id, 1);
});

// --- Arquivos -------------------------------------------------------------

function resourceFixture(fileUrl: string): unknown[] {
  return [{
    id: 7,
    name: "Recurso",
    contents: [{
      type: "file",
      filename: "a.pdf",
      filepath: "/",
      filesize: 12,
      mimetype: "application/pdf",
      fileurl: fileUrl,
    }],
  }];
}

Deno.test("arquivos: registro interno e download limitado", async () => {
  const fileUrl = ORIGIN + "/webservice/pluginfile.php/7/mod_resource/content/0/a.pdf";
  const transport = new FakeTransport(siteFirst((url) => {
    if (url.includes("pluginfile.php")) {
      return new Response(new Uint8Array([104, 101, 108, 108, 111]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    return json(resourceFixture(fileUrl));
  }));
  const adapter = new MoodleAdapter(
    { origin: ORIGIN, token: TOKEN },
    { fetch: transport.fetch },
  );
  const resources = await adapter.getResources([7]);
  assert.equal(resources.coverage, "complete");
  const contents = (resources.data?.[0].contents as Record<string, unknown>[])[0];
  const ref = contents.file as Record<string, unknown>;
  assert.equal(typeof ref.file_id, "string");
  assert.equal(ref.filename, "a.pdf");

  const registered = adapter.listRegisteredFiles();
  assert.equal(registered.length, 1);
  const binary = unwrap(await adapter.downloadFile(registered[0].file_id));
  assert.equal(binary.byte_length, 5);
  assert.equal(binary.filename, "a.pdf");
  assert.match(binary.sha256, /^[0-9a-f]{64}$/);
  const getCall = transport.calls[transport.calls.length - 1];
  assert.ok(getCall.url.includes("token="));
  assert.equal(getCall.init.redirect, "manual");
});

Deno.test("arquivos: host externo e traversal nunca registram", async () => {
  const external = adapterWith(
    siteFirst(() =>
      json(resourceFixture("https://evil.example/webservice/pluginfile.php/7/a.pdf"))
    ),
  );
  const externalResult = await external.adapter.getResources([7]);
  const externalFile = (externalResult.data?.[0].contents as Record<string, unknown>[])[0];
  assert.equal(externalFile.file_error, "security_error");
  assert.equal(external.adapter.listRegisteredFiles().length, 0);

  const traversal = adapterWith(
    siteFirst(() =>
      json(resourceFixture(ORIGIN + "/webservice/pluginfile.php/..%2f..%2fetc/passwd"))
    ),
  );
  const traversalResult = await traversal.adapter.getResources([7]);
  const traversalFile = (traversalResult.data?.[0].contents as Record<string, unknown>[])[0];
  assert.equal(traversalFile.file_error, "security_error");
  assert.equal(traversal.adapter.listRegisteredFiles().length, 0);
});

Deno.test("download: id desconhecido, redirecionamento e limite", async () => {
  const fileUrl = ORIGIN + "/webservice/pluginfile.php/7/mod_resource/content/0/a.pdf";
  const transport = new FakeTransport(siteFirst((url) => {
    if (url.includes("pluginfile.php")) {
      return new Response(new Uint8Array(32), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    return json(resourceFixture(fileUrl));
  }));
  const adapter = new MoodleAdapter(
    { origin: ORIGIN, token: TOKEN, maxDownloadBytes: 8 },
    { fetch: transport.fetch },
  );
  const unknown = await adapter.downloadFile("f_missing");
  assert.equal(unknown.error_code, "invalid_id");

  await adapter.getResources([7]);
  const fileId = adapter.listRegisteredFiles()[0].file_id;
  const tooBig = await adapter.downloadFile(fileId);
  assert.equal(tooBig.error_code, "limit_exceeded");

  const redirect = new FakeTransport(siteFirst((url) => {
    if (url.includes("pluginfile.php")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example/a.pdf" },
      });
    }
    return json(resourceFixture(fileUrl));
  }));
  const redirected = new MoodleAdapter(
    { origin: ORIGIN, token: TOKEN },
    { fetch: redirect.fetch },
  );
  await redirected.getResources([7]);
  const blocked = await redirected.downloadFile(redirected.listRegisteredFiles()[0].file_id);
  assert.equal(blocked.error_code, "security_error");
  assert.equal(DEFAULT_MAX_DOWNLOAD_BYTES > 0, true);
});

// --- Sanitizacao e bloqueios ---------------------------------------------

Deno.test("HTML com script e handler e sanitizado", async () => {
  const page = {
    id: 1,
    name: "Pagina",
    content:
      '<h1>Ola</h1><script>steal()</script><img src="x" onerror="hack()"><a href="javascript:evil()">x</a>',
  };
  const { adapter } = adapterWith(siteFirst(() => json([page])));
  const result = await adapter.getPages([1]);
  const item = result.data?.[0] as Record<string, unknown>;
  assert.ok(!String(item.content).includes("<script"));
  assert.ok(!String(item.content).includes("onerror"));
  assert.ok(!String(item.content).includes("javascript:"));
  assert.ok(String(item.content_text).includes("Ola"));
  assert.deepEqual(sanitizeHtml("<b>x</b>").text, "x");
});

Deno.test("funcoes bloqueadas devolvem recusa sem chamar o Moodle", async () => {
  const { adapter, transport } = adapterWith(siteFirst(() => json([])));
  const grades = await adapter.getOwnGrades(1);
  const submission = await adapter.getSubmissionStatus(1);
  for (const result of [grades, submission]) {
    assert.equal(result.coverage, "denied");
    assert.equal(result.error_code, "security_error");
    assert.equal(result.data, null);
  }
  assert.equal(isBlockedFunction("gradereport_user_get_grade_items"), true);
  assert.equal(isBlockedFunction("mod_assign_get_submission_status"), true);
  assert.equal(isBlockedFunction("mod_assign_get_assignments"), false);
  assert.deepEqual(transport.functionsCalled(), []);
});

Deno.test("configuracao invalida e recusada na construcao", () => {
  assert.throws(() => new MoodleAdapter({ origin: ORIGIN, token: "" }), MoodleError);
  assert.throws(
    () => new MoodleAdapter({ origin: ORIGIN, token: TOKEN, timeoutMs: 0 }),
    MoodleError,
  );
});

Deno.test("transporte interno exige HTTPS para http de loopback", async () => {
  const adapter = new MoodleAdapter(
    { origin: "http://127.0.0.1:8787", token: TOKEN },
    { resolveHost: async () => ["93.184.216.34"] },
  );
  const result = await adapter.getIdentity();
  assert.equal(result.error_code, "http_error");
  assert.equal(result.coverage, "unavailable");
});

Deno.test("subdiretorio: identidade e pluginfile respeitam a base", async () => {
  const subFile = SUBDIR_ORIGIN + "/webservice/pluginfile.php/3/mod_resource/content/0/b.txt";
  const transport = new FakeTransport(async (url, params) => {
    if (params.get("wsfunction") === "core_webservice_get_site_info") {
      return json({ ...siteInfo(), siteurl: SUBDIR_ORIGIN });
    }
    if (url.includes("pluginfile.php")) {
      return new Response("conteudo", { status: 200, headers: { "content-type": "text/plain" } });
    }
    return json([{ id: 3, contents: [{ type: "file", filename: "b.txt", fileurl: subFile }] }]);
  });
  const adapter = new MoodleAdapter(
    { origin: SUBDIR_ORIGIN, token: TOKEN },
    { fetch: transport.fetch },
  );
  const identity = unwrap(await adapter.getIdentity());
  assert.equal(identity.site_url, SUBDIR_ORIGIN);
  await adapter.getResources([3]);
  const fileId = adapter.listRegisteredFiles()[0].file_id;
  const binary = unwrap(await adapter.downloadFile(fileId));
  assert.ok(binary.text?.includes("conteudo"));
});
