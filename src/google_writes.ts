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
const objectId = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_:-]{4,49}$/);
const localFormulaFunctions = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTA",
  "IF",
  "ROUND",
]);
const formula = z.string().min(2).max(2000).refine(
  (value) =>
    /^=[A-Za-z0-9$():,;.+\-*/^%<>\s]+$/.test(value) &&
    [...value.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)]
      .every((match) => localFormulaFunctions.has(match[1].toUpperCase())),
  "Use fórmula aritmética local; funções de importação, links e referências externas não são oferecidos.",
);
const cell = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({ formula }).strict(),
]);
const rows = z.array(z.array(cell).max(50)).min(1).max(200).superRefine((value, ctx) => {
  if (
    value.reduce((count, row) => count + row.length, 0) > 5000 ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 48 * 1024
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Use até 5.000 células e 48 KiB de conteúdo por criação.",
    });
  }
});
const scopes: Record<string, string> = {
  docs_create: "https://www.googleapis.com/auth/documents",
  docs_insert_text: "https://www.googleapis.com/auth/documents",
  sheets_create: "https://www.googleapis.com/auth/spreadsheets",
  slides_create: "https://www.googleapis.com/auth/presentations",
  slides_replace_text: "https://www.googleapis.com/auth/presentations",
  slides_add_text: "https://www.googleapis.com/auth/presentations",
};
export const googleWriteSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("docs_create"), title }).strict(),
  z.object({
    operation: z.literal("sheets_create"),
    title,
    sheet_title: z.string().min(1).max(100).optional(),
    rows: rows.optional(),
  }).strict(),
  z.object({ operation: z.literal("slides_create"), title }).strict(),
  z.object({
    operation: z.literal("slides_add_text"),
    resource_id: resourceId,
    slide_id: objectId,
    text_id: objectId,
    text: z.string().min(1).max(32000),
    x: z.number().finite().min(0).max(2000).default(40),
    y: z.number().finite().min(0).max(2000).default(40),
    width: z.number().finite().positive().max(2000).default(600),
    height: z.number().finite().positive().max(2000).default(300),
  }).strict(),
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
    } else if (input.operation === "slides_replace_text" || input.operation === "slides_add_text") {
      source = await client.getPresentation({ presentationId: input.resource_id });
    } else return null;
    const sourceId = input.operation === "docs_insert_text"
      ? source.documentId
      : source.presentationId;
    if (sourceId !== input.resource_id) {
      throw new HubError(
        "target_mismatch",
        "A fonte retornada não corresponde ao destino escolhido.",
        409,
      );
    }
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
    if (input.operation === "slides_add_text") {
      if (input.slide_id === input.text_id) {
        throw new HubError(
          "invalid_target",
          "Slide e caixa de texto precisam de IDs distintos.",
          400,
        );
      }
      const size = source.pageSize as {
        width?: { magnitude?: number; unit?: string };
        height?: { magnitude?: number; unit?: string };
      } | undefined;
      const points = (dimension: { magnitude?: number; unit?: string } | undefined) => {
        const magnitude = dimension?.magnitude;
        if (typeof magnitude !== "number" || !Number.isFinite(magnitude) || magnitude <= 0) {
          return null;
        }
        return dimension?.unit === "PT"
          ? magnitude
          : dimension?.unit === "EMU"
          ? magnitude / 12700
          : null;
      };
      const width = points(size?.width), height = points(size?.height);
      if (width === null || height === null) {
        throw new HubError(
          "geometry_unavailable",
          "Não foi possível conferir o tamanho do slide.",
          409,
        );
      }
      if (input.x + input.width > width || input.y + input.height > height) {
        throw new HubError(
          "geometry_out_of_bounds",
          "A caixa de texto precisa caber no slide escolhido.",
          400,
        );
      }
      const slides = Array.isArray(source.slides)
        ? source.slides as { objectId?: string; pageElements?: { objectId?: string }[] }[]
        : [];
      if (
        slides.some((slide) =>
          [input.slide_id, input.text_id].includes(slide.objectId ?? "") ||
          slide.pageElements?.some((element) =>
            [input.slide_id, input.text_id].includes(element.objectId ?? "")
          )
        )
      ) {
        throw new HubError(
          "target_exists",
          "Os IDs já existem. Escolha IDs novos antes de preparar a alteração.",
          409,
        );
      }
    }
    return source.revisionId;
  }
  async prepare(p: Principal, connectionId: string, raw: z.input<typeof googleWriteSchema>) {
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
          body: {
            properties: { title: input.title },
            ...(input.rows || input.sheet_title
              ? {
                sheets: [{
                  properties: {
                    title: input.sheet_title ?? "Dados",
                    ...(input.rows
                      ? {
                        gridProperties: {
                          rowCount: Math.max(1, input.rows.length),
                          columnCount: Math.max(
                            1,
                            ...input.rows.map((row) => row.length),
                          ),
                        },
                      }
                      : {}),
                  },
                  ...(input.rows
                    ? {
                      data: [{
                        startRow: 0,
                        startColumn: 0,
                        rowData: input.rows.map((row) => ({
                          values: row.map((value) =>
                            value === null ? {} : {
                              userEnteredValue: typeof value === "string"
                                ? { stringValue: value }
                                : typeof value === "number"
                                ? { numberValue: value }
                                : typeof value === "boolean"
                                ? { boolValue: value }
                                : { formulaValue: value.formula },
                            }
                          ),
                        })),
                      }],
                    }
                    : {}),
                }],
              }
              : {}),
          },
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
      case "slides_add_text":
        return {
          url: `https://slides.googleapis.com/v1/presentations/${input.resource_id}:batchUpdate`,
          body: {
            requests: [
              {
                createSlide: {
                  objectId: input.slide_id,
                  slideLayoutReference: { predefinedLayout: "BLANK" },
                },
              },
              {
                createShape: {
                  objectId: input.text_id,
                  shapeType: "TEXT_BOX",
                  elementProperties: {
                    pageObjectId: input.slide_id,
                    size: {
                      width: { magnitude: input.width, unit: "PT" },
                      height: { magnitude: input.height, unit: "PT" },
                    },
                    transform: {
                      scaleX: 1,
                      scaleY: 1,
                      translateX: input.x,
                      translateY: input.y,
                      unit: "PT",
                    },
                  },
                },
              },
              { insertText: { objectId: input.text_id, insertionIndex: 0, text: input.text } },
            ],
            writeControl: { requiredRevisionId: revision },
          },
        };
    }
  }
}
