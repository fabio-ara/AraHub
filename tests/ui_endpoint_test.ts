import assert from "node:assert/strict";
import { apiEndpoint } from "../web/endpoint.ts";

Deno.test("UI mantém prefixo remoto e rejeita rotas/base com escape de autoridade", () => {
  assert.equal(apiEndpoint("", "/api/context"), "/api/context");
  assert.equal(
    apiEndpoint("https://backend.invalid/functions/v1/arahub/", "/api/context"),
    "https://backend.invalid/functions/v1/arahub/api/context",
  );
  for (
    const path of [
      "//evil.invalid/api/context",
      "/api/../context",
      "/api/%2e%2e/",
      "/api/context?token=x",
    ]
  ) {
    assert.throws(() => apiEndpoint("https://backend.invalid", path));
  }
  for (
    const base of [
      "http://backend.invalid",
      "https://user:secret@backend.invalid",
      "https://backend.invalid/?secret=x",
    ]
  ) {
    assert.throws(() => apiEndpoint(base, "/api/context"));
  }
});
