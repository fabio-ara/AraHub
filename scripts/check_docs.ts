// Check local links without network calls or access to private material.
import { dirname, isAbsolute, relative, resolve } from "node:path";

const root = Deno.cwd();
const files: string[] = [];
async function collect(folder: string) {
  for await (const item of Deno.readDir(folder)) {
    const path = resolve(folder, item.name);
    if (item.isDirectory) await collect(path);
    else if (item.isFile && item.name.endsWith(".md")) files.push(path);
  }
}
await collect(resolve(root, "docs"));
for (const name of ["README.md", "CONTRIBUTING.md", "STATUS.md", "plugin/README.md"]) {
  files.push(resolve(root, name));
}
const failures: string[] = [];
let links = 0;
for (const file of files) {
  const content = (await Deno.readTextFile(file)).replace(/```[\s\S]*?```/g, "");
  for (const match of content.matchAll(/\[[^\]\n]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
    const target = resolve(dirname(file), decodeURIComponent(href.split(/[?#]/)[0]));
    const within = relative(root, target);
    if (
      within.startsWith("..") || isAbsolute(within) ||
      within.split(/[\\/]/).some((s) => s.startsWith(".private"))
    ) {
      failures.push(`${relative(root, file)}: destino fora da documentação pública: ${href}`);
      continue;
    }
    try {
      await Deno.stat(target);
      links++;
    } catch {
      failures.push(`${relative(root, file)}: link inexistente: ${href}`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  Deno.exit(1);
}
console.log(`Documentação: ${files.length} arquivos; ${links} links locais válidos.`);
