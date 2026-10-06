// Real preserved PDF + local Postgres and actual HTTP/MCP SDK. Identity is synthetic.
// Never fetches arbitrary URLs or prints document text. Outputs private evidence only.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { createHandler } from "../src/http.ts";
import { createVerifier } from "../src/auth.ts";
import { sha256Hex } from "../src/migration.ts";

if (Deno.args.length !== 2) {
  throw new Error("Uso: validate_pdf_real.ts <PDF privado> <URL pública da fonte>");
}
const source = new URL(Deno.args[1]);
if (
  source.protocol !== "https:" || source.username || source.password || source.search || source.hash
) {
  throw new Error("Fonte exige HTTPS sem credenciais/consulta/fragmento.");
}
const bytes = await Deno.readFile(Deno.args[0]);
if (bytes.length > 20 * 1024 * 1024 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
  throw new Error("Arquivo não é um PDF dentro do limite.");
}
const hash = await sha256Hex(bytes);
const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
const owner = crypto.randomUUID(), other = crypto.randomUUID(), session = crypto.randomUUID();
const base = "http://127.0.0.1:8789";
const { privateKey, publicKey } = await generateKeyPair("ES256");
const issuer = "https://identity.local-probe.invalid/auth";
const auth = {
  issuer,
  audience: "authenticated",
  resource: base + "/mcp",
  allowedClientIds: ["local-pdf-probe"],
  key: createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "probe", alg: "ES256" }] }),
  sessionActive: (user: string, sid: string) =>
    Promise.resolve((user === owner || user === other) && sid === session),
};
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 8789, onListen() {} },
  createHandler(new Hub(db), { auth, publicUrl: base, verify: createVerifier(auth) }),
);
const clients: Client[] = [];
const connect = async (user = owner) => {
  const token = await new SignJWT({
    role: "authenticated",
    session_id: session,
    client_id: "local-pdf-probe",
  })
    .setProtectedHeader({ alg: "ES256", kid: "probe" }).setSubject(user).setIssuer(issuer)
    .setAudience(auth.audience).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const client = new Client({ name: "local-pdf-probe", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(auth.resource), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
};
const payload = (result: unknown) => {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}");
};
try {
  await db`insert into auth.users(id) values(${owner}),(${other})`;
  const [connection] =
    await db`insert into public.hub_connections(owner_id,provider,label,origin) values(${owner},'migration','Public PDF probe',${source.origin}) returning id`;
  const [entity] =
    await db`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) values(${owner},${connection.id},'resource',${source.href},'Public PDF probe',${
      db.json({
        provenance: {
          source: source.href,
          observed_at: new Date().toISOString(),
          rights: "source license; not AraHub MIT",
        },
      })
    }) returning id`;
  const [file] =
    await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content) values(${owner},${entity.id},'academic-probe.pdf','application/pdf',${hash},${bytes.length},${
      Buffer.from(bytes)
    }) returning id`;
  const first = await connect();
  const limited = payload(
    await first.callTool({
      name: "hub_extract_pdf",
      arguments: { file_id: file.id, sha256: hash, max_pages: 2 },
    }),
  );
  assert.equal(limited.memory.pages, 2);
  assert.equal(limited.memory.complete, false);
  await first.close();
  const resumed = await connect();
  const page = payload(
    await resumed.callTool({
      name: "hub_pdf_page",
      arguments: { file_id: file.id, sha256: hash, page: 1 },
    }),
  );
  assert.equal(page.sha256, hash);
  assert.equal(page.page.locator, "pdf:page:1");
  assert.match(page.page.text, /Attention/);
  assert.equal(page.content_is_untrusted_data, true);
  const full = payload(
    await resumed.callTool({
      name: "hub_extract_pdf",
      arguments: { file_id: file.id, sha256: hash },
    }),
  );
  assert.equal(full.memory.complete, true);
  assert.ok(full.memory.pages > 2);
  const stranger = await connect(other);
  const denied = await stranger.callTool({
    name: "hub_pdf_page",
    arguments: { file_id: file.id, sha256: hash, page: 1 },
  });
  assert.equal(denied.isError, true);
  assert.equal(payload(denied).code, "not_found");
  const changed = await resumed.callTool({
    name: "hub_pdf_page",
    arguments: { file_id: file.id, sha256: "0".repeat(64), page: 1 },
  });
  assert.equal(changed.isError, true);
  assert.equal(payload(changed).code, "file_changed");
  await Deno.mkdir(".private/evidence", { recursive: true });
  const evidence = ".private/evidence/pdf-real-" + crypto.randomUUID() + ".json";
  await Deno.writeTextFile(
    evidence,
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        source: source.href,
        sha256: hash,
        bytes: bytes.length,
        pages: full.memory.pages,
        owner,
        file_id: file.id,
        real_pdf: true,
        real_sql: true,
        real_http_sdk: true,
        synthetic_identity: true,
        partial_then_complete: true,
        new_client_retrieval: true,
        foreign_owner_denied: true,
        changed_hash_denied: true,
        hosted: false,
        ocr: "not_performed",
      },
      null,
      2,
    ) + "\n",
    { createNew: true },
  );
  console.log(
    JSON.stringify({
      approved: true,
      bytes: bytes.length,
      pages: full.memory.pages,
      evidence,
      hosted: false,
    }),
  );
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await server.shutdown();
  await db.end();
}
