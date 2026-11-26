import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { ipcChannels } from '../../shared/ipc-channels'
import { captureFinishedSchema } from '../../shared/schemas'
import { WavWriter } from './wav-writer'

export async function startMicrophoneTest(owner: BrowserWindow): Promise<{ stop(): Promise<void> } | undefined> {
  const consent = await dialog.showMessageBox(owner, {
    type: 'question', title: 'Microphone capture test',
    message: 'Record this microphone to test_recordings/mic.wav?',
    detail: 'Tell anyone nearby before starting. Audio stays on this computer. The test stops automatically after 30 seconds. An existing mic.wav is kept; move it before repeating.',
    buttons: ['Cancel', 'Start microphone test'], defaultId: 0, cancelId: 0
  })
  if (consent.response !== 1) return
  const filePath = join(app.getAppPath(), 'test_recordings', 'mic.wav')
  const writer = await WavWriter.create(filePath)
  const captureSession = session.fromPartition('vinxa-microphone-test')
  const capture = new BrowserWindow({ show: false, webPreferences: {
    session: captureSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
    backgroundThrottling: false, preload: join(__dirname, '../preload/index.js')
  } })
  let closing: Promise<void> | undefined
  let resolveStopped: () => void
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
  let stopping = false
  let error: string | null = null
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined

  function authorize(event: IpcMainInvokeEvent): void {
    if (event.senderFrame !== capture.webContents.mainFrame) throw new Error('Untrusted capture sender')
  }

  function close(padding = 0): Promise<void> {
    if (closing) return closing
    closing = (async () => {
      clearTimeout(killTimer); clearTimeout(stopTimer); clearTimeout(startupTimer)
      // Destroy first on forced stop so a stalled disk cannot keep the device open.
      if (!capture.isDestroyed()) capture.destroy()
      try { await writer.close(padding) }
      catch { error = 'Could not finalize the microphone WAV file' }
      finally {
        for (const channel of [ipcChannels.captureReady, ipcChannels.captureFrame, ipcChannels.captureFinished]) ipcMain.removeHandler(channel)
        captureSession.setPermissionCheckHandler(null)
        captureSession.setPermissionRequestHandler(null)
        if (!capture.isDestroyed()) capture.destroy()
        resolveStopped()
      }
      if (!owner.isDestroyed()) void dialog.showMessageBox(owner, {
        type: error ? 'error' : 'info', title: 'Microphone test stopped',
        message: error ?? 'Microphone test saved. Validate the WAV before reporting success.',
        detail: filePath
      })
    })()
    return closing
  }

  function stop(): Promise<void> {
    if (!stopping && !closing) {
      stopping = true
      capture.webContents.send(ipcChannels.captureStop)
      killTimer = setTimeout(() => { error ??= 'Capture stop timed out'; void close() }, 3000)
    }
    return stopped
  }

  captureSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === capture.webContents && permission === 'media' && details.mediaType === 'audio' && !stopping)
  captureSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === capture.webContents && permission === 'media' &&
      'mediaTypes' in details && details.mediaTypes !== undefined && details.mediaTypes.length > 0 &&
      details.mediaTypes.every((type) => type === 'audio') && !stopping)
  })
  capture.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  capture.webContents.on('will-navigate', (event) => event.preventDefault())
  capture.webContents.on('render-process-gone', () => { error = 'Microphone capture process exited'; void close() })
  ipcMain.handle(ipcChannels.captureFrame, async (event, frame: unknown) => {
    authorize(event)
    if (closing) throw new Error('Capture already closed')
    try { await writer.append(frame as ArrayBuffer) }
    catch { error = 'Audio write failed; check disk space and file access'; void stop(); throw new Error(error) }
  })
  ipcMain.handle(ipcChannels.captureFinished, async (event, payload: unknown) => {
    authorize(event)
    const result = captureFinishedSchema.parse(payload)
    error ??= result.error
    // Let the IPC acknowledgement reach preload before destroying its window.
    setImmediate(() => { void close(error ? 0 : result.paddedSamples) })
  })
  ipcMain.handle(ipcChannels.captureReady, (event) => {
    authorize(event)
    clearTimeout(startupTimer)
    stopTimer = setTimeout(() => { void stop() }, 30000)
    void dialog.showMessageBox(owner, {
      type: 'info', title: 'Microphone recording', message: 'Microphone recording is active',
      detail: 'Speak for at least ten seconds. Stop ends microphone access and finalizes the WAV.',
      buttons: ['Stop recording'], defaultId: 0
    }).then(() => stop())
  })
  startupTimer = setTimeout(() => { error = 'Microphone startup timed out'; void stop() }, 20000)
  try {
    if (process.env.ELECTRON_RENDERER_URL) await capture.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture/index.html`)
    else await capture.loadFile(join(__dirname, '../renderer/capture/index.html'))
  } catch { error = 'Could not load the microphone capture window'; await close() }
  return { stop }
}
