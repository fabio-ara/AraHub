// Executes the prepared Pages artifact in isolated Chrome, with all network stubbed.
// Native capture bytes are written outside the UI. No real accounts or emails.
import { chromium } from "../.private/qa/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
// Optional real PDF remains private; default is a one-page synthetic PDF.
function fixturePdf() {
  const stream = "BT /F1 12 Tf 20 100 Td (AraHub worker fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let text = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  text += "xref\n0 6\n0000000000 65535 f \n" +
    offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
      .join("");
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const pdf = process.argv[2] ? await readFile(process.argv[2]) : fixturePdf();
const pdfHash = createHash("sha256").update(pdf).digest("hex");
const pdfId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const site = "https://ui.fixture.invalid/AraHub/";
const origin = new URL(site).origin;
const backend = "https://api.fixture.invalid/functions/v1/arahub";
const identity = "https://identity.fixture.invalid";
const result = JSON.parse(
  execFileSync("deno", [
    "run",
    "--allow-read=web,LICENSE,THIRD_PARTY_NOTICES.md",
    "--allow-write=.private/deploy",
    "scripts/prepare_ui.ts",
    backend,
    identity,
    site,
  ], { encoding: "utf8" }),
);
const root = new URL(result.directory);
const folder = new URL("../.private/evidence/pages/", import.meta.url);
await mkdir(folder, { recursive: true });
const files = new Map();
for (
  const path of [
    "index.html",
    "privacy.html",
    "ui/app.js",
    "ui/pdf-parser.worker.js",
    "ui/style.css",
    "oauth/consent/index.html",
    "oauth/google/callback/index.html",
    "oauth/callback/index.html",
  ]
) files.set(path, await readFile(new URL(path, root)));
const user = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  aud: "authenticated",
  role: "authenticated",
  email: "fixture@example.invalid",
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
};
const token = Buffer.from('{"alg":"ES256"}').toString("base64url") + "." +
  Buffer.from(
    JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString(
    "base64url",
  ) + ".synthetic";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [], violations = [], receipts = [];
try {
  for (
    const viewport of [{ width: 390, height: 844 }, {
      width: 1280,
      height: 900,
    }]
  ) {
    let otp = 0,
      confirmation = 0,
      exchange = 0,
      approved = 0,
      unavailable = false,
      moodleRequests = 0,
      pdfCommits = 0;
    let pdfBusy = false, pdfTampered = false;
    const connections = [];
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() =>
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations = [
          ...(window.__cspViolations ?? []),
          e.violatedDirective,
        ];
      })
    );
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Cache-Control": "no-store",
      };
      const reply = (value, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          headers,
          body: JSON.stringify(value),
        });
      if (
        request.method() === "OPTIONS" &&
        [identity, new URL(backend).origin].includes(url.origin)
      ) {
        return route.fulfill({
          status: 204,
          headers: {
            ...headers,
            "Access-Control-Allow-Methods": "GET,POST",
            "Access-Control-Allow-Headers": request.headers()["access-control-request-headers"] ??
              "",
          },
          body: "",
        });
      }
      if (url.origin === origin) {
        if (!url.pathname.startsWith("/AraHub/")) {
          throw new Error("Escapou do prefixo Pages.");
        }
        let path = url.pathname.slice("/AraHub/".length);
        if (!path || path.endsWith("/")) path += "index.html";
        if (!files.has(path)) return route.abort();
        if (path === "ui/pdf-parser.worker.js" && pdfBusy) {
          return route.fulfill({
            contentType: "text/javascript",
            body: "self.onmessage=()=>{while(true){}};",
          });
        }
        return route.fulfill({
          status: 200,
          contentType: path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".css")
            ? "text/css"
            : "text/html",
          body: files.get(path),
        });
      }
      if (request.url() === backend + "/api/config") {
        if (unavailable) {
          return route.fulfill({ status: 503, headers, body: "" });
        }
        return reply({
          supabaseUrl: identity,
          publishableKey: "public-synthetic-key",
          canApproveActions: false,
          canConnectMoodle: true,
          canConnectGoogle: true,
          canExtractPdf: true,
          synthetic: false,
        });
      }
      if (request.url() === backend + "/api/context") {
        return reply({ contexts: [], deltas: [], connections });
      }
      if (request.url() === backend + "/api/pdf/list") {
        assert.ok(request.headers().authorization?.startsWith("Bearer "));
        return reply({
          files: [{
            id: pdfId,
            name: "PDF de prova",
            sha256: pdfHash,
            bytes: pdf.length,
            coverage: "unavailable",
          }],
          next_id: null,
        });
      }
      if (request.url() === backend + "/api/pdf/bytes") {
        assert.deepEqual(request.postDataJSON(), {
          file_id: pdfId,
          sha256: pdfHash,
        });
        assert.ok(request.headers().authorization?.startsWith("Bearer "));
        const body = Buffer.from(pdf);
        if (pdfTampered) body[body.length - 1] ^= 1;
        return route.fulfill({
          status: 200,
          contentType: "application/pdf",
          headers,
          body,
        });
      }
      if (request.url() === backend + "/api/pdf/commit") {
        const data = request.postDataJSON();
        assert.equal(data.sha256, pdfHash);
        assert.equal(data.file_id, pdfId);
        assert.equal(data.extraction.execution, "isolated_worker");
        assert.equal(data.extraction.hard_timeout, true);
        assert.equal(data.extraction.ocr, "not_performed");
        assert.ok(data.extraction.pages.length > 0);
        assert.match(
          data.extraction.pages[0].text,
          process.argv[2] ? /Attention/ : /AraHub worker fixture/,
        );
        await writeFile(
          new URL(`pdf-result-${randomUUID()}.json`, folder),
          JSON.stringify({ sha256: pdfHash, extraction: data.extraction }),
        );
        pdfCommits++;
        return reply({ memory: { complete: true } });
      }
      if (request.url() === backend + "/api/connections/google/check") {
        assert.equal(request.method(), "POST");
        assert.deepEqual(request.postDataJSON(), { connection_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
        return reply({ checks: [
          { kind: "gmail_messages", coverage: "partial", items: 3, pages: 1, continuation: true },
          { kind: "calendars", coverage: "denied", error_code: "scope_required" },
          { kind: "drive_files", coverage: "complete", items: 1, pages: 1, continuation: false },
        ], sources_unchanged: true });
      }
      if (request.url() === backend + "/api/connections/moodle") {
        assert.equal(request.method(), "POST");
        const data = request.postDataJSON();
        assert.ok(request.headers().authorization?.startsWith("Bearer "));
        assert.equal(data.origin, "https://moodle.fixture.invalid");
        assert.equal(data.token, "hosted-fixture-marker");
        const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        if (moodleRequests === 0) {
          assert.equal(data.connection_id, undefined);
          connections.push({
            id,
            provider: "moodle",
            label: data.label,
            origin: data.origin,
            state: "connected",
          });
        } else {
          assert.equal(data.connection_id, id);
          const desired = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/drive.readonly"];
          connections.push({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", provider: "google", label: "Google sintético", state: "connected", desired_scopes: desired, granted_scopes: [...desired.filter(s => !s.endsWith("calendar.readonly")), "https://www.googleapis.com/auth/gmail.modify"] });
        }
        moodleRequests++;
        return reply({ id, renewed: moodleRequests > 1 });
      }
      if (url.origin === identity && url.pathname.startsWith("/auth/v1/")) {
        if (url.pathname.endsWith("/otp")) {
          const data = request.postDataJSON();
          assert.equal(data.email, user.email);
          assert.equal(data.create_user, false);
          assert.equal(
            url.searchParams.get("redirect_to"),
            site + "oauth/callback",
          );
          assert.equal(data.code_challenge_method, "s256");
          assert.ok(data.code_challenge);
          assert.equal(data.password, undefined);
          otp++;
          if (otp === 1) {
            return reply({ error_code: "signup_disabled", msg: "Signups disabled" }, 422);
          }
          return reply({});
        }
        if (url.pathname.endsWith("/resend")) {
          const data = request.postDataJSON();
          assert.equal(data.email, user.email);
          assert.equal(data.type, "signup");
          assert.equal(url.searchParams.get("redirect_to"), site + "oauth/callback");
          assert.equal(data.code_challenge_method, "s256");
          assert.ok(data.code_challenge);
          assert.equal(data.password, undefined);
          confirmation++;
          return reply({});
        }
        if (url.pathname.endsWith("/token")) {
          assert.equal(url.searchParams.get("grant_type"), "pkce");
          assert.ok(request.postDataJSON().code_verifier);
          exchange++;
          return reply({
            access_token: token,
            token_type: "bearer",
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
            user,
          });
        }
        if (url.pathname.endsWith("/consent")) {
          assert.equal(request.postDataJSON().action, "approve");
          approved++;
          return reply({ redirect_url: site });
        }
        if (url.pathname.includes("/oauth/authorizations/")) {
          return reply({
            client: { name: "Assistente de teste" },
            scope: "openid email profile",
          });
        }
        return reply(user);
      }
      return route.abort();
    });
    await page.goto(site);
    await page.getByRole("button", { name: "Receber link de acesso" })
      .waitFor();
    await page.getByRole("link", { name: "Privacidade", exact: true }).click();
    await page.getByRole("heading", { name: "Seus dados", exact: true }).waitFor();
    assert.equal(await page.locator("script").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await writeFile(new URL(`privacy-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }));
    await page.getByRole("link", { name: "Voltar ao AraHub", exact: true }).click();
    await page.getByRole("button", { name: "Receber link de acesso" }).waitFor();
    assert.equal(await page.locator("#password").isVisible(), false);
    await page.locator("#email").fill(user.email);
    await page.getByRole("button", { name: "Receber link de acesso" }).click();
    await page.getByText(
      "Confira seu e-mail e abra o link neste navegador para entrar.",
      {
        exact: true,
      },
    ).waitFor();
    assert.equal(otp, 1);
    assert.equal(confirmation, 1);
    await page.goto(site + "oauth/callback/?code=synthetic-code");
    await page.locator("#workspace").waitFor({ state: "visible" });
    assert.equal(exchange, 1);
    assert.equal(new URL(page.url()).searchParams.has("code"), false);
    await page.getByRole("button", { name: "Conexões", exact: true }).click();
    await page.locator("#moodle-setup > summary").click();
    assert.equal(await page.locator("#moodle-token").isVisible(), true);
    await page.locator("#moodle-label").fill("Moodle de teste");
    await page.locator("#moodle-origin").fill("https://moodle.fixture.invalid");
    await page.locator("#moodle-token").fill("hosted-fixture-marker");
    await page.getByRole("button", { name: "Conectar Moodle", exact: true })
      .click();
    await page.getByRole("button", { name: "Renovar acesso", exact: true })
      .waitFor();
    assert.equal(await page.locator("#moodle-token").inputValue(), "");
    await page.getByRole("button", { name: "Renovar acesso", exact: true })
      .click();
    assert.equal(
      await page.locator("#moodle-origin").getAttribute("readonly"),
      "",
    );
    await page.locator("#moodle-token").fill("hosted-fixture-marker");
    await page.getByRole("button", { name: "Renovar Moodle", exact: true })
      .click();
    await page.getByText(
      "Acesso Moodle renovado. A identidade e o histórico foram preservados.",
      {
        exact: true,
      },
    ).waitFor();
    assert.equal(await page.locator("#moodle-token").inputValue(), "");
    assert.equal(moodleRequests, 2);
    await page.getByRole("button", { name: "Verificar leituras", exact: true }).click();
    await page.getByText("Gmail: parcial (3) · Calendar: sem permissão · Drive: concluído (1)", { exact: true }).waitFor();
    await page.getByText("5 permissões concedidas de 6 solicitadas.", { exact: true }).waitFor();
    await writeFile(new URL(`google-check-${viewport.width}.png`, folder), await page.screenshot({fullPage:true}));
    await page.locator("#pdf-setup > summary").click();
    await page.getByRole("button", { name: "Extrair texto", exact: true })
      .click();
    await page.getByText("Texto preservado por página, sem OCR.", {
      exact: true,
    }).waitFor().catch(async () => {
      throw new Error(
        JSON.stringify({
          message: await page.locator("#message").textContent(),
          errors,
          csp: await page.evaluate(() => window.__cspViolations ?? []),
        }),
      );
    });
    assert.equal(pdfCommits, 1);
    pdfTampered = true;
    await page.getByRole("button", { name: "Extrair texto", exact: true }).click();
    await page.getByText("O arquivo mudou. Atualize a lista.", { exact: true }).waitFor();
    assert.equal(pdfCommits, 1);
    pdfTampered = false;
    pdfBusy = true;
    await page.getByRole("button", { name: "Extrair texto", exact: true }).click();
    await page.getByRole("button", { name: "Cancelar extração", exact: true }).waitFor();
    await page.waitForTimeout(250); // Let the disposable Worker enter synchronous CPU.
    await page.getByRole("button", { name: "Cancelar extração", exact: true }).click();
    await page.getByText("Extração cancelada.", { exact: true }).waitFor();
    assert.equal(pdfCommits, 1);
    if (viewport.width === 390) {
      await page.getByRole("button", { name: "Extrair texto", exact: true }).click();
      await page.getByText("Tempo de extração excedido.", { exact: true }).waitFor({
        timeout: 22000,
      });
      assert.equal(pdfCommits, 1);
    }
    pdfBusy = false;
    await writeFile(
      new URL(`pdf-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await page.goto(
      site + "oauth/consent/?authorization_id=fixture-authorization",
    );
    await page.locator("#consent").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#consent-details").textContent(),
      /Assistente de teste/,
    );
    assert.ok(
      await page.locator(".app-shell").evaluate((el) => el.getBoundingClientRect().width) <= 430,
    );
    await writeFile(
      new URL(`consent-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await page.getByRole("button", { name: "Permitir", exact: true }).click();
    await page.waitForURL(site);
    assert.equal(approved, 1);
    violations.push(...await page.evaluate(() => window.__cspViolations ?? []));
    unavailable = true;
    await page.goto(site);
    await page.getByText(
      "Acesso indisponível no momento. Tente novamente mais tarde.",
      {
        exact: true,
      },
    ).waitFor();
    assert.equal(await page.locator("#login-form").isVisible(), false);
    receipts.push({
      viewport,
      pkce_magic_link: "provider_stub",
      consent: "provider_stub",
      physical_callbacks: true,
      privacy_link_and_return: true,
      password_hidden: true,
      moodle_https_connect_renew: moodleRequests === 2,
      google_check_partial_and_denied: true,
      pdf_browser_worker: true,
      pdf_changed_hash_denied: true,
      pdf_cpu_cancel_termination: true,
      pdf_cpu_timeout_termination: viewport.width === 390,
      pdf_real_bytes: !!process.argv[2],
      pdf_backend_commit: "provider_stub",
      prefix: "/AraHub/",
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
  await writeFile(
    new URL("result.json", folder),
    JSON.stringify(
      {
        receipts,
        errors,
        violations,
        real_accounts: false,
        hosted: false,
        artifact_manifest: result.manifest,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: receipts.length,
      hosted: false,
      real_accounts: false,
      csp_violations: violations.length,
    }),
  );
} finally {
  await browser.close();
}
