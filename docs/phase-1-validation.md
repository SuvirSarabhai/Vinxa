# Phase 1 validation

Checked locally on Windows on 26 November 2026.

| Check | Result |
| --- | --- |
| pnpm install --frozen-lockfile | Passed, including Electron native dependency rebuild |
| pnpm typecheck | Passed |
| pnpm test | Six tests passed: schemas, partial/final identity, pause timing, cancellation, replay |
| pnpm build | Passed for main, bundled sandbox preload, and React renderer |
| pnpm dev | Passed: renderer, dark stylesheet, preload bridge, and fixture playback |
| pnpm package:win | Passed: unsigned NSIS installer and portable executable generated |
| Packaged executable smoke | Passed |
| NSIS installer installed and installed executable launched | Passed on this development machine |
| Installed executable smoke | Passed |
| Clean Windows machine | Not run; requires a separate machine or VM |
| Shared contract agreement with Developer B | Pending team review |
| Real-call dual-source WAVs and model benchmark | Developer B deliverable; not tested here |

The smoke command drives the actual Electron app through Playwright. It verifies
the preload bridge, partial-to-final replacement without duplicates, both source
labels, pause/resume/reset, close-to-tray, second-instance exit and first-window
restoration, and app termination. A screenshot is saved under ignored release/.
Tray context menu selection itself still merits a manual check on the demo machine.
The temporary local test installation was removed through its uninstaller after
the installed-app checks passed. Build artifacts remain under ignored release/.

No recording, transcription, local AI, database repositories, or cloud calls are
part of this Phase 1 shell. A successful shell smoke test is not the joint Phase 1 gate.
