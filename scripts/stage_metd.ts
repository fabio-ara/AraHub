/**
 * AraHub — CLI de staging da migração.
 *
 * Uso (padrão: staging privado, sem imprimir dados pessoais):
 *   deno task migration:stage                     # stage
 *   deno task migration:stage -- verify
 *   deno task migration:stage -- origin
 *   deno task migration:stage -- export --out .private/migration/export
 *   deno task migration:stage -- restore --in .private/migration/export --to .private/migration/restored
 *
 * Flags: --source <dir> --to <dir> --in <dir> --out <dir> --label <nome>
 * A saída é composta apenas por contagens, hashes curtos e estados.
 */
import {
  exportStaging,
  restoreStaging,
  stageRepository,
  verifyOrigin,
  verifyStaging,
} from "../src/migration.ts";

interface Flags {
  readonly command: string;
  readonly source: string;
  readonly to: string;
  readonly input: string;
  readonly out: string;
  readonly label: string;
}

function parseFlags(args: string[]): Flags {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(key, next);
        index += 1;
      } else {
        values.set(key, "true");
      }
    } else {
      positionals.push(arg);
    }
  }
  return {
    command: positionals[0] ?? "stage",
    source: values.get("source") ?? ".private/sources/METD",
    to: values.get("to") ?? values.get("dest") ?? ".private/migration/staging",
    input: values.get("in") ?? values.get("from") ?? ".private/migration/export",
    out: values.get("out") ?? ".private/migration/export",
    label: values.get("label") ?? "source",
  };
}

function report(lines: string[]): void {
  console.log(lines.join("\n"));
}

async function commandStage(flags: Flags): Promise<void> {
  const result = await stageRepository(flags.source, flags.to, { sourceLabel: flags.label });
  report([
    `staging label=${flags.label} batch=${result.batchId.slice(0, 12)}`,
    `files=${result.totals.files} text=${result.totals.text} binary=${result.totals.binary} ` +
    `symlink=${result.totals.symlink} gitlink=${result.totals.gitlink}`,
    `bytes=${result.totals.bytes} lines=${result.totals.lines} links=${result.totals.links}`,
    `cas added=${result.added} reused=${result.reused} resumed=${result.resumed}`,
  ]);
}

async function commandVerify(flags: Flags): Promise<void> {
  const result = await verifyStaging(flags.to);
  report([
    `verify ok=${result.ok} batch=${result.batchId.slice(0, 12)}`,
    `checked=${result.checked} missing=${result.missing} corrupted=${result.corrupted} ` +
    `extra=${result.extra} relations=${result.relationsOk} manifest_hash=${result.manifestHashOk}`,
    `issues=${result.issues.length}`,
  ]);
  if (!result.ok) Deno.exitCode = 1;
}

async function commandOrigin(flags: Flags): Promise<void> {
  const result = await verifyOrigin(flags.to, flags.source);
  report([
    `origin changed=${result.changed} clean=${result.clean}`,
    `recorded=${result.recordedCommit.slice(0, 12)} current=${
      result.currentCommit?.slice(0, 12) ?? "-"
    }`,
    `branch=${result.currentBranch ?? "-"} note=${result.note}`,
  ]);
  if (result.changed) Deno.exitCode = 1;
}

async function commandExport(flags: Flags): Promise<void> {
  const result = await exportStaging(flags.to, flags.out);
  report([
    `export batch=${result.batchId.slice(0, 12)} files=${result.files} bytes=${result.bytes}`,
    `excluded=${result.excluded} redacted_files=${result.redactedFiles} redactions=${result.redactions}`,
    `dir=${result.exportDir}`,
  ]);
}

async function commandRestore(flags: Flags): Promise<void> {
  const result = await restoreStaging(flags.input, flags.to);
  report([
    `restore batch=${result.batchId.slice(0, 12)} files=${result.files} verify=${result.verify.ok}`,
    `missing=${result.verify.missing} corrupted=${result.verify.corrupted} relations=${result.verify.relationsOk}`,
  ]);
  if (!result.verify.ok) Deno.exitCode = 1;
}

async function main(): Promise<void> {
  const flags = parseFlags(Deno.args);
  switch (flags.command) {
    case "stage":
      return await commandStage(flags);
    case "verify":
      return await commandVerify(flags);
    case "origin":
      return await commandOrigin(flags);
    case "export":
      return await commandExport(flags);
    case "restore":
      return await commandRestore(flags);
    default:
      console.error(`comando desconhecido: ${flags.command}`);
      Deno.exitCode = 2;
  }
}

if (import.meta.main) await main();
