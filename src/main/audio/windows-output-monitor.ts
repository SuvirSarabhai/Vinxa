import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WindowsOutputMonitor { stop(): Promise<void> }

/** Observe Windows default render endpoints without opening a mic or changing routes. */
export async function watchWindowsDefaultOutput(scriptPath: string, changed: () => void,
  failed: (message: string) => void): Promise<WindowsOutputMonitor> {
  if (process.platform !== 'win32') throw new Error('Windows output monitoring requires Windows')
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('Windows output monitoring could not locate the Windows runtime')
  const script = await readFile(scriptPath, 'utf8')
    .catch(() => { throw new Error('Windows output monitor resource is missing or unreadable') })

  return new Promise((resolve, reject) => {
    const child = spawn(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let state: 'starting' | 'watching' | 'stopping' | 'closed' = 'starting'
    let buffer = ''
    let deliveredChange = false
    let stopPromise: Promise<void> | undefined
    let resolveExit: () => void
    const exited = new Promise<void>((done) => { resolveExit = done })
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let healthTimer: ReturnType<typeof setTimeout> | undefined

    function terminate(): Promise<void> {
      if (stopPromise) return stopPromise
      clearTimeout(startupTimer)
      clearTimeout(healthTimer)
      if (state === 'closed') return Promise.resolve()
      state = 'stopping'
      child.stdin.end('\n')
      killTimer = setTimeout(() => { child.kill() }, 1000)
      killTimer.unref()
      stopPromise = exited
      return stopPromise
    }

    function fail(message: string): void {
      if (state === 'stopping' || state === 'closed') return
      const wasReady = state === 'watching'
      void terminate()
      if (wasReady) failed(message)
      else reject(new Error(message))
    }

    function heartbeat(): void {
      clearTimeout(healthTimer)
      healthTimer = setTimeout(() => fail('Windows output monitor stopped responding; capture must be restarted'), 5000)
    }

    const startupTimer = setTimeout(() => fail('Windows output monitor startup timed out'), 10000)
    child.stdin.on('error', () => {}) // A child that has exited can close this pipe before stop.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (state === 'stopping' || state === 'closed') return
      buffer += chunk
      if (buffer.length > 1024) { fail('Windows output monitor returned invalid diagnostics'); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        if (line === 'ready' && state === 'starting') {
          state = 'watching'
          clearTimeout(startupTimer)
          heartbeat()
          resolve({ stop: terminate })
        } else if (line === 'heartbeat' && state === 'watching') {
          heartbeat()
        } else if (line === 'changed' && state === 'watching' && !deliveredChange) {
          deliveredChange = true
          // The helper exits after reporting a change. Stop it before notifying the caller.
          void terminate()
          changed()
          return
        } else {
          fail('Windows output monitor failed; check Windows PowerShell and Core Audio availability')
          return
        }
      }
    })
    child.once('error', () => {
      fail('Windows output monitor could not start')
      // Spawn failure may not emit exit; close is emitted in both cases.
    })
    child.once('close', () => {
      const previous = state
      state = 'closed'
      clearTimeout(startupTimer)
      clearTimeout(healthTimer)
      clearTimeout(killTimer)
      resolveExit()
      if (previous === 'starting') reject(new Error('Windows output monitor exited before becoming ready'))
      else if (previous === 'watching') failed('Windows output monitor exited unexpectedly; capture must be restarted')
    })
  })
}
