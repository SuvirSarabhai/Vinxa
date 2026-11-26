import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { appendFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AudioSourceName } from '../../shared/contracts'
import { sourceIds } from '../../shared/contracts'
import { ipcChannels } from '../../shared/ipc-channels'
import { captureFinishedSchema } from '../../shared/schemas'
import { parseMicrophoneGain } from '../../shared/pcm'
import { WavWriter } from './wav-writer'
import { watchWindowsDefaultOutput } from './windows-output-monitor'
import type { WindowsOutputMonitor } from './windows-output-monitor'

export type CaptureTestMode = AudioSourceName | 'both'

interface CaptureSource {
  source: AudioSourceName
  writer: WavWriter
  window: BrowserWindow
  ready: boolean
  finished: boolean
  padding: number
}

export async function startCaptureTest(owner: BrowserWindow, mode: CaptureTestMode = 'mic'): Promise<{ stop(): Promise<void> } | undefined> {
  const names: AudioSourceName[] = mode === 'both' ? ['mic', 'system'] : [mode]
  let micGain = 1
  try { if (names.includes('mic')) micGain = parseMicrophoneGain(process.env.VINXA_MIC_GAIN) }
  catch (error) {
    await dialog.showMessageBox(owner, { type: 'error', title: 'Invalid microphone gain',
      message: error instanceof Error ? error.message : 'Invalid microphone gain' })
    return
  }
  const consent = await dialog.showMessageBox(owner, {
    type: 'question', title: 'Audio capture test',
    message: `Record ${names.join(' and ')} audio into separate local WAV files?`,
    detail: `Microphone gain: ${micGain.toFixed(2)} (system gain stays 1.00). Tell participants before starting. Files stay in the selected local test directory on this computer. The test stops after 30 seconds. Existing files are preserved. System audio uses Windows default output; play a video or call through that output.`,
    buttons: ['Cancel', 'Start audio test'], defaultId: 0, cancelId: 0
  })
  if (consent.response !== 1) return

  const directory = process.env.VINXA_CAPTURE_DIR
    ? resolve(process.env.VINXA_CAPTURE_DIR)
    : join(app.isPackaged ? app.getPath('userData') : app.getAppPath(), 'test_recordings')
  const filenames = process.env.VINXA_CAPTURE_ACCEPTANCE === '1'
    ? { mic: 'microphone.wav', system: 'system_audio.wav' } : { mic: 'mic.wav', system: 'system.wav' }
  const writers: { source: AudioSourceName; writer: WavWriter }[] = []
  try {
    for (const source of names) writers.push({ source, writer: await WavWriter.create(join(directory, filenames[source]), sourceIds[source]) })
  } catch {
    // Roll back only empty files created by this attempt, preserving previous recordings.
    for (const { source, writer } of writers) {
      await writer.close()
      await unlink(join(directory, filenames[source]))
    }
    await dialog.showMessageBox(owner, {
      type: 'error', title: 'Audio test could not start',
      message: 'Check available disk space, file permissions and existing WAV files.',
      detail: 'Move existing test WAVs to a local archive before repeating. No existing file was overwritten.'
    })
    return
  }

  const captureSession = session.fromPartition('vinxa-audio-test')
  const sources: CaptureSource[] = []
  try {
    for (const { source, writer } of writers) sources.push({
      source, writer, ready: false, finished: false, padding: 0,
      window: new BrowserWindow({ show: false, webPreferences: {
        session: captureSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, preload: join(__dirname, '../preload/index.js')
      } })
    })
  } catch {
    for (const item of sources) if (!item.window.isDestroyed()) item.window.destroy()
    await Promise.allSettled(writers.map(({ writer }) => writer.close()))
    throw new Error('Audio capture window could not be created')
  }
  let closing: Promise<void> | undefined
  let resolveStopped: () => void
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
  let stopping = false
  let error: string | null = null
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let debugWrites = Promise.resolve()
  let outputMonitor: WindowsOutputMonitor | undefined
  const debug = (stage: string): void => {
    if (process.env.VINXA_CAPTURE_DEBUG !== '1') return
    // A GUI app can outlive its launcher's stdout pipe. Diagnostics must not use it.
    debugWrites = debugWrites.then(() => appendFile(join(directory, 'capture-debug.log'), `[capture] ${stage}\n`))
      .catch(() => {})
  }

  function authorize(event: IpcMainInvokeEvent): CaptureSource {
    const source = sources.find((item) => !item.window.isDestroyed() && event.senderFrame === item.window.webContents.mainFrame)
    if (!source) throw new Error('Untrusted capture sender')
    return source
  }

  function close(): Promise<void> {
    if (closing) return closing
    closing = (async () => {
      clearTimeout(killTimer); clearTimeout(stopTimer); clearTimeout(startupTimer)
      await outputMonitor?.stop()
      for (const item of sources) if (!item.window.isDestroyed()) item.window.destroy()
      const results = await Promise.allSettled(sources.map((item) => item.writer.close(item.padding)))
      if (results.some((result) => result.status === 'rejected')) error = 'Could not finalize one or more WAV files'
      for (const channel of [ipcChannels.captureReady, ipcChannels.captureFrame, ipcChannels.captureFinished]) ipcMain.removeHandler(channel)
      captureSession.setPermissionCheckHandler(null)
      captureSession.setPermissionRequestHandler(null)
      captureSession.setDisplayMediaRequestHandler(null)
      await debugWrites
      resolveStopped()
      if (!owner.isDestroyed()) void dialog.showMessageBox(owner, {
        type: error ? 'error' : 'info', title: 'Audio test stopped',
        message: error ?? 'Audio test saved. Validate and listen to each WAV before reporting success.', detail: directory
      })
    })()
    return closing
  }

  function stop(): Promise<void> {
    if (!stopping && !closing) {
      stopping = true
      void outputMonitor?.stop()
      for (const item of sources) if (!item.finished && !item.window.isDestroyed()) item.window.webContents.send(ipcChannels.captureStop)
      killTimer = setTimeout(() => { error ??= 'Capture stop timed out'; void close() }, 3000)
    }
    return stopped
  }

  captureSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const item = sources.find((source) => !source.window.isDestroyed() && contents === source.window.webContents)
    debug(`permission-check ${item?.source ?? 'untrusted'} ${permission} ${details.mediaType ?? ''}`)
    return !!item && !stopping && (item.source === 'system' ? permission === 'display-capture'
      : permission === 'media' && details.mediaType === 'audio')
  })
  captureSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const item = sources.find((source) => !source.window.isDestroyed() && contents === source.window.webContents)
    debug(`permission-request ${item?.source ?? 'untrusted'} ${permission}`)
    callback(!!item && !stopping && (item.source === 'system' ? permission === 'display-capture'
      : permission === 'media' && 'mediaTypes' in details && details.mediaTypes !== undefined &&
        details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === 'audio')))
  })
  captureSession.setDisplayMediaRequestHandler((request, callback) => {
    debug('display-request received')
    const item = sources.find((source) => source.source === 'system' && !source.window.isDestroyed() &&
      request.frame === source.window.webContents.mainFrame)
    if (!item || stopping || !request.audioRequested || !request.videoRequested) { callback(null); return }
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((screens) => {
      debug(`display-sources ${screens.length}`)
      if (stopping || closing || item.window.isDestroyed() || !screens.length) { callback(null); return }
      callback({ video: screens[0], audio: 'loopback' })
    }).catch(() => { callback(null) })
  })

  for (const item of sources) {
    let pageStarted = false
    item.window.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
      if (!isMainFrame || !url.includes('/capture/index.html')) return
      if (pageStarted && !closing) {
        error = 'Audio capture page reloaded during startup or recording; rebuild and retry'
        void close()
      }
      pageStarted = true
    })
    item.window.webContents.on('console-message', (event) => {
      if (event.message.startsWith('[vinxa-capture]')) debug(`${item.source} ${event.message}`)
    })
    item.window.webContents.on('preload-error', () => { debug(`${item.source} preload-error`) })
    item.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    item.window.webContents.on('will-navigate', (event) => event.preventDefault())
    item.window.webContents.on('render-process-gone', () => {
      error = `${item.source} capture process exited`
      item.finished = true
      void stop()
      if (sources.every((source) => source.finished)) void close()
    })
  }
  ipcMain.handle(ipcChannels.captureFrame, async (event, frame: unknown) => {
    const item = authorize(event)
    if (closing || item.finished) throw new Error('Capture already closed')
    try { await item.writer.append(frame as ArrayBuffer) }
    catch { error = `${item.source} audio write failed; check disk space and file access`; void stop(); throw new Error(error) }
  })
  ipcMain.handle(ipcChannels.captureFinished, (event, payload: unknown) => {
    const item = authorize(event)
    const result = captureFinishedSchema.parse(payload)
    item.finished = true
    item.padding = result.error ? 0 : result.paddedSamples
    error ??= result.error
    if (error) void stop()
    if (sources.every((source) => source.finished)) setImmediate(() => { void close() })
  })
  ipcMain.handle(ipcChannels.captureReady, (event) => {
    const item = authorize(event)
    if (item.ready || item.finished || stopping) return
    item.ready = true
    if (!sources.every((source) => source.ready)) return
    clearTimeout(startupTimer)
    stopTimer = setTimeout(() => { void stop() }, 30000)
    void dialog.showMessageBox(owner, {
      type: 'info', title: 'Audio recording', message: `${names.join(' and ')} recording is active`,
      detail: 'For mic, speak for ten seconds. For system audio, play a video through Windows default output. For both, use headphones and alternate your speech with the video. Stop ends all tracks and finalizes both files.',
      buttons: ['Stop recording'], defaultId: 0
    }).then(() => stop())
  })
  startupTimer = setTimeout(() => { error = 'Audio startup timed out before the audio context became ready'; void stop() }, 20000)
  if (names.includes('system')) {
    try {
      const scriptPath = app.isPackaged
        ? join(process.resourcesPath, 'audio/default-output.ps1')
        : join(__dirname, '../../resources/audio/default-output.ps1')
      outputMonitor = await watchWindowsDefaultOutput(scriptPath, () => {
        if (stopping || closing) return
        error = 'Windows default audio output changed during system capture; check the output and restart the test'
        debug('default-output-changed')
        void stop()
      }, (message) => {
        if (stopping || closing) return
        error = message
        debug('default-output-monitor-failed')
        void stop()
      })
      debug('default-output-monitor-ready')
      if (stopping || closing) { await outputMonitor.stop(); return { stop } }
    } catch {
      error = 'Windows default-output monitoring could not start; capture was stopped. Check the Windows audio runtime and monitor resource.'
      await close()
      return { stop }
    }
  }
  try {
    await Promise.all(sources.map(async (item) => {
      const query = { source: item.source, micGain: String(item.source === 'mic' ? micGain : 1) }
      if (process.env.ELECTRON_RENDERER_URL) {
        await item.window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture/index.html?${new URLSearchParams(query)}`)
      } else await item.window.loadFile(join(__dirname, '../renderer/capture/index.html'), { query })
    }))
  } catch { error = 'Could not load an audio capture window'; await close() }
  return { stop }
}
