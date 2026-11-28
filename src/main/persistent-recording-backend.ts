import type { BackendEvents, RecordingBackend } from '../shared/phase2'
import type { MeetingStore } from './db/repository'
import type { MeetingNotesService } from './insights/meeting-notes'
import { MeetingAudioSpool } from './audio/spool'
import type { AudioSpooler } from '../shared/meetings'
import type { RecordingConfig } from '../shared/contracts'

type Spool = AudioSpooler & { paths: { microphoneAudioPath: string | null; systemAudioPath: string | null } }
interface PersistedSession { id: string; spool?: Spool; events: BackendEvents; failure?: string; endedAt?: number }
export function withMeetingPersistence(backend: RecordingBackend, store: MeetingStore, notes: Pick<MeetingNotesService, 'generate'>,
  changed: () => void, makeSpool: (directory: string, id: string, config: RecordingConfig) => Promise<Spool> = MeetingAudioSpool.create): RecordingBackend {
  if (backend.mode === 'demo') return backend
  let current: PersistedSession | undefined
  let stopping: Promise<void> | undefined
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Meeting persistence failed.'
  async function stop(): Promise<void> {
    if (stopping) return stopping
    const session = current
    if (!session) return backend.stop()
    stopping = (async () => {
      try { store.recording(session.id, 'stopping') } catch (error) { session.failure ??= errorMessage(error) }
      try { await backend.stop() } catch (error) { session.failure ??= errorMessage(error) }
      session.endedAt ??= Date.now()
      try {
        if (session.spool) store.audio(session.id, await session.spool.finalize())
      } catch (error) { session.failure ??= 'Audio finalization failed. ' + errorMessage(error) }
      if (session.failure) {
        store.recording(session.id, 'error', session.endedAt, session.failure)
        store.notesStatus(session.id, 'pending', 'Recording was interrupted. Notes require a fully finalized transcript.')
        changed()
        throw new Error(session.failure)
      }
      // Recording completion depends on durable audio/text, not LLM speed.
      // MeetingNotesService owns and drains its background jobs on shutdown.
      store.recording(session.id, 'completed', session.endedAt)
      session.events.notice('Recording and transcript saved. Notes are generating in the background; transcript export is available.')
      changed()
      void notes.generate(session.id).catch(() => {
        store.notesStatus(session.id, 'failed', 'Notes could not be saved. The recording and transcript remain available; retry notes.')
        changed()
      })
    })().finally(() => { current = undefined; stopping = undefined })
    return stopping
  }
  return {
    mode: 'local',
    bindOwner: owner => backend.bindOwner?.(owner),
    onEngine: listener => backend.onEngine?.(listener) ?? (() => undefined),
    async start(config, id, events, epoch) {
      if (current || stopping) throw new Error('A meeting is still saving.')
      store.create(id, config, Date.now())
      const session: PersistedSession = { id, events }
      current = session
      changed()
      const failure = (message = 'Recording failed.'): void => {
        session.failure ??= message
        events.failure(message)
      }
      try {
        session.spool = await makeSpool(store.userData, id, config)
        store.audio(id, session.spool.paths)
        await backend.start(config, id, {
          ...events,
          failure,
          async audioFrame(source, pcm, metadata) {
            try { await session.spool!.append(source, pcm, metadata) }
            catch (error) { failure('Audio could not be saved. ' + errorMessage(error)); throw error }
          },
          async sourceEnded(source, padding) {
            try { await session.spool!.endSource(source, padding) }
            catch (error) { failure('Audio source could not be finalized. ' + errorMessage(error)); throw error }
          },
          transcript(segment) {
            if (segment.meetingId !== id) return
            try { if (segment.isFinal) store.saveFinal(segment) }
            catch (error) { failure('Transcript could not be saved. ' + errorMessage(error)); return }
            events.transcript(segment)
            if (segment.isFinal) changed()
          }
        }, epoch)
      } catch (error) {
        session.failure ??= errorMessage(error)
        await stop().catch(() => undefined)
        throw error
      }
    },
    async pause() { await backend.pause(); if (current) { store.recording(current.id, 'paused'); changed() } },
    async resume() { await backend.resume(); if (current) { store.recording(current.id, 'recording'); changed() } },
    selectMicrophone:deviceId=>backend.selectMicrophone?backend.selectMicrophone(deviceId):Promise.reject(new Error('Microphone selection is unavailable.')),
    stop,
    dispose() { backend.dispose?.() }
  }
}
