import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AudioSourceName } from '../shared/contracts'

/** Numeric observations only. Collection is opt-in and has a fixed memory bound. */
export class SpeechDiagnostics {
  private rows: Record<string, unknown>[] = []
  private counts: Record<string, number> = {}
  private omitted = 0
  constructor(private readonly directory = process.env.VINXA_DIAGNOSTICS_DIR, private readonly limit = 50000) {}

  record(stage: string, source: AudioSourceName, samples = 0, values: Record<string, number> = {}): void {
    if (!this.directory) return
    if (!Object.values(values).every(Number.isFinite)) throw new Error('Invalid numeric diagnostics')
    const prefix = `${source}.${stage}`
    this.counts[`${prefix}.frames`] = (this.counts[`${prefix}.frames`] ?? 0) + 1
    this.counts[`${prefix}.samples`] = (this.counts[`${prefix}.samples`] ?? 0) + samples
    if (this.rows.length < this.limit) this.rows.push({ stage, source, samples, ...values, mainMonotonicMs: performance.now() })
    else this.omitted++
  }

  async save(): Promise<void> {
    if (!this.directory) return
    await mkdir(this.directory, { recursive: true })
    const data = JSON.stringify({ clock: 'Electron main monotonic milliseconds', counters: this.counts,
      events: this.rows, omittedDiagnosticRows: this.omitted })
    await writeFile(join(this.directory, `electron-${randomUUID()}.json`), data, { flag: 'wx' })
  }
}

export const speechDiagnostics = new SpeechDiagnostics()
