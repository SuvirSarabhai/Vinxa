# Speech Sidecar

The integrated Phase 2 app now has a Windows runtime/model packaging command.
Install requirements-package.txt and run pnpm package:win from the repo root.
The builder freezes the server with PyInstaller and copies an already cached
converted model; it does not download one. See
[Phase 2 completion checks](../docs/phase2-completion-checklist.md). Packaging and
the new lifecycle regressions have not been executed during this implementation.

Phase 1 implements local WAV recognition through engine.py and repeatable
benchmarks in benchmark.py and benchmark_cpp.py. See
[Developer B setup](../README-developer-b.md) and
[measured results](../docs/phase1-speech-benchmark.md). There is no
live Electron speech integration yet. Phase 2 Stage 2 now adds the authenticated
transport described below.

## Phase 2 transport checkpoint

Install `requirements-phase2.txt` in the existing project virtual environment.
The new `python -m sidecar.server` entry point binds only 127.0.0.1 on a random
port. Its parent supplies a fresh token, session UUID and generation through
environment, not command-line arguments. The first stdout JSON line reports
socket listening, not a warmed model. First-message config is authenticated and
validated against JSON Schema generated from src/shared/schemas.ts.

At this stage, ping/stop, validation and cleanup work. Valid audio is explicitly
rejected with NOT_READY until VAD, streaming and model warm-up are implemented;
no transcript is generated. Preload status/error subscriptions are available,
but Developer A's recording flow is not connected to a sidecar manager yet.
See [architecture and protocol](../docs/phase2-sidecar-architecture.md).

## Selected-output Phase 1 diagnostic

When Meet uses a different output from Windows default, the tested Electron
loopback missed the remote voice. `python -m sidecar.loopback_fallback --list`
lists WASAPI loopbacks without recording. Install the existing bounded
PyAudioWPatch dependency from requirements.txt first. To test one output, supply
`--device-name` with the exact listed loopback name, `--output` with a new WAV path
and `--seconds 20`. A local Start button controls recording. This saves only that
output as source 1, at 16 kHz mono signed Int16; microphone capture stays separate.
The existing SpeechEngine accepts this finalized WAV without changes. Physical
fallback validation passed for OnePlus/Meet with Windows default on Realtek:
20 seconds, strict validator pass and user-confirmed clear remote speech.
This is not an automatic Electron fallback and
does not capture multiple output devices at once.

The remaining responsibilities and protocol below describe the planned later
streaming service. Electron will send binary 16 kHz mono PCM frames over a
localhost WebSocket and receive schema-validated status, partial-transcript,
final-transcript and error events.

## Responsibilities

- Receive microphone and system-audio frames without mixing them.
- Apply voice activity detection before inference.
- Run faster-whisper incrementally and use LocalAgreement to commit stable words.
- Preserve `source`, start/end millisecond timestamps, and finality on every segment.
- Deduplicate near-identical mic/system text caused by speaker echo.
- Keep its WebSocket server bound to `127.0.0.1` and require a session token.

## Model policy

Use `base.en` int8 for the first performance baseline. Test `small` int8 for Indian-English accents and Hindi-English code-switching. Models are machine-local assets: configure their location with `VINXA_MODEL_DIR`, keep them out of Git, and record the selected model plus real-time factor in the harness report.

## Protocol outline

1. Electron opens `ws://127.0.0.1:<port>` and sends a configuration message with a one-time session token.
2. Each PCM frame is prefixed with a one-byte source id: `0x00` for microphone and `0x01` for system audio.
3. The sidecar publishes JSON events. Transcript events include `source`, `text`, `startMs`, `endMs`, and `isFinal`.
4. On loss of the sidecar, Electron shows a clear status, retains local audio, and may restart the process with bounded retries.

The actual protocol and Pydantic models will live beside `server.py` once the Hour 0 shared contracts are frozen.
