import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
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
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  event(payload: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })) }
  send(data: string | Uint8Array): void {
    this.messages.push(data)
    if (typeof data !== 'string') return
    const message = JSON.parse(data)
    if (message.type === 'config') {
      this.configuration = message
      this.event({ type: 'status', sessionId: message.sessionId, generation: message.generation, status: 'ready' })
    } else this.event({ type: 'status', sessionId: message.sessionId, generation: message.generation,
      requestId: message.requestId, status: message.type === 'stop' ? 'stopped' : 'ready' })
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
})
