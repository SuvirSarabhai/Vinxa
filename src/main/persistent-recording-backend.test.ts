import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendEvents, RecordingBackend } from '../shared/phase2'
import { MeetingStore } from './db/repository'
import { withMeetingPersistence } from './persistent-recording-backend'
import { SessionController } from './session-controller'
import { MeetingNotesService } from './insights/meeting-notes'
import { NotesSettingsStore } from './insights/settings'
const folders: string[] = [], stores: MeetingStore[] = [], services: MeetingNotesService[] = []
const config = { title: 'Saved session', microphoneEnabled: true, systemAudioEnabled: true, microphoneDeviceId: null }
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.drain())); for (const s of stores.splice(0)) if (s.db.open) s.close(); for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true }) })
function setup(fail = false) {
  const folder = mkdtempSync(join(tmpdir(), 'vinxa-persistence-')); folders.push(folder)
  const store = new MeetingStore(folder); stores.push(store)
  let callbacks: BackendEvents, id: string
  const backend: RecordingBackend = {
    mode: 'local',
    async start(_config, identity, events) {
      callbacks = events; id = identity
      await events.audioFrame?.('mic', new Uint8Array(3200), { startSample: 0 })
      await events.audioFrame?.('system', new Uint8Array(3200), { startSample: 0 })
    },
    pause: async () => {}, resume: async () => {},
    stop: vi.fn(async () => {
      callbacks.transcript({ id: 'last', meetingId: id, source: 'mic', speakerId: null,
        text: 'Final buffered words', startMs: 0, endMs: 100, isFinal: true })
      await callbacks.sourceEnded?.('mic', 0); await callbacks.sourceEnded?.('system', 0)
      if (fail) throw new Error('Speech drain failed')
    })
  }
  const settings = new NotesSettingsStore(store, {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString()
  })
  const notes = new MeetingNotesService(store, settings, () => {}, () => ({
    name: 'mock', model: 'unavailable', available: async () => ({ available: false }), generate: vi.fn()
  }))
  const wrapped = withMeetingPersistence(backend, store, notes, () => {})
  services.push(notes)
  const controller = new SessionController(wrapped, async () => {})
  return { store, backend, controller, wrapped, notes, folder }
}
describe('Stop persistence integration (real SQLite/files, mock capture/provider)', () => {
  it('drains final text and audio, survives duplicate Stop and restart', async () => {
    const test = setup()
    test.controller.requestStart(); await test.controller.confirm(config, true)
    const id = test.controller.snapshot().sessionId!
    await Promise.all([test.controller.stop(), test.controller.stop()])
    await test.notes.drain()
    expect(test.backend.stop).toHaveBeenCalledTimes(1)
    expect(test.controller.snapshot().state).toBe('completed')
    const saved = test.store.get(id)
    expect(saved.meeting.notesStatus).toBe('pending')
    expect(saved.transcript[0].text).toBe('Final buffered words')
    expect(readFileSync(saved.meeting.microphoneAudioPath!).readUInt32LE(40)).toBe(3200)
    test.store.close()
    const reopened = new MeetingStore(test.folder); stores.push(reopened)
    expect(reopened.get(id)).toEqual(saved)
  })
  it('retains the meeting and finalizes WAVs when speech Stop fails', async () => {
    const test = setup(true)
    test.controller.requestStart(); await test.controller.confirm(config, true)
    const id = test.controller.snapshot().sessionId!
    await expect(test.controller.stop()).rejects.toThrow('Speech drain failed')
    const saved = test.store.get(id)
    expect(saved.meeting.recordingStatus).toBe('error')
    expect(saved.meeting.notesStatus).toBe('pending')
    expect(saved.transcript).toHaveLength(1)
    expect(readFileSync(saved.meeting.systemAudioPath!).readUInt32LE(40)).toBe(3200)
  })
  it('completes the recording and exposes durable text while notes are still running', async () => {
    const test = setup()
    let finish!: () => void
    vi.spyOn(test.notes, 'generate').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    test.controller.requestStart(); await test.controller.confirm(config, true)
    await test.controller.stop()
    expect(test.controller.snapshot().busy).toBe(false)
    expect(test.store.list().meetings[0].recordingStatus).toBe('completed')
    expect(test.store.transcript(test.controller.snapshot().sessionId!)).toHaveLength(1)
    finish()
    expect(test.controller.snapshot().state).toBe('completed')
  })
  it('preserves finalized recordings when the notes provider fails', async () => {
    const test = setup()
    test.controller.requestStart(); await test.controller.confirm(config, true)
    const id = test.controller.snapshot().sessionId!
    await test.controller.stop()
    const settings = new NotesSettingsStore(test.store, {
      isEncryptionAvailable:()=>false,encryptString:()=>{throw new Error()},decryptString:()=>{throw new Error()}
    })
    const notes = new MeetingNotesService(test.store,settings,()=>{},()=>({
      name:'mock',model:'failure',available:async()=>({available:true}),generate:async()=>{throw new Error('Provider timed out')}
    }))
    await notes.generate(id)
    expect(test.store.get(id).meeting).toMatchObject({recordingStatus:'completed',notesStatus:'failed'})
    expect(test.store.transcript(id)).toHaveLength(1)
    expect(readFileSync(test.store.meeting(id).microphoneAudioPath!).readUInt32LE(40)).toBe(3200)
  })
  it('keeps completed notes status and previous items when regeneration cannot reach a provider', async () => {
    const test = setup()
    test.controller.requestStart(); await test.controller.confirm(config, true)
    const id = test.controller.snapshot().sessionId!
    await test.controller.stop()
    await test.notes.drain()
    test.store.replaceInsights(id, { summary: 'Saved', decisions: [], actionItems: [
      { task: 'Review', owner: null, due: null, status: 'pending' }
    ] }, 'ollama', 'local')
    const settings = new NotesSettingsStore(test.store, {
      isEncryptionAvailable:()=>false, encryptString:()=>{throw new Error()}, decryptString:()=>{throw new Error()}
    })
    const notes = new MeetingNotesService(test.store, settings, () => {}, () => ({
      name: 'mock', model: 'unavailable', available: async () => ({ available: false, message: 'Service unavailable.' }),
      generate: vi.fn()
    }))
    await notes.generate(id)
    const saved = test.store.get(id)
    expect(saved.meeting.notesStatus).toBe('completed')
    expect(saved.meeting.notesMessage).toContain('Previous notes retained')
    expect(saved.insights?.summary).toBe('Saved')
    expect(saved.actions).toHaveLength(1)
  })
})
