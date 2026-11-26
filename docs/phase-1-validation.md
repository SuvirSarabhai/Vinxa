# Phase 1 validation

Checked locally on Windows on 26 November 2026. The table below records Developer
A's original shell baseline. The latest joint-work checks are recorded next.

## Latest checks after audio and speech work

| Check | Result |
| --- | --- |
| pnpm typecheck / pnpm test / pnpm build | Latest guard fix passed; 69 tests in nine files (baseline 34) |
| Python Phase 1 dependencies and pip check | Installed; no broken requirements |
| python -m pytest sidecar harness -q | 40 passed after selected-output diagnostic; earlier run had 29 |
| Native dependency rebuild | Passed through installed Microsoft VsDevCmd environment; better-sqlite3 compiled for Electron 45.5.0 x64 |
| pnpm package:win | Passed; unsigned NSIS installer and portable executable generated |
| Newly packaged unpacked executable smoke | Passed again after gain/path changes, including second-instance exit and first-window restoration; isolated temporary profile |
| Fresh NSIS installation | Installer exit 0; installed executable exists |
| Installed executable smoke | Latest native-guard build passed full installed smoke; its installed monitor resource matches source; subsequent installed-app Bluetooth dual capture produced two valid WAVs |
| Test-install cleanup | Own silent uninstaller returned 0; installed executable removed |
| Offline model comparisons | Three runs each: faster-whisper base.en/small and whisper.cpp base.en; metrics-only JSON included in the documentation commit; math and shared sample hash rechecked |
| New generated dual-source smoke | Passed: separate 5.010625-second mic and 5.032-second system WAVs; both capture windows cleaned up |
| Final whitespace / import checks | PASS: source and existing index whitespace checks clean; Python AST/import audit found no unused imports; model/secrets ignore rules checked |
| Headphone microphone isolation | User confirmed clear voice with no video bleed; current mic WAV has ten full-scale samples |
| Clean Google Meet real-call WAV pair with video | PASS: two separate 29.9813125-second WAVs, strict validation and user-confirmed clear/correct content; 0 full-scale output samples |
| Non-default meeting output | Primary FAIL retained: only video captured. Selected-OnePlus fallback PASS: 20-second WAV, strict validation, zero full-scale samples and user-confirmed clear remote voice without distortion or missing sections |
| Other required hardware checks | Bluetooth, default-output change/restart and Windows desktop mic denial pass for tested configurations; user confirmed mic access restored On |
| Physical output-switch result | Original attempt FAIL retained; corrected packaged retest PASS: native change log, user-confirmed warning and valid finalized 3.592-second WAV |
| Windows default-output monitor probe | PASS: actual Core Audio helper ready/heartbeat/exit 0; generated dual capture with native monitoring passes; packaged helper hash matches source |
| Latest native-guard package | NSIS/portable build, unpacked and installed smoke pass; physical output-change detection/stop passes; installed Bluetooth capture starts/finalizes normally after restart |
| Mentor capture-path / team contract review | MANUAL-PENDING |
| Separate clean Windows machine | MANUAL-PENDING |

The Build Tools compiler and SDK worked through their developer environment.
Installer registration still reports an incomplete installation; administrator
repair attempts did not complete. This is an environment limitation, not a
successful repair claim. Earlier development-Electron smoke failed with Windows
code 2147483651 at the second-instance launch, including on the original A main.
The fresh packaged and installed versions now pass the unchanged smoke assertions.

Current commands from the repository root:

```powershell
pnpm typecheck
pnpm test
pnpm build
.\.venv\Scripts\python.exe -m pytest sidecar harness -q
.\.venv\Scripts\python.exe -m pip check
pnpm exec electron-builder install-app-deps
pnpm package:win
node scripts/smoke.cjs "release/win-unpacked/Vinxa Desktop.exe"
```

The later Google Meet real-call test was recorded at mic gain 0.75 in
test_recordings/phase1-real-call-20261126-204045. Both WAVs validate and the user
confirmed clear/correct content. Mic worklet input touched full scale twice;
the output has no full-scale samples and no audible distortion was reported.
Keep that upstream headroom warning distinct from the successful saved-WAV
quality result. See phase1-final-acceptance-report.md for full metrics.

Run the native rebuild and packaging from the installed Microsoft developer
environment if ordinary node-gyp discovery fails. The installed-app smoke used
a separate ignored test destination and the same script. No installer settings,
tray code or fixture UI were changed for these checks. The package includes the
capture diagnostic assets, but no bundled Python engine or model. See
[capture evidence](phase1-audio-capture.md) and
[speech benchmark](phase1-speech-benchmark.md) for the joint gate.

## Original Developer A shell baseline

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

The original shell baseline did not include recording, transcription, local AI,
database repositories or cloud calls. The later opt-in recording diagnostic and
independent WAV engine are recorded above. A successful shell smoke test alone
does not satisfy the joint Phase 1 gate.
