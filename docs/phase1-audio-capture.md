# Phase 1 microphone capture

Developer B's Stage 1 adds a microphone diagnostic to the existing desktop shell.
The test is started explicitly and asks for confirmation before microphone access.
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
| Current automated checks | DONE | pnpm typecheck and pnpm build passed; pnpm test reported 6 files and 23 tests passed |
| Generated microphone Electron smoke | DONE | After the user changed Windows application detection, Electron launched. Latest run produced a valid 4.16-second WAV with 66,560 samples at 16 kHz, mono, 16-bit, RMS 0.096657 and zero full-scale samples. Hidden capture window was destroyed. |
| App launch and sample-player runtime regression | PARTIAL | App, preload bridge, partial/final sample playback, pause/resume/reset and close-to-tray passed. Second-instance launch exits with Windows code 2147483651. The same failure was reproduced using Developer A's original main from commit 9892b7a. |
| Physical microphone WAV and listening | DONE | mic.wav has 113,450 samples, duration 7.090625 seconds, peak 0.247192 and zero clipped samples. User confirmed the microphone is clear. |
| Permission denial, unplug and default input change on hardware | MANUAL-PENDING | Error paths implemented; real-device behavior awaits testing |
| Installer rebuild and installed app smoke | BLOCKED | Dependency install failed because node-gyp cannot find Visual Studio C++ build tools. Electron application detection no longer blocks launch. |
| Local commit | DONE | Stage 1 is recorded locally after the microphone tests passed. The existing second-instance issue is documented separately. |
| System capture, dual capture and speech benchmarks | MANUAL-PENDING | Later stages need separate implementation and approval |

## Integration and files

- src/shared/contracts.ts retains the existing contracts and adds CaptureBridge. Source IDs are microphone 0 and system 1 as requested.
- src/shared/ipc-channels.ts adds capture:ready, capture:frame, capture:finished and capture:stop.
- src/shared/schemas.ts validates the completion error and final padding count. src/shared/pcm.ts validates tagged frame lengths and source IDs.
- src/main/audio/microphone-test.ts manages the explicit Start prompt, hidden capture window, microphone-only permission handlers, startup and stop deadlines, and Stop dialog.
- src/renderer/capture/capture.ts acquires getUserMedia audio, connects the worklet, forwards frames and cleans up tracks, context and nodes. Device disappearance or track end stops the test with an error.
- src/renderer/capture/worklet.ts runs PCM conversion off the UI thread. Four outstanding frames are allowed. If the consumer falls behind, capture fails visibly.
- src/shared/pcm.ts averages input channels and uses a streaming windowed-sinc low-pass filter to resample the actual native AudioContext rate to 16 kHz.
- src/main/audio/wav-writer.ts writes an exclusive new file, checks free disk space before capture and every five seconds of audio, updates the header after each frame, and finalizes on stop. It reserves 16 MiB and enforces the RIFF size limit.
- src/main/audio/wav-validation.ts and scripts/validate-wav.mjs check RIFF/chunk lengths, PCM encoding, 16 kHz, mono, 16 bits, sample count, duration, silence and full-scale samples.
- electron.vite.config.ts adds the capture HTML entry. The existing app page, tray controls and installer configuration retain their existing behavior.
- scripts/smoke-microphone.cjs exercises a generated Chromium microphone in an isolated temporary recording folder. Native prompts are simulated for that test only.
- scripts/smoke.cjs accepts an optional application entry argument to run the existing regression checks against the development Electron executable. The existing packaged executable command is preserved.

## PCM and IPC format

Every worklet message carries a 3,201-byte ArrayBuffer. Byte 0 is the source ID.
The remaining 3,200 bytes are 1,600 signed little-endian Int16 mono samples at
16,000 Hz. The first stage accepts source 0 only. No microphone audio is mixed
with another stream or played back through the speakers.

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

Confirm Start microphone test. Speak for ten seconds and then click Stop recording.
The automatic limit is 30 seconds after the capture renderer is ready. The output is
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

This diagnostic captures the default microphone. A physical device selector, system
audio, speaker separation tests, local models and Phase 2 streaming remain later work.
