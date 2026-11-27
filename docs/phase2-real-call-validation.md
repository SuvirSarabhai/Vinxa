# Phase 2 fresh call validation

Status MANUAL-PENDING. Developer B deferred testing to the final Phase 2 validation pass. Each physical-call criterion is REQUIRES MANUAL TEST until Developer B supplies results. The replay reports provide automated pipeline evidence.

## Consolidated final test pass

Complete implementation and merge the required Developer A recording flow before the final end-to-end gate. Then run one combined validation pass.

1. Run the Python and TypeScript suites, typecheck, build and schema check listed in phase2-developer-b-final-report.md.
2. Run the saved dual-source replay three times and keep every report.
3. Run the real Electron startup smoke and confirm warmed readiness and clean quit.
4. Perform the fresh physical call below.
5. Check Developer A's overlay, hotkeys, consent and recording indicators.
6. Verify the chosen installed runtime/model layout on the target machine.
7. Record PASS, FAIL or REQUIRES MANUAL TEST for every criterion.

## Run the live diagnostic

Use a fresh Teams, Zoom or Meet call with another participant. Use headphones, route the call through Windows default output, and tell the participant before recording. The existing diagnostic asks for consent and stops after 30 seconds.

Run these commands from D:/vinxa/Vinxa in PowerShell. The chosen directory is new for each run so earlier recordings remain available.

    pnpm build
    $taskRunDir = Join-Path $env:TEMP ('vinxa-phase2-call-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $taskRunDir | Out-Null
    $env:VINXA_CAPTURE_TEST = 'both'
    $env:VINXA_CAPTURE_SPEECH = '1'
    $env:VINXA_CAPTURE_DEBUG = '1'
    $env:VINXA_DIAGNOSTICS_DIR = $taskRunDir
    $env:VINXA_CAPTURE_DIR = $taskRunDir
    pnpm exec electron .

Select Start audio test in the consent dialog. Wait for the recording dialog. Alternate five seconds of your own speech and five seconds of remote speech, include one short interruption, and play video audio through the call or default output. Let the diagnostic finish after 30 seconds. Choose Quit from the tray to flush the sidecar and main-process numeric reports, then inspect both WAVs and the numeric diagnostics.

The diagnostic forwards real transcript events into the existing main-window transcript subscription. Overlay, hotkeys, consent-owner state and recording indicators require Developer A's recording flow. The current preview shell is a development surface. Complete the overlay-specific items after that integration is available.

After the diagnostic process exits, clear its environment flags before the next normal app launch.

    Remove-Item Env:VINXA_CAPTURE_TEST,Env:VINXA_CAPTURE_SPEECH,Env:VINXA_CAPTURE_DEBUG,Env:VINXA_CAPTURE_DIR,Env:VINXA_DIAGNOSTICS_DIR -ErrorAction SilentlyContinue

## Physical call checklist

- [ ] Mic partials appear while you speak.
- [ ] System partials appear while the remote participant speaks.
- [ ] Both sources produce final segments.
- [ ] Mic is labelled You and system is labelled Remote.
- [ ] Partial revisions replace the row with the same ID.
- [ ] Final segments retain their committed text and do not duplicate.
- [ ] Empty cancellation finals remove provisional rows in the integrated renderer.
- [ ] Pausing stops forwarding audio and resuming establishes fresh measured anchors.
- [ ] Timing survives worklet, IPC, manager and sidecar with monotonic sequence numbers.
- [ ] Accepted samples equal processed samples plus explicit drops, padding and pending samples.
- [ ] Every drop has a cause, and unexplained samples are zero.
- [ ] The overlay receives the same transcript events through Developer A's bridge adoption.
- [ ] Start, pause and stop hotkeys work while another application has focus.
- [ ] Consent and active or paused indicators follow Developer A's flow.

## Timing interpretation

Physical capture timestamps estimate when input samples reach the audio rendering graph. The internal uncertainty includes renderer/main clock-exchange error, graph timing and observed clock residual. Hardware input latency is unmeasured. Preserve this limitation when reporting capture-to-text latency.

The replay capture timestamp represents a simulated acquisition schedule. Fresh-call and replay outcomes are recorded separately in the final report.

## Report results

Send the date, meeting app, output device, whether the remote call included video, and PASS or FAIL for each checklist item. Include the diagnostic directory and any observed delay, missing source, duplicate row or reported gap. Keep participant audio and transcript text private.

## Installed runtime check

Installed builds need a bundled sidecar runtime or an explicit source and interpreter configuration. The current installer configuration has no sidecar resource entry. A developer-installed build can use these explicit external paths after its main bundle has been rebuilt.

    $env:VINXA_SIDECAR_SOURCE = 'D:/vinxa/Vinxa'
    $env:VINXA_SIDECAR_PYTHON = 'D:/vinxa/Vinxa/.venv/Scripts/python.exe'

A clean-machine bundled runtime and model install remains an integration check. The backend service emits a safe error status when the runtime or cached model is unavailable.
