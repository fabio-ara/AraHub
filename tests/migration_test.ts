/**
 * Testes sintéticos públicos da etapa de migração (A25 e A27).
 *
 * Nenhum dado pessoal: a origem é um repositório sintético montado em memória
 * e injetado pela porta `GitPort`. Os testes cobrem inventário reproduzível,
 * idempotência, retomada, verificação, mudança de origem, exportação com
 * exclusão de tokens e restauração de bytes brutos.
 */
import {
  casPath,
  type CurationPayload,
  dirname,
  exportStaging,
  findLineRange,
  gitBlobId,
  type GitPort,
  type GitTreeEntry,
  hashManifest,
  isBatchId,
  isSafeRelativePath,
  isSecretPath,
  isSha256Hex,
  joinPath,
  loadCuration,
  loadInventory,
  MigrationError,
  progressPath,
  redactSecrets,
  restoreStaging,
  sha256Hex,
  stageRepository,
  validateCurationRecord,
  verifyOrigin,
  verifyStaging,
  writeCuration,
} from "../src/migration.ts";

// Asserções locais: evitam dependência externa nova (imports permanecem os do deno.json).
function assert(condition: unknown, message = "asserção falhou"): asserts condition {
  if (!condition) throw new Error(message);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function assertEquals<T>(actual: T, expected: T, message = "valores diferentes"): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

function assertNotEquals<T>(actual: T, expected: T, message = "valores iguais"): void {
  if (deepEqual(actual, expected)) throw new Error(`${message}: ${JSON.stringify(actual)}`);
}

function assertFalse(condition: unknown, message = "esperava falso"): void {
  if (condition) throw new Error(message);
}

function assertStringIncludes(actual: string, expected: string, message = "trecho ausente"): void {
  if (!actual.includes(expected)) throw new Error(`${message}: ${expected}`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function fakeGit(
  files: Record<string, string | Uint8Array>,
  meta: { commit?: string; branch?: string; clean?: boolean } = {},
): Promise<GitPort> {
  const blobs = new Map<string, Uint8Array>();
  const entries: GitTreeEntry[] = [];
  for (const [path, value] of Object.entries(files)) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    const sha = await gitBlobId(bytes);
    blobs.set(sha, bytes);
    entries.push({ path, mode: "100644", type: "blob", sha, size: bytes.length });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    head: () =>
      Promise.resolve({ commit: meta.commit ?? "a".repeat(40), branch: meta.branch ?? "main" }),
    tree: () => Promise.resolve(entries),
    blob: (_source, sha) => {
      const bytes = blobs.get(sha);
      if (!bytes) return Promise.reject(new Error(`blob ausente ${sha}`));
      return Promise.resolve(bytes);
    },
    isClean: () => Promise.resolve(meta.clean ?? true),
  };
}

async function withTempDir(name: string, run: (dir: string) => Promise<void>): Promise<void> {
  const base = joinPath(Deno.cwd(), ".private", "migration", "test", name, crypto.randomUUID());
  await Deno.mkdir(base, { recursive: true });
  try {
    await run(base);
  } finally {
    await Deno.remove(joinPath(Deno.cwd(), ".private", "migration", "test", name), {
      recursive: true,
    });
  }
}

const syntheticFiles: Record<string, string | Uint8Array> = {
  "nota.md": "# Título\n\nVer https://exemplo.org/a e https://exemplo.org/a .\nFim.\n",
  "dados.json": '{\n  "ok": true\n}\n',
  "crlf.txt": "linha um\r\nlinha dois\r\n",
  "vazio.md": "",
  "bin/objeto.bin": new Uint8Array([0, 1, 2, 3, 0, 255, 254, 10]),
};

Deno.test("inventário registra hash, tamanho, codificação, linhas e links", async () => {
  const git = await fakeGit(syntheticFiles, { commit: "b".repeat(40) });
  const inventory = await loadInventory("origem-fake", { git, sourceLabel: "sintetico" });

  assertEquals(inventory.totals.files, 5);
  assertEquals(inventory.totals.binary, 1);
  assertEquals(inventory.totals.text, 4);
  assertEquals(inventory.commit, "b".repeat(40));
  assertEquals(inventory.branch, "main");

  const paths = inventory.entries.map((entry) => entry.path);
  assertEquals(paths, [...paths].sort());

  const nota = inventory.entries.find((entry) => entry.path === "nota.md")!;
  assertEquals(nota.kind, "text");
  assertEquals(nota.encoding, "utf-8");
  assertEquals(nota.eol, "lf");
  assertEquals(nota.lines, 4);
  assertEquals(nota.links.length, 1);
  assertEquals(nota.links[0].count, 2);
  assertEquals(nota.sha256, await sha256Hex(encoder.encode(syntheticFiles["nota.md"] as string)));
  assertEquals(nota.casKey, nota.sha256);
  assertEquals(
    nota.gitBlobSha,
    await gitBlobId(encoder.encode(syntheticFiles["nota.md"] as string)),
  );

  const crlf = inventory.entries.find((entry) => entry.path === "crlf.txt")!;
  assertEquals(crlf.eol, "crlf");
  assertEquals(crlf.lines, 2);

  const bin = inventory.entries.find((entry) => entry.path === "bin/objeto.bin")!;
  assertEquals(bin.kind, "binary");
  assertEquals(bin.lines, null);
  assertEquals(bin.bytes, 8);

  const again = await loadInventory("origem-fake", { git });
  assertEquals(again.batchId, inventory.batchId, "mesma árvore deve produzir o mesmo lote");
});

Deno.test("staging é idempotente, retomável e verificável (A25)", async () => {
  await withTempDir("stage", async (root) => {
    const git = await fakeGit(syntheticFiles, { commit: "c".repeat(40) });
    const dest = joinPath(root, "staging");

    const first = await stageRepository("origem-fake", dest, { git, sourceLabel: "sintetico" });
    assertEquals(first.added, 5);
    assertEquals(first.reused, 0);

    const second = await stageRepository("origem-fake", dest, { git, sourceLabel: "sintetico" });
    assertEquals(second.batchId, first.batchId);
    assertEquals(second.added, 0, "reexecução não deve duplicar objetos");
    assertEquals(second.reused, 5);

    let verify = await verifyStaging(dest);
    assert(verify.ok);
    assertEquals(verify.checked, 5);

    // Remove um objeto e o progresso para simular interrupção e retomada.
    const nota = await sha256Hex(encoder.encode(syntheticFiles["nota.md"] as string));
    await Deno.remove(casPath(joinPath(dest, "cas"), nota));
    await Deno.remove(joinPath(dest, "state", `${first.batchId}.progress.json`));

    const resumed = await stageRepository("origem-fake", dest, { git, sourceLabel: "sintetico" });
    assertEquals(resumed.batchId, first.batchId);
    assertEquals(resumed.added, 1, "apenas o objeto removido deve ser reescrito");
    verify = await verifyStaging(dest);
    assert(verify.ok);

    // Corrupção é detectada.
    const target = casPath(joinPath(dest, "cas"), nota);
    await Deno.writeFile(target, encoder.encode("corrompido"));
    const broken = await verifyStaging(dest);
    assertFalse(broken.ok);
    assertEquals(broken.corrupted, 1);
  });
});

Deno.test("verificação de origem sinaliza avanço do commit", async () => {
  await withTempDir("origin", async (root) => {
    const original = await fakeGit(syntheticFiles, { commit: "d".repeat(40) });
    const dest = joinPath(root, "staging");
    await stageRepository("origem-fake", dest, { git: original });

    const same = await verifyOrigin(dest, "origem-fake", { git: original });
    assertFalse(same.changed);

    const moved = await fakeGit(syntheticFiles, { commit: "e".repeat(40) });
    const changed = await verifyOrigin(dest, "origem-fake", { git: moved });
    assert(changed.changed);
    assertEquals(changed.currentCommit, "e".repeat(40));
    assertNotEquals(changed.recordedCommit, changed.currentCommit);
  });
});

Deno.test("exportação exclui tokens, redige valores e restaura bytes brutos (A27)", async () => {
  await withTempDir("export", async (root) => {
    const segredo = "sk-abcdefghijklmnopqrstuvwx";
    const files: Record<string, string | Uint8Array> = {
      ...syntheticFiles,
      "config/token.txt": `token = "${segredo}"\n`,
      "credenciais/.env": `SEGREDO=${segredo}\n`,
    };
    const git = await fakeGit(files, { commit: "f".repeat(40) });
    const dest = joinPath(root, "staging");
    const exported = joinPath(root, "export");
    const restored = joinPath(root, "restored");

    await stageRepository("origem-fake", dest, { git, sourceLabel: "sintetico" });
    const result = await exportStaging(dest, exported);
    assert(result.excluded >= 1, "arquivo com nome sensível deve ser excluído");
    assert(result.redactedFiles >= 1);
    assert(result.redactions >= 1);

    const exportManifest = JSON.parse(await Deno.readTextFile(joinPath(exported, "manifest.json")));
    assertFalse(
      exportManifest.files.some((file: { path: string }) => file.path === "credenciais/.env"),
    );

    const tokenKey = await sha256Hex(encoder.encode(files["config/token.txt"] as string));
    const tokenBytes = await Deno.readFile(casPath(joinPath(exported, "cas"), tokenKey));
    const tokenText = decoder.decode(tokenBytes);
    assertStringIncludes(tokenText, "[REDACTED]");
    assertFalse(tokenText.includes(segredo), "o token não pode aparecer no export");

    const restore = await restoreStaging(exported, restored);
    assert(restore.verify.ok);

    // Documentos brutos continuam recuperáveis byte a byte.
    const originalNota = encoder.encode(files["nota.md"] as string);
    const restoredNota = await Deno.readFile(
      casPath(joinPath(restored, "cas"), await sha256Hex(originalNota)),
    );
    assertEquals(decoder.decode(restoredNota), files["nota.md"] as string);
  });
});

Deno.test("curadoria exige referências e gera relações no manifesto", async () => {
  await withTempDir("curation", async (root) => {
    const git = await fakeGit(syntheticFiles, { commit: "1".repeat(40) });
    const dest = joinPath(root, "staging");
    const inventory = await loadInventory("origem-fake", { git });

    const payload: CurationPayload = {
      schema: "arahub.migration.v1",
      batchId: inventory.batchId,
      commit: inventory.commit,
      generatedAtUtc: new Date().toISOString(),
      records: [
        {
          id: "cur:exemplo",
          domain: "teste",
          kind: "fact",
          epistemic: "observed",
          assertion: "O arquivo nota.md tem um título.",
          refs: [{ path: "nota.md", commit: inventory.commit, lines: "1", excerpt: "# Título" }],
        },
      ],
    };

    assertEquals(
      validateCurationRecord({ ...payload.records[0], refs: [] }).length,
      1,
      "registro sem referências deve ser inválido",
    );

    await writeCuration(dest, payload);
    await stageRepository("origem-fake", dest, { git });
    const manifest = JSON.parse(await Deno.readTextFile(joinPath(dest, "manifest.json")));
    assert(manifest.curationIds.includes("cur:exemplo"));
    assert(manifest.relations.some((relation: { to: string }) => relation.to === "nota.md"));
    const loaded = await loadCuration(dest);
    assertEquals(loaded.length, 1);

    const verify = await verifyStaging(dest);
    assert(verify.relationsOk);
  });
});

Deno.test("utilitários de localização e redação", () => {
  const text = "linha 1\nlinha 2\nlinha 3\n";
  assertEquals(findLineRange(text, "linha 2"), { start: 2, end: 2 });
  assertEquals(findLineRange(text, "inexistente"), null);

  assert(isSecretPath("a/.env"));
  assert(isSecretPath("chave.pem"));
  assertFalse(isSecretPath("notas.md"));

  const redacted = redactSecrets('api_key = "abcdefghijklmnop123456"\nfim');
  assert(redacted.hits >= 1);
  assertStringIncludes(redacted.text, "[REDACTED]");
});

Deno.test("validação rejeita chaves, lotes e caminhos inseguros", () => {
  assert(isSha256Hex("a".repeat(64)));
  assertFalse(isSha256Hex("a".repeat(63)));
  assertFalse(isSha256Hex(`../${"a".repeat(60)}`));
  assertFalse(isSha256Hex("A".repeat(64)), "hash deve ser minúsculo");
  assert(isBatchId("b".repeat(32)));
  assertFalse(isBatchId("b".repeat(31)));

  assert(isSafeRelativePath(".github/workflows/verificar.yml"));
  assertFalse(isSafeRelativePath("../etc/passwd"));
  assertFalse(isSafeRelativePath("a/../b"));
  assertFalse(isSafeRelativePath("/abs"));
  assertFalse(isSafeRelativePath("C:/x"));
  assertFalse(isSafeRelativePath("a\\b"));
  assertFalse(isSafeRelativePath("a//b"));

  let threw = false;
  try {
    casPath("cas", "../escape");
  } catch (error) {
    threw = error instanceof MigrationError;
  }
  assert(threw, "casPath deve rejeitar chave com traversal");

  threw = false;
  try {
    progressPath("dest", "../../escape");
  } catch (error) {
    threw = error instanceof MigrationError;
  }
  assert(threw, "progressPath deve rejeitar batchId com traversal");
});

Deno.test("verifyStaging rejeita manifesto adulterado antes de tocar o CAS", async () => {
  await withTempDir("tamper", async (root) => {
    const git = await fakeGit(syntheticFiles, { commit: "2".repeat(40) });
    const dest = joinPath(root, "staging");
    await stageRepository("origem-fake", dest, { git });

    const manifestPath = joinPath(dest, "manifest.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.files[0].path = "../escape.md";
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

    let threw = false;
    try {
      await verifyStaging(dest);
    } catch (error) {
      threw = error instanceof MigrationError;
    }
    assert(threw, "path de traversal no manifesto deve ser rejeitado");
  });
});

Deno.test("restore recusa export adulterado sem escrever manifesto", async () => {
  await withTempDir("tamperexport", async (root) => {
    const git = await fakeGit(syntheticFiles, { commit: "3".repeat(40) });
    const staging = joinPath(root, "staging");
    const exported = joinPath(root, "export");
    await stageRepository("origem-fake", staging, { git });
    await exportStaging(staging, exported);

    const key = await sha256Hex(encoder.encode(syntheticFiles["nota.md"] as string));
    await Deno.writeFile(casPath(joinPath(exported, "cas"), key), encoder.encode("adulterado"));

    const target = joinPath(root, "restored-a");
    let threw = false;
    try {
      await restoreStaging(exported, target);
    } catch (error) {
      threw = error instanceof MigrationError;
    }
    assert(threw, "objeto adulterado no export deve impedir o restore");
    let wroteManifest = true;
    try {
      await Deno.stat(joinPath(target, "manifest.json"));
    } catch {
      wroteManifest = false;
    }
    assertFalse(wroteManifest, "nenhum manifesto deve ser escrito após falha de integridade");

    const exportManifestPath = joinPath(exported, "manifest.json");
    const exportManifest = JSON.parse(await Deno.readTextFile(exportManifestPath));
    exportManifest.manifestHash = "0".repeat(64);
    await Deno.writeTextFile(exportManifestPath, JSON.stringify(exportManifest));
    threw = false;
    try {
      await restoreStaging(exported, joinPath(root, "restored-b"));
    } catch (error) {
      threw = error instanceof MigrationError;
    }
    assert(threw, "manifestHash inválido deve impedir o restore");
  });
});

Deno.test("restore não sobrescreve destino com outro lote", async () => {
  await withTempDir("occupied", async (root) => {
    const gitA = await fakeGit(syntheticFiles, { commit: "4".repeat(40) });
    const gitB = await fakeGit({ "outro.md": "# outro\n" }, { commit: "5".repeat(40) });
    const dest = joinPath(root, "dest");

    const stagingA = joinPath(root, "stageA");
    const exportA = joinPath(root, "expA");
    await stageRepository("origem-fake", stagingA, { git: gitA });
    await exportStaging(stagingA, exportA);
    await restoreStaging(exportA, dest);

    const stagingB = joinPath(root, "stageB");
    const exportB = joinPath(root, "expB");
    await stageRepository("origem-fake", stagingB, { git: gitB });
    await exportStaging(stagingB, exportB);

    let threw = false;
    try {
      await restoreStaging(exportB, dest);
    } catch (error) {
      threw = error instanceof MigrationError;
    }
    assert(threw, "restore deve recusar um destino ocupado por outro lote");

    const kept = JSON.parse(await Deno.readTextFile(joinPath(dest, "manifest.json")));
    assertEquals(kept.batchId, (await loadInventory("origem-fake", { git: gitA })).batchId);
  });
});

Deno.test("verify ignora CAS de outro lote e acusa blob_mismatch", async () => {
  await withTempDir("verifyextra", async (root) => {
    const git = await fakeGit(syntheticFiles, { commit: "6".repeat(40) });
    const dest = joinPath(root, "staging");
    await stageRepository("origem-fake", dest, { git });

    const orphan = "b".repeat(64);
    await Deno.mkdir(joinPath(dest, "cas", orphan.slice(0, 2)), { recursive: true });
    await Deno.writeFile(joinPath(dest, "cas", orphan.slice(0, 2), orphan), encoder.encode("x"));
    let result = await verifyStaging(dest);
    assertEquals(result.extra, 1);
    assert(result.ok, "objeto de outro lote não deve invalidar o lote atual");

    const manifestPath = joinPath(dest, "manifest.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    const nota = manifest.files.find((file: { path: string }) => file.path === "nota.md");
    nota.gitBlobSha = "f".repeat(40);
    const { manifestHash: _drop, ...rest } = manifest;
    manifest.manifestHash = await hashManifest(rest);
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

    result = await verifyStaging(dest);
    assertEquals(result.blobMismatch, 1);
    assertFalse(result.ok, "blob_mismatch deve invalidar a verificação");
  });
});

Deno.test("restore repara objeto corrompido e confere a origem quando informada", async () => {
  await withTempDir("repair", async (root) => {
    const git = await fakeGit(syntheticFiles, { commit: "7".repeat(40) });
    const staging = joinPath(root, "staging");
    const exported = joinPath(root, "export");
    const dest = joinPath(root, "dest");
    await stageRepository("origem-fake", staging, { git });
    await exportStaging(staging, exported);

    const key = await sha256Hex(encoder.encode(syntheticFiles["nota.md"] as string));
    const objectPath = casPath(joinPath(dest, "cas"), key);
    await Deno.mkdir(dirname(objectPath), { recursive: true });
    await Deno.writeFile(objectPath, encoder.encode("parcial"));

    const repaired = await restoreStaging(exported, dest);
    assert(repaired.verify.ok, "destino deve ficar íntegro após reparo");
    assert(repaired.repaired >= 1, "objeto corrompido deve ser reparado");

    const moved = await fakeGit(syntheticFiles, { commit: "8".repeat(40) });
    let threw = false;
    try {
      await restoreStaging(exported, joinPath(root, "dest-moved"), {
        source: "origem-fake",
        git: moved,
      });
    } catch (error) {
      threw = error instanceof MigrationError;
    }
    assert(threw, "origem avançada deve impedir o restore");

    const ok = await restoreStaging(exported, joinPath(root, "dest-ok"), {
      source: "origem-fake",
      git,
    });
    assert(ok.verify.ok);
  });
});
