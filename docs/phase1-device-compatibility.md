# Phase 1 device compatibility

Date: 26 November 2026. Hardware results below are limited to actual existing
recordings and user confirmations. New gain and real-call results will be added
only after capture, strict validation and listening. Windows microphone levels
and privacy permissions are changed manually by the operator.

## Existing evidence

Configuration: Windows 11 Home Single Language, build 10.0.26300; i7-13620H.
Exact microphone/headphone model names and Windows input level were not recorded.
Headphone use does not prove a headset microphone was selected.

| Test | Actual result | Status |
| --- | --- | --- |
| Individual microphone | User confirmed clear speech; prior 7.090625-second WAV passed strict validation | PASS |
| Individual default-output playback | User confirmed clear audio; 18.36-second WAV had two full-scale samples | FAIL for strict clean-audio criterion |
| Speakers, simultaneous capture | Two valid 14.4-second WAVs with no full-scale samples; mic heard voice plus acoustic speaker pickup, system heard playback | PASS for capture; isolation is limited by acoustic pickup |
| Headphones, simultaneous capture | Separate 25.4213125-second files; user confirmed clear mic voice without video bleed | PASS for the confirmed mic listening/isolation check |
| Headphone microphone quality | 406,741 samples; 10 negative full-scale samples, zero positive; peak 1.0, RMS 0.067071; 0.00245857% full scale | FAIL for strict clean-audio criterion |
| Headphone system WAV | Same sample count/duration; zero full-scale samples, peak 0.363617, RMS 0.042978; strict validator passes | PASS for file quality; explicit listening on this exact run still required |
| Google Meet real call plus video | 29.9813125-second separate WAVs, strict validation passes with zero output full-scale samples; user confirmed both clear and in correct files | PASS |

The original full-scale samples occur between 6.143625 and 6.245750 seconds.
Their upstream cause cannot be recovered from a clamped WAV. No explicit gain,
normalizer, second mic path or system-to-mic software mix was found in the old
code. Windows input gain, browser processing and resampler overshoot require
fresh pre-gain measurements to distinguish.

## Common capture procedure

Use headphones for isolation. Select the intended input/output in Windows before
launch. Inform participants. Use a new local scenario directory so old WAVs remain
untouched. Quit other Vinxa instances. The existing diagnostic lasts at most
30 seconds, stops both sources together and does not establish a synchronized
meeting timeline.

The finalization adds VINXA_MIC_GAIN (default 0.75; 0.1–1.0),
VINXA_CAPTURE_DIR and VINXA_CAPTURE_ACCEPTANCE=1. The latest changes passed 69
TypeScript tests, typecheck and production build. Launch from the repository root:

```powershell
pnpm build
$env:VINXA_CAPTURE_TEST = 'both'
$env:VINXA_MIC_GAIN = '0.75'
$env:VINXA_CAPTURE_DEBUG = '1'
$env:VINXA_CAPTURE_ACCEPTANCE = '1'
$env:VINXA_CAPTURE_DIR = Join-Path $PWD ('test_recordings/acceptance-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
& .\node_modules\electron\dist\electron.exe .
```

Confirm Start yourself. Speak normally, include a slightly louder sentence, then
alternate silence with playback. Stop and validate microphone.wav and
system_audio.wav in the displayed directory. The strict validator remains
unchanged and rejects any full-scale samples. Listen to each file separately.
Retain capture-debug.log locally for aggregate pre-gain statistics, not transcript
content. Do not upload or commit recordings/logs.

```powershell
node scripts/validate-wav.mjs "$env:VINXA_CAPTURE_DIR/microphone.wav"
node scripts/validate-wav.mjs "$env:VINXA_CAPTURE_DIR/system_audio.wav"
Remove-Item Env:VINXA_CAPTURE_TEST,Env:VINXA_MIC_GAIN,Env:VINXA_CAPTURE_DEBUG,Env:VINXA_CAPTURE_ACCEPTANCE,Env:VINXA_CAPTURE_DIR
```

A lower output peak alone does not establish repaired input audio. If raw input
reaches full scale or listening reveals distortion, lower the selected Windows
microphone's Input volume, remove unnecessary device boost if available, increase
mouth-to-microphone distance and repeat with a fresh file. Do not post-process the
old clipped WAV and report a new capture. Windows input controls and its local
test/playback procedure are described by [Microsoft](https://support.microsoft.com/en-us/windows/hardware/drivers/fix-microphone-problems).

## Required compatibility matrix

### A. Bluetooth headset

- **Configuration:** record headset model, Bluetooth input/output names, selected
  hands-free/stereo profile if shown, meeting app and Windows default routes.
- **Procedure:** manually select the Bluetooth microphone and output; capture
  alternating local speech and playback. Repeat after selecting a different
  device; do not infer that selecting headphones changed the microphone.
- **Expected:** correct mic source and audible system output in separate valid
  WAVs; any disconnect/device change stops or warns according to current logic.
  No hidden fallback or silent continuation with the wrong source.
- **Actual:** user confirmed OnePlus Nord Buds 3 headset mic selected in Windows
  Input and earbuds selected for Output. The latest installed app recorded both
  sources normally after the output-change stop. Files in
  test_recordings/phase1-bluetooth-20261126-212302 pass strict validation:
  microphone 358,869 samples / 22.4293125 s, peak 0.747620, RMS 0.044191;
  system 359,381 samples / 22.4613125 s, peak 0.873199, RMS 0.062985.
  Both are 16kHz mono Int16 with zero full-scale output samples. Mic worklet
  input touched full scale twice; the existing upstream headroom warning remains.
  Exact negotiated Bluetooth profile/device IDs were not logged; selection is
  based on the user's Windows confirmation. User then listened and confirmed
  clear speech in microphone.wav and clear video in system_audio.wav without
  unexpected bleed, distortion or missing audio. The temporary installed app was
  removed through its uninstaller after testing (exit 0, executable removed).
- **Status:** **PASS** for the selected OnePlus configuration and tested switching
  path; this does not certify every Bluetooth profile/headset.
- **Limitations:** default-device acquisition only; no new app device picker.
  Profile changes may alter quality; record the observed behavior.

### B. Microphone permission denial

- **Configuration:** record selected mic, Windows microphone/desktop-app access
  settings and whether the app was launched from development or installed build.
- **Procedure:** operator manually denies access in Windows; launch mic-only
  diagnostic in a fresh directory, confirm the test, observe its error and check
  Windows recording indicator. Restore access manually before other tests.
- **Expected:** useful permission-denied error; no crash, active track or lingering
  capture window; files opened before acquisition are finalized, not counted as
  successful recordings.
- **Actual:** user turned Windows desktop microphone access Off, started the
  packaged mic-only diagnostic and confirmed the error "Microphone permission
  was denied". Local evidence:
  test_recordings/phase1-permission-denial-20261126-213138. microphone.wav is
  exactly 44 bytes: RIFF length 36, data length 0, zero samples, 16kHz/mono/16-bit.
  The debug log reaches requesting stream but never stream acquired or audio
  context running. The app process remained alive with the Vinxa Desktop window.
  This empty header is expected denial evidence, not a successful audio WAV.
  User then confirmed desktop microphone access restored On.
- **Status:** **PASS** for the tested Windows desktop-access denial and cleanup.
- **Limitations:** do not disable global privacy controls while a real call needs
  the mic; desktop-app settings may affect other desktop apps too.

### C. Default output changes

- **Configuration:** screenshot showed Headphones (OnePlus Nord Buds 3) as the
  default and Speaker (2-Realtek(R) Audio) as a separate enabled endpoint.
- **Procedure:** start playback on A and system-only capture, then manually change the
  Windows default to B. Observe warning/stop, validate received files and verify
  indicators clear. Relaunch on B and confirm its playback is captured.
- **Expected:** default-output monitoring stops capture and warns;
  queued audio is finalized and resources are released. Recovery is a fresh
  capture after checking routes, not seamless live migration.
- **Actual:** the earlier -205049 attempt saved nothing. The later
  test_recordings/phase1-output-change-20261126-205825 attempt saved a valid
  13.952-second system_audio.wav with peak 0.859283, RMS 0.053510 and zero
  full-scale samples. User reported no warning after switching. The first roughly
  five seconds have signal; subsequent one-second windows have RMS zero. That is
  consistent with lost playback after the switch, but exact switch timing was
  not independently measured. The browser-only guard failed this physical check.
- **Retest:** corrected packaged app, directory
  test_recordings/phase1-output-change-fixed-20261126-211438. User confirmed the
  warning. Native log records default-output-changed; the finalized WAV passes
  strict validation: 57,472 samples, 3.592 s, peak 0.372406, RMS 0.052916 and
  zero full-scale samples. The native guard is evidenced directly by the log.
  A subsequent installed-app Bluetooth dual capture on the selected earbuds output
  started and finalized normally with both WAVs valid; this establishes restart
  and file recovery. User listening also confirmed correct clear playback in
  case A, completing recovery on this new selected output.
- **Status:** **PASS** for detection, warning, file finalization and subsequent
  capture on the earbuds output. Broader device configurations remain untested.
- **Fix:** main now runs a read-only Windows Core Audio monitor of default render
  endpoint IDs for all three roles every 250 ms. IDs stay private in its helper;
  only ready/heartbeat/changed/error statuses cross its pipe. A change, monitor
  failure or lost heartbeat stops capture with an error. The renderer also now
  stops immediately on system devicechange before any potentially stalled hidden
  document enumeration. The exact Chromium event/enumeration failure stage was
  not instrumented in the failed build, so it is not asserted as proven.
- **Limitations:** polling can miss an away-and-back transition shorter than its
  interval. Any default render-role change stops capture conservatively. Browser
  devicechange may also represent an unrelated change. Recovery is restart on
  the verified new output, not seamless routing.

### D. Meeting on a non-default output

- **Configuration:** Windows default output A; meeting remote voice routed to B;
  record both exact device names and meeting app/version.
- **Procedure:** use a real remote speaker, choose B in the meeting app, keep A as
  default, capture system audio and listen. Repeat with B made Windows default.
  Compare received remote speech and missing sections, rather than nonzero data.
- **Expected:** report observed routing. Never assume default loopback captures
  every output. Missing/incomplete B audio blocks support for this configuration.
- **Actual:** user configured Windows Realtek output and Google Meet OnePlus
  output, then confirmed the system-only recording finished normally. Evidence:
  test_recordings/phase1-nondefault-output-20261126-213749/system_audio.wav.
  Duration 26.930625 s / 430,890 samples, peak 0.9999694824, RMS 0.0402285436.
  Strict validation flags one full-scale output sample. Most one-second windows
  after ten seconds have RMS about 0.000014–0.000017. Whether this represents
  missing remote speech cannot be established solely from these levels. User
  listening subsequently confirmed **only the video**, with the remote Meet
  voice absent. This is a confirmed routing failure, independently of clipping.
  A standalone selected-output PyAudioWPatch diagnostic is now implemented in
  sidecar/loopback_fallback.py. Read-only enumeration found OnePlus and Realtek
  loopback endpoints, both 48 kHz stereo. The user then manually started a real
  Meet capture of the exact OnePlus loopback while Windows remained on Realtek.
  Fallback evidence: test_recordings/phase1-nondefault-fallback-20261126-215510/
  system_audio.wav. It has 320,000 samples / 20 seconds, 640,044 bytes,
  peak 0.957611084, RMS 0.081978658 and zero full-scale samples. The unchanged
  src/main/audio/wav-validation.ts validator passes. SHA-256:
  07c1b9a3e1be8a3e9722f5ca00068c06f811877c7c9bbe14ea01ea065e245fb9.
  User confirmed the other person's voice clear without distortion or missing
  sections. No microphone stream was opened; the native stream closed and
  PyAudio terminated before the saved-result message.
- **Status:** **FAIL** for the primary non-default route and saved-file strict
  quality check (one full-scale sample). **PASS** for the selected-OnePlus
  fallback capture, strict validation and user listening. Primary Electron
  capture is unchanged; automatic integration is not implemented.
- **Limitations:** primary handler grants generic Windows loopback, not an
  arbitrary per-application output selector.

### E. Real Teams/Zoom/Meet call with video

- **Configuration:** record app/version, headphones/mic models, Windows routes,
  physical input level and configured app mic gain. Inform the other person.
- **Procedure:** in one 25–30-second dual capture: local speech alone for roughly
  0–8 seconds; remote speech alone for 8–16 seconds; remote speech with audible
  video for 16–24 seconds; then stop. Keep timestamps approximate because sources
  acquire independently. Note any missing or distorted sections while listening.
- **Expected:** microphone.wav contains intelligible local voice; system_audio.wav
  contains intelligible remote voice and video; both strict validators pass,
  proper 16kHz/mono/16-bit format and plausible duration; no unexpected mic bleed.
- **Actual:** Google Meet recording completed. At gain 0.75, microphone.wav peak
  0.749481/RMS 0.051941; system_audio.wav peak 0.869812/RMS 0.098798. Both contain
  479,701 samples over 29.9813125 s and zero full-scale PCM samples. User confirmed
  both clear, correct sources and no unexpected bleed/distortion/missing sections
  in response to the question explicitly including remote voice and video.
  Local files: test_recordings/phase1-real-call-20261126-204045. Physical device
  model and Windows input level were not reported. Mic worklet input touched
  full scale twice before application gain; that warning remains documented.
- **Status:** **PASS** for the recorded Google Meet configuration and user-confirmed
  listening, not general compatibility with every device/output route.

## Result entry template

For every attempt record: test name; date; app/build; device names and routes;
Windows input level; app gain; exact file paths locally; duration/sample count;
peak/RMS; positive/negative full-scale counts and percentage; pre-gain statistics;
listening observations; warning/error; cleanup; PASS/FAIL/BLOCKED/REQUIRES MANUAL
TEST; operator. Human review uses PENDING REVIEW until signed.

Do not treat synthetic unit/smoke fixtures as Bluetooth, permission, routing or
real-call evidence. Mentor review is recorded separately in
[phase1-contract-review.md](phase1-contract-review.md).
