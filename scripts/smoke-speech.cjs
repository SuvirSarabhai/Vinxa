const assert = require('node:assert/strict')
const { join, dirname, resolve } = require('node:path')
const { mkdir, writeFile } = require('node:fs/promises')
const { _electron } = require('playwright-core')

async function main() {
  const argumentsList = process.argv.slice(2)
  const executableIndex = argumentsList.indexOf('--executable')
  let packagedExecutable
  if (executableIndex >= 0) {
    assert.ok(argumentsList[executableIndex + 1], 'Provide an executable after --executable')
    packagedExecutable = resolve(argumentsList[executableIndex + 1])
    argumentsList.splice(executableIndex, 2)
  }
  assert.ok(argumentsList.length <= 1, 'Provide at most one report path')
  const reportPath = argumentsList[0] ? resolve(argumentsList[0]) : undefined
  const environment = { ...process.env }
  environment.VINXA_BACKEND = 'local'
  if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); environment.VINXA_DIAGNOSTICS_DIR = dirname(reportPath) }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.VINXA_CAPTURE_TEST
  delete environment.VINXA_CAPTURE_SPEECH
  if (packagedExecutable) {
    delete environment.VINXA_SIDECAR_SOURCE
    delete environment.VINXA_SIDECAR_PYTHON
    delete environment.VINXA_SPEECH_MODEL_PATH
  }
  const desktop = await _electron.launch({ executablePath: packagedExecutable || join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
    args: packagedExecutable ? [] : ['.'], env: environment, timeout: 30000 })
  const observed = []
  try {
    if (packagedExecutable) assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), true)
    const page = await desktop.firstWindow()
    await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide() })
    const result = await page.evaluate(() => new Promise((resolve, reject) => {
      const statuses = []
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Readiness deadline')) }, 60000)
      const unsubscribe = window.vinxa.onEngineStatus((event) => {
        statuses.push(event.status)
        if (event.status === 'error') { clearTimeout(timer); unsubscribe(); reject(new Error('Engine unavailable')) }
        if (event.status === 'ready' && !event.requestId) {
          clearTimeout(timer); unsubscribe(); resolve(statuses)
        }
      })
    }))
    observed.push(...result)
    assert.ok(observed.includes('ready'))
  } finally {
    await desktop.close()
  }
  const report = { status: 'DONE', readiness: 'PASS', appExit: 'PASS', packaged: Boolean(packagedExecutable), audioCapture: 'not requested', observed }
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report))
}

main().catch(() => { console.error('Speech startup smoke failed; inspect the runtime and cached model'); process.exitCode = 1 })
