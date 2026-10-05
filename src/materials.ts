import { Buffer } from "node:buffer";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import type { ConnectionService } from "./connections.ts";
import type { MoodleRecord } from "./adapters/moodle.ts";

function locate(value: unknown, fileId: string, parent?: MoodleRecord): MoodleRecord | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = locate(child, fileId, parent);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const row = value as MoodleRecord;
  if (row.file_id === fileId) return parent ?? row;
  const module = typeof row.modname === "string" ? row : parent;
  for (const child of Object.values(row)) {
    const found = locate(child, fileId, module);
    if (found) return found;
  }
  return null;
}

/** A file locator comes only from a fresh authorized course response, never an arbitrary URL. */
export class Materials {
  constructor(private hub: Hub, private connections: ConnectionService) {}
  async preserveMoodle(p: Principal, connectionId: string, courseId: number, fileId: string) {
    const moodle = await this.connections.moodle(p, connectionId);
    const contents = await moodle.getCourseContents(courseId);
    if (!contents.data) {
      throw new HubError(
        "source_unavailable",
        "Não foi possível conferir o material no curso.",
        409,
      );
    }
    const ref = moodle.getRegisteredFile(fileId), module = locate(contents.data, fileId);
    if (!ref || !module) {
      throw new HubError("not_found", "Material não encontrado na cobertura deste curso.", 404);
    }
    const downloaded = await moodle.downloadFile(fileId);
    if (!downloaded.data) {
      return {
        source_refresh: { coverage: downloaded.coverage, error_code: downloaded.error_code },
        memory_commit: null,
      };
    }
    const binary = downloaded.data;
    const entity = await this.hub.entity(p, connectionId, "resource", fileId, ref.filename, {
      course_id: courseId,
      module_id: module.id ?? null,
      source_locator: ref.url,
      source_coverage: contents.coverage,
    });
    // Decode/extraction limits are explicit; preserving the bytes does not prove a PDF was read.
    const textual = binary.text !== undefined;
    const extraction = {
      method: textual ? "moodle_adapter_text" : "none",
      text_available: textual,
      complete: false,
      limits: textual
        ? ["Texto simples com limite do adaptador; layout, fórmulas e imagens não interpretados."]
        : ["Binário preservado; extração por página ainda não disponível."],
      source_coverage: downloaded.coverage,
    };
    const file = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${p.ownerId},${entity.id},${binary.filename},${binary.mimetype},${binary.sha256},${binary.byte_length},${
          Buffer.from(binary.bytes)
        },${binary.text ?? null},${
          tx.json(extraction)
        }) on conflict(owner_id,entity_id,sha256) do update set name=excluded.name returning id,entity_id,sha256,bytes,mime_type,extraction`)[
          0
        ],
    );
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${p.ownerId},${entity.id},${
        tx.json({ file_id: file.id, sha256: binary.sha256, bytes: binary.byte_length })
      },${binary.sha256},${
        tx.json({
          system: "moodle",
          connection_id: connectionId,
          course_id: courseId,
          locator: ref.url,
          observed_at: downloaded.observed_at,
        })
      },${downloaded.coverage},${downloaded.observed_at}) on conflict(owner_id,entity_id,content_hash) do nothing`;
    });
    return {
      memory_commit: file,
      source_refresh: { coverage: downloaded.coverage, observed_at: downloaded.observed_at },
      content_is_untrusted_data: true,
    };
  }
}
