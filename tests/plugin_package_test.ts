import assert from "node:assert/strict";
import { preparePersonalPlugin } from "../scripts/prepare_plugin.ts";

const input = {
  registeredAppId: "asdk_app_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  version: "1.0.1",
  website: "https://hub.example/",
  privacy: "https://hub.example/privacy.html",
};
Deno.test("pacote pessoal liga a Skill ao app existente, sem duplicar servidor ou copiar dados", async () => {
  const result = await preparePersonalPlugin(input);
  const root = new URL(result.directory);
  const manifest = JSON.parse(await Deno.readTextFile(new URL("plugin.json", root)));
  assert.equal(manifest.extensions["com.openai"].apps, "./.app.json");
  assert.equal(manifest.extensions["com.openai"].interface.privacyPolicyURL, input.privacy);
  const apps = JSON.parse(await Deno.readTextFile(new URL(".app.json", root)));
  assert.equal(apps.apps.arahub.id, input.registeredAppId);
  assert.deepEqual(result.files.map((f) => f.name).sort(), [
    ".app.json",
    "LICENSE",
    "plugin.json",
    "skills/academic-memory/SKILL.md",
  ]);
  const skill = await Deno.readTextFile(new URL("skills/academic-memory/SKILL.md", root));
  assert.ok(skill.includes("hub_context") && skill.includes("hub_record_delta"));
  assert.equal(result.installed, false);
  assert.ok((await Deno.readTextFile(new URL("LICENSE", root))).includes("MIT"));
});
Deno.test("pacote recusa IDs e URLs que carreguem dados de autenticação", async () => {
  for (
    const invalid of [
      { registeredAppId: input.registeredAppId + "?token=fixture" },
      { website: "https://user:fixture@hub.example/" },
      { privacy: "https://hub.example/?code=fixture" },
      { privacy: "http://hub.example/privacy" },
    ]
  ) await assert.rejects(() => preparePersonalPlugin({ ...input, ...invalid }));
});
Deno.test("pacote rejeita o ID da página do plugin e valida os namespaces de aplicativos", async () => {
  for (
    const id of [
      "plugin_asdk_app_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "asdk_app_",
      "connector_-bad",
      "templated_apps_ space",
      "asdk_app_A/b",
      "asdk_app_A\n",
    ]
  ) {
    await assert.rejects(() => preparePersonalPlugin({ ...input, registeredAppId: id }));
  }
  for (const id of ["asdk_app_A1-test", "connector_123_test", "templated_apps_Test-1"]) {
    const result = await preparePersonalPlugin({ ...input, registeredAppId: id });
    const apps = JSON.parse(await Deno.readTextFile(new URL(".app.json", result.directory)));
    assert.equal(apps.apps.arahub.id, id);
  }
});
