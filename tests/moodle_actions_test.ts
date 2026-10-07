import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { PersistentActionStore } from "../src/approval_store.ts";
import { MoodleAdapter } from "../src/adapters/moodle.ts";
import { MoodleActions, submissionContentPlugins } from "../src/moodle_actions.ts";
import type { ConnectionService } from "../src/connections.ts";

Deno.test("assignment approval ignores materialized empty plugin shells but retains content", () => {
  const empty = [
    {
      type: "file",
      name: "File submissions",
      fileareas: [{ area: "submission_files", files: [] }],
    },
    { type: "comments", name: "Submission comments" },
  ];
  assert.deepEqual(submissionContentPlugins(empty), submissionContentPlugins(undefined));
  const file = {
    type: "file",
    fileareas: [{ area: "submission_files", files: [{ filename: "draft.pdf", filesize: 7 }] }],
  };
  const editor = {
    type: "onlinetext",
    editorfields: [{ name: "onlinetext", text: "Existing answer", format: 1 }],
  };
  const unknown = { type: "custom", new_content_field: "preserve" };
  assert.deepEqual(submissionContentPlugins([...empty, file, editor, unknown]), [
    file,
    editor,
    unknown,
  ]);
});

async function fixture() {
  const db = createDb(
      Deno.env.get("LOCAL_DATABASE_URL") ??
        "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub",
    ),
    hub = new Hub(db);
  const browser = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() },
    mcp = { ...browser, clientId: "synthetic-client" };
  await db`insert into auth.users(id) values(${browser.ownerId})`;
  const c = await hub.connect(browser, "moodle", "Lab", "https://moodle.example.org", "7", {});
  const store = new PersistentActionStore(db, { sessionActive: () => Promise.resolve(true) });
  let writes = 0, timeout = false, title = "Synthetic forum";
  const functions = [
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_course_get_contents",
    "mod_forum_get_forums_by_courses",
    "mod_forum_get_forum_access_information",
    "mod_forum_get_forum_discussions",
    "mod_forum_get_discussion_posts",
    "mod_forum_add_discussion",
    "mod_forum_add_discussion_post",
  ];
  const posts: Array<Record<string, unknown>> = [{
    id: 20,
    parentid: 0,
    subject: "Peer",
    message: "<p>Context</p>",
    author: { id: 8 },
  }];
  const adapter = () =>
    new MoodleAdapter({ origin: "https://moodle.example.org", token: "synthetic-token" }, {
      fetch: async (input, init) => {
        const form = new URLSearchParams(String(init?.body)), fn = form.get("wsfunction");
        let data: unknown;
        switch (fn) {
          case "core_webservice_get_site_info":
            data = {
              userid: 7,
              username: "student",
              siteurl: "https://moodle.example.org",
              functions: functions.map((name) => ({ name })),
            };
            break;
          case "core_enrol_get_users_courses":
            data = [{ id: 1, fullname: "Synthetic course" }];
            break;
          case "core_course_get_contents":
            data = [{
              id: 1,
              modules: [{
                id: 3,
                instance: 4,
                modname: "forum",
                name: title,
                uservisible: true,
                groupmode: 0,
              }],
            }];
            break;
          case "mod_forum_get_forums_by_courses":
            data = [{
              id: 4,
              name: title,
              type: "general",
              intro: "Rules",
              maxattachments: 0,
              maxbytes: 1024,
            }];
            break;
          case "mod_forum_get_forum_access_information":
            data = { canstartdiscussion: true, canreplypost: true, warnings: [] };
            break;
          case "mod_forum_get_forum_discussions":
            data = {
              discussions: [{ id: 20, discussion: 9, canreply: true, locked: false }],
              warnings: [],
            };
            break;
          case "mod_forum_get_discussion_posts":
            data = { posts, warnings: [] };
            break;
          case "mod_forum_add_discussion_post":
          case "mod_forum_add_discussion": {
            writes++;
            const id = 30 + writes;
            posts.push({
              id,
              parentid: fn === "mod_forum_add_discussion_post" ? Number(form.get("postid")) : 0,
              subject: form.get("subject"),
              message: form.get("message"),
              author: { id: 7 },
              attachments: [],
            });
            if (timeout) throw new DOMException("synthetic lost response", "TimeoutError");
            data = { postid: id, discussionid: 9, warnings: [] };
            break;
          }
          default:
            throw Error("unexpected " + fn);
        }
        return Response.json(data);
      },
    });
  const connections = {
    parent: async () => ({ id: c.id, label: "Lab", provider_subject: "7", oauth_epoch: 0 }),
    moodle: async () => adapter(),
  } as unknown as ConnectionService;
  return {
    db,
    hub,
    browser,
    mcp,
    c,
    store,
    service: new MoodleActions(hub, connections, store),
    writes: () => writes,
    timeout: () => {
      timeout = true;
    },
    rename: () => {
      title = "Changed";
    },
    close: async () => {
      await db`delete from auth.users where id=${browser.ownerId}`;
      await db.end();
    },
  };
}
const input = (id: string) => ({
  connection_id: id,
  course_id: 1,
  cmid: 3,
  kind: "forum.reply",
  discussion_id: 9,
  parent_id: 20,
  subject: "Reply",
  body: "Texto com <dado> & autor.",
  file_ids: [],
});
Deno.test("academic approval binds content, MCP cannot approve, concurrent retry sends once and receipt persists", async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare(f.mcp, input(f.c.id));
    assert.equal(f.writes(), 0);
    await assert.rejects(() => f.service.execute(f.mcp, prepared.action_id), /Autorize/);
    await assert.rejects(
      () => f.store.approve(f.mcp, prepared.action_id),
      /interface|navegador|sessão/i,
    );
    await f.store.approve(f.browser, prepared.action_id, { expectedHash: prepared.content_hash });
    const results = await Promise.allSettled([
      f.service.execute(f.mcp, prepared.action_id),
      f.service.execute(f.mcp, prepared.action_id),
    ]);
    assert.equal(f.writes(), 1);
    assert.ok(results.some((r) => r.status === "fulfilled" && r.value.state === "succeeded"));
    const retry = await f.service.execute(f.mcp, prepared.action_id);
    assert.equal(retry.state, "succeeded");
    assert.equal(f.writes(), 1);
    const read = await f.service.read(f.mcp, prepared.action_id);
    assert.equal(read.external_state_verified, true);
    assert.ok(read.steps.some((s) => s.content.stage === "confirmed"));
    await assert.rejects(() => f.service.prepare(f.mcp, { ...input(f.c.id), approved: true }));
  } finally {
    await f.close();
  }
});
Deno.test("academic preconditions abort before effect and lost provider response is never retried", async () => {
  const f = await fixture();
  try {
    const a = await f.service.prepare(f.mcp, input(f.c.id));
    await f.store.approve(f.browser, a.action_id);
    f.rename();
    await assert.rejects(() => f.service.execute(f.mcp, a.action_id), /mudaram/);
    assert.equal(f.writes(), 0);
    const b = await f.service.prepare(f.mcp, input(f.c.id));
    await f.store.approve(f.browser, b.action_id);
    f.timeout();
    assert.equal((await f.service.execute(f.mcp, b.action_id)).state, "uncertain");
    assert.equal(f.writes(), 1);
    assert.equal((await f.service.execute(f.mcp, b.action_id)).state, "uncertain");
    assert.equal(f.writes(), 1);
    const receipt = await f.service.read(f.mcp, b.action_id);
    assert.equal(receipt.external_state_verified, false);
    assert.ok(
      receipt.steps.some((s) =>
        s.content.stage === "uncertain" && s.content.error_code && s.content.retry_allowed === false
      ),
    );
  } finally {
    await f.close();
  }
});
Deno.test("authorship statement requires a separate browser assent and content hash", async () => {
  const f = await fixture();
  try {
    const action = await f.store.prepare(f.mcp, {
      connectionId: f.c.id,
      operation: "moodle.assignment.submit",
      target: "1/3/4",
      content: { statement: { required: true, text: "Synthetic authorship statement" } },
    });
    await assert.rejects(() => f.store.approve(f.browser, action.id), /declaração/);
    await assert.rejects(() => f.store.approve(f.mcp, action.id, { statementAccepted: true }));
    await f.store.approve(f.browser, action.id, {
      expectedHash: action.hash,
      statementAccepted: true,
    });
    assert.equal((await f.store.load(f.mcp, action.id))?.state, "approved");
  } finally {
    await f.close();
  }
});
