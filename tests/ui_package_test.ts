import assert from "node:assert/strict";
import { prepareUiPackage, type UiPackageManifest } from "../scripts/prepare_ui.ts";

const allowedDeployRoot = new URL("../.private/deploy/", import.meta.url);
const deployRoot = new URL(
  `test-ui-${crypto.randomUUID()}/`,
  allowedDeployRoot,
);
const API_BASE = "https://api.invalid/functions/v1/arahub";
const IDENTITY = "https://proj.invalid";
const UI_URL = "https://usuario.github.io/AraHub/";
const EXPECTED_FILES = [
  ".nojekyll",
  "LICENSE.txt",
  "index.html",
  "oauth/callback/index.html",
  "oauth/consent/index.html",
  "oauth/google/callback/index.html",
  "ui/app.js",
  "ui/pdf-parser.worker.js",
  "ui/style.css",
];

/** Hash independente do gerador, para conferir o manifesto contra o disco. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copy.buffer),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function listFiles(directory: URL, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory) {
      found.push(
        ...await listFiles(
          new URL(`${entry.name}/`, directory),
          `${prefix}${entry.name}/`,
        ),
      );
    } else {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found.sort();
}

async function cleanup() {
  assert.ok(
    deployRoot.href.startsWith(allowedDeployRoot.href) &&
      deployRoot.href !== allowedDeployRoot.href,
  );
  try {
    await Deno.remove(deployRoot, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

Deno.test("pacote GitHub Pages serve subpath com rotas físicas, meta seguro e manifesto com hashes", async () => {
  try {
    const first = await prepareUiPackage({
      apiBase: API_BASE,
      identityBase: IDENTITY,
      uiOrigin: UI_URL,
      deployRoot,
    });
    const second = await prepareUiPackage({
      apiBase: API_BASE,
      identityBase: IDENTITY,
      uiOrigin: UI_URL,
      deployRoot,
    });
    assert.notEqual(
      first.directory,
      second.directory,
      "cada chamada cria um pacote novo",
    );

    const directory = new URL(first.directory);
    assert.ok(
      !first.manifestPath.startsWith(first.directory),
      "o manifesto fica fora dos assets publicados",
    );

    const manifestText = await Deno.readTextFile(new URL(first.manifestPath));
    const onDisk: UiPackageManifest = JSON.parse(manifestText);
    assert.equal(onDisk.schema, "arahub.ui.package.v1");
    assert.equal(onDisk.published, false);
    assert.equal(onDisk.provider, "github-pages");
    assert.equal(onDisk.ui_base_path, "/AraHub");
    assert.deepEqual(onDisk.files, first.manifest.files);
    assert.deepEqual(
      second.manifest.files,
      first.manifest.files,
      "o mesmo insumo produz os mesmos hashes",
    );
    assert.doesNotMatch(
      manifestText,
      /secret|password|api[_-]?key|anon[_-]?key|publishable|bearer|eyJ/i,
      "manifesto não carrega credenciais",
    );

    const declared = onDisk.files.map((file) => file.path).sort();
    assert.deepEqual(declared, EXPECTED_FILES);
    assert.deepEqual(
      await listFiles(directory),
      declared,
      "nenhum arquivo fora do manifesto",
    );
    assert.ok(
      !declared.includes("_headers") && !declared.includes("_redirects"),
    );

    for (const file of onDisk.files) {
      const bytes = await Deno.readFile(new URL(file.path, directory));
      assert.equal(bytes.byteLength, file.bytes, `bytes de ${file.path}`);
      assert.equal(await sha256(bytes), file.sha256, `hash de ${file.path}`);
    }

    const index = await Deno.readTextFile(new URL("index.html", directory));
    assert.match(
      index,
      /name="arahub-api-base" content="https:\/\/api\.invalid\/functions\/v1\/arahub"/,
    );
    assert.ok(
      index.includes('href="/AraHub/ui/style.css"'),
      "CSS absoluto com prefixo",
    );
    assert.ok(
      index.includes('src="/AraHub/ui/app.js"'),
      "bundle absoluto com prefixo",
    );
    assert.ok(
      index.includes('http-equiv="Content-Security-Policy"'),
      "CSP por meta",
    );
    assert.ok(
      index.includes(
        "connect-src 'self' https://api.invalid https://proj.invalid",
      ),
      "CSP libera apenas o backend e a identidade escolhidos",
    );
    assert.doesNotMatch(
      index,
      /frame-ancestors/,
      "frame-ancestors não se aplica por meta",
    );
    assert.ok(index.includes('<meta name="referrer" content="no-referrer">'));

    const copies = await Promise.all(
      [
        "oauth/consent/index.html",
        "oauth/google/callback/index.html",
        "oauth/callback/index.html",
      ].map((path) => Deno.readFile(new URL(path, directory))),
    );
    for (const copy of copies) {
      assert.deepEqual(
        copy,
        new TextEncoder().encode(index),
        "rota SPA idêntica ao index",
      );
    }
    const nojekyll = await Deno.readFile(new URL(".nojekyll", directory));
    assert.equal(nojekyll.byteLength, 0);
  } finally {
    await cleanup();
  }
});

Deno.test("raiz sem subpath mantém caminhos absolutos simples", async () => {
  try {
    const result = await prepareUiPackage({
      apiBase: API_BASE,
      identityBase: IDENTITY,
      uiOrigin: "https://usuario.github.io",
      deployRoot,
    });
    assert.equal(result.manifest.ui_base_path, "/");
    const index = await Deno.readTextFile(
      new URL("index.html", new URL(result.directory)),
    );
    assert.ok(index.includes('href="/ui/style.css"'));
    assert.ok(index.includes('src="/ui/app.js"'));
    assert.ok(!index.includes("/AraHub/"));
  } finally {
    await cleanup();
  }
});

Deno.test("configuração insegura é recusada antes de escrever qualquer asset", async () => {
  const base = {
    apiBase: API_BASE,
    identityBase: IDENTITY,
    uiOrigin: UI_URL,
    deployRoot,
  };
  await assert.rejects(
    prepareUiPackage({ ...base, uiOrigin: "http://usuario.github.io/AraHub/" }),
    /HTTPS/,
  );
  await assert.rejects(
    prepareUiPackage({
      ...base,
      uiOrigin: "https://usuario.github.io/AraHub/index.html",
    }),
    /diretório/,
  );
  await assert.rejects(
    prepareUiPackage({
      ...base,
      uiOrigin: "https://usuario:token@usuario.github.io/AraHub/",
    }),
    /credenciais/,
  );
  await assert.rejects(
    prepareUiPackage({ ...base, identityBase: "https://proj.invalid/auth" }),
    /HTTPS/,
  );
  await assert.rejects(
    prepareUiPackage({
      ...base,
      apiBase: "http://api.invalid/functions/v1/arahub",
    }),
    /Base pública da API inválida/,
  );
  await assert.rejects(
    prepareUiPackage({ ...base, apiBase: "" }),
    /obrigatória/,
  );
});
