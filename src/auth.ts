import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { HubError, type Principal } from "./contracts.ts";

export interface AuthConfig {
  issuer: string;
  audience: string;
  resource: string;
  allowedClientIds: string[];
  key?: JWTVerifyGetKey;
  sessionActive: (ownerId: string, sessionId: string) => Promise<boolean>;
}
export function createVerifier(config: AuthConfig) {
  const key = config.key ?? createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`));
  return async (req: Request, mcp = true): Promise<Principal> => {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      throw new HubError("unauthorized", "Entre no AraHub para continuar.", 401);
    }
    try {
      const { payload } = await jwtVerify(auth.slice(7), key, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["ES256", "RS256"],
        requiredClaims: ["sub", "exp", "iat", "session_id"],
      });
      if (
        payload.role !== "authenticated" || payload.is_anonymous === true ||
        typeof payload.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sub) ||
        typeof payload.session_id !== "string"
      ) throw new Error();
      if (
        mcp &&
        (typeof payload.client_id !== "string" ||
          !config.allowedClientIds.includes(payload.client_id))
      ) throw new Error();
      // Supabase default aud='authenticated'; signed client allowlist binds MCP capability.
      // A resource audience can be configured via a provider hook, never invented at runtime.
      if (!await config.sessionActive(payload.sub, payload.session_id)) throw new Error();
      return {
        ownerId: payload.sub,
        clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
      };
    } catch {
      throw new HubError(
        "unauthorized",
        "Sessão expirada ou acesso revogado. Conecte novamente.",
        401,
      );
    }
  };
}
export function discovery(config: Pick<AuthConfig, "resource" | "issuer">) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
  };
}
