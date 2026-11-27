import type { App, BrowserWindow } from 'electron'
import type { AudioFrameMetadata, AudioSourceName, RecordingState, TranscriptSegment } from '../shared/contracts'
import { sourceIds } from '../shared/contracts'
import { speechDiagnostics } from './speech-diagnostics'
import { ipcChannels } from '../shared/ipc-channels'
import { validatePcmFrame } from '../shared/pcm'
import { SidecarManager, SidecarOperationError } from './sidecar-manager'
import type { SidecarRuntime, SidecarSession } from './sidecar-manager'

let warmBridgeFactory: ((owner: RecordingOwner, window: Pick<BrowserWindow, 'isDestroyed' | 'webContents'>) => RecordingSpeechBridge) | undefined
export function setWarmBridgeFactory(factory: typeof warmBridgeFactory): void { warmBridgeFactory = factory }

export interface RecordingOwner {
  getState(): RecordingState
  hasConsent(sessionId: string): boolean
}
type Manager = Pick<SidecarManager, 'start' | 'sendFrame' | 'sourceEnd' | 'pause' | 'resume' | 'stop'>

/** An adapter to Developer A's owner. It never changes recording state or opens a device. */
export class RecordingSpeechBridge {
  private session?: SidecarSession
  private draining = false
  constructor(private readonly manager: Manager, private readonly owner: RecordingOwner) {}
  get active(): boolean { return this.session !== undefined }

  async start(session: SidecarSession): Promise<void> {
    if (this.active || !this.owner.hasConsent(session.sessionId) ||
      !['awaiting-consent', 'recording'].includes(this.owner.getState())) {
      throw new SidecarOperationError('Recording owner has not authorized speech startup')
    }
    this.session = session
    this.draining = false
    try {
      await this.manager.start(session)
      if (!this.owner.hasConsent(session.sessionId) || !['awaiting-consent', 'recording'].includes(this.owner.getState())) {
        await this.manager.stop()
        throw new SidecarOperationError('Recording authorization changed during startup')
      }
    } catch (error) { this.session = undefined; throw error }
  }

  frame(sessionId: string, source: AudioSourceName, pcm: Uint8Array, metadata?: AudioFrameMetadata): boolean {
    speechDiagnostics.record('bridge_received', source, pcm.byteLength / 2)
    const state = this.owner.getState()
    if (this.session?.sessionId !== sessionId || !this.owner.hasConsent(sessionId) ||
      (state !== 'recording' && !(state === 'stopping' && this.draining))) {
      speechDiagnostics.record('bridge_rejected_authorization', source, pcm.byteLength / 2)
      return false
    }
    if (!metadata) {
      speechDiagnostics.record('bridge_rejected_missing_timing', source, pcm.byteLength / 2)
      throw new SidecarOperationError('Live audio requires measured session sample timing')
    }
    return this.manager.sendFrame(source, pcm, metadata)
  }

  taggedFrame(sessionId: string, frame: ArrayBuffer, metadata?: AudioFrameMetadata): boolean {
    validatePcmFrame(frame)
    const bytes = new Uint8Array(frame)
    return this.frame(sessionId, bytes[0] === sourceIds.mic ? 'mic' : 'system', bytes.subarray(1), metadata)
  }

  permitsTranscript(segment: TranscriptSegment): boolean {
    return this.session?.meetingId === segment.meetingId && this.owner.hasConsent(this.session.sessionId) &&
      ['recording', 'paused', 'stopping', 'processing'].includes(this.owner.getState())
  }
  private requireSession(sessionId: string): void {
    if (this.session?.sessionId !== sessionId) throw new SidecarOperationError('Inactive recording session')
  }
  beginDrain(sessionId: string): void {
    this.requireSession(sessionId)
    if (!this.owner.hasConsent(sessionId) || !['recording', 'stopping'].includes(this.owner.getState())) {
      throw new SidecarOperationError('Recording owner has not authorized final audio draining')
    }
    this.draining = true
  }
  async pause(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    if (!this.owner.hasConsent(sessionId) || !['recording', 'paused'].includes(this.owner.getState())) {
      throw new SidecarOperationError('Recording owner has not authorized pause')
    }
    await this.manager.pause()
    this.draining = false
  }
  async resume(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    if (!this.owner.hasConsent(sessionId) || !['paused', 'recording'].includes(this.owner.getState())) {
      throw new SidecarOperationError('Recording owner has not authorized resume')
    }
    await this.manager.resume()
  }
  async sourceEnd(sessionId: string, source: AudioSourceName, paddedSamples: number): Promise<void> {
    this.requireSession(sessionId)
    await this.manager.sourceEnd(source, paddedSamples)
  }
  async stop(sessionId?: string): Promise<void> {
    if (sessionId) this.requireSession(sessionId)
    if (!this.session) return
    try { await this.manager.stop() }
    finally { this.session = undefined; this.draining = false }
  }
}

/** Publish through the existing IPC and preload subscriptions, without new UI handlers. */
export function createRecordingSpeechBridge(owner: RecordingOwner, runtime: SidecarRuntime,
  window: Pick<BrowserWindow, 'isDestroyed' | 'webContents'>): RecordingSpeechBridge {
  if (warmBridgeFactory) return warmBridgeFactory(owner, window)
  let bridge: RecordingSpeechBridge
  const send = (channel: string, payload: unknown): void => { if (!window.isDestroyed()) window.webContents.send(channel, payload) }
  const manager = new SidecarManager({ runtime,
    onTranscript: (segment) => { if (bridge.permitsTranscript(segment)) send(ipcChannels.transcriptSegment, segment) },
    onStatus: (status) => send(ipcChannels.engineStatus, status),
    onError: (error) => send(ipcChannels.errorRaised, error)
  })
  bridge = new RecordingSpeechBridge(manager, owner)
  return bridge
}

export function attachSpeechAppExit(app: Pick<App, 'on' | 'removeListener' | 'quit'>, bridge: RecordingSpeechBridge): () => void {
  let finalQuit = false
  let pending: Promise<void> | undefined
  const handler = (event: { preventDefault(): void }): void => {
    if (finalQuit || !bridge.active) return
    event.preventDefault()
    if (pending) return
    pending = bridge.stop().then(() => { finalQuit = true; app.quit() }).catch(() => { pending = undefined })
  }
  app.on('before-quit', handler)
  return () => app.removeListener('before-quit', handler)
}
