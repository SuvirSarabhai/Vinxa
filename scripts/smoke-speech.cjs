const assert = require('node:assert/strict')
const { join, dirname, resolve } = require('node:path')
const { writeFile } = require('node:fs/promises')
const { _electron } = require('playwright-core')

async function main() {
  const environment = { ...process.env }
  if (process.argv[2]) environment.VINXA_DIAGNOSTICS_DIR = dirname(resolve(process.argv[2]))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.VINXA_CAPTURE_TEST
  delete environment.VINXA_CAPTURE_SPEECH
  const desktop = await _electron.launch({ executablePath: join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
    args: ['.'], env: environment, timeout: 30000 })
  const observed = []
  try {
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
  const report = { status: 'DONE', readiness: 'PASS', appExit: 'PASS', audioCapture: 'not requested', observed }
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report))
}

main().catch(() => { console.error('Speech startup smoke failed; inspect the runtime and cached model'); process.exitCode = 1 })
