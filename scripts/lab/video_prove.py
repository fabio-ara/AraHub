"""Create an original MAT-02 fixture using installed Windows TTS and ffmpeg only.

No course content, network service, model download or browser is used. Generated
media stays private. Run from the repository root: python scripts/lab/video_prove.py
Then use the existing process_materials.ts CLI and video_prove.ts SQL/SDK probe.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(".private/evidence/video-mat02")
SOURCE = ROOT / "source"
BUILD = ROOT / "build"
for directory in (SOURCE, BUILD):
    directory.mkdir(parents=True, exist_ok=True)
VIDEO = SOURCE / "mat02-synthetic.mp4"
if VIDEO.exists():
    raise SystemExit("Fixture already exists; reuse its bytes instead of regenerating.")

spoken = [
    {"start_ms": 1000, "text": "Este vídeo é um teste sintético do AraHub. A palavra da primeira parte é abacaxi."},
    {"start_ms": 12000, "text": "Esta é a segunda parte do teste. A palavra falada agora é borboleta. Não há conteúdo de curso."},
    {"start_ms": 23000, "text": "Chegamos à terceira parte. A palavra final é bicicleta. O teste termina depois de uma pausa."},
]
spec = {"synthetic": True, "external_service": False, "voice": "Microsoft Maria Desktop", "spoken": spoken}
(BUILD / "tts-input.json").write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
tts = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$spec = Get-Content -LiteralPath '.private/evidence/video-mat02/build/tts-input.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice.SelectVoice($spec.voice)
  $voice.Rate = 0
  for ($part = 0; $part -lt $spec.spoken.Count; $part++) {
    $path = Join-Path (Get-Location) ('.private/evidence/video-mat02/build/speech-' + $part + '.wav')
    $voice.SetOutputToWaveFile($path)
    $voice.Speak([string]$spec.spoken[$part].text)
    $voice.SetOutputToNull()
  }
} finally { $voice.Dispose() }
"""
tts_path = BUILD / "synthesize.ps1"
tts_path.write_text(tts, encoding="utf-8-sig")
commands = []


def run(args, timeout=120):
    commands.append(args)
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    (BUILD / f"command-{len(commands):02}.log").write_bytes(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError(f"Local command {len(commands)} failed; see private log")
    return result.stdout


# Invoke the same local API as a command; do not change execution policy.
run(["powershell.exe", "-NoProfile", "-Command", tts])
for index, part in enumerate(spoken):
    raw = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(BUILD / f"speech-{index}.wav")])
    duration = round(float(json.loads(raw)["format"]["duration"]) * 1000)
    assert duration < 10500, "Speech must fit its eleven-second slot"
    part["end_ms"] = part["start_ms"] + duration

labels = ["SYNTHETIC MAT02 - VISUAL ONLY 731", "SYNTHETIC MAT02 - VISUAL ONLY 482", "SYNTHETIC MAT02 - VISUAL ONLY 956"]
video_graph = "drawbox=x=0:y=0:w=iw:h=120:color=black:t=fill"
for index, label in enumerate(labels):
    video_graph += f",drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='{label}':fontsize=34:fontcolor=white:x=40:y=40:enable='between(t,{index * 11},{(index + 1) * 11})'"
audio_graph = ";".join(f"[{i + 1}:a]adelay={p['start_ms']}:all=1[a{i}]" for i, p in enumerate(spoken))
audio_graph += ";[a0][a1][a2]amix=inputs=3:normalize=0,apad,atrim=duration=34[a]"
args = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24"]
for index in range(len(spoken)):
    args += ["-i", str(BUILD / f"speech-{index}.wav")]
args += ["-filter_complex_threads", "1", "-filter_complex", audio_graph, "-map", "0:v", "-map", "[a]", "-vf", video_graph, "-t", "34", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-b:v", "8M", "-minrate", "8M", "-maxrate", "8M", "-bufsize", "16M", "-x264-params", "nal-hrd=cbr:force-cfr=1", "-c:a", "aac", "-ar", "48000", "-ac", "1", "-movflags", "+faststart", str(VIDEO)]
run(args)
data = VIDEO.read_bytes()
assert len(data) > 20 * 1024 * 1024
spec.update({"source_path": VIDEO.as_posix(), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "duration_ms": 34000, "visual_labels": [{"start_ms": i * 11000, "end_ms": (i + 1) * 11000, "text": label} for i, label in enumerate(labels)], "visual_status": "generated_ground_truth_not_yet_inspected", "speech_status": "local_tts_ground_truth_not_asr", "silent_intervals_ms": [[0, 1000]] + [[p["end_ms"], spoken[i + 1]["start_ms"] if i < 2 else 34000] for i, p in enumerate(spoken)], "commands": commands})
(ROOT / "fixture.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"fixture": VIDEO.as_posix(), "bytes": len(data), "sha256": spec["sha256"], "voice": spec["voice"]}))
