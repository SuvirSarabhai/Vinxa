const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { join, resolve } = require('node:path')
const { mkdir } = require('node:fs/promises')
const { _electron } = require('playwright-core')

async function main() {
  assert.ok(process.argv[2], 'Provide the packaged or installed executable path')
  const executablePath = resolve(process.argv[2])
  const appArguments = process.argv[3] ? [process.argv[3]] : []
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.VINXA_CAPTURE_TEST
  environment.VINXA_BACKEND = 'demo'
  const desktop = await _electron.launch({ executablePath, args: appArguments, env: environment, timeout: 30000 })
  try {
    const page = await desktop.firstWindow()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('heading', { name: 'Your meetings, remembered.' }).waitFor()
    assert.equal(await page.evaluate(() => typeof window.vinxaPhase2?.command), 'function')
    let setupCreated = desktop.waitForEvent('window')
    await page.getByRole('button', { name: 'Start demo', exact: true }).click()
    let setup = await setupCreated
    await setup.getByRole('heading', { name: 'Prepare local session' }).waitFor()
    assert.equal(await setup.getByRole('button', { name: 'Confirm and start demo', exact: true }).isDisabled(), true)
    assert.equal((await page.evaluate(() => window.vinxaPhase2.snapshot())).segments.length, 0)
    await setup.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.waitForFunction(async () => (await window.vinxaPhase2.snapshot()).state === 'idle')

    setupCreated = desktop.waitForEvent('window')
    await page.getByRole('button', { name: 'Start demo', exact: true }).click()
    setup = await setupCreated
    await setup.getByRole('checkbox', { name: /I confirm that participants/ }).check()
    const overlayCreated = desktop.waitForEvent('window')
    await setup.getByRole('button', { name: 'Confirm and start demo', exact: true }).click()
    const overlay = await overlayCreated
    overlay.on('pageerror', (error) => errors.push(error.message))
    await overlay.getByRole('button', { name: 'Pause', exact: true }).click()
    await overlay.getByRole('status').filter({ hasText: /^paused$/ }).waitFor()
    await overlay.getByRole('button', { name: 'Resume', exact: true }).click()
    await overlay.getByText('Sample playback finished. Stop ends the demo session; no audio was captured.', { exact: true }).waitFor()
    assert.equal(await overlay.locator('.segment').count(), 3)
    assert.equal(await overlay.locator('.partial').count(), 0)
    assert.equal(await overlay.getByText('The backend will be ready by Friday.', { exact: true }).count(), 1)
    await overlay.evaluate(() => window.vinxaPhase2.command({ type: 'copy-lines' }))
    assert.match(await desktop.evaluate(({ clipboard }) => clipboard.readText()), /Remote: The backend/)
    await overlay.getByRole('button', { name: 'Collapse', exact: true }).click()
    await overlay.getByRole('button', { name: 'Expand', exact: true }).waitFor()
    assert.equal(await overlay.locator('.overlay-body').count(), 0)
    await overlay.getByRole('button', { name: 'Expand', exact: true }).click()
    await overlay.getByRole('button', { name: 'Stop', exact: true }).waitFor()
    await overlay.evaluate(() => window.vinxaPhase2.command({ type: 'opacity', value: 0.75 }))
    const overlayOpacity = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Vinxa Transcript').getOpacity())
    assert.ok(Math.abs(overlayOpacity - 0.75) < 0.02)
    await overlay.getByRole('button', { name: 'Stop', exact: true }).click()
    await overlay.getByRole('status').filter({ hasText: /^completed$/ }).waitFor()
    await mkdir('release', { recursive: true })
    await page.screenshot({ path: join('release', 'phase-2-smoke.png') })
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close()
    })
    await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, { polling: 100 })
    const hidden = await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return !window.isDestroyed() && !window.isVisible()
    })
    assert.equal(hidden, true, 'Closing the window must hide it without destroying it')
    const exitCode = await new Promise((resolve, reject) => {
      const second = spawn(executablePath, appArguments, { env: environment, windowsHide: true })
      let diagnostics = ''
      second.stderr.on('data', (data) => { diagnostics = (diagnostics + data.toString()).slice(-4000) })
      const timer = setTimeout(() => { second.kill(); reject(new Error('Second instance failed to exit')) }, 15000)
      second.once('error', (error) => { clearTimeout(timer); reject(error) })
      second.once('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) console.error('Second-instance launch failed:', diagnostics || `exit ${code}`)
        resolve(code)
      })
    })
    assert.equal(exitCode, 0)
    await page.waitForFunction(() => document.visibilityState === 'visible')
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.getTitle() !== 'Vinxa Transcript').length), 1)
    assert.deepEqual(errors, [])
    console.log('PASS: consent/cancel, demo transcript, pause/resume/stop, collapse, opacity, clipboard, programmatic close-to-tray, second-instance restore')
    console.log('Native title-bar X is a separate known issue; this script does not validate that mouse click.')
  } finally {
    await desktop.close()
  }
  console.log('PASS: Quit terminates the application')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
