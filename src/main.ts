import { createDb } from "./db.ts";
import { Hub } from "./domain.ts";
import { createVerifier } from "./auth.ts";
import { createHandler } from "./http.ts";
import { ConnectionService } from "./connections.ts";
import { TokenVault } from "./adapters/token_vault.ts";
import { GoogleConnections } from "./google_connections.ts";
import { googleOAuthConfig } from "./adapters/google.ts";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const mode = Deno.env.get("APP_MODE") ?? "configured";
const synthetic = mode === "synthetic";
const publicUrl = Deno.env.get("PUBLIC_URL") ?? "http://127.0.0.1:8787";
if (synthetic && !["127.0.0.1", "localhost"].includes(new URL(publicUrl).hostname)) {
  throw new Error("Modo sintético exige loopback.");
}
const dbUrl = Deno.env.get("DATABASE_URL") ??
  (synthetic ? "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub" : undefined);
if (!dbUrl) {
  throw new Error(
    "Configure DATABASE_URL em ambiente protegido ou APP_MODE=synthetic para prova local.",
  );
}
const db = createDb(dbUrl), hub = new Hub(db);
const issuer = synthetic ? "https://synthetic.arahub.invalid/auth" : Deno.env.get("AUTH_ISSUER");
if (!issuer) throw new Error("Configure AUTH_ISSUER do projeto autorizado.");
const clientIds = synthetic
  ? ["local-mcp-fixture"]
  : (Deno.env.get("MCP_CLIENT_IDS") ?? "").split(",").filter(Boolean);
const keys = synthetic ? await generateKeyPair("ES256") : undefined;
const key = keys
  ? createLocalJWKSet({
    keys: [{ ...await exportJWK(keys.publicKey), kid: "local-test-key", alg: "ES256" }],
  })
  : undefined;
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let syntheticLogin: (() => Promise<string>) | undefined;
if (keys) {
  await db`insert into auth.users(id) values(${ownerId}) on conflict do nothing`;
  syntheticLogin = () =>
    new SignJWT({ role: "authenticated", session_id: sessionId, client_id: "local-mcp-fixture" })
      .setProtectedHeader({ alg: "ES256", kid: "local-test-key" }).setSubject(ownerId).setIssuer(
        issuer,
      ).setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
}
const auth = {
  issuer,
  audience: Deno.env.get("AUTH_AUDIENCE") ?? "authenticated",
  resource: `${publicUrl}/mcp`,
  allowedClientIds: clientIds,
  key,
  sessionActive: async (owner: string, session: string) => {
    if (synthetic) return owner === ownerId && session === sessionId;
    const rows = await db`select id from auth.sessions where user_id=${owner} and id=${session}`;
    return rows.length === 1;
  },
};
const vault = Deno.env.get("ARAHUB_TOKEN_VAULT_KEY") ? await TokenVault.fromEnv() : undefined;
const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID"),
  googleSecret = Deno.env.get("GOOGLE_CLIENT_SECRET"),
  googleRedirect = Deno.env.get("GOOGLE_REDIRECT_URI");
const google = !synthetic && vault && googleClientId && googleSecret && googleRedirect
  ? new GoogleConnections(
    hub,
    vault,
    googleOAuthConfig({
      clientId: googleClientId,
      clientSecret: googleSecret,
      redirectUri: googleRedirect,
    }),
    { sessionActive: auth.sessionActive },
  )
  : undefined;
if (google && googleRedirect !== `${publicUrl}/oauth/google/callback`) {
  throw new Error("GOOGLE_REDIRECT_URI deve corresponder ao callback desta interface.");
}
const handler = createHandler(hub, {
  auth,
  verify: createVerifier(auth),
  publicUrl,
  supabaseUrl: Deno.env.get("SUPABASE_URL"),
  publishableKey: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
  syntheticLogin,
  connections: vault ? new ConnectionService(hub, vault) : undefined,
  google,
});
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: Number(Deno.env.get("PORT") ?? 8787),
  onListen: () => console.log(`AraHub local: ${publicUrl} (${mode})`),
}, handler);
const stop = async () => {
  await server.shutdown();
  await db.end();
};
Deno.addSignalListener("SIGINT", stop);
