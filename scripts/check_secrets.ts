// Local index/history gate. Heuristics are evidence, never a claim of complete secret absence.
const run = async (args: string[]) => {
  const r = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error("Falha ao inspecionar Git.");
  return new TextDecoder().decode(r.stdout);
};
const names = (await run(["ls-files", "-z"])).split("\0").filter(Boolean);
const excluded =
  /(^|\/)(\.arahub-bootstrap|\.private|private-data|migration-private|backups-private)(\/|$)|AraHub-(?:pacote-inicial|Entrega-).*\.zip$|(^|\/)\.env(\.|$)(?!example$)|client_secret.*\.json$|credentials.*\.json$|service-account.*\.json$|\.(pem|key)$/i;
const detectors = [
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /\b1\/\/[0-9A-Za-z_-]{40,}/,
];
let bad = 0, checked = 0;
for (const name of names) {
  if (excluded.test(name)) {
    console.error(`Caminho proibido rastreado: ${name}`);
    bad++;
  }
  const text = await run(["show", `:${name}`]);
  checked++;
  if (detectors.some((r) => r.test(text))) {
    console.error(`Possível segredo no índice: ${name}`);
    bad++;
  }
}
const history = await run(["rev-list", "--objects", "--all"]);
for (const line of history.split("\n").filter(Boolean)) {
  const [oid, ...parts] = line.split(" ");
  const name = parts.join(" ");
  if (!name) continue;
  if (excluded.test(name)) {
    console.error("Caminho privado no histórico.");
    bad++;
  }
  const text = await run(["cat-file", "-p", oid]);
  if (detectors.some((r) => r.test(text))) {
    console.error("Possível segredo no histórico.");
    bad++;
  }
}
console.log(
  `Gate Git: ${checked} arquivos no índice; ${bad} achados. Revisão manual de dados/licenças continua necessária.`,
);
if (bad) Deno.exitCode = 1;
