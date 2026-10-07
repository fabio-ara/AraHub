/**
 * Moodle Lab do AraHub — adapter de laboratório (scripts/lab, MIT).
 *
 * NÃO é importado pelo produto. Existe para exercitar a cadeia real
 * SDK → AraHub → Moodle contra o Moodle Lab privado de loopback.
 *
 * Sobrescreve SOMENTE `getSubmissionStatus`; todo o resto herda o comportamento
 * auditado do adapter raiz (inclusive as funções bloqueadas em produção).
 *
 * A origem loopback é o único motivo de injetar `fetch`: o adapter raiz recusa
 * rede não pública por projeto, e o Lab é justamente loopback. A guarda de
 * marcador e a checagem de loopback rodam antes de qualquer chamada.
 */
import {
  MoodleAdapter,
  type MoodleRecord,
  type MoodleResult,
  type MoodleWarning,
} from "../../src/adapters/moodle.ts";

export interface LabManifestEntry {
  readonly userid: number | null;
  readonly token: string | null;
}

export interface LabManifest {
  readonly schema: string;
  readonly instance_id: string;
  readonly project: string;
  readonly origin: string;
  readonly rest_endpoint: string;
  readonly upload_endpoint: string;
  readonly accounts: Record<string, LabManifestEntry>;
  readonly fixture: Record<string, unknown>;
}

/** Loopback por endereco, nunca por prefixo de texto: 127.evil.com nao passa. */
function isLoopbackHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "localhost" || value === "::1") return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  return parts[0] === 127;
}

/** LAB-04: recusa qualquer alvo fora de loopback antes de tocar a rede. */
export function assertLabOrigin(origin: string): URL {
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new Error("LAB-04: origem vazia recusada.");
  }
  if (/\s/.test(origin)) throw new Error("LAB-04: origem com espaco recusada.");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("LAB-04: origem invalida: " + origin);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LAB-04: esquema recusado: " + url.protocol);
  }
  if (url.username || url.password) {
    throw new Error("LAB-04: origem com credenciais recusada.");
  }
  if (url.search || url.hash) {
    throw new Error("LAB-04: origem com query ou fragmento recusada.");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("LAB-04: subdiretorio nao permitido no laboratorio.");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error("LAB-04: host fora de loopback recusado: " + url.hostname);
  }
  if (url.port === "") {
    throw new Error("LAB-04: porta padrao recusada; use porta loopback explicita.");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("LAB-04: porta fora da faixa de laboratorio: " + url.port);
  }
  return url;
}

export async function loadLabManifest(path: string): Promise<LabManifest> {
  const manifest = JSON.parse(await Deno.readTextFile(path)) as LabManifest;
  assertLabManifest(manifest);
  return manifest;
}

/** Também confere objetos em memória, antes de qualquer transporte autenticado. */
export function assertLabManifest(manifest: LabManifest): void {
  if (manifest.schema !== "arahub.moodle-lab.manifest/1") {
    throw new Error("manifesto de laboratório com esquema inesperado: " + manifest.schema);
  }
  const origin = assertLabOrigin(manifest.origin).origin;
  for (
    const [endpoint, pathname] of [
      [manifest.rest_endpoint, "/webservice/rest/server.php"],
      [manifest.upload_endpoint, "/webservice/upload.php"],
    ]
  ) {
    const url = new URL(endpoint);
    if (
      url.origin !== origin || url.pathname !== pathname || url.username || url.password ||
      url.search || url.hash
    ) {
      throw new Error("Endpoint de laboratório diverge da origem/rota guardada.");
    }
  }
}

/** Confere que o manifesto pertence à instância registrada em disco. */
export function assertLabOwnership(manifest: LabManifest, instanceFile: string): void {
  assertLabManifest(manifest);
  const instance = JSON.parse(Deno.readTextFileSync(instanceFile)) as {
    instance_id?: string;
    project?: string;
    wwwroot?: string;
  };
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      instance.instance_id ?? "",
    )
  ) {
    throw new Error("instância sem UUID válido: " + instanceFile);
  }
  if (
    instance.instance_id !== manifest.instance_id || instance.project !== manifest.project ||
    assertLabOrigin(instance.wwwroot ?? "").origin !== assertLabOrigin(manifest.origin).origin
  ) {
    throw new Error("Manifesto diverge do UUID/projeto/origem da instância em disco.");
  }
}

export function labAccountToken(manifest: LabManifest, user: string): string {
  const entry = manifest.accounts[user];
  if (!entry || !entry.token) throw new Error("conta de laboratório sem token: " + user);
  return entry.token;
}

export class MoodleLabAdapter extends MoodleAdapter {
  private readonly labRest: string;
  private readonly labToken: string;
  private readonly labFetch: typeof fetch;

  /**
   * \`fetchOverride\` existe para provas negativas: ele envia de verdade e depois
   * pode falhar ao ler a resposta, simulando efeito persistido com resposta perdida.
   */
  constructor(
    manifest: LabManifest,
    user: string,
    instanceFile: string,
    fetchOverride?: typeof fetch,
  ) {
    assertLabOwnership(manifest, instanceFile);
    const origin = assertLabOrigin(manifest.origin).toString().replace(/\/$/, "");
    const token = labAccountToken(manifest, user);
    const transport: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin || url.username || url.password) {
        throw new Error("Transporte Lab recusou destino fora da origem guardada.");
      }
      return (fetchOverride ?? fetch)(input, { ...init, redirect: "error" });
    };
    super({ origin, token }, { fetch: transport });
    this.labRest = manifest.rest_endpoint;
    this.labToken = token;
    this.labFetch = transport;
  }

  /** Só esta função é sobrescrita; o restante permanece como no adapter raiz. */
  override async getSubmissionStatus(assignmentId: number): Promise<MoodleResult<MoodleRecord>> {
    assertLabOrigin(this.origin);
    const observedAt = new Date().toISOString();
    const body = new URLSearchParams({
      wstoken: this.labToken,
      wsfunction: "mod_assign_get_submission_status",
      moodlewsrestformat: "json",
      assignid: String(assignmentId),
    });
    const reply = await this.labFetch(this.labRest, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
    });
    const payload = await reply.json() as Record<string, unknown>;
    if (typeof payload.exception === "string") {
      return {
        coverage: "unavailable",
        data: null,
        warnings: [],
        error_code: "moodle_error",
        error_detail: { moodle_code: String(payload.errorcode ?? "exception") },
        observed_at: observedAt,
        empty: false,
        truncated: false,
      };
    }
    // Reusa a normalização do adapter raiz (agora protegida) para que os anexos
    // carreguem a referência file.file_id exigida pela verificação de bytes.
    return {
      coverage: "complete",
      data: await this.normalizeValue(payload) as MoodleRecord,
      warnings: (Array.isArray(payload.warnings) ? payload.warnings : []) as MoodleWarning[],
      error_code: null,
      observed_at: observedAt,
      empty: false,
      truncated: false,
    };
  }
}
