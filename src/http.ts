import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { handleMcp } from "./mcp.ts";
import { type AuthConfig, discovery } from "./auth.ts";
import { boundedBody } from "./network.ts";
import type { ConnectionService } from "./connections.ts";
import { Sync } from "./sync.ts";
import { z } from "zod";
import type { PersistentActionStore } from "./approval_store.ts";
import { Materials } from "./materials.ts";
import type { MaterialTransfers } from "./material_transfer.ts";

interface HttpConfig {
  auth: Pick<AuthConfig, "resource" | "issuer">;
  verify: (req: Request, mcp?: boolean) => Promise<Principal>;
  publicUrl: string;
  supabaseUrl?: string;
  publishableKey?: string;
  syntheticLogin?: () => Promise<string>;
  connections?: ConnectionService;
  actions?: PersistentActionStore;
  materialTransfers?: MaterialTransfers;
}
export function createHandler(hub: Hub, config: HttpConfig) {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const safeHeaders = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
      Response.json(value, { status, headers: { ...safeHeaders, ...extra } });
    try {
      const origin = req.headers.get("origin");
      if (origin && origin !== config.publicUrl) return json({ code: "origin_denied" }, 403);
      if (u.pathname === "/health") {
        return json({
          product: "AraHub",
          state: "service_available",
        });
      }
      if (u.pathname === "/api/material-transfer" && config.materialTransfers) {
        return await config.materialTransfers.download(req);
      }
      if (
        u.pathname === "/.well-known/oauth-protected-resource" ||
        u.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) return json(discovery(config.auth));
      if (u.pathname === "/api/config" && req.method === "GET") {
        return json({
          supabaseUrl: config.supabaseUrl ?? null,
          publishableKey: config.publishableKey ?? null,
          synthetic: !!config.syntheticLogin,
          canConnectMoodle: !!config.connections && !config.syntheticLogin,
          canApproveActions: !!config.actions && !config.syntheticLogin,
          canAuthorizeOwnStatus: !!config.connections?.ownStatusPolicies?.enabled &&
            !config.syntheticLogin,
          canExtractPdf: !config.syntheticLogin,
        });
      }
      if (u.pathname === "/api/synthetic-login" && req.method === "POST" && config.syntheticLogin) {
        return json({ access_token: await config.syntheticLogin(), mode: "synthetic" });
      }
      if (u.pathname === "/privacy.html" && req.method === "GET") {
        return new Response(
          await Deno.readTextFile(new URL("../web/privacy.html", import.meta.url)),
          {
            headers: { ...safeHeaders, "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      if (u.pathname === "/" || u.pathname === "/oauth/consent") {
        return new Response(
          await Deno.readTextFile(new URL("../web/index.html", import.meta.url)),
          {
            headers: {
              ...safeHeaders,
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://*.supabase.co; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            },
          },
        );
      }
      if (
        ["/ui/app.js", "/ui/theme.js", "/ui/style.css", "/ui/pdf-parser.worker.js"].includes(
          u.pathname,
        )
      ) {
        const name = u.pathname.slice("/ui/".length);
        return new Response(await Deno.readFile(new URL(`../web/${name}`, import.meta.url)), {
          headers: {
            ...safeHeaders,
            "Content-Type": name.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
          },
        });
      }
      if (u.pathname === "/mcp") {
        const p = await config.verify(req, true);
        const size = Number(req.headers.get("content-length") ?? "0");
        if (size > 128 * 1024) return json({ code: "limit_exceeded" }, 413);
        if (req.method === "POST") {
          const raw = await boundedBody(req, 128 * 1024);
          if (new TextEncoder().encode(raw).length > 128 * 1024) {
            return json({ code: "limit_exceeded" }, 413);
          }
          return await handleMcp(
            new Request(req.url, { method: req.method, headers: req.headers, body: raw }),
            hub,
            p,
            config.connections,
            config.actions,
            config.materialTransfers,
          );
        }
        return await handleMcp(
          req,
          hub,
          p,
          config.connections,
          config.actions,
          config.materialTransfers,
        );
      }
      if (
        u.pathname === "/api/actions" && req.method === "GET" && config.actions
      ) return json(await config.actions.list(await config.verify(req, false)));
      if (
        ["/api/actions/approve", "/api/actions/deny"].includes(u.pathname) &&
        req.method === "POST" && config.actions
      ) {
        const p = await config.verify(req, false);
        const input = z.object({
          action_id: z.string().uuid(),
          content_hash: z.string().regex(/^[a-f0-9]{64}$/),
          statement_accepted: z.boolean().optional(),
        }).strict().parse(JSON.parse(await boundedBody(req, 2048)));
        const view = await config.actions.load(p, input.action_id);
        if (!view) throw new HubError("not_found", "Ação não encontrada.", 404);
        if (view.action.hash !== input.content_hash) {
          throw new HubError(
            "content_changed",
            "O conteúdo mudou. Revise a nova versão antes de decidir.",
            409,
          );
        }
        if (u.pathname.endsWith("/approve")) {
          const content = view.action.content as
            | { statement?: { required?: unknown } }
            | null;
          if (
            view.action.operation.startsWith("moodle.") &&
            content?.statement?.required === true &&
            input.statement_accepted !== true
          ) {
            throw new HubError(
              "statement_required",
              "Leia e aceite a declaração de autoria desta ação.",
              403,
            );
          }
          return json(
            await config.actions.approve(p, input.action_id, {
              expectedHash: input.content_hash,
              statementAccepted: input.statement_accepted,
            }),
          );
        }
        await config.actions.deny(p, input.action_id, { expectedHash: input.content_hash });
        return json({ state: "denied" });
      }
      if (
        u.pathname === "/api/connections/moodle" && req.method === "POST" && config.connections &&
        !config.syntheticLogin
      ) {
        const p = await config.verify(req, false);
        const input = z.object({
          label: z.string().min(1).max(100),
          origin: z.string().url(),
          token: z.string().min(8).max(4096),
          connection_id: z.string().uuid().optional(),
        }).strict().parse(JSON.parse(await boundedBody(req, 8192)));
        return json(await config.connections.addMoodle(p, input));
      }
      if (
        ["/api/connections/own-status/review", "/api/connections/own-status/decide"].includes(
          u.pathname,
        ) &&
        req.method === "POST" && config.connections?.ownStatusPolicies?.enabled &&
        !config.syntheticLogin
      ) {
        const p = await config.verify(req, false);
        const raw = JSON.parse(await boundedBody(req, 2048));
        if (u.pathname.endsWith("/review")) {
          const input = z.object({ connection_id: z.string().uuid() }).strict().parse(raw);
          return json(await config.connections.ownStatusPolicies.review(p, input.connection_id));
        }
        const input = z.object({
          connection_id: z.string().uuid(),
          credential_epoch: z.number().int().nonnegative(),
          last_receipt_id: z.string().uuid().nullable(),
          policy_version: z.string().max(40),
          allow: z.boolean(),
          effects_accepted: z.boolean(),
        }).strict().parse(raw);
        return json(await config.connections.ownStatusPolicies.decide(p, input));
      }
      if (
        u.pathname === "/api/connections/disconnect" && req.method === "POST" && config.connections
      ) {
        const p = await config.verify(req, false);
        const input = z.object({ connection_id: z.string().uuid() }).strict().parse(
          JSON.parse(await boundedBody(req, 1024)),
        );
        return json(await config.connections.disconnect(p, input.connection_id));
      }
      if (
        u.pathname === "/api/sync/moodle-course" && req.method === "POST" && config.connections
      ) {
        const p = await config.verify(req, false);
        const input = z.object({
          connection_id: z.string().uuid(),
          course_id: z.number().int().positive(),
        }).strict().parse(
          JSON.parse(await boundedBody(req, 1024)),
        );
        return json(
          await new Sync(hub, config.connections).courseContent(
            p,
            input.connection_id,
            input.course_id,
          ),
        );
      }
      if (
        u.pathname === "/api/sync/moodle-courses" && req.method === "POST" && config.connections
      ) {
        const p = await config.verify(req, false);
        const input = z.object({ connection_id: z.string().uuid() }).strict().parse(
          JSON.parse(await boundedBody(req, 1024)),
        );
        return json(await new Sync(hub, config.connections).courses(p, input.connection_id));
      }
      if (u.pathname === "/api/context") {
        if (req.method !== "GET") return json({ code: "method_not_allowed" }, 405);
        return json(await hub.context(await config.verify(req, false)));
      }
      if (u.pathname === "/api/preferences") {
        if (req.method !== "GET") return json({ code: "method_not_allowed" }, 405);
        const scope = z.record(z.string()).parse(
          JSON.parse(u.searchParams.get("scope") ?? "{}"),
        );
        return json(await hub.preferences(await config.verify(req, false), scope));
      }
      if (u.pathname === "/api/export" && req.method === "GET") {
        return json(await hub.exportMemory(await config.verify(req, false)));
      }
      if (u.pathname === "/api/pdf/list" && req.method === "POST") {
        const p = await config.verify(req, false);
        const input = z.object({ after: z.string().uuid().optional() }).strict().parse(
          JSON.parse(await boundedBody(req, 2048)),
        );
        return json(await new Materials(hub, config.connections).listPdf(p, input.after));
      }
      if (u.pathname === "/api/pdf/bytes" && req.method === "POST") {
        const p = await config.verify(req, false);
        const input = z.object({
          file_id: z.string().uuid(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }).strict().parse(JSON.parse(await boundedBody(req, 2048)));
        const file = await new Materials(hub, config.connections).readPdf(
          p,
          input.file_id,
          input.sha256,
        );
        return new Response(file.bytes, {
          headers: { ...safeHeaders, "Content-Type": "application/pdf" },
        });
      }
      if (u.pathname === "/api/pdf/commit" && req.method === "POST") {
        const p = await config.verify(req, false);
        const input = z.object({
          file_id: z.string().uuid(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          extraction: z.unknown(),
        }).strict().parse(JSON.parse(await boundedBody(req, 6 * 1024 * 1024)));
        return json(
          await new Materials(hub, config.connections).commitClientPdf(
            p,
            input.file_id,
            input.sha256,
            input.extraction,
          ),
        );
      }
      return json({ code: "not_found" }, 404);
    } catch (e) {
      const err = e instanceof HubError
        ? e
        : e instanceof z.ZodError || e instanceof SyntaxError
        ? new HubError("invalid_request", "Verifique os campos da solicitação.", 400)
        : new HubError("operation_failed", "Não foi possível concluir a operação.", 500);
      return json(
        { code: err.code, message: err.message },
        err.status,
        err.status === 401
          ? {
            "WWW-Authenticate": `Bearer resource_metadata="${
              config.auth.resource.replace(/\/mcp$/, "")
            }/.well-known/oauth-protected-resource"`,
          }
          : {},
      );
    }
  };
}
