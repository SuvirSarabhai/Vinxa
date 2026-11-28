import { randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { ipcChannels } from '../shared/ipc-channels'
import type { SidecarStatus, SidecarError, TranscriptSegment } from '../shared/contracts'
import type { RecordingOwner } from './recording-speech-bridge'
import { RecordingSpeechBridge, setWarmBridgeFactory } from './recording-speech-bridge'
import { SidecarManager, SidecarOperationError, resolveSidecarRuntime, installedSpeechModel } from './sidecar-manager'
import type { SidecarRuntime } from './sidecar-manager'

let cachedStatus: SidecarStatus | undefined
let statusHandlerRegistered = false

type SpeechWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>
export type SpeechServiceEvent = SidecarStatus | SidecarError | { type: 'transcript'; segment: TranscriptSegment }

export class SpeechService {
  readonly manager: SidecarManager
  private bridge?: RecordingSpeechBridge
  private target: SpeechWindow
  private initialization?: Promise<void>
  private shuttingDown = false
  private listeners = new Set<(event: SpeechServiceEvent) => void>()
  private latestStatus?: SidecarStatus

  constructor(runtime: SidecarRuntime, window: SpeechWindow,
    private readonly model = 'base.en', private readonly language = 'en') {
    this.target = window
    const send = (channel: string, payload: unknown): void => {
      if (!this.target.isDestroyed()) this.target.webContents.send(channel, payload)
    }
    this.manager = new SidecarManager({ runtime, keepWarm: true, protocolVersion: 2,
      onTranscript: (segment) => {
        if (this.bridge?.permitsTranscript(segment)) {
          send(ipcChannels.transcriptSegment, segment)
          this.emit({ type: 'transcript', segment })
        }
      },
      onStatus: (status) => {
        cachedStatus = this.latestStatus = status
        send(ipcChannels.engineStatus, status)
        this.emit(status)
      },
      onError: (error) => { send(ipcChannels.errorRaised, error); this.emit(error) }
    })
  }

  get selectedModel(): string { return this.model }
  get selectedLanguage(): string { return this.language }

  subscribe(listener: (event: SpeechServiceEvent) => void): () => void {
    this.listeners.add(listener)
    if (this.latestStatus) listener(this.latestStatus)
    return () => this.listeners.delete(listener)
  }

  private emit(event: SpeechServiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  initialize(): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Speech service is closing'))
    this.initialization ??= this.manager.prewarm(this.model, this.language)
    return this.initialization
  }

  createBridge(owner: RecordingOwner, window: SpeechWindow = this.target): RecordingSpeechBridge {
    if (this.bridge?.active || this.shuttingDown) throw new Error('Speech service is already owned or closing')
    const bridge = new RecordingSpeechBridge({
      start: async (session) => {
        if (this.bridge?.active && this.bridge !== bridge) throw new Error('Speech service has an active recording owner')
        await this.initialize()
        this.bridge = bridge
        this.target = window
        await this.manager.start(session)
      },
      sendFrame: (source, pcm, metadata) => this.manager.sendFrame(source, pcm, metadata),
      sourceEnd: (source, padding) => this.manager.sourceEnd(source, padding),
      pause: () => this.manager.pause(), resume: () => this.manager.resume(),
      stop: () => this.endRecording()
    }, owner)
    return bridge
  }

  private async endRecording(): Promise<void> {
    try { await this.manager.endSession() }
    catch {
      await this.manager.stop()
      this.initialization = undefined
      if (!this.shuttingDown) void this.initialize().catch(() => undefined)
      throw new SidecarOperationError('The session could not finish completely. Unfinalized words may be missing. Wait for local speech to become ready before starting another session.')
    }
  }

  beginShutdown(): void {
    this.shuttingDown = true
  }

  async shutdown(): Promise<void> {
    this.beginShutdown()
    await this.manager.stop()
  }
}

let appSpeech: SpeechService | undefined
export function getAppSpeech(): SpeechService | undefined { return appSpeech }

export async function initializeAppSpeech(window: BrowserWindow, preference = 'default'): Promise<void> {
  try {
    if (!statusHandlerRegistered) {
      ipcMain.handle(ipcChannels.engineStatusGet, (event) => {
        if (window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted engine status sender')
        return cachedStatus
      })
      statusHandlerRegistered = true
    }
    if (appSpeech) { await appSpeech.initialize(); return }
    const sourceRoot = process.env.VINXA_SIDECAR_SOURCE ?? app.getAppPath()
    const model = preference === 'default' ? (process.env.VINXA_SPEECH_MODEL || 'base.en') : preference
    const runtime = resolveSidecarRuntime({ appPath: sourceRoot,
      resourcesPath: process.resourcesPath, packaged: app.isPackaged && !process.env.VINXA_SIDECAR_SOURCE },
      process.env.VINXA_SIDECAR_PYTHON, model)
    if (preference !== 'default') {
      const path = installedSpeechModel(process.resourcesPath, model)
      if (!path) throw new Error('Selected speech model is no longer installed.')
      runtime.env = { ...runtime.env, VINXA_SPEECH_MODEL_PATH: path }
    }
    appSpeech = new SpeechService(runtime, window, model,
      process.env.VINXA_SPEECH_LANGUAGE ?? 'en')
    setWarmBridgeFactory((owner, target) => appSpeech!.createBridge(owner, target))
    await appSpeech.initialize()
  } catch {
    if (!window.isDestroyed()) {
      const sessionId = randomUUID()
      cachedStatus = { type: 'status', sessionId, generation: 0, status: 'error' }
      window.webContents.send(ipcChannels.engineStatus, cachedStatus)
      window.webContents.send(ipcChannels.errorRaised, { type: 'error', sessionId, generation: 0,
        code: 'SPEECH_INITIALIZATION_FAILED', message: 'Local speech initialization failed. Check the runtime and cached model.', recoverable: false })
    }
  }
}
