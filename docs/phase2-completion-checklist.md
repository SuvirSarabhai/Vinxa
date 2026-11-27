# Phase 2 completion gate

Code follow-up dated 28 November 2026. This checklist covers Developer A and
Developer B Phase 2 together. No installation, build, test, model download,
packaged launch, or audio capture was run by the agent. No commit or push was
made. Earlier Developer B results describe a previous backend checkout and do
not validate these local integration changes.

## Implemented code

- Consent-enforced real microphone/system audio, measured timing and You/Remote
  transcripts in the existing draggable overlay; hotkeys and recording indicators.
- A warmed local model shared between both sources and reused between sessions,
  with per-source VAD, rolling inference, LocalAgreement, and WAV harness support.
- Pause/Resume and final Stop draining. Long control operations have independent
  bounded deadlines. Heartbeats do not falsely expire while Python is handling
  those controls, and resume after finalization. Already queued ping replies remain
  valid across a session transition.
- After a failed session-end, the service reaps the old owned process, resets the
  cached initialization, and warms a fresh process. The failed Stop stays visible;
  it is not marked successful. A new recording can start after readiness. If the
  process cannot be reaped, no duplicate process is launched. Quit disables reload.
- Concurrent shutdown calls share one operation. Stop/reload and heartbeat
  regressions use mocked transports/processes and do not need a real model.
- Windows packaging now produces a PyInstaller onedir speech runtime plus the
  selected cached converted model, copied through electron-builder extraResources.
  The runtime discovers its bundled model and loads offline. Packaging code is
  present, but no executable or installer was generated during implementation.

## Changed files for this completion follow-up

| File | Change |
| --- | --- |
| src/main/sidecar-manager.ts | Lifecycle-aware heartbeat deadlines, single pending heartbeat, bounded finalization controls, shared Stop, bundled model discovery |
| src/main/speech-service.ts | Stop/reap/reload recovery after failed session-end, shutdown-intent flag |
| src/main/session-controller.ts, src/main/session-controller.test.ts | Failed Stop keeps finalized text and removes provisional rows |
| src/main/index.ts | Disable engine reload before beginning app-exit capture cleanup |
| src/main/sidecar-manager.test.ts | Slow controls with an outstanding heartbeat, resumed checks, bounded timeout, concurrent shutdown |
| src/main/speech-service.test.ts | Failed-stop recovery before a second owner; no reload during Quit |
| src/main/sidecar-runtime.test.ts | Frozen executable/model resolution and explicit model override |
| sidecar/streaming.py | Pass the discovered converted model path to the existing offline engine |
| sidecar/entrypoint.py | Frozen server entry point |
| sidecar/package_runtime.py | Windows-only runtime builder, schema/native/data collection, cached model selection and generated-output backup |
| sidecar/requirements-package.txt | Phase 2 runtime dependencies plus PyInstaller |
| sidecar/test_package_runtime.py | Model completeness, cache-only lookup and frozen dependency/schema arguments |
| scripts/build-sidecar.cjs | Launch the chosen venv's packaging command without a shell |
| scripts/smoke-speech.cjs | Development or packaged engine-readiness smoke with external Python/source overrides cleared for packaged checks |
| electron-builder.yml, package.json | Build and ship the frozen sidecar and selected model with Windows artifacts |

README, integration guides and the environment template describe the new setup.
All earlier uncommitted Developer A/B integration changes remain in the worktree.

## 1. Development checks: user to run

Quit Vinxa through the tray and stop existing development terminals. Run commands
one at a time and resolve failures before continuing. Reuse the existing .venv.

```powershell
cd "D:\Python Workspace\Vinxa"
if (!(Test-Path .venv\Scripts\python.exe)) { py -3.11 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r sidecar/requirements-package.txt
Remove-Item Env:VINXA_CAPTURE_TEST -ErrorAction SilentlyContinue
$env:VINXA_BACKEND = 'local'
$env:VINXA_SPEECH_MODEL = 'base.en'
$env:VINXA_SPEECH_LANGUAGE = 'en'
pnpm typecheck
pnpm test
.\.venv\Scripts\python.exe -m pytest sidecar harness -q
pnpm build
```

If dependencies are absent, run pnpm install --frozen-lockfile first. If base.en
is not prepared, run the following explicit online step once; normal inference
and packaging use cached model files only:

```powershell
.\.venv\Scripts\python.exe -c "from sidecar.engine import SpeechEngine; SpeechEngine('base.en').load()"
```

Then start the development app with pnpm dev and perform the real-call gate below.

## 2. Packaged runtime: user to build and check

```powershell
pnpm package:win
node scripts/smoke-speech.cjs tmp/phase2-packaged-speech.json --executable "release/win-unpacked/Vinxa Desktop.exe"
pnpm smoke:win "D:\Python Workspace\Vinxa\release\win-unpacked\Vinxa Desktop.exe"
```

Use a new report filename if the existing one is already present. The first smoke
loads and warms real bundled speech, with no recording. It clears external source,
Python and converted-model overrides. The second smoke uses fixtures to check
the UI, consent, controls and app lifecycle. Neither substitutes for a real call.

pnpm package:win calls pnpm sidecar:build before building Electron. The helper
uses VINXA_SIDECAR_PYTHON if set, otherwise .venv\Scripts\python.exe. It requires
Windows and a cached model. To select an explicit converted model directory:

```powershell
pnpm sidecar:build --model base.en --model-path "D:\Models\base.en"
```

This manual runtime build can be followed by pnpm build and pnpm exec
electron-builder --win nsis portable. The normal package:win command repeats the
runtime build using the chosen VINXA_SPEECH_MODEL cache. Model files must include
model.bin, config.json and tokenizer.json. Only named model files are copied;
local recordings, transcript text and credentials are not packaged.

Generated runtime/model copies remain under ignored build/sidecar and release.
The original cache stays outside Git. A previous generated runtime is retained
under build/sidecar-backup-<id> when replaced. Build paths are checked before a
directory is moved. The separate PyInstaller work/dist output is disposable build
data. Verify both installed and portable output on the target Windows machine;
native library availability is not proven until the packaged smoke passes.

The approach uses [PyInstaller's documented collection options](https://pyinstaller.org/en/stable/usage.html)
and [electron-builder extraResources](https://www.electron.build/contents/).

## 3. Real-call gate before Phase 3

- [ ] Both people know about and consent to capture.
- [ ] Before confirmation, no device is recording. Cancel opens no stream.
- [ ] On a fresh call with headphones, both You and Remote produce useful partials
      and finals in the overlay. Meeting audio uses Windows default output.
- [ ] Observed word-to-overlay latency is approximately two seconds for both
      sources. Record the actual observation; backend replay figures alone do
      not establish UI latency or recognition accuracy.
- [ ] With another application focused, all three hotkeys work.
- [ ] Pause stops real device tracks and speech during the pause is absent.
- [ ] Resume has a visible timeline gap. Stop retains final buffered words.
- [ ] A second recording starts after Stop and asks for fresh consent.
- [ ] Selected microphone and source toggles work. Live meters show real audio.
- [ ] Drag, resize, collapse, opacity and copy controls still work.
- [ ] Device loss/output change gives an error and stops capture.
- [ ] With models prepared, the same loop works with Wi-Fi disabled.
- [ ] Installed-app readiness and a real call pass on the target machine.
- [ ] The other developer reviews the result and records PASS/FAIL with the date.

Actual slow-inference/crash recovery should also be checked on the target machine;
the new unit regressions cover the control flow with injected delays/failures.
The native title-bar X issue remains parked as previously requested.

Phase 2 remains VALIDATION PENDING until these results exist. Implement Phase 3
after this gate so persistence and notes are built on verified source labels,
timestamps, finalized text and Stop behavior. Database design can be discussed
while checks are pending; Phase 3 code was not added by this task.
