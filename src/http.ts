import { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";
import { handleMcp } from "./mcp.ts";
import { type AuthConfig, discovery } from "./auth.ts";

interface HttpConfig {
  auth: Pick<AuthConfig, "resource" | "issuer">;
  verify: (req: Request, mcp?: boolean) => Promise<Principal>;
  publicUrl: string;
  supabaseUrl?: string;
  publishableKey?: string;
  syntheticLogin?: () => Promise<string>;
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
          state: "local_available",
          external_deployment: "not_verified",
        });
      }
      if (
        u.pathname === "/.well-known/oauth-protected-resource" ||
        u.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) return json(discovery(config.auth));
      if (u.pathname === "/api/config") {
        return json({
          supabaseUrl: config.supabaseUrl ?? null,
          publishableKey: config.publishableKey ?? null,
          synthetic: !!config.syntheticLogin,
        });
      }
      if (u.pathname === "/api/synthetic-login" && req.method === "POST" && config.syntheticLogin) {
        return json({ access_token: await config.syntheticLogin(), mode: "synthetic" });
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
      if (u.pathname === "/ui/app.js" || u.pathname === "/ui/style.css") {
        const name = u.pathname.endsWith(".js") ? "app.js" : "style.css";
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
          const raw = await req.text();
          if (new TextEncoder().encode(raw).length > 128 * 1024) {
            return json({ code: "limit_exceeded" }, 413);
          }
          return await handleMcp(
            new Request(req.url, { method: req.method, headers: req.headers, body: raw }),
            hub,
            p,
          );
        }
        return await handleMcp(req, hub, p);
      }
      if (u.pathname === "/api/context") {
        if (req.method !== "GET") return json({ code: "method_not_allowed" }, 405);
        return json(await hub.context(await config.verify(req, false)));
      }
      if (u.pathname === "/api/export" && req.method === "GET") {
        return json(await hub.exportMemory(await config.verify(req, false)));
      }
      return json({ code: "not_found" }, 404);
    } catch (e) {
      const err = e instanceof HubError
        ? e
        : new HubError("operation_failed", "Não foi possível concluir a operação.", 500);
      return json(
        { code: err.code, message: err.message },
        err.status,
        err.status === 401
          ? {
            "WWW-Authenticate":
              `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`,
          }
          : {},
      );
    }
  };
}
