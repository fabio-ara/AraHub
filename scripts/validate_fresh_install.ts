// Gate A01: instalação limpa com cache Deno realmente vazio.
//
// Orquestra um processo filho (scripts/fresh_install_child.ts) sob um DENO_DIR
// novo, criado exclusivamente em .private/fresh-install/, com lock congelado.
// Isso prova que as dependências travadas são baixadas do zero e não vêm de
// cache algum; o filho então aplica as onze migrations em um banco local novo e
// exercita o servidor MCP pelo SDK oficial em transporte HTTP.
//
// Uso (a partir da raiz do repositório):
//   deno run --allow-read --allow-write=.private/fresh-install --allow-run --allow-env \
//     scripts/validate_fresh_install.ts
//
// Este gate não é implantação hospedada nem Auth real: banco, identidade e
// tokens são sintéticos e locais. O manifesto privado sai sem credenciais.
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESULT_MARKER = "ARAHUB_FRESH_RESULT ";
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function walk(dir: string): Promise<{ path: string; size: number }[]> {
  const found: { path: string; size: number }[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) found.push(...await walk(full));
    else if (entry.isFile) found.push({ path: full, size: (await Deno.stat(full)).size });
  }
  return found;
}

async function npmPackages(cacheDir: string): Promise<string[]> {
  const base = join(cacheDir, "npm", "registry.npmjs.org");
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(base)) {
      if (entry.name.startsWith("@")) {
        for await (const sub of Deno.readDir(join(base, entry.name))) {
          names.push(`${entry.name}/${sub.name}`);
        }
      } else names.push(entry.name);
    }
  } catch { /* caminho ausente em outra versão do Deno: registrar cache vazio de pacotes */ }
  return names.sort();
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${
  crypto.randomUUID().slice(0, 8)
}`;
const runDir = join(ROOT_DIR, ".private", "fresh-install", runId);
const cacheDir = join(runDir, "deno");
await Deno.mkdir(cacheDir, { recursive: true });

const cacheBefore = await walk(cacheDir);
if (cacheBefore.length > 0) {
  throw new Error("O DENO_DIR do gate não começou vazio; cache limpo não comprovado.");
}

const lockPath = join(ROOT_DIR, "deno.lock");
const lockBefore = await sha256Hex(await Deno.readFile(lockPath));
const dbName = `arahub_fresh_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const port = 8800 + Math.floor(Math.random() * 88);

const command = new Deno.Command(Deno.execPath(), {
  cwd: ROOT_DIR,
  args: [
    "run",
    "--quiet",
    "--frozen",
    "--node-modules-dir=none",
    `--allow-net=127.0.0.1:55432,127.0.0.1:${port}`,
    "--allow-env",
    "--allow-read",
    join(ROOT_DIR, "scripts", "fresh_install_child.ts"),
  ],
  env: {
    DENO_DIR: cacheDir,
    ARAHUB_FRESH_DB_NAME: dbName,
    ARAHUB_FRESH_MCP_PORT: String(port),
    NO_COLOR: "1",
  },
  stdout: "piped",
  stderr: "piped",
});
const { code, stdout, stderr } = await command.output();
const outText = new TextDecoder().decode(stdout);
const errText = new TextDecoder().decode(stderr);

const resultLine = outText.split(/\r?\n/).find((line) => line.startsWith(RESULT_MARKER));
const result = resultLine ? JSON.parse(resultLine.slice(RESULT_MARKER.length)) : null;

const cacheAfter = await walk(cacheDir);
const lockAfter = await sha256Hex(await Deno.readFile(lockPath));
const packages = await npmPackages(cacheDir);

const manifest = {
  gate: "A01-fresh-install",
  generated_at: new Date().toISOString(),
  deno_version: Deno.version.deno,
  run_id: runId,
  run_dir: relative(ROOT_DIR, runDir).replaceAll("\\", "/"),
  deno_dir: relative(ROOT_DIR, cacheDir).replaceAll("\\", "/"),
  flags: { frozen: true, node_modules_dir: "none", cache_started_empty: true },
  cache: {
    files_before: cacheBefore.length,
    files_after: cacheAfter.length,
    bytes_after: cacheAfter.reduce((sum, file) => sum + file.size, 0),
    npm_packages: packages,
  },
  lock: { path: "deno.lock", sha256: lockAfter, unchanged: lockBefore === lockAfter },
  child_exit_code: code,
  child: result,
  hosted: false,
  auth_real: false,
  synthetic_identity: true,
};

await Deno.mkdir(join(runDir, "evidence"), { recursive: true });
await Deno.writeTextFile(
  join(runDir, "evidence", "fresh-install.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

const required: [string, unknown][] = [
  ["migrations_applied=11", result?.migrations_applied === 11],
  ["rls_verified", result?.rls_verified === true],
  ["two_owners_verified", result?.two_owners_verified === true],
  ["idempotency_verified", result?.idempotency_verified === true],
  ["write_retrieve_verified", result?.write_retrieve_verified === true],
  ["owner_isolation_verified", result?.owner_isolation_verified === true],
  ["auth_rejections_verified", result?.auth_rejections_verified === true],
  ["cache_started_empty", cacheBefore.length === 0],
  ["dependencies_downloaded", cacheAfter.length > 0],
  ["deno.lock unchanged", lockBefore === lockAfter],
];
const failed = required.filter(([, ok]) => !ok).map(([label]) => label);

if (code !== 0 || !result || failed.length > 0) {
  console.error(errText.slice(-4000));
  throw new Error(
    `Gate de instalação limpa reprovado (exit ${code}). Falhas: ${
      failed.join(", ") || "sem resultado do filho"
    }.`,
  );
}

console.log(
  `Instalação limpa com cache vazio aprovada: ${result.migrations_applied} migrations, MCP SDK HTTP, ` +
    `dois donos, retry idempotente. Cache Deno novo: ${cacheAfter.length} arquivos / ` +
    `${manifest.cache.bytes_after} bytes; pacotes npm: ${packages.join(", ")}. ` +
    `deno.lock intacto (${lockAfter.slice(0, 12)}…). ` +
    `Manifesto privado: ${manifest.run_dir}/evidence/fresh-install.json`,
);
