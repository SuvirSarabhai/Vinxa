# Phase 1 speech benchmark

Measured on 26 November 2026. Status: **DONE** for the offline engine, three-run
comparisons and model decision; **MANUAL-PENDING** for accuracy and real-call gates.
All numbers below come from local runs. Recordings, transcript text, model weights
and build output are excluded from Git.

## Decision

Use **faster-whisper base.en, CPU INT8, four threads** for the English demo baseline.
Its median inference was 4.562 seconds for 25.421 seconds of audio (RTF 0.1795),
with a measured process peak working set near 440 MiB. Small took 5.727 seconds
(RTF 0.2253) and about 946 MiB. There is no measured accuracy benefit to justify
the larger model yet. Base.en is English-only: select and validate a multilingual
model before a Hindi-English demo. Keep small available for that evaluation.

Whisper.cpp base.en also ran successfully. Its median total-minus-load time was
8.750 seconds (RTF 0.3442), with lower observed memory, about 316 MiB. Keep it as a
documented alternative. These tests establish an offline speed baseline; they do
not prove two-stream latency, accuracy, or Phase 2 readiness.

## Machine, dependencies and models

| Item | Measured configuration |
| --- | --- |
| OS | Windows 11 Home Single Language, build 10.0.26300 |
| CPU | Intel Core i7-13620H, 10 physical cores / 16 logical processors |
| Usable total physical RAM | 15.638 GiB |
| Runtime | Python 3.11.9, faster-whisper 1.2.1, CTranslate2 4.9.1 |
| Metrics dependencies | NumPy 2.4.6, psutil 7.2.2 |
| Faster-whisper precision | CPU INT8, four threads |
| Faster-whisper base.en revision | 3d3d5dee26484f91867d81cb899cfcf72b96be6c |
| Faster-whisper small revision | 536b0662742c02347bc0e980a01041f333bce120 |
| Whisper.cpp | Official Windows CPU x64 release b5907, GGML base.en weights |
| Power | Charger connected for the final comparison; Windows reported power_plugged=True |

The exact metrics, every run, sample hash and model identifiers are in
[phase1-benchmark-results.json](phase1-benchmark-results.json). Model cache defaults
to the user's local application data directory, outside the repository, and can
be changed with VINXA_MODEL_DIR or --cache-dir.

## Sample and method

Every engine used the same physical headphone-test mic.wav: 406,741 samples,
16,000 Hz, mono, signed little-endian Int16 PCM, duration **25.4213125 seconds**.
SHA-256: daa0a79d8b9798f3ce7eadbfd564e58ab039892bbfb3474e05a28ef345aaa924.
It contains speech and quiet intervals, and 10 full-scale samples. The user
confirmed clear microphone speech with no audible video playback. This is a
short mixed-activity recording, not a clean 60-second continuous-speech corpus.
RTF uses the entire WAV duration, including silence. Repeat with a longer,
unclipped reference recording before making an accuracy or capacity claim.

Each configuration ran three times, sequentially, on the same laptop. Models
were already downloaded; no network/model download time is included. Language
was fixed to en, beam size was five, and VAD was disabled.

Faster-whisper loads one model per benchmark invocation and reuses it for all
three runs. Inference timing includes consuming its lazy segment generator, but
excludes WAV validation/read and model load. condition_on_previous_text=False.
The single measured load includes Python backend imports; it is not a repeated
cold-load median. OS disk caches were not cleared, so the smaller measured load
time for small does not establish that it starts faster.

Whisper.cpp starts a fresh CLI process for every run, with -t 4 -bs 5 -bo 5 -l en
-ng. It reports inference as diagnostic total time minus diagnostic load time;
that interval also includes non-model-load CLI work and is not identical to the
Python timing boundary. Wall time includes process start, model load and exit.
The GGML model is not quantized to INT8, so this is a practical backend comparison,
not a precision-controlled kernel comparison. Its runs overlapped the final
installer-packaging task; the Python final runs started after packaging finished.

Memory is process working set/RSS in MiB, sampled every 50 ms. On Windows it also
uses the process-lifetime peak working set, which can include model loading and
prior runs. Python values include the Python runtime; cpp values cover its child
process. Brief peaks after the last sample can be missed. These are observed
process peaks, not incremental memory allocated by each inference.

## Measured runs

| Backend / model | Run | Inference seconds | RTF | Peak working set MiB |
| --- | --- | --- | --- | --- |
| faster-whisper base.en INT8 | 1 | 4.562 | 0.1795 | 438.3 |
| faster-whisper base.en INT8 | 2 | 4.550 | 0.1790 | 439.7 |
| faster-whisper base.en INT8 | 3 | 4.747 | 0.1867 | 439.7 |
| **base.en median** | | **4.562** | **0.1795** | **439.7** |
| faster-whisper small INT8 | 1 | 5.727 | 0.2253 | 946.1 |
| faster-whisper small INT8 | 2 | 5.550 | 0.2183 | 946.1 |
| faster-whisper small INT8 | 3 | 6.692 | 0.2633 | 946.1 |
| **small median** | | **5.727** | **0.2253** | **946.1** |
| whisper.cpp base.en GGML | 1 | 8.155 | 0.3208 | 315.8 |
| whisper.cpp base.en GGML | 2 | 8.754 | 0.3443 | 318.6 |
| whisper.cpp base.en GGML | 3 | 8.750 | 0.3442 | 315.5 |
| **cpp base.en median** | | **8.750** | **0.3442** | **315.8** |

Faster-whisper load: base.en **4.667 s**, small **1.638 s**.

| Whisper.cpp run | Load seconds | Total seconds | Wall seconds |
| --- | --- | --- | --- |
| 1 | 0.289 | 8.444 | 8.986 |
| 2 | 0.145 | 8.899 | 8.960 |
| 3 | 0.176 | 8.926 | 8.991 |
| Median | 0.176 | 8.899 | 8.986 |

Earlier exploratory Python runs on the same recording had median RTF 0.2645
(base.en) and 0.7498 (small). Power and load conditions were not recorded for
those probes, and their memory sampler used different accounting. They are
retained locally under tmp, excluded from the comparison table. The variation
is another reason to repeat on representative speech and under sustained load.

## Accuracy, installation and packaging

**MANUAL-PENDING:** no ground-truth transcript was provided; WER remains null.
All faster-whisper runs returned nonempty transcripts, which proves execution,
not correctness. No transcript content was printed, committed or included in
the metrics. No qualitative accuracy winner has been established. Fixed-language
probability 1.0 is backend metadata, not measured word accuracy.

The Phase 1 Python dependencies installed successfully in a local virtualenv;
pip check found no broken requirements. CPU model load and offline transcription
worked for both models. A distributable Python sidecar has **not** been frozen or
bundled. PyInstaller, CTranslate2/PyAV runtime dependencies, model distribution,
licences and clean-machine startup still need deployment validation before the
Python stack can be called packaging-ready.

Whisper.cpp installation used the official b5907 Windows x64 CPU archive and
GGML base.en model. The initially inspected newer release tag did not offer the
needed Windows binary asset, so this older official release was used explicitly.
It runs without Python but still needs its executable, supplied runtime DLLs,
model, licences and process integration in the package. Neither backend is
currently bundled with the Electron installer. Do not silently switch stacks:
choose cpp if a later packaged Python startup test fails and cannot be resolved
within the deadline.

The Electron native dependency initially failed because the VS Build Tools
installation was incomplete. The installed VsDevCmd environment successfully
built better-sqlite3. Both unsigned NSIS and portable artifacts were generated;
the unpacked packaged app and the NSIS-installed app passed the existing full
smoke test. The temporary installation was removed with its uninstaller. A
separate clean Windows machine has not been tested. See the updated
[shell validation](phase-1-validation.md) and [capture report](phase1-audio-capture.md).

## Implementation and integration

| File | Responsibility |
| --- | --- |
| sidecar/audio_utils.py | Validate exact WAV format, truncation, silence, duration and full-scale count; calculate RTF |
| sidecar/engine.py | Lazily load and reuse one model; serialize inference; return text, timestamps, language and metrics; sanitize runtime errors |
| sidecar/benchmark.py | Three-or-more runs, optional reference-based WER, process memory sampler, exclusive metrics-only JSON |
| sidecar/benchmark_cpp.py | Validated CPU CLI comparison, timing diagnostics, child memory, timeout/exit handling, exclusive metrics JSON |
| sidecar/requirements-phase1.txt | Bounded offline-engine and test dependencies |
| sidecar/test_*.py | WAV and RTF errors, model reuse/load/inference errors, metrics privacy, subprocess failures and timeout cleanup |

The Python API is SpeechEngine(model='base.en', device='cpu', compute_type='int8',
cpu_threads=4), then transcribe(wav_path, language='en'). It accepts the finalized
WAV path, not live frames. The Transcription result contains text, segments
(text/start_ms/end_ms), language, optional language_probability,
audio_duration_seconds, model_load_seconds, inference_seconds and rtf. Segment
times are relative to that source WAV. Caller owns any source/session mapping.
Unknown confidence remains None, rather than an invented certainty.

SpeechEngineError has a stable code: INVALID_CACHE, CACHE_UNAVAILABLE,
MODEL_MISSING, DISK_SPACE, DEPENDENCY_MISSING, MODEL_UNAVAILABLE,
MODEL_LOAD_FAILED or INFERENCE_FAILED. Invalid audio raises AudioValidationError.
Callers should display sanitized error text, never backend exception chains or
transcript content in logs.

The existing Electron frame contract remains 16 kHz mono Int16 LE, 100 ms:
byte 0 is source 0 (mic) or 1 (system), followed by 1,600 samples / 3,200 bytes.
The total tagged frame is 3,201 bytes. Each source has its own worklet, bounded
queue and WAV writer; the final padded frame is trimmed using its padding count.
No Python PCM implementation, duplicate IPC contracts, WebSocket server, live
inference pipeline or Phase 2 feature was introduced. See
[README-developer-b.md](../README-developer-b.md) for commands.

## Remaining acceptance gates

| Gate | Status / next action |
| --- | --- |
| Offline engine, benchmarks, model choice | DONE |
| Automated tests | DONE: 40 Python tests and 69 TypeScript tests after the standalone fallback diagnostic; typecheck and production build pass |
| Packaged installer launches and shell remains intact | DONE on this laptop, unpacked and installed smoke passes |
| Two clean WAVs of a real call plus video playback | DONE: later Google Meet recording at mic gain 0.75; both 29.9813125-second WAVs pass strict validation with zero full-scale output samples and user-confirmed clear/correct content; pre-gain input warning retained |
| Bluetooth, permission denial and output changes/restart | DONE for tested OnePlus/Realtek configurations; see device matrix |
| Non-default meeting output | Primary FAIL retained; standalone selected-OnePlus fallback PASS: 20 seconds, strict validation and user-confirmed clear remote voice |
| Audio mentor review / team contract review | MANUAL-PENDING; evidence and interfaces prepared |
| Accuracy and Hindi-English model selection | MANUAL-PENDING; obtain a reference sample and compare |

**Overall Phase 1: PARTIAL.** The automated implementation, local packaging and
recorded Google Meet real-call gate pass. Required device checks are recorded,
including primary non-default route failure and successful selected-output
fallback. Focused local commits record this evidence; human reviews remain open.
The original benchmark
still refers to its earlier 25.4213125-second sample, not this later call.

## Primary references

- [faster-whisper implementation and CPU INT8 usage](https://github.com/SYSTRAN/faster-whisper)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [b5907 release](https://github.com/ggml-org/whisper.cpp/releases/tag/b5907)
- [Microsoft developer command environment](https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line?view=msvc-170)
