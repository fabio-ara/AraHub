// Unitário, sem rede, Docker ou chamada ao Moodle Lab.
import { rejects, strictEqual as assertEquals, throws as assertThrows } from "node:assert/strict";
import {
  assertLabOrigin,
  assertLabOwnership,
  loadLabManifest,
  MoodleLabAdapter,
} from "./moodle_lab_adapter.ts";

Deno.test("Lab: origem é loopback explícito, sem credencial nem rota", () => {
  for (const origin of ["http://127.0.0.1:8480", "http://localhost:8481", "http://[::1]:8480"]) {
    assertEquals(assertLabOrigin(origin).origin, origin);
  }
  for (
    const origin of [
      "",
      "http://127.evil.com:8480",
      "https://example.org:8480",
      "http://user:secret@127.0.0.1:8480",
      "http://127.0.0.1",
      "http://127.0.0.1:8480/path",
      "http://127.0.0.1:8480?token=fixture",
      "http://127.0.0.1:8480#fragment",
      "ftp://127.0.0.1:8480",
    ]
  ) assertThrows(() => assertLabOrigin(origin));
});

Deno.test("Lab: manifesto não pode desviar token para endpoint externo", async () => {
  const file = await Deno.makeTempFile({ prefix: "arahub-unit-manifest-" });
  const manifest = {
    schema: "arahub.moodle-lab.manifest/1",
    origin: "http://127.0.0.1:8480",
    rest_endpoint: "http://127.0.0.1:8480/webservice/rest/server.php",
    upload_endpoint: "http://127.0.0.1:8480/webservice/upload.php",
  };
  try {
    await Deno.writeTextFile(file, JSON.stringify(manifest));
    assertEquals((await loadLabManifest(file)).origin, manifest.origin);
    for (
      const endpoint of [
        "https://example.org/webservice/rest/server.php",
        "http://127.0.0.1:8481/webservice/rest/server.php",
        "http://127.0.0.1:8480/other",
        "http://127.0.0.1:8480/webservice/rest/server.php?x=1",
      ]
    ) {
      await Deno.writeTextFile(file, JSON.stringify({ ...manifest, rest_endpoint: endpoint }));
      await rejects(() => loadLabManifest(file), /Endpoint/);
    }
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("Lab: objeto em memória e instância devem concordar antes de enviar token", async () => {
  const file = await Deno.makeTempFile({ prefix: "arahub-unit-instance-" });
  const origin = "http://127.0.0.1:8480";
  const instance = {
    instance_id: "11111111-2222-4333-8444-555555555555",
    project: "labunit",
    wwwroot: origin,
  };
  const manifest = {
    schema: "arahub.moodle-lab.manifest/1",
    ...instance,
    origin,
    rest_endpoint: origin + "/webservice/rest/server.php",
    upload_endpoint: origin + "/webservice/upload.php",
    accounts: { student: { userid: 7, token: "synthetic-unit-token" } },
    fixture: {},
  };
  let requests = 0;
  const transport: typeof fetch = (_input, init) => {
    requests++;
    assertEquals(init?.redirect, "error");
    return Promise.resolve(Response.json({ lastattempt: { submission: { status: "new" } } }));
  };
  try {
    await Deno.writeTextFile(file, JSON.stringify(instance));
    assertLabOwnership(manifest, file);
    for (
      const changed of [
        { ...manifest, rest_endpoint: "https://example.org/collect" },
        { ...manifest, project: "other" },
        { ...manifest, instance_id: "22222222-2222-4333-8444-555555555555" },
        {
          ...manifest,
          origin: "http://127.0.0.1:8481",
          rest_endpoint: "http://127.0.0.1:8481/webservice/rest/server.php",
          upload_endpoint: "http://127.0.0.1:8481/webservice/upload.php",
        },
      ]
    ) {
      assertThrows(() => new MoodleLabAdapter(changed, "student", file, transport));
    }
    assertEquals(requests, 0);
    const adapter = new MoodleLabAdapter(manifest, "student", file, transport);
    assertEquals((await adapter.getSubmissionStatus(10)).data?.lastattempt !== undefined, true);
    assertEquals(requests, 1);
    await Deno.writeTextFile(file, JSON.stringify({ ...instance, instance_id: "invalid" }));
    assertThrows(() => assertLabOwnership({ ...manifest, instance_id: "invalid" }, file));
  } finally {
    await Deno.remove(file);
  }
});
