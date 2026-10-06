import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { handleMcp } from "./mcp.ts";
import { type AuthConfig, discovery } from "./auth.ts";
import { boundedBody } from "./network.ts";
import type { ConnectionService } from "./connections.ts";
import { Sync } from "./sync.ts";
import { z } from "zod";
import type { GoogleConnections } from "./google_connections.ts";
import { GoogleReads } from "./google_reads.ts";
import type { PersistentActionStore } from "./approval_store.ts";
import { Materials } from "./materials.ts";

interface HttpConfig {
  auth: Pick<AuthConfig, "resource" | "issuer">;
  verify: (req: Request, mcp?: boolean) => Promise<Principal>;
  publicUrl: string;
  supabaseUrl?: string;
  publishableKey?: string;
  syntheticLogin?: () => Promise<string>;
  connections?: ConnectionService;
  google?: GoogleConnections;
  actions?: PersistentActionStore;
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
          canConnectGoogle: !!config.google && !config.syntheticLogin,
          canApproveActions: !!config.actions && !config.syntheticLogin,
          canExtractPdf: !config.syntheticLogin,
        });
      }
      if (u.pathname === "/api/synthetic-login" && req.method === "POST" && config.syntheticLogin) {
        return json({ access_token: await config.syntheticLogin(), mode: "synthetic" });
      }
      if (u.pathname === "/privacy.html" && req.method === "GET") {
        return new Response(await Deno.readTextFile(new URL("../web/privacy.html", import.meta.url)), {
          headers: { ...safeHeaders, "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (
        u.pathname === "/" || u.pathname === "/oauth/consent" ||
        u.pathname === "/oauth/google/callback"
      ) {
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
      if (["/ui/app.js", "/ui/style.css", "/ui/pdf-parser.worker.js"].includes(u.pathname)) {
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
            config.google,
            config.actions,
          );
        }
        return await handleMcp(req, hub, p, config.connections, config.google, config.actions);
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
          return json(
            await config.actions.approve(p, input.action_id, { expectedHash: input.content_hash }),
          );
        }
        await config.actions.deny(p, input.action_id, { expectedHash: input.content_hash });
        return json({ state: "denied" });
      }
      if (
        u.pathname === "/api/connections/google/check" && req.method === "POST" && config.google &&
        !config.syntheticLogin
      ) {
        const p = await config.verify(req, false);
        const input = z.object({ connection_id: z.string().uuid() }).strict()
          .parse(JSON.parse(await boundedBody(req, 2048)));
        return json(await new GoogleReads(hub, config.google).check(p, input.connection_id));
      }
      if (
        u.pathname === "/api/connections/google/start" && req.method === "POST" && config.google &&
        !config.syntheticLogin
      ) {
        const p = await config.verify(req, false),
          input = z.object({
            label: z.string().min(1).max(120),
            scopes: z.array(z.string().max(200)).min(1).max(12),
            connection_id: z.string().uuid().optional(),
          }).strict().parse(JSON.parse(await boundedBody(req, 4096)));
        return json(await config.google.start(p, input));
      }
      if (
        u.pathname === "/api/connections/google/callback" && req.method === "POST" &&
        config.google && !config.syntheticLogin
      ) {
        const p = await config.verify(req, false),
          input = z.object({
            state: z.string().min(8).max(200),
            code: z.string().min(1).max(4096).optional(),
            error: z.string().max(100).optional(),
          }).strict().parse(JSON.parse(await boundedBody(req, 8192)));
        return json(await config.google.callback(p, input));
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
        u.pathname === "/api/connections/disconnect" && req.method === "POST" && config.connections
      ) {
        const p = await config.verify(req, false);
        const input = z.object({ connection_id: z.string().uuid() }).strict().parse(
          JSON.parse(await boundedBody(req, 1024)),
        );
        const parent = await config.connections.parent(p, input.connection_id);
        if (parent.provider === "google" && config.google) {
          return json(await config.google.disconnect(p, input.connection_id));
        }
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
