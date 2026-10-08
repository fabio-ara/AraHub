// Isolated local browser. Captures use native screenshot bytes written outside the UI.
// No authenticated user profiles, real provider accounts, external URLs or private data.
// Google own-write/connect UI is retired: this script proves its absence plus the
// focused academic approval surface (Moodle forum/assignment) with synthetic fixtures.
import { chromium } from "../.private/qa/node_modules/playwright/index.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8787";
const folder = new URL("../.private/evidence/ui/", import.meta.url);
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const owner = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connectionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const mobileToken = "a".repeat(32);
const mobilePrivateToken = "b".repeat(32);
const mobileLink = "moodlemobile://token=" +
  Buffer.from(`${"c".repeat(32)}:::${mobileToken}:::${mobilePrivateToken}`).toString("base64");
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
    ["/ui/theme.js", "theme.js", "application/javascript"],
    ["/privacy.html", "privacy.html", "text/html"],
    ["/ui/app.js", "app.js", "application/javascript"],
    ["/ui/style.css", "style.css", "text/css"],
  ].map(async (
    [path, file, type],
  ) => [path, {
    body: await readFile(new URL(`../web/${file}`, import.meta.url)),
    type,
  }])),
);
const actionForum = "11111111-1111-4111-8111-111111111111";
const actionFiles = "22222222-2222-4222-8222-222222222222";
const actionReply = "33333333-3333-4333-8333-333333333333";
const actionUnknown = "44444444-4444-4444-8444-444444444444";
const fileHash = "d".repeat(64);
const hashes = {
  [actionForum]: "a".repeat(64),
  [actionFiles]: "b".repeat(64),
  [actionReply]: "c".repeat(64),
  [actionUnknown]: "e".repeat(64),
};
function actionList(approved) {
  const state = (id) => approved.has(id) ? "approved" : "prepared";
  return [{
    action: {
      id: actionForum,
      connectionId,
      operation: "moodle.forum.discussion",
      target: "forum:7",
      revision: "rev-forum",
      content: {
        kind: "moodle.forum.discussion",
        connection: {
          label: "Moodle de teste",
          origin: "https://moodle.fixture.invalid",
          username: "aluno.fixture",
        },
        target: {
          course_id: 12,
          course_name: "Direito Constitucional",
          cmid: 900,
          activity_name: "Fórum de apresentação",
          instance_id: 7,
        },
        text: {
          subject: "Minha apresentação",
          body: "Texto do tópico com <script>window.__sourceExecuted=true</script> no fim.",
        },
        files: [],
        statement: {
          text: "Declaro que este texto é de minha autoria.",
          required: true,
        },
        expected: {
          epoch: 1,
          user_id: 42,
          fingerprint: "f".repeat(64),
          attempt: null,
          status: null,
        },
        rules: {
          forum: {
            id: 7,
            type: "general",
            duedate: 1790000000,
            cutoffdate: 0,
            maxattachments: 2,
            maxbytes: 1048576,
          },
          access: { canstartdiscussion: true, canreplypost: true },
          discussion: null,
          parent: null,
        },
      },
      hash: hashes[actionForum],
    },
    state: state(actionForum),
  }, {
    action: {
      id: actionFiles,
      connectionId,
      operation: "moodle.assignment.submit",
      target: "assign:55",
      revision: "rev-trabalho",
      content: {
        kind: "moodle.assignment.submit",
        connection: { label: "Moodle de teste", username: "aluno.fixture" },
        target: {
          course_name: "Metodologia",
          cmid: 55,
          activity_name: "Trabalho 1",
        },
        files: [{
          id: "f1",
          name: "trabalho-final.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: 20480,
          sha256: fileHash,
        }],
        statement: {
          text: "Declaro que o arquivo é de minha autoria.",
          required: true,
        },
        expected: { attempt: 0, status: "draft" },
        rules: {
          assignment: {
            id: 55,
            duedate: 1790000000,
            cutoffdate: 0,
            allowsubmissionsfromdate: 1780000000,
            maxattempts: 1,
            submissiondrafts: 1,
            requiresubmissionstatement: 1,
            grade: 100,
            configs: [
              {
                plugin: "file",
                subtype: "assignsubmission",
                name: "maxfilesubmissions",
                value: "3",
              },
              {
                plugin: "file",
                subtype: "assignsubmission",
                name: "maxsubmissionsizebytes",
                value: "5242880",
              },
            ],
          },
          submission: {
            status: "draft",
            attempt: 0,
            locked: false,
            cansubmit: true,
            canedit: true,
          },
        },
      },
      hash: hashes[actionFiles],
    },
    state: state(actionFiles),
  }, {
    action: {
      id: actionReply,
      connectionId,
      operation: "moodle.forum.reply",
      target: "forum:7/discussion:3",
      revision: "rev-resposta",
      content: {
        kind: "moodle.forum.reply",
        connection: { label: "Moodle de teste", username: "aluno.fixture" },
        target: {
          course_name: "Direito Constitucional",
          activity_name: "Fórum de apresentação",
          discussion_id: 3,
          parent_id: 9,
        },
        text: { body: "Concordo com o colega e acrescento um ponto." },
        statement: { text: "Declaro autoria.", required: false },
        expected: { status: null },
        rules: {
          forum: { type: "qanda" },
          access: { canreplypost: true },
          discussion: { canreply: true, locked: false },
          parent: {
            id: 9,
            subject: "Dúvida",
            message: "<p>Primeira linha</p><p>Última <b>linha</b></p>",
            author: { fullname: "Colega Sintético" },
          },
        },
      },
      hash: hashes[actionReply],
    },
    state: state(actionReply),
  }, {
    action: {
      id: actionUnknown,
      connectionId,
      operation: "docs_insert_text",
      target: "legacy",
      revision: null,
      content: {
        text: "Conteúdo legado hostil <script>window.__sourceExecuted=true</script>",
      },
      hash: hashes[actionUnknown],
    },
    state: state(actionUnknown),
  }];
}
try {
  for (
    const viewport of [{ width: 1280, height: 900 }, {
      width: 390,
      height: 844,
    }]
  ) {
    const context = await browser.newContext({ viewport });
    await context.route("https://moodle.fixture.invalid/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>Moodle sintético</title>",
      }));
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    let renewed = false;
    const approved = new Set();
    const decisions = [];
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
          canApproveActions: true,
          canExtractPdf: false,
          canAuthorizeOwnStatus: true,
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
      if (url.pathname === "/api/connections/own-status/review") {
        return reply({
          label: "Moodle de teste",
          origin: "https://moodle.fixture.invalid",
          account: "Aluno sintético",
          explanation: "Esta consulta pode atualizar registros técnicos de acesso.",
          allowed: true,
        });
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
            id: "old-google",
            provider: "google",
            label: "Institucional preservado",
            state: "connected",
          }, {
            id: "old-migration",
            provider: "migration",
            label: "Histórico importado",
            state: "connected",
          }],
          coverage: { memory: "persisted", contexts: "complete", deltas: "partial" },
        });
      }
      if (url.pathname === "/api/preferences") {
        assert.equal(url.searchParams.get("scope"), "{}");
        const netiqueta = {
          id: "p-1",
          content: "Escrever respostas em português formal.",
          scope: { course: "Direito Constitucional" },
          preference: {
            key: "netiqueta no fórum",
            state: "active",
            valid_from: "2026-09-01T00:00:00.000Z",
          },
          status: "current",
        };
        const pdf = {
          id: "p-2",
          content: "Entregar sempre em PDF.",
          scope: { course: "Direito Constitucional" },
          preference: { key: "formato de entrega", state: "active" },
          status: "current",
        };
        const docx = {
          id: "p-3",
          content: "Entregar em DOCX quando pedido.",
          scope: {},
          preference: { key: "formato de entrega", state: "active" },
          status: "current",
        };
        const legacy = {
          id: "p-4",
          content: "Prefiro respostas curtas.",
          scope: {},
          preference: null,
          evidence_kind: "user_report",
          status: "legacy_requires_review",
        };
        return reply({
          at: "2026-10-07T12:00:00.000Z",
          coverage: "complete",
          applicable: [netiqueta],
          history: [netiqueta, pdf, docx, legacy],
          contextual_overrides: ["p-3"],
          conflicts: [{ key: "formato de entrega", ids: ["p-2", "p-3"] }],
          review_required: [pdf, docx, legacy],
          content_is_untrusted_data: true,
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
        return reply(actionList(approved));
      }
      if (
        url.pathname === "/api/actions/approve" ||
        url.pathname === "/api/actions/deny"
      ) {
        const input = request.postDataJSON();
        const decision = url.pathname.endsWith("/approve") ? "approve" : "deny";
        assert.ok(Object.hasOwn(hashes, input.action_id));
        assert.equal(input.content_hash, hashes[input.action_id]);
        assert.equal(typeof input.statement_accepted, "boolean");
        const needsAssent = input.action_id === actionForum ||
          input.action_id === actionFiles;
        assert.equal(
          input.statement_accepted,
          decision === "approve" && needsAssent,
        );
        decisions.push({
          id: input.action_id,
          decision,
          statement_accepted: input.statement_accepted,
        });
        if (decision === "approve") approved.add(input.action_id);
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

    // Own Google operation is gone from the interface.
    assert.equal(await page.locator("#google-setup").count(), 0);
    assert.equal(await page.locator("#google-connect-form").count(), 0);
    const bodyText = await page.locator("body").textContent();
    for (
      const forbidden of [
        "Google",
        "Ampliar permissões",
        "Conectar outra conta",
      ]
    ) assert.ok(!bodyText.includes(forbidden), forbidden);

    // Quiet connection view: state is accessible without redundant text/cards.
    await page.getByRole("button", { name: "Conexões", exact: true }).click();
    assert.equal(await page.locator("#connection-health").count(), 0);
    assert.equal(await page.getByRole("img", { name: "Conectada", exact: true }).count(), 1);
    assert.equal(await page.locator("#moodle-setup, #pdf-setup").count(), 0);
    assert.equal(await page.locator("#actions-panel").isVisible(), false);
    assert.ok(
      (await page.locator("#connection-list").textContent()).includes("Moodle de teste"),
    );
    await writeFile(
      new URL(`connections-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );

    const shellBox = await page.locator(".app-shell").boundingBox();
    const checkGeometry = async (name) => {
      assert.deepEqual(await page.locator(".app-shell").boundingBox(), shellBox, name);
      const problems = await page.locator("button:visible, a.icon-ghost:visible").evaluateAll(
        (nodes) => {
          const boxes = nodes.map((node) => {
            const raw = node.getBoundingClientRect();
            const box = { left: raw.left, right: raw.right, top: raw.top, bottom: raw.bottom };
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
              const css = getComputedStyle(parent), rect = parent.getBoundingClientRect();
              if (/auto|scroll|hidden|clip/.test(css.overflowX)) {
                box.left = Math.max(box.left, rect.left);
                box.right = Math.min(box.right, rect.right);
              }
              if (/auto|scroll|hidden|clip/.test(css.overflowY)) {
                box.top = Math.max(box.top, rect.top);
                box.bottom = Math.min(box.bottom, rect.bottom);
              }
            }
            return { node, raw, box };
          }).filter(({ box }) => box.left < box.right && box.top < box.bottom);
          return boxes.flatMap(({ node, raw, box }, index) => {
            const label = node.getAttribute("aria-label");
            const problems = [];
            if (!label || node.textContent.trim() || raw.width !== 44 || raw.height !== 44) {
              problems.push(label || node.id);
            }
            for (const other of boxes.slice(index + 1)) {
              if (
                box.left < other.box.right && box.right > other.box.left &&
                box.top < other.box.bottom && box.bottom > other.box.top
              ) problems.push("overlap:" + label);
            }
            return problems;
          });
        },
      );
      assert.deepEqual(problems, [], name);
    };
    await checkGeometry("connections");
    assert.equal(
      (await page.locator("#theme").boundingBox()).x,
      (await page.locator("#connections-tab").boundingBox()).x,
    );
    assert.equal(
      (await page.locator("#privacy").boundingBox()).x,
      (await page.locator("#connections-tab").boundingBox()).x,
    );
    await page.getByRole("button", { name: "Status das minhas entregas", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    const modalBox = await page.getByRole("dialog").boundingBox();
    assert.equal(modalBox.width, shellBox.width);
    assert.equal(modalBox.height, shellBox.height);
    await writeFile(new URL(`own-status-${viewport.width}.png`, folder), await page.screenshot());
    await page.getByRole("button", { name: "Cancelar", exact: true }).click();
    const connectionTitleBox = await page.locator("#connections-view h2").boundingBox();
    // Preferences come from the scoped endpoint: valid scopes, conflicts, review.
    await page.getByRole("button", { name: "Preferências", exact: true }).click();
    await page.locator("#preferences-view").waitFor({ state: "visible" });
    await checkGeometry("preferences");
    const preferenceTitleBox = await page.locator("#preferences-view h2").boundingBox();
    assert.equal(preferenceTitleBox.y, connectionTitleBox.y);
    assert.equal(preferenceTitleBox.height, connectionTitleBox.height);
    const preferenceSummary = await page.locator("#preference-summary").textContent();
    assert.match(
      preferenceSummary,
      /1 vigente\(s\), 1 conflito\(s\), 1 para revisar/,
    );
    assert.ok(
      preferenceSummary.includes("1 sobreposto(s) por escopo mais específico"),
    );
    assert.ok(!preferenceSummary.includes("visões recentes"));
    const preferenceText = await page.locator("#preference-list").textContent();
    assert.ok(preferenceText.includes("netiqueta no fórum"));
    assert.ok(preferenceText.includes("Escrever respostas em português formal."));
    assert.ok(preferenceText.includes("Escopo: course=Direito Constitucional."));
    assert.ok(preferenceText.includes("Conflito: formato de entrega"));
    assert.ok(preferenceText.includes("Entregar sempre em PDF."));
    assert.ok(preferenceText.includes("Entregar em DOCX quando pedido."));
    assert.ok(preferenceText.includes("Prefiro respostas curtas."));
    assert.ok(
      preferenceText.includes(
        "Situação: registro antigo sem chave, requer revisão.",
      ),
    );
    await writeFile(
      new URL(`preferences-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await page.getByRole("button", { name: "Conexões", exact: true }).click();

    // Moodle renewal through the official mobile link.
    await page.getByRole("button", { name: "Adicionar Moodle", exact: true }).click();
    await page.locator("#moodle-origin").click();
    await page.locator("#moodle-origin").fill("fixture@example.invalid");
    assert.equal(await page.locator("#moodle-origin").inputValue(), "");
    await page.getByRole("button", { name: "Voltar às conexões", exact: true }).click();
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
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Abrir entrada oficial do Moodle" })
      .click();
    const popup = await popupPromise;
    await popup.waitForURL(/moodle\.fixture\.invalid/, { timeout: 5000 });
    const launch = new URL(popup.url());
    assert.equal(launch.origin, "https://moodle.fixture.invalid");
    assert.equal(launch.pathname, "/admin/tool/mobile/launch.php");
    assert.equal(launch.searchParams.get("service"), "moodle_mobile_app");
    assert.match(launch.searchParams.get("passport") ?? "", /^[a-f0-9]{32}$/);
    await popup.close();
    await page.locator("#moodle-token").fill(mobileLink);
    await page.getByRole("button", { name: "Renovar Moodle", exact: true })
      .click();
    await page.getByText(
      "Acesso renovado.",
      { exact: true },
    ).waitFor();
    assert.equal(renewed, true);
    assert.equal(await page.locator("#moodle-token").inputValue(), "");
    assert.equal(await page.locator("#moodle-view").isVisible(), false);
    await page.getByRole("button", { name: "Ações acadêmicas", exact: true }).click();

    await checkGeometry("academic review");
    // Focused academic approval surface.
    const cards = page.locator("#action-list > .item-row");
    assert.equal(await cards.count(), 3);
    const forum = cards.nth(0);
    const forumText = await forum.textContent();
    assert.ok(forumText.includes("Publicar novo tópico no fórum"));
    assert.ok(forumText.includes("Direito Constitucional"));
    assert.ok(
      forumText.includes(
        "Texto do tópico com <script>window.__sourceExecuted=true</script> no fim.",
      ),
    );
    assert.ok(forumText.includes("Declaro que este texto é de minha autoria."));
    assert.equal(
      await page.evaluate(() => window.__sourceExecuted),
      undefined,
    );
    const forumApprove = forum.getByRole("button", {
      name: "Autorizar esta ação",
      exact: true,
    });
    assert.equal(await forumApprove.isDisabled(), true);
    await forum.getByText("Concordo com esta declaração e assumo a autoria.", {
      exact: true,
    }).click();
    assert.equal(await forumApprove.isEnabled(), true);
    await writeFile(
      new URL(`approval-${viewport.width}.png`, folder),
      await page.screenshot({ fullPage: true, animations: "disabled" }),
    );
    await forumApprove.click();
    await page.getByText(
      "Ação autorizada. O resultado aparecerá após a execução.",
      { exact: true },
    ).waitFor();

    const filesCard = cards.nth(1);
    const filesText = await filesCard.textContent();
    assert.ok(filesText.includes("trabalho-final.docx"));
    assert.ok(filesText.includes("20.0 KiB"));
    // No raw JSON and no technical hash anywhere in the human preview.
    assert.ok(!filesText.includes(fileHash));
    for (
      const material of [
        "Prazo: ",
        "Arquivos por entrega: até 3",
        "Tamanho máximo por arquivo: 5.0 MiB",
        "Estado atual: Rascunho salvo",
        "Pode finalizar no estado atual: Sim",
      ]
    ) assert.ok(filesText.includes(material), material);
    const filesApprove = filesCard.getByRole("button", {
      name: "Autorizar esta ação",
      exact: true,
    });
    assert.equal(await filesApprove.isDisabled(), true);
    await filesCard.getByText(
      "Concordo com esta declaração e assumo a autoria.",
      { exact: true },
    ).click();
    await filesCard.scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    );
    await writeFile(
      new URL(`content-review-${viewport.width}.png`, folder),
      await page.screenshot({ animations: "disabled" }),
    );
    await filesApprove.click();
    await page.getByText(
      "Ação autorizada. O resultado aparecerá após a execução.",
      { exact: true },
    ).waitFor();

    const reply = cards.nth(2);
    const replyText = await reply.textContent();
    assert.ok(replyText.includes("Responder no fórum"));
    assert.ok(replyText.includes("Tipo do fórum: Perguntas e respostas"));
    assert.ok(replyText.includes("Respondendo a: Colega Sintético — Dúvida"));
    assert.ok(replyText.includes("Post original: Primeira linha\nÚltima linha"));
    assert.equal(await reply.locator(".check-label").count(), 0);
    const replyApprove = reply.getByRole("button", {
      name: "Autorizar esta ação",
      exact: true,
    });
    assert.equal(await replyApprove.isEnabled(), true);
    await replyApprove.click();
    await page.getByText(
      "Ação autorizada. O resultado aparecerá após a execução.",
      { exact: true },
    ).waitFor();

    const history = page.locator("#action-history");
    assert.equal(await history.getAttribute("open"), null);
    await history.locator("summary").click();
    const legacy = history.locator(".action-card");
    const legacyText = await legacy.textContent();
    assert.ok(legacyText.includes("Operação aposentada"));
    assert.ok(!legacyText.includes("docs_insert_text"));
    assert.ok(legacyText.includes("não autoriza nem executa esta operação"));
    // The retired operation keeps no raw content and cannot be authorized.
    assert.ok(!legacyText.includes("window.__sourceExecuted"));
    assert.equal(
      await legacy.getByRole("button", {
        name: "Autorizar esta ação",
        exact: true,
      }).count(),
      0,
    );
    assert.equal(
      await legacy.getByRole("button", { name: "Recusar ação", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.__sourceExecuted), undefined);
    assert.equal(decisions.length, 3);
    assert.equal(
      decisions.find((entry) => entry.id === actionForum)?.statement_accepted,
      true,
    );
    assert.equal(
      decisions.find((entry) => entry.id === actionFiles)?.statement_accepted,
      true,
    );
    assert.equal(
      decisions.find((entry) => entry.id === actionReply)?.statement_accepted,
      false,
    );

    // Layout, labels and touch targets.
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.ok(
      await page.locator(".app-shell").evaluate((el) => el.getBoundingClientRect().width) <= 460,
    );
    assert.deepEqual(
      await page.locator("button:visible").evaluateAll((buttons) =>
        buttons.filter((b) => {
          const label = (b.getAttribute("aria-label") ?? "").trim() ||
            (b.textContent ?? "").trim();
          const box = b.getBoundingClientRect();
          return !label || (b.textContent ?? "").trim() || box.width !== 44 || box.height !== 44;
        }).map((b) => b.id || (b.textContent ?? "").trim())
      ),
      [],
    );

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
    assert.equal(await page.locator("#preference-list").textContent(), "");
    receipts.push({
      viewport,
      login: "provider_stub",
      moodle_renewal: "http_stub",
      academic_forum_discussion: "http_stub",
      academic_assignment_files: "http_stub",
      academic_forum_reply_without_statement: "http_stub",
      retired_operation_historical: true,
      preferences_scoped_endpoint: true,
      hostile_text_not_executed: true,
      google_ui_absent: true,
      raw_technical_json_absent: true,
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
