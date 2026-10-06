import { z } from "zod";
import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import type { GoogleConnections } from "./google_connections.ts";
import { PersistentActionStore } from "./approval_store.ts";
import { executeAction } from "./production.ts";
import { boundedBody } from "./network.ts";

const resourceId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const title = z.string().min(1).max(300);
const scopes: Record<string, string> = {
  docs_create: "https://www.googleapis.com/auth/documents",
  docs_insert_text: "https://www.googleapis.com/auth/documents",
  sheets_create: "https://www.googleapis.com/auth/spreadsheets",
  slides_create: "https://www.googleapis.com/auth/presentations",
  slides_replace_text: "https://www.googleapis.com/auth/presentations",
};
export const googleWriteSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("docs_create"), title }).strict(),
  z.object({ operation: z.literal("sheets_create"), title }).strict(),
  z.object({ operation: z.literal("slides_create"), title }).strict(),
  z.object({
    operation: z.literal("docs_insert_text"),
    resource_id: resourceId,
    index: z.number().int().min(1),
    text: z.string().min(1).max(32000),
    tab_id: resourceId.optional(),
  }).strict(),
  z.object({
    operation: z.literal("slides_replace_text"),
    resource_id: resourceId,
    find: z.string().min(1).max(2000),
    replace: z.string().max(32000),
    page_ids: z.array(resourceId).min(1).max(30),
  }).strict(),
]);
type WriteInput = z.infer<typeof googleWriteSchema>;

/** Only fixed native operations; no arbitrary requests, URLs, send/share or implicit drive.file writes. */
export class GoogleWrites {
  constructor(
    private hub: Hub,
    private connections: GoogleConnections,
    readonly store: PersistentActionStore,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async permitted(p: Principal, connectionId: string, operation: string) {
    const row = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`select state,desired_scopes,granted_scopes from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId} and provider='google'`)[
          0
        ],
    );
    if (!row) throw new HubError("not_found", "Conexão não encontrada.", 404);
    const scope = scopes[operation];
    if (row.state !== "connected") {
      throw new HubError(
        "connection_unavailable",
        "Renove a conexão antes de alterar o recurso.",
        409,
      );
    }
    if (!scope || !row.desired_scopes.includes(scope) || !row.granted_scopes.includes(scope)) {
      throw new HubError(
        "scope_required",
        "Autorize a capacidade de edição desta conta pela interface. A aprovação de conteúdo é separada.",
        403,
      );
    }
  }
  private async revision(p: Principal, connectionId: string, input: WriteInput) {
    const client = await this.connections.client(p, connectionId);
    let source: Record<string, unknown>;
    if (input.operation === "docs_insert_text") {
      source = await client.getDocument({ documentId: input.resource_id });
    } else if (input.operation === "slides_replace_text") {
      source = await client.getPresentation({ presentationId: input.resource_id });
    } else return null;
    if (typeof source.revisionId !== "string" || !source.revisionId) {
      throw new HubError(
        "revision_unavailable",
        "Não foi possível fixar a revisão. A alteração não será enviada.",
        409,
      );
    }
    if (
      input.operation === "docs_insert_text" && Array.isArray(source.tabs) &&
      source.tabs.length > 1 && !input.tab_id
    ) {
      throw new HubError(
        "tab_required",
        "Selecione a aba do documento antes de preparar a alteração.",
        409,
      );
    }
    return source.revisionId;
  }
  async prepare(p: Principal, connectionId: string, raw: WriteInput) {
    const input = googleWriteSchema.parse(raw);
    await this.permitted(p, connectionId, input.operation);
    const revision = await this.revision(p, connectionId, input);
    return await this.store.prepare(p, {
      connectionId,
      operation: input.operation,
      target: "resource_id" in input ? input.resource_id : "new",
      revision,
      content: input,
    });
  }
  async execute(p: Principal, actionId: string) {
    const view = await this.store.load(p, actionId);
    if (!view) throw new HubError("not_found", "Ação não encontrada.", 404);
    const action = view.action, input = googleWriteSchema.parse(action.content);
    if (
      action.operation !== input.operation ||
      action.target !== ("resource_id" in input ? input.resource_id : "new")
    ) {
      throw new HubError("content_changed", "A ação não corresponde ao conteúdo preparado.", 409);
    }
    // A prior uncertain/succeeded receipt is returned without provider calls or a new send.
    const prior = await this.store.result(action.id, p.ownerId);
    if (prior) return prior;
    await this.permitted(p, action.connectionId, input.operation);
    if (await this.revision(p, action.connectionId, input) !== action.revision) {
      throw new HubError(
        "revision_changed",
        "A fonte mudou. Prepare e revise uma nova versão.",
        409,
      );
    }
    return await executeAction(p, action, this.store, async () => {
      const access = await this.connections.tokens(p, action.connectionId);
      const request = this.nativeRequest(input, action.revision);
      const response = await this.fetcher(request.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.body),
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Provider operation not confirmed");
      }
      const json = JSON.parse(await boundedBody(response, 1024 * 1024));
      const id = json.documentId ?? json.spreadsheetId ?? json.presentationId;
      if (typeof id !== "string" || !id) throw new Error("Provider receipt absent");
      if ("resource_id" in input && id !== input.resource_id) {
        throw new Error("Provider receipt target mismatch");
      }
      return { externalId: id };
    });
  }
  private nativeRequest(input: WriteInput, revision: string | null) {
    switch (input.operation) {
      case "docs_create":
        return { url: "https://docs.googleapis.com/v1/documents", body: { title: input.title } };
      case "sheets_create":
        return {
          url: "https://sheets.googleapis.com/v4/spreadsheets",
          body: { properties: { title: input.title } },
        };
      case "slides_create":
        return {
          url: "https://slides.googleapis.com/v1/presentations",
          body: { title: input.title },
        };
      case "docs_insert_text":
        return {
          url: `https://docs.googleapis.com/v1/documents/${input.resource_id}:batchUpdate`,
          body: {
            requests: [{
              insertText: {
                location: { index: input.index, ...(input.tab_id ? { tabId: input.tab_id } : {}) },
                text: input.text,
              },
            }],
            writeControl: { requiredRevisionId: revision },
          },
        };
      case "slides_replace_text":
        return {
          url: `https://slides.googleapis.com/v1/presentations/${input.resource_id}:batchUpdate`,
          body: {
            requests: [{
              replaceAllText: {
                containsText: { text: input.find, matchCase: true },
                replaceText: input.replace,
                pageObjectIds: input.page_ids,
              },
            }],
            writeControl: { requiredRevisionId: revision },
          },
        };
    }
  }
}
