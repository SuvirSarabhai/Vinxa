import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ipcChannels } from '../shared/ipc-channels'

const fake = vi.hoisted(() => ({ managers: [] as any[], failRuntime: false,
  handlers: new Map<string, any>() }))
vi.mock('electron', () => ({ app: { getAppPath: () => 'D:/test', isPackaged: false },
  ipcMain: { handle: (name: string, fn: any) => fake.handlers.set(name, fn) } }))
vi.mock('./sidecar-manager', () => ({
  SidecarOperationError: class extends Error {},
  resolveSidecarRuntime: () => { if (fake.failRuntime) throw new Error('private-init-string'); return { command: 'test' } },
  SidecarManager: class {
    prewarm = vi.fn().mockResolvedValue(undefined)
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    endSession = vi.fn().mockResolvedValue(undefined)
    sourceEnd = vi.fn().mockResolvedValue(undefined)
    pause = vi.fn().mockResolvedValue(undefined)
    resume = vi.fn().mockResolvedValue(undefined)
    sendFrame = vi.fn().mockReturnValue(true)
    constructor(readonly options: any) { fake.managers.push(this) }
  }
}))
beforeEach(() => { vi.resetModules(); fake.managers.length = 0; fake.failRuntime = false; fake.handlers.clear() })
afterEach(() => vi.unstubAllEnvs())

it('initializes once and reuses the warmed manager through the normal recording bridge factory', async () => {
  const service = await import('./speech-service')
  const bridgeModule = await import('./recording-speech-bridge')
  const window = { isDestroyed: () => false, webContents: { send: vi.fn(), mainFrame: {} } } as any
  await service.initializeAppSpeech(window)
  await service.initializeAppSpeech(window)
  expect(fake.managers).toHaveLength(1)
  const manager = fake.managers[0]
  expect(manager.prewarm).toHaveBeenCalledExactlyOnceWith('base.en', 'en')
  const owner = { getState: () => 'recording' as const, hasConsent: () => true }
  for (let index = 0; index < 2; index++) {
    const bridge = bridgeModule.createRecordingSpeechBridge(owner, { command: 'ignored', args: [] }, window)
    await bridge.start({ sessionId: randomUUID(), meetingId: 'meeting-' + index, model: 'base.en',
      language: 'en', enabledSources: ['mic'] })
    await bridge.stop()
  }
  expect(manager.start).toHaveBeenCalledTimes(2)
  expect(manager.endSession).toHaveBeenCalledTimes(2)
  expect(manager.stop).not.toHaveBeenCalled()
  await service.getAppSpeech()!.shutdown()
  expect(manager.stop).toHaveBeenCalledOnce()
})

it('reports initialization failure safely and makes status available to late subscribers', async () => {
  fake.failRuntime = true
  const { initializeAppSpeech } = await import('./speech-service')
  const window = { isDestroyed: () => false, webContents: { send: vi.fn(), mainFrame: {} } } as any
  await initializeAppSpeech(window)
  expect(window.webContents.send).toHaveBeenCalledWith(ipcChannels.engineStatus, expect.objectContaining({ status: 'error' }))
  expect(JSON.stringify(window.webContents.send.mock.calls)).not.toContain('private-init-string')
  const status = fake.handlers.get(ipcChannels.engineStatusGet)({ senderFrame: window.webContents.mainFrame })
  expect(status.status).toBe('error')
  expect(() => fake.handlers.get(ipcChannels.engineStatusGet)({ senderFrame: {} })).toThrow()
})
