import { createDb } from "../../../src/db.ts";
import { Hub } from "../../../src/domain.ts";
import { ConnectionService } from "../../../src/connections.ts";
import { TokenVault } from "../../../src/adapters/token_vault.ts";
import { createFollowupHandler, HostedFollowup } from "../../../src/hosted_followup.ts";
const required = (key: string) => {
  const value = Deno.env.get(key);
  if (!value) throw new Error("Missing protected follow-up configuration: " + key);
  return value;
};
const db = createDb(Deno.env.get("DATABASE_URL") || required("SUPABASE_DB_URL"));
// No own-status consent service: recurring access is restricted to audited reads.
const connections = new ConnectionService(new Hub(db), await TokenVault.fromEnv());
const runner = new HostedFollowup(db, required("ARAHUB_FOLLOWUP_GRANT_ID"), connections);
Deno.serve(createFollowupHandler(runner, required("ARAHUB_FOLLOWUP_KEY")));
