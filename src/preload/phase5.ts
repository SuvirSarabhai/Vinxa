import { ipcRenderer } from 'electron'
import { phase5Channel, phase5RequestSchema, phase5ResultSchema } from '../shared/phase5'
import type { Phase5Api } from '../shared/phase5'
import { searchResultSchema } from '../shared/phase4'
export function createPhase5Api(): Phase5Api {
  return {
    async request(input) { return phase5ResultSchema.parse(await ipcRenderer.invoke(phase5Channel, phase5RequestSchema.parse(input))) },
    onOpenTools(listener) {
      const handler = (): void => listener()
      ipcRenderer.on('phase5:open-tools', handler)
      return () => ipcRenderer.removeListener('phase5:open-tools', handler)
    },
    onPassage(listener) {
      const handler = (_event: Electron.IpcRendererEvent, input: unknown): void => {
        const parsed = searchResultSchema.safeParse(input)
        if (parsed.success) listener(parsed.data)
      }
      ipcRenderer.on('phase5:passage', handler)
      return () => ipcRenderer.removeListener('phase5:passage', handler)
    }
  }
}
