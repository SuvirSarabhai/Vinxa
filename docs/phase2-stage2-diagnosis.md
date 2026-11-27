# Phase 2 Stage 1 observations and Stage 2 diagnosis

Stage 1 collection is DONE. Stage 2 diagnosis is PARTIAL for the historical run and DONE for the three observed replays. Performance acceptance is FAIL. Physical call and overlay validation remain MANUAL-PENDING with REQUIRES MANUAL TEST.

## Preservation and scope

Branch navya was verified. The original diff, index diff and two untracked documents were saved in D:/vinxa/navya-stage1-backup-20261126-235140. Initial state was nine modified files and two untracked documents. Existing work is preserved.

This stage adds bounded numeric observations and event records. The current model, VAD thresholds, window size, beam setting, scheduling policy and LocalAgreement behavior retain their existing settings. Transcript text is redacted under the privacy rule.

The capture IPC gains an optional numeric diagnostics argument carrying sequence and cumulative counters. Version 1 WebSocket frames retain their source byte and PCM payload. Precise capture timing and sequence headers require the later protocol proposal.

## Every replay result

Each run uses the saved real-call WAVs through authenticated WebSocket replay at real-time pace. Every run is retained. The table uses model-aligned reference-word client-receipt estimates. Mic latency statistics each contain one matched partial word and one matched final word.

| Run | Source | Nonempty partials | Nonempty finals | Partial median ms | Partial p95 ms | Final p95 ms | Reported lost context samples |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | mic | 1 | 2 | 2687.0 | 2687.0 | 4547.0 | 0 |
| 1 | system | 14 | 6 | 1406.0 | 2206.4 | 6407.7 | 0 |
| 2 | mic | 1 | 2 | 1687.0 | 1687.0 | 3468.0 | 0 |
| 2 | system | 15 | 6 | 1804.5 | 3380.6 | 5595.1 | 11840 |
| 3 | mic | 1 | 2 | 2406.0 | 2406.0 | 4141.0 | 0 |
| 3 | system | 14 | 6 | 1985.0 | 3312.6 | 5498.6 | 11840 |

All runs have performance_status PARTIAL. Mic partial median fails 2000 ms in runs 1 and 3. System partial p95 fails 3000 ms in runs 2 and 3. System final p95 exceeds 5000 ms in every run.

## Per-stage counters and timings

| Stage | Mic in each run | System in each run | Criterion |
| --- | --- | --- | --- |
| Frames sent | 340 | 340 | PASS |
| Server frames received | 340 | 340 | PASS |
| Frame validation passed | 340 | 340 | PASS |
| Ingestion accepted | 340 | 340 | PASS |
| Samples sent including final padding | 544000 | 544000 | PASS |
| Samples processed and passed to VAD | 543701 | 543701 | PASS |
| Known padding removed | 299 | 299 | PASS |
| Unexplained ingestion samples | 0 | 0 | PASS |
| VAD speech starts | 3 | 5 | PASS |
| Inference passes in runs 1 2 3 | 5 6 6 | 23 24 24 | Both sources scheduled |
| Snapshot replacements in runs 1 2 3 | 2 1 1 | 6 5 5 | Observed |
| Full-queue rejections and evictions | 0 | 0 | No overflow observed |

Maximum replay pacing lag was 32 ms. WebSocket send calls took at most 16 ms. Ingestion and VAD calls took at most 16 ms. The clock on this machine shows coarse increments. Reported zero-duration calls completed below its observed resolution.

Median inference times were 860 to 908 ms for mic and 857 to 912 ms for system. System inference spikes reached 3647 ms, 3007 ms and 3027 ms across the three runs. Maximum queue waits reached 1265 ms for mic and 2984 ms for system. Scheduling intervals also include silence, so queue wait gives the more useful measure of service delay.

The traces contain 3.456 seconds of threshold-positive mic VAD windows and 21.216 seconds for system. Raw samples outside speech regions still enter VAD and the bounded buffer. Inference sample totals include repeated overlapping snapshots and cannot be summed as unique input coverage.

## Loss diagnosis

Runs 2 and 3 each report 11840 system samples through reason code 2. The six-second rolling window moves past uncommitted samples 160960 through 172800, totaling 740 ms. All input frames arrived and were processed. Full-queue rejection and eviction counters are zero. Pending live snapshots are coalesced by the existing replacement policy.

The existing droppedSamples metric counts uncommitted context passing a window or buffer boundary. An older queued or running snapshot can still contain those samples. Separate accounting for input loss, context eviction and unique inference coverage is needed in Stage 3. The metric remains visible.

The historical 161088-sample run has no per-stage trace, so its exact causes cannot be assigned retrospectively. Its approximately 2.7-second median inference and queue waits up to 15 seconds support an overload hypothesis. That run reported battery power, while all three new runs report AC power. Power state may explain part of the difference. A controlled comparison would be needed to establish causation.

## Missing mic partial diagnosis

All 340 mic frames arrive with the correct source identity. VAD opens three regions. The scheduler executes five or six mic jobs. In each new run the first region's live hypothesis has its only segment removed by the existing quality filter. The second region produces three accepted words in a live pass and a nonempty partial.

The second region also has a later pending live snapshot replaced by its final job in every run. In run 1 the third region's live job is replaced by its final job. In runs 2 and 3 the third region gets a live inference whose segment is filtered, followed by a final pass containing accepted words.

Sparse mic partials follow from short speech regions, filtered hypotheses and replacement of pending live passes by final jobs. LocalAgreement emits an unstable suffix on a usable live pass. Its two-pass commit rule does not require withholding provisional text. The historical zero-partial run lacks the observations needed to identify which paths occurred there.

## System latency diagnosis

There is a one-frame hold, a roughly one-second active-audio scheduling cadence, VAD onset and end gates, one model worker, and agreement over successive hypotheses. The six-second window is a maximum snapshot length and does not force a six-second startup wait.

The measured ingestion and sender delays are in milliseconds. Model work is hundreds to thousands of milliseconds. CPU inference capacity and decoding variability dominate the measured delays. When both sources request one pass per second, median service demand can exceed one worker-second per second. Queue contention, inference spikes, repeated context, filtered hypotheses and stability waits add latency. The current coalescing policy can replace the only pending live pass of a short utterance.

The traces support an inference-capacity limit combined with scheduling effects. They do not establish a single cause for all hardware speed variation.

## Measurement integrity

All 83 transcript events, including empty partial revisions and empty finals, are retained. All 290 received events across the runs are retained. No event or diagnostic rows were omitted.

Worker start/completion and emission-send completion timestamps stay in the sidecar clock domain. Replay send completion and client receipt stay in the harness clock domain. Cross-process clock subtraction is avoided.

Event-to-frame association uses model-aligned audio end positions and received frame ordinal. Capture timestamps, exact acquisition times, sequence verification across the legacy WebSocket, and clock offsets remain unavailable. Event-end-frame latency is an explicitly labelled proxy. Its pooled distributions include empty events.

The worklet, capture IPC, WAV writer, recording bridge and sidecar manager have opt-in counters. Set VINXA_DIAGNOSTICS_DIR to a writable directory before an Electron diagnostic run. Numeric snapshots are saved on capture or manager shutdown. Python replay traces are embedded in each report.

Replay bypasses Electron capture hops. Their runtime verification and Developer A overlay delivery remain REQUIRES MANUAL TEST.

## Proposed fix plan pending approval

1. Separate input-frame loss, padding removal, context eviction and unique inference coverage while keeping droppedSamples visible.
2. Decouple synchronous VAD and event sends from ingestion with bounded handoffs and explicit overflow causes.
3. Preserve a useful first live pass for short speech while bounding finalization and retaining one model and two-pass stable commits.
4. Profile the recurring expensive decoding and alignment windows before proposing decoding or context changes.
5. Present the negotiated timing-header and clock-offset design for separate approval.
6. Implement app-start initialization and session model reuse at the lifecycle stage.

Model changes require user approval. Further fixes are BLOCKED pending approval of this plan.

## Validation commands and actual output

Commands were run from D:/vinxa/Vinxa.

- .venv/Scripts/python.exe -m pytest -q sidecar harness produced 178 passed in 28.64s.
- With VINXA_RUN_SIDECAR_SMOKE=1, node_modules/.bin/vitest.cmd run --reporter=dot produced 137 passed across 15 files in 10.93s.
- node_modules/.bin/tsc.cmd --noEmit exited 0.
- node_modules/.bin/electron-vite.cmd build built main, preload and renderer and exited 0.

Existing assertions remain in place. The real sidecar warm-up and process-kill/restart test passed. Vite emitted its existing config-loader compatibility warning.

The three replay commands each exited 0 and each performance_status remains PARTIAL. Each used the following command with N set to 1, 2 and 3.

    .venv/Scripts/python.exe -m harness.replay --mic test_recordings/phase1-real-call-20261126-204045/microphone.wav --system test_recordings/phase1-real-call-20261126-204045/system_audio.wav --report tmp/phase2-stage1-20261126-235905/run-N.json

## Reports

- D:/vinxa/Vinxa/tmp/phase2-stage1-20261126-235905/run-1.json
- D:/vinxa/Vinxa/tmp/phase2-stage1-20261126-235905/run-2.json
- D:/vinxa/Vinxa/tmp/phase2-stage1-20261126-235905/run-3.json
- D:/vinxa/Vinxa/tmp/phase2-stage1-20261126-235905/aggregate.json

## Checkpoint

Changed files cover the harness, numeric diagnostic collectors, Python observation hooks, Electron capture IPC counters and focused tests. The original uncommitted work remains included.

Stage 1 collection is DONE. Performance is FAIL. Stage 2 diagnosis remains PARTIAL for the historical run. Fresh physical-call and overlay validation are MANUAL-PENDING with REQUIRES MANUAL TEST.

Proposed commits are Add bounded speech pipeline diagnostics and Record all transcript events with explicit timing availability. Changes remain uncommitted.

## Changed and untracked files

This listing includes the pre-existing changes preserved from the start of this stage.

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
    ?? docs/phase2-streaming-transcription.md
    ?? sidecar/diagnostics.py
    ?? sidecar/test_diagnostics.py
    ?? src/main/speech-diagnostics.test.ts
    ?? src/main/speech-diagnostics.ts

## Diff summary

     harness/latency.py                   | 101 ++++++++++++++++++++++++++++++++++-
     harness/replay.py                    |  38 ++++++++++---
     harness/test_replay.py               |  52 ++++++++++++++++++
     sidecar/engine.py                    |  27 +++++++---
     sidecar/local_agreement.py           |  21 +++++++-
     sidecar/scheduling.py                |  12 ++++-
     sidecar/server.py                    |  19 ++++++-
     sidecar/streaming.py                 |  95 ++++++++++++++++++++++++++------
     sidecar/test_local_agreement.py      |  19 +++++++
     sidecar/test_streaming.py            |  18 +++++++
     sidecar/test_word_engine.py          |  17 ++++++
     sidecar/vad.py                       |   5 ++
     src/main/audio/capture-test.ts       |  32 +++++++++--
     src/main/recording-speech-bridge.ts  |  12 ++++-
     src/main/sidecar-manager.ts          |  34 +++++++++---
     src/preload/index.test.ts            |  11 ++++
     src/preload/index.ts                 |   7 ++-
     src/renderer/capture/capture.ts      |  14 ++++-
     src/renderer/capture/worklet.test.ts |  14 ++++-
     src/renderer/capture/worklet.ts      |  13 +++--
     src/shared/contracts.ts              |   6 ++-
     src/shared/schemas.ts                |   4 ++
     22 files changed, 511 insertions(+), 60 deletions(-)

The diff summary excludes untracked files. New diagnostic collectors and tests are listed above.
