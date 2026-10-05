import { createDb } from "../../../src/db.ts";
import { Hub } from "../../../src/domain.ts";
import { createEdgeHandler } from "../../../src/edge.ts";
import { ConnectionService } from "../../../src/connections.ts";
import { TokenVault } from "../../../src/adapters/token_vault.ts";
import { GoogleConnections } from "../../../src/google_connections.ts";
import { googleOAuthConfig } from "../../../src/adapters/google.ts";
const required = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Configuração ausente: ${name}`);
  return v;
};
const db = createDb(required("DATABASE_URL")), hub = new Hub(db);
const issuer = required("AUTH_ISSUER"), base = required("PUBLIC_URL");
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
Deno.serve(createEdgeHandler(hub, auth, base, connections, google));
