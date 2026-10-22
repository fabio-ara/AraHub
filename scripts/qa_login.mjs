// UI/SDK integration with controlled Auth responses; no real accounts or email.
// Native screenshots are written directly, never downloaded through the browser.
import { chromium } from "../.private/qa/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const origin = "https://login.fixture.invalid", site = origin + "/AraHub/";
const backend = "https://api.fixture.invalid/functions/v1/arahub";
const identity = "https://identity.fixture.invalid";
const prepared = JSON.parse(
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
const assets = new Map();
for (
  const path of [
    "index.html",
    "oauth/callback/index.html",
    "ui/app.js",
    "ui/style.css",
    "ui/theme.js",
  ]
) assets.set(path, await readFile(new URL(path, prepared.directory)));
const folder = ".private/universal/login-ui";
await mkdir(folder, { recursive: true });
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
const cdp = process.env.ARAHUB_QA_CDP;
if (cdp && cdp !== "http://127.0.0.1:9225") {
  throw Error("Use somente o Chrome dedicado em loopback.");
}
const browser = cdp
  ? await chromium.connectOverCDP(cdp)
  : await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const context = await browser.newContext({ viewport });
    try {
      let registration = "invite", unavailable = false, password = true, providers = [];
      const calls = [], errors = [];
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await context.route("**/*", async (route) => {
        const request = route.request(), url = new URL(request.url());
        const headers = { "Access-Control-Allow-Origin": origin, "Cache-Control": "no-store" };
        const reply = (data, status = 200) =>
          route.fulfill({
            status,
            contentType: "application/json",
            headers,
            body: JSON.stringify(data),
          });
        if (request.method() === "OPTIONS") {
          return route.fulfill({
            status: 204,
            headers: {
              ...headers,
              "Access-Control-Allow-Methods": "GET,POST,PUT",
              "Access-Control-Allow-Headers": request.headers()["access-control-request-headers"] ??
                "",
            },
            body: "",
          });
        }
        if (url.origin === origin) {
          let path = url.pathname.slice("/AraHub/".length);
          if (!path || path.endsWith("/")) path += "index.html";
          if (!assets.has(path)) return route.abort();
          return route.fulfill({
            contentType: path.endsWith(".js")
              ? "text/javascript"
              : path.endsWith(".css")
              ? "text/css"
              : "text/html",
            body: assets.get(path),
          });
        }
        if (url.href === backend + "/api/config") {
          return reply({
            supabaseUrl: identity,
            publishableKey: "synthetic-public-key",
            login: { registration, emailLink: true, password, providers },
          }, unavailable ? 503 : 200);
        }
        if (url.href === backend + "/api/context") {
          return reply({ connections: [], contexts: [], deltas: [] });
        }
        if (url.origin === identity) {
          if (["/auth/v1/otp", "/auth/v1/recover"].includes(url.pathname)) {
            calls.push({
              path: url.pathname,
              body: request.postDataJSON(),
              redirect: url.searchParams.get("redirect_to"),
            });
            return reply({});
          }
          if (url.pathname === "/auth/v1/token") {
            calls.push({ path: url.pathname, grant: url.searchParams.get("grant_type") });
            return reply({
              access_token: token,
              refresh_token: "synthetic-refresh",
              token_type: "bearer",
              expires_in: 3600,
              user,
            });
          }
          if (url.pathname === "/auth/v1/user") {
            if (request.method() === "PUT") {
              calls.push({
                path: url.pathname,
                password_updated: typeof request.postDataJSON().password === "string",
              });
            }
            return reply(user);
          }
          if (url.pathname === "/auth/v1/logout") return reply({});
          if (url.pathname === "/auth/v1/authorize") {
            calls.push({
              path: url.pathname,
              provider: url.searchParams.get("provider"),
              redirect: url.searchParams.get("redirect_to"),
              pkce: !!url.searchParams.get("code_challenge"),
            });
            return route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: "Provedor sintético",
            });
          }
        }
        return route.abort();
      });
      await page.goto(site + "?authorization_id=synthetic-consent");
      await page.locator("#email").fill(user.email);
      await page.getByRole("button", { name: "Receber link de acesso", exact: true }).click();
      await page.getByText("Confira seu e-mail e abra o link neste navegador para entrar.", {
        exact: true,
      }).waitFor();
      assert.equal(calls.at(-1).body.create_user, false);
      assert.equal(
        new URL(calls.at(-1).redirect).searchParams.get("authorization_id"),
        "synthetic-consent",
      );
      // Test signup policy separately from consent; do not auto-approve a client.
      await page.evaluate(() => sessionStorage.removeItem("arahub-pending-consent"));
      registration = "open";
      await page.goto(site);
      await page.locator("#email").fill(user.email);
      await page.getByRole("button", { name: "Receber link de acesso", exact: true }).click();
      await page.getByText("Confira seu e-mail e abra o link neste navegador para entrar.", {
        exact: true,
      }).waitFor();
      assert.equal(calls.at(-1).body.create_user, true);
      await writeFile(
        `${folder}/${viewport.width}-entry.png`,
        await page.screenshot({ fullPage: true }),
      );
      await page.locator("#login-method").selectOption("password");
      assert.equal(await page.locator("#password").isVisible(), true);
      await page.getByRole("button", { name: "Esqueci minha senha", exact: true }).click();
      await page.getByText(/Se a conta puder receber/).waitFor();
      assert.equal(calls.at(-1).path, "/auth/v1/recover");
      await page.goto(site + "oauth/callback/?code=synthetic-recovery");
      await page.locator("#recovery-form").waitFor({ state: "visible" });
      assert.equal(await page.locator("#workspace").isVisible(), false);
      await page.locator("#new-password").fill("synthetic-new-password");
      await page.locator("#confirm-password").fill("synthetic-new-password");
      await writeFile(
        `${folder}/${viewport.width}-recovery.png`,
        await page.screenshot({ fullPage: true }),
      );
      await page.getByRole("button", { name: "Salvar senha", exact: true }).click();
      await page.locator("#workspace").waitFor({ state: "visible" });
      assert.ok(calls.some((c) => c.password_updated));
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Sair", exact: true }).click(),
      ]);
      await page.locator("#login-form").waitFor({ state: "visible" });
      await page.locator("#login-method").selectOption("password");
      await page.locator("#email").fill(user.email);
      await page.locator("#password").fill("synthetic-new-password");
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await page.locator("#workspace").waitFor({ state: "visible" });
      assert.ok(calls.some((c) => c.grant === "password"));
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Sair", exact: true }).click(),
      ]);
      providers = ["google"];
      await page.goto(site + "?authorization_id=synthetic-social");
      await page.getByRole("button", { name: "Continuar com Google", exact: true }).click();
      await page.getByText("Provedor sintético", { exact: true }).waitFor();
      assert.equal(calls.at(-1).provider, "google");
      assert.equal(calls.at(-1).pkce, true);
      assert.equal(
        new URL(calls.at(-1).redirect).searchParams.get("authorization_id"),
        "synthetic-social",
      );
      unavailable = true;
      await page.goto(site);
      await page.getByRole("button", { name: "Tentar novamente", exact: true }).waitFor();
      unavailable = false;
      password = false;
      providers = [];
      await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
      await page.locator("#login-form").waitFor({ state: "visible" });
      assert.equal(await page.locator("#password").isVisible(), false);
      assert.equal(await page.locator("#social-login").isVisible(), false);
      assert.deepEqual(errors, []);
      results.push({
        viewport,
        invite: true,
        open_signup: true,
        recovery: true,
        password: true,
        social_pkce: true,
        consent_preserved: true,
        retry: true,
        auth: "controlled_responses",
        email_sent: false,
      });
    } finally {
      await context.close();
    }
  }
  await writeFile(`${folder}/result.json`, JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify({
      passed: results.length,
      dedicated_chrome: !!cdp,
      real_auth: false,
      email_sent: false,
    }),
  );
} finally {
  if (!cdp) await browser.close();
}
// Do not close a CDP-attached browser or any pre-existing tab; detach this process.
if (cdp) process.exit(0);
