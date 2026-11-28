const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdir, mkdtemp, rm, writeFile, realpath, readFile } = require('node:fs/promises')
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
  const packaged = process.argv.includes('--packaged')
  const crash = process.argv.includes('--crash')
  const artifacts = resolve(packaged ? 'release/phase4-live' + (crash ? '-recovery' : '') : 'release/stitch-ui')
  const report = {
    passed: false,
    packaged, crash, physicalMicrophoneUsed: false,
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
    if (packaged) delete env.VINXA_SIDECAR_SOURCE
    const launchOptions = {
      executablePath: packaged ? resolve('release/win-unpacked/Vinxa Desktop.exe') : require('electron'),
      env,
      timeout: 30000,
      args: [
        ...(packaged ? ['--user-data-dir=' + profile, '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=localhost;127.0.0.1;[::1]'] : [resolve('.')]),
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
        '--mute-audio'
      ]
    }
    desktop = await _electron.launch(launchOptions)
    assert.equal(await realpath(await desktop.evaluate(({app}) => app.getPath('userData'))), await realpath(profile))
    desktop.on('window', (window) => window.on('pageerror', (error) => report.errors.push(error.message)))
    const page = await desktop.firstWindow()
    page.on('pageerror', (error) => report.errors.push(error.message))
    await page.getByRole('heading', { name: 'Your meetings, remembered.' }).waitFor()
    await waitForSnapshot(page, (value) => value.ready && value.engine.ready, 90000)
    assert.equal((await page.evaluate(() => window.vinxaPhase2.snapshot())).mode, 'local')
    if (process.env.VINXA_SMOKE_NOTES_MODEL) {
      await page.evaluate(async model => {
        const { apiKeyConfigured, ...settings } = await window.vinxaMeetings.settings()
        await window.vinxaMeetings.saveSettings({ ...settings, provider:'ollama', cloudEnabled:false, ollamaModel:model, timeoutSeconds:300 })
      }, process.env.VINXA_SMOKE_NOTES_MODEL)
    }
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
    if (crash) {
      const committed = await waitForSnapshot(page, value => value.segments.some(s => s.isFinal), 90000)
      const id = committed.sessionId
      const before = await page.evaluate(id => window.vinxaMeetings.get(id), id)
      assert.ok(before.transcript.length > 0, 'Expected at least one committed segment before terminating')
      const child = desktop.process()
      const exited = new Promise(resolveExit => child.once('exit', resolveExit))
      await promisify(execFile)(join(process.env.SystemRoot, 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true,timeout:15000})
      await exited
      // Windows can briefly retain Chromium's profile lock after an abrupt exit.
      desktop = undefined
      const deadline = Date.now() + 45000
      let recovered
      while (!recovered) {
        await new Promise(resolveWait => setTimeout(resolveWait, 1500))
        try {
          desktop = await _electron.launch(launchOptions)
          recovered = await desktop.firstWindow()
        } catch (error) {
          await desktop?.close().catch(() => {})
          desktop = undefined
          if (Date.now() >= deadline || !/has been closed|ECONNRESET|ECONNREFUSED|socket hang up/i.test(error.message)) throw error
        }
      }
      await recovered.getByRole('button', {name:'Library',exact:true}).click()
      await recovered.getByRole('button', {name:'Open meeting',exact:true}).click()
      await recovered.getByRole('button', {name:'Recover meeting',exact:true}).click()
      await recovered.getByText(/Committed meeting data recovered/).waitFor()
      const notesDeadline = Date.now() + 650000
      let detail = await recovered.evaluate(id => window.vinxaMeetings.get(id), id)
      while (env.VINXA_SMOKE_NOTES_MODEL && ['pending','processing'].includes(detail.meeting.notesStatus) && Date.now() < notesDeadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 1000))
        detail = await recovered.evaluate(id => window.vinxaMeetings.get(id), id)
      }
      for (const segment of before.transcript) assert.ok(detail.transcript.some(s => s.id === segment.id && s.text === segment.text))
      assert.equal(detail.meeting.recordingStatus, 'completed')
      const audio = await readFile(detail.meeting.microphoneAudioPath)
      assert.ok(audio.length > 44)
      assert.equal(audio.readUInt32LE(40), audio.length - 44)
      report.notesStatus = detail.meeting.notesStatus
      if (env.VINXA_SMOKE_NOTES_MODEL) assert.equal(report.notesStatus, 'completed', detail.meeting.notesMessage)
      report.recoveredSegments = detail.transcript.length
      report.passed = true
      console.log('PASS: process termination during recording, restart, committed text, repaired audio and recovered notes')
      return
    }
    const cycles = packaged ? 1 : 3
    for (let cycle = 0; cycle < cycles; cycle++) {
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
    await overlay.locator('.status.completed').waitFor({ timeout: process.env.VINXA_SMOKE_NOTES_MODEL ? 650000 : 35000 })
    const finished = await page.evaluate(() => window.vinxaPhase2.snapshot())
    assert.equal(finished.error, null)
    assert.equal(finished.config.systemAudioEnabled, false)
    assert.equal(finished.pauses.length, cycles)
    assert.ok(finished.segments.some((segment) => segment.isFinal))
    assert.deepEqual(report.errors, [])
    report.finalSegments = finished.segments.filter((segment) => segment.isFinal).length
    await page.evaluate(()=>window.vinxaPhase2.command({type:'open-library'}))
    await page.bringToFront()
    await page.screenshot({ path: join(artifacts, 'dashboard-live-synthetic.png'), fullPage: true })
    console.log('PASS: Stop finalized real synthetic speech without capture/clock/IPC errors')
    let saved = await page.evaluate(id => window.vinxaMeetings.get(id), finished.sessionId)
    const notesDeadline = Date.now() + 650000
    while (process.env.VINXA_SMOKE_NOTES_MODEL && ['pending', 'processing'].includes(saved.meeting.notesStatus) && Date.now() < notesDeadline) {
      await page.waitForTimeout(500)
      saved = await page.evaluate(id => window.vinxaMeetings.get(id), finished.sessionId)
    }
    assert.equal(saved.meeting.recordingStatus, 'completed')
    assert.equal(saved.transcript.length, report.finalSegments)
    assert.ok(saved.meeting.microphoneAudioPath)
    assert.equal(saved.meeting.systemAudioPath, null)
    report.notesProvider = process.env.VINXA_SMOKE_NOTES_MODEL ? 'live Ollama' : 'unconfigured'
    report.notesStatus = saved.meeting.notesStatus
    if (process.env.VINXA_SMOKE_NOTES_MODEL) assert.equal(saved.meeting.notesStatus, 'completed', saved.meeting.notesMessage)
    await desktop.close()
    desktop = await _electron.launch(launchOptions)
    const restarted = await desktop.firstWindow()
    await restarted.getByRole('button', { name:'Library', exact:true }).click()
    await restarted.getByRole('button', { name:'Open meeting', exact:true }).click()
    const restored = await restarted.evaluate(id => window.vinxaMeetings.get(id), finished.sessionId)
    assert.deepEqual(restored, saved)
    await restarted.getByRole('tab', {name:'Transcript',exact:true}).click()
    assert.equal(await restarted.locator('.saved-transcript .segment').count(), report.finalSegments)
    if (packaged) {
      const query = saved.transcript[0].text.match(/[a-z]{3,}/i)[0]
      const hits = await restarted.evaluate(query => window.vinxaMeetings.search(query), query)
      assert.ok(hits.some(hit => hit.segmentId === saved.transcript[0].id))
      if (saved.insights?.summary) {
        const word = saved.insights.summary.match(/[a-z]{3,}/i)[0]
        const notes = await restarted.evaluate(query => window.vinxaMeetings.search(query), word)
        assert.ok(notes.some(hit => hit.category === 'Summary' && saved.transcript.some(s => s.id === hit.segmentId)))
      }
      for (const [format, file] of [['markdown','live.md'], ['pdf','live.pdf']]) {
        const path = join(artifacts, file)
        await desktop.evaluate(({dialog}, path) => { dialog.showSaveDialog=async()=>({canceled:false,filePath:path}) },path)
        const result = await restarted.evaluate(input => window.vinxaMeetings.exportMeeting(input), {id:finished.sessionId,format})
        assert.equal(result.path,path)
        assert.ok((await readFile(path)).length>100)
      }
      const status = await restarted.evaluate(() => window.vinxaMeetings.status())
      assert.equal(status.localOnly,true)
      assert.equal(status.allowedCloud,0)
      await desktop.evaluate(({dialog}) => {dialog.showMessageBox=async()=>({response:1,checkboxChecked:false})})
      await restarted.getByRole('button',{name:'Delete meeting',exact:true}).click()
      await restarted.getByText('Meeting permanently deleted.',{exact:true}).waitFor()
      assert.deepEqual(await restarted.evaluate(query=>window.vinxaMeetings.search(query),query),[])
      const consent = await readFile(join(profile,'consent-events.jsonl'),'utf8')
      assert.equal(consent.includes(finished.sessionId),false)
      report.localOnlySearchExportDelete = true
    }
    report.restartPersistence = true
    report.passed = true
    console.log('PASS: real captured transcript, audio path, and notes status survived Electron restart')
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
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
