# Vinxa Desktop

Vinxa Desktop is a Windows-only, offline-first meeting memory app. It captures the local microphone and system audio from any meeting application, shows a live transcript in a floating overlay, then saves searchable notes, decisions, and action items locally.

The product is built for a short hackathon sprint. The first objective is a reliable local audio-to-transcript loop. AI notes, polish, and stretch features follow only after that loop works in the packaged app.

## Product principles

Current implementation: Developer A's consent/setup, global hotkeys, controller,
and draggable overlay are connected to Developer B's Phase 2 local speech service.
Normal launch uses live microphone/system transcription after consent. Set
VINXA_BACKEND=demo explicitly for written fixtures and no audio capture.
The Stitch frontend is now integrated and has been built and tested, including
the real speech pipeline with synthetic microphone input. Phase 3 adds saved
meetings, separate audio files, source-based echo deduplication, and AI notes.
See [Phase 3 implementation and acceptance](docs/phase3-completion-report.md),
[frontend assessment and verification](docs/stitch-frontend-integration.md),
[local integration setup and checks](docs/phase2-local-integration.md) and
[Developer A's interface guide](docs/phase-2.md).
The native main-window X-button issue remains parked; use the tray's Quit action.

The original seven-screen Stitch export is preserved in `design/stitch/`.
The active UI uses React, local CSS, bundled Inter/JetBrains Mono fonts and local
SVG icons, with live recording state throughout. Use `pnpm smoke:ui` after
`pnpm build` to repeat the desktop UI checks; `pnpm smoke:ui:live` additionally
uses synthetic speech with the real cached local model.

- **Local-only by default.** Audio, transcripts, and search stay on the laptop. Cloud notes are an explicit opt-in and receive transcript text, never audio.
- **Two separate audio streams.** Microphone is labelled **You** and WASAPI loopback is labelled **Remote**. Conservative text echo deduplication preserves committed segments and genuine extended replies.
- **Consent is enforced.** Recording cannot begin until the user confirms consent. The overlay, tray, and taskbar show a persistent recording state.
- **Evidence over invention.** Notes use schema validation; unknown owners and dates are `null`, not guesses.

## Architecture

```text
Windows microphone + WASAPI loopback
        |
        v
Electron hidden capture window
getUserMedia + getDisplayMedia -> AudioWorklet (16 kHz mono PCM)
        | localhost WebSocket, session token
        v
Python sidecar
VAD -> faster-whisper -> partial/final transcript events
        |
        v
Electron main process
state machine -> SQLite/FTS5 + local audio spool -> validated notes
        |
        v
React overlay and library
live transcript, saved meetings, insights, consent, settings
```

Capture, SQLite, raw-audio spooling, saved history, and notes are connected.
Search in Library covers transcripts, summaries, decisions, and actions. Matches in newly generated notes open the supporting transcript passage. Older notes without a saved source open in their original tab. From the meeting detail you can export Markdown or PDF, recover an interrupted session, or delete its local data. Exports and text previously sent to a cloud provider remain under separate control.

Settings includes privacy counters, speech model size (applied on restart), and pending notes. When a provider is unavailable, pending notes retry automatically with increasing delays of up to ten minutes. Local speech models must already be installed. To exercise search, export, deletion, and recovery in a temporary profile after building the Windows package, run `pnpm smoke:phase4 --packaged`. For synthetic microphone capture through Whisper, local notes, restart, search, export, and deletion, set `VINXA_SMOKE_NOTES_MODEL` to an installed Ollama model and run `node scripts/smoke-live-ui.cjs --packaged`. Add `--crash` to terminate the isolated test app during capture and verify recovery and notes regeneration.

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
| Export | Markdown and PDF through Electron printToPDF |
| Packaging | electron-builder; PyInstaller for the sidecar |
| Tests | Vitest, pytest, fixture harness, jiwer word-error-rate checks |

## Repository layout

```text
src/
  shared/      Types, Zod schemas, and IPC channel names.
  main/        Electron lifecycle, tray, hotkeys, consent, speech and state machine.
    db/        SQLite migrations, repositories, FTS5 index.
    audio/     Capture, WAV spool and audio level handling.
    insights/  Local and cloud note providers, prompts, chunking.
  preload/     Narrow, context-isolated renderer bridge.
  renderer/    Capture window, floating overlay, and React library screens.
sidecar/       Local transcription service and its Python dependencies.
harness/       Repeatable audio fixtures, latency, and word-error-rate measurement.
docs/          PRD, architecture, privacy, and test-result documentation.
```

## Prerequisites

- Windows 10 or 11, x64
- Node.js 24.13+ and the pnpm version pinned in package.json (the verification scripts use Node's TypeScript loader hooks)
- Python 3.11+
- Visual Studio Build Tools with the Desktop development with C++ workload (required by `better-sqlite3` when no prebuilt binary is available)
- A model cache outside this repository; do not commit downloaded speech or LLM models

## Local setup

Live mode needs the Phase 2 Python dependencies and a cached speech model outside
the repository. Reuse your existing virtual environment. Model preparation can
download files; normal inference uses cached files only.

```powershell
pnpm install
if (!(Test-Path .venv\Scripts\python.exe)) { py -3.11 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r sidecar/requirements-phase2.txt
.\.venv\Scripts\python.exe -c "from sidecar.engine import SpeechEngine; SpeechEngine('base.en').load()"
Remove-Item Env:VINXA_CAPTURE_TEST -ErrorAction SilentlyContinue
$env:VINXA_BACKEND = 'local'
pnpm dev
```

Wait for the engine-ready message, then Start and confirm consent. The selected
microphone and Windows default-output audio appear as You and Remote. Pause
releases capture devices and flushes final words; Resume acquires fresh tracks.
Stop drains speech, finalizes audio, and saves notes or an explicit pending/failed
notes status. Library restores saved meetings across app restarts. The overlay supports dragging,
resize, collapse, opacity, and copying recent lines. Hotkeys default to
Ctrl+Alt+S, Ctrl+Alt+P, and Ctrl+Alt+X.

For UI-only fixtures, set `$env:VINXA_BACKEND='demo'` before `pnpm dev`. Demo mode
does not start Python, capture audio, or invent meter readings. Set runtime
options in the launching PowerShell session; `.env.example` is a template.

## Saved meetings and notes

Normal local sessions save under Electron's user-data directory. The database is
`meetings.sqlite3`; audio is `meetings/<meeting-id>/microphone.wav` and
`system.wav`, plus `metadata.json`. Disabled sources have no file. These are
16 kHz mono PCM WAVs. Library supports reopening, renaming, speaker display names,
summary/decisions/actions, and persisted action completion. Demo mode does not
create saved meetings.

For local notes, start Ollama and run `ollama list`. In Vinxa Settings → Meeting
notes, leave the provider as **Ollama · local-only**, enter an installed model's
exact name, and save. The application only connects to `127.0.0.1:11434` and does
not download a model or switch to cloud automatically. If Ollama is unavailable
or the model is missing, the recording stays saved and Notes stays pending.
After starting Ollama, open the meeting and choose Generate notes.

On this laptop, `llama3:latest` passed a short live recording test with a
300-second timeout. Both installed models timed out on the ten-minute benchmark
at the default 180-second timeout. See the [measured benchmark](docs/phase3-notes-benchmark.md)
before treating long-meeting notes as ready. Review generated notes against the
transcript; schema validation cannot prove factual accuracy.

OpenAI is optional. In Settings choose **OpenAI · opt-in cloud notes**, explicitly
check the transcript-sharing consent box, enter a model that supports structured
outputs and your API key, then save. Only transcript text and derived text notes
are sent; audio stays local. The key is encrypted by Electron safeStorage on
Windows, never returned by the settings API, and can be removed in Settings.
Selecting Ollama or disabling consent prevents subsequent OpenAI requests.
No live OpenAI call was made during Phase 3 verification.

After `pnpm build`, run `pnpm smoke:phase3` for the real Electron/SQLite restart
check with seeded notes. For real local speech and live Ollama notes, run
`$env:VINXA_SMOKE_NOTES_MODEL='llama3:latest'` followed by `pnpm smoke:ui:live`.
That test uses synthetic speech, an isolated profile, and no physical microphone.
Clear `VINXA_SMOKE_NOTES_MODEL` afterwards. `pnpm benchmark:notes` compares the
installed local models on the supplied synthetic ten-minute fixture.

If another application owns the demo smoke's default shortcuts, set
`$env:VINXA_SMOKE_HOTKEYS='{"start":"Ctrl+Alt+J","pause":"Ctrl+Alt+K","stop":"Ctrl+Alt+L"}'`
before `pnpm smoke:ui`, then clear that variable. The smoke uses an isolated
profile and still checks real Windows shortcut registration.

Use `pnpm icons` to regenerate the temporary application/tray icon. `pnpm package:win`
builds an unsigned NSIS installer and portable executable under `release/`.
Windows packaging now freezes the Python runtime and copies the selected cached
model into the installer resources. Install sidecar/requirements-package.txt
before pnpm package:win. No packaging build has been run for these changes.
See the [Phase 2 completion checks](docs/phase2-completion-checklist.md) for the
packaged speech smoke and real-call acceptance steps. The separate shell smoke
explicitly selects demo mode and does not validate real speech.

Developer B's microphone diagnostic is opt-in. Set `$env:VINXA_CAPTURE_TEST='mic'`
before `pnpm dev`, then confirm the native recording prompt. It saves
`test_recordings/mic.wav` and stops after 30 seconds or when Stop recording is clicked.
Run `node scripts/validate-wav.mjs test_recordings/mic.wav` to check the result.
See [microphone capture status and test steps](docs/phase1-audio-capture.md).
Diagnostic mode opens a dedicated screen and does not enable the demo controls
or global hotkeys. Clear `VINXA_CAPTURE_TEST` before returning to normal live/demo sessions.

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

Live audio is processed by the authenticated local speech service after consent.
This path saves no raw WAV files or permanent transcript history. Consent receipts
and hotkey settings are stored in Electron's user-data directory. Optional bounded
diagnostics contain numeric timing/accounting data, not speech text or audio.
Meeting-app mute does not mute Vinxa's microphone. The opt-in Phase 1 diagnostics
still save WAV files separately. Persistent history, echo deduplication, the
broader network guard, deletion, and optional cloud notes remain later work.

## Delivery order

1. Electron shell, installer smoke test, shared contracts.
2. Separate microphone and loopback capture; local faster-whisper speed test.
3. Live transcript, hotkeys, consent, recording indicator.
4. Persistence, search, notes, export, and deletion.
5. Offline/recovery/device-change verification, then stretch goals.

See [docs/README.md](docs/README.md), [sidecar/README.md](sidecar/README.md), and [harness/README.md](harness/README.md) for the working contracts and validation plan.
