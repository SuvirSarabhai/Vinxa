# Developer A/B Phase 2 local integration

The starting checkout was clean on suvir at 81a21dd, already containing Developer
B's Phase 2 and Developer A's UI. The remaining work was connecting the normal
recording flow to the pulled speech service. No older, reverted speech server
was restored. No install, build, test, recording, model command, commit, or push
was performed during this integration. User-run verification remains required.

## Resulting behavior

- Normal startup warms Developer B's existing SpeechService and shows engine
  readiness. Start is disabled until the service is ready. Warm-up opens no audio
  devices. VINXA_BACKEND=demo explicitly selects fixtures and skips Python startup.
- The existing SessionController saves consent before authorizing speech and
  capture. The selected microphone and default Windows output use separate hidden
  sandboxed windows, with permission and IPC checks bound to the exact source.
  Production capture shares the UI's Electron session/origin so selected device
  identifiers remain usable. While recording, capture permissions are granted
  only to the matching hidden source window; those handlers are removed on stop.
- RecordingCapture reuses the pulled capture renderer, AudioWorklet, PCM encoder,
  measured clock exchanges, frame metadata, and negotiated protocol version 2.
  Both sources share a main-process epoch, including pause gaps. No extra Python
  server or alternate wire format was added.
- Main-process SpeechService subscriptions feed real segments into the controller,
  which publishes to both the library and overlay through its existing preload
  bridge. Mic is You and system is Remote. Revised partial timing is accepted;
  an empty cancellation final removes its provisional row.
- PCM-derived audio meters are shown in the library. Before consent, meters stay
  unavailable. The normal live path does not write raw audio or meeting history.
- Pause closes real tracks, drains received frames, reports each source's padding,
  and waits for final inference before entering paused. Resume starts a fresh
  capture generation with new measured anchors. Stop explicitly authorizes only
  the final capture drain while the controller is stopping, then ends the speech
  session while retaining the warmed model. Quit awaits capture/session cleanup
  before terminating Python.
- During a supervised speech restart, finalized rows remain and provisional rows
  are cleared. Existing bounded recovery buffers and dropped-sample notices remain
  visible. Capture remains in the already-consented recording session during a
  recoverable restart. Permanent failure, capture-device loss, or output-monitor
  failure stops capture and displays an error. Restart Vinxa after fixing a
  permanent runtime/model failure.
- Dragging from overlay text/background, resize, collapse, opacity, copy controls,
  tray, hotkeys, consent receipts, and standalone WAV diagnostics are retained.

## Files

| File | Responsibility/change |
| --- | --- |
| src/main/audio/recording-capture.ts | Production capture lifecycle, source-specific permissions, measured frames, meters, device monitor, padding |
| src/main/speech-backend.ts | RecordingBackend adapter using the pulled service/bridge and real controller ownership |
| src/main/speech-service.ts | Main-process subscriptions and cached status replay, alongside existing renderer subscriptions |
| src/main/recording-speech-bridge.ts | Explicit consent-checked final drain during stopping; session ownership released on stop failure |
| src/main/sidecar-manager.ts | Drain the transport queue before pause; allow finalization time for the pause acknowledgement |
| sidecar/streaming.py | Preserve completed-source final inference before a graceful pause; ordinary aborting pause remains available |
| src/main/session-controller.ts | Consent-owner binding, descriptive failures, final drain disposal, resume authorization, partial cancellation/restart cleanup |
| src/main/phase2.ts | Live backend selection, readiness gating/status, async disposal; overlay dragging retained |
| src/shared/phase2.ts | Engine readiness in the validated UI snapshot; backend ownership/subscription hooks |
| src/main/index.ts | Await UI capture cleanup before speech shutdown; explicit demo skips model initialization |
| src/renderer/capture/capture.ts | Apply the selected mic device; reuse all existing timing/worklet logic |
| src/renderer/src/Phase2.tsx | Engine-ready status, consent wording, correct local/demo controls |
| scripts/smoke.cjs | Explicit demo-only packaged UI smoke |
| .env.example, README.md, docs/phase-2.md, docs/phase2-developer-b-integration.md | Current launch options and integration instructions |

New regression tests are in src/main/audio/recording-capture.test.ts and
src/main/speech-backend.test.ts. Existing session-controller, speech-startup,
recording-speech-bridge, and Python streaming tests were extended. These tests
have not been run for this integration.

## Commands for the user

Quit existing Vinxa instances through the tray and stop old dev terminals first.
Run the following commands one at a time, stopping to resolve any error.

```powershell
cd "D:\Python Workspace\Vinxa"
if (!(Test-Path .venv\Scripts\python.exe)) { py -3.11 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r sidecar/requirements-phase2.txt
```

If base.en is not already cached, prepare it once while online. The default cache
is outside Git at %LOCALAPPDATA%\Vinxa\models. Runtime streaming uses cached files.

```powershell
.\.venv\Scripts\python.exe -c "from sidecar.engine import SpeechEngine; SpeechEngine('base.en').load()"
```

Node dependencies did not change. If absent, run pnpm install --frozen-lockfile.
Then run the checks and launch:

```powershell
Remove-Item Env:VINXA_CAPTURE_TEST -ErrorAction SilentlyContinue
$env:VINXA_BACKEND = 'local'
$env:VINXA_SPEECH_MODEL = 'base.en'
$env:VINXA_SPEECH_LANGUAGE = 'en'
pnpm typecheck
pnpm test
.\.venv\Scripts\python.exe -m pytest sidecar harness -q
pnpm dev
```

The repo's .venv is discovered automatically. VINXA_SIDECAR_PYTHON and
VINXA_SIDECAR_SOURCE select an external interpreter and repository source root.
Set options in the launching shell; .env.example is not automatically loaded.
For UI-only checks use VINXA_BACKEND=demo. A bundle-only check after quitting is
pnpm build. Windows runtime/model packaging is now wired through
pnpm package:win; install sidecar/requirements-package.txt first. This build has
not been run. See [completion checks](phase2-completion-checklist.md) for the
packaged speech smoke and physical-call gate. External source/interpreter paths
remain supported for development.

## Manual checks

1. Startup shows warm-up then Ready. No microphone indicator or capture occurs
   before consent. Cancel captures nothing.
2. Confirm a microphone-only session with the desired device. Speak a distinctive
   sentence: You partial/final entries and the library mic meter should respond.
3. Pause mid-sentence and wait for paused. Buffered words finalize, the microphone
   indicator turns off, and speech during the pause is absent. Resume, speak
   another sentence, and verify a timeline gap. Stop mid-sentence and verify the
   last words remain. Start a second session without reloading the model.
4. Use headphones and a real call with both sources. Route the meeting to Windows
   default output. Alternate local and remote speech; verify You/Remote labels,
   timestamps, final replacement and usable latency. Meeting-app mute does not
   mute Vinxa's mic; disable Vinxa's mic source for remote-only transcription.
5. Focus another app and test all three global shortcuts, plus tray controls,
   overlay drag, resize, collapse, opacity, and copying finalized lines.
6. Change output or disconnect the selected mic. Capture should stop with an
   error. Fix the device and start a fresh consent flow.
7. With the model cached, repeat offline. Recognition quality and real
   word-to-overlay latency require this hardware check; prior backend replay
   metrics alone do not establish them for the integrated UI.

The selected-output fallback remains a standalone diagnostic. Echo deduplication,
permanent transcripts/audio, notes, search, exports, and the broader network guard
remain later work. The parked native title-bar X issue was not changed.

## Completion follow-up, 28 November

Long lifecycle controls now defer application-heartbeat expiry while retaining
their own bounded deadlines; health checks resume afterwards. An already pending
heartbeat is given a fresh response interval after finalization. Concurrent Stop
calls share one shutdown. If ending a resident session fails, SpeechService reaps
the owned process before warming a fresh engine. It surfaces the incomplete stop
and permits a new owner after readiness. App exit disables that reload path.

The bundled-runtime build uses PyInstaller onedir output, ships the wire schema,
Silero asset, native inference libraries, dependency metadata and selected cached
Whisper files, and discovers the bundled model at runtime. It never downloads a
model as part of packaging. Regression tests and packaging helpers have been
written but not executed; the final validation gate remains user-run.

## Microphone pause/resume and latency follow-up

The worklet now distinguishes PCM_QUEUE_FULL, AUDIO_CLOCK_RESET and INVALID_PCM.
An empty input quantum after acquisition is represented as silence and advances
the graph sample clock. Initial empty input does not establish an anchor. Forward
clock gaps up to 250 ms are represented as silence. Longer forward gaps flush the
old packet and start a new encoder at the actual acquisition time, preserving the
global packet sequence. This avoids synthesizing large amounts of audio after a
long graph interruption. The renderer derives sample positions from acquisition
time, and main capture accepts forward gaps while still rejecting overlaps and
skipped packet sequences. The existing source-gap protocol reports the missing
interval to speech; recording continues, but missing speech cannot be recovered.
Backwards/invalid graph clocks still fail with AUDIO_CLOCK_RESET and include the
expected/observed frames when available. Gap warnings contain numeric clock
information in the capture console. The normal transport bound is 12 packets
(1.2 seconds of audio), with two extra packets reserved exclusively for the
resampler tail and padded final packet on Pause/Stop or graph reanchoring. This
allowance is stall tolerance; packets are sent immediately and are never
deliberately batched for 1.2 seconds. A sustained stall still stops capture.

Capture requests a 16 kHz interactive AudioContext and falls back to the device
graph rate if unsupported. Native 16 kHz input uses direct downmix/gain/PCM
conversion; other rates retain the existing anti-aliasing resampler. UI snapshot
publication is deferred/coalesced outside frame acknowledgement, and native
tray menus and window icons update only when their relevant state changes.

The first live inference snapshot is offered at 0.6 seconds (or a shorter
explicit interval); subsequent snapshots retain the configured cadence. Word
timestamps extending at most 80 ms past a live window are trimmed to its edge;
words wholly outside the window or farther into the future remain rejected.
The model, confidence filters and final-word agreement remain in use. Scheduling
at 0.6 seconds does not guarantee a transcript at that time: actual inference,
speech content and machine load still determine when a usable hypothesis arrives.

Regression coverage includes five microphone pause/resume cycles, fresh sender
and sequence checks, bounded delayed acknowledgements, full-queue pause flushing,
empty input quanta, native-rate conversion, distinct errors and early partials.
Additional graph-gap coverage checks short-gap silence, minute-long reanchors
at native/fallback sample rates, preserved microphone level totals, bounded
transport, timed IPC positions, source-gap ordering and post-gap speech results.
These tests have been written but have not been run by Codex.

Quit all running Vinxa instances, then run these in the repository:

```powershell
pnpm typecheck
pnpm test
.\.venv\Scripts\python.exe -m pytest sidecar harness -q
pnpm build
Remove-Item Env:VINXA_CAPTURE_TEST -ErrorAction SilentlyContinue
$env:VINXA_BACKEND = 'local'
pnpm dev
```

Confirm microphone only. Speak a sentence, Pause, wait for Paused and the device
indicator to turn off, speak a distinctive sentence while paused, then Resume and
speak another sentence. Repeat five times. Paused speech must be absent; resumed
speech must appear without restarting the session; committed words must remain.
Stop mid-sentence and start another session to verify cleanup. Check provisional
text latency separately from final text, which needs further agreement/silence.

For a latency trace, quit and relaunch after setting this optional launch-shell
variable (use a folder outside the repo):

```powershell
$env:VINXA_DIAGNOSTICS_DIR = Join-Path $env:TEMP 'vinxa-latency'
pnpm dev
```

Repeat the microphone test, Stop, and Quit from the tray so diagnostics are saved.
Electron diagnostics include capture frame age, handler duration and estimated
word age at transcript receipt; Python diagnostics include inference duration and
queue wait. They contain numeric timing/accounting, not transcript text or raw
audio. Word age is an estimate from model word timestamps, not measured visual
render latency. Remove the environment variable after investigation. Existing
installed executables need repackaging before they include these source changes.
