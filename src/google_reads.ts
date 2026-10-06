import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import type { GoogleConnections } from "./google_connections.ts";
import { GoogleApiError } from "./adapters/google.ts";

export type GoogleReadKind =
  | "gmail_messages"
  | "gmail_message"
  | "calendars"
  | "calendar_events"
  | "drive_files"
  | "document"
  | "spreadsheet"
  | "presentation";
export interface GoogleReadInput {
  kind: GoogleReadKind;
  resource_id?: string;
  query?: string;
  calendar_id?: string;
  page_token?: string;
  ranges?: string[];
  max_pages?: number;
  max_items?: number;
}
const prefix = "https://www.googleapis.com/auth/";
const nativeScopes = [prefix + "drive.readonly", prefix + "drive.file"];
const allowed: Record<GoogleReadKind, string[]> = {
  gmail_messages: [prefix + "gmail.readonly"],
  gmail_message: [prefix + "gmail.readonly"],
  calendars: [prefix + "calendar.readonly"],
  calendar_events: [prefix + "calendar.readonly"],
  drive_files: nativeScopes,
  document: [prefix + "documents.readonly", prefix + "documents", ...nativeScopes],
  spreadsheet: [prefix + "spreadsheets.readonly", prefix + "spreadsheets", ...nativeScopes],
  presentation: [prefix + "presentations.readonly", prefix + "presentations", ...nativeScopes],
};

/** Operational allowlist is narrower than the full OAuth token; no arbitrary API or writes. */
export class GoogleReads {
  constructor(private hub: Hub, private connections: GoogleConnections) {}
  /** Settings check: bounded reads, no content disclosure or source mutation. */
  async check(p: Principal, connectionId: string) {
    if (p.clientId || !p.sessionId) {
      throw new HubError("browser_required", "Verifique a conexão pela interface.", 403);
    }
    const rows = await asOwner(this.hub.db, p, (tx) =>
      tx`select id from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId} and provider='google'`
    );
    if (!rows.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
    const checks = [];
    for (const kind of ["gmail_messages", "calendars", "drive_files"] as const) {
      try {
        const read = await this.read(p, connectionId, {
          kind, max_pages: 1, max_items: 3,
          ...(kind === "drive_files" ? { query: "trashed = false" } : {}),
        });
        const page = read.result as { items: unknown[]; pages: number; coverage: string; resumeCursor?: string };
        checks.push({ kind, coverage: page.coverage, items: page.items.length, pages: page.pages, continuation: !!page.resumeCursor });
      } catch (error) {
        const code = error instanceof HubError ? error.code :
          error instanceof GoogleApiError ? error.kind : "unavailable";
        checks.push({ kind, coverage: code === "scope_required" ? "denied" : code, error_code: code });
      }
    }
    return { connection_id: connectionId, checked_at: new Date().toISOString(), checks, sources_unchanged: true };
  }
  async read(p: Principal, connectionId: string, input: GoogleReadInput) {
    const limits = { maxPages: input.max_pages ?? 3, maxItems: input.max_items ?? 100 };
    if (!Number.isInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxPages > 3 ||
      !Number.isInteger(limits.maxItems) || limits.maxItems < 1 || limits.maxItems > 100) {
      throw new HubError("invalid_limits", "Use de 1 a 3 páginas e de 1 a 100 itens.", 400);
    }
    const rows = await asOwner(
      this.hub.db,
      p,
      (tx) =>
        tx`select id,state,desired_scopes,granted_scopes from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId} and provider='google'`,
    );
    if (!rows.length) throw new HubError("not_found", "Conexão não encontrada.", 404);
    const row = rows[0], scopes = allowed[input.kind];
    if (
      !scopes ||
      !scopes.some((s) => row.desired_scopes.includes(s) && row.granted_scopes.includes(s))
    ) {
      throw new HubError(
        "scope_required",
        "Autorize esta leitura na conexão escolhida pela interface.",
        403,
      );
    }
    const required = ["gmail_message", "document", "spreadsheet", "presentation"].includes(
      input.kind,
    );
    if (required && !input.resource_id) {
      throw new HubError(
        "resource_required",
        "Informe o identificador do recurso na conta escolhida.",
      );
    }
    const client = await this.connections.client(p, connectionId);
    let result: unknown;
    switch (input.kind) {
      case "gmail_messages":
        result = await client.listGmailMessages({
          query: input.query,
          pageToken: input.page_token,
          maxResults: limits.maxItems,
          limits,
        });
        break;
      case "gmail_message":
        result = await client.getGmailMessage({ messageId: input.resource_id!, format: "full" });
        break;
      case "calendars":
        result = await client.listCalendars({ limits, maxResults: limits.maxItems, pageToken: input.page_token });
        break;
      case "calendar_events":
        result = await client.listCalendarEvents({ calendarId: input.calendar_id, limits, maxResults: limits.maxItems, pageToken: input.page_token });
        break;
      case "drive_files":
        result = await client.listDriveFiles({
          query: input.query,
          pageToken: input.page_token,
          pageSize: limits.maxItems,
          limits,
          fields:
            "nextPageToken,files(id,name,mimeType,modifiedTime,version,webViewLink,capabilities,permissions)",
        });
        break;
      case "document":
        result = await client.getDocument({ documentId: input.resource_id! });
        break;
      case "spreadsheet":
        result = await client.getSpreadsheet({
          spreadsheetId: input.resource_id!,
          includeGridData: true,
          ranges: input.ranges,
        });
        break;
      case "presentation":
        result = await client.getPresentation({ presentationId: input.resource_id! });
        break;
    }
    return {
      connection_id: connectionId,
      kind: input.kind,
      observed_at: new Date().toISOString(),
      result,
      content_is_untrusted_data: true,
      source_note:
        "Consulta na conta escolhida; disponibilidade do recurso não confirma entrega ou leitura integral pelo assistente.",
    };
  }
}
