# Developer B: Phase 1 audio and speech

Phase 1 now has separate Electron mic/loopback diagnostics, an offline Python
speech engine and measured backend comparisons. The installed desktop shell
passed its smoke test. The Google Meet real-call/video recording passes strict
WAV validation and user listening. Required device checks are recorded, including
the primary non-default routing failure and successful standalone fallback.
Focused local commits record the implementation and evidence. Mentor/team review
is pending, so Phase 1 is not yet fully accepted.

## Setup and checks

Run from the repository root on branch navya. Use the packageManager version in
package.json and Python 3.11. The minimal Phase 1 installation does not install
future streaming services.

```powershell
git branch --show-current
git status --short
pnpm install --frozen-lockfile
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r sidecar/requirements-phase1.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m pytest sidecar -q
pnpm typecheck
pnpm test
pnpm build
```

If node-gyp cannot discover an installed C++ toolchain, run the native rebuild
and packaging commands from the Microsoft x64 Native Tools / Developer Command
Prompt. On this laptop, the registered Build Tools installation was incomplete,
but its actual VsDevCmd environment successfully rebuilt the native dependency.
Do not treat the incomplete installer registration as repaired.

```powershell
pnpm exec electron-builder install-app-deps
pnpm package:win
node scripts/smoke.cjs "release/win-unpacked/Vinxa Desktop.exe"
```

## Local speech benchmark

First download requires a network connection and enough cache space. After that,
--offline requires the existing cached model. The default cache is outside Git
under local application data / Vinxa / models. VINXA_MODEL_DIR or --cache-dir can
select another directory outside the repository.

```powershell
.\.venv\Scripts\python.exe -m sidecar.benchmark --input test_recordings/mic.wav --model base.en --language en --runs 3 --threads 4 --output tmp/base-metrics.json
.\.venv\Scripts\python.exe -m sidecar.benchmark --input test_recordings/mic.wav --model small --language en --runs 3 --threads 4 --output tmp/small-metrics.json
```

Use the identical WAV for every configuration. Existing metrics files are
preserved; choose new names when repeating. Add --reference with a private UTF-8
ground-truth transcript only when one is available. Without it, WER stays pending.
The engine returns transcript text to its caller, while the CLI prints and saves
metrics only. Never put real transcript text in logs or Git.

For whisper.cpp, download an official Windows CPU build and matching GGML model,
keep weights outside the repository, and set runtime paths locally:

```powershell
.\.venv\Scripts\python.exe -m sidecar.benchmark_cpp --input test_recordings/mic.wav --binary "$env:VINXA_WHISPER_CPP" --model-path "$env:VINXA_GGML_MODEL" --model-name base.en --threads 4 --runs 3 --language en --output tmp/cpp-metrics.json
```

The measured recommendation is faster-whisper base.en CPU INT8 for English.
See [all runs and limitations](docs/phase1-speech-benchmark.md), with
[metrics JSON](docs/phase1-benchmark-results.json). A Python executable has not
been bundled into the Electron installer; Phase 1 provides an independent WAV
engine, not the future streaming server.

## Physical capture and real-call checks

Final acceptance procedures and the latest evidence are in
[the device checklist](docs/phase1-device-compatibility.md) and
[final acceptance report](docs/phase1-final-acceptance-report.md).
VINXA_MIC_GAIN defaults to 0.75 (range 0.1–1.0) for new recordings. It adds
headroom before Int16 conversion; it does not repair upstream clipping.
VINXA_CAPTURE_DIR selects a fresh directory and VINXA_CAPTURE_ACCEPTANCE=1
uses microphone.wav/system_audio.wav for the real-call pair. Packaged diagnostics
default to userData/test_recordings so they can write outside the ASAR archive.
System capture also requires the bundled Windows default-output monitor and the
standard Windows PowerShell/.NET/Core Audio runtime. It reads endpoint identity
without opening another audio stream or changing settings. If monitoring cannot
start or stops responding, capture stops with an explicit error. A default
output change requires a fresh capture on the new route; no seamless migration
is claimed. See the device checklist for the failed original test and retest.

Quit other Vinxa instances. Preserve previous test WAVs in a new local archive
directory; the writer intentionally refuses to overwrite them. Connect
headphones, reduce mic input level if full-scale samples occur, and route meeting
audio through the Windows default output. Inform participants before recording.

```powershell
pnpm build
$env:VINXA_CAPTURE_TEST = 'both'
& .\node_modules\electron\dist\electron.exe .
```

Confirm Start audio test yourself. The diagnostic stops after 30 seconds or when
Stop recording is selected. Use a short Teams, Zoom or Meet call with another
person: speak while they are quiet, then stay quiet while they speak; include
video playback during the call. Save each scenario in its own local folder.
Validate and listen to both files:

```powershell
node scripts/validate-wav.mjs test_recordings/mic.wav
node scripts/validate-wav.mjs test_recordings/system.wav
Remove-Item Env:VINXA_CAPTURE_TEST
```

Both validators must pass, your voice must be intelligible in mic.wav, and the
remote voice/playback must be intelligible in system.wav. Check isolation while
each side is quiet. A valid header alone does not prove real-call capture.
If clipped, lower the physical input/playback level and repeat. Do not normalize
an already clipped WAV and call it a clean capture.

The original headphone mic file has ten full-scale samples and is preserved.
The later Google Meet real-call/video pair at gain 0.75 passes both strict WAV
validators with zero full-scale output samples and user-confirmed clear/correct
content. Two pre-gain mic input endpoints remain a documented headroom warning.
Bluetooth, OS microphone denial and corrected default-output change/restart
checks pass for the recorded OnePlus/Realtek configurations. Non-default meeting
output failed: only video was heard, with the remote Meet voice absent. The
selected-output fallback then passed strict validation and user listening with
clear remote voice. Mentor/team review remains pending. The failed primary test
also flags one full-scale sample. Follow
[the acceptance report](docs/phase1-final-acceptance-report.md) and
[device matrix](docs/phase1-device-compatibility.md).
