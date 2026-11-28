import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** Fixed scripts only. User/profile values travel in environment variables. */
export function powershell(script: string, values: NodeJS.ProcessEnv = {}, timeout = 15000): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('This feature requires Windows.'))
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, env: { ...process.env, ...values }, timeout, maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(new Error('Windows operation failed. Check OS support and file permissions.')) : resolve(stdout.trim()))
  })
}
