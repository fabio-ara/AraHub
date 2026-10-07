import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { sha256Hex } from "./migration.ts";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PART_BYTES = 128 * 1024;

/**
 * Leitor genérico de materiais JSON preservados, por file_id/hash.
 *
 * Não consulta provedor nenhum: navega o documento já gravado em hub_files por
 * JSON Pointer RFC 6901, com paginação de arrays/texto e listagem de filhos
 * quando a parte excede 128 KiB. Desembrulha apenas envelopes de formato
 * conhecido (arahub.google.native.v1 usa `native`; arahub.material.v1 usa
 * `value`); qualquer outro JSON mantém a raiz intacta. Conteúdo recuperado é
 * dado não confiável: não prova atualidade, interpretação de imagem nem entrega.
 */
export class PreservedMaterials {
  constructor(private hub: Hub) {}

  async read(
    p: Principal,
    fileId: string,
    hash: string,
    pointer = "",
    offset = 0,
    limit?: number,
    childrenOffset = 0,
  ) {
    if (
      pointer.length > 2000 || (pointer !== "" && !pointer.startsWith("/")) ||
      /~(?![01])/.test(pointer) || !Number.isSafeInteger(offset) || offset < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 16000)) ||
      !Number.isSafeInteger(childrenOffset) || childrenOffset < 0
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
    if (!file.binary_content) {
      throw new HubError("invalid_material", "O arquivo não tem conteúdo preservado.", 400);
    }
    const bytes = new Uint8Array(file.binary_content);
    if (bytes.length > MAX_SNAPSHOT_BYTES || await sha256Hex(bytes) !== hash) {
      throw new HubError("file_integrity", "Os bytes não correspondem à versão preservada.", 409);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new HubError("invalid_material", "Este material não é um JSON preservado.", 400);
    }
    let value: unknown = parsed;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      // Só desembrulha formatos conhecidos: um campo `format` arbitrário no
      // documento não deve descartar a raiz JSON.
      if (envelope.format === "arahub.google.native.v1" && Object.hasOwn(envelope, "native")) {
        value = envelope.native;
      } else if (envelope.format === "arahub.material.v1" && Object.hasOwn(envelope, "value")) {
        value = envelope.value;
      }
    }
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
    const childKeys = tooLarge && result !== null && typeof result === "object"
      ? Object.keys(result)
      : [];
    if (childrenOffset > childKeys.length) {
      throw new HubError("invalid_offset", "Offset além dos filhos disponíveis.", 400);
    }
    const children = childKeys.slice(childrenOffset, childrenOffset + 100).map((key) =>
      Array.isArray(result) ? String(offset + Number(key)) : key
    );
    const childrenNextOffset = childrenOffset + children.length < childKeys.length
      ? childrenOffset + children.length
      : null;
    return {
      file_id: fileId,
      sha256: hash,
      name: file.name,
      pointer,
      offset,
      result: tooLarge ? null : result,
      next_offset: tooLarge ? null : nextOffset,
      coverage: tooLarge || nextOffset !== null ? "partial" : "complete",
      snapshot_coverage: file.extraction?.coverage ?? null,
      provenance: file.extraction?.provenance ?? null,
      children,
      children_offset: childrenOffset,
      children_next_offset: childrenNextOffset,
      children_count: childKeys.length,
      children_truncated: childrenNextOffset !== null,
      note: tooLarge
        ? "Aprofunde o JSON Pointer pelos filhos; a parte excede 128 KiB. Nenhum conteúdo foi truncado silenciosamente."
        : "Parte da observação preservada, sem consultar a fonte; não prova atualidade, interpretação de imagem ou entrega.",
      content_is_untrusted_data: true,
    };
  }
}
