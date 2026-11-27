import { ipcRenderer } from 'electron'
import { overlayDragSchema, phase2Channels, phase2CommandSchema, phase2SnapshotSchema } from '../shared/phase2'
import type { Phase2Api } from '../shared/phase2'

export function createPhase2Api(): Phase2Api {
  return {
    dragOverlay(phase) {
      ipcRenderer.send(phase2Channels.overlayDrag, overlayDragSchema.parse(phase))
    },
    async command(command) {
      await ipcRenderer.invoke(phase2Channels.command, phase2CommandSchema.parse(command))
    },
    async snapshot() {
      const value: unknown = await ipcRenderer.invoke(phase2Channels.snapshot)
      return phase2SnapshotSchema.parse(value)
    },
    onChange(listener) {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        const result = phase2SnapshotSchema.safeParse(value)
        if (result.success) listener(result.data)
      }
      ipcRenderer.on(phase2Channels.changed, handler)
      return () => ipcRenderer.removeListener(phase2Channels.changed, handler)
    }
  }
}
