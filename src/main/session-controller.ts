import { randomUUID } from 'node:crypto'
import type { RecordingConfig, RecordingState, TranscriptSegment } from '../shared/contracts'
import type { ConsentRecord, RecordingBackend, SessionSnapshot } from '../shared/phase2'
import { consentStatementVersion } from '../shared/phase2'
import { recordingConfigSchema, transcriptSegmentSchema } from '../shared/schemas'

const transitions: Record<RecordingState, RecordingState[]> = {
  idle: ['awaiting-consent'],
  'awaiting-consent': ['idle', 'recording'],
  recording: ['paused', 'stopping', 'error'],
  paused: ['recording', 'stopping', 'error'],
  stopping: ['completed', 'error'],
  processing: ['completed', 'error'],
  completed: ['awaiting-consent'],
  interrupted: ['awaiting-consent'],
  error: ['awaiting-consent']
}

export class SessionController {
  private generation = 0
  private disposed = false
  private startedAt = 0
  private announcementCopied = false
  private backendTail: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  private current: SessionSnapshot

  constructor(
    private readonly backend: RecordingBackend,
    private readonly saveConsent: (record: ConsentRecord) => Promise<void>,
    private readonly clock: () => number = Date.now
  ) {
    this.current = {
      state: 'idle', mode: backend.mode, busy: false, consentRequest: 0,
      config: { title: 'New meeting', microphoneEnabled: true, systemAudioEnabled: true, microphoneDeviceId: null },
      segments: [], sessionId: null, error: null, pauses: [],
      notice: backend.mode === 'demo' ? 'Written sample only. No audio is captured.' : 'Local recording backend connected.',
      levels: { mic: null, system: null }
    }
  }

  snapshot(): SessionSnapshot {
    return structuredClone(this.current)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  requestStart(): boolean {
    if (this.disposed || this.current.busy) return false
    if (this.current.state === 'awaiting-consent') return true
    if (!['idle', 'completed', 'error', 'interrupted'].includes(this.current.state)) return false
    this.generation += 1
    this.current.consentRequest += 1
    this.announcementCopied = false
    this.current.error = null
    this.transition('awaiting-consent')
    return true
  }

  markAnnouncementCopied(): void {
    if (this.current.state === 'awaiting-consent') this.announcementCopied = true
  }

  cancel(): void {
    if (this.current.state !== 'awaiting-consent' || this.disposed) return
    this.generation += 1
    this.current.busy = false
    this.transition('idle')
  }

  async confirm(config: RecordingConfig, consent: boolean): Promise<void> {
    if (this.disposed || this.current.state !== 'awaiting-consent') throw new Error('Start a session before confirming consent.')
    if (this.current.busy) throw new Error('The session is already starting.')
    if (consent !== true) throw new Error('Consent is required before capture can start.')
    const validated = recordingConfigSchema.parse(config)
    const generation = this.generation
    const sessionId = randomUUID()
    this.current.busy = true
    this.current.error = null
    this.publish()

    try {
      await this.saveConsent({
        sessionId, confirmedAtUtc: new Date(this.clock()).toISOString(),
        statementVersion: consentStatementVersion, mode: this.backend.mode,
        microphoneEnabled: validated.microphoneEnabled, systemAudioEnabled: validated.systemAudioEnabled,
        announcementCopied: this.announcementCopied
      })
      if (!this.isCurrent(generation) || !this.hasState('awaiting-consent')) return

      await this.enqueue(async () => {
        if (!this.isCurrent(generation) || !this.hasState('awaiting-consent')) return
        this.current.config = validated
        this.current.sessionId = sessionId
        this.current.segments = []
        this.current.pauses = []
        this.current.levels = { mic: null, system: null }
        this.current.notice = this.backend.mode === 'demo' ? 'Playing a short written sample. Stop ends the demo session.' : 'Recording locally.'
        this.startedAt = this.clock()
        this.transition('recording')
        try {
          await this.backend.start(validated, sessionId, {
            transcript: (segment) => this.receiveSegment(generation, segment),
            levels: (mic, system) => {
              if (!this.isCurrent(generation) || this.current.state !== 'recording') return
              const normalize = (value: number | null): number | null =>
                value !== null && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null
              this.current.levels = {
                mic: validated.microphoneEnabled ? normalize(mic) : null,
                system: validated.systemAudioEnabled ? normalize(system) : null
              }
              this.publish()
            },
            notice: (message) => {
              if (!this.isCurrent(generation) || !['recording', 'paused'].includes(this.current.state)) return
              this.current.notice = message
              this.publish()
            },
            failure: () => {
              if (!this.isCurrent(generation) || !['recording', 'paused', 'stopping'].includes(this.current.state)) return
              this.fail('The recording backend stopped unexpectedly.')
              void this.enqueue(() => this.backend.stop()).catch(() => undefined)
            }
          })
        } catch {
          if (this.isCurrent(generation) && !this.hasState('error')) this.fail('The recording backend could not start.')
          await this.backend.stop().catch(() => undefined)
          throw new Error('The recording backend could not start.')
        }
      })
    } catch {
      if (this.isCurrent(generation)) {
        this.current.error = this.hasState('awaiting-consent')
          ? 'Consent could not be saved. Capture was not started. Try again.'
          : 'The recording backend could not start.'
      }
      throw new Error(this.current.error ?? 'The session start was cancelled.')
    } finally {
      if (this.isCurrent(generation)) {
        this.current.busy = false
        this.publish()
      }
    }
  }

  pauseResume(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed || !['recording', 'paused'].includes(this.current.state)) return
      this.current.busy = true
      this.current.error = null
      this.publish()
      try {
        if (this.hasState('recording')) {
          await this.backend.pause()
          if (!this.hasState('recording') || this.disposed) return
          this.current.pauses.push({ startMs: this.elapsed(), endMs: null })
          this.current.levels = { mic: null, system: null }
          this.transition('paused')
        } else {
          await this.backend.resume()
          if (!this.hasState('paused') || this.disposed) return
          this.finishPause()
          this.transition('recording')
        }
      } catch {
        if (!this.hasState('error')) this.fail('Pause or resume failed. The session was stopped.')
        await this.backend.stop().catch(() => undefined)
        throw new Error('Pause or resume failed.')
      } finally {
        this.current.busy = false
        this.publish()
      }
    })
  }

  stop(): Promise<void> {
    if (this.current.state === 'awaiting-consent') {
      this.cancel()
      return Promise.resolve()
    }
    return this.enqueue(async () => {
      if (this.disposed || !['recording', 'paused'].includes(this.current.state)) return
      this.current.busy = true
      this.finishPause()
      this.transition('stopping')
      try {
        await this.backend.stop()
        if (this.disposed || !this.hasState('stopping')) return
        this.current.levels = { mic: null, system: null }
        this.current.notice = 'Session stopped. History and AI notes will be connected in later phases.'
        this.transition('completed')
      } catch {
        if (!this.hasState('error')) this.fail('The backend could not stop cleanly.')
        throw new Error('The backend could not stop cleanly.')
      } finally {
        this.current.busy = false
        this.publish()
      }
    })
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.listeners.clear()
    void this.enqueue(() => this.backend.stop()).catch(() => undefined)
  }

  private receiveSegment(generation: number, segment: TranscriptSegment): void {
    if (!this.isCurrent(generation) || !['recording', 'stopping'].includes(this.current.state)) return
    const parsed = transcriptSegmentSchema.safeParse(segment)
    if (!parsed.success || parsed.data.meetingId !== this.current.sessionId) return
    const value = parsed.data
    if (value.source === 'mic' ? !this.current.config.microphoneEnabled : !this.current.config.systemAudioEnabled) return
    const index = this.current.segments.findIndex((existing) => existing.id === value.id)
    const previous = this.current.segments[index]
    if (previous && (previous.isFinal || previous.source !== value.source || previous.startMs !== value.startMs)) return
    if (index < 0) this.current.segments.push(value)
    else this.current.segments[index] = value
    this.publish()
  }

  private fail(message: string): void {
    this.current.error = message
    this.current.levels = { mic: null, system: null }
    this.finishPause()
    this.transition('error')
  }

  private elapsed(): number {
    return Math.max(0, this.clock() - this.startedAt)
  }

  private finishPause(): void {
    const last = this.current.pauses.at(-1)
    if (last && last.endMs === null) last.endMs = this.elapsed()
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private hasState(...states: RecordingState[]): boolean {
    return states.includes(this.current.state)
  }

  private transition(next: RecordingState): void {
    if (!transitions[this.current.state].includes(next)) throw new Error(`Invalid transition: ${this.current.state} to ${next}`)
    this.current.state = next
    this.publish()
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.backendTail.then(operation)
    this.backendTail = next.catch(() => undefined)
    return next
  }

  private publish(): void {
    if (!this.disposed) this.listeners.forEach((listener) => listener())
  }
}
