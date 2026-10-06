import { Hub } from "./domain.ts";
import { type AuthConfig, createVerifier } from "./auth.ts";
import { createHandler } from "./http.ts";
import type { ConnectionService } from "./connections.ts";
import type { GoogleConnections } from "./google_connections.ts";
import type { PersistentActionStore } from "./approval_store.ts";

/** Supabase terminates TLS and forwards /<function>/... over HTTP to the runtime. */
export function createSupabaseGatewayHandler(
  handler: (req: Request) => Promise<Response>,
  publicUrl: string,
) {
  const base = new URL(publicUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Base Supabase inválida.");
  }
  const publicPrefix = base.pathname.replace(/\/+$/, "");
  if (!/^\/functions\/v1\/[a-z][a-z0-9_-]*$/.test(publicPrefix)) {
    throw new Error("Prefixo Supabase inválido.");
  }
  const runtimePrefix = "/" + publicPrefix.split("/").at(-1);
  const internalOrigin = "http://" + base.host;
  return (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (
      url.origin === base.origin &&
      (url.pathname === publicPrefix || url.pathname.startsWith(publicPrefix + "/"))
    ) {
      return handler(req);
    }
    // Match the configured gateway host/path; never trust caller-supplied forwarded headers.
    if (
      url.origin !== internalOrigin ||
      !(url.pathname === runtimePrefix || url.pathname.startsWith(runtimePrefix + "/"))
    ) {
      return Promise.resolve(Response.json({ code: "not_found" }, { status: 404 }));
    }
    const canonical = new URL(base);
    canonical.pathname = publicPrefix + url.pathname.slice(runtimePrefix.length);
    canonical.search = url.search;
    return handler(new Request(canonical, req));
  };
}

/** Function gateway adapter; PUBLIC_URL is the exact authorized function base. */
export function createEdgeHandler(
  hub: Hub,
  auth: AuthConfig,
  publicUrl: string,
  connections?: ConnectionService,
  google?: GoogleConnections,
  ui?: {
    origin: string;
    supabaseUrl?: string;
    publishableKey?: string;
    actions?: PersistentActionStore;
  },
) {
  const base = new URL(publicUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("O endpoint remoto exige uma base HTTPS sem parâmetros.");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const canonical = base.origin + prefix;
  const uiUrl = new URL(ui?.origin ?? base.origin);
  if (
    uiUrl.protocol !== "https:" || uiUrl.origin !== (ui?.origin ?? base.origin) ||
    uiUrl.username || uiUrl.password
  ) throw new Error("A interface remota exige uma origem HTTPS exata.");
  if (auth.resource !== `${canonical}/mcp`) {
    throw new Error("O recurso autenticado deve corresponder ao endpoint configurado.");
  }
  const core = createHandler(hub, {
    auth,
    publicUrl: uiUrl.origin,
    supabaseUrl: ui?.supabaseUrl,
    publishableKey: ui?.publishableKey,
    verify: createVerifier(auth),
    connections,
    google,
    actions: ui?.actions,
  });
  return async (req: Request) => {
    const original = new URL(req.url);
    let route = original.pathname;
    if (original.origin !== base.origin) {
      return Response.json({ code: "not_found" }, { status: 404 });
    }
    if (route === prefix) route = "/mcp";
    else if (route.startsWith(prefix + "/")) route = route.slice(prefix.length);
    else return Response.json({ code: "not_found" }, { status: 404 });
    // Web UI is delivered separately; no filesystem-dependent asset lookup in Edge.
    if (
      ![
        "/mcp",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
        "/health",
      ].includes(route) && !route.startsWith("/api/")
    ) return Response.json({ code: "not_found" }, { status: 404 });
    const origin = req.headers.get("origin");
    if (origin && origin !== uiUrl.origin) {
      return Response.json({ code: "origin_denied" }, { status: 403 });
    }
    const cors = (response: Response) => {
      if (origin) {
        response.headers.set("Access-Control-Allow-Origin", uiUrl.origin);
        response.headers.set("Vary", "Origin");
        response.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate");
      }
      return response;
    };
    if (req.method === "OPTIONS") {
      const method = req.headers.get("access-control-request-method");
      const headers = (req.headers.get("access-control-request-headers") ?? "")
        .toLowerCase().split(",").map((h) => h.trim()).filter(Boolean);
      if (
        !origin || !["GET", "POST"].includes(method ?? "") ||
        headers.some((h) => !["authorization", "content-type", "mcp-protocol-version"].includes(h))
      ) {
        return cors(Response.json({ code: "preflight_denied" }, { status: 403 }));
      }
      return cors(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
            "Cache-Control": "no-store",
          },
        }),
      );
    }
    const url = new URL(req.url);
    url.pathname = route;
    const transformed = new Request(url, req);
    const result = await core(transformed);
    if (result.status === 401) {
      result.headers.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${canonical}/.well-known/oauth-protected-resource"`,
      );
    }
    return cors(result);
  };
}
