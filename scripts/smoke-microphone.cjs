// Uses Chromium's generated microphone only. No physical input device is opened.
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { mkdir, mkdtemp, readFile } = require('node:fs/promises')

async function run() {
  if (!process.versions.electron) {
    const { build } = await import('vite')
    await build({
      configFile: false,
      build: {
        ssr: 'src/main/audio/microphone-test.ts', outDir: 'out/main', emptyOutDir: false,
        rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'microphone-test.cjs' } }
      }
    })
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const { spawn } = require('node:child_process')
    const code = await new Promise((done, reject) => {
      const child = spawn(require('electron'), [__filename], { env: environment, stdio: 'inherit', windowsHide: true })
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Microphone smoke timed out')) }, 45000)
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('exit', (code) => { clearTimeout(timeout); done(code) })
    })
    process.exitCode = code ?? 1
    return
  }

  const { app, BrowserWindow, dialog } = require('electron')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  const deadline = setTimeout(() => { console.error('FAIL: capture deadline'); app.exit(1) }, 35000)
  await app.whenReady()
  await mkdir('tmp', { recursive: true })
  const output = await mkdtemp(resolve('tmp/microphone-smoke-'))
  app.getAppPath = () => output
  const owner = new BrowserWindow({ show: false })
  let resolveComplete
  const complete = new Promise((done) => { resolveComplete = done })
  dialog.showMessageBox = async (_owner, options) => {
    if (options.title === 'Microphone capture test') return { response: 1 }
    if (options.title === 'Microphone recording') {
      await new Promise((done) => setTimeout(done, 5000))
      return { response: 0 }
    }
    assert.equal(options.type, 'info', options.message)
    resolveComplete()
    return { response: 0 }
  }
  const { startMicrophoneTest } = require('../out/main/microphone-test.cjs')
  const diagnostic = await startMicrophoneTest(owner)
  assert.ok(diagnostic)
  await complete
  await diagnostic.stop()
  const file = await readFile(join(output, 'test_recordings', 'mic.wav'))
  assert.equal(file.toString('ascii', 0, 4), 'RIFF')
  assert.equal(file.readUInt32LE(4) + 8, file.length)
  assert.equal(file.readUInt32LE(24), 16000)
  assert.equal(file.readUInt16LE(22), 1)
  assert.equal(file.readUInt16LE(34), 16)
  assert.equal(file.readUInt32LE(40), file.length - 44)
  console.log(`Generated microphone WAV duration: ${(file.length - 44) / 32000} seconds`)
  assert.ok(file.length >= 44 + 3 * 32000, 'Expected at least three seconds of microphone frames after startup')
  assert.ok(file.subarray(44).some((byte) => byte !== 0), 'Generated microphone must be audible')
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'Hidden capture window must be destroyed')
  console.log('PASS: generated microphone -> AudioWorklet -> preload -> IPC -> finalized 16 kHz mono WAV; capture window cleaned up')
  clearTimeout(deadline)
  owner.destroy()
  app.quit()
}

run().catch((error) => {
  console.error(error.message)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
