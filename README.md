# Vinxa Desktop

Vinxa Desktop is a Windows-only, offline-first meeting memory app. It captures the local microphone and system audio from any meeting application, shows a live transcript in a floating overlay, then saves searchable notes, decisions, and action items locally.

The product is built for a short hackathon sprint. The first objective is a reliable local audio-to-transcript loop. AI notes, polish, and stretch features follow only after that loop works in the packaged app.

## Product principles

- **Local-only by default.** Audio, transcripts, and search stay on the laptop. Cloud notes are an explicit opt-in and receive transcript text, never audio.
- **Two separate audio streams.** Microphone is labelled **You** and WASAPI loopback is labelled **Remote**. The streams are not blindly mixed, which prevents echo duplicates.
- **Consent is enforced.** Recording cannot begin until the user confirms consent. The overlay, tray, and taskbar show a persistent recording state.
- **Evidence over invention.** Notes use schema validation; unknown owners and dates are `null`, not guesses.

## Architecture

```text
Windows microphone + WASAPI loopback
        â”‚
        â–¼
Electron hidden capture window
getUserMedia + getDisplayMedia â†’ AudioWorklet (16 kHz mono PCM)
        â”‚ localhost WebSocket, session token
        â–¼
Python sidecar
VAD â†’ faster-whisper â†’ partial/final transcript events
        â”‚
        â–¼
Electron main process
state machine â†’ SQLite/FTS5 â†’ local audio spool â†’ exports
        â”‚
        â–¼
React overlay and library
live transcript, search, insights, consent, settings
```

## Technology stack

| Area | Choice |
| --- | --- |
| Desktop application | Electron + TypeScript |
| UI | React + electron-vite + CSS variables |
| Capture | WASAPI loopback through Electron; `getUserMedia` for microphone |
| Audio frames | AudioWorklet, 16 kHz mono Int16 PCM, 100 ms frames |
| Speech | Python sidecar with faster-whisper/CTranslate2; whisper.cpp is the documented swap |
| Streaming | Silero VAD, rolling re-transcription, LocalAgreement commits |
| Notes | Ollama locally; OpenAI structured outputs only when cloud notes are enabled |
| Validation | Zod for IPC, sidecar events, and model output |
| Local data | SQLite via better-sqlite3, FTS5, WAL mode |
| Export | Markdown template and Electron `printToPDF` |
| Packaging | electron-builder; PyInstaller for the sidecar |
| Tests | Vitest, pytest, fixture harness, jiwer word-error-rate checks |

## Repository layout

```text
src/
  shared/      Types, Zod schemas, and IPC channel names.
  main/        Electron lifecycle, tray, hotkeys, consent, state machine, recovery.
  db/          SQLite schema, repositories, FTS5 search, deletion.
  audio/       WAV spool and audio level handling.
  stt/         Sidecar lifecycle and WebSocket client.
  insights/    Local and cloud note providers, prompts, chunking.
  export/      Markdown and PDF export templates.
  preload/     Narrow, context-isolated renderer bridge.
  renderer/    Capture window, floating overlay, and React library screens.
sidecar/       Local transcription service and its Python dependencies.
harness/       Repeatable audio fixtures, latency, and word-error-rate measurement.
docs/          PRD, architecture, privacy, and test-result documentation.
```

## Prerequisites

- Windows 10 or 11, x64
- Node.js 22+ and pnpm 10+
- Python 3.11+
- Visual Studio Build Tools with the Desktop development with C++ workload (required by `better-sqlite3` when no prebuilt binary is available)
- A model cache outside this repository; do not commit downloaded speech or LLM models

## Local setup

Phase 1 Developer A work needs Node.js and pnpm only. The Python setup below is
needed when running Developer B's speech sidecar or harness. Current status: the
tray shell, contracts, sample transcript player, opt-in mic/system WAV diagnostics
and independent offline Python WAV transcription are implemented. The live
capture-to-transcript connection, saved meetings and AI notes are later work.

```powershell
pnpm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
pnpm dev
```

For the current desktop shell, run `pnpm install` and `pnpm dev`. Click Play sample
to replay written transcript fixtures. Closing the window hides it in the tray;
Open Library restores it and Quit exits. Recording tray controls are disabled until
Phase 2. `pnpm dev` currently starts Electron only, without a Python sidecar.

Use `pnpm icons` to regenerate the temporary application/tray icon. `pnpm package:win`
builds an unsigned NSIS installer and portable executable under `release/`.
The current package contains the Phase 1 shell; sidecar/model packaging will be
added when Developer B supplies those artifacts. See [Phase 1 contracts](docs/phase-1-contracts.md)
for the integration proposal and completion checks.

Developer B's microphone diagnostic is opt-in. Set `$env:VINXA_CAPTURE_TEST='mic'`
before `pnpm dev`, then confirm the native recording prompt. It saves
`test_recordings/mic.wav` and stops after 30 seconds or when Stop recording is clicked.
Run `node scripts/validate-wav.mjs test_recordings/mic.wav` to check the result.
See [microphone capture status and test steps](docs/phase1-audio-capture.md).

For the Python Phase 1 environment and offline benchmark commands, follow
[Developer B setup](README-developer-b.md). The measured English baseline is
faster-whisper base.en CPU INT8; see [all measured runs and limitations](docs/phase1-speech-benchmark.md).
The Google Meet real-call/video and required device checks are recorded. Generic
Electron loopback missed Meet on a non-default output; the standalone selected-
OnePlus fallback captured clear remote speech and passed strict validation.
Mentor/team reviews remain pending; see [final acceptance](docs/phase1-final-acceptance-report.md).

Use `$env:VINXA_CAPTURE_TEST='system'` for Windows loopback into `system.wav`,
or `'both'` for separate `mic.wav` and `system.wav` files. Move previous test WAVs
to a local archive before repeating. Play audio through Windows default output,
and use headphones for the simultaneous test. No video is saved.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the Electron development application. |
| `pnpm typecheck` | Check TypeScript without emitting output. |
| `pnpm test` | Run renderer/main-process unit tests. |
| `pnpm build` | Produce application bundles. |
| `pnpm package:win` | Build the Windows installer and portable package. |
| `pnpm smoke:win "D:\path\to\Vinxa Desktop.exe"` | Exercise the packaged shell, sample player, single instance, and quit. |
| `pytest sidecar harness` | Run sidecar and harness tests. |

## Privacy and data handling

The default **Local-only** mode blocks non-localhost network requests. When a user enables cloud notes, only finalized transcript text may be sent to the selected provider. Recordings are stored outside the repository in the user data directory. Deleting a meeting must remove its audio, transcript, notes, FTS entries, bookmarks, and temporary files before it disappears from the interface. Exported copies and information already sent to an opted-in cloud provider are outside local deletion.

## Delivery order

1. Electron shell, installer smoke test, shared contracts.
2. Separate microphone and loopback capture; local faster-whisper speed test.
3. Live transcript, hotkeys, consent, recording indicator.
4. Persistence, search, notes, export, and deletion.
5. Offline/recovery/device-change verification, then stretch goals.

See [docs/README.md](docs/README.md), [sidecar/README.md](sidecar/README.md), and [harness/README.md](harness/README.md) for the working contracts and validation plan.
