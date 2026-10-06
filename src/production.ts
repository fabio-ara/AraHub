import { createHash } from "node:crypto";
import { HubError, type Principal } from "./contracts.ts";

export interface PreparedAction {
  id: string;
  ownerId: string;
  connectionId: string;
  operation: string;
  target: string;
  revision: string | null;
  content: unknown;
  hash: string;
}
export interface TrustedReceipt {
  actionId: string;
  hash: string;
  ownerId: string;
  expiresAt: string;
  source: "trusted_ui";
}
export interface ApprovalAuthority {
  consume(action: PreparedAction, actor: Principal): Promise<TrustedReceipt | null>;
  persistResult(
    action: PreparedAction,
    result: { state: "succeeded" | "uncertain"; externalId?: string },
  ): Promise<void>;
  result(
    actionId: string,
    ownerId: string,
  ): Promise<{ state: "succeeded" | "uncertain"; externalId?: string } | null>;
}
export function prepareAction(
  actor: Principal,
  connectionId: string,
  operation: string,
  target: string,
  revision: string | null,
  content: unknown,
): PreparedAction {
  const serialized = JSON.stringify({ connectionId, operation, target, revision, content });
  return {
    id: crypto.randomUUID(),
    ownerId: actor.ownerId,
    connectionId,
    operation,
    target,
    revision,
    content,
    hash: createHash("sha256").update(serialized).digest("hex"),
  };
}
export async function executeAction(
  actor: Principal,
  action: PreparedAction,
  authority: ApprovalAuthority,
  send: (action: PreparedAction) => Promise<{ externalId: string }>,
) {
  if (actor.ownerId !== action.ownerId) {
    throw new HubError("not_found", "Ação não encontrada.", 404);
  }
  const reconstructed = prepareAction(
    actor,
    action.connectionId,
    action.operation,
    action.target,
    action.revision,
    action.content,
  );
  if (reconstructed.hash !== action.hash) {
    throw new HubError(
      "approval_invalid",
      "O conteúdo mudou; prepare e autorize a nova versão.",
      409,
    );
  }
  const prior = await authority.result(action.id, actor.ownerId);
  if (prior) return prior; // never resend an uncertain operation; reconciliation must be explicit.
  const receipt = await authority.consume(action, actor);
  if (
    !receipt || receipt.source !== "trusted_ui" || receipt.actionId !== action.id ||
    receipt.ownerId !== actor.ownerId || receipt.hash !== action.hash ||
    Date.parse(receipt.expiresAt) <= Date.now()
  ) throw new HubError("approval_required", "Autorize esta operação na superfície confiável.", 403);
  // Persist intent/uncertainty before crossing the external side-effect boundary.
  await authority.persistResult(action, { state: "uncertain" });
  try {
    const sent = await send(action);
    const result = { state: "succeeded" as const, externalId: sent.externalId };
    await authority.persistResult(action, result);
    return result;
  } catch {
    return { state: "uncertain" as const };
  }
}
export type StudyRole = "required" | "related" | "suggested";

/** Arquivo/versão já preservado para uma entidade; o localizador prova o hash lido. */
export interface StudyFile {
  id: string;
  name: string;
  mime_type: string;
  sha256: string;
  /** BIGINT do banco chega como string decimal; number só quando couber. */
  bytes: number | string;
  locator: string;
  text_available: boolean;
  text_length: number | null;
  extraction: Record<string, unknown>;
}

/**
 * Material do pacote: um por entidade relacionada. Quando a entidade tem mais
 * de um arquivo/versão, `files` lista todos e `selection_required` pede
 * escolha humana; nenhum arquivo é eleito por recência.
 */
export interface StudyMaterial {
  id: string;
  role: StudyRole | "reference";
  locator: string;
  rights: string;
  readEvidence?: string;
  title?: string;
  relation_kinds?: string[];
  relation_evidence?: { kind: string; evidence: Record<string, unknown> }[];
  rights_by_relation?: Record<string, string>;
  rights_requires_review?: boolean;
  coverage?: string | null;
  provenance?: unknown;
  observation?: unknown;
  files?: StudyFile[];
  file_count?: number;
  selection_required?: boolean;
}
export function studyPackage(
  activity: { id: string; instruction: string },
  materials: StudyMaterial[],
  goal: string,
) {
  return {
    activity,
    materials,
    goal,
    source_contents_are_data: true,
    aralearn: { creation_authorized: false, privacy: "Keep private unless explicitly authorized" },
    // Sem prova de leitura, cada arquivo disponível é apenas constatado, nunca confirmado.
    read_status: materials.flatMap((m) => {
      const files = m.files ?? [];
      const status = m.readEvidence ? "reported_read" : "available_not_confirmed_read";
      if (!files.length) {
        return [{
          id: m.id,
          material_id: m.id,
          locator: m.locator,
          status,
          basis: "entity_locator",
        }];
      }
      return files.map((f) => ({
        id: f.id,
        material_id: m.id,
        locator: f.locator,
        status,
        basis: "preserved_file",
      }));
    }),
  };
}
