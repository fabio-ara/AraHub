import { asOwner, type Db } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { MoodleAdapter } from "./adapters/moodle.ts";
import {
  type SealedSecret,
  type SealedTokenRecord,
  type TokenStore,
  TokenVault,
} from "./adapters/token_vault.ts";

/** Privileged vault path. Principal comes from HTTP/JWT verifier, never tool arguments. */
export class ConnectionService {
  constructor(
    private hub: Hub,
    private vault: TokenVault,
    private makeMoodle = (origin: string, token: string) => new MoodleAdapter({ origin, token }),
  ) {}
  async parent(p: Principal, id: string) {
    return asOwner(this.hub.db, p, async (tx) => {
      const rows =
        await tx`select id,provider,origin,state from public.hub_connections where owner_id=${p.ownerId} and id=${id}`;
      if (!rows.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
      return rows[0];
    });
  }
  async addMoodle(p: Principal, input: { label: string; origin: string; token: string }) {
    if (p.clientId) {
      throw new HubError("browser_required", "Conecte a conta pela interface do AraHub.", 403);
    }
    const moodle = this.makeMoodle(input.origin, input.token);
    const identity = await moodle.initialize();
    const capabilities = await moodle.discover();
    const connection = await this.hub.connect(
      p,
      "moodle",
      input.label,
      moodle.origin,
      String(identity.user_id),
      capabilities,
    );
    const sealed = await this.vault.seal(input.token, `${p.ownerId}:${connection.id}:moodle`);
    await this.hub
      .db`insert into arahub_private.credentials(owner_id,connection_id,encrypted_payload,key_version) values(${p.ownerId},${connection.id},${
      this.hub.db.json({ provider: "moodle", sealed: { ...sealed } })
    },${sealed.kid})`;
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`update public.hub_connections set state='connected' where owner_id=${p.ownerId} and id=${connection.id}`;
    });
    return {
      id: connection.id,
      provider: "moodle",
      label: input.label,
      state: "connected",
      capabilities,
    };
  }
  async moodle(p: Principal, id: string) {
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
    return this.makeMoodle(parent.origin, token);
  }
  async disconnect(p: Principal, id: string) {
    if (p.clientId) {
      throw new HubError("browser_required", "Desconecte pela interface do AraHub.", 403);
    }
    await this.parent(p, id);
    await this.hub
      .db`delete from arahub_private.credentials where owner_id=${p.ownerId} and connection_id=${id}`;
    await asOwner(this.hub.db, p, async (tx) => {
      await tx`update public.hub_connections set state='revoked' where owner_id=${p.ownerId} and id=${id}`;
    });
    return { disconnected: true, history_preserved: true };
  }
}

export class PostgresTokenStore implements TokenStore {
  constructor(private db: Db, private actor: Principal, private epoch?: number) {}
  private async check(ownerId: string, id: string) {
    if (ownerId !== this.actor.ownerId) {
      throw new HubError("not_found", "Conexão não encontrada.", 404);
    }
    const rows = await asOwner(
      this.db,
      this.actor,
      (tx) =>
        tx`select id from public.hub_connections where owner_id=${this.actor.ownerId} and id=${id} and provider='google' and (${
          this.epoch ?? null
        }::integer is null or (oauth_epoch=${
          this.epoch ?? null
        } and state in ('connected','expired')))`,
    );
    if (!rows.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
  }
  async read(ownerId: string, id: string): Promise<SealedTokenRecord | null> {
    await this.check(ownerId, id);
    const rows = await this
      .db`select encrypted_payload from arahub_private.credentials where owner_id=${this.actor.ownerId} and connection_id=${id}`;
    return rows[0]?.encrypted_payload ?? null;
  }
  async compareAndSwap(
    ownerId: string,
    id: string,
    expectedVersion: number,
    next: SealedTokenRecord,
  ) {
    await this.check(ownerId, id);
    if (
      next.ownerId !== ownerId || next.connectionId !== id || next.version !== expectedVersion + 1
    ) throw new HubError("invalid_record", "Registro inválido.");
    const kid = next.accessToken.kid;
    return await this.db.begin(async (tx) => {
      // Lock the same parent used by reconnect/disconnect. A token version can restart at one,
      // but the connection epoch cannot: an old refresh must not overwrite a new consent.
      const parent =
        await tx`select oauth_epoch,state from public.hub_connections where owner_id=${this.actor.ownerId} and id=${id} and provider='google' for update`;
      if (!parent.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
      if (
        this.epoch !== undefined &&
        (parent[0].oauth_epoch !== this.epoch ||
          !["connected", "expired"].includes(parent[0].state))
      ) return false;
      const encoded = tx.json(JSON.parse(JSON.stringify(next)));
      const rows = expectedVersion === 0
        ? await tx`insert into arahub_private.credentials(owner_id,connection_id,encrypted_payload,key_version,version) values(${ownerId},${id},${encoded},${kid},${next.version}) on conflict(connection_id) do nothing returning connection_id`
        : await tx`update arahub_private.credentials set encrypted_payload=${encoded},key_version=${kid},version=${next.version} where owner_id=${this.actor.ownerId} and connection_id=${id} and version=${expectedVersion} returning connection_id`;
      return rows.length === 1;
    });
  }
}
