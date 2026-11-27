# Phase 2 streaming transcription

Developer B implementation, 26 November 2026. The live backend is implemented;
Developer A's overlay and recording-flow adoption remain separate integration work.

## Separate sources and VAD

Audio stays 16 kHz mono Int16 with the existing mic=0/system=1 source identity.
Each source has its own sample cursor, bounded audio buffer, held final frame,
Silero recurrent h/c/context, speech gate, utterance counter and agreement state.
No microphone/system mixing, acoustic echo deduplication or speaker-renaming
logic is present.

The scorer uses the Silero V6 ONNX model distributed with faster-whisper 1.2,
through ONNX Runtime CPU. It rechunks the existing 1,600-sample packets into
512-sample windows and preserves the remainder. It does not install or load Torch.
Default onset/release probabilities are 0.5/0.35, minimum speech is 96 ms,
end-of-speech silence 400 ms, pre-speech padding 200 ms and retained tail 100 ms.
Short pauses do not reset a speech region. Source reset clears only that source's
recurrent state. Source-end/stop handles the real partial tail and its padding.

No Whisper inference is scheduled for pure VAD-negative silence. Model outputs
are additionally filtered for low log probability, combined no-speech/low-confidence
evidence and excessive compression ratio. Known closing/subscribe phrases are
filtered only on very low energy, rather than banned from legitimate speech.
Thresholds reduce hallucinations; they do not constitute an accuracy guarantee.

## Rolling windows, agreement and identities

The default inference cadence is one requested pass per second of active source
audio. Each snapshot is at most six seconds; a per-source buffer holds at most
20 seconds. Committed words trim older samples while retaining 300 ms overlap.
Uncommitted samples evicted from a buffer/window are reported as AUDIO_DROPPED.
No unbounded audio history or inference queue is retained.

LocalAgreement is pure logic in sidecar/local_agreement.py. Two consecutive
hypotheses must agree on a normalized word prefix with bounded timestamp drift.
Whitespace, case and attached punctuation do not turn the same word into a new
word. A committed prefix becomes an immutable final chunk; the unstable suffix
uses a new provisional chunk ID, revised until its own final. A finalization pass
commits the remaining accepted words once. Word revisions crossing an immutable
commit boundary are discarded rather than moving already published timestamps.
This can reduce coverage when model alignment drifts; the harness reports it.

The manager maps validated events to the existing TranscriptSegment. A provisional
chunk and its final retain the same id. Empty final text cancels an unconfirmed
provisional chunk when context is invalidated. Developer A should hide/remove
empty rows through their existing transcript rendering path. No overlay is built.

## Single model and scheduling

One SpeechEngine loads one faster-whisper base.en CPU INT8 model. Inference and
warm-up use a single ThreadPoolExecutor worker; the engine's existing lock also
serializes model calls. There are no concurrent mic/system calls on one model.
VAD is small and independent of the speech model.

The queue rotates sources round-robin. Each source has at most two queued jobs
plus the single global in-flight job. A newer live snapshot replaces an older
queued live snapshot for the same utterance. Final jobs are retained; when a
queue has only final jobs and reaches its bound, new work is rejected and loss
is reported. A slow model coalesces work rather than growing a stale backlog.

Profiling the final base.en path measured encoder work as the largest share of a six-second inference window. The selected four-thread profile took about 0.661 seconds, including 0.469 seconds in encoding. The final runtime keeps the library's encoder context and beam setting. A bounded queue can retain a first live pass before its final job when space is available, reducing short-utterance provisional starvation.

See phase2-latency-report.md for all-run results and metric definitions.

## Lifecycle

The app starts a resident sidecar and warms the selected model using synthetic audio before readiness. Recording sessions reuse that model and create fresh buffers, VAD and agreement state. Session end drains finals and retains the model. App shutdown releases the process. Restart reloads, re-warms and repeats clock synchronization.

Each source has a bounded input handoff and independent VAD processing. A bounded event sender separates network backpressure from ingestion. Input overflow keeps newer frames, records a source discontinuity and counts removed samples by cause. Pause and shutdown preserve the input accounting equation.

Protocol version 2 carries frame sequences and measured sample timing. Version 1 remains available for legacy callers. Transcript events include producing-frame provenance when available.

An inference already executing in native code cannot be interrupted safely as
a Python thread. Its result is invalidated by a source epoch; shutdown joins it.
The parent process supervisor enforces process deadlines and can terminate the
owned process if graceful finalization fails.

## Tuning

Internal environment settings are validated and do not change shared contracts:

| Variable | Default | Purpose |
| --- | --- | --- |
| VINXA_STREAM_INTERVAL_SECONDS | 1 | Active-source inference request cadence |
| VINXA_STREAM_WINDOW_SECONDS | 6 | Maximum inference audio window |
| VINXA_MAX_BUFFER_SECONDS | 20 | Per-source retained audio cap |
| VINXA_STREAM_OVERLAP_SECONDS | 0.3 | Audio overlap after commits |
| VINXA_MAX_QUEUE_PER_SOURCE | 2 | Maximum queued snapshots per source |
| VINXA_BEAM_SIZE | 1 | Streaming greedy baseline; Phase 1 benchmark remains beam 5 |
| VINXA_CPU_THREADS | 4 | Threads for the one speech model |
| VINXA_VAD_THRESHOLD / VINXA_VAD_RELEASE | 0.5 / 0.35 | Speech onset/release thresholds |

Beam/context changes are speed-quality tradeoffs. No WER or Hindi-English quality
claim is made without a human reference and the appropriate multilingual model.
See [latency methodology/results](phase2-latency-report.md).

Primary implementation references: [Silero input/state handling](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py),
[faster-whisper word timestamps](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py),
[CTranslate2 variable-length encoder](https://github.com/OpenNMT/CTranslate2/blob/master/src/layers/whisper.cc).
