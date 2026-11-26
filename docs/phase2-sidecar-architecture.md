# Phase 2 sidecar architecture and protocol

26 November 2026. The user approved the Stage 1 shared-contract proposal and
Stage 2 implementation. **Stage 1: DONE. Stage 2: DONE for transport only.**
Developer A's human contract review and live-recording integration remain pending.
The approved target architecture below includes later stages; current behavior
and remaining work are explicitly separated in the Stage 2 checkpoint.

## Confirmed baseline

- Branch navya, clean before this document. main has been pulled separately;
  its only additional commit is the merge of navya. Shared files have no diff.
- Existing tagged frame: exactly 3,201 bytes; byte 0 is mic=0 or system=1;
  bytes 1..3200 are 1,600 mono signed Int16 little-endian samples at 16 kHz.
  One frame represents 100 ms. Disabled sources must be rejected.
- Reuse src/shared/pcm.ts, the independent capture/worklet pipelines, WAV
  validation and sidecar/engine.py. Preserve Phase 1 diagnostics and tests.
- The selected English baseline is faster-whisper base.en, CPU INT8, four threads.
  Existing load/lock/cache behavior is reusable; the WAV-only inference method
  needs an additional in-memory word-timestamp method in a later stage.
- At the Stage 0 inspection, no server, streaming VAD, LocalAgreement, process
  manager or replay executable existed. Stage 2 now adds the server. harness
  still has documentation and an empty fixtures directory.
- Existing renderer path: main sends event:transcript-segment; preload validates
  TranscriptSegment; onTranscript replaces the row with the same id.
- Latest visible Developer A commit is 9892b7a. Ownership/dependency surfaces:
  src/main/index.ts, src/preload/index.ts, src/renderer/**, shared contracts and
  packaging. Unpushed changes on another developer's machine are not visible.

## Approved shared protocol

Implement the authoritative wire definitions in src/shared/schemas.ts and infer
TypeScript types in src/shared/contracts.ts. Do not hand-maintain duplicate TS
types. Python validation must conform to the approved wire schema; shared JSON
fixtures will test both implementations against the same valid/invalid payloads.
Protocol version 1 is the first implemented server protocol; Phase 1's proposed
wire shapes were never connected to a server. Its strict Zod objects will need
coordinated producer/consumer updates, not a claim of old-client compatibility.

### 1. Config and authentication

Retain all existing sidecarConfigSchema fields:
type=config, token, sampleRate=16000, channels=1, encoding=pcm_s16le,
frameMs=100, model, language. Add these required fields:

| Field | Validation / meaning |
| --- | --- |
| protocolVersion | Literal 1; reject unsupported versions |
| sessionId | UUID generated for one recording session by main |
| generation | Nonnegative safe integer; increases on process restart |
| enabledSources | Unique, nonempty array of existing mic/system values |

Bound text lengths and reject unknown fields. Restrict supported model names in
the Python runtime to the existing base.en/small engine support; preserve the
shared model string's extensibility and return UNSUPPORTED_MODEL for other names.
Use the measured base.en English configuration by default.

Main creates a fresh 32-byte cryptographic token encoded as 64 hexadecimal
characters for every sidecar generation. Pass its value through child environment
or stdin, never argv or URL. Send it in the first JSON config message. No token,
raw config, audio, transcript or sensitive path is logged. Compare tokens in
constant time. Reject config before accepting any binary audio. Validate the
session/generation against the process's expected values supplied at launch.

Only one authenticated connection may own the generation. Authentication must
finish within 10 seconds of connection; token admission expires 30 seconds after
the listening handshake. A valid session does not expire mid-recording merely
because that admission deadline passes. Consumed tokens cannot admit another
socket. Stop, disconnect or process death revokes ownership and token validity.
Recovery launches a new generation with a new token; old sockets are rejected.

### 2. Transcript events and stable identity

Retain type=partial/final, source, text, startMs, endMs. Add required sessionId,
generation and id to both variants. id is an opaque immutable identifier for one
pending transcript chunk. Its revisions and corresponding final reuse that id;
the next chunk gets a new id. Never derive identity from mutable word timestamps.
Use source- and generation-qualified IDs to prevent collisions.

The manager validates sidecarEventSchema before producing the existing
TranscriptSegment, which stays unchanged:

| TranscriptSegment field | Mapping |
| --- | --- |
| id | Approved sidecar event id |
| meetingId | Recording owner's meeting identity retained by main |
| source, text, startMs, endMs | Validated sidecar values |
| speakerId | null until an agreed speaker policy exists |
| isFinal | event.type === final |

Reject events for inactive sessions/generations. Require nonnegative integer
milliseconds, endMs >= startMs and consistent ordering per source. Final chunks
are immutable and emitted once; partial events revise only the pending chunk.
Stable-prefix commits can finalize a chunk and create a new partial chunk for its
remaining suffix. On generation interruption, notify the existing engine-status
path so Developer A can discard that generation's provisional rows while keeping
final rows. This renderer behavior needs their agreement; no overlay is built here.

### 3. Status and error events

Retain the existing status values loading, ready and stopped. Extend the enum to:
starting, loading, warming-up, ready, listening, processing, restarting, error,
stopped. loading means model loading; these are engine statuses, not a second
RecordingState. Add required sessionId and generation to all status events.

Optional status requestId acknowledges the matching lifecycle/health request.
Optional numeric metrics contain source, inferenceMs, queueWaitMs, queueDepth
and droppedSamples for a completed inference pass or buffering report; timing
fields are optional when no pass has completed. Values are finite/nonnegative,
queue/sample counts are integers. Metrics contain no text or audio.

Error shape becomes:
type=error, code, message, recoverable, sessionId, generation. Session identity
may be null only before authentication has established a session. Main supplies
its known launch context when reporting startup failures. Never echo attacker-
supplied config, tokens, backend exceptions or sensitive paths in error messages.
Error codes include AUTH_FAILED, AUTH_EXPIRED, INVALID_CONFIG, INVALID_FRAME,
SOURCE_DISABLED, NOT_READY, MODEL_LOAD_FAILED, WARMUP_FAILED, AUDIO_DROPPED,
SIDECAR_DISCONNECTED, RESTART_LIMIT and STOP_TIMEOUT.

No extra renderer event system: use existing event:engine-status and event:error.
Developer A owns how those events affect their UI and recording state.

### 4. Control messages and acknowledgements

Add an executable sidecarControlSchema, not informal unchecked JSON. Every
control carries sessionId, generation and a unique requestId. Proposed variants:

| type | Additional fields | Behavior |
| --- | --- | --- |
| source-start | source, startSample | Anchor a source's first received frame on the common session sample timeline |
| source-gap | source, startSample, droppedSamples | Explicit discontinuity; clear crossing provisional/VAD context and advance to the next actual sample position |
| source-end | source, paddedSamples | Source has ended; trim the final frame's 0..1599 synthetic samples, flush remaining speech |
| pause | none | Stop accepting audio, invalidate in-flight partial results and clear provisional/VAD buffers; retain committed context |
| resume | none | Keep the session; accept new source anchors before further frames |
| stop | none | Stop audio ingress, finalize pending speech, emit finals followed by stopped acknowledgement |
| ping | none | Reply with current truthful status and the matching requestId |

Ordered WebSocket delivery preserves controls relative to binary frames.
Controls have explicit field validation and legal-phase checks. Acknowledgements
use the existing status variant with requestId, not an additional event category.
Pause acknowledgement follows invalidation of pre-pause inference results;
resume cannot emit stale queued audio. Normal stop drains finalization before
closing the socket. Disconnect cancels pending work and frees buffers; a lost
socket cannot receive a guaranteed final flush, so report interruption honestly.
Health checks must remain responsive while the single inference worker is busy.

### 5. PCM callback and time mapping

Clarify AudioSource.onFrame's pcm as exactly 3,200 UNTAGGED bytes, since source is
already a separate argument. The adapter prefixes it once for the WebSocket.
Phase 1 CaptureBridge continues to carry already tagged ArrayBuffers unchanged.

An optional third AudioSource callback argument is inferred from the new
audioFrameMetadataSchema: {startSample: nonnegative safe integer}. It identifies
the first real sample of that frame on the session timeline. Require metadata
for the new live adapter; existing Phase 1 callers remain valid without it.
Use the same inferred AudioFrameMetadata type as an optional second argument to
CaptureBridge.frame(frame, metadata?). This lets capture send measured timing
through the existing capture:frame IPC rather than estimating it in main.
The existing tagged frame bytes, ready/finished/onStop signatures and Phase 1
calls without metadata remain valid. Validate metadata in preload and main;
bind the sender to the active recording/source so stale capture windows cannot
submit new-session frames. The live adapter's measured clock/start handoff must
be agreed with Developer A before wiring capture into their recording flow.

Main's session clock is monotonic. Source timestamps include measured acquisition
offsets and pause time. Source-relative sample count alone cannot establish those
offsets. The live adapter supplies measured session anchors; do not infer an exact
capture time from IPC arrival time. Warm-up time precedes capture and does not
become fake audio. Convert sample positions to integer milliseconds consistently
only at the transcript boundary. source-start/gap controls transport anchors
without changing the binary frame layout. Pauses/resumes and dropped/restarted
audio are discontinuities, not compressed time or unreported silence.

At source-end, hold the latest frame until its padding is known; process every
earlier frame immediately. This adds at most one frame of buffering and avoids
transcribing the final zero padding. source-end is ordered after the last frame.
source-gap and pause similarly resolve or discard the held tail explicitly.

### 6. Main/preload integration surface

Developer B's main-only manager exposes start(sessionId, meetingId, config),
sendFrame(source, pcm, metadata), sourceEnd(source, paddedSamples), pause(),
resume() and stop(), plus callbacks for validated transcript/status/error events.
These are process/session transport APIs, not another recording state machine.
Developer A's existing owner checks consent and recording state before start or
frame forwarding. Manager readiness is an additional required gate, never a
substitute for consent.

Approved optional additions to DesktopApi preserve fixture methods:
onEngineStatus(listener) and onError(listener), both returning unsubscribe.
Their payload types derive from the approved status/error schemas. Lifecycle
request shapes use a shared sessionId envelope on the already declared
recording:start/pause/resume/stop channels. Developer A retains ownership of
those handlers and their public start/consent flow; do not install competing
handlers or add a renderer recording API before agreeing that flow.

Dependencies for Developer A: session-to-meeting mapping; per-source clock
metadata; readiness/consent gating; status/error subscriptions; invalidation of
provisional rows after generation failure; pause/resume/stop acknowledgements.
TranscriptSegment, RecordingState, RecordingConfig and InsightsProvider remain
unchanged. No UI, tray, hotkey or consent implementation is included.

## Startup, limits and failure policy

Bind only 127.0.0.1 with port=0; report the actual bound port in one stdout JSON
line: {"protocolVersion":1,"port":52345,"state":"listening"}. The example port
is illustrative. Listening is transport availability, NOT model readiness.
Main connects on that line, authenticates, receives loading/warming-up events,
then receives ready only after model load and synthetic warm-up finish. No audio
is captured or saved for warm-up. Load and infer on the one model worker so the
socket event loop remains responsive.

Inbound WebSocket messages are bounded to 4,096 bytes. Binary messages must still
be exactly 3,201 bytes; validate source and enabled-source membership. Text messages
are bounded valid UTF-8 JSON objects with strict schemas. Reject malformed, empty,
short and oversized messages with safe errors/close codes; never unbounded parsing
or traceback output. Outgoing events have a 64 KiB bound and are validated in both
Python and Electron. Schema validation must not serialize bad payloads into logs.

One manager owns at most one child and one authenticated socket. Readiness and
health deadlines are failure bounds, not sleep-based startup guesses. Stage 7
will implement bounded exponential-backoff restarts, wait for old-child exit and
buffer only a small capped amount of audio. Report discarded frames/samples and
interrupted in-flight speech. A restarted generation must anchor retained frames
on the original timeline and avoid re-emitting committed chunks. This is bounded
in-memory recovery, not saved-session crash recovery or guaranteed lossless audio.

## Tests required after approval

- Shared valid/invalid config, event and control fixtures; strict Zod/Python parity.
- Unchanged 3,201-byte layout; invalid source, disabled source and size boundaries.
- Missing/wrong/expired/reused token; second client; stale session/generation.
- Listening versus warmed-ready distinction; model/warm-up failure sanitization.
- Identity preserved across partial revisions/final; duplicate/final replay guard.
- Common-source offsets, pause gaps, final padding and discontinuities.
- Lifecycle control validation, acknowledgements, disconnect and resource cleanup.
- No runtime logs containing tokens, audio, transcripts or sensitive paths.
- Preserve all Phase 1 tests; the prior Stage 0 baseline was 69 TypeScript tests,
  40 Python tests, typecheck and production build passing.

## Latency methodology dependency

Replay each source in actual 100 ms intervals. Record send/emission times with
monotonic clocks in the harness, independently of audio-relative transcript times.
Verified per-word latency requires a private word-aligned reference for the input
audio and known-silence intervals. No such reference exists in the current
recordings. If model word timestamps are used for alignment, label the result
model-aligned estimates, not verified ground truth. Do not log transcript text
or adjust word times to improve latency. Persist numeric metrics only.

## Stage 1 checkpoint and approval

The Stage 1 checkpoint created this document as a proposal only; no runtime or
shared files were changed then. The user subsequently approved the proposed
contract changes and proceeding to Stage 2. Those approved schemas and boundary
subscriptions are now implemented alongside the transport. No recording flow,
overlay, hotkey, consent UI or second recording state machine was added.
Commands: branch/status, shared-file comparison with main, contract/preload/PCM
inspection, and git diff whitespace check. No stage implementation was exercised;
the Stage 0 test results above are historical baseline results, not a new run.
Status: **DONE** for the user-approved protocol. Developer A review and the live
capture timing/lifecycle handoff remain integration dependencies.

## Stage 2 checkpoint: implemented transport

- sidecar/server.py binds 127.0.0.1 on an OS-assigned port. One structured stdout
  line reports listening; it never prints a token or claims model readiness.
- First-message config authentication uses constant-time comparison, launch
  session/generation checks, deadlines, one owner and a single-use token.
  Disconnect/stop revokes ownership. Concurrent claims are tested over real TCP.
- sidecar/protocol.py validates config/control/outgoing events using
  sidecar/wire-schema.json, generated from the existing Zod definitions and PCM
  constants. Python explicitly enforces the two cross-field event refinements
  not expressible in JSON Schema. Both validators run the same shared fixtures.
- Binary parsing validates exact length, source identity and enabled sources.
  The server rejects valid audio with recoverable NOT_READY: there is no model,
  VAD or ingestion buffer at this stage, so no transcription success is implied.
- ping and stop work with correlated status acknowledgements. Audio lifecycle
  controls are schema-validated but return NOT_READY until their later stages.
  Session control tracking and socket queues are bounded.
- Stop/disconnect/context shutdown close sockets and revoke token/session state.
  The CLI exits when its owner ends or unclaimed admission expires. Missing
  dependencies/schema and other startup failures produce a fixed safe error,
  without traceback or private paths.
- Browser Origins and URL credential paths are rejected. Inbound messages are
  capped at 4,096 bytes, outgoing events at 64 KiB; compression is disabled.
- Preload adds validated subscriptions on existing status/error IPC channels.
  Optional frame timing is validated in preload/main; Phase 1 calls retain their
  original bytes and argument behavior. No main-side speech manager is wired.

Setup: install sidecar/requirements-phase2.txt into the project virtualenv.
The parent supplies VINXA_SIDECAR_TOKEN, VINXA_SIDECAR_SESSION_ID and
VINXA_SIDECAR_GENERATION through environment, then starts `python -m sidecar.server`.
Never put the token in shell arguments or a URL. This entry point is intended for
the future manager/harness; automated subprocess tests exercise it now.

After schema changes, use Node 24 to run
`node scripts/export-sidecar-schema.cjs`; commit the generated wire-schema.json.
`node scripts/export-sidecar-schema.cjs --check` verifies it without modifying it.
Node currently emits an experimental warning for its TypeScript transform API;
this is development export tooling, not a Python runtime requirement.

Actual final checks on this laptop:

| Command | Actual result |
| --- | --- |
| python -m pytest sidecar harness -q | 137 passed in 18.97 seconds; Phase 1 baseline 40 |
| pnpm test | 123 passed in 11 files; Phase 1 baseline 69 in nine files |
| pnpm typecheck | Passed |
| pnpm build | Passed: main, preload, capture and main renderer |
| python -m pip check | No broken requirements found |
| node scripts/export-sidecar-schema.cjs --check | Passed; generated artifact matches Zod and PCM constants |
| git diff --check | Passed |

The actual-process test started the Python module, validated its single stdout
listening line, authenticated over a real localhost socket, sent stop, received
stopped and observed exit 0 with no further stdout/stderr. Another subprocess
test omitted the bundled schema and verified a safe error without traceback.
Two initial test issues were resolved: revoke session state before beginning
the error close handshake; normalize Windows CRLF when asserting an otherwise
exact one-line stderr message. No tests were removed or validation weakened.

Files created: sidecar/{protocol,session,server,test_protocol,test_server}.py,
sidecar/requirements-phase2.txt, sidecar/wire-schema.json,
sidecar/fixtures/protocol.json, scripts/export-sidecar-schema.cjs,
src/shared/sidecar-protocol.test.ts, src/preload/index.test.ts and this document.
Files modified: src/shared/{schemas,contracts}.ts, src/preload/index.ts,
src/main/audio/capture-test.ts and its tests, sidecar/requirements.txt and
sidecar/README.md. No IPC channel name, renderer UI or recording-state owner changed.

Local commit plan, executed only after these checks:
1. feat(protocol): define authenticated sidecar wire contracts
   (shared schemas/types/fixtures, generated JSON Schema/export tooling,
   preload boundary and capture metadata validation/tests).
2. feat(sidecar): add authenticated localhost transport
   (Python protocol/session/server/tests, bounded dependencies and docs).

Status: **DONE** for Stage 2. Next stage is per-source Silero VAD; model readiness,
LocalAgreement, streaming, manager recovery and UI integration remain unimplemented.
No latency measurement, model warm-up, real microphone capture, installer build
or overlay integration is claimed by Stage 2.

Primary API references: [Zod JSON Schema export](https://zod.dev/json-schema),
[websockets asyncio server](https://websockets.readthedocs.io/en/stable/reference/asyncio/server.html),
[Python JSON Schema validation](https://python-jsonschema.readthedocs.io/en/stable/validate/).
