import { Buffer } from "node:buffer";
import { z } from "zod";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import type { GoogleConnections } from "./google_connections.ts";
import { GoogleReads } from "./google_reads.ts";
import { sha256Hex } from "./migration.ts";

export const nativeMaterialSchema = z.object({
  kind: z.enum(["document", "spreadsheet", "presentation"]),
  resource_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  ranges: z.array(z.string().min(1).max(300)).min(1).max(30).optional(),
}).strict();
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PART_BYTES = 128 * 1024;
const idField = {
  document: "documentId",
  spreadsheet: "spreadsheetId",
  presentation: "presentationId",
};

/** A derived native JSON snapshot, not an original binary or proof of reading/submission. */
export class GoogleMaterials {
  constructor(private hub: Hub, private google?: GoogleConnections) {}
  async preserve(p: Principal, connectionId: string, raw: z.infer<typeof nativeMaterialSchema>) {
    const input = nativeMaterialSchema.parse(raw);
    if (input.ranges && input.kind !== "spreadsheet") {
      throw new HubError("invalid_ranges", "Faixas são exclusivas de planilhas.", 400);
    }
    if (!this.google) {
      throw new HubError(
        "connection_unavailable",
        "Conecte a conta para preservar uma observação nova.",
        409,
      );
    }
    const [before] = await asOwner(
      this.hub.db,
      p,
      (tx) =>
        tx`select oauth_epoch from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId} and provider='google'`,
    );
    if (!before) throw new HubError("not_found", "Conexão não encontrada.", 404);
    const observation = await new GoogleReads(this.hub, this.google).read(p, connectionId, input);
    const native = observation.result as Record<string, unknown>;
    if (!native || native[idField[input.kind]] !== input.resource_id) {
      throw new HubError(
        "target_mismatch",
        "A fonte retornada não corresponde ao recurso escolhido.",
        409,
      );
    }
    // Bind coverage/selection into the hash: equal cell values observed through
    // different ranges must not silently reuse another selection's provenance.
    const text = JSON.stringify({
        format: "arahub.google.native.v1",
        kind: input.kind,
        resource_id: input.resource_id,
        ranges: input.ranges ?? null,
        native,
      }),
      bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_SNAPSHOT_BYTES) {
      throw new HubError(
        "material_too_large",
        "O snapshot excede 8 MiB; selecione faixas menores quando disponíveis. Nada foi truncado ou preservado.",
        413,
      );
    }
    const hash = await sha256Hex(bytes);
    const coverage = input.ranges ? "partial" : "complete";
    const provenance = {
      system: "google",
      connection_id: connectionId,
      resource_id: input.resource_id,
      native_kind: input.kind,
      revision: typeof native.revisionId === "string" ? native.revisionId : null,
      ranges: input.ranges ?? null,
      observed_at: observation.observed_at,
    };
    const extraction = {
      method: "google_native_json",
      native_kind: input.kind,
      coverage,
      selection: input.ranges ?? null,
      observed_at: observation.observed_at,
      provenance,
      images_not_interpreted: true,
      note:
        "JSON nativo observado, com estrutura/valores/fórmulas; não é o binário original, extração de prosa ou confirmação de leitura/entrega. Faixas selecionadas não cobrem a planilha inteira.",
    };
    const name =
      (typeof native.title === "string"
        ? native.title
        : typeof (native.properties as { title?: unknown })?.title === "string"
        ? (native.properties as { title: string }).title
        : input.resource_id).slice(0, 300);
    const file = await asOwner(this.hub.db, p, async (tx) => {
      const [current] =
        await tx`select state,oauth_epoch from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId} and provider='google'`;
      if (!current || current.state !== "connected" || current.oauth_epoch !== before.oauth_epoch) {
        throw new HubError(
          "connection_changed",
          "A conexão mudou durante a leitura. O snapshot não foi gravado.",
          409,
        );
      }
      const [entity] =
        await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${p.ownerId},${connectionId},${
          "google_native_" + input.kind
        },${input.resource_id},${name},${
          tx.json({ native_kind: input.kind, resource_id: input.resource_id })
        }) on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title returning id`;
      const [saved] =
        await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${p.ownerId},${entity.id},${name},${"application/json"},${hash},${bytes.length},${
          Buffer.from(bytes)
        },${text},${
          tx.json(extraction)
        }) on conflict(owner_id,entity_id,sha256) do update set name=excluded.name returning id,entity_id,sha256,bytes,extraction`;
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${p.ownerId},${entity.id},${
        tx.json({ file_id: saved.id, sha256: hash, representation: "google_native_json" })
      },${hash},${
        tx.json(provenance)
      },${coverage},${observation.observed_at}) on conflict(owner_id,entity_id,content_hash) do nothing`;
      return saved;
    }, { lockConnection: connectionId });
    return {
      memory_commit: file,
      source_refresh: {
        coverage,
        observed_at: observation.observed_at,
        resource_id: input.resource_id,
      },
      content_is_untrusted_data: true,
    };
  }

  async read(p: Principal, fileId: string, hash: string, pointer = "", offset = 0, limit?: number) {
    if (
      pointer.length > 2000 || (pointer !== "" && !pointer.startsWith("/")) ||
      /~(?![01])/.test(pointer) || !Number.isSafeInteger(offset) || offset < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 16000))
    ) throw new HubError("invalid_locator", "Localizador, offset ou limite inválido.", 400);
    const [file] = await asOwner(
      this.hub.db,
      p,
      (tx) =>
        tx`select name,sha256,binary_content,extraction from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`,
    );
    if (!file) throw new HubError("not_found", "Material não encontrado.", 404);
    if (file.sha256 !== hash) {
      throw new HubError("file_changed", "Escolha o hash da versão preservada.", 409);
    }
    if (file.extraction?.method !== "google_native_json" || !file.binary_content) {
      throw new HubError("invalid_material", "Este arquivo não é um snapshot nativo Google.", 400);
    }
    const bytes = new Uint8Array(file.binary_content);
    if (bytes.length > MAX_SNAPSHOT_BYTES || await sha256Hex(bytes) !== hash) {
      throw new HubError("file_integrity", "Os bytes não correspondem à versão preservada.", 409);
    }
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    if (envelope.format !== "arahub.google.native.v1") {
      throw new HubError("invalid_material", "Formato de snapshot incompatível.", 400);
    }
    let value: unknown = envelope.native;
    for (const encoded of pointer === "" ? [] : pointer.slice(1).split("/")) {
      const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) {
        throw new HubError("invalid_locator", "Índice de array inválido no JSON Pointer.", 400);
      }
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
        throw new HubError("not_found", "Localizador ausente nesta versão.", 404);
      }
      value = (value as Record<string, unknown>)[key];
    }
    let result = value, nextOffset: number | null = null;
    if (Array.isArray(value)) {
      if (offset > value.length) {
        throw new HubError("invalid_offset", "Offset além da sequência.", 400);
      }
      const part = value.slice(offset, offset + Math.min(limit ?? 20, 100));
      while (
        part.length > 1 && new TextEncoder().encode(JSON.stringify(part)).length > MAX_PART_BYTES
      ) part.pop();
      result = part;
      nextOffset = offset + part.length < value.length ? offset + part.length : null;
    } else if (typeof value === "string") {
      if (
        offset > value.length ||
        (offset > 0 && /[\uDC00-\uDFFF]/.test(value[offset] ?? "") &&
          /[\uD800-\uDBFF]/.test(value[offset - 1]))
      ) throw new HubError("invalid_offset", "Offset inválido no texto UTF-16.", 400);
      let end = Math.min(value.length, offset + (limit ?? 8000));
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end++;
      result = value.slice(offset, end);
      nextOffset = end < value.length ? end : null;
    } else if (offset !== 0) {
      throw new HubError("invalid_offset", "Offset aplica-se somente a arrays ou texto.", 400);
    }
    const tooLarge = new TextEncoder().encode(JSON.stringify(result)).length > MAX_PART_BYTES;
    const children = tooLarge && result !== null && typeof result === "object"
      ? Object.keys(result).slice(0, 100).map((key) =>
        Array.isArray(result) ? String(offset + Number(key)) : key
      )
      : [];
    return {
      file_id: fileId,
      sha256: hash,
      name: file.name,
      pointer,
      offset,
      result: tooLarge ? null : result,
      next_offset: tooLarge ? null : nextOffset,
      coverage: tooLarge || nextOffset !== null ? "partial" : "complete",
      snapshot_coverage: file.extraction.coverage,
      provenance: file.extraction.provenance,
      children,
      children_truncated: tooLarge && result !== null && typeof result === "object" &&
        Object.keys(result).length > 100,
      note: tooLarge
        ? "Aprofunde o JSON Pointer pelos filhos; a parte excede 128 KiB. Nenhum conteúdo foi truncado silenciosamente."
        : "Parte da observação preservada, sem consultar a fonte; não prova atualidade, interpretação de imagem ou entrega.",
      content_is_untrusted_data: true,
    };
  }
}
