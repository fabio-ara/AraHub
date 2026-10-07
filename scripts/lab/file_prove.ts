/** Local SQL + production HTTP parser proof. No host/provider network or credentials.
 * deno run --cached-only --allow-net=127.0.0.1:55432 --allow-env --allow-read
 *   --allow-write=.private scripts/lab/file_prove.ts
 */
import assert from "node:assert/strict";
import { Artifacts, MAX_ARTIFACT_BYTES } from "../../src/artifacts.ts";
import { PinnedHttpError, readPinnedHttpResponse } from "../../src/adapters/pinned_http.ts";
import { MoodleAdapter } from "../../src/adapters/moodle.ts";
import { MoodleActions } from "../../src/moodle_actions.ts";
import { PersistentActionStore } from "../../src/approval_store.ts";
import type { ConnectionService } from "../../src/connections.ts";
import { HubError } from "../../src/contracts.ts";
import { createDb } from "../../src/db.ts";
import { Hub } from "../../src/domain.ts";
import { sha256Hex } from "../../src/migration.ts";

const encoder = new TextEncoder();
const host = "files.oaiusercontent.com";
const code = (expected: string) => (e: unknown) => e instanceof HubError && e.code === expected;

/** Split at raw byte boundaries. Refuses reads after the supplied wire prefix. */
function wireReader(wire: string, prefixOnly = false) {
  const bytes = encoder.encode(wire);
  let offset = 0, readsAfterPrefix = 0;
  return {
    read(buffer: Uint8Array): Promise<number | null> {
      if (offset === bytes.length) {
        readsAfterPrefix++;
        assert.equal(prefixOnly, false, "body must not be requested after rejection");
        return Promise.resolve(null);
      }
      const count = Math.min(7, buffer.length, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + count));
      offset += count;
      return Promise.resolve(count);
    },
    consumed: () => offset,
    readsAfterPrefix: () => readsAfterPrefix,
    length: bytes.length,
  };
}

async function fixture() {
  // Fixed target: no environment override can select a hosted database.
  const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
  const hub = new Hub(db);
  const p = {
    ownerId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    clientId: "file-proof",
  };
  const close = async () => {
    try {
      await db`delete from auth.users where id=${p.ownerId}`;
    } finally {
      await db.end();
    }
  };
  try {
    await db`insert into auth.users(id) values(${p.ownerId})`;
    const c = await hub.connect(
      p,
      "moodle",
      "Synthetic file proof",
      "https://moodle.example.org",
      "7",
      {},
    );
    const context = await hub.createContext(p, "Synthetic file proof");
    const counts = async () => {
      const [row] = await db`select
        (select count(*)::integer from public.hub_entities where owner_id=${p.ownerId} and kind='artifact') as entities,
        (select count(*)::integer from public.hub_files where owner_id=${p.ownerId}) as files`;
      return { entities: row.entities, files: row.files };
    };
    return { db, hub, p, c, context, counts, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function proveFileRenewal() {
  const f = await fixture();
  try {
    const text = "Prova sintética: bytes preservados após renovação.";
    const bytes = encoder.encode(text);
    const attempted: string[] = [];
    const receiver = new Artifacts(f.hub, {
      hosts: [host],
      resolve: (name) => {
        assert.equal(name, host);
        return Promise.resolve(["104.18.1.1"]);
      },
      send: async (options) => {
        assert.equal(options.address, "104.18.1.1");
        assert.equal(options.maxBytes, MAX_ARTIFACT_BYTES);
        assert.equal(options.headers.authorization, undefined);
        const token = new URL(options.url).searchParams.get("signature")!;
        attempted.push(token);
        const response = token === "SYNTHETIC_EXPIRED"
          ? "HTTP/1.1 410 Gone\r\nContent-Length: 10000\r\n\r\n"
          : token === "SYNTHETIC_EMPTY"
          ? "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
          : `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${bytes.length}\r\n\r\n${text}`;
        return await readPinnedHttpResponse(wireReader(response, true), options.maxBytes);
      },
    });
    const expired = {
      file_id: "stable-host-file-id",
      file_name: "Revisão.txt",
      mime_type: "text/plain",
      download_url: `https://${host}/temporary-fixture?signature=SYNTHETIC_EXPIRED`,
    };
    await assert.rejects(
      () => receiver.importHost(f.p, f.c.id, f.context.id, expired),
      (e: unknown) =>
        code("download_unavailable")(e) &&
        /solicite novo acesso ao cliente/.test((e as Error).message) &&
        !/signature|SYNTHETIC_EXPIRED|temporary-fixture/.test((e as Error).message),
    );
    assert.deepEqual(await f.counts(), { entities: 0, files: 0 });
    assert.equal(attempted.length, 1, "no automatic retry of expired URL");
    // The supported renewal is a new hostFile object supplied by the client,
    // retaining file_id. AraHub does not fabricate or refresh signed URLs.
    const renewed = {
      ...expired,
      download_url: `https://${host}/temporary-fixture?signature=SYNTHETIC_RENEWED`,
    };
    const saved = await receiver.importHost(f.p, f.c.id, f.context.id, renewed);
    assert.equal(saved.source.file_id, expired.file_id);
    assert.equal(saved.sha256, await sha256Hex(bytes));
    assert.equal(saved.bytes, bytes.length);
    assert.deepEqual((await receiver.load(f.p, f.c.id, saved.id)).content, bytes);
    assert.equal((await receiver.importHost(f.p, f.c.id, f.context.id, renewed)).id, saved.id);
    await assert.rejects(
      () =>
        receiver.importHost(f.p, f.c.id, f.context.id, {
          ...renewed,
          download_url: `https://${host}/temporary-fixture?signature=SYNTHETIC_EMPTY`,
        }),
      code("limit_exceeded"),
    );
    assert.deepEqual(await f.counts(), { entities: 1, files: 1 });
    assert.deepEqual(attempted, [
      "SYNTHETIC_EXPIRED",
      "SYNTHETIC_RENEWED",
      "SYNTHETIC_RENEWED",
      "SYNTHETIC_EMPTY",
    ]);
    // Scan all owner-scoped hub rows, not only entity.state. Synthetic owner only.
    const tables = await f.db`select distinct table_name from information_schema.columns
      where table_schema='public' and left(table_name,4)='hub_' and column_name='owner_id'`;
    let scannedRows = 0;
    for (const { table_name: table } of tables) {
      assert.match(table, /^hub_[a-z_]+$/);
      const rows = await f.db.unsafe(
        `select to_jsonb(t) as row from public."${table}" t where owner_id=$1`,
        [f.p.ownerId],
      );
      scannedRows += rows.length;
      assert.doesNotMatch(
        JSON.stringify(rows),
        /oaiusercontent|temporary-fixture|SYNTHETIC_(EXPIRED|RENEWED|EMPTY)|download_url|signature=/,
      );
    }
    assert.ok(scannedRows >= 4);
    return {
      scenario: "FILE-03",
      status: "passed",
      level: "local_integration",
      fixture_sha256: saved.sha256,
      fixture_bytes: saved.bytes,
      requests: attempted.length,
      stored_files: 1,
      scanned_owner_tables: tables.length,
      scanned_owner_rows: scannedRows,
      checks: [
        "expired_410_safe_error",
        "no_body_read_or_partial_sql_on_expiry",
        "same_file_id_new_hostFile_succeeds",
        "sql_bytes_sha256_recovery",
        "renewed_retry_idempotent",
        "empty_200_rejected",
        "zero_signed_url_in_owner_hub_rows",
      ],
      limits: [
        "DNS and HTTP socket are fixtures; production HTTP parser/Artifacts/Hub/Postgres are real.",
        "New hostFile is client-supplied. Actual ChatGPT URL renewal/host handoff is not exercised.",
      ],
    };
  } finally {
    await f.close();
  }
}

export async function proveFileLimits() {
  const f = await fixture();
  try {
    let proxyLimit = 1024, moodleLimit = 512;
    let payload = "", oversizedChunk = false, lastReader = wireReader("");
    let lastTransportError: string | null = null;
    const receiver = new Artifacts(f.hub, {
      hosts: [host],
      resolve: () => Promise.resolve(["104.18.1.1"]),
      send: async (options) => {
        assert.equal(options.maxBytes, MAX_ARTIFACT_BYTES);
        const length = encoder.encode(payload).length;
        const response = oversizedChunk
          ? `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${
            (MAX_ARTIFACT_BYTES + 1).toString(16)
          }\r\n`
          : length > proxyLimit
          ? "HTTP/1.1 413 Content Too Large\r\nContent-Length: 9000\r\n\r\n"
          : `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${
            length.toString(16)
          }\r\n${payload}\r\n0\r\n\r\n`;
        lastReader = wireReader(response, true);
        lastTransportError = null;
        try {
          return await readPinnedHttpResponse(lastReader, options.maxBytes);
        } catch (error) {
          lastTransportError = error instanceof PinnedHttpError ? error.code : "unexpected_error";
          throw error;
        }
      },
    });
    const functions = [
      "core_webservice_get_site_info",
      "core_enrol_get_users_courses",
      "core_course_get_contents",
      "mod_forum_get_forums_by_courses",
      "mod_forum_get_forum_access_information",
      "mod_forum_can_add_discussion",
      "mod_forum_add_discussion",
    ];
    const providerCalls: string[] = [];
    const adapter = new MoodleAdapter({
      origin: "https://moodle.example.org",
      token: "synthetic-token",
    }, {
      fetch: (input, init) => {
        assert.equal(new URL(String(input)).origin, "https://moodle.example.org");
        const fn = new URLSearchParams(String(init?.body)).get("wsfunction")!;
        providerCalls.push(fn);
        const responses: Record<string, unknown> = {
          core_webservice_get_site_info: {
            userid: 7,
            username: "synthetic",
            siteurl: "https://moodle.example.org",
            functions: functions.map((name) => ({ name })),
          },
          core_enrol_get_users_courses: [{ id: 1, fullname: "Synthetic" }],
          core_course_get_contents: [{
            id: 1,
            modules: [{
              id: 3,
              instance: 4,
              modname: "forum",
              name: "Synthetic",
              uservisible: true,
              groupmode: 0,
            }],
          }],
          mod_forum_get_forums_by_courses: [{
            id: 4,
            name: "Synthetic",
            maxattachments: 2,
            maxbytes: moodleLimit,
          }],
          mod_forum_get_forum_access_information: {
            canstartdiscussion: true,
            cancreateattachment: true,
            warnings: [],
          },
          mod_forum_can_add_discussion: { status: true, cancreateattachment: true, warnings: [] },
        };
        assert.ok(Object.hasOwn(responses, fn), "only fixture read endpoints are allowed");
        return Promise.resolve(Response.json(responses[fn]));
      },
    });
    const connections = {
      parent: () =>
        Promise.resolve({ id: f.c.id, label: "Synthetic", provider_subject: "7", oauth_epoch: 0 }),
      moodle: () => Promise.resolve(adapter),
    } as unknown as ConnectionService;
    const store = new PersistentActionStore(f.db, { sessionActive: () => Promise.resolve(true) });
    const actions = new MoodleActions(f.hub, connections, store, receiver);
    const prepare = (ids: string[]) =>
      actions.prepare(f.p, {
        connection_id: f.c.id,
        course_id: 1,
        cmid: 3,
        kind: "forum.discussion",
        subject: "Synthetic",
        body: "Synthetic file proof",
        file_ids: ids,
      });
    const imported: Array<{ id: string; sha256: string; bytes: number }> = [];
    async function receive(size: number, name: string, id: string) {
      payload = "á" + "x".repeat(size - 2); // Character count differs from byte count.
      assert.equal(encoder.encode(payload).length, size);
      const file = await receiver.importHost(f.p, f.c.id, f.context.id, {
        file_id: id,
        file_name: name,
        download_url: `https://${host}/synthetic-boundary`,
      });
      assert.equal(file.bytes, size);
      assert.equal(file.sha256, await sha256Hex(encoder.encode(payload)));
      assert.deepEqual(
        (await receiver.load(f.p, f.c.id, file.id)).content,
        encoder.encode(payload),
      );
      imported.push(file);
      return file;
    }
    // Moodle is the minimum: 512 < proxy 1024 < AraHub 16 MiB.
    const below = await receive(511, "Revisa\u0303o final.txt", "unicode-nfd");
    const at = await receive(512, "limite.txt", "at-moodle-limit");
    for (const file of [below, at]) {
      const prepared = await prepare([file.id]);
      assert.equal(prepared.state, "prepared");
      assert.equal(prepared.review.files[0].sha256, file.sha256);
      assert.equal(prepared.external_write, false);
    }
    const over = await receive(513, "acima.txt", "over-moodle-limit");
    await assert.rejects(() => prepare([over.id]), code("file_limit"));
    // Different origins that NFC-normalize to the same name remain distinct in SQL.
    const collision = await receive(511, "Revisão final.txt", "unicode-nfc");
    assert.equal(below.name, collision.name);
    assert.notEqual(below.original_name, collision.original_name);
    assert.notEqual(below.id, collision.id);
    assert.equal(below.sha256, collision.sha256);
    await assert.rejects(() => prepare([below.id, collision.id]), code("duplicate_filename"));
    const distinct = await prepare([below.id, at.id]);
    assert.equal(distinct.review.files.length, 2);
    assert.equal(distinct.review.files[0].name, "Revisão final.txt");
    assert.equal(distinct.review.files[0].original_name, "Revisa\u0303o final.txt");
    // Swap the minimum: proxy 512 < Moodle 1024 < AraHub 16 MiB.
    proxyLimit = 512;
    moodleLimit = 1024;
    for (const size of [511, 512]) {
      const file = await receive(size, `proxy-${size}.txt`, `proxy-${size}`);
      assert.equal((await prepare([file.id])).state, "prepared");
    }
    const before = await f.counts();
    await assert.rejects(
      () => receive(513, "proxy-over.txt", "proxy-over"),
      code("download_unavailable"),
    );
    assert.equal(lastReader.consumed(), lastReader.length);
    assert.equal(lastReader.readsAfterPrefix(), 0);
    assert.equal(lastTransportError, null);
    assert.deepEqual(await f.counts(), before);
    // Real parser enforces AraHub's cap from a chunk header, without reading the
    // oversized body, allocating it, or creating a partial SQL artifact.
    oversizedChunk = true;
    await assert.rejects(
      () => receive(2, "stream-over.txt", "stream-over"),
      code("download_unavailable"),
    );
    assert.equal(lastReader.consumed(), lastReader.length);
    assert.equal(lastReader.readsAfterPrefix(), 0);
    assert.equal(lastTransportError, "limit_exceeded");
    assert.deepEqual(await f.counts(), before);
    assert.deepEqual(before, { entities: 6, files: 6 });
    const [rows] = await f
      .db`select count(*)::integer as total from public.hub_actions where owner_id=${f.p.ownerId}`;
    assert.equal(rows.total, 5, "rejections do not leave prepared actions");
    assert.ok(!providerCalls.some((fn) => fn === "mod_forum_add_discussion"));
    return {
      scenario: "FILE-05",
      status: "passed",
      level: "local_integration",
      hub_limit_bytes: MAX_ARTIFACT_BYTES,
      boundaries: [
        {
          proxy: 1024,
          moodle: 512,
          effective: 512,
          below: 511,
          at: 512,
          above: 513,
          rejecting_layer: "moodle_preflight",
        },
        {
          proxy: 512,
          moodle: 1024,
          effective: 512,
          below: 511,
          at: 512,
          above: 513,
          rejecting_layer: "proxy_http_fixture_413",
        },
      ],
      oversized_stream_declared_bytes: MAX_ARTIFACT_BYTES + 1,
      oversized_stream_wire_bytes_consumed: lastReader.consumed(),
      oversized_stream_body_reads: lastReader.readsAfterPrefix(),
      oversized_stream_error: lastTransportError,
      files: imported.map(({ sha256, bytes }) => ({ sha256, bytes })),
      stored_files: before.files,
      prepared_actions: rows.total,
      external_writes: 0,
      checks: [
        "moodle_min_below_at_above",
        "proxy_min_below_at_above",
        "utf8_byte_lengths_and_sql_digests",
        "unicode_nfc_collision_preserves_both_origins",
        "collision_rejected_before_action_or_write",
        "distinct_unicode_names_prepare",
        "chunked_stream_bounded_before_body",
        "no_partial_sql_on_transport_rejection",
      ],
      reused: [
        "tests/artifacts_test.ts: direct preserve >16 MiB rejection",
        "tests/pinned_http_test.ts: split/chunked/EOF/framing bounds",
        "tests/files_test.ts: stream cancellation",
      ],
      limits: [
        "Proxy and Moodle HTTP are fixtures; production parser/Artifacts/MoodleActions/Postgres are real.",
        "Limit is min(proxy, Moodle activity, AraHub) for file bytes in this fixture; actual proxy multipart envelope and host limits are not measured.",
        "No provider write or real host handoff; Lab quota evidence remains separate.",
      ],
    };
  } finally {
    await f.close();
  }
}

export async function recordFileProof(proof: { scenario: string }) {
  assert.ok(["FILE-03", "FILE-05"].includes(proof.scenario));
  const directory = ".private/entrega-1/materials/file-proofs";
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    `${directory}/${proof.scenario}.json`,
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        database: "127.0.0.1:55432",
        synthetic: true,
        ...proof,
      },
      null,
      2,
    ) + "\n",
  );
}

if (import.meta.main) {
  await recordFileProof(await proveFileRenewal());
  await recordFileProof(await proveFileLimits());
  console.log("FILE-03/05: provas locais aprovadas; recibos privados gravados.");
}
