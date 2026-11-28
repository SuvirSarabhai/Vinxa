import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { MeetingAudioSpool } from './spool'
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})
const folders: string[] = []
async function setup(mic = true, system = true) {
  const dir = await mkdtemp(join(tmpdir(), 'vinxa-spool-')); folders.push(dir)
  return MeetingAudioSpool.create(dir, randomUUID(), { title: 'Test', microphoneEnabled: mic, systemAudioEnabled: system, microphoneDeviceId: null })
}
afterEach(async () => { vi.restoreAllMocks(); for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true }) })
describe('meeting audio files', () => {
  it('writes separate valid WAVs and preserves pause gaps and sample counts', async () => {
    const spool = await setup()
    await spool.append('mic', new Uint8Array(3200).fill(1), { startSample: 1600 })
    await spool.endSource('mic', 100)
    await spool.append('mic', new Uint8Array(3200).fill(2), { startSample: 5000 })
    await spool.append('system', new Uint8Array(3200).fill(3), { startSample: 0 })
    const paths = await spool.finalize()
    expect(await spool.finalize()).toEqual(paths)
    const mic = await readFile(paths.microphoneAudioPath!)
    expect(mic.subarray(0,4).toString()).toBe('RIFF')
    expect(mic.readUInt32LE(24)).toBe(16000)
    expect(mic.readUInt16LE(22)).toBe(1)
    expect(mic.readUInt32LE(40)).toBe(13200)
    expect(mic.subarray(44, 3244).every(n => n === 0)).toBe(true)
    expect((await readFile(paths.systemAudioPath!)).readUInt32LE(40)).toBe(3200)
    const metadata = JSON.parse(await readFile(join(spool.directory, 'metadata.json'), 'utf8'))
    expect(metadata.sources.mic.capturedSamples).toBe(3100)
  })
  it('finalizes empty enabled sources and omits disabled sources', async () => {
    const spool = await setup(true, false)
    const paths = await spool.finalize()
    expect(paths.systemAudioPath).toBeNull()
    expect((await readFile(paths.microphoneAudioPath!)).length).toBe(44)
    await expect(spool.append('mic', new Uint8Array(3200), { startSample: 0 })).rejects.toThrow()
  })
  it('reports overlapping frames on append and finalization', async () => {
    const spool = await setup()
    await spool.append('mic', new Uint8Array(3200), { startSample: 1600 })
    await expect(spool.append('mic', new Uint8Array(3200), { startSample: 0 })).rejects.toThrow('Overlapping')
    await expect(spool.finalize()).rejects.toThrow('Overlapping')
  })
  it('surfaces an actual file write rejection and still closes both files', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).open
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await original(...args)
      if (String(args[0]).endsWith('microphone.wav')) vi.spyOn(file, 'write').mockRejectedValueOnce(new Error('ENOSPC'))
      return file
    })
    const spool = await setup()
    await expect(spool.append('mic', new Uint8Array(3200), {startSample:0})).rejects.toThrow('ENOSPC')
    await spool.append('system', new Uint8Array(3200), {startSample:0})
    await expect(spool.finalize()).rejects.toThrow('ENOSPC')
    expect((await readFile(spool.paths.systemAudioPath!)).readUInt32LE(40)).toBe(3200)
    const metadata = JSON.parse(await readFile(join(spool.directory, 'metadata.json'), 'utf8'))
    expect(metadata.finalized).toBe(false)
  })
})
