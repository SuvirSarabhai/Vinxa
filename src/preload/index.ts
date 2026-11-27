import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureBridge, DesktopApi } from '../shared/contracts'
import { createPhase2Api } from './phase2'
import { ipcChannels } from '../shared/ipc-channels'
import { captureFinishedSchema, fixtureCommandSchema, fixtureStatusSchema, transcriptSegmentSchema } from '../shared/schemas'
import { validatePcmFrame } from '../shared/pcm'

const desktopApi: DesktopApi = {
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

contextBridge.exposeInMainWorld('vinxa', desktopApi)
contextBridge.exposeInMainWorld('vinxaPhase2', createPhase2Api())

const captureBridge: CaptureBridge = {
  ready: () => ipcRenderer.invoke(ipcChannels.captureReady),
  frame: (frame) => {
    validatePcmFrame(frame)
    return ipcRenderer.invoke(ipcChannels.captureFrame, frame)
  },
  finished: (result) => ipcRenderer.invoke(ipcChannels.captureFinished, captureFinishedSchema.parse(result)),
  onStop: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(ipcChannels.captureStop, handler)
    return () => ipcRenderer.removeListener(ipcChannels.captureStop, handler)
  }
}
contextBridge.exposeInMainWorld('vinxaCapture', captureBridge)

