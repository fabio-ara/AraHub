import postgres from "postgres";
import { HubError, type Principal } from "./contracts.ts";
export type Db = ReturnType<typeof postgres>;
export function createDb(url: string): Db {
  const host = new URL(url).hostname;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(host);
  // 'require' in postgres.js permits unverified certificates; remote peers must be verified.
  return postgres(url, {
    max: 3,
    prepare: false,
    onnotice: () => {},
    connect_timeout: 10,
    ssl: local ? false : { rejectUnauthorized: true },
    idle_timeout: 20,
  });
}
export async function asOwner<T>(
  db: Db,
  principal: Principal,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(principal.ownerId)) {
    throw new HubError("unauthorized", "Sessão inválida.", 401);
  }
  try {
    return await db.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub',${principal.ownerId},true)`;
      await tx`select set_config('request.jwt.claims','{}',true)`;
      await tx`set local role authenticated`;
      return await fn(tx);
    }) as T;
  } catch (e) {
    if (e instanceof HubError) throw e;
    // Provider SQL messages/details may contain private values. Only public codes survive.
    const msg = e instanceof Error ? e.message : "";
    if (msg === "version_conflict" || msg === "idempotency_conflict") {
      throw new HubError(
        msg,
        "A versão mudou. Recupere o contexto e preserve a nova evidência.",
        409,
      );
    }
    if (msg === "not_found") throw new HubError("not_found", "Registro não encontrado.", 404);
    throw new HubError("operation_failed", "Não foi possível concluir a operação.", 400);
  }
}
