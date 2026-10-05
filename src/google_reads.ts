import { asOwner } from "./db.ts";
import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import type { GoogleConnections } from "./google_connections.ts";

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
}
const prefix = "https://www.googleapis.com/auth/";
const nativeScopes = [prefix + "drive.readonly", prefix + "drive.file"];
const allowed: Record<GoogleReadKind, string[]> = {
  gmail_messages: [prefix + "gmail.readonly"],
  gmail_message: [prefix + "gmail.readonly"],
  calendars: [prefix + "calendar.readonly"],
  calendar_events: [prefix + "calendar.readonly"],
  drive_files: nativeScopes,
  document: [prefix + "documents.readonly", ...nativeScopes],
  spreadsheet: [prefix + "spreadsheets.readonly", ...nativeScopes],
  presentation: [prefix + "presentations.readonly", ...nativeScopes],
};

/** Operational allowlist is narrower than the full OAuth token; no arbitrary API or writes. */
export class GoogleReads {
  constructor(private hub: Hub, private connections: GoogleConnections) {}
  async read(p: Principal, connectionId: string, input: GoogleReadInput) {
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
    const client = await this.connections.client(p, connectionId),
      limits = { maxPages: 3, maxItems: 100 };
    let result: unknown;
    switch (input.kind) {
      case "gmail_messages":
        result = await client.listGmailMessages({
          query: input.query,
          pageToken: input.page_token,
          limits,
        });
        break;
      case "gmail_message":
        result = await client.getGmailMessage({ messageId: input.resource_id!, format: "full" });
        break;
      case "calendars":
        result = await client.listCalendars({ limits });
        break;
      case "calendar_events":
        result = await client.listCalendarEvents({ calendarId: input.calendar_id, limits });
        break;
      case "drive_files":
        result = await client.listDriveFiles({
          query: input.query,
          pageToken: input.page_token,
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
