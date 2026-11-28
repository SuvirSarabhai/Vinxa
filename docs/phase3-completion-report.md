# Phase 3 completion report

Date — 28 November 2026  
Checkout — D:\vinxa\Vinxa  
Branch — navya  
Starting commit — a67bfad

**Phase 3 is ready for acceptance testing, with explicit open gates below. It is not signed off for release.** The production path now records, persists final text and separate audio, drains on Stop, generates validated notes, and restores meetings in the Library after restarting Electron. A short live local-speech/Ollama/restart test passed. Both installed LLMs timed out on the ten-minute benchmark at the default deadline. Live OpenAI and a fresh packaged Phase 3 physical-call check remain unverified.

## Starting state and scope

The existing implementation already had source-aware transcript and insights schemas, the RecordingBackend interface, consent/controller/hotkeys, the real speech service and bridge, capture windows, a diagnostic WAV header helper, and an explicit demo mode. These were reused. There was no production meeting repository or secure notes-key store to extend. better-sqlite3 was already a runtime dependency; only its TypeScript definitions were added.

Actual baseline results were **205 TS passed, 1 failed, 2 skipped** and **201 Python passed**, with typecheck passing. The TS failure was the native-16-kHz PCM immediate-frame assertion, caused by a pre-existing uncommitted change in src/shared/pcm.ts. That file was preserved in ignored tmp/pcm-before-phase3.ts. The native-rate branch was restored without weakening the test; the user's other formatting changes remain.

No reset, lockfile deletion, commit, push, model download, real OpenAI request, or private-call upload was performed for Phase 3. The existing navya checkout was reused. Phase 4 and 5 features remain out of scope.

## Implementation map

| Area | Files |
| --- | --- |
| Shared contracts and runtime schemas | src/shared/meetings.ts, meetings.test.ts, phase2.ts, ipc-channels.ts |
| SQLite and FTS | src/main/db/migrations.ts, repository.ts, repository.test.ts |
| Audio persistence | src/main/audio/spool.ts, spool.test.ts, recording-capture.ts |
| Stop integration | src/main/persistent-recording-backend.ts and test, session-controller.ts, speech-backend.ts, phase2.ts |
| Notes | src/main/insights/{http,ollama,openai,settings,prompts,chunking,service,meeting-notes}.ts and tests |
| Renderer bridge | src/main/meetings.ts, src/preload/meetings.ts and test, preload/index.ts, renderer/src/env.d.ts |
| Saved-meeting UI | renderer/src/ui/{SavedMeetings,NotesSettings,Library,Settings,Setup}.tsx, styles.css |
| Echo dedup | sidecar/dedup.py, test_dedup.py, streaming.py, test_streaming.py |
| Repeatable verification | scripts/{register-typescript,benchmark-notes,smoke-phase3}.cjs, scripts/fixtures/notes-ten-minutes.cjs; extended smoke-live-ui.cjs and configurable smoke-ui.cjs test hotkeys |
| Setup and documentation | README.md, package.json, pnpm-lock.yaml, .gitignore, this report, phase3-notes-benchmark.md |

The existing MeetingInsights schema remains authoritative. No second speech service, transcript pipeline, or database path was introduced. No new any casts were used to bypass type errors.

## Database and persistence

All production storage is beneath Electron app.getPath('userData'), never the repository or development virtual environment. In a standard Windows installation this is the application's directory under %APPDATA%; the development and installed app names may give different profile names. Smoke scripts use an explicitly isolated temporary profile.

- meetings.sqlite3 stores meetings and notes. SQLite WAL, secure_delete, foreign keys, prepared parameterized statements, and transactions are enabled.
- Migration 1 creates meetings, transcript_segments, meeting_notes, decisions, action_items, speakers, settings, and timeline/action indexes.
- Migration 2 adds an external-content FTS5 index, prefix lengths 2/3/4, Unicode accent-insensitive tokenization, insert/update/delete triggers, and initial rebuilding.
- schema_migrations tracks ordered versions. Each migration and its version record commit together. A failed migration rolls back without dropping existing user data. A database from a newer application version is rejected.
- Final, nonempty segments are persisted immediately. The composite meetingId/id identity makes repeated delivery idempotent. Conflicting repeated finals fail visibly. Partials and empty cancellation finals are never saved.
- Timeline reads sort by startMs, endMs, and id. Once recording has entered processing/completed, unseen late segments are rejected. Exact already-stored duplicates remain safe.
- Notes replacement is transactional. Invalid regeneration leaves previous valid notes intact. Existing action IDs and the user's pending/done choice survive regeneration when task, owner, and due match exactly.
- Custom speaker names are separate rows. Original source identities and transcript text do not change. Library totals and pending-action counts come from database queries.

FTS is backend infrastructure only. No search UI, export, or deletion workflow was added. Raw meeting databases, WAVs, model files, and keys are ignored by Git.

## Audio files and lifecycle

Each UUID meeting directory contains:

```text
<userData>/meetings/<meeting-id>/
  microphone.wav   # only if microphone was enabled
  system.wav       # only if system audio was enabled
  metadata.json
```

Both sources use 16000 Hz, one channel, signed 16-bit little-endian PCM, in separate RIFF WAV files. Files are created exclusively and cannot overwrite another meeting. Frames append through a per-source queue. Positional writes preserve initial offsets and pause gaps as silence; end padding is trimmed. Metadata distinguishes timeline samples from captured samples.

Capture IPC acknowledges frames after their spool writes. Stop drains capture and speech, saves the final transcript callbacks, finalizes/syncs/closes both audio files, reloads the full transcript, generates and saves notes, then marks the meeting/controller completed. While notes are pending in-flight the recording status is processing. Duplicate Stop calls share the operation; shutdown awaits it. Enabled-but-empty WAVs have valid empty headers. Disabled sources have null database paths.

Write failures are reported and other sources are still finalized. A retained partial recording is marked error and notes stay pending if speech/audio finalization failed. Provider failures leave completed recordings and audio intact, with notes pending or failed. A notes persistence failure is surfaced and does not silently declare completion.

## Speakers and echo dedup

Speaker identity comes only from source — mic maps to You/you, system to Remote/remote. This is source identification, not speaker diarization.

EchoDeduplicator retains at most 128 recent system finals. It applies Unicode NFKC normalization, case folding, and tokenization. Candidate mic finals must have both start and end within 2000 ms of a system final and the same token count. Exact matches need at least four tokens. Approximate matches need at least eight tokens and similarity of at least 0.94.

Short replies, expanded replies such as “Yes, I agree, let's continue,” different-time repetitions, and mic text already committed are retained. System partials cannot suppress a mic final. Mic partials remain provisional; suppression emits the existing empty-final cancellation for that ID. Audio is never altered. Diagnostics record reasons without transcript text.

Limits — different ASR wording or chunk boundaries can leave echo. A system final arriving after the mic final cannot remove committed text. Simultaneous genuine long verbatim repetition may resemble echo. Headphones and a real dual-source call remain part of acceptance.

## Notes, privacy, and configuration

Ollama uses only the fixed loopback endpoint on port 11434. Model availability is checked before each generation request; remote/cloud model aliases are rejected using the model metadata/name. There is no automatic download or cloud fallback. Missing service/model yields a saved meeting with Notes pending and a visible explanation.

OpenAI requires both the provider selection and the explicit transcript-sharing checkbox. The opt-in is checked again before every request. Text prompts and derived text notes use the Responses API with a strict JSON schema and store:false; there are no audio fields. API keys use Electron safeStorage, are encrypted before database writes, are never returned to the renderer after saving, and can be cleared in Settings. Encryption unavailability blocks key storage. Tests exercise this boundary with mocked OS encryption; no real credential was supplied.

The implementation follows the [Ollama API schema](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml) and [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses/create).

For local acceptance, start Ollama, run ollama list, enter llama3:latest in Settings → Meeting notes, leave Ollama selected, set timeout to 300 seconds, and save. This setting passed the short live integration check. No default model is silently selected. The [README](../README.md) has complete setup instructions.

Prompts require evidence, supported original timestamps, actual commitments, null unknown owners/dates, and empty lists instead of guesses. Chunks retain full segments, chronological order, source labels and original timestamps. Chunk size is configurable, with 6000 characters as the default. A single segment may exceed this soft limit. Pairwise consolidation retains odd final groups and de-duplicates final decisions/actions. An empty transcript produces explicitly empty notes without a provider call.

Every returned envelope and notes value is validated. Invalid JSON, shape, or unsupported decision timestamps gets exactly one correction attempt containing the validation error. A second invalid response becomes a controlled failure, with no malformed notes persisted. Network, key, rate-limit and timeout errors are controlled failures without automatic validation retries. Regeneration never deletes the recording.

Schema validation cannot establish factual truth. Review summaries, commitments, owners and dates against the transcript. The live Mistral warm-up produced unsupported agenda actions; this is documented, not hidden by the successful schema result.

## Actual verification

Final verification ran after the implementation fixes.

| Command/check | Actual result |
| --- | --- |
| pnpm test, with VINXA_RUN_SIDECAR_SMOKE=1 | **PASS — 246 tests in 33 files, zero skips** |
| .venv\Scripts\python.exe -m pytest sidecar harness -q | **PASS — 206 tests** |
| pnpm typecheck | **PASS** |
| pnpm build | **PASS** |
| node scripts/export-sidecar-schema.cjs --check | **PASS** |
| pnpm exec vitest run src/main/db/repository.test.ts | **PASS — 5 tests**, including v1-to-v2 upgrade, rollback, restart and FTS consistency |
| git diff --check | **PASS** |
| node scripts/smoke-phase3.cjs | **PASS — real Electron/SQLite, seeded notes explicitly labelled mock** |
| pnpm smoke:ui | **PASS — 10 checks, no renderer errors or HTTP/CDN requests** |
| VINXA_SMOKE_NOTES_MODEL=llama3:latest, node scripts/smoke-live-ui.cjs | **PASS — real Whisper and live Ollama, synthetic microphone, restart** |

The normal TS command leaves two opt-in sidecar tests skipped. They were explicitly enabled in the final run and both passed, including actual warm-up, process restart, and model reuse. Node emitted its experimental TypeScript-loader notice and Vite emitted an existing config-loader warning; commands exited successfully.

The demo smoke initially encountered Ctrl+Alt+7 owned by another running application. The script now accepts VINXA_SMOKE_HOTKEYS, preserving all assertions. The final run used valid Ctrl+Alt+J/K/L bindings, exercised native registration and persistence, and left the user's application settings untouched. An intermediate test-only Shift binding was rejected by the existing accelerator schema; the successful rerun used the supported format.

Real Electron Library verification loaded SQLite records, renamed the meeting and Remote to Client, marked an action done, restarted Electron, and verified the same transcript, summary, decisions, action status, speaker name, WAV headers, and statistics. Missing-model regeneration preserved the previous notes. Artifacts are under release/phase3-ui/.

The live local-speech test used Windows-synthesized speech through Chromium's simulated microphone, the existing AudioWorklet/IPC/Whisper pipeline, and live llama3:latest. First visible text was 2589 ms after confirmation, three Pause/Resume cycles passed, four final segments were saved, notes completed, and restart returned the same meeting detail. This is **not** physical-microphone latency or a dual-source call measurement. Report — release/stitch-ui/live-report.json.

Separate-source WAV output was tested with real files/SQLite and controlled PCM frames. The live speech test used microphone only; fresh real system-loopback capture and acoustic echo evaluation remain manual gates.

## Benchmark and remaining issues

The [benchmark report](phase3-notes-benchmark.md) contains real model comparisons, load/warm-up times, memory, raw artifact location, reproducible commands, and limits.

- **FAIL — ten-minute performance at defaults.** Mistral timed out at 180.043 s and Llama 3 at 180.024 s on the first 6000-character chunk. Neither reached consolidation. Full-workload tokens are unavailable. Mocked consolidation tests pass but do not certify live consolidation quality/performance.
- **PASS — short local notes integration.** Llama 3 completed the short recording test with a 300-second deadline.
- **BLOCKED — live OpenAI.** No explicit real-cloud test opt-in or key was supplied. Mock HTTP tests cover success, invalid key, disabled cloud, text-only payload, timeouts, invalid output and retry.
- **PASS — Phase 3 package build.** On 28 November 2026, `corepack pnpm package:win` created `release/Vinxa Desktop-0.1.0-setup.exe` and `release/Vinxa Desktop-0.1.0-portable.exe`. The package script was changed to call its Node helper and local build binaries directly because plain `pnpm` was absent from the user's shell PATH. The unpacked packaged app loaded and warmed the bundled `base.en` model in `scripts/smoke-speech.cjs`.
- **BLOCKED — packaged Phase 3 acceptance.** The new installer has not been installed and tested. The portable executable's direct Playwright launch timed out after 30 seconds, so portable startup remains unverified. Neither new package has completed an offline recording/notes/restart check. The previously installed executable is still the earlier Phase 2 build.
- **BLOCKED — fresh physical call and acoustic echo sign-off.** Synthetic tests cannot establish real device stability, human recognition quality or the user's reported dual-source delay.

No deferred notes queue, crash recovery, disk warning UI, device-change recovery, encryption of meeting contents, search/export/delete UI, or Phase 5 functionality was added. Notes requests may take several minutes, especially on CPU. RIFF WAV size limits are detected and reported. Exact task matching preserves completed status during regeneration; paraphrased tasks may receive a new ID.

## Outstanding Phase 2 gates

The earlier local report release/phase2-validation-20261128-141124/report.json records successful installer and portable builds and synthetic transcription in online/offline packaged runs with the bundled runtime/model. That evidence applies to the earlier package, not these Phase 3 changes.

The user reported trying a call, but the complete physical-call checklist has no recorded sign-off. Real dual-source first-word latency was reported around ten seconds, microphone interruption had been observed, and native title-bar X behavior remains separately tracked. This task does not claim those issues were fixed. The user explicitly requested continuing Phase 3, so the older documentation's pause-at-Phase-2 gate was treated as outstanding validation rather than a reason to stop implementation.

## Acceptance checklist

| Area | Status | Evidence / limit |
| --- | --- | --- |
| Database | **PASS** | Init, ordered transactional migrations, WAL/secure_delete/FKs, incremental finals, duplicate handling, FTS5 and restart |
| Audio | **PASS** | Separate valid finalized WAVs, exact sample/padding tests, empty sources and injected file-write rejection; physical dual-source call still BLOCKED |
| Speakers | **PASS** | Source mapping, conservative dedup and genuine reply tests, streaming cancellation; acoustic field validation still BLOCKED |
| AI notes | **PASS** implementation; **FAIL** long benchmark; **BLOCKED** live OpenAI | Live short Ollama success, mocked OpenAI opt-in/privacy and errors, chunks/consolidation, validation, one retry, pending behavior |
| UI | **PASS** | Real Electron Library/detail/rename/actions/speakers/stats and restart |
| Integration | **PASS** automated and package build; **BLOCKED** fresh packaged real call | Stop waits for persistence/notes, final transcript used, failures retained, restart exact match, unpacked packaged speech warm-up, Phase 2 automated tests intact |
| Quality | **PASS** | 246 TS, 206 Python, typecheck, build, schema/migration checks, docs |

**Ready for acceptance testing — yes. Ready for release sign-off — no**, until long-meeting notes performance/quality and the outstanding live/package gates are resolved.
