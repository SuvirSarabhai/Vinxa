import { randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { ipcChannels } from '../shared/ipc-channels'
import type { SidecarStatus } from '../shared/contracts'
import type { RecordingOwner } from './recording-speech-bridge'
import { RecordingSpeechBridge, setWarmBridgeFactory } from './recording-speech-bridge'
import { SidecarManager, resolveSidecarRuntime } from './sidecar-manager'
import type { SidecarRuntime } from './sidecar-manager'

let cachedStatus: SidecarStatus | undefined
let statusHandlerRegistered = false

type SpeechWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>

export class SpeechService {
  readonly manager: SidecarManager
  private bridge?: RecordingSpeechBridge
  private target: SpeechWindow
  private initialization?: Promise<void>
  private shuttingDown = false

  constructor(runtime: SidecarRuntime, window: SpeechWindow,
    private readonly model = 'base.en', private readonly language = 'en') {
    this.target = window
    const send = (channel: string, payload: unknown): void => {
      if (!this.target.isDestroyed()) this.target.webContents.send(channel, payload)
    }
    this.manager = new SidecarManager({ runtime, keepWarm: true, protocolVersion: 2,
      onTranscript: (segment) => {
        if (this.bridge?.permitsTranscript(segment)) send(ipcChannels.transcriptSegment, segment)
      },
      onStatus: (status) => { cachedStatus = status; send(ipcChannels.engineStatus, status) },
      onError: (error) => send(ipcChannels.errorRaised, error)
    })
  }

  get selectedModel(): string { return this.model }
  get selectedLanguage(): string { return this.language }

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
      stop: () => this.manager.endSession()
    }, owner)
    return bridge
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await this.manager.stop()
  }
}

let appSpeech: SpeechService | undefined
export function getAppSpeech(): SpeechService | undefined { return appSpeech }

export async function initializeAppSpeech(window: BrowserWindow): Promise<void> {
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
    const runtime = resolveSidecarRuntime({ appPath: sourceRoot,
      resourcesPath: process.resourcesPath, packaged: app.isPackaged && !process.env.VINXA_SIDECAR_SOURCE },
      process.env.VINXA_SIDECAR_PYTHON)
    appSpeech = new SpeechService(runtime, window, process.env.VINXA_SPEECH_MODEL ?? 'base.en',
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
