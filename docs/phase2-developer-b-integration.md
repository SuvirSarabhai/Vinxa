# Developer B Phase 2 integration handoff

Status DONE for backend implementation and automated bridge checks. Overlay, hotkeys, consent-owner UI, recording indicators and installed runtime adoption remain Developer A integration work. Fresh-call validation is MANUAL-PENDING and deferred to the final Phase 2 validation pass.

Local follow-up: Developer A's normal consent/controller/overlay now adopts this
service. See [the local integration guide](phase2-local-integration.md). These
additional integration changes have not been executed or tested by the agent;
the backend's previously recorded results are not a result for this working tree.

## App lifecycle

The normal main-process entry initializes SpeechService after creating the window. Model loading and synthetic warm-up run asynchronously in the owned sidecar. Engine status arrives through the existing onEngineStatus subscription. Late subscribers receive the cached status.

The existing createRecordingSpeechBridge factory adopts the app's warmed service. getAppSpeech also exposes createBridge for explicit main-process integration. Initialize the app service once. Model selection uses VINXA_SPEECH_MODEL, default base.en, and VINXA_SPEECH_LANGUAGE, default en. A model change requires a fresh service lifecycle.

Stop on a recording bridge ends its session and retains the warmed model. App shutdown releases the owned sidecar after capture and finalization complete. Startup failure and restart publish safe error and availability states.

## Recording owner and capture

The owner supplies getState and hasConsent. Create a bridge after the owner's recording flow exists. Following consent, await bridge.start with a fresh sessionId, meetingId, selected model, language and enabledSources before forwarding capture.

Supply the same main-process session epoch to both capture sources. The capture clock handler authorizes the hidden frame's sender and returns mainReceiveMs, mainSendMs and sessionStartMs. The preload exposes clockSync. Capture translates AudioWorklet audio-context timestamps into main-clock estimates and produces source sequence, startSample, captureTimeMs, captureErrorMs, sampleCount and captureKind metadata.

Forward untagged PCM through bridge.frame, or existing source-tagged worklet packets through bridge.taggedFrame. The manager creates the negotiated binary header. Acquisition timestamps originate from the audio graph and measured clock exchanges.

Pause stops capture and transmission through the owner, then awaits bridge.pause. Resume establishes new measured source anchors before forwarding new frames. Clear queued callbacks from the pre-pause capture generation.

On stop, stop the devices, forward their final received frames, report each source's padding through sourceEnd and await bridge.stop while the owner permits final publication. App exit uses the central main-process shutdown sequence.

The optional VINXA_CAPTURE_TEST and VINXA_CAPTURE_SPEECH diagnostic exercises this path after the existing consent dialog. Its owner is confined to the diagnostic. Production integration uses Developer A's consent-owning recording flow.

## Events and renderer adoption

onTranscript delivers TranscriptSegment with optional timing. Mic is You and system is Remote. Replace a provisional row with the same ID when it is revised or finalized. Remove a provisional row when its final text is empty. On a sidecar restart, invalidate provisional rows from the failed generation and preserve committed finals.

The current preview shell is still Phase 1. The overlay and recording controls must adopt these subscriptions for their end-to-end acceptance check.

## Runtime layout

Development uses the local .venv and the external cached model. resolveSidecarRuntime supports a bundled sidecar executable or a configured interpreter/source layout. The app accepts VINXA_SIDECAR_SOURCE and VINXA_SIDECAR_PYTHON for an explicit external layout.

The current installer resource list contains tray and audio-monitor resources. A self-contained installed speech runtime and model payload need packaging adoption and verification. Missing resources emit a safe initialization error status.

## Diagnostics and validation

VINXA_DIAGNOSTICS_DIR enables bounded numeric traces. The manager assigns a unique sidecar output file per process generation. Quit the app to flush the final sidecar and main-process snapshots. Audio, transcript text and admission tokens are excluded from those traces.

Input accounting distinguishes accepted, processed, padded, pending and dropped samples. Context loss and overlapping inference windows have separate observations. The droppedSamples event metric remains visible.

See phase2-timing-protocol.md, phase2-latency-report.md, phase2-real-call-validation.md and phase2-developer-b-final-report.md for protocol details, all-run measurements, the final checklist and acceptance results.
