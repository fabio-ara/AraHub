import { asOwner, type Db } from "./db.ts";
import { HubError, type Principal } from "./contracts.ts";
import { z } from "zod";

export const LIBRARY_PART_BYTES = 1024 * 1024;
export const LIBRARY_MAX_BYTES = 128 * 1024 * 1024;
export const libraryPartSchema = z.object({
  file_id: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().min(0).max(LIBRARY_MAX_BYTES - 1),
}).strict();

/** Read-only access to preserved originals for the personal web session. */
export class Library {
  constructor(private db: Db) {}

  private personal(p: Principal) {
    if (p.clientId) throw new HubError("client_denied", "Use sua sessão pessoal.", 403);
  }

  async list(p: Principal, after?: string) {
    this.personal(p);
    const rows = await asOwner(this.db, p, (tx) =>
      tx`
      select f.id,f.name,f.mime_type,f.sha256,f.bytes,
        e.title as source_title,c.label as source,
        (f.bytes between 1 and ${LIBRARY_MAX_BYTES}
          and octet_length(f.binary_content)=f.bytes) as available
      from public.hub_files f
      join public.hub_entities e on e.owner_id=f.owner_id and e.id=f.entity_id
      join public.hub_connections c on c.owner_id=e.owner_id and c.id=e.connection_id
      where f.owner_id=${p.ownerId} and f.binary_content is not null
        and (${after ?? null}::uuid is null or f.id>${after ?? null}::uuid)
      order by f.id limit 21`);
    return {
      files: rows.slice(0, 20).map((r) => ({
        id: String(r.id),
        name: String(r.name),
        mime_type: String(r.mime_type),
        sha256: String(r.sha256),
        bytes: Number(r.bytes),
        source: String(r.source),
        source_title: String(r.source_title),
        available: r.available === true,
      })),
      next_id: rows.length > 20 ? rows[19].id : null,
    };
  }

  async part(p: Principal, input: z.infer<typeof libraryPartSchema>) {
    this.personal(p);
    const { file_id, sha256, offset } = libraryPartSchema.parse(input);
    const [row] = await asOwner(this.db, p, (tx) =>
      tx`
      select substring(binary_content from ${offset + 1} for ${LIBRARY_PART_BYTES}) as chunk,
        bytes,octet_length(binary_content) as stored_bytes,
        case when ${offset}=0 then encode(extensions.digest(binary_content,'sha256'),'hex')
          else sha256 end as actual_hash
      from public.hub_files where owner_id=${p.ownerId} and id=${file_id} and sha256=${sha256}`);
    if (!row) {
      throw new HubError("not_found", "Material não encontrado. Atualize a biblioteca.", 404);
    }
    const size = Number(row.bytes);
    if (
      size < 1 || size > LIBRARY_MAX_BYTES || size !== row.stored_bytes ||
      row.actual_hash !== sha256
    ) {
      throw new HubError("material_unavailable", "O arquivo preservado não está disponível.", 409);
    }
    if (offset % LIBRARY_PART_BYTES !== 0 || offset >= size) {
      throw new HubError("invalid_range", "Parte do arquivo inválida.", 416);
    }
    if (row.chunk?.length !== Math.min(LIBRARY_PART_BYTES, size - offset)) {
      throw new HubError("material_unavailable", "Arquivo incompleto.", 409);
    }
    return new Uint8Array(row.chunk);
  }
}
