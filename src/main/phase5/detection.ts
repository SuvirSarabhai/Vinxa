import { powershell } from './windows'

export interface CallWindow { process: string; title: string }
/** Window-title heuristic, not a conferencing API or proof of an active call. */
export function callCandidates(windows: CallWindow[]): string[] {
  return [...new Set(windows.filter(w =>
    (/^(zoom|teams|ms-teams)$/i.test(w.process) && /\b(meeting|in a call|call with|call in progress)\b/i.test(w.title)))
    .map(w => w.process.toLowerCase()))]
}
export class MeetingDetector {
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private previous = new Set<string>()
  private closed = false
  constructor(private readonly offer: () => void, private readonly idle: () => boolean) {}
  start(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => void this.poll(), 10000)
    this.timer.unref()
    void this.poll()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.previous.clear() }
  close(): void { this.closed = true; this.stop() }
  private async poll(): Promise<void> {
    if (this.running || !this.timer || this.closed) return
    this.running = true
    try {
      const output = await powershell(`$ErrorActionPreference='Stop'; $items=@(Get-Process -Name Zoom,Teams,ms-teams -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle} | ForEach-Object {@{process=$_.ProcessName;title=$_.MainWindowTitle}}); ConvertTo-Json -InputObject $items -Compress`)
      if (!this.timer || this.closed) return
      const parsed: unknown = JSON.parse(output || '[]')
      if (!Array.isArray(parsed)) return
      const windows = parsed.filter((v): v is CallWindow => v && typeof v.process === 'string' && typeof v.title === 'string')
      const candidates = new Set(callCandidates(windows))
      if (this.idle() && [...candidates].some(candidate => !this.previous.has(candidate))) this.offer()
      this.previous = candidates
    } catch { /* Missing or restricted process access never starts recording. */ }
    finally { this.running = false }
  }
}
