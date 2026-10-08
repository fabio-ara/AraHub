import type { Db } from "./db.ts";
import { HubError, type Principal } from "./contracts.ts";

export const OWN_STATUS_POLICY_VERSION = "own-individual-v1";
export const OWN_STATUS_POLICY_TEXT =
  "Consultar somente o estado das minhas entregas individuais nesta conta Moodle. A consulta pode criar um registro técnico vazio, marcar feedback como visto e gerar logs. No laboratório, duas consultas não alteraram notas; isso não garante ausência de outros efeitos internos na instalação da universidade. Não autoriza upload, publicação, entrega final, consulta de terceiros ou grupos. Posso revogar; renovar a credencial exige novo consentimento.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function blocked(): never {
  throw new HubError(
    "status_policy_blocked",
    "A consulta de status próprio precisa de consentimento vigente na interface do AraHub.",
    403,
  );
}

/** Disabled unless configured by the operator; the MCP cannot create consent. */
export class OwnSubmissionStatusPolicies {
  constructor(
    private db: Db,
    private sessionActive: (owner: string, session: string) => Promise<boolean>,
    readonly enabled = false,
  ) {}

  private async browser(p: Principal) {
    if (!this.enabled) blocked();
    if (
      p.clientId || !uuid.test(p.ownerId) || !p.sessionId || !uuid.test(p.sessionId) ||
      !await this.sessionActive(p.ownerId, p.sessionId)
    ) {
      throw new HubError(
        "browser_required",
        "Revise esta permissão na sua sessão ativa da interface AraHub.",
        403,
      );
    }
  }

  async review(p: Principal, connectionId: string) {
    await this.browser(p);
    const [c] = await this.db`select id,label,origin,provider_subject,oauth_epoch,state
      from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId} and provider='moodle'`;
    if (!c) throw new HubError("not_found", "Conexão não encontrada.", 404);
    const [receipt] = await this.db`select id,allowed,credential_epoch,policy_version,decided_at
      from arahub_private.own_submission_status_consents where owner_id=${p.ownerId} and connection_id=${connectionId}
      order by sequence desc limit 1`;
    return {
      connection_id: connectionId,
      label: c.label,
      origin: c.origin,
      account: c.provider_subject,
      credential_epoch: c.oauth_epoch,
      state: c.state,
      policy_version: OWN_STATUS_POLICY_VERSION,
      explanation: OWN_STATUS_POLICY_TEXT,
      last_receipt_id: receipt?.id ?? null,
      allowed: c.state === "connected" && receipt?.allowed === true &&
        receipt.credential_epoch === c.oauth_epoch &&
        receipt.policy_version === OWN_STATUS_POLICY_VERSION,
    };
  }

  async decide(p: Principal, input: {
    connection_id: string;
    credential_epoch: number;
    last_receipt_id: string | null;
    policy_version: string;
    allow: boolean;
    effects_accepted: boolean;
  }) {
    await this.browser(p);
    if (
      input.policy_version !== OWN_STATUS_POLICY_VERSION || (input.allow && !input.effects_accepted)
    ) blocked();
    return await this.db.begin(async (tx) => {
      // Same lock used by renewal/disconnect and guarded reads: no stale approval wins.
      const [c] =
        await tx`select origin,provider_subject,oauth_epoch,state from public.hub_connections
        where owner_id=${p.ownerId} and id=${input.connection_id} and provider='moodle' for update`;
      if (!c) throw new HubError("not_found", "Conexão não encontrada.", 404);
      const [prior] = await tx`select id from arahub_private.own_submission_status_consents
        where owner_id=${p.ownerId} and connection_id=${input.connection_id} order by sequence desc limit 1`;
      if (
        c.oauth_epoch !== input.credential_epoch || (prior?.id ?? null) !== input.last_receipt_id ||
        (input.allow && c.state !== "connected")
      ) {
        throw new HubError(
          "connection_changed",
          "A permissão ou conexão mudou. Reabra a revisão.",
          409,
        );
      }
      if (!await this.sessionActive(p.ownerId, p.sessionId!)) blocked();
      const [receipt] = await tx`insert into arahub_private.own_submission_status_consents
        (owner_id,connection_id,credential_epoch,provider_subject,origin,policy_version,allowed,session_id)
        values(${p.ownerId},${input.connection_id},${c.oauth_epoch},${c.provider_subject},${c.origin},
          ${OWN_STATUS_POLICY_VERSION},${input.allow},${p
        .sessionId!}) returning id,allowed,decided_at`;
      return receipt;
    });
  }

  async run<T>(
    p: Principal,
    connectionId: string,
    expectedEpoch: number,
    identity: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) blocked();
    return await this.db.begin(async (tx) => {
      const [c] =
        await tx`select origin,provider_subject,oauth_epoch,state from public.hub_connections
        where owner_id=${p.ownerId} and id=${connectionId} and provider='moodle' for share`;
      if (
        !c || c.state !== "connected" || c.oauth_epoch !== expectedEpoch ||
        c.provider_subject !== String(identity)
      ) blocked();
      const [r] = await tx`select allowed,credential_epoch,provider_subject,origin,policy_version
        from arahub_private.own_submission_status_consents where owner_id=${p.ownerId} and connection_id=${connectionId}
        order by sequence desc limit 1`;
      if (
        !r?.allowed || r.credential_epoch !== c.oauth_epoch ||
        r.provider_subject !== c.provider_subject ||
        r.origin !== c.origin || r.policy_version !== OWN_STATUS_POLICY_VERSION
      ) blocked();
      // Keep the shared lock through the bounded provider request. Revocation/renewal
      // waits for an already dispatched read; subsequent reads see the new decision.
      return await operation();
    }) as T;
  }
}
