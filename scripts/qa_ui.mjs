// Isolated local browser. Captures use native screenshot bytes written outside the UI.
// No authenticated user profiles, real provider accounts, external URLs or private data.
import { chromium } from "../.private/qa/node_modules/playwright/index.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8787";
const folder = new URL("../.private/evidence/ui/", import.meta.url);
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const owner = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connectionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const googleConnectionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mobileToken = "a".repeat(32);
const mobilePrivateToken = "b".repeat(32);
const mobileLink = "moodlemobile://token=" +
  Buffer.from(`${"c".repeat(32)}:::${mobileToken}:::${mobilePrivateToken}`).toString("base64");
const googleReadScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
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
  Buffer.from(
    JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString(
    "base64url",
  ) + ".synthetic";
const errors = [], receipts = [];
const staticFiles = new Map(
  await Promise.all([
    ["/", "index.html", "text/html"],
    ["/ui/app.js", "app.js", "application/javascript"],
    ["/ui/style.css", "style.css", "text/css"],
  ].map(async (
    [path, file, type],
  ) => [path, {
    body: await readFile(new URL(`../web/${file}`, import.meta.url)),
    type,
  }])),
);
try {
  for (
    const viewport of [{ width: 1280, height: 900 }, {
      width: 390,
      height: 844,
    }]
  ) {
    const context = await browser.newContext({ viewport });
    await context.route("https://moodle.fixture.invalid/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Moodle sintético</title>" }));
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    let renewed = false, actionApproved = false, googleUpgraded = false;
    const additionalApproved = new Set();
    const actionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const sheetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const slideId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sheetRows = [["Literal", "=SUM(A2:A3)", true, null], [2], [3], [{
      formula: "=SUM(A2:A3)",
    }], ["Última célula <script>window.__sourceExecuted=true</script>"]];
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
        if (url.pathname.endsWith("/logout")) {
          return route.fulfill({ status: 204, body: "" });
        }
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
          }, {
            id: googleConnectionId,
            provider: "google",
            label: "Institucional",
            origin: "edu.ulisboa.pt",
            state: "connected",
            desired_scopes: googleReadScopes,
            granted_scopes: googleReadScopes,
          }],
        });
      }
      if (url.pathname === "/api/connections/google/start") {
        const input = request.postDataJSON();
        assert.equal(input.connection_id, googleConnectionId);
        assert.equal(input.label, "Institucional");
        assert.deepEqual(
          new Set(input.scopes),
          new Set([...googleReadScopes, "docs_write", "sheets_write", "slides_write"]),
        );
        googleUpgraded = true;
        return reply({ authorization_url: base + "/oauth/mock" });
      }
      if (url.pathname === "/oauth/mock") {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>OAuth fixture</title>",
        });
      }
      if (url.pathname === "/api/connections/moodle") {
        const input = request.postDataJSON();
        assert.equal(input.connection_id, connectionId);
        assert.equal(input.origin, "https://moodle.fixture.invalid");
        assert.equal(input.token, mobileToken);
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
            content: {
              text: "<script>Fonte hostil é dado, não comando.</script>",
            },
            hash: "a".repeat(64),
          },
          state: actionApproved ? "approved" : "prepared",
        }, {
          action: {
            id: sheetId,
            connectionId,
            operation: "sheets_create",
            target: "new",
            revision: null,
            content: {
              title: "Planilha sintética",
              sheet_title: "Dados",
              rows: sheetRows,
            },
            hash: "b".repeat(64),
          },
          state: additionalApproved.has(sheetId) ? "approved" : "prepared",
        }, {
          action: {
            id: slideId,
            connectionId,
            operation: "slides_add_text",
            target: "presentation-fixture",
            revision: "revision-fixture",
            content: {
              slide_id: "slide_test",
              text_id: "text_test",
              x: 40,
              y: 40,
              width: 600,
              height: 300,
              text: "Título e conteúdo sintéticos\nÚltima linha do slide",
            },
            hash: "c".repeat(64),
          },
          state: additionalApproved.has(slideId) ? "approved" : "prepared",
        }]);
      }
      if (url.pathname === "/api/actions/approve") {
        const input = request.postDataJSON();
        assert.ok([actionId, sheetId, slideId].includes(input.action_id));
        assert.equal(
          input.content_hash,
          (input.action_id === actionId ? "a" : input.action_id === sheetId ? "b" : "c").repeat(64),
        );
        if (input.action_id === actionId) actionApproved = true;
        else additionalApproved.add(input.action_id);
        return reply({ source: "trusted_ui" });
      }
      if (url.pathname.startsWith("/api/")) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: '{"message":"Fixture não prevista"}',
        });
      }
      const file = staticFiles.get(url.pathname);
      if (file) {
        return route.fulfill({
          status: 200,
          contentType: file.type,
          body: file.body,
        });
      }
      return route.abort();
    });
    await page.goto(base);
    await page.locator("#email").fill("fixture@example.invalid");
    await page.locator("#password").fill("synthetic-login-marker");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.getByRole("button", { name: "Conexões", exact: true }).click();
    await page.getByRole("button", { name: "Renovar acesso", exact: true }).first()
      .click();
    assert.equal(
      await page.locator("#moodle-origin").inputValue(),
      "https://moodle.fixture.invalid",
    );
    assert.equal(
      await page.locator("#moodle-origin").evaluate((el) => el.readOnly),
      true,
    );
    assert.equal(await page.locator("#moodle-token").inputValue(), "");
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Abrir entrada oficial do Moodle" }).click();
    const popup = await popupPromise;
    await popup.waitForURL(/moodle\.fixture\.invalid/, { timeout: 5000 });
    const launch = new URL(popup.url());
    assert.equal(launch.origin, "https://moodle.fixture.invalid");
    assert.equal(launch.pathname, "/admin/tool/mobile/launch.php");
    assert.equal(launch.searchParams.get("service"), "moodle_mobile_app");
    assert.match(launch.searchParams.get("passport") ?? "", /^[a-f0-9]{32}$/);
    await popup.close();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const capture = await page.screenshot({
      fullPage: true,
      animations: "disabled",
    });
    await writeFile(
      new URL(`connections-${viewport.width}.png`, folder),
      capture,
    );
    await page.locator("#moodle-token").fill(mobileLink);
    await page.getByRole("button", { name: "Renovar Moodle", exact: true })
      .click();
    await page.getByText(
      "Acesso Moodle renovado. A identidade e o histórico foram preservados.",
      {
        exact: true,
      },
    ).waitFor();
    assert.equal(renewed, true);
    assert.equal(await page.locator("#moodle-token").inputValue(), "");
    assert.equal(
      await page.locator("#moodle-origin").evaluate((el) => el.readOnly),
      true,
    );
    await page.locator("#moodle-origin").click();
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
    const firstAction = page.locator("#action-list > .panel").first();
    const approve = firstAction.getByRole("button", {
      name: "Autorizar esta versão",
      exact: true,
    });
    assert.equal(await approve.isDisabled(), true);
    assert.ok(
      (await page.locator("#action-list").textContent()).includes(
        "<script>Fonte hostil",
      ),
    );
    await firstAction.getByText("Revisei a conta, o destino e o conteúdo.", {
      exact: true,
    }).click();
    assert.equal(await approve.isEnabled(), true);
    await writeFile(
      new URL(`approval-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await approve.click();
    await page.getByText(
      "Esta versão foi autorizada. Consulte o resultado após a execução.",
      {
        exact: true,
      },
    ).waitFor();
    assert.equal(actionApproved, true);
    for (
      const [position, expected] of [[
        1,
        "Última célula <script>window.__sourceExecuted=true</script>",
      ], [2, "Última linha do slide"]]
    ) {
      const card = page.locator("#action-list > .panel").nth(position);
      assert.ok((await card.locator("pre").textContent()).includes(expected));
      if (position === 1) {
        const preview = await card.locator("pre").textContent();
        for (
          const value of [
            "B1 · texto literal: =SUM(A2:A3)",
            "A4 · fórmula: =SUM(A2:A3)",
            "A2 · número: 2",
            "C1 · lógico: verdadeiro",
            "D1 · vazia:",
          ]
        ) assert.ok(preview.includes(value));
      }
      const button = card.getByRole("button", {
        name: "Autorizar esta versão",
        exact: true,
      });
      assert.equal(await button.isDisabled(), true);
      await card.getByText("Revisei a conta, o destino e o conteúdo.", {
        exact: true,
      }).click();
      await card.scrollIntoViewIfNeeded();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
      assert.equal(
        await page.evaluate(() => window.__sourceExecuted),
        undefined,
      );
      await writeFile(
        new URL(`content-review-${position}-${viewport.width}.png`, folder),
        await page.screenshot({ animations: "disabled" }),
      );
      await button.click();
      await card.getByText("Versão autorizada; execução pendente", {
        exact: true,
      }).waitFor();
    }
    assert.equal(additionalApproved.size, 2);
    await page.getByRole("button", { name: "Mudar tema: sistema", exact: true })
      .click();
    await page.getByRole("button", { name: "Mudar tema: claro", exact: true })
      .click();
    assert.equal(
      await page.locator("html").getAttribute("data-color-mode"),
      "dark",
    );
    await writeFile(
      new URL(`dark-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await page.getByRole("button", { name: "Preparar exportação privada" })
      .click();
    await page.locator("#export-content").waitFor({ state: "visible" });
    assert.ok(
      (await page.locator("#export-content").textContent()).includes(
        "fixture-only",
      ),
    );
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page.locator("#login").waitFor({ state: "visible" });
    assert.equal(await page.locator("#export-content").textContent(), "");
    await page.locator("#email").fill("fixture@example.invalid");
    await page.locator("#password").fill("synthetic-login-marker");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Conexões", exact: true }).click();
    await page.getByRole("button", { name: "Ampliar permissões Google" }).click();
    await page.getByRole("button", { name: "Solicitar permissões adicionais Google" }).click();
    await page.getByText("Marque uma permissão adicional ou use Renovar acesso.", {
      exact: true,
    }).waitFor();
    assert.equal(googleUpgraded, false);
    await page.getByRole("button", { name: "Cancelar alteração de permissões" }).click();
    assert.equal(await page.locator("#google-label").evaluate((el) => el.readOnly), false);
    await page.getByRole("button", { name: "Ampliar permissões Google" }).click();
    assert.equal(await page.locator("#google-label").inputValue(), "Institucional");
    assert.equal(await page.locator("#google-label").evaluate((el) => el.readOnly), true);
    assert.equal(await page.locator("#google-gmail").isDisabled(), true);
    assert.equal(await page.locator("#google-gmail").isChecked(), true);
    assert.equal(await page.locator("#google-drive-mode").isDisabled(), true);
    assert.equal(await page.locator("#google-drive-mode").inputValue(), "drive_read");
    for (const name of ["docs", "sheets", "slides"]) {
      await page.locator(`#google-${name}-write`).check();
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await writeFile(
      new URL(`google-upgrade-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await page.getByRole("button", { name: "Solicitar permissões adicionais Google" }).click();
    await page.waitForURL(base + "/oauth/mock");
    assert.equal(googleUpgraded, true);
    receipts.push({
      viewport,
      login: "provider_stub",
      renewal: "http_stub",
      approval: "http_stub",
      typed_sheet_and_new_slide_review: "http_stub",
      hostile_text_not_executed: true,
      export_logout: true,
      google_incremental_scopes: "http_stub",
      overflow: false,
      native_screenshot: true,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("result.json", folder),
    JSON.stringify(
      {
        browser: browser.version(),
        real_accounts: false,
        real_mobile: false,
        receipts,
        errors,
      },
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
