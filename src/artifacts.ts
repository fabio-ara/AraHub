import { Buffer } from "node:buffer";
import { z } from "zod";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { isPublicIp } from "./adapters/moodle.ts";
import { sendPinnedHttp } from "./adapters/pinned_http.ts";
import { sha256Hex } from "./migration.ts";
import { inspectOfficeArchive } from "./document_text.ts";

// Host contract: all four properties declared, only the first two required.
export const hostFileSchema = z.object({
  download_url: z.string().url().max(16384),
  file_id: z.string().min(1).max(300),
  mime_type: z.string().max(200).optional(),
  file_name: z.string().max(500).optional(),
}).strict();
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
// Exact origins observed in the native host file contract. Do not allow the
// entire Azure storage suffix: unrelated accounts can use that same suffix.
export const HOST_FILE_DOWNLOAD_HOSTS = [
  "files.oaiusercontent.com",
  "sdmntprbrazilsouth.oaiusercontent.com",
  "oaisdmntprbrazilsouth.blob.core.windows.net",
] as const;
export interface ArtifactFile {
  id: string;
  name: string;
  original_name: string;
  mime: string;
  bytes: number;
  sha256: string;
}
export interface ArtifactTransport {
  hosts: readonly string[];
  resolve?: (host: string) => Promise<readonly string[]>;
  send?: typeof sendPinnedHttp;
}
const fail = (code: string, text: string, status = 422): never => {
  throw new HubError(code, text, status);
};

export function safeArtifactName(name: string, extension: string): string {
  const leaf = name.normalize("NFC").split(/[\\/]/).at(-1) ?? "arquivo";
  let stem = leaf.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/[. ]+$/g, "")
    .replace(/\.[^.]*$/, "").slice(0, 120);
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = "arquivo";
  return `${stem}.${extension}`;
}

/** Detect content, never trust an extension or a caller supplied MIME. */
export async function artifactType(bytes: Uint8Array): Promise<{ mime: string; extension: string }> {
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  if (head.startsWith("%PDF-")) return { mime: "application/pdf", extension: "pdf" };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    const office = await inspectOfficeArchive(bytes, { maxBytes: MAX_ARTIFACT_BYTES });
    if (!office.ok || office.encrypted || office.macro_enabled || office.main_parts.length !== 1) {
      fail("invalid_archive", "Arquivo Office inválido, cifrado ou com macros.");
    }
    if (office.detected === "docx") return {mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",extension:"docx"};
    if (office.detected === "pptx") return {mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",extension:"pptx"};
    fail("unsupported_type", "Somente PDF, DOCX, PPTX e texto UTF-8 são aceitos nesta cadeia.");
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) &&
      !/^\s*(<!doctype|<html|<script|<svg)/i.test(text)
    ) return { mime: "text/plain", extension: "txt" };
  } catch { /* Binary is not text. */ }
  return fail("unsupported_type", "Tipo de arquivo não suportado.");
}

export class Artifacts {
  constructor(
    private hub: Hub,
    private transport: ArtifactTransport = { hosts: HOST_FILE_DOWNLOAD_HOSTS },
  ) {}

  async importHost(p: Principal, connectionId: string, contextId: string, raw: unknown) {
    const file = hostFileSchema.parse(raw);
    // Check owner/target before any download; OAuth credentials never leave this boundary.
    await asOwner(this.hub.db, p, async (tx) => {
      const rows =
        await tx`select c.id from public.hub_connections c,public.hub_contexts x where c.owner_id=${p.ownerId} and c.id=${connectionId} and c.provider='moodle' and x.owner_id=c.owner_id and x.id=${contextId}`;
      if (!rows.length) fail("not_found", "Contexto ou conexão não encontrado.", 404);
    });
    const url = new URL(file.download_url);
    if (
      url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || !this.transport.hosts.includes(url.hostname)
    ) fail("download_denied", "Origem de arquivo não autorizada.", 403);
    const resolve = this.transport.resolve ?? (async (host: string) => {
      const results = await Promise.allSettled([
        Deno.resolveDns(host, "A"),
        Deno.resolveDns(host, "AAAA"),
      ]);
      return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
    });
    let bytes: Uint8Array;
    try {
      const addresses = await resolve(url.hostname);
      if (!addresses.length || addresses.some((x) => !isPublicIp(x))) {
        fail("download_denied", "Origem não pública.", 403);
      }
      const reply = await (this.transport.send ?? sendPinnedHttp)({
        url: url.href,
        address: addresses[0],
        method: "GET",
        headers: { accept: "application/octet-stream" },
        maxBytes: MAX_ARTIFACT_BYTES,
        timeoutMs: 30_000,
      });
      if (reply.status !== 200) {
        fail(
          "download_unavailable",
          "Arquivo expirado ou indisponível; solicite novo acesso ao cliente.",
          409,
        );
      }
      bytes = reply.bytes;
    } catch (e) {
      if (e instanceof HubError) throw e;
      return fail(
        "download_unavailable",
        "Não foi possível obter o arquivo dentro dos limites.",
        409,
      );
    }
    return await this.preserve(p, connectionId, contextId, bytes, {
      id: file.file_id,
      name: file.file_name ?? "arquivo",
      system: "chatgpt_file",
    });
  }

  /** Internal bytes port for a trusted transport; not an MCP base64 argument. */
  async preserve(
    p: Principal,
    connectionId: string,
    contextId: string,
    bytes: Uint8Array,
    source: { id: string; name: string; system: string },
  ) {
    if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) {
      fail("limit_exceeded", "Arquivo vazio ou maior que 16 MiB.", 413);
    }
    const type = await artifactType(bytes),
      hash = await sha256Hex(bytes),
      name = safeArtifactName(source.name, type.extension);
    return await asOwner(this.hub.db, p, async (tx) => {
      const valid =
        await tx`select c.id from public.hub_connections c,public.hub_contexts x where c.owner_id=${p.ownerId} and c.id=${connectionId} and c.provider='moodle' and x.owner_id=c.owner_id and x.id=${contextId}`;
      if (!valid.length) fail("not_found", "Contexto ou conexão não encontrado.", 404);
      const metadata = {
        context_id: contextId,
        source_system: source.system,
        source_id: source.id,
        original_name: source.name,
        destination_name: name,
        sha256: hash,
        observed_at: new Date().toISOString(),
      };
      const entity =
        (await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${p.ownerId},${connectionId},'artifact',${`${contextId}:${source.system}:${source.id}:${hash}`},${name},${
          tx.json(metadata)
        }) on conflict(owner_id,connection_id,kind,external_id) do update set title=excluded.title returning id`)[
          0
        ];
      const stored =
        (await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text,extraction) values(${p.ownerId},${entity.id},${name},${type.mime},${hash},${bytes.length},decode('','hex'),${
          type.extension === "txt" ? new TextDecoder().decode(bytes) : null
        },${
          tx.json({ method: "none", content_is_untrusted_data: true, original_name: source.name })
        }) on conflict(owner_id,entity_id,sha256) do update set name=excluded.name returning id,octet_length(binary_content)::integer as stored_bytes`)[
          0
        ];
      if (Number(stored.stored_bytes) === 0) {
        for (let i = 0; i < bytes.length; i += 512 * 1024) {
          await tx`update public.hub_files set binary_content=binary_content || ${
            Buffer.from(bytes.subarray(i, i + 512 * 1024))
          }::bytea where owner_id=${p.ownerId} and id=${stored.id}`;
        }
      }
      const check =
        (await tx`select encode(extensions.digest(binary_content,'sha256'),'hex') as hash from public.hub_files where owner_id=${p.ownerId} and id=${stored.id}`)[
          0
        ];
      if (check.hash !== hash) {
        fail("artifact_corrupt", "Arquivo preservado diverge dos bytes recebidos.", 409);
      }
      return {
        id: stored.id,
        name,
        original_name: source.name,
        mime: type.mime,
        bytes: bytes.length,
        sha256: hash,
        context_id: contextId,
        source: { system: source.system, file_id: source.id },
        external_write: false,
      };
    });
  }

  async load(
    p: Principal,
    connectionId: string,
    id: string,
  ): Promise<ArtifactFile & { content: Uint8Array }> {
    return await asOwner(this.hub.db, p, async (tx) => {
      const r =
        (await tx`select f.id,f.name,f.mime_type,f.bytes,f.sha256,f.binary_content,e.state from public.hub_files f join public.hub_entities e on e.owner_id=f.owner_id and e.id=f.entity_id where f.owner_id=${p.ownerId} and f.id=${id} and e.connection_id=${connectionId} and e.kind='artifact'`)[
          0
        ];
      if (!r) fail("not_found", "Arquivo não encontrado nesta conexão.", 404);
      const content = new Uint8Array(r.binary_content);
      if (content.length !== Number(r.bytes) || await sha256Hex(content) !== r.sha256) {
        fail("artifact_corrupt", "Verificação do arquivo falhou.", 409);
      }
      return {
        id: r.id,
        name: r.name,
        original_name: r.state.original_name,
        mime: r.mime_type,
        bytes: Number(r.bytes),
        sha256: r.sha256,
        content,
      };
    });
  }
}
