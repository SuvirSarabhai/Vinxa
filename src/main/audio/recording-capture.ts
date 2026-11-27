import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { AudioFrameMetadata, AudioSourceName, RecordingConfig } from '../../shared/contracts'
import { sourceIds } from '../../shared/contracts'
import { ipcChannels } from '../../shared/ipc-channels'
import { audioFrameMetadataSchema, captureFinishedSchema, captureFrameDiagnosticsSchema } from '../../shared/schemas'
import { parseMicrophoneGain, validatePcmFrame } from '../../shared/pcm'
import { watchWindowsDefaultOutput } from './windows-output-monitor'
import type { WindowsOutputMonitor } from './windows-output-monitor'
import { speechDiagnostics } from '../speech-diagnostics'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

interface Source {
  name: AudioSourceName; window: BrowserWindow; ready: boolean; finished: boolean
  padding: number; sequence: number; nextSample?: number
}
interface Run {
  sources: Source[]; partition: Electron.Session; ready: ReturnType<typeof deferred>
  done: ReturnType<typeof deferred>; monitor?: WindowsOutputMonitor
  stopping: boolean; cleaned: boolean; error?: string
  startupTimer?: ReturnType<typeof setTimeout>; stopTimer?: ReturnType<typeof setTimeout>
  stoppingPromise?: Promise<void>
}

export class RecordingCapture {
  private run?: Run
  private epoch = 0
  private config?: RecordingConfig
  private gain = 0.75
  private padding: Partial<Record<AudioSourceName, number>> = {}

  constructor(
    private readonly frame: (source: AudioSourceName, pcm: Uint8Array, metadata: AudioFrameMetadata) => void,
    private readonly level: (source: AudioSourceName, value: number) => void,
    private readonly failure: (message: string) => void
  ) {}

  get finalPadding(): Partial<Record<AudioSourceName, number>> { return { ...this.padding } }

  async start(config: RecordingConfig, sessionStartMs = performance.now()): Promise<void> {
    if (this.run || this.config) throw new Error('Audio capture is already initialized.')
    this.config = config
    this.epoch = sessionStartMs
    this.gain = config.microphoneEnabled ? parseMicrophoneGain(process.env.VINXA_MIC_GAIN) : 1
    await this.open()
  }

  async resume(): Promise<void> {
    if (!this.config || this.run) throw new Error('Audio capture cannot resume in this state.')
    await this.open()
  }

  private async open(): Promise<void> {
    const config = this.config!
    this.padding = {}
    const names: AudioSourceName[] = []
    if (config.microphoneEnabled) names.push('mic')
    if (config.systemAudioEnabled) names.push('system')
    const run: Run = { sources: [], partition: session.defaultSession,
      ready: deferred(), done: deferred(), stopping: false, cleaned: false }
    this.run = run
    try {
      for (const name of names) run.sources.push({ name, ready: false, finished: false, padding: 0, sequence: 0,
        window: new BrowserWindow({ show: false, webPreferences: {
          session: run.partition, contextIsolation: true, sandbox: true, nodeIntegration: false,
          backgroundThrottling: false, preload: join(__dirname, '../preload/index.js')
        } }) })
      run.partition.setPermissionCheckHandler((contents, permission, _origin, details) => {
        const source = run.sources.find((item) => !item.window.isDestroyed() && item.window.webContents === contents)
        return !!source && !run.stopping && !run.cleaned && (source.name === 'system'
          ? permission === 'display-capture' : permission === 'media' && details.mediaType === 'audio')
      })
      run.partition.setPermissionRequestHandler((contents, permission, callback, details) => {
        const source = run.sources.find((item) => !item.window.isDestroyed() && item.window.webContents === contents)
        callback(!!source && !run.stopping && !run.cleaned && (source.name === 'system'
          ? permission === 'display-capture' : permission === 'media' && 'mediaTypes' in details &&
            !!details.mediaTypes?.length && details.mediaTypes.every((type) => type === 'audio')))
      })
      run.partition.setDisplayMediaRequestHandler((request, callback) => {
        const source = run.sources.find((item) => item.name === 'system' && !item.window.isDestroyed() &&
          item.window.webContents.mainFrame === request.frame)
        if (!source || run.stopping || run.cleaned || !request.audioRequested || !request.videoRequested) { callback(null); return }
        void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((screens) => {
          if (!run.stopping && !run.cleaned && screens[0]) callback({ video: screens[0], audio: 'loopback' })
          else callback(null)
        }).catch(() => callback(null))
      })

      ipcMain.handle(ipcChannels.captureClock, (event, clientSendMs: unknown) => {
        const mainReceiveMs = performance.now()
        this.authorize(run, event)
        if (typeof clientSendMs !== 'number' || !Number.isFinite(clientSendMs)) throw new Error('Invalid capture clock request.')
        return { mainReceiveMs, mainSendMs: performance.now(), sessionStartMs: this.epoch }
      })
      ipcMain.handle(ipcChannels.captureReady, (event) => {
        const source = this.authorize(run, event)
        if (run.stopping || source.finished) return
        source.ready = true
        if (run.sources.every((item) => item.ready)) { clearTimeout(run.startupTimer); run.ready.resolve() }
      })
      ipcMain.handle(ipcChannels.captureFrame, (event, value: unknown, timing: unknown, diagnostics?: unknown) => {
        const receivedAt = performance.now()
        const source = this.authorize(run, event)
        if (source.finished || run.error) throw new Error('Audio source has ended.')
        validatePcmFrame(value, sourceIds[source.name])
        const metadata = audioFrameMetadataSchema.parse(timing)
        if (metadata.sequence !== source.sequence || metadata.captureKind !== 'render-estimate' ||
          metadata.captureTimeMs === undefined || metadata.captureErrorMs === undefined || metadata.sampleCount !== 1600 ||
          (source.nextSample !== undefined && metadata.startSample < source.nextSample)) {
          throw new Error('Measured audio continuity was lost.')
        }
        // A forward acquisition-clock gap is recoverable. SidecarManager sends
        // its existing source-gap control before the new PCM; never renumber
        // these samples to hide missing time. Duplicates/overlaps remain fatal.
        if (source.nextSample !== undefined && metadata.startSample > source.nextSample) {
          speechDiagnostics.record('capture_clock_gap', source.name, metadata.startSample - source.nextSample)
        }
        const counters = diagnostics === undefined ? {} : captureFrameDiagnosticsSchema.parse(diagnostics)
        speechDiagnostics.record('capture_ipc_received', source.name, 1600, { ...counters,
          sequence: metadata.sequence!, startSample: metadata.startSample,
          frameAgeMs: Math.max(0, receivedAt - metadata.captureTimeMs) })
        source.sequence++
        source.nextSample = metadata.startSample + 1600
        const bytes = new Uint8Array(value)
        const samples = new DataView(value, 1)
        let energy = 0
        for (let index = 0; index < 1600; index++) energy += (samples.getInt16(index * 2, true) / 32768) ** 2
        this.level(source.name, Math.min(1, Math.sqrt(energy / 1600) * 4))
        this.frame(source.name, bytes.subarray(1), metadata)
        speechDiagnostics.record('capture_ipc_handled', source.name, 1600, {
          sequence: metadata.sequence!, durationMs: performance.now() - receivedAt
        })
      })
      ipcMain.handle(ipcChannels.captureFinished, (event, payload: unknown) => {
        const source = this.authorize(run, event)
        const result = captureFinishedSchema.parse(payload)
        source.finished = true
        source.padding = result.error ? 0 : result.paddedSamples
        if (result.error) this.fail(run, result.error)
        else if (!run.stopping) this.fail(run, 'An audio source ended unexpectedly. Start a new session.')
        if (run.sources.every((item) => item.finished)) run.done.resolve()
      })

      for (const source of run.sources) {
        source.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        source.window.webContents.on('will-navigate', (event) => event.preventDefault())
        source.window.webContents.on('render-process-gone', () => this.fail(run, `${source.name} capture process stopped. Start a new session.`))
        source.window.webContents.on('preload-error', () => this.fail(run, 'The capture bridge could not load. Rebuild and restart Vinxa.'))
        let navigated = false
        source.window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
          if (!mainFrame) return
          if (navigated) this.fail(run, 'An audio capture page reloaded. Start a new session.')
          navigated = true
        })
      }
      if (names.includes('system')) {
        const script = app.isPackaged ? join(process.resourcesPath, 'audio/default-output.ps1')
          : join(__dirname, '../../resources/audio/default-output.ps1')
        run.monitor = await watchWindowsDefaultOutput(script,
          () => this.fail(run, 'Windows default output changed. Start a new session on the new output.'),
          () => this.fail(run, 'Windows output monitoring stopped. Start a new session.'))
        if (run.cleaned) { await run.monitor.stop(); throw new Error('Capture startup was cancelled.') }
      }
      run.startupTimer = setTimeout(() => this.fail(run, 'Audio startup timed out. Check audio permissions and devices.'), 20000)
      await Promise.all(run.sources.map((source) => {
        const query: Record<string, string> = { source: source.name, micGain: String(source.name === 'mic' ? this.gain : 1) }
        if (source.name === 'mic' && config.microphoneDeviceId) query.microphoneDeviceId = config.microphoneDeviceId
        if (process.env.VINXA_DIAGNOSTICS_DIR) query.diagnostics = '1'
        return process.env.ELECTRON_RENDERER_URL
          ? source.window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture/index.html?${new URLSearchParams(query)}`)
          : source.window.loadFile(join(__dirname, '../renderer/capture/index.html'), { query })
      }))
      await run.ready.promise
    } catch (error) {
      await this.cleanup(run)
      if (this.run === run) this.run = undefined
      throw error
    }
  }

  async stop(): Promise<void> {
    const run = this.run
    if (!run) return
    run.stoppingPromise ??= (async () => {
      run.stopping = true
      clearTimeout(run.startupTimer)
      for (const source of run.sources) {
        if (!source.finished && !source.window.isDestroyed()) source.window.webContents.send(ipcChannels.captureStop)
      }
      if (run.sources.every((source) => source.finished)) run.done.resolve()
      run.stopTimer = setTimeout(() => run.done.reject(new Error('Audio capture did not stop cleanly.')), 4000)
      try {
        await run.done.promise
        this.padding = Object.fromEntries(run.sources.map((source) => [source.name, source.padding]))
        if (run.error) throw new Error(run.error)
      } finally {
        await this.cleanup(run)
        if (this.run === run) this.run = undefined
      }
    })()
    return run.stoppingPromise
  }

  async abort(): Promise<void> {
    const run = this.run
    if (!run) return
    run.error ??= 'Audio capture was interrupted.'
    run.ready.reject(new Error(run.error))
    run.done.resolve()
    const closed = this.cleanup(run)
    this.run = undefined
    await closed
  }

  private authorize(run: Run, event: IpcMainInvokeEvent): Source {
    const source = run.sources.find((item) => !item.window.isDestroyed() && item.window.webContents.mainFrame === event.senderFrame)
    if (run.cleaned || this.run !== run || !source) throw new Error('Untrusted audio capture sender.')
    return source
  }

  private fail(run: Run, message: string): void {
    if (run.cleaned || run.error) return
    run.error = message
    run.ready.reject(new Error(message))
    this.failure(message)
  }

  private async cleanup(run: Run): Promise<void> {
    if (run.cleaned) return
    run.cleaned = true
    clearTimeout(run.startupTimer); clearTimeout(run.stopTimer)
    for (const source of run.sources) if (!source.window.isDestroyed()) source.window.destroy()
    for (const channel of [ipcChannels.captureClock, ipcChannels.captureReady, ipcChannels.captureFrame, ipcChannels.captureFinished]) ipcMain.removeHandler(channel)
    run.partition.setPermissionCheckHandler(null)
    run.partition.setPermissionRequestHandler(null)
    run.partition.setDisplayMediaRequestHandler(null)
    await run.monitor?.stop()
  }
}
