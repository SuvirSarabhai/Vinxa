# Phase 1 audio capture

Finalization evidence and outstanding acceptance are tracked in
[phase1-final-acceptance-report.md](phase1-final-acceptance-report.md).
The detailed physical matrix is [phase1-device-compatibility.md](phase1-device-compatibility.md);
human capture/contract review is [phase1-contract-review.md](phase1-contract-review.md).

Developer B's Stages 1 and 2 add microphone and Windows loopback diagnostics to the existing desktop shell.
The test is started explicitly and asks for confirmation before audio access.
Implementation and hardware verification are tracked separately below.

## Microphone headroom finalization

VINXA_MIC_GAIN now accepts a finite linear gain from 0.1 through 1.0, default
0.75 (approximately -2.50 dB). Main validates it before acquisition, passes it in
the trusted capture-page query and the renderer forwards it to the worklet.
PcmEncoder applies it once after resampling and before the unchanged Int16
clamp/round. System gain remains 1.0 and its PCM is byte-identical for different
mic-gain configurations in the synthetic regression test. Invalid mic gain fails
with a useful message, without opening capture windows or input tracks.

Worklet completion now includes internal aggregate levels: input peak, count and
full-scale count across input channels; resampled pre-gain peak/count/full-scale
count; applied gain and output full-scale count. Only these scalar metrics are
logged through the existing opt-in local diagnostic path. Public
CaptureBridge.finished and IPC contracts are unchanged. No raw samples or
transcript content are logged. A full-scale input warning remains visible in
diagnostics even if attenuation makes output PCM fall below full scale.

Here input means samples delivered to the worklet, after any device/Windows/
Chromium processing. It is not an ADC-level measurement. Browser automatic gain,
noise suppression or echo processing may already have changed the waveform.
The original ten clipped samples cannot identify the upstream stage because
pre-gain telemetry was not recorded. Application attenuation creates headroom;
it cannot reconstruct clipped input. Fresh physical validation and listening
remain required before calling the microphone quality issue resolved.

VINXA_CAPTURE_DIR selects a local output directory. The default development path
is unchanged; packaged builds now use userData/test_recordings rather than an
unwritable path inside app.asar. VINXA_CAPTURE_ACCEPTANCE=1 selects microphone.wav
and system_audio.wav; existing mic.wav/system.wav defaults remain compatible.
Exclusive creation preserves old files, and failed multi-file setup rolls back
only empty files created by that attempt. Use a fresh directory for every test.

## Status and evidence

| Item | Status | Evidence |
| --- | --- | --- |
| Branch | DONE | navya, with Developer A commit 9892b7a included |
| Baseline typecheck, tests, production build | DONE | Before microphone changes, 2 test files and 6 tests passed |
| Microphone implementation | DONE | Generated-device smoke passes. Physical microphone produced a valid WAV and the user confirmed clear speech. |
| PCM conversion | DONE | Synthetic tests cover 48 kHz stereo 1 kHz tone, 44.1 kHz and other rates, continuity, downmix, silence, anti-alias filtering, clipping and frames |
| WAV writer and validator | DONE | Tests cover duration, interrupted header, final trim, existing file preservation, bounded queue and invalid WAVs |
| Cleanup logic | DONE | Mocked renderer tests cover stop, denied permission and cancellation during device acquisition; worklet tests cover acknowledgements and overflow |
| Current automated checks | DONE | After standalone fallback diagnostic: typecheck/build pass; 69 TypeScript tests in nine files and 40 Python tests pass. Actual monitor startup/heartbeat/stop probe and generated dual capture pass. Latest packaging evidence is tracked in the final acceptance report. |
| Generated microphone Electron smoke | DONE | After the user changed Windows application detection, Electron launched. Latest run produced a valid 4.16-second WAV with 66,560 samples at 16 kHz, mono, 16-bit, RMS 0.096657 and zero full-scale samples. Hidden capture window was destroyed. |
| App launch and sample-player runtime regression | DONE for current package | Fresh unpacked and NSIS-installed builds pass preload bridge, partial/final playback, pause/resume/reset, close-to-tray, second-instance restoration and quit. Earlier development-executable launches failed with code 2147483651, including Developer A's original main. The current packaged test passes without changing shell behavior. |
| Physical microphone WAV and listening | DONE | mic.wav has 113,450 samples, duration 7.090625 seconds, peak 0.247192 and zero clipped samples. User confirmed the microphone is clear. |
| Windows microphone permission denial | DONE | User confirmed expected denial with desktop mic access Off; zero samples captured, header finalized, app alive; access restored On |
| Unplug and default input change on hardware | MANUAL-PENDING | Error paths implemented; these physical configurations remain untested |
| Installer rebuild and installed app smoke | DONE on this laptop | Installed Microsoft VsDevCmd environment successfully rebuilt better-sqlite3. pnpm package:win generated unsigned NSIS and portable artifacts. NSIS returned 0; installed-app smoke passed. The temporary installation was removed using its uninstaller. Build Tools registration is still incomplete; use its developer environment for builds. A clean machine is untested. |
| Local commit | DONE | Stage 1 is recorded as 2c8751a. Stage 2 is committed locally after automated and controlled Windows loopback tests. |
| System audio implementation | DONE | Trusted display-capture handler grants a screen source and Windows loopback. Video track is stopped immediately. Controlled default-output tone was captured successfully. |
| Simultaneous generated input test | DONE | Latest node scripts/smoke-microphone.cjs both passed after gain changes: 5.010625-second mic and 5.032-second system WAVs; separate files and capture windows cleaned up. This uses generated inputs, not a real call. Earlier pairs also passed strict quality checks. |
| User system playback recording | PARTIAL | system.wav contains 293,760 samples over 18.36 seconds at 16 kHz, mono, 16-bit. RIFF and data lengths match. RMS is 0.093222. Strict validation flags 2 full-scale samples (0.000681 percent). User confirmed system audio is clear. |
| Real-call dual capture | DONE | Google Meet real-call/video recording: separate microphone.wav and system_audio.wav each 29.9813125 s / 479,701 samples, 16kHz mono Int16, zero full-scale output samples. Both strict validators pass; user confirmed both clear and in correct files without unexpected bleed, distortion or missing sections. See final acceptance report for hashes and pre-gain warning. |
| Simultaneous playback test using speakers | PARTIAL | Both files passed WAV validation at 16 kHz, mono, 16-bit, each with 230,400 samples over 14.4 seconds and no full-scale samples. User heard voice and playback in mic.wav and playback only in system.wav. User confirmed laptop or external speakers were used; acoustic pickup explains the reported overlap. A headphone test is needed to check isolation. |
| Headphone isolation signal check | DONE | Both WAVs contain 406,741 samples over 25.4213125 seconds at 16 kHz, mono, 16-bit. At 2–4 seconds, system RMS is 0.09117 while mic RMS is approximately 0.00001. At 6–8 seconds, mic RMS is 0.22495 while system RMS is zero. User confirmed microphone voice was clear with no audible video playback. |
| Headphone-test audio level validation | PARTIAL | system.wav passes strict validation with zero clipped samples. mic.wav has 10 full-scale samples and is flagged by the strict clipping check. Its overall RMS is 0.067071. Lower microphone input level for the next recording. |
| Speech benchmarks | DONE | Offline Python engine and three-run faster-whisper base.en/small and whisper.cpp comparison completed on the same 25.421-second WAV. See phase1-speech-benchmark.md and phase1-benchmark-results.json. Accuracy remains pending a reference. |

## Integration and files

- src/shared/contracts.ts retains the existing contracts and adds CaptureBridge. Source IDs are microphone 0 and system 1 as requested.
- src/shared/ipc-channels.ts adds capture:ready, capture:frame, capture:finished and capture:stop.
- src/shared/schemas.ts validates the completion error and final padding count. src/shared/pcm.ts validates tagged frame lengths and source IDs.
- src/main/audio/capture-test.ts manages the explicit Start prompt, one hidden capture window and WAV writer per source, source-specific permission handlers, trusted display capture, startup and stop deadlines, and the Stop dialog. It replaces the Stage 1 microphone-test module.
- src/renderer/capture/capture.ts selects getUserMedia for mic or getDisplayMedia for system audio, stops video immediately, connects the worklet, forwards frames and cleans up tracks, context and nodes. Device changes or track end stop the test with an error.
- src/renderer/capture/worklet.ts runs PCM conversion off the UI thread. Four outstanding frames are allowed. If the consumer falls behind, capture fails visibly.
- src/shared/pcm.ts averages input channels and uses a streaming windowed-sinc low-pass filter to resample the actual native AudioContext rate to 16 kHz.
- src/main/audio/wav-writer.ts writes an exclusive new file, checks free disk space before capture and every five seconds of audio, updates the header after each frame, and finalizes on stop. It reserves 16 MiB and enforces the RIFF size limit.
- src/main/audio/wav-validation.ts and scripts/validate-wav.mjs check RIFF/chunk lengths, PCM encoding, 16 kHz, mono, 16 bits, sample count, duration, silence and full-scale samples.
- electron.vite.config.ts adds the capture HTML entry. The existing app page, tray controls and installer configuration retain their existing behavior.
- scripts/smoke-microphone.cjs supports mic, system and both modes in isolated temporary recording folders. Its system input substitutes a generated 880 Hz stream for getDisplayMedia; Windows hardware compatibility remains a separate check. Native prompts are simulated in this test.
- scripts/smoke.cjs accepts an optional application entry argument to run the existing regression checks against the development Electron executable. The existing packaged executable command is preserved.

## PCM and IPC format

Every worklet message carries a 3,201-byte ArrayBuffer. Byte 0 is the source ID.
The remaining 3,200 bytes are 1,600 signed little-endian Int16 mono samples at
16,000 Hz. Each sender is bound to its own source ID and file. Each source has its
own stream, worklet, frame queue and writer. Both files are mono. The diagnostic
starts sources independently, so it does not establish a synchronized meeting timeline.

The worklet transfers buffer ownership to the capture renderer. The preload bridge
uses acknowledged asynchronous Electron IPC to main. Electron's IPC transfer list
supports MessagePorts; this implementation uses structured cloning for frame buffers
across the context bridge and main-process boundary. It makes no zero-copy claim.
Each acknowledgement follows the file write. Both worklet and writer enforce bounded
pending-frame limits. Overflow stops capture with an error.

The final partial frame is zero-padded to 1,600 samples. Completion reports the padding
count so the WAV writer trims those samples. Output sample count is
floor(input sample count * 16000 / input sample rate). A renderer crash can retain
up to one padded frame because the final trim count may be unavailable. Disk failures
and sudden power loss can still require file recovery.

Microphone access is stopped as soon as Stop is requested. Worklet flush and queued
writes complete before the normal window is destroyed. A hung renderer is destroyed
after three seconds, with the file finalized from frames already received. App Quit
waits for the same cleanup. A successful file write still needs validation and listening.

## Run the physical microphone test

Use Node 24, the locked pnpm version, and a machine allowed to run the installed
Electron executable. Fix the C++ toolchain dependency for a full native install.
The recording prompts describe the local test; inform nearby participants first.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
$env:VINXA_CAPTURE_TEST = 'mic'
pnpm dev
```

Confirm Start audio test. Speak for ten seconds and then click Stop recording.
The automatic limit is 30 seconds after all requested capture renderers are ready. The output is
test_recordings/mic.wav relative to the project root when running from source.
The writer refuses to overwrite an existing file. Move the previous WAV to a separate
local test folder before another run. Recordings and temporary smoke artifacts are
ignored by Git.

After stopping, validate and listen locally, then clear the diagnostic flag.

```powershell
node scripts/validate-wav.mjs test_recordings/mic.wav
Remove-Item Env:VINXA_CAPTURE_TEST
```

The validator prints metrics only. It exits nonzero for malformed, silent or clipped
audio. Compare its duration to the time actually spent speaking. Nonzero samples
alone do not prove intelligibility or correct physical device selection.

## Repeatable checks

```powershell
pnpm typecheck
pnpm test
pnpm build
node scripts/smoke-microphone.cjs
node scripts/smoke-microphone.cjs both
```

The synthetic Electron smoke never opens a physical microphone. Its first attempt used
a 1.2-second wall-clock capture interval and produced only 0.010625 seconds of silent
audio during startup. The interval is now five seconds, with an assertion that at least
three seconds of non-silent data reach the file. Two later captures passed at 4.36 and
4.16 seconds. Physical-device duration and intelligibility still require manual checks.

Run the existing desktop regression against the built development app with the following
command. All assertions before second-instance exit passed locally. The exit-code failure
was reproduced against both the current main and Developer A's original main, then the
current production build was restored.

```powershell
node scripts/smoke.cjs .\node_modules\electron\dist\electron.exe .
```

The later native rebuild succeeded through the installed Microsoft developer
environment. Fresh unpacked and NSIS-installed executables passed this full
smoke, including second-instance restore. See phase-1-validation.md for the
current package evidence. The earlier development launch failure above is
retained as historical diagnostic evidence.

## Manual results to complete

| Scenario | Captured | WAV valid | Intelligible | Cleanup observed | Status |
| --- | --- | --- | --- | --- | --- |
| Default microphone, ordinary speech | Yes | Yes | User confirmed clear | Capture finalized | DONE |
| Headset microphone (OnePlus Bluetooth) | Yes | Yes, zero full-scale output samples | User confirmed clear | Both WAVs finalized | DONE for tested configuration |
| Bluetooth microphone | Yes, installed app | Yes | User confirmed clear/correct files | Both WAVs finalized | DONE for OnePlus Nord Buds 3 |
| Windows microphone access denied | No audio, as expected | Empty finalized header; not a valid speech sample | Expected denial confirmed | App alive, access restored On | DONE |
| Microphone unplugged during capture | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Default microphone changed during capture | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Quit while recording | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Default output playback recording | Yes | Format and lengths valid; 2 full-scale samples flagged | User confirmed clear | WAV finalized | PARTIAL |
| System audio through default speakers | Yes, speaker dual test | Yes | User heard playback in system.wav | WAV finalized | DONE for playback |
| System audio through headphones | Yes, headphone dual test | Yes, no full-scale samples | User confirmed mic isolation; system listening for this run not explicitly confirmed | WAV finalized | PARTIAL |
| Default output changed during capture | Yes, corrected retest | Yes, 3.592 seconds | Warning confirmed; listening not required for stop detection | WAV finalized; subsequent Bluetooth capture passes | DONE for tested switch |
| Meeting app on a non-default output | Primary: 26.930625 seconds; fallback: 20 seconds | Primary strict quality fails; fallback passes | Primary missed Meet voice; selected-OnePlus fallback voice clear, user confirmed | WAVs finalized | Primary FAIL; standalone selected-output fallback PASS |
| Google Meet call with simultaneous mic/system and video | Yes, two files | Both strict validators pass; zero full-scale output samples | User confirmed both clear and correct | Both files finalized | DONE for this configuration |
| Simultaneous microphone and playback using speakers | Yes, two files | Both pass | User heard both sources; mic includes speaker pickup | Both WAVs finalized | PARTIAL |
| Simultaneous capture using headphones | Yes, two files | System passes; mic has 10 full-scale samples | User confirmed clear mic voice and no video bleed; level intervals support isolation | Both WAVs finalized | PARTIAL: lower mic gain and repeat for clean quality gate |

## Run the system audio test

Play a video or call through the Windows default output device. After quitting any
previous Vinxa development instance, launch the system-only diagnostic.

```powershell
$env:VINXA_CAPTURE_TEST = 'system'
pnpm dev
```

Confirm Start audio test, play the sound for at least ten seconds, and press Stop
recording. Validate test_recordings/system.wav and listen to confirm the expected
sound is present. The system capture window is denied microphone permissions.
If Chromium returns no audio track, the diagnostic reports the error and stops.

```powershell
node scripts/validate-wav.mjs test_recordings/system.wav
```

For simultaneous capture, archive previous mic.wav and system.wav, then repeat with
VINXA_CAPTURE_TEST set to both. Use headphones. Speak with video playback paused,
then stay quiet while the video plays. Verify the first interval is audible in mic.wav
and the second interval in system.wav. The original headphone microphone
isolation check was confirmed by the user, but that historical mic file has ten
full-scale samples. The later Google Meet acceptance pair at gain 0.75 passes
both strict validators with zero full-scale output samples and confirmed clear
audio. Keep the original evidence separate; it was not normalized or overwritten.

Any devicechange event during system capture stops the test and warns to check the
Windows default output before repeating. This conservative response includes unrelated
device changes because browser device enumeration does not prove which Windows output
the loopback backend followed. Meeting audio routed to a non-default output must be
tested explicitly. No compatibility claim is made for that case yet.

The physical output-switch test later exposed a failure in the browser-only
guard: no warning, and a valid file with silence after about five seconds. Main
now independently observes Windows default render endpoints through the read-only
resources/audio/default-output.ps1 helper and windows-output-monitor.ts. It polls
all three roles every 250 ms, with startup and heartbeat timeouts, and stops all
requested capture sources on a change or monitor failure. The renderer stops on
system devicechange immediately rather than waiting for hidden-window device
enumeration. The corrected packaged retest passed: native default-output-changed
log, user-confirmed warning and valid 3.592-second finalized WAV. A subsequent
installed-app Bluetooth dual capture restarted on the earbuds output, produced
two valid approximately 22.4-second WAVs and passed user listening. The original
failed recording is preserved. See the device checklist for metrics and scope.

The helper is bundled as an extra resource because packaged ASAR paths cannot be
used as external script resources. It requires the standard Windows PowerShell /
.NET runtime and Core Audio. It neither changes device settings nor opens audio
streams. No execution-policy override is passed. Startup failure blocks capture
with an explicit error instead of silently disabling monitoring. Parent pipe
closure, normal stop and a bounded kill deadline release the helper.

Primary references: [Windows default endpoint API](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdeviceenumerator-getdefaultaudioendpoint)
and [media device-change exposure rules](https://www.w3.org/TR/mediacapture-streams/#device-change-notification-steps).

A physical device selector and Phase 2 streaming remain later work. Local WAV
transcription models are now implemented and benchmarked independently of capture.

## System capture timeout investigation

The first user system test timed out and left a 44-byte header-only system.wav.
The development log showed Vite optimizing zod and reloading the capture page at
startup. The renderer configuration now explicitly preloads zod. A capture-page
reload now finalizes files and reports a specific error. Optional diagnostics,
enabled with VINXA_CAPTURE_DEBUG set to 1, log permission and startup stage names.
They contain no audio samples or transcript text.

An earlier diagnostic logger wrote to the launch terminal after its pipe had closed,
raising EPIPE in Electron main. Diagnostics now append to the local
test_recordings/capture-debug.log file and never write to the launch terminal.
The regression test simulates an unavailable console and verifies file logging and
capture finalization still work. A controlled Windows loopback retest after this
fix captured 4.76 seconds and detected the expected 880 Hz tone.

The built application completed actual Windows loopback tests. A controlled test
played an 880 Hz tone through the default output and captured 4.850625 seconds.
The tone's measured RMS was 0.041475 and total RMS was 0.043375. This verified the
expected output signal reached the loopback WAV. Earlier quiet-output probes also
produced WAV files, but the controlled tone is the evidence for signal capture.
User playback, headphone-mic listening and the later Google Meet real-call/video
check are recorded above. Non-default output routing and other device
compatibility checks remain manual checks.

Run the controlled test with the following command. It plays a short audible tone,
uses actual Windows system capture, and saves its file in an ignored temporary folder.

```powershell
node scripts/smoke-microphone.cjs loopback
```

For a stable physical test after building, launch the built Electron application
without the development server. The production capture assets avoid development
page reloads during recording.

```powershell
pnpm build
$env:VINXA_CAPTURE_TEST = 'system'
& .\node_modules\electron\dist\electron.exe .
```

## Remaining physical acceptance procedure

Use a separate archived WAV pair for each scenario. Quit the current Vinxa
instance, preserve old mic.wav/system.wav, connect the intended devices, build,
then launch with VINXA_CAPTURE_TEST=both. Confirm Start yourself. Each diagnostic
lasts at most 30 seconds. Stop explicitly, validate both WAVs, and listen to each
in isolation. Record failures and error text as well as successful captures.

1. **Headphones:** repeat at lower microphone gain. Speak for 5–10 seconds while
   playback is paused; then stay quiet while playback runs. Mic should contain
   clear local speech without video bleed; system should contain playback. Both
   strict validators must pass before the pair is called clean.
2. **Speakers:** repeat the alternating intervals. Expect acoustic playback in
   the physical mic. That observation does not imply software mixing; report it
   explicitly. Do not claim isolated speech when the speakers are audible to mic.
3. **Bluetooth headset:** select it in Windows before launch, and verify the
   actual microphone and output routes. Repeat the alternating test, note any
   hands-free mode/quality change, validate, listen and confirm cleanup. Headphone
   use alone does not prove a headset microphone was selected.
4. **Default output change:** during playback, manually change the Windows
   default output. The current conservative implementation should stop and warn,
   finalize received audio and release tracks. It does not promise seamless
   switching. Relaunch on the new default and verify playback is captured there.
5. **Permission denial:** manually deny microphone access using Windows controls
   and start a mic-only diagnostic. Expect a clear startup error, finalized files
   if any were opened, and no lingering capture. Restore access yourself for
   subsequent tests. Any system-only result is a separate scenario; never count
   a silent mic as success.
6. **Non-default meeting output:** leave Windows default output on device A and
   route meeting playback to device B. Run system-only capture and listen for the
   remote voice. Record the actual result and both routes. Support is unverified;
   do not claim Chromium follows B. A missing signal needs documented fallback
   evaluation before changing the capture design.
7. **Real call:** arrange Teams, Zoom or Meet with another person, use headphones,
   and inform participants before recording. Alternate local and remote speech.
   Validate both separate files and confirm the correct voice in each. This case
   passed with the later Google Meet acceptance pair; repeat it only for another
   configuration or a failed route/quality check.
8. **Video during the real call:** repeat with audible video playback on the
   default output. Confirm remote voice and playback in system.wav and clear
   local speech in mic.wav, without clipping or video bleed into mic.

After Stop, check the Windows microphone indicator stops and the capture windows
are gone. Also test unplug/track end and Quit while recording when practical:
expect an error or normal quit cleanup, usable finalized headers for received
frames, and no ongoing capture. A power loss is outside this cleanup guarantee.

| Scenario | Captured? | Mic ok | System ok | Streams separate | Intelligible | Distortion/clipping | WAVs valid | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Headphones | Yes | User confirmed clear | Signal present; explicit listening on this run pending | Mic isolation confirmed | Mic confirmed | Mic has 10 full-scale samples; system 0 | Format/lengths valid; strict mic quality check flags clipping | PARTIAL |
| Speakers | Yes | Voice plus acoustic speaker pickup | Playback confirmed | Separate files; acoustic bleed present | User heard both | No full-scale samples in this pair | Both pass | PARTIAL for isolation |
| Bluetooth headset | Yes, installed app | Clear | Clear | Correct files confirmed | Both confirmed | Zero full-scale output samples; mic input warning retained | Both pass | DONE for OnePlus Nord Buds 3 |
| Default output change | Yes, corrected retest | N/A | Stops on change | System only | Warning confirmed | Zero full-scale output samples | Finalized 3.592-second file passes; recovery capture also passes | DONE for tested switch |
| Mic denial | No audio, expected | Explicit denial confirmed | Separate test | N/A | N/A | N/A | Empty 44-byte finalized header, not speech evidence | DONE; user restored access On |
| Meeting on non-default output | Yes, primary and fallback | N/A for system-only test | Primary missed voice; selected-OnePlus fallback captured it | System only | Fallback voice clear, user confirmed | Primary one full-scale sample; fallback zero | Fallback strict validator passes | Primary FAIL; standalone fallback PASS |
| Google Meet real call | Yes | Clear, user confirmed | Clear, user confirmed | Separate files, correct content confirmed | Both confirmed | No reported distortion; output 0 full-scale; mic input 2 endpoint hits retained as warning | Both pass | DONE for this configuration |
| Video during Google Meet call | Yes | No unexpected bleed reported | Remote voice plus video confirmed in listening question | User confirmed correct files | Confirmed | Same pre-gain warning; output 0 full-scale | Both pass | DONE for this configuration |

Request an audio mentor to review the trusted loopback handler, source-bound IPC,
resampling, cleanup and the captured evidence. Mentor and team contract sign-off
remain PENDING REVIEW. The clean real-call WAV pair, Bluetooth, OS mic denial and
corrected output-switch/restart checks now pass for the recorded configurations.
Non-default meeting routing failed: user heard only the video and no remote Meet
voice. Its WAV also flags one full-scale sample. The later selected-output
fallback passes strict validation and user listening for the OnePlus route.
Mentor/team reviews remain pending. Phase 1 acceptance remains incomplete.

## Primary capture and fallback audit

The implemented primary path is the trusted Electron display-media handler with
Windows loopback for source 1, getUserMedia for source 0, one hidden window and
AudioWorklet per source, resampling to 16kHz mono Int16 and separate WAV writers.
Video is discarded immediately. No capture fallback is selected automatically.
Electron documents system loopback as a Windows audio grant; it does not establish
this repository's compatibility with every application/output route. See
[Electron session documentation](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).

**Fallback diagnostic implemented and physically validated for OnePlus.** The confirmed
non-default routing failure justifies a standalone selected-output diagnostic in
sidecar/loopback_fallback.py. PyAudioWPatch 0.2.12.9 is installed in the project
virtual environment. Read-only enumeration found OnePlus and Realtek loopbacks,
both 48 kHz stereo. Enumeration opens no audio stream. This diagnostic is neither
bundled nor automatically selected by Electron.

The [PyAudioWPatch project](https://github.com/s0d3s/PyAudioWPatch) exposes WASAPI
loopback endpoints, including lookup for a chosen output. The diagnostic requires
an exact current loopback name and a manual Start button. It captures native
float32 at the selected endpoint's rate/channels, downmixes, resamples offline
with scipy.signal.resample_poly and encodes unity-gain 16 kHz mono Int16. Its
result identifies only system source 1; it never opens a microphone. Capture is
bounded to 30 seconds, creates files exclusively and closes the stream before
conversion. Stream errors/overflow and insufficient frames fail explicitly;
received frames get a finalized partial WAV where possible. Unplug and real
Bluetooth configurations beyond the recorded OnePlus route remain physical
checks, not inferred from mocks.

Actual selected-OnePlus Google Meet recording on 26 November: 20 seconds,
320,000 samples, 16 kHz mono signed Int16, peak 0.957611084, RMS 0.081978658,
zero full-scale samples; unchanged strict validator passes. User confirmed clear
remote voice without distortion or missing sections. Evidence is preserved at
test_recordings/phase1-nondefault-fallback-20261126-215510/system_audio.wav.
This establishes the tested route, not a universal device-compatibility claim.

Run `python -m sidecar.loopback_fallback --list` to inspect endpoints without
recording. Then supply `--device-name` (exact displayed name), `--output` (a new
WAV path) and `--seconds 20`. A local window requires manual Start before capture.
The selected-output WAV records that endpoint only: simultaneous playback on
Realtek is intentionally outside a OnePlus-only diagnostic. It does not promise
capture from all render devices at once or hot switching during recording.

The existing speech engine accepts a finalized WAV path independently of capture.
A compliant alternative recorder can supply the same WAV contract without
rewriting SpeechEngine. That interface compatibility does not make fallback
selection implemented. If a required route loses/distorts audio, preserve the
failed evidence, review the fallback diagnostic and repeat the real-call check
before accepting that route. The current primary
capture method remains in place.
