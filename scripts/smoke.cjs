const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { mkdir } = require('node:fs/promises')
const { _electron } = require('playwright-core')

async function main() {
  const executablePath = process.argv[2]
  assert.ok(executablePath, 'Provide the packaged or installed executable path')
  const appArguments = process.argv[3] ? [process.argv[3]] : []
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const desktop = await _electron.launch({ executablePath, args: appArguments, env: environment, timeout: 30000 })
  try {
    const page = await desktop.firstWindow()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('heading', { name: 'Transcript preview' }).waitFor()
    assert.equal(await page.evaluate(() => typeof window.vinxa?.fixtureCommand), 'function')
    await page.getByRole('button', { name: 'Play sample', exact: true }).click()
    await page.getByText('Let us review', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Pause sample', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'paused' }).waitFor()
    await page.getByRole('button', { name: 'Resume sample', exact: true }).click()
    await page.getByText('The backend will be ready by Friday.', { exact: true }).waitFor()
    await page.getByRole('status').filter({ hasText: 'completed' }).waitFor()
    assert.equal(await page.locator('.segment').count(), 3)
    assert.equal(await page.locator('.partial').count(), 0)
    await mkdir('release', { recursive: true })
    await page.screenshot({ path: join('release', 'phase-1-smoke.png') })
    await page.getByRole('button', { name: 'Reset sample', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.segment').length === 0)
    const hidden = await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.close()
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
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    assert.deepEqual(errors, [])
    console.log('PASS: desktop bridge, partial/final transcript, pause/resume/reset, close-to-tray, second-instance restore')
  } finally {
    await desktop.close()
  }
  console.log('PASS: Quit terminates the application')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
