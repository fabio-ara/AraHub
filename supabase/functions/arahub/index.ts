import { createDb } from "../../../src/db.ts";
import { Hub } from "../../../src/domain.ts";
import { createEdgeHandler } from "../../../src/edge.ts";
import { ConnectionService } from "../../../src/connections.ts";
import { TokenVault } from "../../../src/adapters/token_vault.ts";
import { GoogleConnections } from "../../../src/google_connections.ts";
import { googleOAuthConfig } from "../../../src/adapters/google.ts";
import { PersistentActionStore } from "../../../src/approval_store.ts";
const required = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Configuração ausente: ${name}`);
  return v;
};
// Supabase injects the database URL into the function's protected environment.
// An explicit URL still supports a chosen pooler; never expose either value.
const databaseUrl = Deno.env.get("DATABASE_URL") || required("SUPABASE_DB_URL");
const db = createDb(databaseUrl), hub = new Hub(db);
const issuer = required("AUTH_ISSUER"), base = required("PUBLIC_URL");
const uiOrigin = required("UI_ORIGIN");
const uiBase = new URL(required("UI_URL"));
if (
  uiBase.protocol !== "https:" || uiBase.origin !== uiOrigin || uiBase.username ||
  uiBase.password || uiBase.search || uiBase.hash || !uiBase.pathname.endsWith("/")
) {
  throw new Error(
    "UI_URL deve ser a base HTTPS da interface na origem autorizada, terminada em /.",
  );
}
const auth = {
  issuer,
  audience: Deno.env.get("AUTH_AUDIENCE") ?? "authenticated",
  resource: `${base}/mcp`,
  allowedClientIds: required("MCP_CLIENT_IDS").split(",").filter(Boolean),
  sessionActive: async (owner: string, session: string) => {
    const rows = await db`select id from auth.sessions where user_id=${owner} and id=${session}`;
    return rows.length === 1;
  },
};
const vault = Deno.env.get("ARAHUB_TOKEN_VAULT_KEY") ? await TokenVault.fromEnv() : undefined;
const connections = vault ? new ConnectionService(hub, vault) : undefined;
const googleClient = Deno.env.get("GOOGLE_CLIENT_ID"),
  googleSecret = Deno.env.get("GOOGLE_CLIENT_SECRET"),
  googleRedirect = Deno.env.get("GOOGLE_REDIRECT_URI");
const google = vault && googleClient && googleSecret && googleRedirect
  ? new GoogleConnections(
    hub,
    vault,
    googleOAuthConfig({
      clientId: googleClient,
      clientSecret: googleSecret,
      redirectUri: googleRedirect,
    }),
    { sessionActive: auth.sessionActive },
  )
  : undefined;
if (google && googleRedirect !== new URL("oauth/google/callback", uiBase).href) {
  throw new Error("GOOGLE_REDIRECT_URI deve corresponder à interface autorizada.");
}
Deno.serve(createEdgeHandler(hub, auth, base, connections, google, {
  origin: uiOrigin,
  supabaseUrl: required("SUPABASE_URL"),
  publishableKey: required("ARAHUB_PUBLISHABLE_KEY"),
  actions: new PersistentActionStore(db, { sessionActive: auth.sessionActive }),
}));
