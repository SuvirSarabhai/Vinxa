# Developer A Phase 2

Implementation added for the parallel-build plan. Build and test commands have
not been run for these changes; the user will run the checks below.

## Current behavior

The library screen, tray, and global Start shortcut all enter the same consent
flow. A separate always-on-top setup window asks for the title, microphone,
source toggles, and explicit consent. Device enumeration does not open an audio
stream or ask for recording permission. Available device labels depend on the
existing Windows/Chromium permissions.

The default backend replays the existing written fixture; it records no audio,
contacts no speech service, and generates no notes. The UI, overlay, tray tooltip,
and consent receipt identify demo mode. Audio meters remain unavailable rather
than displaying invented activity. The demo announcement explicitly says that
no audio is recorded.

Confirmation is logged before starting the backend. Cancel invalidates a pending
start, including cancellation while the consent file is being written. A new
consent request resets the checkbox. Backend start/pause/resume/stop operations
are serialized. Final transcript events flushed during stop are retained. Late
events from old sessions and partial updates after a final segment are ignored.

The overlay is frameless, draggable from its header, background, and transcript text, resizable, always on top,
collapsible, and adjustable from 50 to 100 percent opacity. Copy recent lines
copies the last ten finalized segments. During an active session, closing the
overlay collapses it so that an indicator remains visible. Pause gaps are shown
with session-relative timestamps. The tray and taskbar badges use red for the
recording/stopping state and amber for paused; demo mode remains labelled.

## Files

| File | Responsibility |
| --- | --- |
| src/shared/phase2.ts | Command/snapshot schemas, UI API, backend interface, consent record, announcement text |
| src/main/session-controller.ts | Consent enforcement, recording state, serialized backend operations, transcript and pause timeline state |
| src/main/demo-backend.ts | Fixture adapter, source filtering, paused-time offsets, sample completion notice |
| src/main/hotkeys.ts | Atomic shortcut registration/rebinding, conflict rollback, ownership cleanup |
| src/main/phase2.ts | Electron windows, tray and taskbar indicators, trusted IPC, async consent/settings files |
| src/main/index.ts | Installs Phase 2 after creating the shell and disposes it during Quit |
| src/preload/phase2.ts | Validated, restricted Phase 2 bridge |
| src/preload/index.ts | Exposes window.vinxaPhase2 alongside the Phase 1 API |
| src/renderer/src/env.d.ts | Type declarations for both preload APIs |
| src/renderer/src/Phase2.tsx | Library controls, setup/consent form, hotkey settings, overlay, transcript and meters |
| src/renderer/src/CaptureDiagnostic.tsx | Dedicated real-audio diagnostic screen, separate from demo controls |
| src/renderer/src/use-overlay-drag.ts | Pointer dragging from overlay text/background with capture, movement threshold, and control/scrollbar exclusions |
| src/renderer/src/main.tsx | Selects Phase2App as the renderer entry |
| src/renderer/src/styles.css | Phase 2 theme, draggable header, controls, status colors, layout |
| src/main/session-controller.test.ts | Consent/cancel races, failures, transcript replacement, pause gaps, stop flushing, stale events |
| src/main/hotkeys.test.ts | Conflicts, swapping bindings, cleanup ownership |
| src/shared/phase2.test.ts | Consent and command validation, duplicate keys, opacity limits |
| scripts/smoke.cjs | Packaged-app consent/cancel, demo, overlay, clipboard, lifecycle smoke checks |

No new package dependencies are required. The Phase 1 App.tsx remains in the
repository for reference but is no longer the renderer entry point.

## Commands to run

Quit existing Vinxa instances through the tray, then stop an old development
terminal with Ctrl+C. Do not run a packaged copy and a development copy together
when evaluating global shortcut conflicts.

```powershell
cd "D:\Python Workspace\Vinxa"
pnpm typecheck
pnpm test
pnpm dev
```

The unit suite includes the Phase 2 controller/shortcut tests and Developer B's
merged capture, worklet, PCM, WAV, and device-monitor tests. Re-run the combined
suite locally; prior branch-specific results are not a merged-build result.

After manual checks, Quit Vinxa and stop the development terminal, then run:

```powershell
pnpm package:win
pnpm smoke:win "D:\Python Workspace\Vinxa\release\win-unpacked\Vinxa Desktop.exe"
```

package:win includes the production build. An optional faster bundle-only check
is pnpm build. If dependencies are not installed, run pnpm install --frozen-lockfile
before the other commands. No Python environment or API key is needed.

The smoke script launches the actual packaged app, creates demo consent receipts,
copies dummy transcript text to the clipboard, writes release/phase-2-smoke.png,
and exits. It tests programmatic close-to-tray, not the known native X mouse issue.

## Manual acceptance checks

1. Library says demo mode and no audio recording. Start opens setup without
   emitting new transcript segments. Confirm is disabled until consent is checked.
2. Cancel and the Stop hotkey during setup both return to idle without starting.
   Reopen setup: the consent checkbox must be unchecked.
3. Confirm with both sources selected: the overlay appears and partial text is
   replaced with final text. Two You segments and one Remote segment remain.
4. Start a new session with microphone disabled: only the Remote sample appears.
   Disable system audio instead: only You samples appear. Both disabled blocks start.
5. Before the short sample ends, switch to another app and press Ctrl+Alt+P.
   Paused is amber, text stops changing, and a pause gap is visible. Press again to
   resume. Ctrl+Alt+X stops; Ctrl+Alt+S starts a new consent flow.
6. Drag the overlay from the header, transcript text, or empty background. Buttons,
   sliders, scrollbars, and the outer resize edges are excluded from dragging.
   Resize its edges, collapse/expand it, change opacity, scroll the transcript,
   and copy recent lines. Buttons and range inputs must remain clickable.
7. Tray Start/Pause/Resume/Stop match the screen state. Taskbar badge and tooltip
   identify demo recording/paused state. Open Library restores the main screen.
8. Change Start to Ctrl+Alt+R and save. The old binding stops working and the new
   one opens consent. Quit and restart: the saved bindings remain.
9. Try duplicate shortcuts: a validation error appears. A shortcut owned by another
   app must report a registration conflict and preserve the existing bindings.
   The tray remains usable if startup registration fails.
10. Stop retains the current session transcript on screen, but no meeting history,
    summary, search, export, or permanent transcript persistence is claimed.

## Developer B integration

The 27 November local integration brought in origin/main at 0984a0f, including
Developer B's Phase 1 diagnostics, standalone selected-output fallback, and WAV
speech engine. VINXA_CAPTURE_TEST selects the dedicated diagnostic screen;
without it the app uses the Phase 2 demo. Both remain intentionally separate.
The capture renderer entry, native monitor packaging resource, capture preload
bridge, and quit-time WAV finalization are preserved. Shared binary source ids
are 0 for microphone and 1 for system audio, with 3,201 bytes per tagged frame.

Replace createDemoBackend with an implementation of RecordingBackend and pass
it as the fourth argument to installPhase2. Use mode local only for a real local
pipeline. start must resolve when capture is running; failure before that must
reject. Do not start capture outside the controller's post-consent start call.

pause must stop capture/writes and flush any pending results before resolving;
resume restarts capture. stop must be idempotent and finish publishing final
segments before resolving. Emit stable utterance ids, the supplied sessionId,
source metadata, and session-relative timestamps that account for pause gaps.
Audio levels are normalized 0..1; unknown levels are null. Async backend failure
uses the failure callback. Do not include secrets or transcript text in errors.

The joint Hour 3 gate still needs real dual-source audio, local transcription,
latency measurement, and capture-level pause/consent verification. The native
main-window X-button issue is explicitly parked and has not been re-tested here.

## Local metadata

phase2-hotkeys.json and consent-events.jsonl live in Electron's user-data
directory, not the source tree. Receipts contain session id, UTC consent time,
statement version, demo/local mode, source flags, and announcement-copied flag.
They contain no transcript text or meeting title. Database-backed consent events
and meeting persistence remain later-phase work. No hotkeys or consent files have
been created by running these changes during implementation.
