# Stitch frontend integration — 28 November 2026

Later update: [navya integration](navya-integration-2026-11-28.md) adds the saved
meeting, notes, search/export and deletion backends described as future work in
the historical Stitch assessment below. Its combined validation is user-run.

## Native overlay controls follow-up

The overlay now requests the standard Windows title bar with Minimize,
Maximize/Restore and Close. The square button maximizes the window; it is separate
from the in-app Collapse control. Minimize keeps the session running. Close hides
only the overlay, and Show overlay reopens it, restoring a minimized window when
needed. Pause/Resume no longer reopens an overlay that the user dismissed.
Recording ends through Stop, not by closing the transcript window.

Compact and expanded sizes now measure usable content separately from the native
title bar and borders. Maximizing a compact overlay reveals the full transcript.
Dragging within web content is suspended while maximized or in fullscreen.

The desktop smoke script has additional assertions for the native frame/control
capabilities, minimize/restore, maximize/restore, hiding/reopening the overlay,
and compact content height. These follow-up changes have not been built or tested
by Codex; run the commands below yourself. Verification figures later in this
document describe the previous tested UI revision.

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:ui
pnpm dev
```

## Assessment of the supplied export

The supplied folder contains seven HTML screens and one design-system document.
All eight files are preserved under `design/stitch/` in this repository. There
is no React project, package manifest, Electron integration, or reusable component
directory in the export. Some screens have inline prototype JavaScript; this
changes sample state or labels rather than controlling recording or Windows.

The visual design is substantially complete for the seven supplied screens.
Backend integration was absent. The HTML uses Tailwind's online runtime,
Google Fonts, static device names, sample meeting content, and unconditional Demo
labels. Those assumptions have been replaced in the running application.

| Export screen | Integrated behavior |
| --- | --- |
| Main dashboard | Real session state, title, elapsed time, Start/Pause/Resume/Stop, source meters, registered shortcuts, engine readiness, live transcript, and copy finalized lines |
| Setup and consent | Real device enumeration and selection, audio-source validation, mandatory consent, native clipboard announcement, cancel, and backend startup |
| Expanded overlay | Real partial/final transcript, chronological pause gaps, Pause/Resume/Stop, open main window, collapse, opacity, and clipboard |
| Collapsed overlay | Status, elapsed time, Pause/Resume/Stop and Expand remain usable in the compact window |
| Settings | Native shortcut validation/registration/persistence/reset, live overlay opacity and engine information |
| Future meeting library | Honest empty saved-library state; current in-memory session can be opened separately |
| Future meeting details | Current-session transcript; Summary/Decisions/Action items visibly identify future functionality and contain no fabricated meeting intelligence |

Persistent history, saved-meeting search, rename/delete/export, and generated
notes require their planned backend work. Integrating these mockups does not
implement those future phases. The current session is replaced on the next
confirmed start and disappears on Quit; it is clearly labelled **not saved**.

## Implementation

The renderer remains React + TypeScript, built with electron-vite. The design is
implemented as local CSS and reusable React components in `src/renderer/src/ui/`.
The warm off-white, white, mint, cyan and deep teal palette follows the supplied
design. Inter and JetBrains Mono are bundled locally. Font licenses ship in
`out/renderer/licenses/`; icons use local SVG. Production screens need no Tailwind
CDN, remote fonts, or Material Symbols request. The original HTML remains a design
reference and is not executed by the desktop application.

`Phase2.tsx` now composes the dashboard, navigation, consent and overlay views.
The existing authenticated preload/IPC and recording owner remain the source of
truth. Native window controls are provided by Electron; mock title-bar buttons
were not added. The parked native Windows X issue is still separate work.

Small integration additions publish session start/end times and allow the
overlay to reopen the main window. Elapsed time includes pause gaps and freezes
after Stop or failure. The opacity control applies local input immediately,
coalesces IPC writes, and ignores older snapshots while a newer value is pending.
Session transcripts interleave pause markers at their actual timeline positions.

No new runtime dependency was needed. A local backup of the previous renderer,
session contracts, main UI wiring and smoke script is retained under
`.git/backups/before-stitch-ui-*.zip`. Existing audio/sidecar work was preserved.

## Verification

The following checks were run in the current Windows checkout during integration:

- `pnpm typecheck`: passed.
- `pnpm test`: 206 passed; two real-engine opt-in tests are skipped in this default run.
- `.\.venv\Scripts\python.exe -m pytest sidecar harness -q`: 200 passed.
- The two opt-in real Python/WebSocket tests were run separately with the cached
  model and Hugging Face offline mode: both passed. They cover warm-up, crash
  recovery, silent dual-source transmission, and reusing a resident model for
  multiple timed sessions.
- `pnpm build`: production Electron/preload/renderer bundle completed.

`pnpm smoke:ui` checks the actual built Electron windows with an isolated profile:
navigation, empty library, hotkey validation/persistence/native registration,
consent and Cancel, audio-source validation, announcement clipboard, demo
partial/final updates, five pause/resume cycles, compact overlay controls,
opacity, current-session details, application close-event handling,
single-instance restore, and Quit. It also checks for renderer exceptions,
external HTTP requests, and horizontal overflow. Screenshots and the report
are written to `release/stitch-ui/`.

The drag test sends a real renderer pointer gesture through trusted IPC and moves
the native overlay using a simulated Windows cursor position. CDP mouse input
does not move the physical Windows cursor. Native title-bar X/accelerator
dispatch is not certified by this smoke; the application close handler is
tested directly. Real mouse dragging remains a manual hardware check.

`pnpm smoke:ui:live` generates a synthetic English WAV locally with Windows
System.Speech, feeds it through Chromium's simulated microphone, and uses the
real AudioWorklet, IPC, Python VAD/Whisper service and React overlay. Three actual
capture Pause/Resume cycles and Stop passed, with final text retained and no
capture/clock/IPC errors. The physical microphone is never opened by this test.
The temporary speech file and test profile are removed afterwards. The test uses
the cached `base.en` model with network model access disabled.

The live report's first-transcript interval is measured from Confirm, including
capture startup and inference. It is not a per-word latency or accuracy claim.
Physical microphone quality, household noise, meeting-app mute behavior, real
call loopback routing, and native X still need manual hardware checks.

## Running the integrated app

```powershell
pnpm dev
```

Normal launch uses the local speech backend. For a written sample with no capture:

```powershell
$env:VINXA_BACKEND = 'demo'
pnpm dev
```

For the real backend again:

```powershell
$env:VINXA_BACKEND = 'local'
pnpm dev
```

To repeat the desktop checks after a build, run `pnpm smoke:ui`, then
`pnpm smoke:ui:live` sequentially. Both use temporary settings/consent profiles
and separate test shortcuts; they do not replace the normal profile. The live
check requires the existing local speech environment and cached model.
`pnpm build` updates `out/`; an existing installed executable needs repackaging
to include these source changes. No installer was rebuilt during this UI work.
