import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ child: undefined as any, spawn: vi.fn(), readFile: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn }))
vi.mock('node:fs/promises', () => ({ readFile: fake.readFile }))

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks() })

async function start() {
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn()
  })
  fake.child = child
  fake.spawn.mockReturnValue(child)
  fake.readFile.mockResolvedValue('trusted bundled monitor script')
  const changed = vi.fn(), failed = vi.fn()
  const { watchWindowsDefaultOutput } = await import('./windows-output-monitor')
  const ready = watchWindowsDefaultOutput('monitor.ps1', changed, failed)
  await Promise.resolve()
  await Promise.resolve()
  return { child, changed, failed, ready }
}

describe('Windows default-output monitor lifecycle', () => {
  it('waits for readiness, handles split lines, reports a change once and cleans up', async () => {
    const { child, changed, failed, ready } = await start()
    child.stdout.emit('data', 'rea')
    child.stdout.emit('data', 'dy\r\nheartbeat\n')
    const monitor = await ready
    expect(fake.spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true })
    expect(fake.spawn.mock.calls[0][1]).not.toContain('-ExecutionPolicy')
    child.stdout.emit('data', 'changed\n')
    child.stdout.emit('data', 'changed\n')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(child.stdin.end).toHaveBeenCalledWith('\n')
    child.emit('close', 0)
    await monitor.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops intentionally without reporting a failure and kills an unresponsive child', async () => {
    const { child, failed, ready } = await start()
    child.stdout.emit('data', 'ready\n')
    const monitor = await ready
    const stopping = monitor.stop()
    expect(monitor.stop()).toBe(stopping)
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('close', 0)
    await stopping
    expect(failed).not.toHaveBeenCalled()
  })

  it('rejects startup failure without leaving startup timers running', async () => {
    const { child, ready } = await start()
    const rejected = expect(ready).rejects.toThrow('could not start')
    child.emit('error', new Error('private OS detail'))
    child.emit('close', -1)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects startup timeout and stops the helper', async () => {
    const { child, ready } = await start()
    const rejected = expect(ready).rejects.toThrow('startup timed out')
    await vi.advanceTimersByTimeAsync(10000)
    await rejected
    expect(child.stdin.end).toHaveBeenCalled()
    child.emit('close', 0)
  })

  it('reports unexpected exit after readiness', async () => {
    const { child, failed, ready } = await start()
    child.stdout.emit('data', 'ready\n')
    await ready
    child.emit('close', 1)
    expect(failed).toHaveBeenCalledWith(expect.stringContaining('exited unexpectedly'))
  })

  it('detects a hung monitor even when its process has not exited', async () => {
    const { child, failed, ready } = await start()
    child.stdout.emit('data', 'ready\n')
    await ready
    await vi.advanceTimersByTimeAsync(4000)
    child.stdout.emit('data', 'heartbeat\n')
    await vi.advanceTimersByTimeAsync(4000)
    expect(failed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(failed).toHaveBeenCalledWith(expect.stringContaining('stopped responding'))
    child.emit('close', 0)
  })

  it('rejects oversized or unexpected process output without logging its contents', async () => {
    const { child, ready } = await start()
    const rejected = expect(ready).rejects.toThrow('invalid diagnostics')
    child.stdout.emit('data', 'x'.repeat(1025))
    child.emit('close', 1)
    await rejected
  })
})
