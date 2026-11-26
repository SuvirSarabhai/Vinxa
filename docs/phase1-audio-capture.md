# Phase 1 audio capture

Developer B's Stages 1 and 2 add microphone and Windows loopback diagnostics to the existing desktop shell.
The test is started explicitly and asks for confirmation before audio access.
Implementation and hardware verification are tracked separately below.

## Status and evidence

| Item | Status | Evidence |
| --- | --- | --- |
| Branch | DONE | navya, with Developer A commit 9892b7a included |
| Baseline typecheck, tests, production build | DONE | Before microphone changes, 2 test files and 6 tests passed |
| Microphone implementation | DONE | Generated-device smoke passes. Physical microphone produced a valid WAV and the user confirmed clear speech. |
| PCM conversion | DONE | Synthetic tests cover 48 kHz stereo 1 kHz tone, 44.1 kHz and other rates, continuity, downmix, silence, anti-alias filtering, clipping and frames |
| WAV writer and validator | DONE | Tests cover duration, interrupted header, final trim, existing file preservation, bounded queue and invalid WAVs |
| Cleanup logic | DONE | Mocked renderer tests cover stop, denied permission and cancellation during device acquisition; worklet tests cover acknowledgements and overflow |
| Current automated checks | DONE | pnpm typecheck and pnpm build passed; pnpm test reported 7 files and 34 tests passed |
| Generated microphone Electron smoke | DONE | After the user changed Windows application detection, Electron launched. Latest run produced a valid 4.16-second WAV with 66,560 samples at 16 kHz, mono, 16-bit, RMS 0.096657 and zero full-scale samples. Hidden capture window was destroyed. |
| App launch and sample-player runtime regression | PARTIAL | App, preload bridge, partial/final sample playback, pause/resume/reset and close-to-tray passed. Second-instance launch exits with Windows code 2147483651. The same failure was reproduced using Developer A's original main from commit 9892b7a. |
| Physical microphone WAV and listening | DONE | mic.wav has 113,450 samples, duration 7.090625 seconds, peak 0.247192 and zero clipped samples. User confirmed the microphone is clear. |
| Permission denial, unplug and default input change on hardware | MANUAL-PENDING | Error paths implemented; real-device behavior awaits testing |
| Installer rebuild and installed app smoke | BLOCKED | Dependency install failed because node-gyp cannot find Visual Studio C++ build tools. Electron application detection no longer blocks launch. |
| Local commit | DONE | Stage 1 is recorded as 2c8751a. Stage 2 is committed locally after automated and controlled Windows loopback tests. |
| System audio implementation | DONE | Trusted display-capture handler grants a screen source and Windows loopback. Video track is stopped immediately. Controlled default-output tone was captured successfully. |
| Simultaneous generated input test | DONE | node scripts/smoke-microphone.cjs both passed with two distinct 4.992-second WAVs. Each has 79,872 samples at 16 kHz, mono, 16-bit, and zero clipped samples. Windows loopback compatibility requires the manual test. |
| User system playback recording | PARTIAL | system.wav contains 293,760 samples over 18.36 seconds at 16 kHz, mono, 16-bit. RIFF and data lengths match. RMS is 0.093222. Strict validation flags 2 full-scale samples (0.000681 percent). Listening confirmation is pending. |
| Real-call dual capture | MANUAL-PENDING | Awaiting simultaneous physical microphone and system capture and separate listening checks |
| Speech benchmarks | MANUAL-PENDING | Later stages need implementation and approval |

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

Packaging and Developer A's packaged smoke remain separate checks after full native
dependency setup succeeds.

## Manual results to complete

| Scenario | Captured | WAV valid | Intelligible | Cleanup observed | Status |
| --- | --- | --- | --- | --- | --- |
| Default microphone, ordinary speech | Yes | Yes | User confirmed clear | Capture finalized | DONE |
| Headset microphone | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Bluetooth microphone | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Windows microphone access denied | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Microphone unplugged during capture | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Default microphone changed during capture | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Quit while recording | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Default output playback recording | Yes | Format and lengths valid; 2 full-scale samples flagged | Pending | WAV finalized | PARTIAL |
| System audio through default speakers | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| System audio through headphones | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Default output changed during capture | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Meeting app on a non-default output | Pending | Pending | Pending | Pending | MANUAL-PENDING |
| Real call with simultaneous mic and system | Pending | Pending | Pending | Pending | MANUAL-PENDING |

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
and the second interval in system.wav. These real-device results remain pending.

Any devicechange event during system capture stops the test and warns to check the
Windows default output before repeating. This conservative response includes unrelated
device changes because browser device enumeration does not prove which Windows output
the loopback backend followed. Meeting audio routed to a non-default output must be
tested explicitly. No compatibility claim is made for that case yet.

A physical device selector, local models and Phase 2 streaming remain later work.

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
Video playback, listening quality, non-default output routing and real-call dual
capture remain manual checks.

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
