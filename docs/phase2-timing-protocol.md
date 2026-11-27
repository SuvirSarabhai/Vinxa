# Phase 2 timing protocol

Status DONE. The user approved the remaining stages on 27 November 2026. The protocol and lifecycle additions were described before implementation.

## Negotiation and compatibility

The listening envelope retains protocolVersion 1. Authenticated configuration selects protocolVersion 2 together with timedFrames true. Version 1 configuration and its one-byte source prefix remain accepted. The explicit timedFrames field keeps older unsupported-version fixtures meaningful.

PCM remains mono 16 kHz signed Int16 little-endian. Every payload is 3200 bytes. Source-end reports the known padding in the last payload.

## Version 2 binary header

| Offset | Bytes | Encoding | Meaning |
| --- | --- | --- | --- |
| 0 | 2 | ASCII VX | Magic |
| 2 | 1 | unsigned byte | Version 2 |
| 3 | 1 | unsigned byte | Mic 0 or system 1 |
| 4 | 4 | uint32 little-endian | Source sequence |
| 8 | 8 | float64 little-endian | Source-relative start sample, a nonnegative safe integer |
| 16 | 8 | float64 little-endian | Capture estimate in sender monotonic milliseconds |
| 24 | 8 | float64 little-endian | WebSocket dispatch time in sender monotonic milliseconds |
| 32 | 4 | uint32 little-endian | Payload sample count 1600 |
| 36 | 8 | float64 little-endian | Capture clock uncertainty in milliseconds |
| 44 | 4 | uint32 little-endian | Bit 0 identifies an audio-render estimate; other bits are reserved |
| 48 | 3200 | PCM Int16 little-endian | Audio |

The sender and Python parser validate length, identity, finite timestamps, sample position, sample count and flags. Source sample anchors must match the frame header. Backward sequence numbers are rejected. Source gaps and pause/resume anchors preserve the measured session timeline.

## Clock translation

Renderer, main and sidecar use independent monotonic origins. Calendar time is recorded only as report metadata.

For an exchange, the client observes c1 before sending and c4 after receipt. The server observes s2 at handler receipt and s3 before replying.

    server_minus_client = ((s2 - c1) + (s3 - c4)) / 2
    exchange_uncertainty = ((c4 - c1) - (s3 - s2)) / 2

Three exchanges are taken and the exchange with the lowest nonnegative uncertainty is selected. Small numerical roundoff in uncertainty is bounded at zero. Measurements themselves retain their original signed values.

Capture IPC exchanges translate renderer performance time into main performance time. A separate clock-sync exchange translates main time into sidecar time. Clock-set confirms the selected offset and uncertainty before timed frames are admitted. Reconnecting after a process crash repeats the exchange.

AudioWorklet stamps source sequence and audio-context sample time before transferring PCM. The renderer anchors audio-context time after resume, maps it through the measured renderer/main offset and records observed clock residual as uncertainty. The first measured frame position establishes the source's session-relative anchor. Later positions advance by exactly 1600 samples. Audio graph clock discontinuities fail visibly.

The sample-time approximation includes graph quantum and resampler timing plus exchange uncertainty and observed residual. Hardware input latency is unmeasured. The captureKind field identifies render-estimate or replay, and the manual report must retain that distinction.

## Transcript timing

Jobs copy bounded frame provenance for their audio windows. A partial or final event includes source sequence range, capture start/end, dispatch, application receive, inference start/completion, emission and uncertainty when available. These fields initially use the sidecar clock. The main manager translates event timestamps back into its sender clock before publishing through the existing transcript IPC.

The event's audio start/end identify its recognized sample range. Empty cancellation events retain their event identity and audio positions. Fields generated without a producing inference remain unavailable in the harness.

The harness retains every event, including unmatched hypotheses and empty revisions, with transcript text redacted. Negative timing estimates are retained and counted. A clock-consistency criterion prevents those estimates from producing a timing pass.

## Resident model lifecycle

keepAlive and standby permit synthetic startup warm-up without capture. Session-begin supplies a fresh recording identity, enabled sources and language. Session-end drains finalization and clears per-session state while retaining the warmed engine. Stop releases the owned process.

The authenticated connection has one owner. Crash recovery reaps the old process, rotates admission credentials, reloads and re-warms the model, and re-establishes clock translation. A bounded recent-request history supports long-lived health checks for resident sessions. Legacy sessions retain their original request limit.

The model, buffers, VAD recurrence, agreement state and source sequences are tested across two sessions. The same engine serves both sources serially.
