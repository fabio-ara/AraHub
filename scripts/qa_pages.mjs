// Executes the prepared Pages artifact in isolated Chrome, with all network stubbed.
// Native capture bytes are written outside the UI. No real accounts or emails.
import { chromium } from "../.private/qa/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
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
    "ui/app.js",
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
  Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
    "base64url",
  ) + ".synthetic";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [], violations = [], receipts = [];
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    let otp = 0, exchange = 0, approved = 0, unavailable = false;
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() =>
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations = [...(window.__cspViolations ?? []), e.violatedDirective];
      })
    );
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": origin, "Cache-Control": "no-store" };
      const reply = (value) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          headers,
          body: JSON.stringify(value),
        });
      if (
        request.method() === "OPTIONS" && [identity, new URL(backend).origin].includes(url.origin)
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
        if (!url.pathname.startsWith("/AraHub/")) throw new Error("Escapou do prefixo Pages.");
        let path = url.pathname.slice("/AraHub/".length);
        if (!path || path.endsWith("/")) path += "index.html";
        if (!files.has(path)) return route.abort();
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
        if (unavailable) return route.fulfill({ status: 503, headers, body: "" });
        return reply({
          supabaseUrl: identity,
          publishableKey: "public-synthetic-key",
          canApproveActions: false,
          canConnectMoodle: true,
          canConnectGoogle: false,
          synthetic: false,
        });
      }
      if (request.url() === backend + "/api/context") {
        return reply({ contexts: [], deltas: [], connections: [] });
      }
      if (url.origin === identity && url.pathname.startsWith("/auth/v1/")) {
        if (url.pathname.endsWith("/otp")) {
          const data = request.postDataJSON();
          assert.equal(data.email, user.email);
          assert.equal(data.create_user, false);
          assert.equal(url.searchParams.get("redirect_to"), site + "oauth/callback");
          assert.equal(data.code_challenge_method, "s256");
          assert.ok(data.code_challenge);
          assert.equal(data.password, undefined);
          otp++;
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
          return reply({ client: { name: "Assistente de teste" }, scope: "openid email profile" });
        }
        return reply(user);
      }
      return route.abort();
    });
    await page.goto(site);
    await page.getByRole("button", { name: "Receber link de acesso" }).waitFor();
    assert.equal(await page.locator("#password").isVisible(), false);
    await page.locator("#email").fill(user.email);
    await page.getByRole("button", { name: "Receber link de acesso" }).click();
    await page.getByText("Confira seu e-mail e abra o link neste navegador para entrar.", {
      exact: true,
    }).waitFor();
    assert.equal(otp, 1);
    await page.goto(site + "oauth/callback/?code=synthetic-code");
    await page.locator("#workspace").waitFor({ state: "visible" });
    assert.equal(exchange, 1);
    assert.equal(new URL(page.url()).searchParams.has("code"), false);
    await page.getByRole("button", { name: "Conexões", exact: true }).click();
    await page.locator("#moodle-setup > summary").click();
    assert.equal(await page.locator("#moodle-token").isVisible(), false);
    await page.goto(site + "oauth/consent/?authorization_id=fixture-authorization");
    await page.locator("#consent").waitFor({ state: "visible" });
    assert.match(await page.locator("#consent-details").textContent(), /Assistente de teste/);
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
    await page.getByText("Acesso indisponível no momento. Tente novamente mais tarde.", {
      exact: true,
    }).waitFor();
    assert.equal(await page.locator("#login-form").isVisible(), false);
    receipts.push({
      viewport,
      pkce_magic_link: "provider_stub",
      consent: "provider_stub",
      physical_callbacks: true,
      password_hidden: true,
      moodle_token_hidden: true,
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
