import { Hub } from "./domain.ts";
import { type AuthConfig, createVerifier } from "./auth.ts";
import { createHandler } from "./http.ts";
import type { ConnectionService } from "./connections.ts";
import type { GoogleConnections } from "./google_connections.ts";

/** Function gateway adapter; PUBLIC_URL is the exact authorized function base. */
export function createEdgeHandler(
  hub: Hub,
  auth: AuthConfig,
  publicUrl: string,
  connections?: ConnectionService,
  google?: GoogleConnections,
) {
  const base = new URL(publicUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("O endpoint remoto exige uma base HTTPS sem parâmetros.");
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const canonical = base.origin + prefix;
  if (auth.resource !== `${canonical}/mcp`) {
    throw new Error("O recurso autenticado deve corresponder ao endpoint configurado.");
  }
  const core = createHandler(hub, {
    auth,
    publicUrl: base.origin,
    verify: createVerifier(auth),
    connections,
    google,
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
      ].includes(route)
    ) return Response.json({ code: "not_found" }, { status: 404 });
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
    return result;
  };
}
