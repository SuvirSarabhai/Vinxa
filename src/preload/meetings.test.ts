import { beforeEach, describe, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
import { createMeetingsApi } from './meetings'
import { ipcChannels } from '../shared/ipc-channels'
describe('meeting preload runtime boundaries', () => {
  beforeEach(() => vi.clearAllMocks())
  it('rejects invalid commands and settings before IPC', async () => {
    const api = createMeetingsApi()
    await expect(api.get('../other-profile')).rejects.toThrow()
    await expect(api.command({type:'rename',id:'not-a-uuid',title:'Title'})).rejects.toThrow()
    await expect(api.saveSettings({provider:'ollama',cloudEnabled:false,ollamaModel:'',openaiModel:'',chunkCharacters:0,timeoutSeconds:30})).rejects.toThrow()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
  it('validates returned database records and unregisters change listeners', async () => {
    const api=createMeetingsApi()
    ipc.invoke.mockResolvedValueOnce({meetings:[{title:'incomplete'}],stats:{totalMeetings:1,pendingActions:0}})
    await expect(api.list()).rejects.toThrow()
    expect(ipc.invoke).toHaveBeenCalledWith(ipcChannels.meetingsList)
    const listener=vi.fn(), off=api.onChange(listener)
    ipc.on.mock.calls[0][1]()
    expect(listener).toHaveBeenCalledOnce()
    off()
    expect(ipc.removeListener).toHaveBeenCalledWith(ipcChannels.meetingsChanged,ipc.on.mock.calls[0][1])
  })
})
