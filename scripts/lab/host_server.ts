/**
 * Optional, temporary host acceptance server. Preparing this file does not
 * authorize an external tunnel, OAuth client, consent or hosted private import.
 * Domain data and Moodle remain local. Only native identity/session validation
 * reads the explicitly configured existing identity database.
 * No synthetic login, fake bearer or public Moodle UI is exposed.
 */
import { z } from "zod";
import { asOwner, createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { HubError } from "../../src/contracts.ts";
import { createVerifier } from "../../src/auth.ts";
import { createHandler } from "../../src/http.ts";
import { PersistentActionStore } from "../../src/approval_store.ts";
import type { ConnectionService } from "../../src/connections.ts";
import { assertLabOwnership, loadLabManifest, MoodleLabAdapter } from "./moodle_lab_adapter.ts";

const schema = z.object({
  public_origin: z.string().url(),
  identity_origin: z.string().url(),
  publishable_key: z.string().min(10),
  owner_id: z.string().uuid(),
  client_id: z.string().min(1),
  connection_id: z.string().uuid(),
  context_id: z.string().uuid(),
  expires_at: z.string().datetime(),
  manifest_path: z.string().min(1),
  instance_path: z.string().min(1),
}).strict();

export function hostLabBoundary(
  handler: (request: Request) => Promise<Response>,
  expiresAt: number,
) {
  const denied = new Set([
    "/api/connections/moodle",
    "/api/connections/disconnect",
    "/api/synthetic-login",
  ]);
  return (request: Request): Promise<Response> | Response => {
    const url = new URL(request.url);
    if (Date.now() >= expiresAt) return new Response(null, { status: 503 });
    if (denied.has(url.pathname)) return Response.json({ code: "lab_scope_only" }, { status: 403 });
    // Browser location/query remain the actual native callback. Only the local
    // HTML handler path changes; no token, claim or approval is synthesized.
    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      url.pathname = "/";
      return handler(new Request(url, request));
    }
    return handler(request);
  };
}

async function main() {
  if (!Deno.args[0]) throw Error("Informe o arquivo privado do lote de homologação aprovado.");
  const config = schema.parse(JSON.parse(await Deno.readTextFile(Deno.args[0])));
  const publicOrigin = new URL(config.public_origin), identity = new URL(config.identity_origin);
  for (const origin of [publicOrigin, identity]) {
    if (
      origin.protocol !== "https:" || origin.username || origin.password || origin.port ||
      origin.pathname !== "/" || origin.search || origin.hash
    ) throw Error("Origem HTTPS inválida.");
  }
  const remaining = Date.parse(config.expires_at) - Date.now();
  if (remaining <= 0 || remaining > 2 * 60 * 60 * 1000) {
    throw Error("Janela deve ser futura e de até duas horas.");
  }
  const database = Deno.env.get("LOCAL_DATABASE_URL") ??
    "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
  const local = new URL(database);
  if (local.hostname !== "127.0.0.1" || local.port !== "55432") {
    throw Error("Dados de domínio exigem o banco local exclusivo.");
  }
  const identityDatabase = Deno.env.get("HOST_LAB_IDENTITY_DATABASE_URL");
  if (!identityDatabase) {
    throw Error("Configure a conexão protegida de identidade nativa do alvo aprovado.");
  }
  const manifest = await loadLabManifest(config.manifest_path);
  assertLabOwnership(manifest, config.instance_path);
  const account = manifest.accounts.labstudenta;
  if (!account?.userid || !account.token) throw Error("Estudante sintético ausente.");
  const lifetime = new AbortController();
  const db = createDb(database), identityDb = createDb(identityDatabase), hub = new Hub(db);
  // Existing prepared local context only: this server neither creates real-account
  // fixtures nor imports personal memory merely because credentials are available.
  const scoped = await asOwner(
    db,
    { ownerId: config.owner_id },
    async (tx) =>
      await tx`select c.id from public.hub_connections c join public.hub_contexts x
    on x.owner_id=c.owner_id where c.owner_id=${config.owner_id} and c.id=${config.connection_id}
    and x.id=${config.context_id} and c.provider='moodle' and c.origin=${manifest.origin}
    and c.provider_subject=${String(account.userid)} and c.state='connected'
    and x.scope->>'environment'='synthetic-host-lab'
    and not exists(select 1 from public.hub_contexts other where other.owner_id=c.owner_id and other.id<>x.id)
    and not exists(select 1 from public.hub_connections other where other.owner_id=c.owner_id and other.id<>c.id)`,
  );
  if (scoped.length !== 1) {
    throw Error("Contexto e conexão de homologação local não correspondem ao lote.");
  }
  const sessionActive = async (owner: string, session: string) => {
    if (owner !== config.owner_id || Date.now() >= Date.parse(config.expires_at)) return false;
    const result =
      await identityDb`select id from auth.sessions where user_id=${owner} and id=${session}`;
    return result.length === 1;
  };
  const auth = {
    issuer: identity.origin + "/auth/v1",
    audience: "authenticated",
    resource: publicOrigin.origin + "/mcp",
    allowedClientIds: [config.client_id],
    sessionActive,
  };
  const parent = async (principal: { ownerId: string }, id: string) => {
    if (principal.ownerId !== config.owner_id || id !== config.connection_id) {
      throw new HubError("not_found", "Conexão fora do laboratório.", 404);
    }
    return await asOwner(db, principal, async (tx) => {
      const rows = await tx`select * from public.hub_connections where owner_id=${principal.ownerId}
      and id=${id} and origin=${manifest.origin} and provider_subject=${
        String(account.userid)
      } and state='connected'`;
      if (rows.length !== 1) throw new HubError("not_found", "Conexão indisponível.", 404);
      return rows[0];
    });
  };
  const connections = {
    parent,
    moodle: async (principal: { ownerId: string }, id: string) => {
      await parent(principal, id);
      return new MoodleLabAdapter(
        manifest,
        "labstudenta",
        config.instance_path,
        (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              lifetime.signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
      );
    },
  } as unknown as ConnectionService;
  const handler = createHandler(hub, {
    auth,
    verify: createVerifier(auth),
    publicUrl: publicOrigin.origin,
    supabaseUrl: identity.origin,
    publishableKey: config.publishable_key,
    connections,
    actions: new PersistentActionStore(db, { sessionActive }),
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 8840,
    signal: lifetime.signal,
    onListen: () =>
      console.log(
        "Homologação preparada: listener local 8840; autenticação nativa; expiração limitada.",
      ),
  }, hostLabBoundary(handler, Date.parse(config.expires_at)));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    lifetime.abort();
    const forcedExit = setTimeout(() => Deno.exit(0), 1000);
    await Promise.allSettled([
      server.finished,
      db.end({ timeout: 0.5 }),
      identityDb.end({ timeout: 0.5 }),
    ]);
    clearTimeout(forcedExit);
  };
  const timer = setTimeout(() => {
    void stop();
  }, Math.max(0, Date.parse(config.expires_at) - Date.now()));
  Deno.addSignalListener("SIGINT", () => {
    void stop();
  });
  await server.finished.catch((error) => {
    if (!lifetime.signal.aborted) throw error;
  });
}
if (import.meta.main) await main();
