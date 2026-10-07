import { createHostSessionProbe } from "../scripts/lab/host_identity.ts";
import { createVerifier } from "../src/auth.ts";
import { generateKeyPair, SignJWT } from "jose";

const OWNER = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const ORIGIN = "https://abcdefghijklmnopqrst.supabase.co";
const assert = (value: unknown, message = "assertion failed"): void => {
  if (!value) throw Error(message);
};
function fixture(fetcher: typeof fetch, extra: Record<string, unknown> = {}) {
  let credentials = 0;
  const controller = new AbortController();
  const probe = createHostSessionProbe({
    identityOrigin: ORIGIN,
    ownerId: OWNER,
    expiresAt: Date.now() + 60000,
    signal: controller.signal,
    credential: () => {
      credentials++;
      return Promise.resolve("synthetic-test-credential");
    },
    fetcher,
    ...extra,
  });
  return { probe, controller, credentials: () => credentials };
}

Deno.test("host Lab lookup is one fixed SELECT with native owner/session and no redirects", async () => {
  let calls = 0;
  const f = fixture((input, init) => {
    calls++;
    assert(
      String(input) === "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query",
    );
    assert(init?.method === "POST" && init.redirect === "error");
    const payload = JSON.parse(String(init?.body));
    assert(Object.keys(payload).join() === "query");
    assert(
      payload.query ===
        `select exists(select 1 from auth.sessions where user_id='${OWNER}'::uuid and id='${SESSION}'::uuid) as active`,
    );
    assert(init?.signal instanceof AbortSignal);
    return Promise.resolve(Response.json([{ active: true }]));
  });
  assert(await f.probe(OWNER, SESSION));
  assert(calls === 1 && f.credentials() === 1);
});

Deno.test("host Lab rejects owner, injected session, expiry and cancellation before credentials", async () => {
  let calls = 0;
  const f = fixture(() => {
    calls++;
    throw Error("must not dispatch");
  });
  assert(!await f.probe(SESSION, SESSION));
  assert(!await f.probe(OWNER, "x'; delete from auth.sessions; --"));
  f.controller.abort();
  assert(!await f.probe(OWNER, SESSION));
  const expired = fixture(() => {
    calls++;
    throw Error("must not dispatch");
  }, { expiresAt: 1 });
  assert(!await expired.probe(OWNER, SESSION));
  assert(calls === 0 && f.credentials() === 0 && expired.credentials() === 0);
});

Deno.test("host Lab native session lookup fails closed for revoked and malformed responses", async () => {
  for (
    const response of [
      Response.json([{ active: false }]),
      Response.json([]),
      Response.json([{ active: "true" }]),
      Response.json([{ active: true }, { active: true }]),
      new Response("invalid json"),
      new Response("x".repeat(4097)),
      new Response(null, { status: 403 }),
      new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    ]
  ) {
    const f = fixture(() => Promise.resolve(response));
    assert(!await f.probe(OWNER, SESSION));
  }
  assert(!await fixture(() => Promise.reject(Error("provider secret text"))).probe(OWNER, SESSION));
});

Deno.test("host Lab expires while credential or provider request is in flight", async () => {
  let now = 10, calls = 0;
  const f = fixture(() => {
    calls++;
    return Promise.resolve(Response.json([{ active: true }]));
  }, {
    now: () => now,
    expiresAt: 20,
    credential: () => {
      now = 20;
      return Promise.resolve("synthetic");
    },
  });
  assert(!await f.probe(OWNER, SESSION) && calls === 0);
  now = 10;
  const duringResponse = fixture(() => {
    now = 20;
    return Promise.resolve(Response.json([{ active: true }]));
  }, {
    now: () => now,
    expiresAt: 20,
  });
  assert(!await duringResponse.probe(OWNER, SESSION));
});

Deno.test("host Lab refuses a different endpoint shape without any request", () => {
  for (
    const identityOrigin of [
      "http://abcdefghijklmnopqrst.supabase.co",
      "https://abcdefghijklmnopqrst.supabase.co.other.example",
      ORIGIN + "/other",
      ORIGIN + "?query=1",
      ORIGIN + "#fragment",
      "https://user:password@abcdefghijklmnopqrst.supabase.co",
    ]
  ) {
    let refused = false;
    try {
      fixture(() => Promise.reject(Error("no request")), { identityOrigin });
    } catch {
      refused = true;
    }
    assert(refused);
  }
});

Deno.test("host Lab verifies signed JWT and client before querying native sessions", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return Promise.resolve(Response.json([{ active: true }]));
  });
  const verify = createVerifier({
    issuer: ORIGIN + "/auth/v1",
    audience: "authenticated",
    resource: "https://lab.example/mcp",
    allowedClientIds: ["synthetic-host-client"],
    key: () => Promise.resolve(publicKey),
    sessionActive: f.probe,
  });
  const signed = async (client: string) =>
    await new SignJWT({ role: "authenticated", session_id: SESSION, client_id: client })
      .setProtectedHeader({ alg: "ES256" }).setSubject(OWNER).setIssuer(ORIGIN + "/auth/v1")
      .setAudience("authenticated").setIssuedAt().setExpirationTime("2m").sign(privateKey);
  for (const token of ["not-a-jwt", await signed("different-client")]) {
    let rejected = false;
    try {
      await verify(
        new Request("https://lab.example/mcp", { headers: { authorization: "Bearer " + token } }),
      );
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
  assert(calls === 0 && f.credentials() === 0);
  const p = await verify(
    new Request("https://lab.example/mcp", {
      headers: { authorization: "Bearer " + await signed("synthetic-host-client") },
    }),
  );
  assert(p.ownerId === OWNER && p.sessionId === SESSION && calls === 1);
});
