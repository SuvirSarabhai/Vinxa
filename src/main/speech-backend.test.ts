import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionController } from './session-controller'
import { RecordingSpeechBridge } from './recording-speech-bridge'
import type { SpeechServiceEvent } from './speech-service'
import type { RecordingOwner } from './recording-speech-bridge'
import { createSpeechBackend } from './speech-backend'

const fake = vi.hoisted(() => ({ service: null as any, captures: [] as any[] }))
vi.mock('./speech-service', () => ({ getAppSpeech: () => fake.service }))
vi.mock('./audio/recording-capture', () => ({ RecordingCapture: class {
  finalPadding = { mic: 7 }
  constructor(readonly frame: any, readonly level: any, readonly failure: any) { fake.captures.push(this) }
  start = vi.fn(async () => { this.frame('mic', new Uint8Array(3200), { startSample: 0 }); this.level('mic', 0.5) })
  stop = vi.fn(async () => { this.frame('mic', new Uint8Array(3200), { startSample: 1600 }) })
  resume = vi.fn(async () => { this.frame('mic', new Uint8Array(3200), { startSample: 32000 }) })
  abort = vi.fn().mockResolvedValue(undefined)
} }))

const config = { title: 'Integration', microphoneEnabled: true, systemAudioEnabled: false, microphoneDeviceId: 'selected' }

function setup() {
  const listeners = new Set<(event: SpeechServiceEvent) => void>()
  const manager = { ready: true, start: vi.fn().mockResolvedValue(undefined), sendFrame: vi.fn().mockReturnValue(true),
    sourceEnd: vi.fn().mockResolvedValue(undefined), pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) }
  fake.service = { manager, selectedModel: 'base.en', selectedLanguage: 'en',
    subscribe: (listener: (event: SpeechServiceEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    createBridge: (owner: RecordingOwner) => new RecordingSpeechBridge(manager, owner) }
  const backend = createSpeechBackend({} as any)
  const consent = vi.fn().mockResolvedValue(undefined)
  const controller = new SessionController(backend, consent)
  const emit = (event: SpeechServiceEvent) => { for (const listener of listeners) listener(event) }
  return { backend, controller, manager, consent, emit }
}

beforeEach(() => { fake.captures = [] })

describe('speech backend with the real session controller and recording bridge', () => {
  it('opens capture only after consent and retains final publication while Stop drains trailing audio', async () => {
    const test = setup()
    expect(fake.captures).toHaveLength(0)
    test.controller.requestStart()
    expect(fake.captures).toHaveLength(0)
    await test.controller.confirm(config, true)
    expect(test.consent).toHaveBeenCalledOnce()
    expect(fake.captures[0].start).toHaveBeenCalledWith(config, expect.any(Number))
    expect(test.manager.sendFrame).toHaveBeenCalledOnce()
    const id = test.controller.snapshot().sessionId!
    test.manager.stop.mockImplementationOnce(async () => test.emit({ type: 'transcript', segment: {
      id: 'last', meetingId: id, source: 'mic', speakerId: null, text: 'Last words', startMs: 0, endMs: 500, isFinal: true
    } }))
    await test.controller.stop()
    expect(test.manager.sendFrame).toHaveBeenCalledTimes(2)
    expect(test.manager.sourceEnd).toHaveBeenCalledWith('mic', 7)
    expect(test.controller.snapshot()).toMatchObject({ state: 'completed', segments: [{ text: 'Last words', speakerId: 'you' }] })
    test.backend.dispose?.()
  })

  it('releases devices before pausing and authorizes the first frame produced during resume', async () => {
    const test = setup()
    test.controller.requestStart()
    await test.controller.confirm(config, true)
    await test.controller.pauseResume()
    expect(test.controller.snapshot().state).toBe('paused')
    expect(fake.captures[0].stop).toHaveBeenCalledOnce()
    expect(test.manager.sourceEnd.mock.invocationCallOrder[0]).toBeLessThan(test.manager.pause.mock.invocationCallOrder[0])
    await test.controller.pauseResume()
    expect(test.controller.snapshot().state).toBe('recording')
    expect(test.manager.resume).toHaveBeenCalledOnce()
    expect(test.manager.sendFrame).toHaveBeenCalledTimes(3)
    await test.controller.stop()
    test.backend.dispose?.()
  })

  it('removes failed-generation provisional text while keeping final text', async () => {
    const test = setup()
    test.controller.requestStart()
    await test.controller.confirm(config, true)
    const id = test.controller.snapshot().sessionId!
    const segment = { id: 'done', meetingId: id, source: 'mic' as const, speakerId: null, text: 'Committed', startMs: 0, endMs: 300, isFinal: true }
    test.emit({ type: 'transcript', segment })
    test.emit({ type: 'transcript', segment: { ...segment, id: 'pending', text: 'Provisional', isFinal: false } })
    test.emit({ type: 'status', sessionId: id, generation: 1, status: 'restarting' })
    expect(test.controller.snapshot().segments.map((value) => value.id)).toEqual(['done'])
    await test.controller.stop()
    test.backend.dispose?.()
  })

  it('keeps the same microphone session authorized through five pause/resume cycles', async () => {
    const test = setup()
    test.controller.requestStart()
    await test.controller.confirm(config, true)
    const id = test.controller.snapshot().sessionId
    for (let cycle = 0; cycle < 5; cycle++) {
      await test.controller.pauseResume()
      expect(test.controller.snapshot()).toMatchObject({ state: 'paused', sessionId: id, error: null })
      await test.controller.pauseResume()
      expect(test.controller.snapshot()).toMatchObject({ state: 'recording', sessionId: id, error: null })
    }
    expect(test.manager.pause).toHaveBeenCalledTimes(5)
    expect(test.manager.resume).toHaveBeenCalledTimes(5)
    expect(test.manager.sendFrame).toHaveBeenCalledTimes(11)
    await test.controller.stop()
    expect(test.controller.snapshot()).toMatchObject({ state: 'completed', error: null })
    test.backend.dispose?.()
  })
})
