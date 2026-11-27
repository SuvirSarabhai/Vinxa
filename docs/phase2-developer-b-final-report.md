# Phase 2 Developer B final report

Developer B implementation is DONE. Overall Phase 2 acceptance is PARTIAL. The user approved the remaining implementation stages and deferred their testing to the final Phase 2 validation pass. Fresh-call and overlay validation are MANUAL-PENDING. The current offline mic reference has zero accepted words, so mic recognition quality remains REQUIRES MANUAL TEST.

## Original status and root causes

The existing sidecar already provided authenticated localhost transport, automatic restart, dual-source VAD and rolling transcription, LocalAgreement and a WAV replay harness. App launch still initialized the fixture path. Warm-up began with a recording session, capture omitted measured frame metadata and the harness retained latency estimates only for reference-matched words.

The historical review reported 161088 lost samples, zero mic partials, 4.70-second system partial median and 6.16-second p95. Its per-stage trace is unavailable, so the exact source attribution remains PARTIAL. Inference around 2.7 seconds per pass and queue waits approaching 15 seconds support an overload explanation. The OS reported battery power during that run and AC power during later runs. A controlled power comparison was not performed.

Stage 1 located 11840 system samples of reported uncommitted context loss in two of three repeats. Those samples moved outside the rolling window before commitment. Every frame still arrived and entered VAD. The old droppedSamples metric can include context loss even when an earlier queued or running snapshot covers the same input.

Mic frames arrived with the correct source identity and VAD opened three regions. Short regions, confidence-filtered live hypotheses and a final job replacing a pending live job explained sparse provisional output in traced runs. LocalAgreement publishes an unstable suffix when a usable live hypothesis exists, while stable commits retain the two-pass rule.

System delay came mainly from model work, queue contention, repeated overlapping context and waiting for usable or stable hypotheses. Sender and ingestion delays were much smaller. The selected four-thread profile spent about 0.469 of 0.661 seconds in encoding a six-second sample window. Model and decoding variability remain relevant hardware limits.

## Implementation completed

### Ingestion and accounting

Each source has a bounded 32-frame handoff and independent VAD processing. A separate bounded 256-event sender isolates delivery backpressure. Input overflow keeps newer queued frames, records the discontinuity and counts removed samples by cause. Pause, failure and shutdown conserve accepted samples.

The per-source equation is accepted input equals processed plus explicit input drops plus padding plus pending samples. Completed runs require zero pending and unexplained samples. Unique inference coverage removes overlap and retires bounded history. The existing droppedSamples event metric remains visible.

### Frame timing

Audio protocol 2 is explicitly negotiated with timedFrames true. It uses a 48-byte little-endian header carrying source, sequence, start sample, capture estimate, dispatch time, count and uncertainty. Protocol 1 and its source prefix remain supported.

AudioWorklet stamps audio-context time before transfer. Capture IPC exchanges translate renderer time into main time. Three main/sidecar clock exchanges choose the lowest-uncertainty estimate and confirm the translation before timed audio is admitted. Jobs retain producing-frame provenance. Transcript timing reaches the existing main/preload subscription.

Physical timing estimates describe the audio rendering graph. Their uncertainty includes graph/resampler timing, exchange error and observed residual. Hardware input latency is unmeasured. Replay acquisition is simulated. See phase2-timing-protocol.md.

### App-launch warm-up and model reuse

Normal app startup initializes SpeechService asynchronously. Synthetic warm-up precedes readiness and emits no transcript. The existing bridge factory adopts the resident service. Recording sessions create fresh buffers, VAD, source state and agreement while sharing the selected model.

Session end drains finalization and retains the model. App quit releases capture before shutting down speech. Restart reaps the previous owned process, rotates admission credentials, reloads, re-warms and repeats clock synchronization. Safe failure status is available to late preload subscribers.

The selected model remains base.en CPU INT8 with four threads and beam 1. VINXA_SPEECH_MODEL and VINXA_SPEECH_LANGUAGE configure startup. An explicit external source/interpreter layout supports installed-app integration through VINXA_SIDECAR_SOURCE and VINXA_SIDECAR_PYTHON.

### Streaming and harness

The bounded inference scheduler can retain a first useful live pass before its final job when capacity permits. One shared model and source rotation remain in place. Silence gates, confidence filtering and two-pass stable commits remain active.

Every emitted partial and final gets an event entry, including unmatched hypotheses, empty revisions and cancellation finals. Text is redacted under the privacy rule. Fields without a producing observation are marked unavailable. Clock domains, sequences, input counts, queue data, inference durations and finalization timing are retained.

Negative timing estimates are preserved and counted. A clock-consistency criterion prevents a negative estimate from producing a timing pass. Separate distributions retain sender-dispatch, sidecar-receive, inference and finalization endpoints.

## All final replay results

The same two 29.981-second retained WAVs were replayed at real-time pace. Each input has two seconds of leading and trailing silence. The table measures the emitted segment's capture-end estimate through client receipt. Every run is retained.

| Run | Source | Partials | Finals | Partial median ms | Partial p95 ms | Final p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | mic | 1 | 2 | 1420.3 | 1420.3 | 2459.3 |
| 1 | system | 17 | 8 | 1102.5 | 1648.2 | 2485.5 |
| 2 | mic | 2 | 3 | 1151.9 | 1480.1 | 2202.2 |
| 2 | system | 17 | 7 | 1087.4 | 1635.8 | 2507.4 |
| 3 | mic | 2 | 3 | 1579.0 | 1914.6 | 2595.0 |
| 3 | system | 17 | 8 | 1022.3 | 1700.3 | 2716.1 |

All three timed runs meet partial median 2000 ms, partial p95 3000 ms and final p95 5000 ms for each source. Each source accepts 544000 samples, processes 543701 and removes 299 padding samples. Input drops, pending samples, unexplained samples and reported context loss are zero.

Mic has only one or two nonempty partial events per run. The current offline reference pass accepts zero mic words. Mic reference-word coverage and WER are unavailable. System partial reference coverage is about 48.9 percent of 45 reference words. Timely events alone do not establish recognition accuracy.

Historical reports use matched-reference-word receipt delay. Final timed reports use segment-end capture estimates. Both sets remain available as separate measures. Clock-domain descriptions were corrected after collection and sidecar-receive distributions were derived from retained timestamps. Original timestamps and existing numeric measurements were retained.

phase2-latency-report.md lists all 14 historical reports, all three final runs and pooled event-level results. The aggregate also retains the earlier tuning experiments, so slower runs remain visible.

## Automated verification

The final automated pass produced 193 Python tests passed in 13.65 seconds and 148 TypeScript tests passed across 19 files. The TypeScript run enabled the real sidecar process tests. Typecheck, build, generated wire-schema check and Git whitespace check passed.

The final real Electron startup smoke reached warmed readiness and exited successfully. Its sidecar trace records zero received input samples during startup warm-up. Final logs and machine-readable results are in tmp/phase2-final-base-20261127-203828/final-validation.json.

The build emits the existing Vite configuration compatibility warning and Node experimental TypeScript-strip warning. Both checks exit successfully.

New coverage includes startup initialization, late status replay, safe failure, resident-model reuse, fresh session state, real process restart, timed header parsing, legacy compatibility, sequence replay rejection, renderer clock translation, worklet clock discontinuity, metadata through IPC and WebSocket, first-live-pass retention, bounded health history, input conservation and every-event timing math.

The existing suite and assertions are preserved. An unsupported version 2 configuration without explicit timedFrames negotiation continues to be rejected by the old fixtures.

The real Electron startup smoke reached warmed readiness and exited successfully. It exercised the normal app entry without requesting media capture. Its earlier record is tmp/phase2-final-base-20261127-203828/electron-startup.json. Final validation will also retain the final startup record and per-process numeric snapshots.

## Acceptance criteria

| Criterion | Result and evidence |
| --- | --- |
| Sidecar initializes at app launch | PASS through startup unit and real Electron smoke |
| Model loads before ready | PASS through runtime and warm-up tests |
| Warm-up occurs once per model lifecycle | PASS through fake-engine counts and real lifecycle statuses |
| Recording sessions reuse the model | PASS across two sessions in the same real child process |
| Restart reloads and re-warms | PASS through actual process-kill tests |
| Init failure is safe and visible | PASS through status/error and late-subscriber tests |
| Sequences and capture estimates originate before IPC | PASS through worklet and capture tests |
| Audio-relative positions remain monotonic | PASS through sample-clock and gap tests |
| Metadata survives IPC and WebSocket | PASS through capture tests and real timed sessions |
| Python parses timing and accepts legacy format | PASS through protocol tests |
| Events map to source frames | PASS for producing inference events; cancellation identity and unavailable fields are retained |
| Both sources emit partials and finals | PASS in every final replay |
| Fair model scheduling and one model call at a time | PASS through queue and dual-source tests |
| Silence suppresses phantom output in injected silence | PASS in tests and replay checks |
| LocalAgreement stable commits and final identities | PASS through preserved regression tests and report checks |
| Input loss has explicit causes | PASS through overflow, pause, failure and shutdown tests |
| Unexplained accepted-sample loss is zero | PASS in final replays and fault tests |
| Partial median and p95 meet targets repeatedly | PASS for three short simulated-capture replays |
| Final p95 meets target repeatedly | PASS for three short simulated-capture replays |
| Recognition quality and mic WER | REQUIRES MANUAL TEST with a human reference |
| Harness uses real-time protocol replay | PASS with authenticated timed WebSocket frames |
| Every emitted event is logged | PASS with redacted text and explicit missing fields |
| Per-source drops, backlog and JSON reports exist | PASS |
| Electron receives readiness, errors and transcript events | PASS through real startup, manager and bridge checks |
| You and Remote labels in current rendering path | REQUIRES MANUAL TEST |
| Developer A overlay, hotkeys, consent and indicators | BLOCKED on Developer A flow adoption |
| Default self-contained installed speech runtime | BLOCKED on installer runtime/model payload adoption |
| Explicit external installed runtime layout | REQUIRES MANUAL TEST |
| Fresh physical call with mic, remote audio and video | REQUIRES MANUAL TEST and deferred by the user |

## Final manual validation

The user reported Not tested yet and asked to perform all testing at the end of Phase 2. phase2-real-call-validation.md is the consolidated final checklist. The consent-based diagnostic can exercise live capture, timing and transcript delivery with VINXA_CAPTURE_TEST=both and VINXA_CAPTURE_SPEECH=1.

The normal renderer remains the Phase 1 preview shell. Developer A owns the overlay, hotkeys, consent-owner UI and recording indicators. Their integrated fresh-call gate remains open. The existing installer resource list includes tray and audio-monitor resources and needs a speech runtime/model payload or a verified external layout.

Physical-call, Hindi-English accuracy and clean-machine installed speech criteria remain REQUIRES MANUAL TEST.

## Commands and artifact paths

Commands run from D:/vinxa/Vinxa.

    .venv/Scripts/python.exe -m pytest -q sidecar harness
    $env:VINXA_RUN_SIDECAR_SMOKE = '1'
    node_modules/.bin/vitest.cmd run --reporter=dot
    node_modules/.bin/tsc.cmd --noEmit
    node_modules/.bin/electron-vite.cmd build
    node scripts/export-sidecar-schema.cjs --check

Each final replay used this command with N set to 1, 2 and 3.

    .venv/Scripts/python.exe -m harness.replay --mic test_recordings/phase1-real-call-20261126-204045/microphone.wav --system test_recordings/phase1-real-call-20261126-204045/system_audio.wav --report tmp/phase2-final-base-20261127-203828/run-N.json

The startup smoke uses the built app and synthetic warm-up.

    node scripts/smoke-speech.cjs tmp/phase2-final-base-20261127-203828/electron-final.json

- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/run-1.json
- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/run-2.json
- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/run-3.json
- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/aggregate.json

## Preservation and proposed commits

Branch navya is retained. The pre-completion diff, index diff and all untracked files were saved outside the repository in D:/vinxa/navya-phase2-completion-backup-20261127-202554. Earlier Stage 1 and Stage 3 backups remain available.

Changes remain uncommitted. Proposed commits are Add negotiated frame timing and clock translation, Reuse the app-start warmed speech model across sessions, Preserve first live inference and complete event measurements, and Record Phase 2 verification and final manual checklist.

## Stage checkpoint

| Stage | Files and work | Status | Remaining dependency |
| --- | --- | --- | --- |
| 4 | Schemas, binary codec, worklet, capture IPC, manager, Python parser and frame provenance | DONE | Physical hardware timing validation |
| 5 | SpeechService, normal main entry, resident lifecycle and restart tests | DONE | Installed runtime adoption |
| 6 | First-live-pass retention, source fairness and inference profile | DONE for implementation and timed replay | Recognition quality and longer physical-call evidence |
| 7 | Every-event log, clock translation and source-specific timing distributions | DONE | Human reference for mic accuracy |
| 8 | Regression, real process and app-start checks | DONE for automated checks | Manual hardware checks |
| 9 | Runnable consent-based diagnostic and consolidated checklist | MANUAL-PENDING | User deferred testing and Developer A integration |
| 10 | Final report, historical inventory, commands and acceptance matrix | DONE | Manual results can be appended later |

## Current changed and untracked files

This listing includes earlier changes preserved from the start of the task.

     M harness/latency.py
     M harness/replay.py
     M harness/test_replay.py
     M sidecar/engine.py
     M sidecar/local_agreement.py
     M sidecar/protocol.py
     M sidecar/scheduling.py
     M sidecar/server.py
     M sidecar/session.py
     M sidecar/streaming.py
     M sidecar/test_local_agreement.py
     M sidecar/test_streaming.py
     M sidecar/test_word_engine.py
     M sidecar/vad.py
     M sidecar/wire-schema.json
     M src/main/audio/capture-test.test.ts
     M src/main/audio/capture-test.ts
     M src/main/index.ts
     M src/main/recording-speech-bridge.ts
     M src/main/sidecar-manager.ts
     M src/preload/index.test.ts
     M src/preload/index.ts
     M src/renderer/capture/capture.test.ts
     M src/renderer/capture/capture.ts
     M src/renderer/capture/worklet.test.ts
     M src/renderer/capture/worklet.ts
     M src/shared/contracts.ts
     M src/shared/ipc-channels.ts
     M src/shared/schemas.ts
    ?? docs/phase2-developer-b-final-report.md
    ?? docs/phase2-developer-b-integration.md
    ?? docs/phase2-latency-report.md
    ?? docs/phase2-real-call-validation.md
    ?? docs/phase2-stage2-diagnosis.md
    ?? docs/phase2-stage3-report.md
    ?? docs/phase2-streaming-transcription.md
    ?? docs/phase2-timing-protocol.md
    ?? scripts/smoke-speech.cjs
    ?? sidecar/diagnostics.py
    ?? sidecar/sample_accounting.py
    ?? sidecar/test_diagnostics.py
    ?? sidecar/test_ingestion.py
    ?? sidecar/test_phase2_lifecycle.py
    ?? src/main/speech-diagnostics.test.ts
    ?? src/main/speech-diagnostics.ts
    ?? src/main/speech-service.real.test.ts
    ?? src/main/speech-service.test.ts
    ?? src/main/speech-service.ts
    ?? src/main/speech-startup.test.ts
    ?? src/shared/frame-protocol.test.ts
    ?? src/shared/frame-protocol.ts

## Current diff summary

     harness/latency.py                   | 151 ++++++++-
     harness/replay.py                    |  74 +++-
     harness/test_replay.py               |  86 +++++
     sidecar/engine.py                    |  27 +-
     sidecar/local_agreement.py           |  21 +-
     sidecar/protocol.py                  |  33 +-
     sidecar/scheduling.py                |  18 +-
     sidecar/server.py                    | 107 +++++-
     sidecar/session.py                   |  15 +-
     sidecar/streaming.py                 | 482 ++++++++++++++++++++++----
     sidecar/test_local_agreement.py      |  19 ++
     sidecar/test_streaming.py            |  18 +
     sidecar/test_word_engine.py          |  17 +
     sidecar/vad.py                       |   5 +
     sidecar/wire-schema.json             | 631 ++++++++++++++++++++++++++++++-----
     src/main/audio/capture-test.test.ts  |  28 +-
     src/main/audio/capture-test.ts       |  77 ++++-
     src/main/index.ts                    |   9 +-
     src/main/recording-speech-bridge.ts  |  16 +-
     src/main/sidecar-manager.ts          | 142 +++++++-
     src/preload/index.test.ts            |  25 ++
     src/preload/index.ts                 |  15 +-
     src/renderer/capture/capture.test.ts |  22 ++
     src/renderer/capture/capture.ts      |  46 ++-
     src/renderer/capture/worklet.test.ts |  36 +-
     src/renderer/capture/worklet.ts      |  28 +-
     src/shared/contracts.ts              |   7 +-
     src/shared/ipc-channels.ts           |   4 +-
     src/shared/schemas.ts                |  43 ++-
     29 files changed, 1971 insertions(+), 231 deletions(-)

The diff summary excludes the untracked files listed above.
