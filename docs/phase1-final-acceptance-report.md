# Phase 1 final acceptance report

Audit date: 26 November 2026. Branch: navya. **Overall: BLOCKED** pending mentor
capture-path review and team contract review. The Google Meet real-call
WAV pair now passes validation and user listening. Phase 2 has
not been started. A checkbox is checked only for its stated PASS scope.

## Initial inspection and clipping evidence

Existing Python implementation/tests were staged; README/report changes and new
reports were not yet committed. No work was discarded. The three EOF warnings
were sidecar/benchmark_cpp.py, sidecar/engine.py and sidecar/test_engine.py.

The old headphone mic.wav has 406,741 samples (25.4213125 s): ten negative
full-scale samples, zero positive, peak 1.0, RMS 0.0670710275, clipping percentage
0.002458567%. All ten occur within 6.143625–6.245750 s. The matching system WAV has
zero full-scale samples, peak 0.3636169434 and RMS 0.0429778555. Both files have
16kHz mono signed Int16 headers and matching data lengths; only system passes
the strict quality validator. These files are local ignored evidence, not a
verified real-call pair.

No explicit amplification, duplicate processing path or software source mixing
was found. The old WAV lacks pre-conversion samples and Windows input-level
metadata. Whether the peaks began in the device, Chromium processing or sinc
interpolation cannot be proven retrospectively. New pre-gain diagnostics and a
fresh physical recording are required. Lowering the saved PCM alone cannot
restore upstream clipped speech or satisfy acceptance.

## Developer B — Audio and Speech

| Acceptance item | Status | Evidence / remaining action |
| --- | --- | --- |
| [x] Microphone capture works | PASS | Existing physical recording and user listening confirmation; current clean-quality gate is tracked separately |
| [x] System audio capture works | PASS | Controlled default-output loopback and user playback confirmation; current system.wav validates |
| [x] Two separate recordings exist | PASS | Fresh Google Meet microphone.wav/system_audio.wav; independent source-bound windows, worklets and writers; valid headers and distinct SHA-256 hashes |
| [x] Real-call recording with video completed | PASS | Google Meet, 26 November 2026; user confirmed recording finished and both local voice / remote voice plus video clear in correct files, without unexpected bleed, distortion or missing sections |
| [x] Microphone clipping resolved | PASS | New saved mic PCM has zero positive/negative full-scale samples at gain 0.75, peak 0.749481 and clear user-confirmed speech; two pre-gain input endpoints remain an explicitly documented warning, not a claim of repaired upstream audio |
| [x] WAV validation passes for both acceptance recordings | PASS | Both strict validator runs passed: 479,701 samples each, 29.9813125 s, 16kHz/mono/16-bit, zero full-scale samples |
| [x] Bluetooth compatibility checked | PASS | OnePlus Nord Buds 3 mic/output selected by user; installed app produced valid approximately 22.4-second separate WAVs with zero full-scale output samples; user confirmed clear/correct speech and playback without unexpected bleed, distortion or gaps |
| [x] Microphone permission denial checked | PASS | Windows desktop mic access Off, expected permission-denied message confirmed, zero samples / finalized 44-byte header, no stream/context startup, app remains alive; user confirmed access restored On |
| [x] Default output changes checked | PASS | Corrected packaged retest: native default-output-changed log, user-confirmed warning and finalized 3.592-second valid WAV with zero full-scale samples |
| [x] Fresh capture after output-change stop | PASS | Subsequent installed-app Bluetooth dual capture started/finalized normally on the selected earbuds output; valid files and user-confirmed clear/correct audio |
| [x] Non-default meeting output checked | PASS | Primary route failure documented: only video, Meet voice absent; selected-OnePlus fallback then saved a valid 20-second WAV with zero full-scale samples, user-confirmed clear remote voice without distortion or missing sections |
| [x] Capture fallback reviewed | PASS | Local implementation/contract audit, unit tests and physical selected-output capture pass; mentor suitability review remains separate and pending; no Electron backend switch |
| [x] faster-whisper benchmark documented | PASS | docs/phase1-benchmark-results.json and phase1-speech-benchmark.md; three runs each for base.en/small |
| [x] whisper.cpp comparison documented | PASS | Same sample, official b5907 CPU build, three measured runs and timing-boundary limitations |
| [x] Model selected using measurements | PASS | English baseline: base.en CPU INT8, four threads, median RTF 0.1795; accuracy and multilingual suitability unverified |

## Developer A — Shell and Contracts

| Acceptance item | Status | Evidence / remaining action |
| --- | --- | --- |
| [x] Electron shell works | PASS | Post-change production build and full packaged/installed smoke passed |
| [x] Tray works | PASS | Post-change close-to-tray and second-instance restoration smoke; actual context-menu selection still needs operator observation |
| [x] Shared contracts are integrated | PASS | Existing source ids, Zod schemas, preload bridge and fixture/capture callers; human agreement is separate |
| [x] Fake transcript player works | PASS | Post-change packaged/installed smoke covers partial replacement, labels, pause/resume/reset |
| [x] Installer launches | PASS | Latest native-guard NSIS installer returned 0, installed helper hash matches source, and installed executable launched successfully |
| [x] Installed-app smoke passes | PASS | Latest native-guard installed smoke passed fixture playback, tray lifecycle, second-instance restore and quit; same installed build then produced valid Bluetooth dual WAVs |

## Joint acceptance

| Acceptance item | Status | Evidence / remaining action |
| --- | --- | --- |
| [ ] Mentor capture-path review completed | PENDING REVIEW | Mentor checklist in phase1-contract-review.md; no reviewer/sign-off yet |
| [ ] Team contract review completed | PENDING REVIEW | Local audit prepared; no human agreement recorded |
| [x] Final cleanup completed | PASS | Three EOF warnings fixed in working tree and existing staged copies; two unused imports and one unused local removed; whitespace/import/AST checks pass; model-weight ignore rules expanded |
| [x] Python tests pass | PASS | Post-fallback rerun: 40 passed (29 original plus 11 selected-output diagnostic cases); pip check reports no broken requirements |
| [x] TypeScript tests pass | PASS | Latest output-guard rerun: 69 passed in nine files, baseline was 34 |
| [x] Typecheck passes | PASS | Post-change pnpm typecheck passed |
| [x] Build passes | PASS | Post-change pnpm build passed for main, preload and both renderer entries |
| [x] Changes reviewed and committed | PASS | Local source, exact-file, artifact, secret-pattern and whitespace checks completed; five focused local commits on navya follow the shown plan. Human mentor/team acceptance remains separate; nothing pushed |

## Evidence categories and next gate

Automated results, physical observations and human review are distinct. Synthetic
capture and mocked denial/device-change tests cannot complete real hardware
checks. Finalization pnpm package:win and fresh packaged/installed smoke were
actually rerun and passed. Both smoke runs used separate temporary user-data
profiles so the pending physical mic test could stay open. Their second-instance
checks used the same profile within each run. Installer/uninstaller both returned
0; the temporary installed executable was confirmed removed.

The generated dual-source smoke also passed after the code change (mic
5.010625 s, system 5.032 s, separate finalized files and destroyed capture
windows). This is not real microphone, Bluetooth or call evidence. Existing
benchmark JSON math, medians and sample SHA-256 were rechecked successfully;
the model engine was not changed beyond EOF cleanup, so timings were retained
with their original measured sample and limitations rather than relabelled.

## Accepted Google Meet recording

The user reported the call ready, manually started dual recording, confirmed
recording finished, then confirmed both recordings were clear and in the correct
files in response to the explicit local-voice / remote-voice-plus-video listening
question. Call application: Google Meet. Device model names and Windows physical
input level were not supplied. Headphones/default output were requested in the
procedure; exact device selection was not independently inspected.

Local evidence directory: test_recordings/phase1-real-call-20261126-204045.
Both exclusive-created WAVs remain ignored by Git. The earlier mic-only attempt
never saved a file and was replaced by this real-call test; the original clipped
headphone WAV remains preserved separately.

| File | Samples / seconds | Peak | RMS | Positive / negative full scale | Clipping percentage | Result |
| --- | --- | --- | --- | --- | --- | --- |
| microphone.wav | 479,701 / 29.9813125 | 0.7494812012 | 0.0519408793 | 0 / 0 | 0% | PASS |
| system_audio.wav | 479,701 / 29.9813125 | 0.8698120117 | 0.0987983426 | 0 / 0 | 0% | PASS |

Both files are 16kHz mono signed Int16 PCM, 959,446 bytes with valid finalized
RIFF/data lengths. SHA-256 mic:
cc7191eb125af62acfa7a81692e3b7fe330b1a0d131bcc07988f133198495827.
SHA-256 system:
8010b23f389abc87715374dc077b2afe3875c70cc028e3e22768711787695adc.
The files differ; source-bound windows/worklets/writers and prior regression
tests establish software separation. User listening establishes the reported
semantic content and quality; metrics alone cannot do that.

Pre-gain microphone diagnostics: input peak 1.0, two absolute-full-scale input
values out of 2,878,208 channel samples; resampled peak 0.9993205022 and zero
resampled full-scale samples. Output at gain 0.75 has zero full-scale samples.
System diagnostics: gain 1, input peak 0.8698039055, zero input full-scale values,
resampled peak 0.8698271585 and zero output full-scale samples. The microphone
warning was retained in the local diagnostic log. Two exact input endpoints
indicate limited upstream headroom; neither the original cause nor ADC clipping
can be inferred from these post-browser samples. User reported no audible
distortion. Lower Windows input volume and repeat if that warning or audible
distortion recurs; attenuation does not reconstruct clipped upstream speech.

Remaining blockers: mentor capture-path review and team contract review. The primary
non-default test failed: user heard
only video, not the remote Meet voice. Its 26.930625-second WAV also has one
full-scale sample. A standalone PyAudioWPatch diagnostic now selects one exact
loopback, converts native audio to the existing PCM contract and requires a
manual Start. The subsequent physical OnePlus fallback capture passed the
unchanged WAV validator: 320,000 samples / 20 seconds, peak 0.957611084,
RMS 0.081978658, zero full-scale samples. User confirmed clear remote voice
without distortion or missing sections. Evidence:
test_recordings/phase1-nondefault-fallback-20261126-215510/system_audio.wav.
Its SHA-256 is
07c1b9a3e1be8a3e9722f5ca00068c06f811877c7c9bbe14ea01ea065e245fb9.
The native stream and PyAudio instance close before reporting saved. No
microphone is opened by this source-1 diagnostic. Post-change checks: 40 Python tests, 69 TypeScript tests,
typecheck, build and pip check pass. Electron integration/automatic fallback is
not implemented. A separate clean Windows machine is untested. Python/model
bundling and live transcription are not claimed by this Phase 1 WAV engine.

Do not begin Phase 2 while the original acceptance gates remain unresolved.

## Local Git finalization

The exact file list and five-group plan were shown before committing. The
implementation commits are a36e487 (speech engine/benchmarks), c8255db (mic
headroom/output-change guard), 45edc53 (selected-output diagnostic) and 4b28c94
(model ignore rules). The accompanying documentation commit records this report,
device evidence, contract review packet and plan. Recordings, models, virtualenv
and generated artifacts are excluded. No push or main-branch commit was made.
Local source review is not mentor sign-off or team agreement on contracts.

## Failed output-switch check and correction

The physical system-only attempt -205825 did not produce a device-change warning
according to the user. Its WAV remained structurally valid, but the last roughly
nine seconds are silent. Strict file validation cannot detect that semantic loss
of playback. This failure is retained and is not relabelled as a passing test.

The old browser handler awaited enumerateDevices before stopping even system
capture. Hidden-document visibility and device-exposure constraints make that an
unsafe dependency; whether the event itself was omitted or enumeration stalled
in this attempt is unproven. It now stops system capture before enumerating.

An additional read-only Windows Core Audio guard polls default render endpoints
for console/multimedia/communications roles every 250 ms. A bundled PowerShell
helper performs only endpoint queries, prints no IDs or audio, and exits on parent
stdin close. Main handles readiness, changes, startup/exit/protocol failures and
missing heartbeats; it stops/finalizes capture on a change or monitoring failure.
No microphone permission, capture backend, public IPC contract or speech engine
was changed. The installer resource list adds the helper for packaged operation.

Actual native probe: ready, heartbeat, exit 0, no stderr. Generated dual capture
with the monitor passed (mic 4.9893125 s, system 5.010625 s) and cleaned up capture
windows. Typecheck, build and 69 TypeScript tests pass; 29 Python tests and pip
check still pass. Latest NSIS and portable packaging completed. The packaged
helper hash matches source, and full unpacked packaged smoke passed. The physical
retest at test_recordings/phase1-output-change-fixed-20261126-211438 then passed:
the user confirmed a warning and the log explicitly records default-output-changed.
The finalized 16kHz mono Int16 WAV has 57,472 samples / 3.592 s, peak
0.3724060059, RMS 0.0529157210 and zero full-scale samples. No monitor PowerShell
child remained after capture stopped. The successful retest does not replace or
relabel the preserved failed attempt. Fresh capture on the new output was
checked by the subsequent installed-app Bluetooth capture: both sources started
and finalized normally, both WAVs pass validation, and the user confirmed both
clear and in the correct files. The latest native-guard installer returned 0, its installed helper
hash matches source, and full installed smoke passed. This installed build was
also used for the Bluetooth test, exercising its actual capture/monitor resources.
Its temporary test installation was subsequently removed with its own uninstaller
(exit 0, executable confirmed absent); recordings remain in the ignored project
test directory. Microphone has 358,869 samples / 22.4293125 s, peak 0.7476196289,
RMS 0.0441911664; system has 359,381 samples / 22.4613125 s, peak 0.8731994629,
RMS 0.0629848435. Both have zero full-scale output samples; two mic input
endpoints before gain remain a documented warning, with no audible distortion
reported. Actual negotiated Bluetooth profile was not independently logged.
