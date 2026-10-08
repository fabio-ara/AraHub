import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { HubError } from "../src/contracts.ts";
import { ConnectionService } from "../src/connections.ts";
import { TokenVault } from "../src/adapters/token_vault.ts";
import { isBlockedFunction, MoodleAdapter, type MoodleDeps } from "../src/adapters/moodle.ts";
import {
  OWN_STATUS_POLICY_VERSION,
  OwnSubmissionStatusPolicies,
} from "../src/own_submission_status.ts";
import { createHandler } from "../src/http.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function fixture() {
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db),
    browser = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const other = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  await db`insert into auth.users(id) values(${browser.ownerId}),(${other.ownerId})`;
  let active = true, group = false, own = true, enrolled = true, reads = 0;
  const sessionActive = (o: string, s: string) =>
    Promise.resolve(active && o === browser.ownerId && s === browser.sessionId);
  const policies = new OwnSubmissionStatusPolicies(db, sessionActive, true);
  const vault = await TokenVault.fromRawKeys([{
    kid: "fixture",
    key: crypto.getRandomValues(new Uint8Array(32)),
  }]);
  const functions = [
    "core_enrol_get_users_courses",
    "mod_assign_get_assignments",
    "mod_assign_get_submission_status",
  ];
  const factory = (origin: string, token: string, deps?: MoodleDeps) =>
    new MoodleAdapter({ origin, token }, {
      ...deps,
      fetch: (_url, init) => {
        const p = new URLSearchParams(String(init?.body)), fn = p.get("wsfunction");
        let result: unknown;
        switch (fn) {
          case "core_webservice_get_site_info":
            result = {
              userid: 7,
              username: "synthetic-student",
              siteurl: origin,
              functions: functions.map((name) => ({ name })),
            };
            break;
          case "core_enrol_get_users_courses":
            result = enrolled ? [{ id: 12 }] : [];
            break;
          case "mod_assign_get_assignments":
            result = {
              courses: [{ id: 12, assignments: [{ id: 34, teamsubmission: group ? 1 : 0 }] }],
            };
            break;
          case "mod_assign_get_submission_status":
            assert.equal(p.get("userid"), "0");
            assert.equal(p.get("groupid"), "0");
            assert.equal(p.get("assignid"), "34");
            reads++;
            result = { lastattempt: { submission: { userid: own ? 7 : 8, status: "new" } } };
            break;
          default:
            throw new Error("Unexpected provider function");
        }
        return Promise.resolve(Response.json(result));
      },
    });
  const connections = new ConnectionService(hub, vault, factory, policies);
  const connection = await connections.addMoodle(browser, {
    origin: "https://synthetic-status.invalid",
    label: "Synthetic status",
    token: "synthetic-secret",
  });
  const review = () => policies.review(browser, connection.id);
  const decide = async (allow: boolean) => {
    const r = await review();
    return policies.decide(browser, {
      connection_id: connection.id,
      credential_epoch: r.credential_epoch,
      last_receipt_id: r.last_receipt_id,
      policy_version: r.policy_version,
      allow,
      effects_accepted: allow,
    });
  };
  return {
    db,
    hub,
    browser,
    other,
    policies,
    connections,
    connection,
    review,
    decide,
    sessionActive,
    mcp: { ...browser, clientId: "synthetic-mcp" },
    reads: () => reads,
    group: (v: boolean) => {
      group = v;
    },
    own: (v: boolean) => {
      own = v;
    },
    enrolled: (v: boolean) => {
      enrolled = v;
    },
    active: (v: boolean) => {
      active = v;
    },
    close: async () => {
      await db`delete from auth.users where id in (${browser.ownerId},${other.ownerId})`;
      await db.end();
    },
  };
}

Deno.test("own status: disabled/default and unconsented connections never call status", async () => {
  const f = await fixture();
  try {
    const disabled = new OwnSubmissionStatusPolicies(f.db, f.sessionActive);
    await assert.rejects(disabled.review(f.browser, f.connection.id), /consentimento/);
    const m = await f.connections.moodle(f.mcp, f.connection.id);
    assert.equal((await m.getSubmissionStatus(34, 12)).error_code, "security_error");
    assert.equal(f.reads(), 0);
    assert.equal(isBlockedFunction("mod_assign_get_submission_status"), true);
  } finally {
    await f.close();
  }
});

Deno.test("own status: browser/session/owner/explanation and current revision required", async () => {
  const f = await fixture();
  try {
    const r = await f.review();
    const input = {
      connection_id: f.connection.id,
      credential_epoch: r.credential_epoch,
      last_receipt_id: null,
      policy_version: OWN_STATUS_POLICY_VERSION,
      allow: true,
      effects_accepted: true,
    };
    for (const p of [f.mcp, { ownerId: f.browser.ownerId }, f.other]) {
      await assert.rejects(f.policies.decide(p, input));
    }
    await assert.rejects(f.policies.decide(f.browser, { ...input, effects_accepted: false }));
    await assert.rejects(
      f.policies.decide(f.browser, { ...input, policy_version: "model-invented" }),
    );
    f.active(false);
    await assert.rejects(f.policies.decide(f.browser, input));
    f.active(true);
    await f.policies.decide(f.browser, input);
    await assert.rejects(
      f.policies.decide(f.browser, input),
      (e: unknown) => e instanceof HubError && e.code === "connection_changed",
    );
    assert.equal(f.reads(), 0);
    assert.equal((await f.review()).allowed, true);
  } finally {
    await f.close();
  }
});

Deno.test("own status: only individual enrolled assignment and own return; revoked adapter cannot read", async () => {
  const f = await fixture();
  try {
    await f.decide(true);
    const m = await f.connections.moodle(f.mcp, f.connection.id);
    assert.equal((await m.getSubmissionStatus(34, 12)).coverage, "complete");
    assert.equal(f.reads(), 1);
    f.group(true);
    assert.equal((await m.getSubmissionStatus(34, 12)).error_code, "security_error");
    f.group(false);
    f.enrolled(false);
    assert.equal((await m.getSubmissionStatus(34, 12)).error_code, "security_error");
    f.enrolled(true);
    assert.equal((await m.getSubmissionStatus(35, 12)).error_code, "security_error");
    assert.equal(f.reads(), 1);
    f.own(false);
    assert.equal((await m.getSubmissionStatus(34, 12)).error_code, "security_error");
    f.own(true);
    await f.decide(false);
    assert.equal((await m.getSubmissionStatus(34, 12)).error_code, "security_error");
    assert.equal(f.reads(), 2);
    assert.equal((await m.getOwnGrades(12)).error_code, "security_error");
  } finally {
    await f.close();
  }
});

Deno.test("own status: credential renewal and disconnect invalidate without erasing consent history", async () => {
  const f = await fixture();
  try {
    await f.decide(true);
    const prior = await f.connections.moodle(f.mcp, f.connection.id);
    await f.connections.addMoodle(f.browser, {
      connection_id: f.connection.id,
      origin: "https://synthetic-status.invalid",
      label: "Renewed",
      token: "synthetic-new-secret",
    });
    assert.equal((await f.review()).allowed, false);
    assert.equal((await prior.getSubmissionStatus(34, 12)).error_code, "security_error");
    await f.decide(true);
    const current = await f.connections.moodle(f.mcp, f.connection.id);
    await f.connections.disconnect(f.browser, f.connection.id);
    assert.equal((await current.getSubmissionStatus(34, 12)).error_code, "security_error");
    const [count] = await f
      .db`select count(*)::int as n from arahub_private.own_submission_status_consents where owner_id=${f.browser.ownerId}`;
    assert.equal(count.n, 2);
    assert.equal(f.reads(), 0);
  } finally {
    await f.close();
  }
});

Deno.test("own status: consent is inaccessible to Data API roles", async () => {
  const f = await fixture();
  try {
    await f.decide(true);
    for (const role of ["anon", "authenticated"]) {
      for (
        const statement of [
          "select * from arahub_private.own_submission_status_consents",
          "delete from arahub_private.own_submission_status_consents",
          "update arahub_private.own_submission_status_consents set allowed=true",
          "insert into arahub_private.own_submission_status_consents default values",
        ]
      ) {
        await assert.rejects(f.db.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx.unsafe(statement);
        }));
      }
    }
    const [r] = await f
      .db`select relrowsecurity,relforcerowsecurity from pg_class where oid='arahub_private.own_submission_status_consents'::regclass`;
    assert.equal(r.relrowsecurity, true);
    assert.equal(r.relforcerowsecurity, true);
  } finally {
    await f.close();
  }
});

Deno.test("own status: revocation serialized after dispatched read, blocks subsequent read", async () => {
  const f = await fixture();
  try {
    await f.decide(true);
    const r = await f.review();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = f.policies.run(f.mcp, f.connection.id, r.credential_epoch, 7, async () => {
      entered();
      await hold;
      return "own";
    });
    await ready;
    const revoke = f.decide(false);
    release();
    assert.equal(await read, "own");
    await revoke;
    await assert.rejects(
      f.policies.run(
        f.mcp,
        f.connection.id,
        r.credential_epoch,
        7,
        () => Promise.resolve("forbidden"),
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test("own status: trusted HTTP rejects MCP consent, forged fields, stale epoch, wrong owner", async () => {
  const f = await fixture();
  try {
    let p = f.browser as typeof f.browser & { clientId?: string };
    const handler = createHandler(f.hub, {
      auth: { resource: "http://127.0.0.1/mcp", issuer: "https://synthetic.invalid" },
      publicUrl: "http://127.0.0.1",
      verify: () => Promise.resolve(p),
      connections: f.connections,
    });
    const send = (path: string, body: unknown) =>
      handler(
        new Request("http://127.0.0.1/api/connections/own-status/" + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const review = await (await send("review", { connection_id: f.connection.id })).json();
    const input = {
      connection_id: f.connection.id,
      credential_epoch: review.credential_epoch,
      last_receipt_id: null,
      policy_version: review.policy_version,
      allow: true,
      effects_accepted: true,
    };
    p = f.mcp;
    assert.equal((await send("decide", input)).status, 403);
    p = f.browser;
    assert.equal((await send("decide", { ...input, owner_id: f.other.ownerId })).status, 400);
    assert.equal((await send("decide", { ...input, credential_epoch: 999 })).status, 409);
    assert.equal((await send("decide", input)).status, 200);
    assert.equal(f.reads(), 0);
  } finally {
    await f.close();
  }
});

Deno.test("own status: real SDK tool cannot consent, remains blocked until browser decision and after revocation", async () => {
  const f = await fixture();
  const base = "http://127.0.0.1:8790";
  const handler = createHandler(f.hub, {
    auth: { resource: base + "/mcp", issuer: "https://synthetic.invalid" },
    publicUrl: base,
    verify: () => Promise.resolve(f.mcp),
    connections: f.connections,
  });
  const server = Deno.serve({ hostname: "127.0.0.1", port: 8790, onListen: () => {} }, handler);
  const client = new Client({ name: "own-status-synthetic", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const list = await client.listTools();
    const tool = list.tools.find((t: { name: string; annotations?: { readOnlyHint?: boolean } }) =>
      t.name === "hub_moodle_own_submission_status"
    );
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(
      list.tools.some((t: { name: string }) => /consent|own_status_approve/.test(t.name)),
      false,
    );
    const call = async () => {
      const r = await client.callTool({
        name: tool.name,
        arguments: { connection_id: f.connection.id, course_id: 12, assignment_id: 34 },
      });
      return JSON.parse((r.content as Array<{ text: string }>)[0].text);
    };
    assert.equal((await call()).error_code, "security_error");
    assert.equal(f.reads(), 0);
    await f.decide(true);
    assert.equal((await call()).data.lastattempt.submission.userid, 7);
    await f.decide(false);
    assert.equal((await call()).error_code, "security_error");
    assert.equal(f.reads(), 1);
  } finally {
    await client.close();
    await server.shutdown();
    await f.close();
  }
});
