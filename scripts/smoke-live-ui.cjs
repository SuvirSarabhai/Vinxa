const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { _electron } = require('playwright-core')
const { waitForSnapshot } = require('./smoke-helpers.cjs')

async function waitForRoute(desktop, route) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const page = desktop.windows().find((window) => window.url().endsWith(`#${route}`))
    if (page) return page
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`Window did not load: ${route}`)
}

async function main() {
  assert.equal(process.platform, 'win32', 'Synthetic speech generation uses Windows System.Speech')
  const profile = await mkdtemp(join(tmpdir(), 'vinxa-live-ui-'))
  const wav = join(profile, 'synthetic-speech.wav')
  const artifacts = resolve('release/stitch-ui')
  const report = {
    passed: false,
    physicalMicrophoneUsed: false,
    syntheticSpeech: true,
    cycles: 0,
    errors: []
  }
  let desktop
  try {
    await mkdir(artifacts, { recursive: true })
    await writeFile(
      join(profile, 'phase2-hotkeys.json'),
      JSON.stringify({ start: 'Ctrl+Alt+7', pause: 'Ctrl+Alt+8', stop: 'Ctrl+Alt+9' })
    )
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    await promisify(execFile)(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Speech
      $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
      try {
        $english = $voice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
        if ($english) { $voice.SelectVoice($english.VoiceInfo.Name) }
        $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
        $voice.SetOutputToWaveFile($env:VINXA_SYNTHETIC_WAV, $format)
        $voice.Speak('The meeting starts on Monday. We will review the project and confirm the next steps.')
      } finally { $voice.Dispose() }
    `
      ],
      { env: { ...process.env, VINXA_SYNTHETIC_WAV: wav }, windowsHide: true, timeout: 30000 }
    )
    const env = {
      ...process.env,
      VINXA_BACKEND: 'local',
      VINXA_SMOKE_USER_DATA: profile,
      VINXA_SIDECAR_SOURCE: resolve('.'),
      VINXA_SPEECH_MODEL: 'base.en',
      VINXA_SPEECH_LANGUAGE: 'en',
      HF_HUB_OFFLINE: '1'
    }
    for (const key of [
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RENDERER_URL',
      'VINXA_CAPTURE_TEST',
      'VINXA_DIAGNOSTICS_DIR',
      'VINXA_SPEECH_MODEL_PATH'
    ])
      delete env[key]
    desktop = await _electron.launch({
      executablePath: require('electron'),
      env,
      timeout: 30000,
      args: [
        resolve('.'),
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
        '--mute-audio'
      ]
    })
    desktop.on('window', (window) => window.on('pageerror', (error) => report.errors.push(error.message)))
    const page = await desktop.firstWindow()
    page.on('pageerror', (error) => report.errors.push(error.message))
    await page.getByRole('heading', { name: 'Your meetings, remembered.' }).waitFor()
    await waitForSnapshot(page, (value) => value.ready && value.engine.ready, 90000)
    assert.equal((await page.evaluate(() => window.vinxaPhase2.snapshot())).mode, 'local')
    await page.getByRole('button', { name: 'Start session', exact: true }).click()
    const setup = await waitForRoute(desktop, 'setup')
    await setup
      .getByRole('textbox', { name: 'Meeting title', exact: true })
      .fill('Synthetic speech integration check')
    await setup.getByRole('checkbox', { name: /Include system audio/ }).uncheck()
    await setup.getByRole('checkbox', { name: /I confirm that participants/ }).check()
    const started = performance.now()
    await setup
      .getByRole('button', { name: 'Confirm and start', exact: true })
      .click({ noWaitAfter: true })
      .catch((error) => {
        if (!setup.isClosed()) throw error
      })
    const overlay = await waitForRoute(desktop, 'overlay')
    await waitForSnapshot(
      page,
      (value) => value.segments.some((segment) => /meeting|monday|project|review|steps/i.test(segment.text)),
      60000
    )
    report.firstTranscriptAfterConfirmMs = Math.round(performance.now() - started)
    await overlay.locator('.segment').first().waitFor()
    await overlay.screenshot({ path: join(artifacts, 'overlay-live-synthetic.png') })
    console.log(
      'PASS: generated speech -> simulated microphone -> AudioWorklet -> IPC -> real Whisper -> redesigned overlay'
    )
    for (let cycle = 0; cycle < 3; cycle++) {
      await overlay.getByRole('button', { name: 'Pause', exact: true }).click()
      await overlay.locator('.status.paused').waitFor({ timeout: 35000 })
      const paused = await page.evaluate(() => window.vinxaPhase2.snapshot())
      assert.deepEqual(paused.levels, { mic: null, system: null })
      const before = JSON.stringify(paused.segments)
      await page.waitForTimeout(500)
      assert.equal(
        JSON.stringify((await page.evaluate(() => window.vinxaPhase2.snapshot())).segments),
        before
      )
      await overlay.getByRole('button', { name: 'Resume', exact: true }).click()
      await waitForSnapshot(
        page,
        (value) => value.state === 'recording' && value.segments.length > paused.segments.length,
        60000
      )
      report.cycles++
      console.log(
        `PASS: real capture Pause/Resume ${report.cycles}; microphone released and transcription continued`
      )
    }
    await overlay.getByRole('button', { name: 'Stop', exact: true }).click()
    await overlay.locator('.status.completed').waitFor({ timeout: 35000 })
    const finished = await page.evaluate(() => window.vinxaPhase2.snapshot())
    assert.equal(finished.error, null)
    assert.equal(finished.config.systemAudioEnabled, false)
    assert.equal(finished.pauses.length, 3)
    assert.ok(finished.segments.some((segment) => segment.isFinal))
    assert.deepEqual(report.errors, [])
    report.finalSegments = finished.segments.filter((segment) => segment.isFinal).length
    report.passed = true
    await page.screenshot({ path: join(artifacts, 'dashboard-live-synthetic.png'), fullPage: true })
    console.log('PASS: Stop finalized real synthetic speech without capture/clock/IPC errors')
  } catch (error) {
    report.failure = error.message
    if (desktop) {
      const page = desktop.windows().find((window) => !window.url().includes('/capture/'))
      if (page) {
        report.snapshot = await page.evaluate(() => window.vinxaPhase2?.snapshot()).catch(() => null)
        await page.screenshot({ path: join(artifacts, 'live-failure.png'), fullPage: true }).catch(() => {})
      }
    }
    throw error
  } finally {
    await desktop?.close()
    await writeFile(join(artifacts, 'live-report.json'), JSON.stringify(report, null, 2))
    assert.equal(dirname(resolve(profile)), resolve(tmpdir()))
    await rm(profile, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
