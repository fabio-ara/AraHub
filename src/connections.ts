import { asOwner, type Db } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { MoodleAdapter, type MoodleDeps } from "./adapters/moodle.ts";
import { type SealedSecret, TokenVault } from "./adapters/token_vault.ts";

/** Privileged vault path. Principal comes from HTTP/JWT verifier, never tool arguments. */
export class ConnectionService {
  constructor(
    private hub: Hub,
    private vault: TokenVault,
    private makeMoodle = (origin: string, token: string, deps?: MoodleDeps) =>
      new MoodleAdapter({ origin, token }, deps),
  ) {}
  async parent(p: Principal, id: string) {
    return asOwner(this.hub.db, p, async (tx) => {
      const rows =
        await tx`select id,provider,origin,provider_subject,state,oauth_epoch,label from public.hub_connections where owner_id=${p.ownerId} and id=${id}`;
      if (!rows.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
      return rows[0];
    });
  }
  async addMoodle(
    p: Principal,
    input: { label: string; origin: string; token: string; connection_id?: string },
  ) {
    if (p.clientId) {
      throw new HubError("browser_required", "Conecte a conta pela interface do AraHub.", 403);
    }
    const prior = input.connection_id ? await this.parent(p, input.connection_id) : null;
    if (prior && prior.provider !== "moodle") {
      throw new HubError("not_found", "Conexão não encontrada.", 404);
    }
    const moodle = this.makeMoodle(input.origin, input.token);
    if (prior && moodle.origin !== prior.origin) {
      throw new HubError(
        "identity_mismatch",
        "A renovação deve usar a mesma instalação e conta.",
        409,
      );
    }
    const identity = await moodle.initialize();
    const capabilities = await moodle.discover();
    if (prior && String(identity.user_id) !== prior.provider_subject) {
      throw new HubError(
        "identity_mismatch",
        "A renovação deve usar a mesma instalação e conta.",
        409,
      );
    }
    const id = prior?.id as string ?? crypto.randomUUID();
    const sealed = await this.vault.seal(input.token, `${p.ownerId}:${id}:moodle`);
    try {
      await this.hub.db.begin(async (tx) => {
        if (prior) {
          const current =
            await tx`select oauth_epoch,origin,provider_subject from public.hub_connections where owner_id=${p.ownerId} and id=${id} and provider='moodle' for update`;
          if (
            !current.length || current[0].oauth_epoch !== prior.oauth_epoch ||
            current[0].origin !== moodle.origin ||
            current[0].provider_subject !== String(identity.user_id)
          ) {
            throw new HubError("connection_changed", "A conexão mudou. Reabra a renovação.", 409);
          }
          await tx`update public.hub_connections set label=${input.label},state='connected',oauth_epoch=oauth_epoch+1,capabilities=${
            tx.json(JSON.parse(JSON.stringify(capabilities)))
          } where owner_id=${p.ownerId} and id=${id}`;
        } else {
          await tx`insert into public.hub_connections(id,owner_id,provider,label,origin,provider_subject,state,capabilities) values(${id},${p.ownerId},'moodle',${input.label},${moodle.origin},${
            String(identity.user_id)
          },'connected',${tx.json(JSON.parse(JSON.stringify(capabilities)))})`;
        }
        await tx`insert into arahub_private.credentials(owner_id,connection_id,encrypted_payload,key_version) values(${p.ownerId},${id},${
          tx.json({ provider: "moodle", sealed: { ...sealed } })
        },${sealed.kid}) on conflict(connection_id) do update set encrypted_payload=excluded.encrypted_payload,key_version=excluded.key_version,version=arahub_private.credentials.version+1 where arahub_private.credentials.owner_id=excluded.owner_id`;
      });
    } catch (e) {
      if (e instanceof HubError) throw e;
      if ((e as { code?: string })?.code === "23505") {
        throw new HubError(
          "connection_exists",
          "Esta conta já está conectada. Use Renovar acesso.",
          409,
        );
      }
      throw new HubError("connection_failed", "Não foi possível preservar a conexão.");
    }
    return {
      id,
      provider: "moodle",
      label: input.label,
      state: "connected",
      capabilities,
      renewed: !!prior,
      history_preserved: true,
    };
  }
  async moodle(p: Principal, id: string, deps?: MoodleDeps) {
    const parent = await this.parent(p, id);
    if (parent.provider !== "moodle" || parent.state !== "connected") {
      throw new HubError(
        "connection_unavailable",
        "A conexão precisa ser ativada ou renovada.",
        409,
      );
    }
    const rows = await this.hub
      .db`select encrypted_payload from arahub_private.credentials where owner_id=${p.ownerId} and connection_id=${id}`;
    if (!rows.length) {
      throw new HubError("credentials_unavailable", "Renove a conexão pela interface.", 409);
    }
    const sealed = rows[0].encrypted_payload.sealed as SealedSecret;
    const token = await this.vault.open(sealed, `${p.ownerId}:${id}:moodle`);
    return this.makeMoodle(parent.origin, token, deps);
  }
  async disconnect(p: Principal, id: string) {
    if (p.clientId) {
      throw new HubError("browser_required", "Desconecte pela interface do AraHub.", 403);
    }
    const parent = await this.parent(p, id);
    if (parent.provider !== "moodle") {
      throw new HubError("not_found", "Conexão não encontrada.", 404);
    }
    await this.hub.db.begin(async (tx) => {
      const rows =
        await tx`select id from public.hub_connections where owner_id=${p.ownerId} and id=${id} and provider='moodle' for update`;
      if (!rows.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
      await tx`delete from arahub_private.credentials where owner_id=${p.ownerId} and connection_id=${id}`;
      await tx`update public.hub_connections set state='revoked',oauth_epoch=oauth_epoch+1 where owner_id=${p.ownerId} and id=${id}`;
    });
    return { disconnected: true, history_preserved: true };
  }
}
