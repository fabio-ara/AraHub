/**
 * Processador local de materiais do AraHub (worker separado, sem navegador).
 *
 * Lê os arquivos já preservados em uma pasta privada e grava, para cada
 * conteúdo, a extração estruturada e o texto com localizadores em
 * `<out>/<sha256>/`. É idempotente por conteúdo (mesmo sha256 reutiliza o
 * resultado) e mantém um manifesto com contagens, cobertura e hashes.
 *
 * Não há rede, upload, credencial nem serviço de transcrição. Para vídeo usa
 * ffmpeg/ffprobe locais: verifica legendas embutidas e declara a lacuna de ASR.
 *
 * Uso (a partir da raiz do repositório):
 *   deno run --allow-read --allow-write=.private --allow-run=ffmpeg,ffprobe \
 *     scripts/process_materials.ts --in .private/entrega-1/materials/source \
 *     --out .private/entrega-1/materials/extracted [--audio] [--asr] [--force]
 *
 * `--check` só informa ferramentas/formato sem processar nada.
 */
import {
  documentExtractionToText,
  extractDocxText,
  extractHtmlText,
} from "../src/document_text.ts";
import {
  ASR_ENGINE_VERSION,
  DEFAULT_ASR_LANGUAGE,
  extractFrameAt,
  type LocalTranscriptionResult,
  type MediaProbeResult,
  mediaTools,
  probeLocalAsr,
  probeMediaFile,
  processVideo,
  shouldReuseTranscription,
  transcribeLocal,
  type TranscriptionCacheStamp,
} from "../src/material_processor.ts";
import { extractPdfText, pdfExtractionToText } from "../src/pdf_text.ts";

const DOCUMENT_EXTENSIONS = new Set(["docx", "docm"]);
/** Muda quando a extração muda de forma material; invalida a reutilização. */
const EXTRACTOR_VERSION = "materials-2026-10-07.3";
const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const MEDIA_EXTENSIONS = new Set(["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg", "oga", "opus", "flac", "aac"]);

interface Options {
  inputDir: string;
  outputDir: string;
  check: boolean;
  audio: boolean;
  asr: boolean;
  transcribe: boolean;
  modelPath: string;
  modelSha256: string | null;
  language: string;
  frames: number;
  reprocessMedia: boolean;
  force: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    inputDir: ".private/entrega-1/materials/source",
    outputDir: ".private/entrega-1/materials/extracted",
    check: false,
    audio: false,
    asr: false,
    transcribe: false,
    modelPath: "",
    modelSha256: null,
    language: DEFAULT_ASR_LANGUAGE,
    frames: 0,
    reprocessMedia: false,
    force: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--in") options.inputDir = argv[++i] ?? options.inputDir;
    else if (arg === "--out") options.outputDir = argv[++i] ?? options.outputDir;
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--check") options.check = true;
    else if (arg === "--audio") options.audio = true;
    else if (arg === "--asr") options.asr = true;
    else if (arg === "--transcribe") options.transcribe = true;
    else if (arg === "--model") options.modelPath = argv[++i] ?? options.modelPath;
    else if (arg === "--model-sha") options.modelSha256 = argv[++i] ?? null;
    else if (arg === "--language") options.language = argv[++i] ?? options.language;
    else if (arg === "--frames") options.frames = Number.parseInt(argv[++i] ?? "0", 10) || 0;
    else if (arg === "--reprocess-media") options.reprocessMedia = true;
    else if (arg === "--force") options.force = true;
  }
  return options;
}

async function listFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = dir + "/" + entry.name;
    if (entry.isDirectory) found.push(...await listFiles(path, depth + 1));
    else if (entry.isFile) found.push(path);
  }
  return found.sort();
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Kind = "docx" | "html" | "pdf" | "video" | "audio" | "unsupported";

function kindOf(extension: string): Kind {
  if (DOCUMENT_EXTENSIONS.has(extension)) return "docx";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (PDF_EXTENSIONS.has(extension)) return "pdf";
  if (MEDIA_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return "unsupported";
}

interface SummaryEntry {
  i: number;
  sha256: string;
  ext: string;
  bytes: number;
  kind: Kind;
  reused: boolean;
  ok: boolean;
  coverage: string;
  error_code?: string;
  blocks?: number;
  paragraphs?: number;
  headings?: number;
  list_items?: number;
  tables?: number;
  cells?: number;
  links?: number;
  images?: number;
  fields?: number;
  characters?: number;
  gaps?: number;
  parts_read?: number;
  container?: string | null;
  duration_ms?: number | null;
  streams?: { video: number; audio: number; subtitle: number; text_subtitle: number };
  captions_present?: boolean;
  cues?: number;
  transcript_source?: string;
  asr?: string;
  asr_reviewed?: boolean;
  asr_reused?: boolean;
  asr_engine?: string;
  asr_model_integrity?: string;
  asr_model_sha_prefix?: string | null;
  asr_error_code?: string | null;
  asr_accuracy_verified?: boolean;
  asr_source_unreviewed?: boolean;
  coverage_scope?: string;
  first_ms?: number | null;
  last_ms?: number | null;
  timeline_ratio?: number | null;
  frames?: number;
  visual_analysis?: string;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Instantes (ms) para quadros: meio dos segmentos de fala quando existirem. */
function frameInstants(
  transcript: Array<{ start_ms: number; end_ms: number }>,
  count: number,
  durationMs: number | null,
): number[] {
  if (count <= 0) return [];
  const picks: number[] = [];
  if (transcript.length) {
    for (let i = 0; i < count; i++) {
      const index = Math.min(
        transcript.length - 1,
        Math.floor((i * transcript.length) / count),
      );
      const cue = transcript[index];
      picks.push(Math.round((cue.start_ms + cue.end_ms) / 2));
    }
  } else if (durationMs !== null && durationMs > 0) {
    for (let i = 0; i < count; i++) {
      picks.push(Math.round((durationMs * (i + 1)) / (count + 1)));
    }
  }
  return [...new Set(picks)];
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  if (options.check) {
    const tools = await mediaTools();
    const asr = await probeLocalAsr();
    const modelPin = options.modelSha256;
    let modelBytes: number | null = null;
    try {
      modelBytes = (await Deno.stat(options.modelPath)).size;
    } catch {
      modelBytes = null;
    }
    console.log(JSON.stringify({
      check: true,
      ffmpeg: { available: tools.ffmpeg.available, version: tools.ffmpeg.version },
      ffprobe: { available: tools.ffprobe.available, version: tools.ffprobe.version },
      run_permission: tools.run_permission,
      local_asr: asr,
      model: {
        path: options.modelPath,
        present: modelBytes !== null && modelBytes > 0,
        bytes: modelBytes,
        pinned_sha256_prefix: modelPin ? modelPin.slice(0, 16) : null,
      },
      transcription_enabled: options.transcribe,
      extensions: {
        docx: [...DOCUMENT_EXTENSIONS],
        html: [...HTML_EXTENSIONS],
        pdf: [...PDF_EXTENSIONS],
        media: [...MEDIA_EXTENSIONS],
        audio: [...AUDIO_EXTENSIONS],
      },
    }));
    return;
  }

  if (
    options.transcribe && (!options.modelPath || !/^[a-f0-9]{64}$/.test(options.modelSha256 ?? ""))
  ) {
    throw new Error(
      "Para transcrever, informe --model e --model-sha explícitos. Não há fallback para modelo leve. A qualidade PT-PT precisa de validação própria.",
    );
  }
  const files = await listFiles(options.inputDir);
  const selected = options.limit === null ? files : files.slice(0, Math.max(0, options.limit));
  const tools = await mediaTools();
  const entries: SummaryEntry[] = [];
  const manifest: Record<string, unknown>[] = [];
  const manifestPath = options.outputDir + "/manifest.json";
  const previous = new Map<string, { version: string; entry: SummaryEntry }>();
  try {
    const parsed = JSON.parse(await Deno.readTextFile(manifestPath)) as {
      files?: Array<Record<string, unknown>>;
    };
    for (const row of parsed.files ?? []) {
      const sha = typeof row.sha256 === "string" ? row.sha256 : null;
      const summary = row.summary as SummaryEntry | undefined;
      if (sha && summary) {
        previous.set(sha, {
          version: typeof row.extractor_version === "string" ? row.extractor_version : "",
          entry: summary,
        });
      }
    }
  } catch {
    // Primeiro processamento: não há manifesto anterior.
  }

  console.log(JSON.stringify({
    started: true,
    files: selected.length,
    ffmpeg: tools.ffmpeg.available,
    ffprobe: tools.ffprobe.available,
    run_permission: tools.run_permission,
  }));

  let index = 0;
  for (const path of selected) {
    index++;
    const extension = extensionOf(path);
    const kind = kindOf(extension);
    const bytes = await Deno.readFile(path);
    const sha = await sha256Hex(bytes);
    const targetDir = options.outputDir + "/" + sha;
    const prior = previous.get(sha);
    if (
      prior && !options.force &&
      !(options.reprocessMedia && (kind === "video" || kind === "audio")) &&
      prior.version === EXTRACTOR_VERSION &&
      await fileExists(targetDir + "/extraction.json")
    ) {
      const reused: SummaryEntry = { ...prior.entry, i: index, reused: true };
      entries.push(reused);
      manifest.push({
        sha256: sha,
        source: path,
        extension,
        bytes: bytes.byteLength,
        kind,
        extractor_version: EXTRACTOR_VERSION,
        coverage: reused.coverage,
        ok: reused.ok,
        error_code: reused.error_code ?? null,
        summary: reused,
      });
      console.log(JSON.stringify(reused));
      continue;
    }
    const entry: SummaryEntry = {
      i: index,
      sha256: sha,
      ext: extension,
      bytes: bytes.byteLength,
      kind,
      reused: false,
      ok: false,
      coverage: "not_extracted",
    };
    let text: string | null = null;
    let extraction: unknown = null;
    let probe: MediaProbeResult | null = null;

    if (kind === "docx") {
      const result = await extractDocxText(bytes);
      extraction = result;
      text = result.ok ? documentExtractionToText(result) : null;
      Object.assign(entry, {
        ok: result.ok,
        coverage: result.coverage,
        blocks: result.block_count,
        paragraphs: result.paragraph_count,
        headings: result.heading_count,
        list_items: result.list_item_count,
        tables: result.table_count,
        cells: result.cell_count,
        links: result.link_count,
        images: result.image_count,
        fields: result.field_count,
        characters: result.characters,
        gaps: result.gaps.length,
        parts_read: result.parts_read.length,
      });
      if (result.error_code) entry.error_code = result.error_code;
    } else if (kind === "html") {
      const result = await extractHtmlText(bytes);
      extraction = result;
      text = result.ok ? documentExtractionToText(result) : null;
      Object.assign(entry, {
        ok: result.ok,
        coverage: result.coverage,
        blocks: result.block_count,
        paragraphs: result.paragraph_count,
        headings: result.heading_count,
        list_items: result.list_item_count,
        tables: result.table_count,
        cells: result.cell_count,
        links: result.link_count,
        images: result.image_count,
        characters: result.characters,
        gaps: result.gaps.length,
      });
      if (result.error_code) entry.error_code = result.error_code;
    } else if (kind === "pdf") {
      const result = await extractPdfText(bytes, { allowMainThreadFallback: true });
      extraction = result;
      text = result.pages.length ? pdfExtractionToText(result) : null;
      Object.assign(entry, {
        ok: result.ok,
        coverage: result.coverage,
        blocks: result.pages_returned,
        characters: result.pages.reduce((sum, page) => sum + page.char_count, 0),
        gaps: result.omitted_pages.length,
      });
      if (result.error_code) entry.error_code = result.error_code;
    } else if (kind === "video" || kind === "audio") {
      probe = await probeMediaFile(path, { byteLength: bytes.byteLength });
      const audioPath = options.audio ? targetDir + "/audio-16k-mono.wav" : undefined;
      if (audioPath) await Deno.mkdir(targetDir, { recursive: true });
      const modelSha256 = options.modelSha256;
      const expectedStamp: TranscriptionCacheStamp = {
        engine_version: ASR_ENGINE_VERSION,
        model_sha256: modelSha256,
        language: options.language,
      };
      const cachedRaw = await readJsonObject(targetDir + "/transcription.json");
      const cachedStamp = (cachedRaw?.cache ?? null) as TranscriptionCacheStamp | null;
      const cachedTranscription = cachedRaw !== null && cachedRaw.ok === true
        ? cachedRaw as unknown as LocalTranscriptionResult
        : null;
      const captionsInFile = probe.text_subtitle_streams > 0;
      const canReuseAsr = cachedTranscription !== null &&
        shouldReuseTranscription(cachedStamp, expectedStamp) &&
        await fileExists(targetDir + "/transcript.srt");
      const needsAsr = options.transcribe && !captionsInFile && !canReuseAsr;
      const result = await processVideo(path, {
        probe,
        byteLength: bytes.byteLength,
        checkAsr: options.asr,
        audioOutputPath: audioPath,
        transcription: needsAsr
          ? {
            modelPath: options.modelPath,
            language: options.language,
            expectedModelSha256: modelSha256,
            destinationPath: targetDir + "/transcript.srt",
          }
          : null,
      });
      let transcription = result.transcription;
      let asrReused = false;
      if (canReuseAsr && cachedTranscription !== null) {
        transcription = cachedTranscription;
        asrReused = true;
      }
      if (needsAsr && result.transcription !== null) {
        await Deno.mkdir(targetDir, { recursive: true });
        await Deno.writeTextFile(
          targetDir + "/transcription.json",
          JSON.stringify({ ...result.transcription, cache: expectedStamp }, null, 2) + "\n",
        );
      }
      // A transcrição guardada é o artefato durável: quando ela é reaproveitada,
      // o resultado composto declara a mesma origem que a execução original.
      const composed = transcription !== null && transcription.ok && !result.transcript.length
        ? {
          ...result,
          transcription,
          transcript: transcription.segments,
          transcript_source: "local_asr" as const,
          asr: "completed_local" as const,
          asr_engine: "ffmpeg_whisper_cpp" as const,
          coverage: transcription.coverage,
        }
        : { ...result, transcription };
      extraction = composed;
      text = composed.transcript.length
        ? composed.transcript
          .map((cue) =>
            "[" + cue.locator + "] " + cue.start_ms + "-" + cue.end_ms + "ms " + cue.text
          )
          .join("\n")
        : null;
      const frameInstantsMs = frameInstants(
        composed.transcript,
        options.frames,
        probe.duration_ms,
      );
      const frameRecords: Array<Record<string, unknown>> = [];
      if (frameInstantsMs.length) {
        const framesDir = targetDir + "/frames";
        await Deno.mkdir(framesDir, { recursive: true });
        for (let index = 0; index < frameInstantsMs.length; index++) {
          const framePath = framesDir + "/frame-" + (index + 1) + ".png";
          const frame = await extractFrameAt(path, frameInstantsMs[index], framePath);
          const frameSha = frame.ok ? await sha256Hex(await Deno.readFile(framePath)) : null;
          frameRecords.push({
            i: index + 1,
            at_ms: frameInstantsMs[index],
            ok: frame.ok,
            format: frame.format,
            bytes: frame.bytes,
            sha256: frameSha,
            error_code: frame.error_code ?? null,
          });
        }
        await Deno.writeTextFile(
          framesDir + "/frames.json",
          JSON.stringify(
            {
              source_sha256: sha,
              method: "ffmpeg -ss <ms> -i <arquivo> -frames:v 1 (bytes locais, fora de interface)",
              visual_analysis: "not_performed",
              note: "Quadros privados para inspeção futura; não publicados e não interpretados.",
              frames: frameRecords,
            },
            null,
            2,
          ) + "\n",
        );
      }
      Object.assign(entry, {
        ok: composed.ok,
        coverage: composed.coverage,
        container: composed.probe.container,
        duration_ms: composed.probe.duration_ms,
        streams: {
          video: composed.probe.video_streams,
          audio: composed.probe.audio_streams,
          subtitle: composed.probe.subtitle_streams,
          text_subtitle: composed.probe.text_subtitle_streams,
        },
        captions_present: composed.subtitles.captions_present,
        cues: composed.transcript.length,
        transcript_source: composed.transcript_source,
        asr: composed.asr,
        asr_reviewed: composed.asr_reviewed,
        asr_reused: asrReused,
        asr_engine: composed.asr_engine,
        asr_model_integrity: transcription?.model.integrity ?? null,
        asr_model_sha_prefix: transcription?.model.sha256
          ? transcription.model.sha256.slice(0, 16)
          : null,
        asr_error_code: transcription?.error_code ?? null,
        asr_accuracy_verified: transcription?.accuracy_verified ?? false,
        asr_source_unreviewed: transcription?.source_unreviewed ?? false,
        coverage_scope: composed.coverage_scope,
        first_ms: transcription?.first_ms ?? null,
        last_ms: transcription?.last_ms ?? null,
        timeline_ratio: transcription?.timeline_coverage_ratio ?? null,
        frames: frameRecords.filter((frame) => frame.ok === true).length,
        visual_analysis: composed.visual_analysis,
        images: 0,
      });
      if (composed.error_code) entry.error_code = composed.error_code;
    } else {
      entry.error_code = "unsupported_format";
      entry.coverage = "unavailable";
    }

    await Deno.mkdir(targetDir, { recursive: true });
    await Deno.writeTextFile(
      targetDir + "/extraction.json",
      JSON.stringify(extraction, null, 2) + "\n",
    );
    if (text !== null) await Deno.writeTextFile(targetDir + "/text.txt", text + "\n");
    manifest.push({
      sha256: sha,
      source: path,
      extension,
      bytes: bytes.byteLength,
      kind,
      extractor_version: EXTRACTOR_VERSION,
      coverage: entry.coverage,
      ok: entry.ok,
      error_code: entry.error_code ?? null,
      summary: entry,
    });
    entries.push(entry);
    console.log(JSON.stringify(entry));
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          tools: {
            ffmpeg: tools.ffmpeg.version,
            ffprobe: tools.ffprobe.version,
            run_permission: tools.run_permission,
          },
          files: manifest,
        },
        null,
        2,
      ) + "\n",
    );
  }

  const totals = entries.reduce(
    (acc, entry) => {
      acc.bytes += entry.bytes;
      if (entry.ok) acc.ok++;
      acc.coverage[entry.coverage] = (acc.coverage[entry.coverage] ?? 0) + 1;
      return acc;
    },
    { bytes: 0, ok: 0, coverage: {} as Record<string, number> },
  );
  console.log(JSON.stringify({
    done: true,
    processed: entries.length,
    ok: totals.ok,
    bytes: totals.bytes,
    coverage: totals.coverage,
    by_kind: entries.reduce((acc, entry) => {
      acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  }));
}

if (import.meta.main) {
  await main();
}
