import assert from "node:assert/strict";
import { archiveAsrRevision } from "../scripts/process_materials.ts";

Deno.test("ASR: troca de representação preserva original e revisão, com replay idempotente", async () => {
  const dir = await Deno.makeTempDir({ dir: ".private", prefix: "asr-history-" });
  assert.equal(await archiveAsrRevision(dir), null);
  await Deno.writeTextFile(
    dir + "/transcription.json",
    JSON.stringify({ model: "fixture-a", text: "palavra antiga" }),
  );
  await Deno.writeTextFile(
    dir + "/transcript.srt",
    "1\n00:00:20,000 --> 00:00:23,000\npalavra antiga\n",
  );
  const first = await archiveAsrRevision(dir);
  assert.equal(await archiveAsrRevision(dir), first);
  await Deno.writeTextFile(
    dir + "/transcription.json",
    JSON.stringify({ model: "fixture-b", text: "palavra revista" }),
  );
  await Deno.writeTextFile(
    dir + "/transcript.srt",
    "1\n00:00:20,000 --> 00:00:23,000\npalavra revista\n",
  );
  const second = await archiveAsrRevision(dir);
  assert.notEqual(first, second);
  assert.match(
    await Deno.readTextFile(dir + "/history/" + first + "/transcript.srt"),
    /palavra antiga/,
  );
  assert.match(
    await Deno.readTextFile(dir + "/history/" + second + "/transcript.srt"),
    /palavra revista/,
  );
  assert.match(await Deno.readTextFile(dir + "/transcription.json"), /fixture-b/);
  await Deno.writeTextFile(dir + "/history/" + second + "/transcript.srt", "arquivo adulterado");
  await assert.rejects(archiveAsrRevision(dir), /Histórico de ASR divergente/);
  assert.match(await Deno.readTextFile(dir + "/transcript.srt"), /palavra revista/);
});
