# Local main integration 27 November 2026

Fetched origin/main and fast-forwarded local main from 9892b7a to 0984a0f
(Merge pull request 1, Developer B's navya branch). Reapplied Developer A's
uncommitted Phase 2 work and overlay dragging changes. No integration commit or
push was made. A backup of the pre-integration local changes remains in Git stash:
2c54beca6a443a838a19b1d4b879247a17dde912.

## Resolved overlaps

- src/main/index.ts: both Phase 2 startup/cleanup and the opt-in audio diagnostic;
  diagnostic Quit still waits for WAV finalization. The parked X-button changes
  were preserved rather than treated as fixed.
- src/preload/index.ts: Phase 1 fixture, Phase 2 controls, and capture bridges all
  retained; each uses its own channels and validates incoming data.
- scripts/smoke.cjs: current Phase 2 UI checks retained, together with upstream
  optional Electron app arguments, directory creation, and second-instance errors.
  The normal UI smoke clears VINXA_CAPTURE_TEST in its child environment so it
  cannot accidentally start a real-audio diagnostic.
- README.md: reconciled both implementation statuses, retained Developer B's
  setup/evidence links, and repaired the architecture diagram's text encoding.

## Boundaries

Normal launch is still a demo with no audio capture. Recognized VINXA_CAPTURE_TEST
values mic/system/both instead select a dedicated diagnostic screen, keep Phase 2
demo hotkeys disabled, and show Developer B's native consent and recording dialogs.
Hidden capture renderers and their private session permissions remain unchanged.

Developer B's shared source ids (mic 0, system 1), PCM helpers, capture renderer
build entry, packaged default-output monitor, and standalone Python modules are
included. A frame is one source byte plus 3,200 bytes of 16kHz mono Int16 PCM.
No live WebSocket server or RecordingBackend adapter is present in the upstream
Phase 1 code, so a source merge alone does not turn demo transcripts into live STT.
Stable utterance ids, common session-relative timing, PCM callback framing, and
pause/resume/stop behavior still require agreement at that adapter boundary.

## User-run verification

No install, build, test, recording, or model command was run during integration.
After quitting current Vinxa instances, check normal UI mode:

```powershell
cd "D:\Python Workspace\Vinxa"
Remove-Item Env:VINXA_CAPTURE_TEST -ErrorAction SilentlyContinue
pnpm typecheck
pnpm test
pnpm dev
```

Use README-developer-b.md for optional Python setup and real-audio diagnostic
procedures. They require explicit recording consent and appropriate devices;
the demo does not need Python or an API key. Existing ignored recordings, models,
virtual environments, and generated build output were not stashed or deleted.
