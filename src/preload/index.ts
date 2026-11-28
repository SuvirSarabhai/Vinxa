import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureBridge, DesktopApi } from '../shared/contracts'
import { createPhase2Api } from './phase2'
import { createMeetingsApi } from './meetings'
import { createPhase5Api } from './phase5'
import { ipcChannels } from '../shared/ipc-channels'
import { audioFrameMetadataSchema, captureFrameDiagnosticsSchema, captureFinishedSchema, fixtureCommandSchema, fixtureStatusSchema,
  sidecarEventSchema, transcriptSegmentSchema } from '../shared/schemas'
import { validatePcmFrame } from '../shared/pcm'

const desktopApi: DesktopApi = {
  onEngineStatus: (listener) => {
    let active = true
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const result = sidecarEventSchema.safeParse(payload)
      if (active && result.success && result.data.type === 'status') listener(result.data)
    }
    ipcRenderer.on(ipcChannels.engineStatus, handler)
    void ipcRenderer.invoke(ipcChannels.engineStatusGet).then((payload) => handler({} as Electron.IpcRendererEvent, payload)).catch(() => {})
    return () => { active = false; ipcRenderer.removeListener(ipcChannels.engineStatus, handler) }
  },

  onError: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const result = sidecarEventSchema.safeParse(payload)
      if (result.success && result.data.type === 'error') listener(result.data)
    }
    ipcRenderer.on(ipcChannels.errorRaised, handler)
    return () => ipcRenderer.removeListener(ipcChannels.errorRaised, handler)
  },
  fixtureCommand: (command) => ipcRenderer.invoke(ipcChannels.fixtureCommand, fixtureCommandSchema.parse(command)),
  onTranscript: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const result = transcriptSegmentSchema.safeParse(payload)
      if (result.success) listener(result.data)
    }
    ipcRenderer.on(ipcChannels.transcriptSegment, handler)
    return () => ipcRenderer.removeListener(ipcChannels.transcriptSegment, handler)
  },
  onFixtureStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const result = fixtureStatusSchema.safeParse(payload)
      if (result.success) listener(result.data)
    }
    ipcRenderer.on(ipcChannels.fixtureStatus, handler)
    return () => ipcRenderer.removeListener(ipcChannels.fixtureStatus, handler)
  }
}
contextBridge.exposeInMainWorld('vinxaMeetings', createMeetingsApi())
contextBridge.exposeInMainWorld('vinxaPhase5', createPhase5Api())

contextBridge.exposeInMainWorld('vinxa', desktopApi)
contextBridge.exposeInMainWorld('vinxaPhase2', createPhase2Api())

const captureBridge: CaptureBridge = {
  clockSync: (clientSendMs) => ipcRenderer.invoke(ipcChannels.captureClock, clientSendMs),
  ready: (deviceId) => ipcRenderer.invoke(ipcChannels.captureReady,deviceId),
  frame: (frame, metadata, diagnostics) => {
    validatePcmFrame(frame)
    if (diagnostics !== undefined) return ipcRenderer.invoke(ipcChannels.captureFrame, frame,
      metadata === undefined ? undefined : audioFrameMetadataSchema.parse(metadata),
      captureFrameDiagnosticsSchema.parse(diagnostics))
    if (metadata === undefined) return ipcRenderer.invoke(ipcChannels.captureFrame, frame)
    return ipcRenderer.invoke(ipcChannels.captureFrame, frame, audioFrameMetadataSchema.parse(metadata))
  },
  finished: (result) => ipcRenderer.invoke(ipcChannels.captureFinished, captureFinishedSchema.parse(result)),
  onStop: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(ipcChannels.captureStop, handler)
    return () => ipcRenderer.removeListener(ipcChannels.captureStop, handler)
  }
}
contextBridge.exposeInMainWorld('vinxaCapture', captureBridge)

