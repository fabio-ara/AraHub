import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { asOwner, type Db } from "./db.ts";
import { HubError, type Principal } from "./contracts.ts";

const TTL = 300;
const CHUNK = 1024 * 1024;
const MAX_BYTES = 128 * 1024 * 1024;
const TYPE = "arahub-material-transfer+jwt";
const claimsSchema = z.object({
  sub: z.string().uuid(),
  session: z.string().uuid(),
  client: z.string().min(1).max(256),
  file: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(MAX_BYTES),
  iat: z.number().int(),
  exp: z.number().int(),
});
type Access = {
  sessionActive: (owner: string, session: string) => Promise<boolean>;
  allowedClientIds: readonly string[];
};
function denied(): never {
  throw new HubError("transfer_denied", "Transferência expirada ou não autorizada.", 403);
}
function safeName(name: string) {
  return name.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "").slice(0, 160) || "material.bin";
}

/** One-file, short-lived read capability. Never contains Moodle or account tokens. */
export class MaterialTransfers {
  private key: Uint8Array;
  private base: string;
  constructor(
    private db: Db,
    key: Uint8Array,
    base: string,
    private access: Access,
    private now: () => Date = () => new Date(),
  ) {
    const url = new URL(base);
    if (
      key.length !== 32 || url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    ) throw new Error("Configuração de transferência inválida.");
    this.key = key.slice();
    this.base = url.href.replace(/\/+$/, "");
  }

  static configured(db: Db, base: string, access: Access, secret?: string) {
    if (!secret) return undefined;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
      throw new Error("Chave de transferência inválida.");
    }
    return new MaterialTransfers(
      db,
      Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)),
      base,
      access,
    );
  }

  private async active(p: Principal) {
    if (
      !z.string().uuid().safeParse(p.ownerId).success ||
      !z.string().uuid().safeParse(p.sessionId).success ||
      !p.clientId || !this.access.allowedClientIds.includes(p.clientId) ||
      !await this.access.sessionActive(p.ownerId, p.sessionId!)
    ) denied();
  }

  async prepare(p: Principal, fileId: string, hash: string) {
    await this.active(p);
    if (!z.string().uuid().safeParse(fileId).success || !/^[a-f0-9]{64}$/.test(hash)) denied();
    const [file] = await asOwner(
      this.db,
      p,
      (tx) =>
        tx`select id,name,mime_type,sha256,bytes,octet_length(binary_content)::integer as stored_bytes,
        encode(extensions.digest(binary_content,'sha256'),'hex') as actual_hash
        from public.hub_files where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash}`,
    );
    if (!file) throw new HubError("not_found", "Arquivo não encontrado.", 404);
    const bytes = Number(file.bytes);
    if (
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES ||
      file.stored_bytes !== bytes || file.actual_hash !== hash
    ) {
      throw new HubError(
        "material_unavailable",
        "Binário íntegro indisponível para transferência.",
        409,
      );
    }
    const issued = Math.floor(this.now().getTime() / 1000);
    const transfer = await new SignJWT({
      session: p.sessionId,
      ...(p.clientId ? { client: p.clientId } : {}),
      file: fileId,
      sha256: hash,
      bytes,
    }).setProtectedHeader({ alg: "HS256", typ: TYPE }).setSubject(p.ownerId)
      .setIssuer(this.base).setAudience("arahub-material-transfer")
      .setIssuedAt(issued).setExpirationTime(issued + TTL).sign(this.key);
    return {
      file_id: fileId,
      sha256: hash,
      bytes,
      name: safeName(file.name),
      mime_type: file.mime_type,
      expires_at: new Date((issued + TTL) * 1000).toISOString(),
      transfer: {
        method: "GET",
        url: this.base + "/api/material-transfer",
        headers: { Authorization: "Bearer " + transfer },
      },
      instructions:
        "Transferência direta pelo ambiente do cliente, fora da interface. Não exibir nem registrar o cabeçalho temporário. Não seguir redirecionamentos. Conferir tamanho e SHA-256 antes de analisar. Não abrir URL no navegador nem acionar downloads/Salvar como. O acesso vale apenas para este arquivo por cinco minutos e depende da sessão continuar ativa. Obter bytes não comprova análise audiovisual; relatar separadamente quadros, fala, sons e lacunas.",
    };
  }

  async download(req: Request) {
    if (req.method !== "GET" || new URL(req.url).search || req.headers.has("range")) denied();
    const authorization = req.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 4096) denied();
    let claims: z.infer<typeof claimsSchema>;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.key, {
        algorithms: ["HS256"],
        typ: TYPE,
        issuer: this.base,
        audience: "arahub-material-transfer",
        currentDate: this.now(),
        maxTokenAge: TTL,
      });
      claims = claimsSchema.parse(payload);
      if (claims.exp - claims.iat !== TTL) denied();
    } catch {
      denied();
    }
    const p: Principal = {
      ownerId: claims.sub,
      sessionId: claims.session,
      clientId: claims.client,
    };
    await this.active(p);
    const [file] = await asOwner(
      this.db,
      p,
      (tx) =>
        tx`select name from public.hub_files where owner_id=${p.ownerId} and id=${claims.file}
        and sha256=${claims.sha256} and bytes=${claims.bytes}
        and octet_length(binary_content)=${claims.bytes}`,
    );
    if (!file) denied();
    let offset = 0, stopped = false;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (stopped || req.signal.aborted) throw new Error("cancelled");
          // Revocation or expiry interrupts later chunks; it cannot erase bytes already received.
          if (Math.floor(this.now().getTime() / 1000) >= claims.exp) denied();
          await this.active(p);
          const length = Math.min(CHUNK, claims.bytes - offset);
          const [row] = await asOwner(
            this.db,
            p,
            (tx) =>
              tx`select substring(binary_content from ${offset + 1} for ${length}) as chunk
              from public.hub_files where owner_id=${p.ownerId} and id=${claims.file}
              and sha256=${claims.sha256} and bytes=${claims.bytes}
              and octet_length(binary_content)=${claims.bytes}`,
          );
          if (!row?.chunk || row.chunk.length !== length) denied();
          if (stopped || req.signal.aborted) throw new Error("cancelled");
          controller.enqueue(new Uint8Array(row.chunk));
          offset += length;
          if (offset === claims.bytes) controller.close();
        } catch {
          if (!stopped) {
            controller.error(new Error("Transferência interrompida; descarte bytes incompletos."));
          }
          stopped = true;
        }
      },
      cancel: () => {
        stopped = true;
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(claims.bytes),
        "Content-Disposition": "attachment; filename*=UTF-8''" +
          encodeURIComponent(safeName(file.name)).replace(
            /['()*]/g,
            (c) => "%" + c.charCodeAt(0).toString(16),
          ),
        "Cache-Control": "no-store, private",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "ETag": '"' + claims.sha256 + '"',
      },
    });
  }
}
