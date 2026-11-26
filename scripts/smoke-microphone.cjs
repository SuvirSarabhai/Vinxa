// Uses generated input streams. System mode substitutes a synthetic display stream,
// so it tests routing and cleanup, not Windows loopback device compatibility.
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { mkdir, mkdtemp, readFile } = require('node:fs/promises')

async function run() {
  const requestedMode = process.argv[2] ?? 'mic'
  const realLoopback = requestedMode === 'loopback'
  const mode = realLoopback ? 'system' : requestedMode
  assert.ok(['mic', 'system', 'both'].includes(mode), 'Use mic, system, both, or loopback')
  if (!process.versions.electron) {
    const { build } = await import('vite')
    await build({
      configFile: false,
      build: {
        ssr: 'src/main/audio/capture-test.ts', outDir: 'out/main', emptyOutDir: false,
        rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'microphone-test.cjs' } }
      }
    })
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const { spawn } = require('node:child_process')
    const code = await new Promise((done, reject) => {
      const child = spawn(require('electron'), [__filename, requestedMode], { env: environment, stdio: 'inherit', windowsHide: true })
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Microphone smoke timed out')) }, 45000)
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('exit', (code) => { clearTimeout(timeout); done(code) })
    })
    process.exitCode = code ?? 1
    return
  }

  const { app, BrowserWindow, dialog } = require('electron')
  if (!realLoopback) {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  }
  const loadFile = BrowserWindow.prototype.loadFile
  BrowserWindow.prototype.loadFile = async function(file, options) {
    try {
      if (!realLoopback && options?.query?.source === 'system') {
        await this.loadURL('about:blank')
        this.webContents.debugger.attach('1.3')
        await this.webContents.debugger.sendCommand('Page.enable')
        await this.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
        navigator.mediaDevices.getDisplayMedia = async () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          oscillator.frequency.value = 880;
          const gain = context.createGain(); gain.gain.value = 0.2;
          const destination = context.createMediaStreamDestination();
          oscillator.connect(gain).connect(destination); oscillator.start();
          await context.resume();
          const canvas = document.createElement('canvas');
          canvas.getContext('2d').fillRect(0, 0, 1, 1);
          destination.stream.addTrack(canvas.captureStream(10).getVideoTracks()[0]);
          return destination.stream;
        };
        ` })
      }
      return await loadFile.call(this, file, options)
    } catch (error) {
      console.error('Synthetic capture page failed to load:', error.message)
      throw error
    }
  }
  const deadline = setTimeout(() => { console.error('FAIL: capture deadline'); app.exit(1) }, 35000)
  await app.whenReady()
  await mkdir('tmp', { recursive: true })
  const output = await mkdtemp(resolve('tmp/microphone-smoke-'))
  app.getAppPath = () => output
  const owner = new BrowserWindow({ show: false })
  if (realLoopback) {
    await owner.loadURL('about:blank')
    await owner.webContents.executeJavaScript(`
      window.loopbackTone = new AudioContext();
      const oscillator = loopbackTone.createOscillator();
      oscillator.frequency.value = 880;
      const gain = loopbackTone.createGain(); gain.gain.value = 0.15;
      oscillator.connect(gain).connect(loopbackTone.destination);
      oscillator.start();
      loopbackTone.resume();
    `, true)
  }
  let resolveComplete
  let rejectComplete
  const complete = new Promise((done, reject) => { resolveComplete = done; rejectComplete = reject })
  complete.catch(() => {})
  dialog.showMessageBox = async (_owner, options) => {
    if (options.title === 'Audio capture test') return { response: 1 }
    if (options.title === 'Audio recording') {
      await new Promise((done) => setTimeout(done, 5000))
      return { response: 0 }
    }
    if (options.type !== 'info') { rejectComplete(new Error(options.message)); return { response: 0 } }
    resolveComplete()
    return { response: 0 }
  }
  const { startCaptureTest } = require('../out/main/microphone-test.cjs')
  const diagnostic = await startCaptureTest(owner, mode)
  assert.ok(diagnostic)
  await complete
  await diagnostic.stop()
  const names = mode === 'both' ? ['mic', 'system'] : [mode]
  const files = []
  for (const source of names) {
    const file = await readFile(join(output, 'test_recordings', `${source}.wav`))
    assert.equal(file.toString('ascii', 0, 4), 'RIFF')
    assert.equal(file.readUInt32LE(4) + 8, file.length)
    assert.equal(file.readUInt32LE(24), 16000)
    assert.equal(file.readUInt16LE(22), 1)
    assert.equal(file.readUInt16LE(34), 16)
    assert.equal(file.readUInt32LE(40), file.length - 44)
    console.log(`Generated ${source} WAV duration: ${(file.length - 44) / 32000} seconds`)
    assert.ok(file.length >= 44 + 3 * 32000, 'Expected at least three seconds of frames after startup')
    assert.ok(file.subarray(44).some((byte) => byte !== 0), 'Generated source must be audible')
    if (realLoopback) {
      let sine = 0, cosine = 0, energy = 0
      const samples = (file.length - 44) / 2
      for (let i = 1600; i < samples - 1600; i++) {
        const sample = file.readInt16LE(44 + i * 2) / 32768
        sine += sample * Math.sin(2 * Math.PI * 880 * i / 16000)
        cosine += sample * Math.cos(2 * Math.PI * 880 * i / 16000)
        energy += sample * sample
      }
      const count = samples - 3200
      const toneRms = Math.SQRT2 * Math.hypot(sine, cosine) / count
      const rms = Math.sqrt(energy / count)
      console.log(`Loopback 880 Hz tone RMS: ${toneRms.toFixed(6)}; total RMS: ${rms.toFixed(6)}`)
      assert.ok(toneRms > 0.001 && toneRms > rms * 0.5, 'Expected the played 880 Hz tone in Windows loopback')
    }
    files.push(file)
  }
  if (files.length === 2) assert.ok(!files[0].equals(files[1]), 'Separate sources must retain distinct generated signals')
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'Hidden capture window must be destroyed')
  console.log(`PASS: ${realLoopback ? 'Windows loopback' : `generated ${mode} input`} -> AudioWorklet -> preload -> IPC -> separate finalized WAVs; capture windows cleaned up`)
  clearTimeout(deadline)
  owner.destroy()
  app.quit()
}

run().catch((error) => {
  console.error(error.message)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})
