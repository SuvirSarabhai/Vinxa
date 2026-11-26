# Phase 1 local commit plan

Branch: navya. Prepared and shown before execution, as required by the
finalization request. The five groups below contain the exact 37 intended files.
Commits are local; no push is authorized. Human mentor/team acceptance remains
pending independently of local code review. Existing staged work is preserved;
staging uses the reviewed working versions, not stale pre-cleanup index copies.

## 1. feat(speech): add offline engine and repeatable CPU benchmarks

- sidecar/__init__.py
- sidecar/audio_utils.py
- sidecar/engine.py
- sidecar/benchmark.py
- sidecar/benchmark_cpp.py
- sidecar/requirements-phase1.txt
- sidecar/requirements.txt
- sidecar/test_engine.py
- sidecar/test_benchmark.py
- sidecar/test_benchmark_cpp.py

Includes the already staged, previously uncommitted Python deliverables, the
three EOF fixes and confirmed unused test-import/local removal. Validation:
29 Python tests, pip check, benchmark math/hash checks and final diff inspection.

## 2. fix(audio): add mic headroom and detect Windows output changes

- src/shared/pcm.ts
- src/shared/pcm-gain.test.ts
- src/renderer/capture/capture.ts
- src/renderer/capture/capture.test.ts
- src/renderer/capture/worklet.ts
- src/renderer/capture/worklet.test.ts
- src/main/audio/capture-test.ts
- src/main/audio/capture-test.test.ts
- src/main/audio/windows-output-monitor.ts
- src/main/audio/windows-output-monitor.test.ts
- resources/audio/default-output.ps1
- electron-builder.yml

Includes configurable 0.75 default mic gain, preserved pre-gain saturation metrics,
unchanged system samples and strict validator, acceptance filenames, custom output
directory, writable packaged default and a read-only native default-output guard.
The installer change bundles only that required helper resource; it does not
alter installer behavior. It addresses the observed missed-switch/silent-tail
failure. The corrected packaged physical retest and subsequent capture pass;
the failed attempt remains preserved.
Validation: 69 TypeScript tests,
typecheck/build and generated dual-source smoke, with packaging and real-device
results recorded separately in the acceptance report.

## 3. feat(audio): add selected-output loopback diagnostic

- sidecar/loopback_fallback.py
- sidecar/test_loopback_fallback.py

Standalone, manual-Start PyAudioWPatch recorder for one exact loopback endpoint.
Preserves source 1, converts native float32 to the existing 16 kHz mono Int16 WAV
contract, creates output exclusively and reports stream failures. It does not
switch or integrate the Electron backend. Validation: 40 Python tests overall,
including 11 diagnostic cases; actual 20-second non-default Meet capture passes
strict WAV validation and user listening. Primary route failure stays documented.

## 4. chore(phase1): ignore model weights outside cache directories

- .gitignore

Adds common weight extensions as a safeguard against accidental copies. Recordings,
secrets, virtualenv, model directories and generated output retain existing ignore
rules. No ignored runtime artifact belongs in any proposed commit.

## 5. docs(phase1): record acceptance evidence and pending reviews

- README.md
- README-developer-b.md
- sidecar/README.md
- docs/phase-1-validation.md
- docs/phase-1-contracts.md
- docs/phase1-audio-capture.md
- docs/phase1-speech-benchmark.md
- docs/phase1-benchmark-results.json
- docs/phase1-device-compatibility.md
- docs/phase1-contract-review.md
- docs/phase1-final-acceptance-report.md
- docs/phase1-commit-plan.md

Documents actual measurements, results and manual/review blockers. Wording must
match the latest observed results before staging. Human review remains pending
until reviewer/date/findings are recorded. Real-call results must not be inferred
from generated fixtures.

## Before executing the plan

Review the complete staged/unstaged/untracked text diff and this exact file list.
Confirm branch navya, no unrelated shell/tray/installer/public-contract edits,
no secrets/weights/WAVs/build output, clean whitespace and successful required
checks. Final acceptance may remain incomplete while these focused implementation
commits are reviewed; their messages must not claim completed human tests.

No reset, clean, force checkout, push or main-branch commit is part of this plan.

## Execution record

The plan and exact 37-file list were shown before staging. Local source review,
secret-pattern/artifact checks, branch and exact file-set checks, staged and
working-tree whitespace checks passed. Executed on navya:

- a36e487: speech engine and benchmarks (10 files).
- c8255db: mic gain and Windows output-change handling (12 files).
- 45edc53: selected-output diagnostic and tests (2 files).
- 4b28c94: model ignore rules (1 file).
- The documentation commit containing this record completes group 5 (12 files).

Nothing was pushed. Mentor capture-path and team contract reviews remain pending.
