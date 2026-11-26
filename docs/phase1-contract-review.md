# Phase 1 contract review

Review date: 26 November 2026. **PENDING REVIEW** by Developer A and the team.
This is a local implementation audit and review packet; no human agreement or
mentor sign-off is implied. Public types, schemas and IPC channel names have not
been changed during this finalization.

## Existing structures and compatibility

| Contract | Current structure / evidence | Finding |
| --- | --- | --- |
| TranscriptSegment | src/shared/schemas.ts; id, meetingId, source, nullable speakerId, text, nonnegative integer startMs/endMs, isFinal; end >= start | PASS for Phase 1 fixture integration; stable segment identity and session-relative time must be maintained by the future adapter |
| MeetingInsights | summary; decisions with text/atMs; actionItems with task, nullable owner/due, pending/done status | PASS for current typed provider boundary; missing owners/dates must be explicit null |
| RecordingState | idle, awaiting-consent, recording, paused, stopping, processing, completed, interrupted, error | PASS as a schema; transition enforcement is explicitly Phase 2 |
| RecordingConfig | title, microphoneEnabled, systemAudioEnabled, nullable microphoneDeviceId; at least one source | PASS as a shared proposal; current diagnostic uses Windows default mic rather than this future selection API |
| AudioSourceName / sourceIds | mic/system strings; mic=0, system=1 | PASS; shared PCM and source-bound WAV writers use these identities |
| AudioSource | start(config,onFrame), pause(), resume(), stop(); callback(source,pcm:Uint8Array) | PENDING REVIEW: document whether pcm excludes the source prefix; existing diagnostic transfers a complete tagged ArrayBuffer instead |
| DesktopApi | fixtureCommand; transcript and fixture-status subscriptions with unsubscribe functions | PASS for current context-isolated fixture player; live recording API is not exposed yet |
| CaptureBridge | ready(), frame(ArrayBuffer), finished({error,paddedSamples}), onStop() | PASS for diagnostic; existing preload validates shape and main binds each sender to one source |
| IPC names | src/shared/ipc-channels.ts; fixture, capture, planned recording/data/settings/event channels | PASS for current handlers; declared future names are not evidence those services are implemented |
| SidecarConfig | config/token, fixed 16kHz/mono/pcm_s16le/100ms, model, nullable language | PASS as a proposal; Python supports base.en/small and its file API has no WebSocket server |
| SidecarEvent | partial/final with source/text/startMs/endMs; status loading/ready/stopped; error code/message | PENDING REVIEW for live identity and time mapping; live events are not implemented in Phase 1 |
| InsightsProvider | generate(TranscriptSegment[]) -> Promise<MeetingInsights> | PASS as an interface; actual providers are later work |

Evidence files: src/shared/contracts.ts, schemas.ts, schemas.test.ts,
ipc-channels.ts, pcm.ts, src/preload/index.ts and docs/phase-1-contracts.md.
The fixture and capture tests exercise existing boundaries. The Python engine
returns WAV-relative segment times and does not duplicate these TypeScript types.

## Issues to resolve before live integration

1. **Frame callback ambiguity.** The wire frame is one source byte plus 3,200 PCM
   bytes, total 3,201. AudioSource already supplies source separately. Smallest
   proposal: add a documentation comment defining callback pcm as the 3,200
   untagged bytes; have the future adapter add the source prefix exactly once.
   Do not implement the adapter now. Status: **PENDING REVIEW**.
2. **Utterance identity.** Sidecar events lack an utterance id; the current handoff
   proposes deriving identity from source and startMs. Rolling transcription can
   move an estimated start time. Smallest proposal: agree on immutable per-source
   utterance identity, potentially an optional utteranceId, and then update both
   event producers and consumers together. No schema change was made. Status:
   **PENDING REVIEW**.
3. **Common time origin.** Separate diagnostic capture windows start independently;
   engine times are relative to their WAV. Phase 2 needs a common session epoch
   and measured per-source offsets. Smallest proposal: document adapter mapping
   before deciding whether a capture-start offset field is needed. No new field
   is agreed. Status: **PENDING REVIEW**.
4. **Date and model semantics.** due is currently any nullable string, and model
   is an arbitrary nonempty string while the current engine supports two names.
   Agree on due-date formatting and unsupported-model errors at the boundary.
   Preserve extensibility; do not narrow public schemas without team review.
   Status: **PENDING REVIEW**.
5. **Lifecycle scope.** AudioSource pause/resume, recording state transitions,
   WebSocket token validation and provider implementations are future services.
   Their absence is expected in this Phase 1 spike. Do not label them implemented.

## Agreed changes and review record

- Agreed public contract changes during this finalization: **none**.
- Existing diagnostic frame format remains unchanged.
- Gain and level metrics belong to internal worklet messages and configuration;
  CaptureBridge.finished remains {error,paddedSamples}.
- Developer A reviewer/name/date: **PENDING REVIEW**.
- Developer B reviewer/name/date: **PENDING REVIEW** for team acceptance; local
  code audit is recorded above.
- Resolution of identity/time-origin proposals: **PENDING REVIEW**.
- Mentor capture-path review: **PENDING REVIEW**.

## Mentor review checklist

| Item to inspect | Evidence requested | Status |
| --- | --- | --- |
| Microphone quality | Fresh speech WAV, peak/RMS/full-scale counts, pre-gain diagnostics and listening | PENDING REVIEW |
| WASAPI loopback quality | Remote voice and video in a separate valid system WAV | PENDING REVIEW |
| Missing/distorted playback | Recordings, routes and actual error/cleanup behavior | PENDING REVIEW |
| Bluetooth | Exact input/output profile, alternating speech/playback and switching result | PENDING REVIEW |
| Default/non-default outputs | Route A/B test with remote speech, no universal loopback claim | PENDING REVIEW |
| Fallback suitability | Review standalone selected-output diagnostic, source 1 PCM contract and actual non-default route evidence before integrating/selecting it in Electron | PENDING REVIEW |
| Source isolation and time | Independent worklets/writers, source-byte checks and unsynchronized-start limitation | PENDING REVIEW |

Record reviewer, date, findings and explicit acceptance here after review. A
prepared checklist or an automated test run does not complete human review.
