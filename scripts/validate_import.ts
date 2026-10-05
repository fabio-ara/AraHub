import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { createHandler } from "../src/http.ts";
import { createVerifier } from "../src/auth.ts";
import { stableUuid } from "../src/importer.ts";
import { loadCuration, readJson, type StagingManifest } from "../src/migration.ts";
// Real imported source data, local transport + synthetic identity. No private text is logged.
const owner = await readJson<{ ownerId: string }>(".private/local-owner.json");
const manifest = await readJson<StagingManifest>(".private/migration/staging/manifest.json");
const payloads = await loadCuration(".private/migration/staging");
const records = payloads.flatMap((p) => p.records);
const db = createDb("postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub");
const { privateKey, publicKey } = await generateKeyPair("ES256"), sid = crypto.randomUUID();
const auth = {
  issuer: "https://local-fixture.invalid/auth",
  resource: "http://fixture.invalid/mcp",
  audience: "authenticated",
  allowedClientIds: ["import-regression"],
  key: createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "ES256" }] }),
  sessionActive: (o: string, s: string) => Promise.resolve(o === owner.ownerId && s === sid),
};
const token = await new SignJWT({
  role: "authenticated",
  client_id: "import-regression",
  session_id: sid,
}).setProtectedHeader({ alg: "ES256", kid: "test" }).setSubject(owner.ownerId).setIssuer(
  auth.issuer,
).setAudience(auth.audience).setIssuedAt().setExpirationTime("10m").sign(privateKey);
const handler = createHandler(new Hub(db), {
  auth,
  verify: createVerifier(auth),
  publicUrl: "http://fixture.invalid",
});
const client = new Client({ name: "new-private-conversation-fixture", version: "1.0.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(auth.resource), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        handler(new Request(input, init)),
    }),
  );
  let checked = 0;
  for (const domain of new Set(records.map((r) => r.domain))) {
    const contextId = await stableUuid(`${owner.ownerId}:${manifest.sourceLabel}:${domain}`);
    let offset: number | null = 0;
    const received: { content: string; provenance: { excerpt: string; version: string }[] }[] = [];
    while (offset !== null) {
      const result = await client.callTool({
        name: "hub_history",
        arguments: { context_id: contextId, offset },
      });
      const page = JSON.parse((result.content as { text: string }[])[0].text);
      if (!Array.isArray(page.records)) throw new Error("Recuperação do contexto falhou.");
      received.push(...page.records);
      offset = page.next_offset;
    }
    for (const record of records.filter((r) => r.domain === domain)) {
      if (
        !received.some((d) =>
          d.content === record.assertion &&
          d.provenance.some((p) =>
            p.version === manifest.commit && record.refs.some((ref) => ref.excerpt === p.excerpt)
          )
        )
      ) throw new Error("Um registro curado não foi recuperado com a proveniência esperada.");
      checked++;
    }
  }
  const listing = await client.callTool({ name: "hub_files", arguments: {} });
  const listed = JSON.parse((listing.content as { text: string }[])[0].text);
  if (!listed.records?.length) throw new Error("Documentos brutos não recuperáveis.");
  const f = listed.records[0];
  const read = await client.callTool({
    name: "hub_file_text",
    arguments: { file_id: f.id, sha256: f.sha256, limit: 500 },
  });
  const text = JSON.parse((read.content as { text: string }[])[0].text);
  if (text.sha256 !== f.sha256 || !text.excerpt) {
    throw new Error("Leitura do documento não conferiu.");
  }
  await Deno.writeTextFile(
    ".private/evidence/import-retrieval.json",
    JSON.stringify(
      {
        checked_records: checked,
        source_commit: manifest.commit,
        transport: "sdk_streamable_http_in_process",
        identity: "synthetic_local",
        source_data: "real_private_import",
        new_client: true,
        verified: true,
        remote: false,
        mobile: false,
      },
      null,
      2,
    ),
  );
  console.log(
    `Recuperação MCP local aprovada: ${checked} registros curados com proveniência e documento bruto legível. OAuth/cliente remoto não testados.`,
  );
} finally {
  await client.close();
  await db.end();
}
