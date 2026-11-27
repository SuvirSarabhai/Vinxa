import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SidecarManager } from './sidecar-manager'

class Child extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  kill = vi.fn(() => { this.exitCode = 0; this.emit('close', 0); return true })
}
class Socket extends EventTarget {
  readyState = 0
  bufferedAmount = 0
  messages: Array<string | Uint8Array> = []
  configuration: any
  heldTypes = new Set<string>()
  held: any[] = []
  withholdSessionReady = false
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  event(payload: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })) }
  send(data: string | Uint8Array): void {
    this.messages.push(data)
    if (typeof data !== 'string') return
    const message = JSON.parse(data)
    if (message.type === 'config') {
      this.configuration = message
      this.event({ type: 'status', sessionId: message.sessionId, generation: message.generation, status: 'ready' })
    } else if (this.heldTypes.has(message.type)) this.held.push(message)
    else this.reply(message)
  }
  reply(message: any): void {
    if (message.type === 'clock-sync') {
      // Protocol 2 requires timestamped exchanges before readiness. A generic
      // acknowledgement leaves synchronizeClock() with no usable samples.
      const serverReceiveMs = performance.now()
      this.event({ type: 'status', sessionId: message.sessionId, generation: message.generation,
        requestId: message.requestId, status: 'ready', clock: {
          clientSendMs: message.clientSendMs, serverReceiveMs, serverSendMs: serverReceiveMs
        } })
    } else if (message.type === 'session-begin') {
      queueMicrotask(() => {
        this.event({ type: 'status', sessionId: message.sessionId, generation: message.generation,
          requestId: message.requestId, status: 'ready' })
        this.configuration.sessionId = message.nextSessionId
        if (!this.withholdSessionReady) this.event({ type: 'status', sessionId: message.nextSessionId, generation: message.generation, status: 'ready' })
      })
    } else this.event({ type: 'status', sessionId: message.sessionId, generation: message.generation,
      requestId: message.requestId, status: message.type === 'stop' ? 'stopped' : message.type === 'session-end' ? 'standby' : 'ready' })
  }
  release(type: string): void {
    this.heldTypes.delete(type)
    const pending = this.held.filter((message) => message.type === type)
    this.held = this.held.filter((message) => message.type !== type)
    for (const message of pending) this.reply(message)
  }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
function setup(overrides = {}) {
  const children: Child[] = [], sockets: Socket[] = []
  const spawnProcess = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => {
    const child = new Child(); children.push(child); return child as unknown as ChildProcess
  })
  const onTranscript = vi.fn(), onStatus = vi.fn(), onError = vi.fn()
  const createSocket = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket })
  const manager = new SidecarManager({ runtime: { command: 'test-python', args: ['-m', 'sidecar.server'] },
    spawnProcess, createSocket, onTranscript, onStatus, onError, backoffMs: 1, healthMs: 1000,
    startupMs: 1000, readyMs: 2000, requestMs: 100, shutdownMs: 20, ...overrides })
  const session = { sessionId: randomUUID(), meetingId: 'scripted-test', model: 'base.en', language: 'en', enabledSources: ['mic', 'system'] as ('mic' | 'system')[] }
  function ready(index = 0): void {
    children[index].stdout.write('{"protocolVersion":1,"port":12345,"state":"listening"}\n')
    sockets[index].open()
  }
  return { manager, session, children, sockets, spawnProcess, createSocket, onTranscript, onStatus, onError, ready }
}

describe('sidecar supervisor', () => {
  it('waits for handshake and warmed readiness; authenticates without token in argv or URL', async () => {
    const test = setup()
    const start = test.manager.start(test.session)
    expect(test.manager.ready).toBe(false)
    test.ready()
    await start
    expect(test.manager.ready).toBe(true)
    const options = test.spawnProcess.mock.calls[0][2] as any
    expect(options.windowsHide).toBe(true)
    expect(options.env.VINXA_SIDECAR_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(test.spawnProcess.mock.calls[0].slice(0, 2))).not.toContain(options.env.VINXA_SIDECAR_TOKEN)
    expect(test.createSocket).toHaveBeenCalledWith('ws://127.0.0.1:12345')
    test.manager.sendFrame('mic', new Uint8Array(3200), { startSample: 0 })
    const frame = test.sockets[0].messages.find((m) => m instanceof Uint8Array) as Uint8Array
    expect(frame.length).toBe(3201)
    expect(frame[0]).toBe(0)
    const configuration = test.sockets[0].configuration
    test.sockets[0].event({ type: 'final', ...{ sessionId: configuration.sessionId, generation: 0 },
      id: 'mic:0:1', source: 'mic', text: 'scripted', startMs: 0, endMs: 100 })
    expect(test.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ meetingId: 'scripted-test', isFinal: true }))
    await test.manager.stop()
    expect(test.children[0].exitCode).toBe(0)
  })

  it('reaps the old child, rotates token and reports bounded restart buffer loss', async () => {
    const test = setup({ bufferFramesPerSource: 2 })
    const start = test.manager.start(test.session)
    test.ready(); await start
    const oldToken = test.sockets[0].configuration.token
    test.children[0].kill()
    await vi.waitFor(() => expect(test.manager.ready).toBe(false))
    for (let index = 0; index < 3; index++) test.manager.sendFrame('mic', new Uint8Array(3200), { startSample: index * 1600 })
    await vi.waitFor(() => expect(test.children).toHaveLength(2))
    expect(test.children[0].exitCode).toBe(0)
    test.ready(1)
    expect(test.sockets[1].configuration.token).not.toBe(oldToken)
    expect(test.sockets[1].configuration.generation).toBe(1)
    await vi.waitFor(() => expect(test.sockets[1].messages.filter((m) => m instanceof Uint8Array)).toHaveLength(2))
    expect(test.onStatus.mock.calls.some(([event]) => event.metrics?.droppedSamples === 1600)).toBe(true)
    const count = test.onTranscript.mock.calls.length
    test.sockets[0].event({ type: 'final', sessionId: test.session.sessionId, generation: 0,
      id: 'stale', source: 'mic', text: 'stale-script', startMs: 0, endMs: 100 })
    expect(test.onTranscript).toHaveBeenCalledTimes(count)
    await test.manager.stop()
  })

  it('has bounded restarts and rejects startup instead of looping forever', async () => {
    const test = setup({ maxRestarts: 1 })
    const start = test.manager.start(test.session).catch((error) => error)
    test.children[0].kill()
    await vi.waitFor(() => expect(test.children).toHaveLength(2))
    test.children[1].kill()
    expect((await start).message).toContain('restart limit')
    expect(test.onError.mock.calls.some(([event]) => event.code === 'RESTART_LIMIT' && !event.recoverable)).toBe(true)
    await test.manager.stop()
    expect(test.children).toHaveLength(2)
  })

  it('refuses to start a second process if the owned child cannot be reaped', async () => {
    const test = setup()
    const start = test.manager.start(test.session).catch((error) => error)
    test.children[0].kill.mockImplementation(() => false)
    test.children[0].stdout.write('invalid-handshake\n')
    await start
    expect(test.children).toHaveLength(1)
    await expect(test.manager.stop()).rejects.toThrow('did not exit')
  })

  it('suspends transmission on pause, requires fresh anchors on resume and finalizes sources', async () => {
    const test = setup()
    const start = test.manager.start(test.session)
    test.ready(); await start
    test.manager.sendFrame('mic', new Uint8Array(3200), { startSample: 0 })
    await test.manager.pause()
    expect(test.manager.sendFrame('mic', new Uint8Array(3200), { startSample: 1600 })).toBe(false)
    await test.manager.resume()
    test.manager.sendFrame('mic', new Uint8Array(3200), { startSample: 64000 })
    await test.manager.sourceEnd('mic', 123)
    const controls = test.sockets[0].messages.filter((m) => typeof m === 'string').map((m) => JSON.parse(m as string))
    expect(controls.filter((m) => m.type === 'source-start').map((m) => m.startSample)).toEqual([0, 64000])
    expect(controls.find((m) => m.type === 'source-end').paddedSamples).toBe(123)
    await test.manager.stop()
  })

  it('sends a source-gap control before the first timed packet after a graph interruption', async () => {
    const test = setup({ protocolVersion: 2 })
    const start = test.manager.start(test.session)
    try {
      test.ready(); await start
      const controls = test.sockets[0].messages.filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message))
      expect(controls.filter((message) => message.type === 'clock-sync')).toHaveLength(3)
      const clockSets = controls.filter((message) => message.type === 'clock-set')
      expect(clockSets).toHaveLength(1)
      expect(Number.isFinite(clockSets[0].offsetMs)).toBe(true)
      expect(clockSets[0].uncertaintyMs).toBeGreaterThanOrEqual(0)
      expect(test.onError).not.toHaveBeenCalled()
      for (const [sequence, startSample] of [[0, 0], [1, 16000], [2, 17600]]) {
        expect(test.manager.sendFrame('mic', new Uint8Array(3200), { sequence, startSample,
          captureTimeMs: 100 + startSample / 16, captureErrorMs: 1, sampleCount: 1600,
          captureKind: 'render-estimate' })).toBe(true)
      }
      const messages = test.sockets[0].messages
      const gapIndex = messages.findIndex((message) => typeof message === 'string' && JSON.parse(message).type === 'source-gap')
      expect(gapIndex).toBeGreaterThan(0)
      expect(JSON.parse(messages[gapIndex] as string)).toMatchObject({ source: 'mic', startSample: 16000, droppedSamples: 14400 })
      const resumed = messages[gapIndex + 1] as Uint8Array
      expect(resumed).toBeInstanceOf(Uint8Array)
      const header = new DataView(resumed.buffer, resumed.byteOffset)
      expect(header.getUint32(4, true)).toBe(1)
      expect(header.getFloat64(8, true)).toBe(16000)
      expect(messages.filter((message) => message instanceof Uint8Array)).toHaveLength(3)
      expect(test.manager.ready).toBe(true)
      expect(test.children).toHaveLength(1)
      await test.manager.sourceEnd('mic', 0)
    } finally { await test.manager.stop() }
  })

  it.each(['pause', 'session-end'] as const)('keeps an existing heartbeat alive while %s drains, then resumes health checks', async (control) => {
    const test = setup({ keepWarm: true, healthMs: 10, requestMs: 30 })
    const warm = test.manager.prewarm()
    test.ready(); await warm
    await test.manager.start(test.session)
    const socket = test.sockets[0]
    socket.heldTypes.add('ping')
    socket.heldTypes.add(control)
    try {
      await vi.waitFor(() => expect(socket.held.some((message) => message.type === 'ping')).toBe(true), { interval: 1, timeout: 200 })
      const operation = control === 'pause' ? test.manager.pause() : test.manager.endSession()
      void operation.catch(() => undefined)
      await vi.waitFor(() => expect(socket.held.some((message) => message.type === control)).toBe(true), { interval: 1 })
      await delay(120)
      expect(test.children).toHaveLength(1)
      expect(test.onError).not.toHaveBeenCalled()
      expect(socket.held.filter((message) => message.type === 'ping')).toHaveLength(1)
      socket.release(control)
      socket.release('ping')
      await operation
      await vi.waitFor(() => expect(socket.messages.filter((message) => typeof message === 'string' && JSON.parse(message).type === 'ping').length).toBeGreaterThan(1), { interval: 1 })
      if (control === 'pause') await test.manager.resume()
      else await test.manager.start({ ...test.session, sessionId: randomUUID() })
      expect(test.manager.ready).toBe(true)
    } finally { await test.manager.stop() }
  })

  it('still times out a stuck lifecycle control while heartbeat deadlines are deferred', async () => {
    const test = setup({ healthMs: 10, requestMs: 20, finalizationMs: 50 })
    const start = test.manager.start(test.session)
    test.ready(); await start
    const socket = test.sockets[0]
    socket.heldTypes.add('pause')
    try {
      await expect(test.manager.pause()).rejects.toThrow('timed out')
      expect(test.children).toHaveLength(1)
    } finally { await test.manager.stop() }
  })

  it('shares a concurrent shutdown instead of sending duplicate stop controls', async () => {
    const test = setup()
    const start = test.manager.start(test.session)
    test.ready(); await start
    const socket = test.sockets[0]
    socket.heldTypes.add('stop')
    const first = test.manager.stop()
    const second = test.manager.stop()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(socket.held.filter((message) => message.type === 'stop')).toHaveLength(1))
    socket.release('stop')
    await Promise.all([first, second])
    expect(test.children[0].kill).toHaveBeenCalledOnce()
  })

  it('still detects an unhealthy idle engine outside a lifecycle operation', async () => {
    const test = setup({ healthMs: 10, requestMs: 20, maxRestarts: 0 })
    const start = test.manager.start(test.session)
    test.ready(); await start
    test.sockets[0].heldTypes.add('ping')
    try {
      await vi.waitFor(() => expect(test.onError.mock.calls.some(([event]) => event.code === 'RESTART_LIMIT')).toBe(true), { interval: 1 })
      expect(test.manager.ready).toBe(false)
    } finally { await test.manager.stop() }
  })

  it('bounds readiness after a warm session-begin acknowledgement', async () => {
    const test = setup({ keepWarm: true, readyMs: 50 })
    const warm = test.manager.prewarm()
    test.ready(); await warm
    test.sockets[0].withholdSessionReady = true
    try { await expect(test.manager.start(test.session)).rejects.toThrow('readiness timed out') }
    finally { await test.manager.stop() }
  })
})
