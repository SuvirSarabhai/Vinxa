# Phase 4 implementation and verification

28 November 2026

Phase 4 is implemented in the navya working tree. The unpacked Windows build passed the saved-meeting checks, a real local speech and notes cycle with synthetic microphone audio, and forced process termination followed by recovery. Physical device testing and the network-adapter-disabled acceptance run remain open.

## Implemented behavior

| Area | Result |
| --- | --- |
| Search | FTS5 across transcripts, summaries, decisions and actions, with accent and prefix matching, highlighted snippets, speaker labels and passage navigation. Newly generated notes carry validated transcript references. Older notes retain section navigation when a source is unavailable. |
| Export | Markdown and PDF through an escaped HTML template and Electron printToPDF, using native save dialogs. |
| Deletion | Confirmation explains local cleanup, exported copies, previously sent cloud text and storage erasure limits. Database and FTS cleanup, audio overwrite and unlink, managed-file cleanup, consent-receipt removal, WAL checkpoint and VACUUM are integrated. Failed cleanup retains a retry record. Deleting the current saved meeting also clears its session snapshot. |
| Settings | Local-only and cloud-notes choices, encrypted API-key storage, hotkeys, persistent request counters and installed speech-model selection. Speech-model changes apply after quitting and reopening Vinxa. |
| Network guard | External Electron requests are blocked in Local-only mode. Approved cloud notes use the guarded request path. The Python sidecar also restricts networking to loopback. |
| Deferred notes | Pending meetings are processed at startup and retried after provider outages. Retry delays increase to ten minutes and continue while the provider is unavailable. Invalid output and configuration errors retain an explicit failure state for manual correction. |
| Crash recovery | Recording, paused and stopping meetings become interrupted on launch. Recovery retains committed segments, repairs supported WAV headers, preserves warnings and queues notes immediately. |
| Disk space | Startup and periodic recording checks show low-space warnings based on the enabled PCM sources. |
| Device changes | Microphone loss warns and preserves system capture. Pause and resume reconnects capture, with a replacement microphone selectable while paused. Default-output changes show a warning and reconnection instructions. |

Migration 4 adds saved note references and restores pending status for meetings stopped by the earlier three-attempt retry limit. Provider prompts use short references, and the notes service resolves them back to original segment IDs after validation.

## Verification

- TypeScript typecheck passed.
- The TypeScript suite passed 257 tests, with two real-sidecar tests skipped by their existing opt-in condition.
- The Python sidecar and harness suite passed 213 tests.
- The Windows unpacked app matched the current compiled main process.
- electron-builder completed both the Windows NSIS installer and portable executable in release.
- The packaged saved-meeting smoke passed search navigation, all indexed categories, cited summary navigation, Markdown and PDF saves, HTTP and HTTPS blocking, deletion cancellation and completion, interrupted-meeting recovery, persisted counters and settings.
- The packaged live smoke used Windows-generated speech through Chromium's simulated microphone, the bundled Whisper sidecar and installed llama3:latest through local Ollama. Recording, pause and resume, notes, restart persistence, cited search, both exports, deletion and consent-receipt cleanup passed.
- The packaged crash smoke terminated the isolated process tree during recording. On restart, recovery preserved committed transcript text, repaired the audio length and completed local notes generation.

Machine-readable evidence is stored in release/phase4-packaged/report.json, release/phase4-live/live-report.json and release/phase4-live-recovery/live-report.json. Run pnpm smoke:phase4 --packaged for saved-meeting checks. Set VINXA_SMOKE_NOTES_MODEL to an installed local model and run node scripts/smoke-live-ui.cjs --packaged for the capture cycle, or add --crash for recovery.

## Acceptance limits

Wi-Fi remained connected at the user's request. Packaged live tests used an unavailable external proxy with loopback bypass in addition to the application guard. The network-adapter-disabled run remains unverified. Physical microphone unplugging, default-output switching, a real dual-source call and a clean-machine installation also require acceptance testing. Automated device-change tests passed.

The live notes check used a short synthetic recording. The earlier ten-minute local-notes performance gate remains open. Existing notes without source references can be regenerated to enable cited transcript navigation.
