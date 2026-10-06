/**
 * AraHub — pacote estático para GitHub Pages.
 *
 * Gera um diretório novo em `.private/deploy/` com a interface pública MIT
 * pronta para ser servida a partir de uma URL base com subpath de projeto
 * (por exemplo `https://usuario.github.io/AraHub/`). Nada aqui contata
 * provedor, publica ou sobrescreve pacote anterior: cada chamada cria
 * `ui-<uuid>/` e um manifesto irmão `ui-<uuid>.manifest.json` fora dos assets.
 *
 * GitHub Pages não permite cabeçalhos HTTP customizados, então a proteção
 * vive no próprio HTML: CSP e `referrer` por `<meta>` e o frameguard do app
 * (`window.top !== window.self`). `frame-ancestors` é omitido de propósito,
 * porque o navegador ignora esse diretivo em CSP entregue por `<meta>`. As
 * rotas `oauth/...` são servidas por cópias físicas de `index.html` e o
 * `.nojekyll` desliga o processamento Jekyll.
 *
 * O app calcula a base do site com `new URL("../", import.meta.url)`, então
 * servir o bundle em `<base>/ui/app.js` mantém as rotas e a origem da API no
 * mesmo prefixo. `web/app.js` precisa existir (`deno task web:build`).
 */

import { apiEndpoint } from "../web/endpoint.ts";
import { sha256Hex } from "../src/migration.ts";

/** Entrada explícita para gerar o pacote; nenhuma chamada de rede ocorre. */
export type UiPackageOptions = {
  /** Base HTTPS pública da API, ex.: `https://<ref>.supabase.co/functions/v1/arahub`. */
  apiBase: string;
  /** Origem HTTPS do Supabase (identidade/Auth), sem caminho nem credenciais. */
  identityBase: string;
  /** URL HTTPS da interface, aceitando subpath de projeto (`.../AraHub/`). */
  uiOrigin: string;
  /** Diretório `web/` com `index.html`, `app.js` e `style.css` já construídos. */
  source?: URL;
  /** Raiz onde o pacote novo é criado; padrão `.private/deploy/`. */
  deployRoot?: URL;
};

/** Arquivo declarado no manifesto, com bytes e hash conferíveis. */
export type UiPackageFile = { path: string; bytes: number; sha256: string };

/** Manifesto do pacote; fica fora dos assets e nunca carrega credenciais. */
export type UiPackageManifest = {
  schema: "arahub.ui.package.v1";
  prepared_at: string;
  published: false;
  provider: "github-pages";
  api_base: string;
  ui_url: string;
  ui_origin: string;
  ui_base_path: string;
  identity_origin: string;
  files: UiPackageFile[];
};

export type UiPackageResult = {
  /** URL `file:` do diretório novo; nunca reutiliza um nome existente. */
  directory: string;
  /** URL `file:` do manifesto, irmão do diretório de assets. */
  manifestPath: string;
  manifest: UiPackageManifest;
};

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text);
const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll(
    "<",
    "&lt;",
  )
    .replaceAll(">", "&gt;");

function parseIdentity(identityBase: string): string {
  let url: URL;
  try {
    url = new URL(identityBase);
  } catch {
    throw new Error("Supabase exige origem HTTPS exata, sem credenciais.");
  }
  if (
    url.protocol !== "https:" || url.origin !== identityBase || url.username ||
    url.password
  ) {
    throw new Error("Supabase exige origem HTTPS exata, sem credenciais.");
  }
  return url.origin;
}

function parseBackend(apiBase: string): string {
  if (!apiBase) throw new Error("Base HTTPS da API é obrigatória.");
  // `apiEndpoint` rejeita protocolo não-HTTPS e base com credenciais/consulta/fragmento.
  return new URL(apiEndpoint(apiBase, "/api/config")).origin;
}

function parseUi(uiOrigin: string): { origin: string; basePath: string } {
  let url: URL;
  try {
    url = new URL(uiOrigin);
  } catch {
    throw new Error(
      "A interface exige URL HTTPS de diretório, sem credenciais.",
    );
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash
  ) {
    throw new Error(
      "A interface exige URL HTTPS de diretório, sem credenciais.",
    );
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const segment = basePath.split("/").at(-1) ?? "";
  if (
    basePath.includes("..") || basePath.includes("//") || segment.includes(".")
  ) {
    throw new Error(
      "O subpath da interface deve ser um diretório, não um arquivo.",
    );
  }
  return { origin: url.origin, basePath };
}

function contentSecurityPolicy(
  backendOrigin: string,
  identityOrigin: string,
): string {
  // Sem `frame-ancestors`: o navegador ignora esse diretivo em CSP via `<meta>` e o
  // GitHub Pages não permite cabeçalhos; a defesa de enquadramento é o frameguard do app.
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self' ${backendOrigin} ${identityOrigin}`,
  ].join("; ");
}

function buildIndex(
  html: string,
  params: { apiBase: string; assetPrefix: string; csp: string },
): Uint8Array {
  const charset = '<meta charset="utf-8">';
  const apiMarker = '<meta name="arahub-api-base" content="">';
  const styleHref = 'href="/ui/style.css"';
  const scriptSrc = 'src="/ui/app.js"';
  const markers: [string, string][] = [
    ["charset", charset],
    ["API", apiMarker],
    ["estilo", styleHref],
    ["script", scriptSrc],
  ];
  for (const [label, needle] of markers) {
    if (html.split(needle).length !== 2) {
      throw new Error(
        `Marcador ${label} ausente ou duplicado em web/index.html.`,
      );
    }
  }
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(params.csp)}">`,
    '<meta name="referrer" content="no-referrer">',
  ].join("\n    ");
  const prepared = html
    .replace(charset, `${charset}\n    ${head}`)
    .replace(
      apiMarker,
      `<meta name="arahub-api-base" content="${escapeAttribute(params.apiBase)}">`,
    )
    .replace(styleHref, `href="${params.assetPrefix}/ui/style.css"`)
    .replace(scriptSrc, `src="${params.assetPrefix}/ui/app.js"`)
    .replace('href="/privacy.html"', `href="${params.assetPrefix}/privacy.html"`);
  return encode(prepared);
}

/** Gera o pacote estático novo e devolve caminhos e manifesto; não contata rede. */
export async function prepareUiPackage(
  options: UiPackageOptions,
): Promise<UiPackageResult> {
  const identityOrigin = parseIdentity(options.identityBase);
  const backendOrigin = parseBackend(options.apiBase);
  const ui = parseUi(options.uiOrigin);
  const source = options.source ?? new URL("../web/", import.meta.url);
  const deployRoot = options.deployRoot ??
    new URL("../.private/deploy/", import.meta.url);

  const html = buildIndex(
    await Deno.readTextFile(new URL("index.html", source)),
    {
      apiBase: options.apiBase,
      assetPrefix: ui.basePath,
      csp: contentSecurityPolicy(backendOrigin, identityOrigin),
    },
  );
  const files: [string, Uint8Array][] = [
    ["index.html", html],
    ["privacy.html", encode((await Deno.readTextFile(new URL("privacy.html", source)))
      .replace('href="/ui/style.css"', `href="${ui.basePath}/ui/style.css"`))],
    ["ui/app.js", await Deno.readFile(new URL("app.js", source))],
    [
      "ui/pdf-parser.worker.js",
      await Deno.readFile(new URL("pdf-parser.worker.js", source)),
    ],
    ["ui/style.css", await Deno.readFile(new URL("style.css", source))],
    [".nojekyll", new Uint8Array(0)],
    ["oauth/consent/index.html", html],
    ["oauth/google/callback/index.html", html],
    ["oauth/callback/index.html", html],
    [
      "LICENSE.txt",
      encode((await Promise.all([
        Deno.readTextFile(new URL("../LICENSE", import.meta.url)),
        Deno.readTextFile(
          new URL("../THIRD_PARTY_NOTICES.md", import.meta.url),
        ),
      ])).join("\n\n")),
    ],
  ];

  const token = crypto.randomUUID();
  const root = new URL(`ui-${token}/`, deployRoot);
  const manifestUrl = new URL(`ui-${token}.manifest.json`, deployRoot);
  await Deno.mkdir(deployRoot, { recursive: true });
  await Deno.mkdir(root, { recursive: true });
  for (const [path, bytes] of files) {
    const slash = path.lastIndexOf("/");
    if (slash >= 0) {
      await Deno.mkdir(new URL(path.slice(0, slash + 1), root), {
        recursive: true,
      });
    }
    await Deno.writeFile(new URL(path, root), bytes, { createNew: true });
  }
  const manifest: UiPackageManifest = {
    schema: "arahub.ui.package.v1",
    prepared_at: new Date().toISOString(),
    published: false,
    provider: "github-pages",
    api_base: options.apiBase,
    ui_url: options.uiOrigin,
    ui_origin: ui.origin,
    ui_base_path: ui.basePath || "/",
    identity_origin: identityOrigin,
    files: await Promise.all(
      files.map(async ([path, bytes]) => ({
        path,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      })),
    ),
  };
  await Deno.writeTextFile(
    manifestUrl,
    JSON.stringify(manifest, null, 2) + "\n",
    {
      createNew: true,
    },
  );
  return { directory: root.href, manifestPath: manifestUrl.href, manifest };
}

if (import.meta.main) {
  const [apiBase, identityBase, uiOrigin] = Deno.args;
  if (!apiBase || !identityBase || !uiOrigin || Deno.args.length !== 3) {
    throw new Error(
      "Uso: prepare_ui.ts <base HTTPS da API> <origem Supabase> <URL HTTPS da UI (subpath aceito)>",
    );
  }
  const result = await prepareUiPackage({ apiBase, identityBase, uiOrigin });
  console.log(
    JSON.stringify({
      prepared: true,
      published: false,
      provider: "github-pages",
      directory: result.directory,
      manifest: result.manifestPath,
      files: result.manifest.files.length,
    }),
  );
}
