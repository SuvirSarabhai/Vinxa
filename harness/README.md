# Audio and Accuracy Harness

The harness makes the high-risk audio and speech pipeline repeatable before it is connected to the UI.

## Inputs

- Separate microphone and system WAV files from a real meeting call.
- Scripted fixtures for clear speech, alternating speakers, interruptions, Indian English, Hindi-English code-switching, fan/keyboard noise, and device changes.
- Reference transcripts for word-error-rate calculation.

## Measurements

- Median and p95 speech-to-partial-text latency.
- Final segment latency.
- faster-whisper real-time factor per model and source.
- Word error rate using `jiwer`.
- Echo-duplicate rate between microphone and system streams.
- Audio gap count and maximum gap.

## Acceptance targets

| Measure | Target |
| --- | --- |
| Partial transcript latency | ≤2 s median, ≤3 s p95 |
| Clear two-speaker English WER | ≤15% |
| Indian-English WER | ≤25% |
| Duplicate echo text | <5% of segments |
| Soak test | 20 minutes with no crash or gap over 1 s |

The harness must run before every major transcription change and on the demo laptop before packaging.

