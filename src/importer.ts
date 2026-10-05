import { Buffer } from "node:buffer";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { type Delta, type Principal } from "./contracts.ts";
import {
  analyzeText,
  casPath,
  loadCuration,
  readJson,
  sha256Hex,
  type StagingManifest,
  verifyStaging,
} from "./migration.ts";

export async function stableUuid(key: string): Promise<string> {
  const h = await sha256Hex(new TextEncoder().encode(key));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${
    h.slice(20, 32)
  }`;
}

export async function importStaging(hub: Hub, actor: Principal, path: string) {
  const verified = await verifyStaging(path);
  if (!verified.ok) throw new Error("Staging inválido; importação recusada.");
  const manifest = await readJson<StagingManifest>(`${path}/manifest.json`);
  const connectionId = await stableUuid(`${actor.ownerId}:migration:${manifest.sourceLabel}`);
  await asOwner(hub.db, actor, async (tx) => {
    await tx`insert into public.hub_connections(id,owner_id,provider,label,provider_subject,state,capabilities) values(${connectionId},${actor.ownerId},'migration','Memória importada',${manifest.sourceLabel},'connected',${
      tx.json({ batch: manifest.batchId, commit: manifest.commit, source_read_only: true })
    }) on conflict(id) do update set capabilities=excluded.capabilities`;
  });
  const documentMap = new Map<string, string>();
  let files = 0, records = 0, reused = 0;
  for (const file of manifest.files) {
    if (!file.casKey) continue;
    const bytes = await Deno.readFile(casPath(`${path}/cas`, file.casKey));
    const expected = file.exportedSha256 ?? file.sha256;
    if (await sha256Hex(bytes) !== expected) throw new Error("Objeto alterado após verificação.");
    const text = analyzeText(bytes);
    const entity = await hub.entity(
      actor,
      connectionId,
      "source_document",
      `${manifest.commit}:${file.path}`,
      file.path,
      {
        source_commit: manifest.commit,
        original_hash: file.sha256,
        representation: file.kind,
        classification: file.path.endsWith("AGENTS.md")
          ? "source_policy_not_authority"
          : "source_document",
      },
    );
    documentMap.set(file.path, entity.id);
    await asOwner(hub.db, actor, async (tx) => {
      await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${actor.ownerId},${entity.id},${file.path},${
        file.kind === "text" ? "text/plain" : "application/octet-stream"
      },${expected},${bytes.length},${Buffer.from(bytes)},${text.text ?? null},${
        tx.json({
          encoding: file.encoding,
          lines: file.lines,
          source_commit: manifest.commit,
          redacted: file.redacted ?? false,
          external_link_targets_read: false,
        })
      }) on conflict(owner_id,entity_id,sha256) do nothing`;
    });
    files++;
  }
  for (const payload of await loadCuration(path)) {
    if (payload.batchId !== manifest.batchId || payload.commit !== manifest.commit) {
      throw new Error("Curadoria de lote divergente.");
    }
    for (const record of payload.records) {
      const contextId = await stableUuid(
        `${actor.ownerId}:${manifest.sourceLabel}:${record.domain}`,
      );
      await asOwner(hub.db, actor, async (tx) => {
        await tx`insert into public.hub_contexts(id,owner_id,title,scope) values(${contextId},${actor.ownerId},${record.domain},${
          tx.json({ domain: record.domain, source: "migration" })
        }) on conflict(id) do nothing`;
      });
      const idempotencyKey = `${manifest.batchId}:${record.id}`;
      const prior = await asOwner(
        hub.db,
        actor,
        async (tx) =>
          await tx`select id,version from public.hub_deltas where owner_id=${actor.ownerId} and idempotency_key=${idempotencyKey}`,
      );
      if (prior.length) reused++;
      const context = await hub.context(actor, contextId);
      const kind: Delta["kind"] = record.kind === "preference"
        ? "preference"
        : record.kind === "version"
        ? "artifact"
        : record.kind === "argument"
        ? "decision"
        : "experience";
      const evidence: Delta["evidence_kind"] = record.epistemic === "reported"
        ? "user_report"
        : record.epistemic === "observed"
        ? "observed"
        : record.epistemic === "inferred"
        ? "interpretation"
        : "hypothesis";
      await hub.recordDelta(actor, {
        context_id: contextId,
        idempotency_key: idempotencyKey,
        kind,
        content: record.assertion,
        evidence_kind: evidence,
        expected_version: prior.length ? prior[0].version - 1 : context.contexts[0].version,
        scope: record.scope ?? {},
        provenance: record.refs.map((ref) => ({
          system: "migration",
          locator: `${ref.path}:${ref.lines}`,
          version: ref.commit,
          excerpt: ref.excerpt,
          original_date: record.date
            ? `${record.date.value} (${record.date.precision})`
            : undefined,
        })),
      });
      const memoryEntity = await hub.entity(
        actor,
        connectionId,
        "memory_record",
        `${manifest.batchId}:${record.id}`,
        record.id,
        {
          epistemic: record.epistemic,
          date: record.date ?? null,
          versions: record.versions ?? [],
          domain: record.domain,
        },
      );
      for (const ref of record.refs) {
        const target = documentMap.get(ref.path);
        if (!target) throw new Error("Referência de curadoria sem documento.");
        await asOwner(hub.db, actor, async (tx) => {
          await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${actor.ownerId},${memoryEntity.id},${target},'derived_from',${
            tx.json({ ...ref })
          }) on conflict do nothing`;
        });
      }
      if (!prior.length) records++;
    }
  }
  return { batch: manifest.batchId, files, records, reused, connectionId };
}
