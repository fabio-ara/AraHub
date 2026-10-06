// Bind generic skills to an already registered personal MCP app; no service mutation.
export async function preparePersonalPlugin(input: {
  registeredPluginId: string;
  version: string;
  website: string;
  privacy: string;
}) {
  if (!/^plugin_asdk_app_[0-9a-f]{32}$/.test(input.registeredPluginId)) {
    throw new Error("Use o ID técnico do plugin MCP já registrado, sem credenciais.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error("Versão inválida.");
  for (const value of [input.website, input.privacy]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Use URLs HTTPS sem credenciais, consulta ou fragmento.");
    }
  }
  const parent = new URL(
    `../.private/deploy/personal-plugin-${crypto.randomUUID()}/`,
    import.meta.url,
  );
  const root = new URL("arahub/", parent);
  await Deno.mkdir(new URL("skills/academic-memory/", root), { recursive: true });
  const base = JSON.parse(
    await Deno.readTextFile(new URL("../plugin/plugin.json", import.meta.url)),
  );
  const manifest = {
    ...base,
    version: input.version,
    extensions: {
      "com.openai": {
        apps: "./.app.json",
        interface: {
          displayName: "AraHub",
          shortDescription: base.description,
          websiteURL: input.website,
          privacyPolicyURL: input.privacy,
          defaultPrompt: ["Retome meu contexto acadêmico com fontes e incertezas."],
        },
      },
    },
  };
  // Registered app mapping preserves its existing OAuth account. No duplicate MCP server.
  const files = new Map<string, string>([
    ["plugin.json", JSON.stringify(manifest, null, 2) + "\n"],
    [
      ".app.json",
      JSON.stringify({ apps: { arahub: { id: input.registeredPluginId } } }, null, 2) + "\n",
    ],
    [
      "skills/academic-memory/SKILL.md",
      await Deno.readTextFile(
        new URL("../plugin/skills/academic-memory/SKILL.md", import.meta.url),
      ),
    ],
    ["LICENSE", await Deno.readTextFile(new URL("../LICENSE", import.meta.url))],
  ]);
  const hashes = [];
  for (const [name, content] of files) {
    const bytes = new TextEncoder().encode(content);
    await Deno.writeFile(new URL(name, root), bytes, { createNew: true });
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    hashes.push({ name, bytes: bytes.length, sha256: hash });
  }
  const receipt = {
    prepared: true,
    installed: false,
    directory: root.href,
    version: input.version,
    files: hashes,
  };
  await Deno.writeTextFile(new URL("receipt.json", parent), JSON.stringify(receipt, null, 2), {
    createNew: true,
  });
  return receipt;
}

if (import.meta.main) {
  if (Deno.args.length !== 4) {
    throw new Error(
      "Uso: prepare_plugin.ts <plugin_asdk_app_ID> <versão> <site HTTPS> <privacidade HTTPS>",
    );
  }
  const [registeredPluginId, version, website, privacy] = Deno.args;
  console.log(
    JSON.stringify(await preparePersonalPlugin({ registeredPluginId, version, website, privacy })),
  );
}
