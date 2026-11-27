import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '../shared/ipc-channels'

const fake = vi.hoisted(() => ({
  apis: new Map<string, any>(), handlers: new Map<string, any>(),
  invoke: vi.fn().mockResolvedValue(undefined), remove: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => fake.apis.set(name, api) },
  ipcRenderer: {
    invoke: fake.invoke,
    on: (name: string, callback: unknown) => fake.handlers.set(name, callback),
    removeListener: fake.remove
  }
}))
const identity = { sessionId: '00000000-0000-4000-8000-000000000001', generation: 0 }

describe('sidecar preload boundary', () => {
  beforeEach(async () => {
    vi.resetModules()
    fake.apis.clear(); fake.handlers.clear(); fake.invoke.mockClear(); fake.remove.mockClear()
    await import('./index')
  })

  it('preserves numeric capture counters and rejects additional diagnostic payloads', async () => {
    const bridge = fake.apis.get('vinxaCapture')
    const frame = new ArrayBuffer(3201)
    const counters = { sequence: 4, producedSamples: 8000, rendererFrames: 5, ipcFrames: 5 }
    await bridge.frame(frame, undefined, counters)
    expect(fake.invoke).toHaveBeenLastCalledWith(ipcChannels.captureFrame, frame, undefined, counters)
    expect(() => bridge.frame(frame, undefined, { ...counters, transcript: 'private-test-phrase' })).toThrow()
    expect(() => bridge.frame(frame, undefined, { ...counters, sequence: -1 })).toThrow()
    expect(fake.invoke).toHaveBeenCalledTimes(1)
  })

  it('validates engine events and removes the exact subscription on unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = fake.apis.get('vinxa').onEngineStatus(listener)
    const handler = fake.handlers.get(ipcChannels.engineStatus)
    handler({}, { type: 'status', ...identity, status: 'starting' })
    handler({}, { type: 'status', ...identity, status: 'fake-ready' })
    handler({}, { type: 'status', status: 'ready' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(fake.remove).toHaveBeenCalledWith(ipcChannels.engineStatus, handler)
  })

  it('delivers cached readiness to a late subscriber and honors unsubscribe before it resolves', async () => {
    const status = { type: 'status', ...identity, status: 'ready' }
    fake.invoke.mockResolvedValueOnce(status)
    const listener = vi.fn()
    fake.apis.get('vinxa').onEngineStatus(listener)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(status))
    fake.invoke.mockResolvedValueOnce(status)
    const cancelled = vi.fn()
    const unsubscribe = fake.apis.get('vinxa').onEngineStatus(cancelled)
    unsubscribe()
    await Promise.resolve()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('accepts only validated error events on the error channel', () => {
    const listener = vi.fn()
    const unsubscribe = fake.apis.get('vinxa').onError(listener)
    const handler = fake.handlers.get(ipcChannels.errorRaised)
    handler({}, { type: 'error', ...identity, code: 'TEST', message: 'Safe error', recoverable: false })
    handler({}, { type: 'error', ...identity, code: 'TEST', message: 'Missing recoverability' })
    handler({}, { type: 'status', ...identity, status: 'ready' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(fake.remove).toHaveBeenCalledWith(ipcChannels.errorRaised, handler)
  })

  it('preserves tagged Phase 1 calls and validates optional live timing', async () => {
    const bridge = fake.apis.get('vinxaCapture')
    const frame = new ArrayBuffer(3201)
    await bridge.frame(frame)
    expect(fake.invoke).toHaveBeenLastCalledWith(ipcChannels.captureFrame, frame)
    await bridge.frame(frame, { startSample: 3200 })
    expect(fake.invoke).toHaveBeenLastCalledWith(ipcChannels.captureFrame, frame, { startSample: 3200 })
    expect(() => bridge.frame(frame, { startSample: -1 })).toThrow()
    expect(() => bridge.frame(frame, { startSample: 0, extra: true })).toThrow()
    expect(fake.invoke).toHaveBeenCalledTimes(2)
  })
})
