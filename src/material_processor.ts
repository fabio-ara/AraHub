/**
 * Pipeline local de mídia (CPU) para materiais audiovisuais do AraHub.
 *
 * Objetivo desta frente: verificar legendas/transcrições efetivamente
 * presentes no arquivo, extrair as legendas de texto com timestamps e manter
 * explícita a lacuna de ASR (fala sem legenda) sem contratar serviço algum.
 *
 * Regras:
 * - só processos locais (`ffprobe`/`ffmpeg`) sobre bytes já preservados do
 *   dono; nenhuma rede, nenhum upload, nenhuma credencial;
 * - falha de permissão de execução, ferramenta ausente e tempo excedido são
 *   estados distintos e explícitos, não "sem legendas";
 * - legenda embutida não é transcrição verificada: é legenda da fonte, com
 *   idioma/faixa/stream identificados;
 * - fala sem legenda permanece lacuna declarada (`asr`), nunca uma transcrição
 *   fingida; quadros/visuais não são analisados automaticamente.
 */
import { type Coverage, HubError } from "./contracts.ts";

export const DEFAULT_MEDIA_TIMEOUT_MS = 120_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
export const MAX_SUBTITLE_CUES = 20_000;
export const MAX_STDERR_CHARS = 600;

export type MediaToolCode =
  | "tool_unavailable"
  | "run_permission_denied"
  | "timeout"
  | "unreadable"
  | "oversized"
  | "empty_input"
  | "unreadable_output";

const COVERAGE_BY_CODE: Record<MediaToolCode, Coverage> = {
  tool_unavailable: "unavailable",
  run_permission_denied: "denied",
  timeout: "timeout",
  unreadable: "parsing_error",
  oversized: "unavailable",
  empty_input: "parsing_error",
  unreadable_output: "parsing_error",
};

export const LISTENING_NOTE =
  "O arquivo é dado não confiável; nenhum conteúdo de fala foi interpretado por modelo de linguagem.";
export const NO_SERVICE_NOTE =
  "Nenhum serviço de transcrição foi contratado ou acionado; o processamento é local (ffmpeg/ffprobe).";

export interface MediaToolAvailability {
  name: "ffmpeg" | "ffprobe";
  available: boolean;
  version: string | null;
  error_code?: MediaToolCode;
  diagnostic?: string;
}

export interface MediaTools {
  ffmpeg: MediaToolAvailability;
  ffprobe: MediaToolAvailability;
  run_permission: "granted" | "denied" | "prompt";
}

export interface MediaStreamInfo {
  index: number;
  type: "video" | "audio" | "subtitle" | "data" | "attachment";
  codec: string | null;
  language: string | null;
  text_subtitle: boolean;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  channels: number | null;
  sample_rate: number | null;
}

export interface MediaProbeResult {
  kind: "media_probe";
  ok: boolean;
  error_code?: MediaToolCode;
  coverage: Coverage;
  container: string | null;
  duration_ms: number | null;
  streams: MediaStreamInfo[];
  video_streams: number;
  audio_streams: number;
  subtitle_streams: number;
  text_subtitle_streams: number;
  image_subtitle_streams: number;
  tools: MediaTools;
  limits: string[];
  notes: string[];
  content_is_untrusted_data: true;
  byte_length: number;
  elapsed_ms: number;
  diagnostic?: string;
}

export interface SubtitleCue {
  index: number;
  locator: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface SubtitleTrack {
  stream_index: number;
  language: string | null;
  codec: string | null;
  cue_count: number;
  truncated: boolean;
  cues: SubtitleCue[];
}

export interface SubtitleExtractionResult {
  kind: "video_subtitles";
  ok: boolean;
  error_code?: MediaToolCode;
  coverage: Coverage;
  captions_present: boolean;
  text_track_count: number;
  image_track_count: number;
  tracks: SubtitleTrack[];
  cue_count: number;
  limits: string[];
  notes: string[];
  content_is_untrusted_data: true;
  elapsed_ms: number;
  diagnostic?: string;
}

export interface VideoProcessingResult {
  kind: "video_media_extraction";
  ok: boolean;
  error_code?: MediaToolCode;
  coverage: Coverage;
  probe: MediaProbeResult;
  subtitles: SubtitleExtractionResult;
  transcript_source: "embedded_captions" | "local_asr" | "none";
  transcript: SubtitleCue[];
  asr: "not_attempted" | "completed_local";
  asr_engine: "none" | "ffmpeg_whisper_cpp";
  /** A transcrição local é saída de máquina e não foi revisada por humano. */
  asr_reviewed: false;
  /** Cobertura do texto: execução/linha do tempo (ASR) ou completude (legenda). */
  coverage_scope: "temporal_execution" | "text_completeness" | "media_presence";
  /** Nenhuma verificação de acurácia do texto foi feita (legenda ou ASR). */
  accuracy_verified: false;
  transcription: LocalTranscriptionResult | null;
  asr_gap_note: string;
  local_asr: LocalAsrCapability | null;
  visual_analysis: "not_performed";
  audio_output: { path: string; bytes: number } | null;
  limits: string[];
  notes: string[];
  content_is_untrusted_data: true;
  elapsed_ms: number;
}

export interface LocalAsrCapability {
  whisper_filter_available: boolean;
  model_option_mentioned: boolean;
  model_configured: boolean;
  note: string;
}

const TEXT_SUBTITLE_CODECS = new Set([
  "ass",
  "eia_608",
  "hdmv_text_subtitle",
  "jacosub",
  "microdvd",
  "mov_text",
  "mpl2",
  "pjs",
  "realtext",
  "sami",
  "scc",
  "srt",
  "stl",
  "subrip",
  "subviewer",
  "subviewer1",
  "text",
  "ttml",
  "vplayer",
  "webvtt",
]);

const IMAGE_SUBTITLE_CODECS = new Set([
  "dvb_subtitle",
  "dvd_subtitle",
  "hdmv_pgs_subtitle",
  "xsub",
]);

function isTextSubtitle(codec: string | null): boolean {
  if (!codec) return false;
  const normalized = codec.toLowerCase();
  if (IMAGE_SUBTITLE_CODECS.has(normalized)) return false;
  return TEXT_SUBTITLE_CODECS.has(normalized);
}

interface RunOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  binary?: string;
  cwd?: string;
}

interface RunResult {
  code: number | null;
  stdout: Uint8Array;
  stdout_truncated: boolean;
  diagnostic: string;
  timed_out: boolean;
  error_code?: MediaToolCode;
}

function sanitizeDiagnostic(raw: string, secrets: string[] = []): string {
  let out = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[caminho]");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.slice(0, MAX_STDERR_CHARS);
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean; total: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > cap) {
      const room = cap - (total - value.length);
      if (room > 0) chunks.push(value.subarray(0, room));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, truncated, total };
}

/** Executa uma ferramenta local com limite de tempo e de saída; nunca usa shell. */
async function runTool(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const binary = options.binary ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_SUBTITLE_BYTES;
  const permission = await Deno.permissions.query({ name: "run", command: binary });
  if (permission.state !== "granted") {
    return {
      code: null,
      stdout: new Uint8Array(0),
      stdout_truncated: false,
      diagnostic: "Permissão de execução de processo não concedida a esta execução.",
      timed_out: false,
      error_code: "run_permission_denied",
    };
  }
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(binary, {
      args,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      ...(options.cwd ? { cwd: options.cwd } : {}),
    }).spawn();
  } catch (error) {
    const code: MediaToolCode = error instanceof Deno.errors.NotFound
      ? "tool_unavailable"
      : "unreadable";
    return {
      code: null,
      stdout: new Uint8Array(0),
      stdout_truncated: false,
      diagnostic: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
      timed_out: false,
      error_code: code,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Processo já terminou.
    }
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Sem ação adicional.
      }
    }, 2_000);
    killer.unref?.();
  }, timeoutMs);

  const [stdout, stderr, status] = await Promise.all([
    readCapped(child.stdout, maxStdoutBytes),
    readCapped(child.stderr, 64 * 1024),
    child.status,
  ]);
  clearTimeout(timer);
  const diagnostic = sanitizeDiagnostic(new TextDecoder().decode(stderr.bytes).trim());
  if (timedOut) {
    return {
      code: status.code,
      stdout: stdout.bytes,
      stdout_truncated: stdout.truncated,
      diagnostic: diagnostic || "Tempo limite excedido.",
      timed_out: true,
      error_code: "timeout",
    };
  }
  return {
    code: status.code,
    stdout: stdout.bytes,
    stdout_truncated: stdout.truncated,
    diagnostic,
    timed_out: false,
  };
}

/**
 * Verifica se o ffmpeg local oferece o filtro `whisper` (whisper.cpp) e se há
 * modelo configurado. Não baixa modelo, não transcreve e não contrata serviço:
 * apenas informa a capacidade real da máquina.
 */
export async function probeLocalAsr(
  options: { ffmpegPath?: string; modelPath?: string } = {},
): Promise<LocalAsrCapability> {
  const binary = options.ffmpegPath ?? "ffmpeg";
  const filters = await runTool(["-hide_banner", "-filters"], {
    binary,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    maxStdoutBytes: 2 * 1024 * 1024,
  });
  const filterText = filters.error_code ? "" : new TextDecoder().decode(filters.stdout);
  const whisperAvailable = /(^|\s)whisper(\s|$)/m.test(filterText);
  let modelOption = false;
  if (whisperAvailable) {
    const help = await runTool(["-hide_banner", "-h", "filter=whisper"], {
      binary,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      maxStdoutBytes: 256 * 1024,
    });
    modelOption = !help.error_code && /\bmodel\b/i.test(new TextDecoder().decode(help.stdout));
  }
  const modelConfigured = options.modelPath !== undefined &&
    await fileSize(options.modelPath) !== null;
  return {
    whisper_filter_available: whisperAvailable,
    model_option_mentioned: modelOption,
    model_configured: modelConfigured,
    note: whisperAvailable
      ? "O ffmpeg local anuncia o filtro whisper (whisper.cpp); a transcrição exige um modelo " +
        "ggml local e não foi executada nem verificada nesta frente."
      : "O ffmpeg local não anuncia o filtro whisper; não há motor de ASR local configurado.",
  };
}

export interface MediaArtifact {
  ok: boolean;
  path: string;
  bytes: number;
  format: string | null;
  error_code?: MediaToolCode;
  diagnostic?: string;
  elapsed_ms: number;
}

/** Extrai áudio PCM 16 kHz mono para um motor de ASR local, se pedido. */
export async function extractAudioForAsr(
  path: string,
  outPath: string,
  options: { ffmpegPath?: string; timeoutMs?: number } = {},
): Promise<MediaArtifact> {
  const startedAt = performance.now();
  const result = await runTool(
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outPath,
    ],
    {
      binary: options.ffmpegPath ?? "ffmpeg",
      timeoutMs: options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS,
      maxStdoutBytes: 4096,
    },
  );
  if (result.error_code || result.code !== 0) {
    return {
      ok: false,
      path: outPath,
      bytes: 0,
      format: null,
      error_code: result.error_code ?? "unreadable",
      diagnostic: result.diagnostic,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  }
  const bytes = await fileSize(outPath) ?? 0;
  let format: string | null = null;
  try {
    const head = await Deno.readFile(outPath).then((data) => data.subarray(0, 12));
    if (head.length >= 4 && String.fromCharCode(...head.subarray(0, 4)) === "RIFF") format = "wav";
  } catch {
    format = null;
  }
  return {
    ok: bytes > 44,
    path: outPath,
    bytes,
    format,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
}

/**
 * Extrai um quadro em PNG/JPEG num instante pedido, gravando os bytes fora de
 * qualquer interface. Não é análise visual: apenas materializa o quadro para
 * inspeção futura, e o resultado nunca afirma que o vídeo foi assistido.
 */
export async function extractFrameAt(
  path: string,
  atMs: number,
  outPath: string,
  options: { ffmpegPath?: string; timeoutMs?: number } = {},
): Promise<MediaArtifact> {
  const startedAt = performance.now();
  if (!Number.isFinite(atMs) || atMs < 0) {
    throw new HubError("invalid_media_option", "Instante do quadro inválido.");
  }
  const result = await runTool(
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      (atMs / 1000).toFixed(3),
      "-i",
      path,
      "-frames:v",
      "1",
      outPath,
    ],
    {
      binary: options.ffmpegPath ?? "ffmpeg",
      timeoutMs: options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS,
      maxStdoutBytes: 4096,
    },
  );
  if (result.error_code || result.code !== 0) {
    return {
      ok: false,
      path: outPath,
      bytes: 0,
      format: null,
      error_code: result.error_code ?? "unreadable",
      diagnostic: result.diagnostic,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  }
  let format: string | null = null;
  let bytes = 0;
  try {
    const data = await Deno.readFile(outPath);
    bytes = data.length;
    if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50) format = "png";
    else if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) format = "jpeg";
  } catch {
    format = null;
  }
  return {
    ok: bytes > 0 && format !== null,
    path: outPath,
    bytes,
    format,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
}

const VIDEO_LIMITS = [
  "Processamento local em CPU: ffprobe para faixas e ffmpeg para legendas/áudio.",
  "Sem rede, sem upload e sem serviço de transcrição.",
  "Análise visual (quadros, gestos, demonstrações em tela) não é executada automaticamente.",
];

/**
 * Pipeline completo de vídeo: sonda, verifica legendas, extrai as legenda de
 * texto com timestamps e declara a lacuna de ASR. Nunca afirma transcrição de
 * fala que não foi executada.
 */
export async function processVideo(
  path: string,
  options: {
    probe?: MediaProbeResult;
    ffmpegPath?: string;
    ffprobePath?: string;
    timeoutMs?: number;
    maxCues?: number;
    byteLength?: number;
    audioOutputPath?: string;
    checkAsr?: boolean;
    modelPath?: string;
    /** Quando presente e sem legendas no arquivo, transcreve a fala localmente. */
    transcription?: {
      modelPath: string;
      language?: string;
      expectedModelSha256?: string | null;
      destinationPath?: string;
      timeoutMs?: number;
      queue?: number;
    } | null;
  } = {},
): Promise<VideoProcessingResult> {
  const startedAt = performance.now();
  const probe = options.probe ??
    await probeMediaFile(path, {
      ffprobePath: options.ffprobePath,
      timeoutMs: options.timeoutMs,
      byteLength: options.byteLength,
    });
  const subtitles = await extractEmbeddedSubtitles(path, {
    probe,
    ffmpegPath: options.ffmpegPath,
    timeoutMs: options.timeoutMs,
    maxCues: options.maxCues,
  });
  const captionCues = subtitles.tracks.flatMap((track) => track.cues);
  const fromCaptions = captionCues.length > 0;
  // Só transcreve quando não há legenda no arquivo: legenda da fonte tem
  // precedência e evita trabalho pesado desnecessário.
  const shouldTranscribe = !fromCaptions && options.transcription != null;
  const transcription = shouldTranscribe
    ? await transcribeLocal(path, {
      modelPath: options.transcription!.modelPath,
      language: options.transcription!.language,
      expectedModelSha256: options.transcription!.expectedModelSha256,
      destinationPath: options.transcription!.destinationPath,
      timeoutMs: options.transcription!.timeoutMs,
      queue: options.transcription!.queue,
      ffmpegPath: options.ffmpegPath,
      mediaDurationMs: probe.duration_ms,
    })
    : null;
  const transcript = fromCaptions ? captionCues : (transcription?.segments ?? []);
  const audioOutput = options.audioOutputPath
    ? await extractAudioForAsr(path, options.audioOutputPath, {
      ffmpegPath: options.ffmpegPath,
      timeoutMs: options.timeoutMs,
    })
    : null;
  const localAsr = options.checkAsr
    ? await probeLocalAsr({ ffmpegPath: options.ffmpegPath, modelPath: options.modelPath })
    : null;

  const gapParts: string[] = [];
  if (fromCaptions) {
    gapParts.push(
      "Transcrição derivada de legendas embutidas (" + subtitles.cue_count +
        " cues em " + subtitles.text_track_count + " faixa(s) de texto)" +
        (subtitles.image_track_count > 0
          ? "; " + subtitles.image_track_count + " faixa(s) de legenda de imagem exigiriam OCR."
          : "."),
    );
    gapParts.push(
      "Fala sem legenda e conteúdo visual não foram tratados; a legenda é da fonte e não foi " +
        "verificada contra o áudio.",
    );
  } else if (transcription?.ok) {
    gapParts.push(
      "Transcrição local de fala (" + transcription.segment_count +
        " segmentos, motor " + transcription.engine + ", modelo " +
        (transcription.model.sha256 ?? "não verificado") + "), não revisada por humano.",
    );
    gapParts.push(
      "Conteúdo visual (quadros, slides, gestos, demonstrações) não foi examinado.",
    );
  } else {
    gapParts.push(
      "Nenhuma legenda de texto encontrada: a fala permanece sem transcrição (ASR não executado).",
    );
    if (transcription && !transcription.ok) {
      gapParts.push(
        "A transcrição local não foi concluída (" + (transcription.error_code ?? "falha") + ").",
      );
    }
    if (subtitles.image_track_count > 0) {
      gapParts.push(
        subtitles.image_track_count + " faixa(s) de legenda em imagem exigiriam OCR.",
      );
    }
  }
  if (localAsr) gapParts.push(localAsr.note);

  const coverage: Coverage = !probe.ok
    ? probe.coverage
    : !subtitles.ok
    ? subtitles.coverage
    : shouldTranscribe
    ? (transcription?.coverage ?? "partial")
    : fromCaptions && !subtitles.tracks.some((track) => track.truncated)
    ? "complete"
    : "partial";
  const errorCode = probe.error_code ?? subtitles.error_code;

  return {
    kind: "video_media_extraction",
    ok: probe.ok && subtitles.ok,
    ...(errorCode ? { error_code: errorCode } : {}),
    coverage,
    probe,
    subtitles,
    transcript_source: fromCaptions
      ? "embedded_captions"
      : transcription?.ok
      ? "local_asr"
      : "none",
    transcript,
    asr: transcription?.ok ? "completed_local" : "not_attempted",
    asr_engine: transcription?.ok ? "ffmpeg_whisper_cpp" : "none",
    asr_reviewed: false,
    coverage_scope: fromCaptions
      ? "text_completeness"
      : transcription?.ok
      ? "temporal_execution"
      : "media_presence",
    accuracy_verified: false,
    transcription,
    asr_gap_note: gapParts.join(" "),
    local_asr: localAsr,
    visual_analysis: "not_performed",
    audio_output: audioOutput ? { path: audioOutput.path, bytes: audioOutput.bytes } : null,
    limits: VIDEO_LIMITS,
    notes: fromCaptions
      ? [LISTENING_NOTE, NO_SERVICE_NOTE, CAPTION_ACCURACY_NOTE]
      : transcription?.ok
      ? [LISTENING_NOTE, NO_SERVICE_NOTE, ACCURACY_NOTE]
      : [LISTENING_NOTE, NO_SERVICE_NOTE],
    content_is_untrusted_data: true,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
}

/** Versão e disponibilidade de ffmpeg/ffprobe, com a permissão de execução atual. */
export async function mediaTools(
  options: { ffmpegPath?: string; ffprobePath?: string } = {},
): Promise<MediaTools> {
  const ffmpegBinary = options.ffmpegPath ?? "ffmpeg";
  const ffprobeBinary = options.ffprobePath ?? "ffprobe";
  const states = await Promise.all([
    Deno.permissions.query({ name: "run", command: ffmpegBinary }),
    Deno.permissions.query({ name: "run", command: ffprobeBinary }),
  ]);
  const runPermission: MediaTools["run_permission"] =
    states.every((state) => state.state === "granted")
      ? "granted"
      : states.every((state) => state.state === "denied")
      ? "denied"
      : "prompt";
  const versionOf = async (
    name: "ffmpeg" | "ffprobe",
    binary: string,
  ): Promise<MediaToolAvailability> => {
    const result = await runTool(["-hide_banner", "-version"], {
      binary,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      maxStdoutBytes: 64 * 1024,
    });
    if (result.error_code) {
      return {
        name,
        available: false,
        version: null,
        error_code: result.error_code,
        diagnostic: result.diagnostic,
      };
    }
    const first = new TextDecoder().decode(result.stdout).split("\n")[0]?.trim() ?? "";
    return {
      name,
      available: result.code === 0 && first.length > 0,
      version: first.length ? first.slice(0, 120) : null,
      ...(result.code === 0 ? {} : { error_code: "unreadable" as MediaToolCode }),
    };
  };
  return {
    ffmpeg: await versionOf("ffmpeg", ffmpegBinary),
    ffprobe: await versionOf("ffprobe", ffprobeBinary),
    run_permission: runPermission,
  };
}

export function subtitleCueLocator(streamIndex: number, cueIndex: number): string {
  return "video:sub:" + streamIndex + ":" + cueIndex;
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await Deno.stat(path);
    return info.size;
  } catch {
    return null;
  }
}

function streamTypeOf(codecType: unknown): MediaStreamInfo["type"] {
  if (codecType === "video") return "video";
  if (codecType === "audio") return "audio";
  if (codecType === "subtitle") return "subtitle";
  if (codecType === "attachment") return "attachment";
  return "data";
}

function msFromSeconds(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const seconds = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

const PROBE_LIMITS = [
  "Sondagem local (ffprobe) sobre o arquivo preservado; nenhuma rede.",
  "Faixas de legenda de imagem (PGS/DVB/DVD) não são interpretadas sem OCR.",
];

/**
 * Sonda o contêiner e as faixas com `ffprobe`. Não decodifica vídeo nem áudio;
 * serve para saber se existem legendas de texto antes de qualquer transcrição.
 */
export async function probeMediaFile(
  path: string,
  options: { ffprobePath?: string; timeoutMs?: number; byteLength?: number } = {},
): Promise<MediaProbeResult> {
  const startedAt = performance.now();
  const byteLength = options.byteLength ?? (await fileSize(path)) ?? 0;
  const tools = await mediaTools({ ffprobePath: options.ffprobePath });
  const base: MediaProbeResult = {
    kind: "media_probe",
    ok: false,
    coverage: "unavailable",
    container: null,
    duration_ms: null,
    streams: [],
    video_streams: 0,
    audio_streams: 0,
    subtitle_streams: 0,
    text_subtitle_streams: 0,
    image_subtitle_streams: 0,
    tools,
    limits: PROBE_LIMITS,
    notes: [LISTENING_NOTE, NO_SERVICE_NOTE],
    content_is_untrusted_data: true,
    byte_length: byteLength,
    elapsed_ms: 0,
  };
  if (byteLength === 0) {
    return { ...base, error_code: "empty_input", diagnostic: "Arquivo vazio ou ilegível." };
  }
  const result = await runTool(
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", path],
    {
      binary: options.ffprobePath ?? "ffprobe",
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxStdoutBytes: 2 * 1024 * 1024,
    },
  );
  if (result.error_code) {
    return {
      ...base,
      error_code: result.error_code,
      coverage: COVERAGE_BY_CODE[result.error_code],
      diagnostic: result.diagnostic,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  }
  if (result.code !== 0) {
    return {
      ...base,
      error_code: "unreadable",
      coverage: "parsing_error",
      diagnostic: result.diagnostic,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  }
  let parsed: {
    format?: { format_name?: string; duration?: string };
    streams?: Array<Record<string, unknown>>;
  };
  try {
    parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  } catch {
    return {
      ...base,
      error_code: "unreadable_output",
      coverage: "parsing_error",
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  }
  const formatDuration = msFromSeconds(parsed.format?.duration);
  const streams: MediaStreamInfo[] = (parsed.streams ?? []).map((raw) => {
    const type = streamTypeOf(raw.codec_type);
    const codec = typeof raw.codec_name === "string" ? raw.codec_name : null;
    const tags = (raw.tags ?? {}) as Record<string, unknown>;
    return {
      index: typeof raw.index === "number" ? raw.index : -1,
      type,
      codec,
      language: typeof tags.language === "string" ? tags.language : null,
      text_subtitle: type === "subtitle" && isTextSubtitle(codec),
      width: typeof raw.width === "number" ? raw.width : null,
      height: typeof raw.height === "number" ? raw.height : null,
      duration_ms: msFromSeconds(raw.duration) ?? (type === "video" ? formatDuration : null),
      channels: typeof raw.channels === "number" ? raw.channels : null,
      sample_rate: typeof raw.sample_rate === "string"
        ? Number.parseInt(raw.sample_rate, 10)
        : null,
    };
  });
  const textSubtitles = streams.filter((stream) => stream.text_subtitle).length;
  const subtitles = streams.filter((stream) => stream.type === "subtitle").length;
  return {
    ...base,
    ok: true,
    coverage: "complete",
    container: parsed.format?.format_name ?? null,
    duration_ms: formatDuration,
    streams,
    video_streams: streams.filter((stream) => stream.type === "video").length,
    audio_streams: streams.filter((stream) => stream.type === "audio").length,
    subtitle_streams: subtitles,
    text_subtitle_streams: textSubtitles,
    image_subtitle_streams: subtitles - textSubtitles,
    diagnostic: result.diagnostic || undefined,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
}

function parseTimecode(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const fraction = match[4] ? Number.parseInt(match[4].padEnd(3, "0"), 10) : 0;
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction;
}

function cleanCueText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

/**
 * Interpreta cues de SRT/WebVTT sem DOM: blocos separados por linha em branco,
 * linha de tempo obrigatória e texto multilinha preservado.
 */
export function parseSubtitleCues(
  text: string,
  streamIndex: number,
  options: { maxCues?: number } = {},
): { cues: SubtitleCue[]; truncated: boolean } {
  const maxCues = options.maxCues ?? MAX_SUBTITLE_CUES;
  const cues: SubtitleCue[] = [];
  let truncated = false;
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    if (cues.length >= maxCues) {
      truncated = true;
      break;
    }
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    const header = lines.find((line) => line.includes("-->"));
    if (!header) continue; // WEBVTT, NOTE, STYLE, REGION ou cabeçalho de bloco
    const [rawStart, rawRest] = header.split("-->");
    if (rawStart === undefined || rawRest === undefined) continue;
    const start = parseTimecode(rawStart);
    const end = parseTimecode(rawRest.trim().split(/\s+/)[0] ?? "");
    if (start === null) continue;
    const textLines = lines.slice(lines.indexOf(header) + 1);
    const content = cleanCueText(textLines);
    if (!content) continue;
    const index = cues.length + 1;
    cues.push({
      index,
      locator: subtitleCueLocator(streamIndex, index),
      start_ms: start,
      end_ms: end ?? start,
      text: content.slice(0, 4_000),
    });
  }
  return { cues, truncated };
}

const SUBTITLE_LIMITS = [
  "Legendas extraídas da própria faixa do arquivo; não é transcrição de fala.",
  "Faixas de legenda de imagem exigem OCR e não são interpretadas aqui.",
];

/**
 * Extrai as legendas de texto presentes no arquivo, por faixa, com timestamps.
 * Não transcreve fala: se não houver faixa de texto, `captions_present` é falso.
 */
export async function extractEmbeddedSubtitles(
  path: string,
  options: {
    probe?: MediaProbeResult;
    ffmpegPath?: string;
    timeoutMs?: number;
    maxCues?: number;
    byteLength?: number;
  } = {},
): Promise<SubtitleExtractionResult> {
  const startedAt = performance.now();
  const probe = options.probe ??
    await probeMediaFile(path, {
      timeoutMs: options.timeoutMs,
      byteLength: options.byteLength,
    });
  const base: SubtitleExtractionResult = {
    kind: "video_subtitles",
    ok: false,
    coverage: "unavailable",
    captions_present: false,
    text_track_count: probe.text_subtitle_streams,
    image_track_count: probe.image_subtitle_streams,
    tracks: [],
    cue_count: 0,
    limits: SUBTITLE_LIMITS,
    notes: [LISTENING_NOTE, NO_SERVICE_NOTE],
    content_is_untrusted_data: true,
    elapsed_ms: 0,
  };
  if (!probe.ok) {
    return {
      ...base,
      error_code: probe.error_code,
      coverage: probe.coverage,
      diagnostic: probe.diagnostic,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  }
  const textStreams = probe.streams.filter((stream) => stream.text_subtitle);
  const tracks: SubtitleTrack[] = [];
  let diagnostic: string | undefined;
  let failure: MediaToolCode | undefined;
  for (const stream of textStreams) {
    const result = await runTool(
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        path,
        "-map",
        "0:" + stream.index,
        "-f",
        "srt",
        "-",
      ],
      {
        binary: options.ffmpegPath ?? "ffmpeg",
        timeoutMs: options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS,
        maxStdoutBytes: MAX_SUBTITLE_BYTES,
      },
    );
    if (result.error_code) {
      failure = result.error_code;
      diagnostic = result.diagnostic;
      break;
    }
    if (result.code !== 0) {
      failure = "unreadable";
      diagnostic = result.diagnostic;
      break;
    }
    const { cues, truncated } = parseSubtitleCues(
      new TextDecoder().decode(result.stdout),
      stream.index,
      { maxCues: options.maxCues },
    );
    tracks.push({
      stream_index: stream.index,
      language: stream.language,
      codec: stream.codec,
      cue_count: cues.length,
      truncated: truncated || result.stdout_truncated,
      cues,
    });
  }
  if (failure) {
    return {
      ...base,
      error_code: failure,
      coverage: COVERAGE_BY_CODE[failure],
      tracks,
      cue_count: tracks.reduce((sum, track) => sum + track.cue_count, 0),
      diagnostic,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  }
  const cueCount = tracks.reduce((sum, track) => sum + track.cue_count, 0);
  const captions = cueCount > 0;
  return {
    ...base,
    ok: true,
    coverage: captions ? "complete" : "partial",
    captions_present: captions,
    tracks,
    cue_count: cueCount,
    notes: captions ? base.notes : [
      ...base.notes,
      "Nenhuma legenda de texto encontrada no arquivo; a fala não foi transcrita.",
    ],
    diagnostic,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
}

// --- ASR local (filtro whisper do ffmpeg) -----------------------------------

export const ASR_ENGINE_VERSION = "ffmpeg-whisper-cpp-2026-10-07.2";
export const DEFAULT_ASR_LANGUAGE = "pt";
export const DEFAULT_ASR_TIMEOUT_MS = 1_200_000;
export const DEFAULT_ASR_QUEUE = 20;

/**
 * Escapa um valor para uso dentro de um grafo de filtros do ffmpeg.
 *
 * Medido neste ffmpeg (9.0.1): o parser desescapa DUAS vezes, então o
 * dois-pontos precisa de barra dupla (C\:/dir/m.bin é lido como C:/dir/m.bin),
 * e uma barra só falha no parse. A barra invertida é normalizada para barra,
 * que o ffmpeg aceita e evita ambiguidade com o escape.
 *
 * Caracteres que não podem ser expressos com segurança (vírgula, ponto e
 * vírgula, colchetes e apóstrofo) NÃO são escapados aqui: vírgula/ponto e
 * vírgula/colchetes quebram o grafo e o apóstrofo é descartado em silêncio, o
 * que apontaria para outro arquivo. Use `isGraphSafePath` antes e recuse.
 */
export function filterOptionValue(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/:/g, "\\\\:");
}

/**
 * Um caminho só pode entrar no grafo de filtros se não tiver caractere de
 * controle nem os caracteres medidos como inseguros (vírgula, ponto e vírgula,
 * colchetes e apóstrofo). Recusar é preferível a escapar errado: um apóstrofo
 * descartado apontaria silenciosamente para outro arquivo.
 */
export function isGraphSafePath(value: string): boolean {
  if (!value) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (
      character === "," || character === ";" || character === "[" ||
      character === "]" || character === "'"
    ) return false;
  }
  return true;
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    const bytes = await Deno.readFile(path);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", copy);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Separa diretório e nome aceitando barra e barra invertida (Windows). */
export function splitPath(path: string): { dir: string; base: string } {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { dir: ".", base: normalized };
  return { dir: normalized.slice(0, index) || "/", base: normalized.slice(index + 1) };
}

export interface LocalModelInfo {
  path: string;
  bytes: number | null;
  sha256: string | null;
  expected_sha256: string | null;
  integrity: "verified" | "unverified" | "unknown";
  language: string;
}

export interface LocalTranscriptionResult {
  kind: "video_local_transcription";
  ok: boolean;
  error_code?:
    | MediaToolCode
    | "model_missing"
    | "model_integrity"
    | "asr_failed"
    | "invalid_option";
  coverage: Coverage;
  engine: "ffmpeg_whisper_cpp";
  engine_version: string;
  model: LocalModelInfo;
  language: string;
  format: "srt";
  segments: SubtitleCue[];
  segment_count: number;
  first_ms: number | null;
  last_ms: number | null;
  media_duration_ms: number | null;
  timeline_coverage_ratio: number | null;
  transcript_reviewed: false;
  /**
   * Cobertura de transcrição significa cobertura de execução/linha do tempo do
   * áudio, NUNCA acurácia do texto: a saída do motor não é revisada e contém
   * erros de transcrição.
   */
  coverage_scope: "temporal_execution";
  accuracy_verified: false;
  source_unreviewed: true;
  asr: "completed_local";
  visual_analysis: "not_performed";
  audio_source: "in_file_audio";
  limits: string[];
  notes: string[];
  content_is_untrusted_data: true;
  elapsed_ms: number;
  diagnostic?: string;
}

export interface TranscriptionOptions {
  modelPath: string;
  language?: string;
  timeoutMs?: number;
  expectedModelSha256?: string | null;
  /** Caminho do SRT de saída; sem ele, usa diretório temporário e descarta. */
  destinationPath?: string;
  queue?: number;
  useGpu?: boolean;
  mediaDurationMs?: number | null;
  ffmpegPath?: string;
}

export interface TranscriptionCacheStamp {
  engine_version: string | null;
  model_sha256: string | null;
  language: string | null;
}

/**
 * Decide se uma transcrição guardada pode ser reutilizada. Exige motor, idioma
 * e sha256 do modelo idênticos; sem sha conhecido dos dois lados, não reutiliza
 * (não se presume equivalência de modelo).
 */
export function shouldReuseTranscription(
  previous: TranscriptionCacheStamp | null | undefined,
  expected: TranscriptionCacheStamp,
): boolean {
  if (!previous) return false;
  if (!previous.engine_version || previous.engine_version !== expected.engine_version) return false;
  if (!previous.language || previous.language !== expected.language) return false;
  if (!previous.model_sha256 || !expected.model_sha256) return false;
  return previous.model_sha256 === expected.model_sha256;
}

const ASR_LIMITS = [
  "Transcrição local em CPU pelo filtro whisper (whisper.cpp) do ffmpeg.",
  "Nenhum áudio, vídeo ou transcrição é enviado a provedor, API ou serviço externo.",
  "Segmentos com timestamps são saída de máquina: precisão, pontuação e nomes não foram revisados.",
  "Cobertura da transcrição mede execução/linha do tempo do áudio, não acurácia do texto.",
  "Conteúdo visual não é examinado; transcrição de fala não descreve quadros nem slides.",
];

const ACCURACY_NOTE =
  "A transcrição é saída de máquina não revisada (accuracy_verified:false, source_unreviewed:true): " +
  "a cobertura declarada é de execução e linha do tempo do áudio, não de acurácia, e há erros de " +
  "transcrição no texto.";

const CAPTION_ACCURACY_NOTE =
  "A legenda vem do próprio arquivo e não foi conferida contra o áudio por este pipeline " +
  "(accuracy_verified:false).";

function asrErrorResult(
  base: LocalTranscriptionResult,
  code: LocalTranscriptionResult["error_code"],
  coverage: Coverage,
  message: string,
  startedAt: number,
  diagnostic?: string,
): LocalTranscriptionResult {
  const result: LocalTranscriptionResult = {
    ...base,
    ok: false,
    coverage,
    notes: [...base.notes, message],
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
  if (code !== undefined) result.error_code = code;
  if (diagnostic) result.diagnostic = diagnostic;
  return result;
}

/**
 * Transcreve a fala de um arquivo já preservado com o filtro whisper do ffmpeg
 * local e um modelo ggml informado. Roda com cwd no diretório de saída e destino
 * relativo, de modo que o único caminho absoluto no grafo de filtros seja o do
 * modelo, devidamente escapado. Não lança para problemas de execução: devolve
 * ok:false com error_code explícito.
 */
export async function transcribeLocal(
  path: string,
  options: TranscriptionOptions,
): Promise<LocalTranscriptionResult> {
  const startedAt = performance.now();
  const language = (options.language ?? DEFAULT_ASR_LANGUAGE).toLowerCase();
  const base: LocalTranscriptionResult = {
    kind: "video_local_transcription",
    ok: false,
    coverage: "unavailable",
    engine: "ffmpeg_whisper_cpp",
    engine_version: ASR_ENGINE_VERSION,
    model: {
      path: options.modelPath,
      bytes: null,
      sha256: null,
      expected_sha256: options.expectedModelSha256 ?? null,
      integrity: "unknown",
      language,
    },
    language,
    format: "srt",
    segments: [],
    segment_count: 0,
    first_ms: null,
    last_ms: null,
    media_duration_ms: options.mediaDurationMs ?? null,
    timeline_coverage_ratio: null,
    transcript_reviewed: false,
    coverage_scope: "temporal_execution",
    accuracy_verified: false,
    source_unreviewed: true,
    asr: "completed_local",
    visual_analysis: "not_performed",
    audio_source: "in_file_audio",
    limits: ASR_LIMITS,
    notes: [LISTENING_NOTE, NO_SERVICE_NOTE, ACCURACY_NOTE],
    content_is_untrusted_data: true,
    elapsed_ms: 0,
  };
  if (!/^(auto|[a-z]{2,3})$/.test(language)) {
    return asrErrorResult(
      base,
      "invalid_option",
      "parsing_error",
      "Idioma inválido para transcrição (use 'auto' ou um código ISO de 2 a 3 letras).",
      startedAt,
    );
  }
  // O processo filho roda com cwd no diretório de saída, então um caminho de
  // modelo ou de entrada relativo seria resolvido no lugar errado. Fixamos os
  // absolutos antes de montar o grafo e a linha de comando.
  let inputPath = path;
  try {
    inputPath = await Deno.realPath(path);
  } catch {
    // Ausente ou sem permissão: mantém o informado e o erro aparece adiante.
  }
  let modelPath = options.modelPath;
  try {
    modelPath = await Deno.realPath(options.modelPath);
  } catch {
    // Ausente ou sem permissão: mantém o informado e o erro aparece adiante.
  }
  const modelBytes = await fileSize(modelPath);
  if (modelBytes === null || modelBytes === 0) {
    return asrErrorResult(
      base,
      "model_missing",
      "unavailable",
      "Modelo ggml não encontrado no caminho informado; nenhuma transcrição foi executada.",
      startedAt,
    );
  }
  const model: LocalModelInfo = { ...base.model, path: modelPath, bytes: modelBytes };
  if (options.expectedModelSha256) {
    const actual = await sha256OfFile(modelPath);
    model.sha256 = actual;
    if (actual !== options.expectedModelSha256) {
      return asrErrorResult(
        { ...base, model },
        "model_integrity",
        "denied",
        "O sha256 do modelo local não corresponde ao pin esperado; execução recusada.",
        startedAt,
      );
    }
    model.integrity = "verified";
  } else {
    model.integrity = "unverified";
  }

  let destination = options.destinationPath ?? null;
  let cleanupDir: string | null = null;
  if (destination === null) {
    try {
      cleanupDir = await Deno.makeTempDir({ prefix: "arahub-asr-" });
      destination = cleanupDir + "/transcript.srt";
    } catch {
      return asrErrorResult(
        { ...base, model },
        "run_permission_denied",
        "denied",
        "Sem permissão de escrita para o arquivo de transcrição.",
        startedAt,
      );
    }
  }
  const { dir, base: destinationName } = splitPath(destination);
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch {
    // Diretório já existe ou inacessível; o erro aparece na execução.
  }
  if (!isGraphSafePath(modelPath) || !isGraphSafePath(destinationName)) {
    return asrErrorResult(
      { ...base, model },
      "invalid_option",
      "parsing_error",
      "O caminho do modelo ou o nome do arquivo de transcrição tem caractere que o grafo de " +
        "filtros do ffmpeg não aceita com segurança (vírgula, ponto e vírgula, colchetes, " +
        "apóstrofo ou controle); renomeie/mova o arquivo e repita.",
      startedAt,
    );
  }
  const graph = [
    "whisper=model=" + filterOptionValue(modelPath),
    "language=" + language,
    "queue=" + (options.queue ?? DEFAULT_ASR_QUEUE),
    "use_gpu=" + (options.useGpu === true ? "true" : "false"),
    "destination=" + filterOptionValue(destinationName),
    "format=srt",
  ].join(":");
  const run = await runTool(
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-af",
      graph,
      "-f",
      "null",
      "-",
    ],
    {
      binary: options.ffmpegPath ?? "ffmpeg",
      timeoutMs: options.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS,
      maxStdoutBytes: 4096,
      cwd: dir,
    },
  );
  try {
    if (run.error_code) {
      return asrErrorResult(
        { ...base, model },
        run.error_code,
        COVERAGE_BY_CODE[run.error_code],
        "A transcrição local não pôde ser executada (" + run.error_code + ").",
        startedAt,
        run.diagnostic,
      );
    }
    if (run.code !== 0) {
      return asrErrorResult(
        { ...base, model },
        "asr_failed",
        "unavailable",
        "O filtro whisper falhou ao transcrever o áudio.",
        startedAt,
        run.diagnostic,
      );
    }
    let srt: string;
    try {
      srt = await Deno.readTextFile(destination);
    } catch {
      return asrErrorResult(
        { ...base, model },
        "asr_failed",
        "unavailable",
        "O filtro whisper terminou sem produzir arquivo de transcrição.",
        startedAt,
      );
    }
    const parsed = parseSubtitleCues(srt, 0, { maxCues: MAX_SUBTITLE_CUES });
    const segments = parsed.cues.map((cue) => ({
      ...cue,
      locator: "asr:" + language + ":" + cue.index,
    }));
    const first = segments.length ? segments[0].start_ms : null;
    const last = segments.length ? Math.max(...segments.map((cue) => cue.end_ms)) : null;
    const duration = options.mediaDurationMs ?? null;
    const ratio = last !== null && duration !== null && duration > 0
      ? Math.min(1, last / duration)
      : null;
    const truncated = parsed.truncated || run.stdout_truncated;
    const shortTimeline = ratio !== null && ratio < 0.9;
    const coverage: Coverage = segments.length === 0 || truncated || shortTimeline
      ? "partial"
      : "complete";
    const notes = [...base.notes];
    if (segments.length === 0) {
      notes.push("Nenhum segmento de fala transcrito (silêncio, ruído ou áudio sem fala).");
    } else if (shortTimeline) {
      notes.push(
        "A transcrição termina antes do fim do arquivo; pode haver trecho não processado.",
      );
    }
    return {
      ...base,
      ok: segments.length > 0,
      coverage,
      model,
      segments,
      segment_count: segments.length,
      first_ms: first,
      last_ms: last,
      timeline_coverage_ratio: ratio,
      notes,
      elapsed_ms: Math.round(performance.now() - startedAt),
    };
  } finally {
    if (cleanupDir !== null) {
      await Deno.remove(cleanupDir, { recursive: true }).catch(() => {});
    }
  }
}
