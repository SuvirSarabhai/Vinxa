# Phase 2 Stage 3 ingestion and accounting report

Stage 3 is DONE. Input conservation, bounded handoffs and fault-path accounting are PASS in automated verification. Overall Phase 2 remains PARTIAL. Performance acceptance is FAIL. Physical-call and Developer A overlay validation remain MANUAL-PENDING with REQUIRES MANUAL TEST.

## Work completed

Each source has its own bounded 32-frame input queue. Ingestion validates source state, assigns the existing source-relative sample cursor and queues PCM without waiting for VAD, inference or network emission. Overflow removes the oldest queued input frame, keeps the newest frames and records the exact removed sample count and numeric reason.

VAD runs in a separate worker pool with at most one active call per source. Source consumers serialize buffer updates and inference scheduling. The existing single shared speech-model worker and round-robin inference queue remain in place. Model selection, beam size, six-second inference window, one-second cadence, VAD thresholds and two-pass LocalAgreement retain their prior settings.

Outgoing speech events use a separate bounded 256-event queue. Slow delivery applies backpressure to event producers while ingestion remains available. Failed delivery clears readiness and releases waiting producers. Shutdown accounts for discarded input, joins native workers and releases retained inference snapshots. Concurrent shutdown callers await the same cleanup task.

Input overflow causes a source discontinuity at the original sample position. The pipeline invalidates the affected context and preserves the elapsed source timeline. Padding is removed only from the known final frame. Pause and shutdown discards are counted by cause.

Transcript identity advances before yielding to the sender. Invalidated queued partials are discarded explicitly, while committed final events retain their identity. Trace records carry the producing inference job's timings, avoiding association with a later job when event delivery is delayed.

## Sample accounting

The per-source conservation equation is

    accepted input = processed + input dropped with reason + final padding + pending input

At completed shutdown, pending and unexplained samples must both be zero. Received samples in this accounting mean frames accepted by the active sidecar pipeline. Frames rejected before acceptance retain separate server diagnostic counters.

Input drop reasons are overflow, pause, shutdown, processing failure and context reset. Reported upstream gaps are tracked separately because those samples never entered the sidecar. Unique inference coverage is computed over completed inference windows with overlap removed. Old interval detail is retired only when no retained or queued window can revisit it.

The existing droppedSamples event metric stays visible. It can report uncommitted rolling-context loss as well as input loss. Processed-without-inference samples include silence, VAD-negative material and other input outside completed windows. They do not establish recognition accuracy.

## All post-change replay results

All four runs replay the same two saved WAVs at real-time pace through protocol version 1. Runs 1 through 3 exercise the ingestion implementation. Run 4 follows shutdown hardening. Every result is retained. Later fault-path cleanup tests also verify snapshot release.

Latencies below are matched-reference-word client-receipt estimates from model alignment. Each mic partial percentile contains one matched word, so it provides limited evidence. Precise capture-to-event latency remains unavailable.

| Run | Mic partial median ms | Mic final p95 ms | System partial median ms | System partial p95 ms | System final p95 ms | Reported dropped samples |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2531.0 | 4484.0 | 1452.5 | 2503.8 | 5165.1 | 0 |
| 2 | 2609.0 | 4422.0 | 1468.5 | 2566.8 | 5182.8 | 0 |
| 3 | 2719.0 | 4531.0 | 1500.0 | 2531.0 | 5206.2 | 0 |
| 4 | 2672.0 | 4438.0 | 1445.5 | 2437.8 | 5175.2 | 0 |

Each run produced one nonempty mic partial and two mic finals. System produced 15, 15, 14 and 15 nonempty partials, with six nonempty finals in each run. Every run remains performance_status PARTIAL. Mic partial median exceeds 2000 ms in every run. System final p95 exceeds 5000 ms in every run.

The Stage 1 reported-context totals were 0, 11840 and 11840 samples. The four Stage 3 totals are all zero. These measurements use separate runs on the same hardware and do not establish how much speed variation comes from scheduling or operating-system conditions.

## Accounting verified in every replay

| Measure per source per run | Mic | System | Criterion |
| --- | --- | --- | --- |
| Frames sent, received, validated and accepted | 340 | 340 | PASS |
| Accepted samples including padding | 544000 | 544000 | PASS |
| Processed samples | 543701 | 543701 | PASS |
| Final padding removed | 299 | 299 | PASS |
| Input dropped samples | 0 | 0 | PASS |
| Pending samples at close | 0 | 0 | PASS |
| Unexplained samples | 0 | 0 | PASS |
| Unique samples in completed inference windows | 85056 | 404928 | PASS against independent interval union |
| Nonempty partial and final events | Both present | Both present | PASS for presence |
| Latency targets across runs | Partial median FAIL | Final p95 FAIL | FAIL |

The reports retain 377 received events including 109 transcript events. All emitted transcript events are represented, including empty revisions and cancellation finals. Diagnostic and event row omission counts are zero. Final event IDs are unique per source in every run.

## Tests and commands

The full Python command was .venv/Scripts/python.exe -m pytest -q sidecar harness. Actual final output was 186 passed in 6.32s.

The eight added tests cover overlapping inference coverage and retirement, a blocked mic VAD worker with continuing system ingestion, explicit input overflow, a blocked model with continuing ingestion, pause conservation, stalled event delivery, safe VAD failure, failed sender backpressure, concurrent shutdown with failed drop reporting, and releasing an abandoned snapshot after the native worker returns. Some tests exercise multiple related conditions.

With VINXA_RUN_SIDECAR_SMOKE=1, node_modules/.bin/vitest.cmd run --reporter=dot produced 137 passed across 15 files in 11.81s. After shutdown hardening, the real sidecar test was rerun separately and produced 1 passed in 8.38s. Existing assertions remain in place.

node_modules/.bin/tsc.cmd --noEmit exited 0. node_modules/.bin/electron-vite.cmd build exited 0 and built main, preload and renderer. git diff --check passed. Vite emitted its existing config-loader compatibility warning.

Commands ran from D:/vinxa/Vinxa. Each replay used the command below with N set to 1, 2, 3 and 4.

    .venv/Scripts/python.exe -m harness.replay --mic test_recordings/phase1-real-call-20261126-204045/microphone.wav --system test_recordings/phase1-real-call-20261126-204045/system_audio.wav --report tmp/phase2-stage3-20261127-001703/run-N.json

All replay commands exited 0. Successful replay completion is recorded separately from the failing performance criteria.

## Acceptance checkpoint

| Criterion | Result |
| --- | --- |
| Slow inference allows ingestion to continue | PASS |
| A blocked mic VAD worker allows system processing to continue | PASS |
| Input queues retain a fixed bound and count overflow by cause | PASS |
| Stalled output allows bounded input ingestion | PASS |
| Every accepted sample is processed, pending, padded or counted as dropped | PASS |
| Completed runs have zero unexplained samples | PASS |
| Overlapping inference coverage is counted uniquely | PASS |
| Pause, failure and concurrent close conserve samples | PASS |
| Existing silence, LocalAgreement and source tests pass | PASS |
| Recognition and protocol settings retain their previous values | PASS |
| Phase 2 latency meets all targets | FAIL |
| Fresh physical call and overlay integration | REQUIRES MANUAL TEST |

## Files and preservation

The Stage 3 source changes are sidecar/streaming.py, sidecar/server.py, sidecar/diagnostics.py, harness/latency.py and harness/replay.py. New source files are sidecar/sample_accounting.py and sidecar/test_ingestion.py. This report is the Stage 3 checkpoint artifact.

The pre-stage diff, index diff and all untracked files were saved outside the repository at D:/vinxa/navya-stage3-backup-20261127-000834. Earlier work is preserved. No commit or push was made.

Proposed commit messages are Decouple sidecar ingestion from VAD and event delivery and Account for input drops and unique inference coverage.

## Remaining Phase 2 work

Stage 4 requires a reviewed timing protocol and clock-offset proposal before the binary format changes. App-launch warm-up and model reuse remain for Stage 5. Sparse mic partials, inference-capacity limits and latency tuning remain for Stage 6. Later work completes capture timing measurements and physical-call validation. Further staged changes require their specified approval checkpoints.

## Reports

- D:/vinxa/Vinxa/tmp/phase2-stage3-20261127-001703/run-1.json
- D:/vinxa/Vinxa/tmp/phase2-stage3-20261127-001703/run-2.json
- D:/vinxa/Vinxa/tmp/phase2-stage3-20261127-001703/run-3.json
- D:/vinxa/Vinxa/tmp/phase2-stage3-20261127-001703/run-4.json
- D:/vinxa/Vinxa/tmp/phase2-stage3-20261127-001703/aggregate.json

## Current changed and untracked files

This full listing includes the preserved earlier changes.

     M harness/latency.py
     M harness/replay.py
     M harness/test_replay.py
     M sidecar/engine.py
     M sidecar/local_agreement.py
     M sidecar/scheduling.py
     M sidecar/server.py
     M sidecar/streaming.py
     M sidecar/test_local_agreement.py
     M sidecar/test_streaming.py
     M sidecar/test_word_engine.py
     M sidecar/vad.py
     M src/main/audio/capture-test.ts
     M src/main/recording-speech-bridge.ts
     M src/main/sidecar-manager.ts
     M src/preload/index.test.ts
     M src/preload/index.ts
     M src/renderer/capture/capture.ts
     M src/renderer/capture/worklet.test.ts
     M src/renderer/capture/worklet.ts
     M src/shared/contracts.ts
     M src/shared/schemas.ts
    ?? docs/phase2-developer-b-integration.md
    ?? docs/phase2-stage2-diagnosis.md
    ?? docs/phase2-stage3-report.md
    ?? docs/phase2-streaming-transcription.md
    ?? sidecar/diagnostics.py
    ?? sidecar/sample_accounting.py
    ?? sidecar/test_diagnostics.py
    ?? sidecar/test_ingestion.py
    ?? src/main/speech-diagnostics.test.ts
    ?? src/main/speech-diagnostics.ts

## Current diff summary

     harness/latency.py                   | 106 ++++++++-
     harness/replay.py                    |  42 +++-
     harness/test_replay.py               |  52 +++++
     sidecar/engine.py                    |  27 ++-
     sidecar/local_agreement.py           |  21 +-
     sidecar/scheduling.py                |  12 +-
     sidecar/server.py                    |  33 ++-
     sidecar/streaming.py                 | 417 ++++++++++++++++++++++++++++++-----
     sidecar/test_local_agreement.py      |  19 ++
     sidecar/test_streaming.py            |  18 ++
     sidecar/test_word_engine.py          |  17 ++
     sidecar/vad.py                       |   5 +
     src/main/audio/capture-test.ts       |  32 ++-
     src/main/recording-speech-bridge.ts  |  12 +-
     src/main/sidecar-manager.ts          |  34 ++-
     src/preload/index.test.ts            |  11 +
     src/preload/index.ts                 |   7 +-
     src/renderer/capture/capture.ts      |  14 +-
     src/renderer/capture/worklet.test.ts |  14 +-
     src/renderer/capture/worklet.ts      |  13 +-
     src/shared/contracts.ts              |   6 +-
     src/shared/schemas.ts                |   4 +
     22 files changed, 815 insertions(+), 101 deletions(-)

Untracked files are listed above and are excluded from the Git diff summary.
