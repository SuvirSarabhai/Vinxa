import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SpeechDiagnostics } from './speech-diagnostics'

it('keeps per-source totals when bounded diagnostic detail overflows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vinxa-diagnostics-'))
  try {
    const diagnostics = new SpeechDiagnostics(directory, 1)
    diagnostics.record('received', 'mic', 1600, { sequence: 0 })
    diagnostics.record('received', 'mic', 1600, { sequence: 2 })
    diagnostics.record('received', 'system', 1600, { sequence: 0 })
    expect(() => diagnostics.record('received', 'mic', 0, { value: NaN })).toThrow()
    await diagnostics.save()
    const files = await readdir(directory)
    const report = JSON.parse(await readFile(join(directory, files[0]), 'utf8'))
    expect(report.counters['mic.received.samples']).toBe(3200)
    expect(report.counters['system.received.samples']).toBe(1600)
    expect(report.events).toHaveLength(1)
    expect(report.omittedDiagnosticRows).toBe(2)
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})
