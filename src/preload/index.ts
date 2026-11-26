import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'
import { fixtureCommandSchema, fixtureStatusSchema, transcriptSegmentSchema } from '../shared/schemas'

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

