import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AudioFrameMetadata, AudioSourceName, SidecarConfig, SidecarControl,
  SidecarError, SidecarStatus, TranscriptSegment } from '../shared/contracts'
import { clockEstimate, encodeTimedFrame } from '../shared/frame-protocol'
import { speechDiagnostics } from './speech-diagnostics'
import { sourceIds } from '../shared/contracts'
import { audioFrameMetadataSchema, sidecarConfigSchema, sidecarControlSchema,
  sidecarEventSchema, sidecarListeningSchema, transcriptSegmentSchema } from '../shared/schemas'

export interface SidecarRuntime { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
export type SidecarSession = Pick<SidecarConfig, 'sessionId' | 'model' | 'language' | 'enabledSources'> & { meetingId: string }
interface Options {
  runtime: SidecarRuntime
  onTranscript(segment: TranscriptSegment): void
  onStatus(status: SidecarStatus): void
  onError(error: SidecarError): void
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  createSocket?: (url: string) => WebSocket
  maxRestarts?: number; backoffMs?: number; startupMs?: number; readyMs?: number
  healthMs?: number; requestMs?: number; bufferFramesPerSource?: number
  shutdownMs?: number; finalizationMs?: number
  protocolVersion?: 1 | 2
  keepWarm?: boolean
}
interface QueuedFrame { source: AudioSourceName; pcm: Uint8Array; metadata: AudioFrameMetadata }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export class SidecarOperationError extends Error {}

export function resolveSidecarRuntime(paths: { appPath: string; resourcesPath: string; packaged: boolean },
  configuredPython?: string): SidecarRuntime {
  const bundled = join(paths.resourcesPath, 'sidecar', process.platform === 'win32' ? 'vinxa-sidecar.exe' : 'vinxa-sidecar')
  if (paths.packaged && existsSync(bundled)) {
    const model = process.env.VINXA_SPEECH_MODEL || 'base.en'
    const modelPath = join(paths.resourcesPath, 'sidecar', 'models', model)
    return { command: bundled, args: [], env: {
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      ...(!process.env.VINXA_SPEECH_MODEL_PATH && ['base.en', 'small', 'tiny.en'].includes(model) && existsSync(join(modelPath, 'model.bin'))
        ? { VINXA_SPEECH_MODEL_PATH: modelPath } : {})
    } }
  }
  let python = configuredPython ?? join(paths.appPath, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const root = paths.packaged ? join(paths.resourcesPath, 'sidecar') : paths.appPath
  if (!existsSync(python) || !existsSync(join(root, 'sidecar/server.py'))) {
    throw new SidecarOperationError('Sidecar runtime unavailable; configure a local interpreter or bundled runtime')
  }
  let env: NodeJS.ProcessEnv | undefined
  // Run the actual interpreter, not Windows' venv redirector. The owned PID must
  // be the model process even if it crashes before its close handler runs.
  const venvRoot = resolve(dirname(python), '..')
  const configuration = join(venvRoot, 'pyvenv.cfg')
  if (process.platform === 'win32' && existsSync(configuration)) {
    const executable = /^executable\s*=\s*(.+)$/mi.exec(readFileSync(configuration, 'utf8'))?.[1].trim()
    if (!executable || !existsSync(executable)) throw new SidecarOperationError('Direct Python runtime could not be resolved')
    python = executable
    env = { PYTHONPATH: join(venvRoot, 'Lib/site-packages'), PYTHONNOUSERSITE: '1' }
  }
  return { command: python, args: ['-m', 'sidecar.server'], cwd: root, env }
}

/** Owns process/socket availability only. The recording owner supplies consent/state gates. */
export class SidecarManager {
  private session?: SidecarSession
  private generation = 0
  private socket?: WebSocket
  private child?: ChildProcess
  private finishGeneration?: (reason: string) => void
  private supervision?: Promise<void>
  private lifetime = new AbortController()
  private firstReady = deferred<void>()
  private readyWaiters = new Set<ReturnType<typeof deferred<void>>>()
  private pending = new Map<string, { type: SidecarControl['type']; resolve: () => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
  private lifecycleRequests = 0
  private healthGraceUntil = 0
  private stopOperation?: Promise<void>
  private queue: QueuedFrame[] = []
  private expected = new Map<AudioSourceName, number>()
  private finalEnd = new Map<AudioSourceName, number>()
  private dropped = new Map<AudioSourceName, number>()
  private available = false
  private hadReady = false
  private paused = false
  private stopping = false
  private active = false
  private permanent = false
  private standby = false
  private switching = false
  private clockSamples: { offsetMs: number; uncertaintyMs: number }[] = []
  private clockMapping?: { offsetMs: number; uncertaintyMs: number }

  constructor(private readonly options: Options) {
    for (const [value, minimum, maximum] of [
      [options.maxRestarts ?? 3, 0, 5], [options.backoffMs ?? 250, 1, 10000],
      [options.bufferFramesPerSource ?? 20, 1, 50], [options.startupMs ?? 15000, 10, 120000],
      [options.readyMs ?? 60000, 10, 180000], [options.healthMs ?? 5000, 10, 30000],
      [options.requestMs ?? 5000, 10, 30000], [options.shutdownMs ?? 3000, 10, 5000],
      [options.finalizationMs ?? 30000, 10, 60000]
    ]) if (!Number.isInteger(value) || value < minimum || value > maximum) throw new SidecarOperationError('Invalid sidecar limits')
  }

  get ready(): boolean { return this.available && !this.stopping && !this.permanent }

  async prewarm(model = 'base.en', language = 'en'): Promise<void> {
    this.standby = true
    await this.start({ sessionId: randomUUID(), meetingId: 'speech-warmup', model, language, enabledSources: ['mic', 'system'] })
  }

  async endSession(): Promise<void> {
    if (!this.options.keepWarm) return this.stop()
    if (this.standby) return
    await this.drain()
    await this.request('session-end', {}, this.options.finalizationMs ?? 30000)
    this.standby = true
    this.expected.clear()
    this.finalEnd.clear()
    this.paused = false
  }

  private async synchronizeClock(): Promise<void> {
    this.clockSamples = []
    for (let index = 0; index < 3; index++) await this.request('clock-sync', { clientSendMs: performance.now() })
    const best = [...this.clockSamples].sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0]
    if (!best) throw new SidecarOperationError('Clock synchronization unavailable')
    await this.request('clock-set', best)
    this.clockMapping = best
  }

  async start(session: SidecarSession): Promise<void> {
    if (this.active && this.options.keepWarm && this.standby && !this.switching) {
      if (!this.ready || session.model !== this.session!.model) throw new SidecarOperationError('Wait for warm-up or restart to select a different model')
      if (!session.meetingId || session.meetingId.length > 160) throw new SidecarOperationError('Invalid meeting identity')
      sidecarControlSchema.parse({ type: 'session-begin', sessionId: this.session!.sessionId, generation: this.generation,
        requestId: randomUUID(), nextSessionId: session.sessionId, language: session.language, enabledSources: session.enabledSources })
      this.switching = true
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      try {
        this.firstReady = deferred<void>()
        void this.firstReady.promise.catch(() => {})
        readyTimer = setTimeout(() => this.firstReady.reject(new SidecarOperationError('Session readiness timed out')),
          this.options.readyMs ?? 60000)
        const pending = this.request('session-begin', { nextSessionId: session.sessionId,
          language: session.language, enabledSources: session.enabledSources }, this.options.finalizationMs ?? 30000)
        this.session = { ...session, enabledSources: [...session.enabledSources] }
        this.available = false
        this.expected.clear(); this.finalEnd.clear(); this.paused = false
        await pending
        await this.firstReady.promise
        this.standby = false
        return
      } catch (error) {
        this.finishGeneration?.('Session transition failed')
        throw error
      } finally { clearTimeout(readyTimer); this.switching = false }
    }
    if (this.active) throw new SidecarOperationError('A sidecar session is already active')
    const { meetingId: _, ...wire } = session
    if (!sidecarConfigSchema.safeParse({ ...wire, type: 'config', token: randomBytes(32).toString('hex'),
      protocolVersion: this.options.protocolVersion ?? 1, ...(this.options.protocolVersion === 2 ? { timedFrames: true } : {}), generation: 0, sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', frameMs: 100 }).success) {
      throw new SidecarOperationError('Invalid sidecar session configuration')
    }
    if (!session.meetingId || session.meetingId.length > 160) throw new SidecarOperationError('Invalid meeting identity')
    this.session = { ...session, enabledSources: [...session.enabledSources] }
    this.active = true; this.stopping = this.permanent = this.paused = this.available = this.hadReady = false
    this.generation = 0; this.queue = []; this.expected.clear(); this.finalEnd.clear(); this.dropped.clear()
    this.firstReady = deferred<void>(); this.lifetime = new AbortController()
    this.supervision = this.supervise()
    return this.firstReady.promise
  }

  private status(status: SidecarStatus['status']): void {
    this.options.onStatus({ type: 'status', sessionId: this.session!.sessionId, generation: this.generation, status })
  }
  private error(code: string, message: string, recoverable: boolean): void {
    this.options.onError({ type: 'error', code, message, recoverable, sessionId: this.session?.sessionId ?? null,
      generation: this.session ? this.generation : null })
  }

  private async supervise(): Promise<void> {
    try {
      while (!this.stopping) {
        this.status('starting')
        let reason = 'Local sidecar became unavailable'
        try { reason = await this.runGeneration() } catch { /* safe generic reason */ }
        this.available = false
        if (this.stopping) break
        this.error('SIDECAR_DISCONNECTED', reason + '; unfinalized audio may be interrupted', true)
        if (this.child || this.generation >= (this.options.maxRestarts ?? 3)) {
          this.permanent = true
          this.error('RESTART_LIMIT', 'Sidecar restart limit reached; start a new session after checking the local runtime', false)
          this.status('error')
          this.firstReady.reject(new SidecarOperationError('Sidecar restart limit reached'))
          for (const waiter of this.readyWaiters) waiter.reject(new SidecarOperationError('Sidecar unavailable'))
          this.readyWaiters.clear()
          this.dropQueue()
          break
        }
        this.status('restarting')
        await delay((this.options.backoffMs ?? 250) * 2 ** this.generation, undefined, { signal: this.lifetime.signal })
        this.generation++
      }
    } catch {
      if (!this.stopping) {
        this.permanent = true
        this.error('SIDECAR_FAILED', 'Local sidecar supervision failed', false)
        this.status('error')
        this.firstReady.reject(new SidecarOperationError('Sidecar unavailable'))
      }
    }
  }

  private async runGeneration(): Promise<string> {
    const generation = this.generation
    const done = deferred<string>(), exited = deferred<void>()
    let didExit = false, handshake = false, stdout = ''
    let socket: WebSocket | undefined
    let health: ReturnType<typeof setInterval> | undefined
    const fail = (message: string): void => { this.available = false; done.resolve(message) }
    this.finishGeneration = fail
    const token = randomBytes(32).toString('hex')
    const environment: NodeJS.ProcessEnv = { ...process.env, ...this.options.runtime.env,
      VINXA_SIDECAR_TOKEN: token, VINXA_SIDECAR_SESSION_ID: this.session!.sessionId,
      VINXA_SIDECAR_GENERATION: String(generation) }
    if (process.env.VINXA_DIAGNOSTICS_DIR) {
      await mkdir(process.env.VINXA_DIAGNOSTICS_DIR, { recursive: true })
      environment.VINXA_DIAGNOSTICS_PATH = join(process.env.VINXA_DIAGNOSTICS_DIR,
        'sidecar-' + randomUUID() + '-' + generation + '.json')
    }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = (this.options.spawnProcess ?? spawn)(this.options.runtime.command, this.options.runtime.args,
      { cwd: this.options.runtime.cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.once('close', () => { didExit = true; exited.resolve(); fail('Local sidecar process exited') })
    child.once('error', () => fail('Local sidecar process could not start'))
    child.stderr?.resume() // Drain privately; never log child stderr or native exceptions.
    const startup = setTimeout(() => fail('Sidecar listening handshake timed out'), this.options.startupMs ?? 15000)
    const readyDeadline = setTimeout(() => fail('Sidecar model readiness timed out'), this.options.readyMs ?? 60000)
    const flushTimer = setInterval(() => this.flush(), 20)
    this.expected.clear()
    this.clockMapping = undefined
    const current = (): boolean => generation === this.generation && socket === this.socket
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 1024) { fail('Invalid sidecar listening handshake'); return }
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      if (handshake || stdout.trim()) { fail('Unexpected sidecar stdout'); return }
      try {
        const listening = sidecarListeningSchema.parse(JSON.parse(line))
        handshake = true
        clearTimeout(startup)
        socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(`ws://127.0.0.1:${listening.port}`)
        this.socket = socket
        socket.addEventListener('open', () => {
          if (!current() || this.stopping) return
          const { meetingId: _, ...session } = this.session!
          socket!.send(JSON.stringify(sidecarConfigSchema.parse({ ...session, type: 'config', token,
            generation, protocolVersion: this.options.protocolVersion ?? 1,
            ...(this.options.protocolVersion === 2 ? { timedFrames: true } : {}),
            ...(this.options.keepWarm ? { keepAlive: true, standby: this.standby } : {}), sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', frameMs: 100 })))
        })
        socket.addEventListener('message', (message) => {
          if (!current()) return
          if (typeof message.data !== 'string' || message.data.length > 65536) { fail('Invalid sidecar event'); return }
          try {
            const event = sidecarEventSchema.parse(JSON.parse(message.data))
            if (event.sessionId !== this.session!.sessionId || event.generation !== generation) {
              if (this.switching && event.generation === generation && event.type === 'status' &&
                event.requestId && this.pending.has(event.requestId)) {
                const request = this.pending.get(event.requestId)!
                clearTimeout(request.timer); this.pending.delete(event.requestId); request.resolve()
                return
              }
              fail('Stale sidecar event rejected'); return
            }
            if (event.type === 'status') {
              if (event.clock) this.clockSamples.push(clockEstimate(event.clock.clientSendMs, event.clock.serverReceiveMs,
                event.clock.serverSendMs, performance.now()))
              if (event.requestId) {
                const request = this.pending.get(event.requestId)
                if (request) { clearTimeout(request.timer); this.pending.delete(event.requestId); request.resolve() }
              }
              const markReady = (): void => {
                if (!current() || this.stopping) return
                clearTimeout(readyDeadline)
                this.available = this.hadReady = true
                this.firstReady.resolve()
                for (const waiter of this.readyWaiters) waiter.resolve()
                this.readyWaiters.clear()
                this.reportDrops()
                this.options.onStatus(event)
              }
              if (event.status === 'ready' && !event.requestId) {
                if (this.options.protocolVersion === 2 && !this.clockMapping) {
                  void this.synchronizeClock().then(markReady).catch(() => fail('Source clock synchronization failed'))
                } else markReady()
              } else this.options.onStatus(event)
              if (!health && event.status !== 'stopped') health = setInterval(() => {
                if (!this.stopping && !this.lifecycleRequests && ![...this.pending.values()].some((request) => request.type === 'ping')) {
                  void this.request('ping').catch(() => fail('Sidecar health check timed out'))
                }
              }, this.options.healthMs ?? 5000)
            } else if (event.type === 'error') {
              this.options.onError(event)
              if (!event.recoverable) fail('Sidecar engine failed')
            } else {
              if (event.type === 'final' && event.text) {
                const previous = this.finalEnd.get(event.source) ?? 0
                if (event.endMs <= previous) return
                this.finalEnd.set(event.source, event.endMs)
              }
              this.options.onTranscript(transcriptSegmentSchema.parse({
                id: event.id, meetingId: this.session!.meetingId, speakerId: null, source: event.source,
                text: event.text, startMs: event.startMs, endMs: event.endMs, isFinal: event.type === 'final',
                ...(event.timing && this.clockMapping ? { timing: {
                  ...event.timing, clock: 'sender-monotonic',
                  ...(event.timing.finalizationStartMs === undefined ? {} :
                    { finalizationStartMs: event.timing.finalizationStartMs - this.clockMapping.offsetMs }),
                  ...Object.fromEntries(['captureStartMs', 'captureEndMs', 'sentMs', 'receivedMs',
                    'inferenceStartMs', 'inferenceEndMs', 'emittedMs'].map((key) =>
                      [key, event.timing![key as keyof typeof event.timing] as number - this.clockMapping!.offsetMs]))
                } } : {})
              }))
            }
          } catch { fail('Invalid sidecar event') }
        })
        socket.addEventListener('close', () => { if (current()) fail('Local sidecar socket disconnected') })
        socket.addEventListener('error', () => { if (current()) fail('Local sidecar socket failed') })
      } catch { fail('Invalid sidecar listening handshake') }
    })
    try { return await done.promise }
    finally {
      this.available = false
      clearTimeout(startup); clearTimeout(readyDeadline); clearInterval(health); clearInterval(flushTimer)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer); pending.reject(new SidecarOperationError('Sidecar generation ended'))
      }
      this.pending.clear()
      try { socket?.close() } catch { /* already closed */ }
      if (!didExit) {
        if (process.platform === 'win32' && !this.options.spawnProcess && child.pid) {
          // Python's Windows venv redirector can have a child. Terminate this owned tree.
          await new Promise<void>((resolve) => {
            if (!process.env.SystemRoot) throw new SidecarOperationError('Windows process runtime unavailable; restart refused')
            const killer = spawn(join(process.env.SystemRoot, 'System32/taskkill.exe'),
              ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            killer.once('error', () => resolve()); killer.once('close', () => resolve())
          })
        } else child.kill()
        await Promise.race([exited.promise, delay(this.options.shutdownMs ?? 3000)])
        if (!didExit) { child.kill('SIGKILL'); await Promise.race([exited.promise, delay(this.options.shutdownMs ?? 3000)]) }
        if (!didExit) throw new SidecarOperationError('Previous sidecar did not exit; restart refused')
      }
      if (this.child === child) this.child = undefined
      if (this.socket === socket) this.socket = undefined
    }
  }

  private request(type: SidecarControl['type'], fields: Record<string, unknown> = {}, timeout = this.options.requestMs ?? 5000): Promise<void> {
    if (!this.socket || this.socket.readyState !== 1 || this.pending.size >= 64) return Promise.reject(new SidecarOperationError('Sidecar control unavailable'))
    const requestId = randomUUID()
    const control = sidecarControlSchema.parse({ type, sessionId: this.session!.sessionId, generation: this.generation, requestId, ...fields })
    const lifecycle = !['ping', 'clock-sync', 'clock-set'].includes(type)
    if (lifecycle) this.lifecycleRequests++
    const operation = new Promise<void>((resolve, reject) => {
      const pending = { type, resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined }
      const expired = (): void => {
        if (type === 'ping' && (this.lifecycleRequests || performance.now() < this.healthGraceUntil)) {
          pending.timer = setTimeout(expired, this.lifecycleRequests ? timeout : Math.max(1, this.healthGraceUntil - performance.now()))
          return
        }
        this.pending.delete(requestId)
        reject(new SidecarOperationError('Sidecar control timed out'))
      }
      pending.timer = setTimeout(expired, timeout)
      this.pending.set(requestId, pending)
      try { this.socket!.send(JSON.stringify(control)) }
      catch { clearTimeout(pending.timer); this.pending.delete(requestId); reject(new SidecarOperationError('Sidecar control failed')) }
    })
    return operation.finally(() => {
      if (lifecycle) {
        this.lifecycleRequests--
        this.healthGraceUntil = performance.now() + (this.options.requestMs ?? 5000)
      }
    })
  }

  sendFrame(source: AudioSourceName, pcm: Uint8Array, metadata: AudioFrameMetadata): boolean {
    speechDiagnostics.record('manager_received', source, pcm.byteLength / 2)
    if (!this.active || this.standby || this.switching || this.stopping || this.permanent || this.paused || !this.hadReady) {
      speechDiagnostics.record('manager_rejected_state', source, pcm.byteLength / 2)
      return false
    }
    audioFrameMetadataSchema.parse(metadata)
    if (!this.session!.enabledSources.includes(source) || !(pcm instanceof Uint8Array) || pcm.byteLength !== 3200) {
      throw new SidecarOperationError('Invalid untagged PCM frame')
    }
    if (this.options.protocolVersion === 2) encodeTimedFrame(source, pcm, metadata, performance.now())
    const limit = this.options.bufferFramesPerSource ?? 20
    if (this.queue.filter((frame) => frame.source === source).length >= limit) {
      speechDiagnostics.record('manager_drop_overflow', source, 1600)
      this.queue.splice(this.queue.findIndex((frame) => frame.source === source), 1)
      this.dropped.set(source, (this.dropped.get(source) ?? 0) + 1600)
    }
    speechDiagnostics.record('manager_enqueued', source, 1600, { startSample: metadata.startSample })
    this.queue.push({ source, pcm: Uint8Array.from(pcm), metadata: { ...metadata } })
    this.flush()
    return true
  }

  private flush(): void {
    if (!this.available || this.standby || this.paused || !this.socket || this.socket.readyState !== 1) return
    let sent = 0
    while (this.queue.length && this.socket.bufferedAmount < 128000 && sent++ < 8) {
      const frame = this.queue.shift()!
      speechDiagnostics.record('manager_dequeued', frame.source, 1600)
      const expected = this.expected.get(frame.source)
      if (expected !== undefined && frame.metadata.startSample < expected) {
        speechDiagnostics.record('manager_drop_stale', frame.source, 1600)
        this.dropped.set(frame.source, (this.dropped.get(frame.source) ?? 0) + 1600)
        continue
      }
      if (expected === undefined || expected !== frame.metadata.startSample) {
        const type = expected === undefined ? 'source-start' : 'source-gap'
        void this.request(type, { source: frame.source, startSample: frame.metadata.startSample,
          ...(expected === undefined ? {} : { droppedSamples: frame.metadata.startSample - expected }) })
          .catch(() => this.finishGeneration?.('Source timing acknowledgement failed'))
      }
      const tagged = this.options.protocolVersion === 2
        ? encodeTimedFrame(frame.source, frame.pcm, frame.metadata, performance.now()) : new Uint8Array(3201)
      if (this.options.protocolVersion !== 2) { tagged[0] = sourceIds[frame.source]; tagged.set(frame.pcm, 1) }
      try {
        const started = performance.now()
        this.socket.send(tagged)
        speechDiagnostics.record('websocket_written', frame.source, 1600, {
          startSample: frame.metadata.startSample, bufferedBytes: this.socket.bufferedAmount,
          writeMs: performance.now() - started
        })
      }
      catch { speechDiagnostics.record('manager_drop_send_failed', frame.source, 1600); this.dropped.set(frame.source, (this.dropped.get(frame.source) ?? 0) + 1600); this.finishGeneration?.('Audio transmission failed'); break }
      this.expected.set(frame.source, frame.metadata.startSample + 1600)
    }
    if (this.available) this.reportDrops()
  }
  private reportDrops(): void {
    for (const [source, samples] of this.dropped) if (samples) {
      this.error('AUDIO_DROPPED', 'Bounded restart or transmission buffer discarded audio', true)
      this.options.onStatus({ type: 'status', sessionId: this.session!.sessionId, generation: this.generation,
        status: this.permanent ? 'error' : this.available ? 'listening' : 'restarting',
        metrics: { source, queueDepth: this.queue.length, droppedSamples: samples } })
    }
    this.dropped.clear()
  }
  private dropQueue(): void {
    for (const frame of this.queue) {
      speechDiagnostics.record('manager_drop_clear', frame.source, 1600)
      this.dropped.set(frame.source, (this.dropped.get(frame.source) ?? 0) + 1600)
    }
    this.queue = []; this.reportDrops()
  }
  private async drain(): Promise<void> {
    const deadline = performance.now() + 3000
    while (this.queue.length) {
      this.flush()
      if (performance.now() > deadline || !this.available) throw new SidecarOperationError('Audio buffer could not drain')
      await delay(20)
    }
  }
  async sourceEnd(source: AudioSourceName, paddedSamples = 0): Promise<void> {
    if (!this.ready && this.active && !this.stopping && !this.permanent) {
      const waiter = deferred<void>()
      this.readyWaiters.add(waiter)
      const timer = setTimeout(() => waiter.reject(new SidecarOperationError('Sidecar recovery timed out')), 15000)
      try { await waiter.promise } finally { clearTimeout(timer); this.readyWaiters.delete(waiter) }
    }
    if (!this.ready || this.paused) throw new SidecarOperationError('Sidecar unavailable for source finalization')
    await this.drain()
    await this.request('source-end', { source, paddedSamples }, this.options.finalizationMs ?? 30000)
  }
  async pause(): Promise<void> {
    if (!this.ready) throw new SidecarOperationError('Sidecar unavailable for pause')
    await this.drain()
    this.paused = true; this.dropQueue()
    await this.request('pause', {}, this.options.finalizationMs ?? 30000)
    this.expected.clear()
  }
  async resume(): Promise<void> {
    if (!this.ready) throw new SidecarOperationError('Sidecar unavailable for resume')
    await this.request('resume')
    this.expected.clear(); this.paused = false
  }
  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation
    if (!this.active) return Promise.resolve()
    const operation = this.stopOwnedProcess()
    this.stopOperation = operation
    void operation.finally(() => { if (this.stopOperation === operation) this.stopOperation = undefined }).catch(() => undefined)
    return operation
  }

  private async stopOwnedProcess(): Promise<void> {
    this.stopping = true
    try {
      if (this.available && this.socket?.readyState === 1) {
        try { await this.drain() } catch { this.dropQueue() }
        await this.request('stop', {}, this.options.finalizationMs ?? 30000)
      } else this.dropQueue()
    } catch { this.error('STOP_TIMEOUT', 'Sidecar could not finish normally; unfinalized speech may be missing', false) }
    finally {
      this.available = false; this.lifetime.abort(); this.finishGeneration?.('Session stopped')
      await this.supervision
      for (const waiter of this.readyWaiters) waiter.reject(new SidecarOperationError('Session stopped'))
      this.readyWaiters.clear()
      if (this.child) {
        this.error('SHUTDOWN_FAILED', 'Sidecar process did not exit; starting another session is refused', false)
        this.status('error')
        throw new SidecarOperationError('Sidecar process did not exit')
      }
      this.active = false
      await speechDiagnostics.save().catch(() => this.error('DIAGNOSTICS_FAILED', 'Numeric diagnostics could not be saved', true))
      this.firstReady.reject(new SidecarOperationError('Session stopped before readiness'))
      this.status('stopped')
    }
  }
}
