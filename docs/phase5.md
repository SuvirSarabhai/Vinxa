# Phase 5 implementation and user-run acceptance

28 November 2026. Both developers' code work. Navigation now lives in a left
sidebar with **Home, Library, Tools and Settings**, as requested. Open **Tools**
to see bookmarks and optional features inside the main window. The tray Tools
shortcut also selects this view rather than creating another window. Colours,
fonts, existing meeting controls and the separate recording overlay are retained.
Saved transcript text displays optional cluster labels and supports keyboard tab
navigation; passage navigation reuses the existing highlight. Demo mode shows an
honest tools empty state without calling unavailable persistence APIs.

## Implemented

| Feature | Behavior and limits |
| --- | --- |
| First run / keyboard / tray | One-time native usage explanation, existing consent flow retained, saved meeting tabs support arrows/Home/End, bookmark shortcut and tray fallback. |
| FR22 bookmarks | Ctrl+Alt+B or tray action during active recording. Monotonic session timestamps include pause gaps. Persisted, listed per session in tools, clickable to the nearest finalized passage, removable and exported. |
| FR21 mock CRM | Configurable local port at `http://127.0.0.1:<port>/vinxa/decisions`, chosen record ID, confirmation, decisions/actions only, redirect refusal, timeout, idempotency hash, acknowledged sent/failed state per session. |
| FR19 meeting hints | Opt-in Zoom/Teams process/window-title polling every ten seconds. Native notification opens consent. Approximate detection, not a conferencing SDK integration. Browser meetings stay manual. |
| FR20 encryption | Optional Windows EFS conversion of the profile before opening files on next launch, inherited encryption for new files, actual attribute verification. Supported Windows edition and NTFS required. No SQLCipher or password-based encryption. |
| FR18 remote clustering | Optional local Sherpa ONNX worker over completed system WAVs, up to one hour. Derived segment labels use dominant overlap; ambiguous passages retain Remote. Search, notes input and exports use the labels; original text remains immutable. |
| FR23 Ask Vinxa | Local extractive transcript retrieval across saved meetings with exact text, meeting/speaker/time citations, clickable passage navigation and explicit not found. No generated synthesis or semantic-search claim. |
| Speech configuration | Validated local model/language/VAD controls, applied after restart. Hindi requires multilingual `small`. Existing defaults stay base.en / English / VAD 0.5 onset and 0.35 release until changed. |

The architecture and privacy handoff are [architecture.md](architecture.md) and
[privacy-and-consent.md](privacy-and-consent.md). Optional feature code is present;
hardware suitability, measured tuning and release acceptance are **not verified**.
The real-call and packaged offline checks from Phases 2/4 remain prerequisites for
showcasing stretch features. Do not describe an unavailable feature as demo-ready.

## Commands to run

Quit the running app first. From `D:\Python Workspace\Vinxa`:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:ui
pnpm smoke:phase3
pnpm smoke:phase4
pnpm dev
```

No build, typecheck, unit tests, inference, encryption or hardware checks were
run by the agent for this change. Regression tests cover persistence, cascade
deletion, bookmark inputs, CRM boundaries/receipts, retrieval, speaker
assignment, configuration and mocked encryption failure. These are not real EFS
or real model acceptance tests.

For CRM, run in a separate PowerShell window:

```powershell
pnpm mock:crm
```

To use a different local port, set `$env:VINXA_MOCK_CRM_PORT = '4320'` before
starting the mock server and use the same port in tools. Stop the server with
Ctrl+C. It does not persist customer data. Test receiver-off failure, retry,
matching acknowledgement and rejected external/redirect destinations.
Regenerating notes or changing action status marks a previously sent delivery
stale; send again to acknowledge the current version.

## Optional clustering setup

Install into the existing project environment yourself:

```powershell
.\.venv\Scripts\python.exe -m pip install -r sidecar/requirements-phase5.txt
```

Obtain compatible segmentation and speaker embedding ONNX models using the
[official Sherpa guide](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/python.html).
Check each model's licence before redistributing. Supported examples are the
Pyannote segmentation 3.0 ONNX model and a compatible 16 kHz 3D-Speaker embedding
model. Models stay outside Git. Supply actual paths before launching:

```powershell
$env:VINXA_DIARIZATION_SEGMENTATION = 'D:\Models\diarization\segmentation\model.onnx'
$env:VINXA_DIARIZATION_EMBEDDING = 'D:\Models\diarization\embedding.onnx'
pnpm dev
```

Record two remote speakers with headphones and system audio enabled. Stop, wait
for notes to finish, then select the meeting in tools and run clustering. Verify
Remote 1/2 where supported, fallback for mixed speech, microphone unchanged,
search/export labels, restart persistence, and deletion. This is diarization,
not verified identity recognition. No claim of Hindi/English clustering accuracy
is made without testing. To include the installed library in a release build,
set `$env:VINXA_PACKAGE_DIARIZATION = '1'` before `pnpm package:win`; the two model
paths must also be deployed/configured on the target machine. Packaging does not
silently download or bundle model weights.

## Encryption acceptance

EFS is opt-in and is not available on every Windows edition. In tools request
encryption, confirm the native explanation, quit from the tray, and reopen.
Back up the EFS certificate/private key with `cipher /x` and keep that backup
outside the laptop. Check the tools status after conversion. A failure can leave
some files encrypted and others unchanged; files are preserved, and no success
is claimed. Do not use encryption merely as a demo toggle without recovery keys.

On supported Windows, verify database, WAL/journals, existing and new WAVs,
metadata, consent receipts and directories using Windows file encryption
attributes. Record/search/export/delete/restart again. Exported copies outside
the profile are not covered. On unsupported Windows, verify a clear failure with
recordings still readable. EFS is not protection against the signed-in user.

## Speech tuning and remaining acceptance

Start from the existing defaults; change one model/VAD setting at a time. Install
the selected speech model first. English-only models cannot transcribe Hindi;
choose small and the Hindi language option for the code-switched test. Quit and
reopen after saving. Explicit `VINXA_*` environment settings override saved
startup tuning, while the existing saved speech-model selection selects the
actual model. Do not change model and language independently to an incompatible
combination. Benchmark the existing harness on real English and Hindi-English
audio and record latency/accuracy before claiming tuning is complete.

Acceptance checklist:

1. Sidebar navigation selects Home, Library, Tools and Settings in the same main
   window. Check active state, Tab/Shift+Tab, Enter/Space, detail-tab arrow keys,
   and a 900px window for overflow. Overlay and consent remain separate windows.
2. Start/consent/pause/resume/stop still work. Bookmark during speech; paused and
   stopped bookmarks fail without changing recordings. Restart and open moments.
3. With no internet, run local transcription and notes, search and Ask; compare
   exact evidence and click citations. An unrelated term returns not found.
4. Send reviewed notes to mock CRM; check sent/failed status per selected meeting.
5. Enable call hints, open a Zoom/Teams call, inspect the offer and verify no
   recording begins until consent. Disable and ensure polling stops.
6. Test optional clustering and EFS only after their prerequisites are ready.
7. Delete a meeting and verify bookmarks, CRM metadata, speaker labels, search
   and Ask evidence are removed along with existing managed data.
8. Run a real two-laptop call, offline installer check, device changes and a
   twenty-minute soak before marking Phase 5 release-ready.
