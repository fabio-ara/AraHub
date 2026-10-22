import assert from "node:assert/strict";
import { DEFAULT_LOGIN, loginConfig } from "../src/login_config.ts";
import { createHandler } from "../src/http.ts";
import type { Hub } from "../src/domain.ts";

Deno.test("login: padrão conserva convite; configurações inválidas falham antes de servir", () => {
  assert.deepEqual(loginConfig(() => undefined), DEFAULT_LOGIN);
  const values: Record<string, string> = {
    ARAHUB_REGISTRATION: "open",
    ARAHUB_LOGIN_EMAIL_LINK: "false",
    ARAHUB_LOGIN_PASSWORD: "true",
    ARAHUB_LOGIN_PROVIDERS: "google, github,google",
  };
  assert.deepEqual(loginConfig((n) => values[n]), {
    registration: "open",
    emailLink: false,
    password: true,
    providers: ["google", "github"],
  });
  for (
    const bad of [
      { ARAHUB_REGISTRATION: "public" },
      { ARAHUB_LOGIN_PASSWORD: "yes" },
      { ARAHUB_LOGIN_PROVIDERS: "https://evil.invalid" },
      { ARAHUB_LOGIN_EMAIL_LINK: "false" },
    ]
  ) assert.throws(() => loginConfig((n) => (bad as Record<string, string | undefined>)[n]));
});

Deno.test("login: configuração pública e callback não precisam de sessão; API continua protegida", async () => {
  let verified = 0;
  const handler = createHandler({} as Hub, {
    publicUrl: "http://127.0.0.1:8787",
    auth: { issuer: "https://identity.invalid/auth/v1", resource: "http://127.0.0.1:8787/mcp" },
    verify: async () => {
      verified++;
      throw new Error("verification required");
    },
    login: { registration: "open", emailLink: true, password: true, providers: ["github"] },
  });
  const response = await handler(new Request("http://127.0.0.1:8787/api/config"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).login.providers, ["github"]);
  const callback = await handler(new Request("http://127.0.0.1:8787/oauth/callback?code=fixture"));
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /<title>AraHub<\/title>/);
  assert.equal(verified, 0);
  await handler(new Request("http://127.0.0.1:8787/api/context"));
  assert.equal(verified, 1);
});
