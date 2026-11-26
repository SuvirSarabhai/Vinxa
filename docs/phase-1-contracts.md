# Phase 1 contracts and handoff

The parallel-build plan is the working plan. Developer A owns the desktop shell,
shared contracts, fixture player, and installer smoke test. Developer B leads the
Phase 1 checkpoint and owns dual-source capture and the speech-model benchmark.

These contracts are proposed for Developer B's review. Agreement and merging are
still team tasks; a local implementation does not imply approval by the other developer.

## Shared modules

- `src/shared/contracts.ts`: inferred TypeScript types, DesktopApi, AudioSource, InsightsProvider.
- `src/shared/schemas.ts`: executable Zod validation at process boundaries.
- `src/shared/ipc-channels.ts`: fixed channel names; only the fixture channels are wired in Phase 1.

TranscriptSegment carries `id`, `meetingId`, `source` (`mic` or `system`),
`speakerId` (nullable), `text`, `startMs`, `endMs`, and `isFinal`.
Times are nonnegative integer milliseconds relative to session start; end must not precede start.
Partial and final updates for one utterance retain the same segment id. The UI replaces
that segment by id instead of appending duplicates.

MeetingInsights carries `summary`, decisions (`text`, `atMs`), and action items
(`task`, `owner`, `due`, `status`). Unknown owners and dates must be explicit nulls.
Status is `pending` or `done`. Rename-speaker and persistence are Phase 3 work.

RecordingConfig carries `title`, `microphoneEnabled`, `systemAudioEnabled`, and
nullable `microphoneDeviceId`. At least one source is required. Recording states are
`idle`, `awaiting-consent`, `recording`, `paused`, `stopping`, `processing`,
`completed`, `interrupted`, and `error`. State-transition enforcement and consent
are Phase 2 work; schemas alone do not enforce consent.

## Sidecar protocol proposal

Use a random localhost port and per-session token. The first JSON message follows
sidecarConfigSchema: `type: config`, token, `sampleRate: 16000`, `channels: 1`,
`encoding: pcm_s16le`, `frameMs: 100`, model, and nullable language.
Each binary frame contains one source byte (0 = microphone, 1 = system), followed by
3,200 bytes of signed little-endian PCM (1,600 mono samples).
Sidecar events are partial/final text with source, text, startMs, endMs;
status (`loading`, `ready`, `stopped`); or error with code and message.
The Electron adapter will assign stable utterance ids and meeting ids and map event
type to isFinal before publishing a TranscriptSegment. Repeated partial/final updates
for one utterance must preserve its startMs to support that adapter.

Developer B's audio diagnostic uses one hidden capture page per source and the preload bridge.
Its channels are capture:ready, capture:frame, capture:finished, and capture:stop.
Frames use the byte layout above. capture:frame is acknowledged after the WAV write.
capture:finished carries a nullable error and the final frame's zero-padding count.
Each frame sender is bound to its own source ID and WAV writer. A capture window
selects its pipeline through the validated source query parameter. Modes are mic,
system and both; system requests Chromium loopback and immediately stops its video track.
See phase1-audio-capture.md for implementation status and checks.
No sidecar server is implemented in Phase 1.
Database schema and repositories remain Phase 3 work under Developer A.

The proposed table definitions from the plan are frozen for review here; SQL
migrations and repository implementations follow in Phase 3:

| Table | Columns |
| --- | --- |
| meetings | id, title, started_at_utc, ended_at_utc, duration_ms, state, engine, model, language, audio_dir |
| segments | id, meeting_id, source, speaker_id, text, start_ms, end_ms |
| segments_fts | External-content FTS5 index over segments |
| speakers | id, meeting_id, label, display_name |
| insights | meeting_id, summary, status, generated_by, generated_at |
| decisions | id, meeting_id, text, at_ms |
| action_items | id, meeting_id, task, owner, due, status |
| bookmarks | id, meeting_id, at_ms, note |
| consent_events | id, meeting_id, confirmed_at_utc, statement_version, announcement_copied |
| settings | key, value |

Store absolute dates in UTC and transcript offsets in milliseconds. Keep audio
as separate per-source WAV files, referenced by meeting audio_dir. FTS indexing
of summaries, decisions, and actions must also be implemented in Phase 3/4;
segments_fts alone will not satisfy the full search requirement.

## Fixture player

Play sample runs a short in-memory conversation through Electron main, a narrow
preload bridge, and React. Pause sample preserves the remaining delay; Reset sample
cancels pending events and clears the display. You and Remote labels derive from
the source. The fixture status is independent of the recording state.
No audio file, model, Python environment, permissions, or network service is needed.
Closing the window hides it; it does not reset the sample. Quit ends playback.

## Shell and packaging

Start, Pause, and Stop are present but disabled until the Phase 2 recording service
and consent flow exist. Open Library restores the current shell window. Quit exits.
Launching a second copy restores the first window. The tray uses a temporary V icon
generated by `pnpm icons`; the icon source generator is committed.

The Phase 1 package includes the shell and icon only. Add the sidecar and model
resources when those artifacts exist. It must not be described as an offline speech build yet.
The repository's existing MIT declaration is backed by the root LICENSE file.

## Completion checks

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm package:win`.
In the packaged app: play the sample, observe partial replacement and both speakers,
pause/resume/reset, close to tray, reopen, launch a second copy, then quit.
The installer can be tested locally; a clean Windows machine test remains a separate check.
Run `pnpm smoke:win "D:\path\to\Vinxa Desktop.exe"` for the automated packaged-app check.
Developer B supplies two clean real-call WAV files and a model timing result before
the joint Phase 1 gate passes.
