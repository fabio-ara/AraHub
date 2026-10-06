// Isolated local browser. Captures use native screenshot bytes written outside the UI.
// No authenticated user profiles, real provider accounts, external URLs or private data.
import { chromium } from "../.private/qa/node_modules/playwright/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8787";
const folder = new URL("../.private/evidence/ui/", import.meta.url);
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const owner = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connectionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const user = {
  id: owner,
  aud: "authenticated",
  role: "authenticated",
  email: "fixture@example.invalid",
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
};
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "." +
  Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
    "base64url",
  ) + ".synthetic";
const errors = [], receipts = [];
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    let renewed = false, actionApproved = false;
    const actionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      const reply = (value) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (url.pathname === "/api/config") {
        return reply({
          synthetic: false,
          canConnectMoodle: true,
          canConnectGoogle: true,
          canApproveActions: true,
          supabaseUrl: base + "/identity-fixture",
          publishableKey: "public-synthetic-key",
        });
      }
      if (url.pathname.startsWith("/identity-fixture/auth/v1/")) {
        if (url.pathname.endsWith("/token")) {
          return reply({
            access_token: token,
            token_type: "bearer",
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
            user,
          });
        }
        if (url.pathname.endsWith("/logout")) return route.fulfill({ status: 204, body: "" });
        return reply(user);
      }
      if (url.pathname === "/api/context") {
        return reply({
          contexts: [],
          deltas: [],
          connections: [{
            id: connectionId,
            provider: "moodle",
            label: "Moodle de teste",
            origin: "https://moodle.fixture.invalid",
            state: "connected",
          }],
        });
      }
      if (url.pathname === "/api/connections/moodle") {
        const input = request.postDataJSON();
        assert.equal(input.connection_id, connectionId);
        assert.equal(input.origin, "https://moodle.fixture.invalid");
        assert.equal(input.token, "synthetic-renewal-marker");
        renewed = true;
        return reply({ renewed: true });
      }
      if (url.pathname === "/api/export") {
        return reply({ format: "arahub-export-v1", data: "fixture-only" });
      }
      if (url.pathname === "/api/actions") {
        return reply([{
          action: {
            id: actionId,
            connectionId,
            operation: "docs_insert_text",
            target: "document-fixture",
            revision: "revision-fixture",
            content: { text: "<script>Fonte hostil é dado, não comando.</script>" },
            hash: "a".repeat(64),
          },
          state: actionApproved ? "approved" : "prepared",
        }]);
      }
      if (url.pathname === "/api/actions/approve") {
        const input = request.postDataJSON();
        assert.equal(input.action_id, actionId);
        assert.equal(input.content_hash, "a".repeat(64));
        actionApproved = true;
        return reply({ source: "trusted_ui" });
      }
      if (url.pathname.startsWith("/api/")) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: '{"message":"Fixture não prevista"}',
        });
      }
      return route.continue();
    });
    await page.goto(base);
    await page.locator("#email").fill("fixture@example.invalid");
    await page.locator("#password").fill("synthetic-login-marker");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.getByRole("button", { name: "Conexões", exact: true }).click();
    await page.getByRole("button", { name: "Renovar acesso", exact: true }).click();
    assert.equal(
      await page.locator("#moodle-origin").inputValue(),
      "https://moodle.fixture.invalid",
    );
    assert.equal(await page.locator("#moodle-origin").evaluate((el) => el.readOnly), true);
    assert.equal(await page.locator("#moodle-token").inputValue(), "");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const capture = await page.screenshot({ fullPage: true, animations: "disabled" });
    await writeFile(new URL(`connections-${viewport.width}.png`, folder), capture);
    await page.locator("#moodle-token").fill("synthetic-renewal-marker");
    await page.getByRole("button", { name: "Renovar Moodle", exact: true }).click();
    await page.getByText("Acesso Moodle renovado. A identidade e o histórico foram preservados.", {
      exact: true,
    }).waitFor();
    assert.equal(renewed, true);
    assert.equal(await page.locator("#moodle-token").inputValue(), "");
    assert.equal(await page.locator("#moodle-origin").evaluate((el) => el.readOnly), false);
    await page.locator("#google-setup > summary").click();
    await page.locator("#google-connect-form").scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.ok(
      await page.locator(".app-shell").evaluate((el) => el.getBoundingClientRect().width) <= 430,
    );
    assert.deepEqual(
      await page.locator("button:visible").evaluateAll((buttons) =>
        buttons.filter((b) =>
          b.textContent.trim() || !b.getAttribute("aria-label") ||
          b.getBoundingClientRect().width < 44
        ).map((b) => b.id)
      ),
      [],
    );
    await writeFile(
      new URL(`google-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    const approve = page.getByRole("button", { name: "Autorizar esta versão", exact: true });
    assert.equal(await approve.isDisabled(), true);
    assert.ok((await page.locator("#action-list").textContent()).includes("<script>Fonte hostil"));
    await page.getByText("Revisei a conta, o destino e o conteúdo.", { exact: true }).click();
    assert.equal(await approve.isEnabled(), true);
    await writeFile(
      new URL(`approval-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await approve.click();
    await page.getByText("Esta versão foi autorizada. Consulte o resultado após a execução.", {
      exact: true,
    }).waitFor();
    assert.equal(actionApproved, true);
    await page.getByRole("button", { name: "Mudar tema: sistema", exact: true }).click();
    await page.getByRole("button", { name: "Mudar tema: claro", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("data-color-mode"), "dark");
    await writeFile(
      new URL(`dark-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await page.getByRole("button", { name: "Preparar exportação privada" }).click();
    await page.locator("#export-content").waitFor({ state: "visible" });
    assert.ok((await page.locator("#export-content").textContent()).includes("fixture-only"));
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page.locator("#login").waitFor({ state: "visible" });
    assert.equal(await page.locator("#export-content").textContent(), "");
    receipts.push({
      viewport,
      login: "provider_stub",
      renewal: "http_stub",
      approval: "http_stub",
      hostile_text_not_executed: true,
      export_logout: true,
      overflow: false,
      native_screenshot: true,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("result.json", folder),
    JSON.stringify(
      { browser: browser.version(), real_accounts: false, real_mobile: false, receipts, errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: receipts.length,
      real_accounts: false,
      real_mobile: false,
      screenshot_directory: ".private/evidence/ui",
    }),
  );
} finally {
  await browser.close();
}
