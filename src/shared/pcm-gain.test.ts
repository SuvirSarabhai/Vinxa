import { describe, expect, it } from 'vitest'
import { defaultMicrophoneGain, parseMicrophoneGain, PcmEncoder } from './pcm'

function encode(input: Float32Array, gain: number, source: 0 | 1 = 0) {
  const frames: ArrayBuffer[] = []
  const encoder = new PcmEncoder(48000, source, (frame) => frames.push(frame), gain)
  for (let offset = 0; offset < input.length; offset += 128) encoder.push([input.subarray(offset, offset + 128)])
  const padding = encoder.finish()
  const samples = frames.flatMap((frame) => Array.from({ length: 1600 }, (_, i) => new DataView(frame).getInt16(1 + i * 2, true)))
  return { frames, samples: samples.slice(0, samples.length - padding), levels: encoder.levels }
}

describe('microphone headroom and saturation evidence', () => {
  it('defaults conservatively and accepts explicit unity without allowing amplification', () => {
    expect(parseMicrophoneGain()).toBe(defaultMicrophoneGain)
    expect(parseMicrophoneGain('0.5')).toBe(0.5)
    expect(parseMicrophoneGain(1)).toBe(1)
    expect(parseMicrophoneGain(0.1)).toBe(0.1)
  })

  it.each([0, -1, 1.01, NaN, Infinity, '', ' ', 'invalid', null, true])('rejects invalid gain %s', (value) => {
    expect(() => parseMicrophoneGain(value)).toThrow('between 0.1 and 1')
  })

  it('attenuates once while preserving the resampled waveform, frequency and sample count', () => {
    const input = Float32Array.from({ length: 48000 }, (_, i) => 0.6 * Math.sin(2 * Math.PI * 1000 * i / 48000))
    const unity = encode(input, 1)
    const reduced = encode(input, 0.5)
    expect(reduced.samples).toHaveLength(16000)
    for (let i = 0; i < unity.samples.length; i++) expect(Math.abs(reduced.samples[i] - unity.samples[i] * 0.5)).toBeLessThanOrEqual(1)
    const bins = [900, 1000, 1100].map((frequency) => {
      let real = 0, imaginary = 0
      for (let i = 160; i < 15840; i++) {
        real += reduced.samples[i] * Math.cos(2 * Math.PI * frequency * i / 16000)
        imaginary += reduced.samples[i] * Math.sin(2 * Math.PI * frequency * i / 16000)
      }
      return Math.hypot(real, imaginary)
    })
    expect(bins.indexOf(Math.max(...bins))).toBe(1)
    expect(reduced.levels.outputFullScaleSamples).toBe(0)
  })

  it('retains upstream saturation evidence even when attenuated PCM no longer reaches full scale', () => {
    const result = encode(new Float32Array(48000).fill(1.2), 0.5)
    expect(result.levels.inputSamples).toBe(48000)
    expect(result.levels.inputFullScaleSamples).toBe(48000)
    expect(result.levels.inputPeak).toBeCloseTo(1.2)
    expect(result.levels.preGainPeak).toBeGreaterThan(1)
    expect(result.levels.preGainFullScaleSamples).toBeGreaterThan(0)
    expect(result.levels.outputFullScaleSamples).toBe(0)
    expect(result.levels.preGainSamples).toBe(16000)
    const overrange = encode(new Float32Array(4800).fill(-4), 0.75)
    expect(overrange.samples.every((value) => value >= -32768 && value <= 32767)).toBe(true)
    expect(overrange.levels.outputFullScaleSamples).toBeGreaterThan(0)
  })

  it('keeps system audio byte-identical regardless of the microphone gain setting', () => {
    const input = Float32Array.from({ length: 5000 }, (_, i) => 0.3 * Math.sin(i / 7))
    const first = encode(input, 1, 1)
    const second = encode(input, 0.1, 1)
    expect(second.frames).toEqual(first.frames)
    expect(second.levels.gain).toBe(1)
    expect(second.frames.every((frame) => new Uint8Array(frame)[0] === 1)).toBe(true)
  })
})
