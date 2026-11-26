import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WavWriter, wavHeader } from './wav-writer'
import { validateWav } from './wav-validation'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))) })

async function path(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vinxa-wav-'))
  directories.push(directory)
  return join(directory, 'mic.wav')
}

function frame(): ArrayBuffer {
  const data = new ArrayBuffer(3201)
  const view = new DataView(data)
  for (let i = 0; i < 1600; i++) view.setInt16(1 + i * 2, Math.round(8000 * Math.sin(i * Math.PI / 8)), true)
  return data
}

describe('microphone WAV writer', () => {
  it('serializes concurrent frames, updates interrupted headers and trims final padding', async () => {
    const target = await path()
    const writer = await WavWriter.create(target)
    await Promise.all([writer.append(frame()), writer.append(frame())])
    const interrupted = validateWav(await readFile(target))
    expect(interrupted.samples).toBe(3200)
    await writer.close(200)
    const result = validateWav(await readFile(target))
    expect(result.samples).toBe(3000)
    expect(result.durationSeconds).toBe(3000 / 16000)
    await writer.close()
    await expect(writer.append(frame())).rejects.toThrow('closed')
  })

  it('keeps existing recordings and rejects excessive pending writes', async () => {
    const target = await path()
    const writer = await WavWriter.create(target)
    await expect(WavWriter.create(target)).rejects.toMatchObject({ code: 'EEXIST' })
    const writes = Array.from({ length: 4 }, () => writer.append(frame()))
    await expect(writer.append(frame())).rejects.toThrow('buffer')
    await Promise.all(writes)
    await writer.close()
  })

  it('rejects corrupt, unsupported, silent, empty, truncated and clipped WAVs', () => {
    expect(() => validateWav(Buffer.alloc(44))).toThrow('header')
    expect(() => validateWav(wavHeader(0))).toThrow('empty')
    const silent = Buffer.concat([wavHeader(3200), Buffer.alloc(3200)])
    expect(() => validateWav(silent)).toThrow('silent')
    const wrong = Buffer.from(silent); wrong.writeUInt32LE(48000, 24)
    expect(() => validateWav(wrong)).toThrow('16000')
    expect(() => validateWav(silent.subarray(0, 80))).toThrow('length')
    const clipped = Buffer.from(silent); clipped.writeInt16LE(32767, 44)
    expect(() => validateWav(clipped)).toThrow('full-scale')
  })

  it('rejects a microphone-tagged frame sent to the system writer', async () => {
    const writer = await WavWriter.create(await path(), 1)
    expect(() => writer.append(frame())).toThrow('source')
    const systemFrame = frame()
    new Uint8Array(systemFrame)[0] = 1
    await writer.append(systemFrame)
    await writer.close()
  })
})
