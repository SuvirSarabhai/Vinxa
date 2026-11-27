import { describe, expect, it, vi } from 'vitest'
import { SessionController } from './session-controller'
import type { BackendEvents, ConsentRecord, RecordingBackend } from '../shared/phase2'

const config = { title: 'Test meeting', microphoneEnabled: true, systemAudioEnabled: true, microphoneDeviceId: null }

function harness(saveConsent = vi.fn<(record: ConsentRecord) => Promise<void>>().mockResolvedValue(undefined)) {
  let events: BackendEvents | undefined
  let sessionId = ''
  const backend = {
    mode: 'demo' as const,
    start: vi.fn<RecordingBackend['start']>().mockImplementation(async (_config, id, callbacks) => {
      sessionId = id
      events = callbacks
    }),
    pause: vi.fn<RecordingBackend['pause']>().mockResolvedValue(undefined),
    resume: vi.fn<RecordingBackend['resume']>().mockResolvedValue(undefined),
    stop: vi.fn<RecordingBackend['stop']>().mockResolvedValue(undefined)
  }
  let now = 1000
  const controller = new SessionController(backend, saveConsent, () => now)
  return { controller, backend, saveConsent, events: () => events!, sessionId: () => sessionId, time: (value: number) => { now = value } }
}

describe('SessionController', () => {
  it('requires a start request and explicit consent before calling the backend', async () => {
    const target = harness()
    await expect(target.controller.confirm(config, true)).rejects.toThrow('Start a session')
    target.controller.requestStart()
    await expect(target.controller.confirm(config, false)).rejects.toThrow('Consent is required')
    expect(target.backend.start).not.toHaveBeenCalled()
    expect(target.saveConsent).not.toHaveBeenCalled()
    await target.controller.confirm(config, true)
    expect(target.saveConsent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'demo', statementVersion: 'phase2-v1' }))
    expect(target.backend.start).toHaveBeenCalledTimes(1)
    expect(target.controller.snapshot().state).toBe('recording')
  })

  it('does not start capture if cancelled while the consent record is being written', async () => {
    let finishWrite!: () => void
    const pending = new Promise<void>((resolve) => { finishWrite = resolve })
    const target = harness(vi.fn<(record: ConsentRecord) => Promise<void>>().mockReturnValue(pending))
    target.controller.requestStart()
    const confirmation = target.controller.confirm(config, true)
    target.controller.cancel()
    target.controller.requestStart()
    finishWrite()
    await confirmation
    expect(target.backend.start).not.toHaveBeenCalled()
    expect(target.controller.snapshot()).toMatchObject({ state: 'awaiting-consent', busy: false, consentRequest: 2 })
  })

  it('does not capture if consent logging fails, and permits a retry', async () => {
    const target = harness()
    target.saveConsent.mockRejectedValueOnce(new Error('Disk unavailable'))
    target.controller.requestStart()
    await expect(target.controller.confirm(config, true)).rejects.toThrow()
    expect(target.backend.start).not.toHaveBeenCalled()
    expect(target.controller.snapshot()).toMatchObject({ state: 'awaiting-consent', busy: false })
    await target.controller.confirm(config, true)
    expect(target.controller.snapshot().state).toBe('recording')
  })

  it('cleans up and reports an error when the backend fails to start', async () => {
    const target = harness()
    target.backend.start.mockRejectedValueOnce(new Error('Unavailable'))
    target.controller.requestStart()
    await expect(target.controller.confirm(config, true)).rejects.toThrow('could not start')
    expect(target.backend.stop).toHaveBeenCalled()
    expect(target.controller.snapshot()).toMatchObject({ state: 'error', busy: false })
  })

  it('replaces partial text, ignores late partials, and rejects disabled or foreign sources', async () => {
    const target = harness()
    target.controller.requestStart()
    await target.controller.confirm({ ...config, systemAudioEnabled: false }, true)
    const partial = { id: 'one', meetingId: target.sessionId(), source: 'mic' as const, speakerId: 'you', text: 'Hello', startMs: 0, endMs: 300, isFinal: false }
    target.events().transcript(partial)
    target.events().transcript({ ...partial, text: 'Hello team', endMs: 500, isFinal: true })
    target.events().transcript(partial)
    target.events().transcript({ ...partial, id: 'remote', source: 'system' })
    target.events().transcript({ ...partial, id: 'foreign', meetingId: 'another-meeting' })
    expect(target.controller.snapshot().segments).toHaveLength(1)
    expect(target.controller.snapshot().segments[0]).toMatchObject({ text: 'Hello team', isFinal: true })
  })

  it('preserves pause gaps and accepts final transcript flushing during stop', async () => {
    const target = harness()
    target.controller.requestStart()
    await target.controller.confirm(config, true)
    target.time(1500)
    await target.controller.pauseResume()
    expect(target.controller.snapshot().state).toBe('paused')
    target.time(3500)
    await target.controller.pauseResume()
    expect(target.controller.snapshot().pauses).toEqual([{ startMs: 500, endMs: 2500 }])
    target.backend.stop.mockImplementationOnce(async () => {
      target.events().transcript({ id: 'final', meetingId: target.sessionId(), source: 'mic', speakerId: null, text: 'Last words', startMs: 2600, endMs: 3000, isFinal: true })
    })
    await target.controller.stop()
    expect(target.controller.snapshot().state).toBe('completed')
    expect(target.controller.snapshot().segments[0].text).toBe('Last words')
  })

  it('ignores events from old sessions after a new consent flow starts', async () => {
    const target = harness()
    target.controller.requestStart()
    await target.controller.confirm(config, true)
    const oldEvents = target.events()
    const oldId = target.sessionId()
    await target.controller.stop()
    target.controller.requestStart()
    await target.controller.confirm(config, true)
    oldEvents.transcript({ id: 'stale', meetingId: oldId, source: 'mic', speakerId: null, text: 'Old words', startMs: 0, endMs: 10, isFinal: true })
    oldEvents.failure()
    expect(target.controller.snapshot()).toMatchObject({ state: 'recording', segments: [] })
    const copy = target.controller.snapshot()
    copy.config.title = 'Changed outside controller'
    expect(target.controller.snapshot().config.title).toBe('Test meeting')
  })
})
