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
  stopping: ['processing', 'completed', 'error'],
  processing: ['completed', 'error'],
  completed: ['awaiting-consent'],
  interrupted: ['awaiting-consent'],
  error: ['awaiting-consent']
}

export class SessionController {
  private generation = 0
  private disposed = false
  private startedAt = 0
  private startedMonotonic = 0
  private announcementCopied = false
  private backendTail: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  private readonly initial: SessionSnapshot
  private current: SessionSnapshot

  constructor(
    private readonly backend: RecordingBackend,
    private readonly saveConsent: (record: ConsentRecord) => Promise<void>,
    private readonly clock: () => number = Date.now
  ) {
    this.initial = {
      state: 'idle', mode: backend.mode, busy: false, consentRequest: 0,
      config: { title: 'New meeting', microphoneEnabled: true, systemAudioEnabled: true, microphoneDeviceId: null },
      segments: [], sessionId: null, error: null, pauses: [],
      notice: backend.mode === 'demo' ? 'Written sample only. No audio is captured.' : 'Local recording backend connected.',
      levels: { mic: null, system: null }
    }
    this.current = structuredClone(this.initial)
    backend.bindOwner?.({
      getState: () => this.current.state,
      hasConsent: (sessionId) => this.current.sessionId === sessionId &&
        ['recording', 'paused', 'stopping', 'processing'].includes(this.current.state)
    })
  }

  snapshot(): SessionSnapshot {
    return structuredClone(this.current)
  }

  forgetDeletedMeeting(id: string): void {
    if (this.current.sessionId !== id) return
    const { consentRequest, state, busy } = this.current
    this.current = { ...structuredClone(this.initial), consentRequest, busy,
      state: state === 'awaiting-consent' ? state : 'idle' }
    this.publish()
  }

  getState(): RecordingState { return this.current.state }
  bookmarkMoment(): { id: string; atMs: number } {
    if (this.disposed || this.current.busy || this.current.state !== 'recording' || !this.current.sessionId) {
      throw new Error('Start or resume recording before adding a bookmark.')
    }
    return { id: this.current.sessionId, atMs: Math.max(0, Math.floor(performance.now() - this.startedMonotonic)) }
  }
  announce(message: string): void { this.current.notice = message; this.publish() }
  async selectMicrophone(deviceId:string):Promise<void>{
    if(this.disposed||this.current.busy||this.current.state!=='paused'||!this.current.config.microphoneEnabled||!this.backend.selectMicrophone)throw new Error('Pause an active microphone session before changing its device.')
    await this.backend.selectMicrophone(deviceId)
    this.current.config.microphoneDeviceId=deviceId
    this.current.notice='Microphone selected. Resume to reconnect with the same session timeline.'
    this.publish()
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
        this.current.startedAtMs = this.startedAt
        this.current.endedAtMs = null
        const sessionStartMs = performance.now()
        this.startedMonotonic = sessionStartMs
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
              if (!this.isCurrent(generation) || !['recording', 'paused', 'stopping', 'processing'].includes(this.current.state)) return
              this.current.notice = message
              this.publish()
            },
            discardPartials: () => {
              if (!this.isCurrent(generation)) return
              this.current.segments = this.current.segments.filter((segment) => segment.isFinal)
              this.publish()
            },
            processing: () => {
              if (!this.isCurrent(generation) || !this.hasState('stopping')) return
              this.current.endedAtMs = this.clock()
              this.current.notice = 'Recording saved. Preparing meeting notes.'
              this.transition('processing')
            },
            failure: (message) => {
              if (!this.isCurrent(generation) || !['recording', 'paused', 'stopping'].includes(this.current.state)) return
              this.fail(message ?? 'The recording backend stopped unexpectedly.')
              void this.enqueue(() => this.backend.stop()).catch(() => undefined)
            }
          }, sessionStartMs)
        } catch (error) {
          const message = `The recording backend could not start. ${error instanceof Error ? error.message : ''}`.trim()
          if (this.isCurrent(generation) && !this.hasState('error')) this.fail(message)
          await this.backend.stop().catch(() => undefined)
          throw new Error(message)
        }
      })
    } catch {
      if (this.isCurrent(generation)) {
        this.current.error = this.hasState('awaiting-consent')
          ? 'Consent could not be saved. Capture was not started. Try again.'
          : this.current.error ?? 'The recording backend could not start.'
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
          const pausedAt = this.elapsed()
          await this.backend.pause()
          if (!this.hasState('recording') || this.disposed) return
          this.current.pauses.push({ startMs: pausedAt, endMs: null })
          this.current.levels = { mic: null, system: null }
          this.transition('paused')
        } else {
          const resumedAt = this.elapsed()
          this.transition('recording')
          await this.backend.resume()
          if (!this.hasState('recording') || this.disposed) return
          this.finishPause(resumedAt)
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
        if (this.disposed || !this.hasState('stopping', 'processing')) return
        this.current.levels = { mic: null, system: null }
        if (this.backend.mode === 'demo' && !this.hasState('processing')) this.current.notice = 'Session stopped.'
        this.current.endedAtMs ??= this.clock()
        this.transition('completed')
      } catch (error) {
        const message = 'The backend could not stop cleanly.' + (error instanceof Error ? ' ' + error.message : '')
        if (!this.hasState('error')) this.fail(message)
        throw new Error(message)
      } finally {
        this.current.busy = false
        this.publish()
      }
    })
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.generation += 1
    this.listeners.clear()
    return this.enqueue(() => this.backend.stop())
  }

  private receiveSegment(generation: number, segment: TranscriptSegment): void {
    if (!this.isCurrent(generation) || !['recording', 'stopping'].includes(this.current.state)) return
    const parsed = transcriptSegmentSchema.safeParse(segment)
    if (!parsed.success || parsed.data.meetingId !== this.current.sessionId) return
    const value = parsed.data
    if (value.source === 'mic' ? !this.current.config.microphoneEnabled : !this.current.config.systemAudioEnabled) return
    const index = this.current.segments.findIndex((existing) => existing.id === value.id)
    const previous = this.current.segments[index]
    if (previous && (previous.isFinal || previous.source !== value.source)) return
    if (!value.text.trim()) {
      if (value.isFinal && index >= 0) { this.current.segments.splice(index, 1); this.publish() }
      return
    }
    if (index < 0) this.current.segments.push(value)
    else this.current.segments[index] = value
    this.publish()
  }

  private fail(message: string): void {
    this.current.endedAtMs = this.clock()
    this.current.error = message
    this.current.segments = this.current.segments.filter((segment) => segment.isFinal)
    this.current.levels = { mic: null, system: null }
    this.finishPause()
    this.transition('error')
  }

  private elapsed(): number {
    return Math.max(0, this.clock() - this.startedAt)
  }

  private finishPause(endedAt = this.elapsed()): void {
    const last = this.current.pauses.at(-1)
    if (last && last.endMs === null) last.endMs = endedAt
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
