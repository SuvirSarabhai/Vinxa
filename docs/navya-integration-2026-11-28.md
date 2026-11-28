# Local integration of navya — 28 November 2026

Fetched `origin/navya` and fast-forwarded the local `suvir` branch from `a6728f3`
to `5cb95f0`. Incoming work includes `a67bfad` (cached-model packaging correction)
and `5cb95f0` (meeting persistence and Phase 4 workflows).

The four existing native-overlay edits were saved before the update and applied
afterwards without conflicts. The backup is retained as stash
`98941c19b9ebf615be936ee7e16bd8dbc90cb9af`. Native Minimize/Maximize/Close,
content-aware compact sizing, explicit reopening and overlay smoke additions
are preserved alongside the incoming persistence, notes and settings changes.
Nothing was pushed. No installation, build, test, model or audio command was run
for this integration. Whitespace and unresolved-merge checks passed.

## Incoming implementation

- SQLite migrations, final-segment persistence, separate per-source WAV storage,
  saved-meeting listing/details, rename, speaker names and action completion.
- Ollama notes and explicitly enabled OpenAI notes, structured-output validation,
  chunk/consolidate processing, encrypted key storage and pending-notes retry.
- Source-based microphone echo deduplication; this is not multi-person diarization.
- FTS5 search across transcripts and notes, result snippets and passage navigation.
- Markdown/PDF export and confirmed deletion with database/search/file cleanup.
- Local-only request blocking and counters, interrupted-meeting recovery,
  low-disk warnings, device-change handling and replacement microphone selection
  while paused. Speech-model selection applies after restart.
- Cached speech-model packaging no longer requires optional snapshot files.

The incoming developer reports describe tests in another checkout. They do not
certify this combined checkout. Physical device changes, real two-source calls,
network-adapter-disabled operation, clean-machine installation and long-meeting
notes performance remain acceptance work. The ten-minute notes benchmark timed
out at the default deadline; a short notes test is not equivalent.

## Commands for the user

Quit existing Vinxa instances from the tray. Reuse the existing Python environment
and cached speech model. Run commands one at a time and resolve errors before
continuing:

```powershell
cd "D:\Python Workspace\Vinxa"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
.\.venv\Scripts\python.exe -m pytest sidecar harness -q
pnpm build
pnpm smoke:ui
pnpm smoke:phase3
pnpm smoke:phase4
```

Dependencies now include `@types/better-sqlite3`. SQLite is used at normal startup,
so native-binding compatibility matters. If a NODE_MODULE_VERSION error appears,
retain its complete text: Node-based tests and Electron may require different
native builds. Node 24.13+ is required for the incoming script loader.

For local notes, start Ollama and use `ollama list` to find an installed model.
Enter its exact name in Settings → Meeting notes, keep Ollama/local-only selected,
and save. A missing provider/model should leave the meeting saved with notes
pending. No API key is needed for local notes. Do not enable cloud sharing just
to test persistence.

```powershell
$env:VINXA_BACKEND = 'local'
pnpm dev
```

## Manual acceptance sequence

1. Record a short microphone-only session containing a clear decision and action.
   Pause, speak a phrase while paused, resume, then Stop. Check final text, source
   labels, audio files and saved-meeting status. Paused speech must be absent.
2. Quit and reopen. Open Library and verify the same meeting and transcript.
   Rename the meeting/speaker, toggle an action done, restart and verify retention.
3. With an installed Ollama model configured, generate notes. Check their claims
   against the transcript. Without Ollama, verify saved data survives and notes
   remain pending; retry after the provider becomes available.
4. Search a known phrase, click its result, check the highlighted passage; export
   Markdown and PDF and open both files. Test deletion only on a throwaway meeting:
   Cancel retains it; confirmed deletion removes it from Library and search.
5. Check the native overlay controls in expanded/compact modes. X and Minimize
   affect only the overlay; Show overlay restores it; Stop ends recording.
6. With headphones, run a real microphone + system-audio call, then check offline
   operation and device changes. Check recoverable interruptions using a disposable
   meeting/profile; keep normal meeting data out of fault-injection tests.

Optional synthetic full-pipeline test after local notes are configured:

```powershell
$env:VINXA_SMOKE_NOTES_MODEL = 'your-installed-model-name'
pnpm smoke:ui:live
Remove-Item Env:VINXA_SMOKE_NOTES_MODEL
```

This test uses generated speech and an isolated profile, not the physical mic.
