const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { _electron } = require('playwright-core')
const { waitForSnapshot } = require('./smoke-helpers.cjs')

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'vinxa-stitch-ui-'))
  const artifacts = resolve('release/stitch-ui')
  await mkdir(artifacts, { recursive: true })
  const testBindings = { start: 'Ctrl+Alt+7', pause: 'Ctrl+Alt+8', stop: 'Ctrl+Alt+9' }
  await writeFile(join(profile, 'phase2-hotkeys.json'), JSON.stringify(testBindings))
  const environment = { ...process.env, VINXA_BACKEND: 'demo', VINXA_SMOKE_USER_DATA: profile }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'VINXA_CAPTURE_TEST',
    'VINXA_DIAGNOSTICS_DIR',
    'ELECTRON_RENDERER_URL'
  ])
    delete environment[key]
  const executablePath = require('electron')
  const args = [resolve('.')]
  let desktop
  const checks = [],
    errors = [],
    requests = []
  const pass = (name) => {
    checks.push(name)
    console.log('PASS:', name)
  }
  const observe = (page) => {
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url())
    })
  }
  try {
    desktop = await _electron.launch({ executablePath, args, env: environment, timeout: 30000 })
    desktop.on('window', observe)
    const page = await desktop.firstWindow()
    observe(page)
    await page.getByRole('heading', { name: 'Your meetings, remembered.' }).waitFor()
    await waitForSnapshot(page, (value) => value.ready)
    assert.equal(
      await page.evaluate(async () => {
        await document.fonts.ready
        return document.fonts.check('14px Inter')
      }),
      true
    )
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: join(artifacts, 'dashboard-idle.png'), fullPage: true })
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
    pass('dashboard, local fonts, honest demo state, no horizontal overflow')

    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('heading', { name: 'No saved meetings yet' }).waitFor()
    assert.equal(await page.getByRole('searchbox').isDisabled(), true)
    await page.screenshot({ path: join(artifacts, 'library-empty.png'), fullPage: true })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const startShortcut = page.getByRole('textbox', { name: 'Start shortcut', exact: true })
    await startShortcut.fill('Ctrl+Alt+8')
    await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Each action needs a different shortcut' }).waitFor()
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    assert.equal(await startShortcut.inputValue(), 'Ctrl+Alt+S')
    await startShortcut.fill('Ctrl+Alt+4')
    await page.getByRole('textbox', { name: 'Pause / Resume shortcut', exact: true }).fill('Ctrl+Alt+5')
    await page.getByRole('textbox', { name: 'Stop shortcut', exact: true }).fill('Ctrl+Alt+6')
    await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Shortcuts saved.' }).waitFor()
    const saved = JSON.parse(await readFile(join(profile, 'phase2-hotkeys.json'), 'utf8'))
    assert.equal(saved.start, 'Ctrl+Alt+4')
    assert.equal(
      await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+4')),
      true
    )
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    assert.equal(await startShortcut.inputValue(), 'Ctrl+Alt+S')
    await startShortcut.fill(testBindings.start)
    await page.getByRole('textbox', { name: 'Pause / Resume shortcut', exact: true }).fill(testBindings.pause)
    await page.getByRole('textbox', { name: 'Stop shortcut', exact: true }).fill(testBindings.stop)
    await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click()
    await waitForSnapshot(page, (value) => value.hotkeys.start === 'Ctrl+Alt+7')
    await page.screenshot({ path: join(artifacts, 'settings.png'), fullPage: true })
    pass('library empty state, shortcut validation, persistence, native registration, reset')
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()

    let setupCreated = desktop.waitForEvent('window')
    await page.getByRole('button', { name: 'Start demo', exact: true }).click()
    let setup = await setupCreated
    await setup.getByRole('heading', { name: 'Prepare local session' }).waitFor()
    assert.equal(
      await setup.getByRole('button', { name: 'Confirm and start demo', exact: true }).isDisabled(),
      true
    )
    assert.equal((await page.evaluate(() => window.vinxaPhase2.snapshot())).segments.length, 0)
    await setup.screenshot({ path: join(artifacts, 'setup-consent.png'), fullPage: true })
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Vinxa — Setup and Consent')
        .setSize(500, 600)
    )
    await setup.waitForTimeout(100)
    assert.equal(await setup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await setup
      .getByRole('button', { name: 'Cancel', exact: true })
      .click({ noWaitAfter: true })
      .catch((error) => {
        if (!setup.isClosed()) throw error
      })
    await waitForSnapshot(page, (value) => value.state === 'idle')
    pass('consent gate, untouched transcript before consent, cancel')

    setupCreated = desktop.waitForEvent('window')
    await page.getByRole('button', { name: 'Start demo', exact: true }).click()
    setup = await setupCreated
    await setup.getByRole('textbox', { name: 'Meeting title', exact: true }).fill('Stitch integration smoke')
    await setup.getByRole('checkbox', { name: /I confirm that participants/ }).check()
    await setup.getByRole('checkbox', { name: /Include microphone/ }).uncheck()
    await setup.getByRole('checkbox', { name: /Include system audio/ }).uncheck()
    assert.equal(
      await setup.getByRole('button', { name: 'Confirm and start demo', exact: true }).isDisabled(),
      true
    )
    await setup.getByRole('checkbox', { name: /Include microphone/ }).check()
    await setup.getByRole('checkbox', { name: /Include system audio/ }).check()
    await setup.getByRole('button', { name: 'Copy meeting announcement', exact: true }).click()
    await setup.getByText('Copied. Review the announcement before sharing it.', { exact: true }).waitFor()
    assert.match(await desktop.evaluate(({ clipboard }) => clipboard.readText()), /written sample transcript/)
    const overlayCreated = desktop.waitForEvent('window')
    await setup
      .getByRole('button', { name: 'Confirm and start demo', exact: true })
      .click({ noWaitAfter: true })
      .catch((error) => {
        if (!setup.isClosed()) throw error
      })
    const overlay = await overlayCreated
    await overlay.getByRole('button', { name: 'Pause', exact: true }).waitFor()
    pass('audio-source validation, announcement clipboard, consent confirmation, overlay creation')

    for (let cycle = 0; cycle < 5; cycle++) {
      await overlay.getByRole('button', { name: 'Pause', exact: true }).click()
      await overlay.locator('.status.paused').waitFor()
      await overlay.getByRole('button', { name: 'Resume', exact: true }).click()
      await overlay.locator('.status.recording').waitFor()
    }
    await overlay
      .getByText('Sample playback finished. Stop ends the demo session; no audio was captured.', {
        exact: true
      })
      .waitFor()
    assert.equal(await overlay.locator('.segment').count(), 3)
    assert.equal(await overlay.locator('.partial').count(), 0)
    await overlay.getByRole('button', { name: 'Copy recent lines', exact: true }).click()
    assert.match(await desktop.evaluate(({ clipboard }) => clipboard.readText()), /Remote: The backend/)
    const receipt = (await readFile(join(profile, 'consent-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.equal(receipt.length, 1)
    assert.equal(receipt[0].mode, 'demo')
    pass(
      'five pause/resume cycles, partial-to-final replacement, speaker labels, consent receipt, transcript clipboard'
    )

    const beforeDrag = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Vinxa Transcript')
        .getBounds()
    )
    // CDP mouse input does not move the Windows cursor read by Electron.
    // Simulate that cursor only while exercising the real renderer gesture,
    // trusted IPC handler and native window positioning.
    await desktop.evaluate(({ screen }) => {
      const original = screen.getCursorScreenPoint
      let calls = 0
      screen.getCursorScreenPoint = () => (calls++ === 0 ? { x: 100, y: 100 } : { x: 160, y: 130 })
      globalThis.__restoreSmokeCursor = () => {
        screen.getCursorScreenPoint = original
      }
    })
    const transcript = await overlay.locator('.segment p').first().boundingBox()
    await overlay.mouse.move(transcript.x + 24, transcript.y + 10)
    await overlay.mouse.down()
    await overlay.mouse.move(transcript.x + 85, transcript.y + 42, { steps: 8 })
    await overlay.mouse.up()
    await overlay.waitForTimeout(100)
    const afterDrag = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Vinxa Transcript')
        .getBounds()
    )
    await desktop.evaluate(() => {
      globalThis.__restoreSmokeCursor()
      delete globalThis.__restoreSmokeCursor
    })
    assert.ok(
      beforeDrag.x !== afterDrag.x || beforeDrag.y !== afterDrag.y,
      'Dragging transcript text should move the native overlay'
    )
    await overlay.screenshot({ path: join(artifacts, 'overlay-expanded.png') })
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Vinxa Transcript')
        .setSize(440, 360)
    )
    await overlay.waitForTimeout(100)
    assert.equal(await overlay.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await overlay.screenshot({ path: join(artifacts, 'overlay-minimum-size.png') })
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Vinxa Transcript')
        .setSize(600, 500)
    )
    await overlay.getByRole('button', { name: 'Collapse', exact: true }).click()
    await overlay.getByRole('button', { name: 'Expand', exact: true }).waitFor()
    assert.equal(await overlay.locator('.overlay-body').count(), 0)
    await overlay.getByRole('button', { name: 'Pause', exact: true }).click()
    await overlay.locator('.status.paused').waitFor()
    await overlay.screenshot({ path: join(artifacts, 'overlay-collapsed.png') })
    await overlay.getByRole('button', { name: 'Resume', exact: true }).click()
    await overlay.getByRole('button', { name: 'Expand', exact: true }).click()
    const slider = overlay.getByRole('slider', { name: 'Overlay opacity' })
    await slider.press('Home')
    for (let step = 0; step < 25; step++) await slider.press('ArrowRight')
    await waitForSnapshot(overlay, (value) => value.opacity === 0.75)
    const opacity = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Vinxa Transcript')
        .getOpacity()
    )
    assert.ok(Math.abs(opacity - 0.75) < 0.02)
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === 'Vinxa Transcript')
          .isAlwaysOnTop()
      ),
      true
    )
    pass(
      'body drag with simulated Windows cursor, collapsed Pause/Resume, expand, native opacity, always-on-top'
    )

    await overlay.getByRole('button', { name: 'Open main window', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settingsSlider = page.getByRole('slider', { name: 'Overlay opacity' })
    await settingsSlider.press('Home')
    for (let step = 0; step < 10; step++) await settingsSlider.press('ArrowRight')
    await waitForSnapshot(page, (value) => value.opacity === 0.6)
    await overlay.waitForFunction(() => document.querySelector('input[type="range"]').value === '60')
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
    pass('minimum window sizes and cross-window opacity synchronization')
    await overlay.getByRole('button', { name: 'Stop', exact: true }).click()
    await overlay.locator('.status.completed').waitFor()
    const finished = await page.evaluate(() => window.vinxaPhase2.snapshot())
    assert.equal(typeof finished.startedAtMs, 'number')
    assert.ok(finished.endedAtMs >= finished.startedAtMs)
    assert.equal(finished.pauses.length, 6)
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'View session', exact: true }).click()
    assert.equal(await page.locator('.segment').count(), 3)
    await page.getByRole('tab', { name: /Summary/ }).click()
    await page.getByRole('heading', { name: 'Summary — coming in a later phase' }).waitFor()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).press('ArrowRight')
    await page.getByRole('heading', { name: 'Summary — coming in a later phase' }).waitFor()
    await page.getByRole('tab', { name: /Summary/ }).press('Home')
    await page.screenshot({ path: join(artifacts, 'meeting-details.png'), fullPage: true })
    pass('Stop, frozen session duration, pause timeline, current-session details, honest future tabs')

    // Test the application close handler. Native X/accelerator dispatch remains
    // a separately tracked Windows issue and is not certified by this smoke.
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() !== 'Vinxa Transcript')
        .emit('close', { preventDefault() {} })
    )
    for (let attempt = 0; attempt < 40; attempt++) {
      const visible = await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) => window.isVisible() && window.getTitle() !== 'Vinxa Transcript'
        )
      )
      if (!visible) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) => window.isVisible() && window.getTitle() !== 'Vinxa Transcript'
        )
      ),
      false
    )
    const secondExit = await new Promise((resolveExit, reject) => {
      const second = spawn(executablePath, args, { env: environment, windowsHide: true })
      const timer = setTimeout(() => {
        second.kill()
        reject(new Error('Second instance did not exit'))
      }, 15000)
      second.once('error', reject)
      second.once('exit', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
    })
    assert.equal(secondExit, 0)
    for (let attempt = 0; attempt < 40; attempt++) {
      const visible = await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) => window.isVisible() && window.getTitle() !== 'Vinxa Transcript'
        )
      )
      if (visible) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) => window.isVisible() && window.getTitle() !== 'Vinxa Transcript'
        )
      ),
      true
    )
    pass('application close-event hides to tray, single-instance lock and restore')
    assert.deepEqual(errors, [])
    assert.deepEqual(requests, [])
    pass('no renderer exceptions and no HTTP/CDN/font requests')
  } finally {
    await desktop?.close()
    await writeFile(
      join(artifacts, 'report.json'),
      JSON.stringify(
        {
          checks,
          errors,
          requests,
          physicalAudioTested: false,
          nativeCloseDispatchVerified: false,
          dragCursorSimulated: true
        },
        null,
        2
      )
    )
    assert.equal(dirname(resolve(profile)), resolve(tmpdir()))
    await rm(profile, { recursive: true, force: true })
  }
  console.log(
    'PASS: Quit terminated the test application; native title-bar X and physical meeting audio require manual checks.'
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
