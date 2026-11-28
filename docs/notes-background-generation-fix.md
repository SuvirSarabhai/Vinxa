# Notes generation and transcript availability

Follow-up implementation, 28 November 2026. Build and tests are user-run.

Previously Stop awaited LLM generation, so the recording remained processing for
minutes. Export's global operation lock also rejected requests while any notes
job ran, and manual notes generation held the renderer's busy flag until inference
finished. The recording and the notes now have separate completion lifecycles.

- Stop still waits for final speech callbacks, durable transcript writes and WAV
  finalization. It then marks recording completed and returns. Notes start as a
  background job tracked and drained by MeetingNotesService.
- Manual notes commands acknowledge job startup instead of holding the UI busy
  throughout inference. The button displays Generating notes while its job runs.
- Export can read a consistent saved meeting snapshot during notes generation.
  That export contains current finalized text and whatever validated notes exist
  at export time; later-generated notes require a new export.
- Destructive operations retain their guards against active notes jobs.
- Ollama's output schema asks for decision references without numeric timestamps.
  Missing timestamps are derived only from allowed, verified transcript IDs.
  Unknown citations and explicitly incorrect timestamps still fail validation.
- Summaries are requested concisely, local output is bounded to 1024 tokens, and
  repair prompts report concise field errors. The response is still validated;
  two failures do not produce invented notes or decisions. Failure messages now
  identify validation issues while recording/text remain available.

The existing llama3:latest settings are preserved. These changes do not certify
model accuracy or a particular inference time. They remove UI waiting on the
model and avoid asking it to calculate timestamps. Source citations alone do not
prove factual correctness; review generated notes against the transcript.

Regression coverage was updated for nonblocking Stop with deferred notes and for
timestamps derived from valid references, with rejection of unknown references.
The live smoke now waits for notes separately from recording completion.

Citation repair follow-up: both provider schemas now restrict reference strings
to the IDs supplied in that individual request. Summary references are required
during decoding, then discarded when the summary is empty. Consolidation uses
only references retained in validated input notes; empty notes are combined
without another model request. Prompts include the allowed IDs explicitly, and
Ollama also receives the response schema in its system prompt. Validation still
rejects unknown IDs, and errors identify the generation stage and field.
Regression tests were added for request schema enums, chunk/consolidation ID
scoping, empty notes, and invalid citation diagnostics. These new checks have
not been run by the agent; run the commands below to validate this checkout.

After quitting the old app, run:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:phase3
pnpm smoke:phase4
pnpm dev
```

Test a short meeting with an explicit decision and commitment. After Stop,
verify recording is completed and export Markdown/PDF while Notes is processing.
Check the exported transcript. Notes generation should not disable export; its
own button remains disabled to prevent duplicate work. On completion, review
summary/decisions/actions and export again to include them. Retry notes for an
older failed meeting and retain the full new validation message if it still fails.
