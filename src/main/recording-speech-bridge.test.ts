import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { RecordingState } from '../shared/contracts'
import { attachSpeechAppExit, RecordingSpeechBridge } from './recording-speech-bridge'

function setup() {
  let state: RecordingState = 'awaiting-consent'
  let consent = false
  const manager = { start: vi.fn().mockResolvedValue(undefined), sendFrame: vi.fn().mockReturnValue(true),
    sourceEnd: vi.fn().mockResolvedValue(undefined), pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) }
  const owner = { getState: () => state, hasConsent: () => consent }
  const bridge = new RecordingSpeechBridge(manager, owner)
  const session = { sessionId: randomUUID(), meetingId: 'test-meeting', model: 'base.en', language: 'en', enabledSources: ['mic'] as 'mic'[] }
  return { manager, bridge, session, state: (next: RecordingState) => { state = next }, consent: (next: boolean) => { consent = next } }
}

describe('Developer A recording integration boundary', () => {
  it('requires both consent and the owner state before startup', async () => {
    const test = setup()
    await expect(test.bridge.start(test.session)).rejects.toThrow('authorized')
    expect(test.manager.start).not.toHaveBeenCalled()
    test.consent(true); test.state('idle')
    await expect(test.bridge.start(test.session)).rejects.toThrow('authorized')
    test.state('awaiting-consent')
    await test.bridge.start(test.session)
    expect(test.manager.start).toHaveBeenCalledTimes(1)
    await test.bridge.stop()
  })

  it('rejects paused, revoked, stale-session and unmeasured audio; adds the prefix only once', async () => {
    const test = setup()
    test.consent(true); await test.bridge.start(test.session)
    const frame = new ArrayBuffer(3201)
    expect(test.bridge.taggedFrame(test.session.sessionId, frame, { startSample: 0 })).toBe(false)
    test.state('recording')
    expect(() => test.bridge.taggedFrame(test.session.sessionId, frame)).toThrow('measured')
    expect(test.bridge.taggedFrame('old-session', frame, { startSample: 0 })).toBe(false)
    expect(test.bridge.taggedFrame(test.session.sessionId, frame, { startSample: 0 })).toBe(true)
    expect(test.manager.sendFrame.mock.calls[0][1].length).toBe(3200)
    test.state('paused')
    expect(test.bridge.taggedFrame(test.session.sessionId, frame, { startSample: 1600 })).toBe(false)
    test.state('recording'); test.consent(false)
    expect(test.bridge.taggedFrame(test.session.sessionId, frame, { startSample: 1600 })).toBe(false)
    await test.bridge.stop()
  })

  it('keeps pause/resume/stop ownership outside the adapter and allows stopping after revoked consent', async () => {
    const test = setup()
    test.consent(true); await test.bridge.start(test.session)
    test.state('paused'); await test.bridge.pause(test.session.sessionId)
    await test.bridge.resume(test.session.sessionId)
    test.state('stopping'); test.consent(false)
    await test.bridge.sourceEnd(test.session.sessionId, 'mic', 123)
    await test.bridge.stop(test.session.sessionId)
    expect(test.manager.sourceEnd).toHaveBeenCalledWith('mic', 123)
    expect(test.manager.stop).toHaveBeenCalledTimes(1)
    expect(test.bridge.active).toBe(false)
  })

  it('cancels startup if authorization is revoked while waiting for model readiness', async () => {
    const test = setup()
    test.consent(true)
    test.manager.start.mockImplementation(async () => { test.consent(false) })
    await expect(test.bridge.start(test.session)).rejects.toThrow('changed')
    expect(test.manager.stop).toHaveBeenCalledTimes(1)
    expect(test.bridge.active).toBe(false)
  })

  it('awaits graceful shutdown on app exit and removes its handler', async () => {
    const test = setup()
    test.consent(true); await test.bridge.start(test.session)
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
    const detach = attachSpeechAppExit(app as unknown as Pick<App, 'on' | 'removeListener' | 'quit'>, test.bridge)
    const event = { preventDefault: vi.fn() }
    app.emit('before-quit', event)
    expect(event.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
    detach()
    expect(app.listenerCount('before-quit')).toBe(0)
  })

  it('admits trailing stop frames only after an explicitly authorized drain', async () => {
    const test = setup()
    test.consent(true); test.state('recording')
    await test.bridge.start(test.session)
    test.state('stopping')
    const frame = new ArrayBuffer(3201)
    expect(test.bridge.taggedFrame(test.session.sessionId, frame, { startSample: 0 })).toBe(false)
    test.bridge.beginDrain(test.session.sessionId)
    expect(test.bridge.taggedFrame(test.session.sessionId, frame, { startSample: 0 })).toBe(true)
    test.consent(false)
    expect(test.bridge.taggedFrame(test.session.sessionId, frame, { startSample: 1600 })).toBe(false)
    await test.bridge.stop()
  })
})
