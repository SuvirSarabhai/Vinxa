import { Buffer } from 'node:buffer'

export function validateWav(data: Buffer): { sampleRate: number; samples: number; durationSeconds: number; peak: number; rms: number; clippedSamples: number } {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid RIFF/WAVE header')
  }
  if (data.readUInt32LE(4) + 8 !== data.length) throw new Error('RIFF length does not match file length')
  let formatFound = false
  let audio: Buffer | undefined
  let offset = 12
  while (offset + 8 <= data.length) {
    const name = data.toString('ascii', offset, offset + 4)
    const length = data.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > data.length) throw new Error('Truncated WAV chunk')
    if (name === 'fmt ') {
      if (length < 16 || data.readUInt16LE(start) !== 1 || data.readUInt16LE(start + 2) !== 1 ||
          data.readUInt32LE(start + 4) !== 16000 || data.readUInt32LE(start + 8) !== 32000 ||
          data.readUInt16LE(start + 12) !== 2 || data.readUInt16LE(start + 14) !== 16) {
        throw new Error('Expected 16000 Hz mono signed 16-bit PCM WAV')
      }
      formatFound = true
    }
    if (name === 'data') {
      if (audio) throw new Error('Multiple WAV data chunks are unsupported')
      audio = data.subarray(start, start + length)
    }
    offset = start + length + length % 2
  }
  if (offset !== data.length || !formatFound || !audio || audio.length === 0 || audio.length % 2) {
    throw new Error('Missing, empty, or invalid WAV data')
  }
  let peak = 0
  let squares = 0
  let clippedSamples = 0
  for (let index = 0; index < audio.length; index += 2) {
    const value = audio.readInt16LE(index)
    peak = Math.max(peak, Math.abs(value) / 32768)
    squares += (value / 32768) ** 2
    if (value === -32768 || value === 32767) clippedSamples++
  }
  const samples = audio.length / 2
  const rms = Math.sqrt(squares / samples)
  if (peak === 0 || rms < 0.00001) throw new Error('WAV is silent or below the validation threshold')
  if (clippedSamples > 0) throw new Error(`WAV contains ${clippedSamples} full-scale samples; check microphone gain`)
  return { sampleRate: 16000, samples, durationSeconds: samples / 16000, peak, rms, clippedSamples }
}
