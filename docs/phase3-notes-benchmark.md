# Phase 3 local notes benchmark

Measured on 28 November 2026 on this Windows laptop. These are live Ollama results, not mocked responses.

## Workload and method

Run `node scripts/benchmark-notes.cjs` from the repository after starting Ollama. The runner enumerates downloaded local models, rejects remote aliases, unloads each selected model, performs a short warm-up, then uses the production notes pipeline on `scripts/fixtures/notes-ten-minutes.cjs`.

The fixture is explicitly synthetic. It contains 970 words in 20 alternating microphone/system segments over the original 0–600000 ms timeline. It covers release gates, agreed decisions, questions, suggestions, real commitments, unknown dates, an already-completed task, and a final recap. At the default 6000-character boundary it produces two chunks of 5839 and 1485 characters, retaining whole segments.

Machine — Intel Core i7-13620H, 16,791,150,592 bytes RAM, Windows, Ollama on 127.0.0.1:11434. Installed models were mistral:latest (7.2B Q4_K_M) and llama3:latest (8B Q4_0). Request timeout was 180 seconds, temperature zero, structured JSON output. This was an indicative run during development verification, with some other test processes running. Power state and dedicated GPU utilization were not controlled or measured.

Raw report — `release/phase3-notes-benchmark.json` (ignored local artifact).
The runner records the model digest, provider, wall time, response-reported load time and tokens, retries, each returned chunk/consolidation call, validation outcome, and sampled process working set. Samples cover all Ollama processes every approximately two seconds. They exclude GPU memory and can miss short peaks.

## Actual results

| Measurement | mistral:latest | llama3:latest |
| --- | --- | --- |
| Initial model load, reported by Ollama | 8.008 s | 13.350 s |
| Short warm-up wall time, including load | 56.358 s | 39.483 s |
| Warm-up input / output tokens | 281 / 176 | 257 / 34 |
| Warm-up schema validation | PASS | PASS |
| Ten-minute workload wall time | 180.043 s | 180.024 s |
| First full-workload chunk | Timed out | Timed out |
| Remaining chunk / consolidation | BLOCKED by first-chunk timeout | BLOCKED by first-chunk timeout |
| Validation retry count | 0 | 0 |
| Full-workload token count | Unavailable | Unavailable |
| Peak sampled Ollama working set | 5,110,468,608 bytes | 5,499,219,968 bytes |
| Full-workload result | FAIL — timeout | FAIL — timeout |

Timeouts are transport failures and are not validation retries. Ollama did not return a completed response, so full-workload tokens and load metrics are unavailable. The original raw report's tokens field is zero because no usage was returned; this does **not** mean zero tokens were processed. The runner now records unavailable token totals as null and the pipeline records elapsed failed-call time. Neither model reached consolidation in this measured run. Mocked consolidation tests are not presented as live benchmarks.

Human review of warm-up output found that Mistral converted the agenda into three action items despite no commitment in that segment. Llama 3 returned a summary with empty decisions/actions, which matched the evidence. Passing Zod validation does not establish factual accuracy.

A separate live Electron test used llama3:latest with a 300-second request timeout on a short real local transcription of synthetic speech. Stop completed notes generation, persisted the result, and a second Electron launch restored exactly the same record. That is a successful short integration check, not a successful ten-minute benchmark.

## Recommendation and next measurement

Use **llama3:latest for short acceptance tests**, with a 300-second timeout in Settings. Its short output was more conservative and its measured warm-up was faster. **Neither installed model is qualified for long meetings at the default settings.** Keep long-meeting performance and factual review as open acceptance gates.

To try smaller chunks or a longer request deadline, preserve the previous report first, then run a selected model. These are proposed tuning settings, not measured improvements.

```powershell
cd D:\vinxa\Vinxa
ollama list
# Start Ollama, or run ollama serve in a separate terminal.
Copy-Item release/phase3-notes-benchmark.json release/phase3-notes-benchmark-defaults.json
$env:VINXA_BENCH_CHUNK_CHARACTERS = '3000'
$env:VINXA_BENCH_TIMEOUT_SECONDS = '300'
node scripts/benchmark-notes.cjs llama3:latest
Remove-Item Env:VINXA_BENCH_CHUNK_CHARACTERS,Env:VINXA_BENCH_TIMEOUT_SECONDS
```

For a release decision, rerun without competing workloads, record power/GPU configuration, obtain completed per-chunk and consolidation measurements, and review every decision and action against the fixture. The benchmark never downloads models, calls OpenAI, or uses a private call transcript.
