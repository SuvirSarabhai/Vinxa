import { describe, expect, it } from 'vitest'
import { floatToInt16, PcmEncoder, validatePcmFrame } from './pcm'

function encode(rate: number, channels: Float32Array[], quantum = 128): { frames: ArrayBuffer[]; samples: number[]; padding: number } {
  const frames: ArrayBuffer[] = []
  const encoder = new PcmEncoder(rate, 0, (frame) => frames.push(frame))
  for (let offset = 0; offset < channels[0].length; offset += quantum) {
    encoder.push(channels.map((channel) => channel.subarray(offset, offset + quantum)))
  }
  const padding = encoder.finish()
  const samples = frames.flatMap((frame) => {
    const view = new DataView(frame)
    return Array.from({ length: 1600 }, (_, i) => view.getInt16(1 + i * 2, true))
  })
  return { frames, samples: samples.slice(0, samples.length - padding), padding }
}

function tone(rate: number, frequency: number): Float32Array {
  return Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * i / rate))
}

describe('microphone PCM contract', () => {
  it('emits native 16 kHz samples immediately without filtering or changing sample values', () => {
    const frames: ArrayBuffer[] = []
    const encoder = new PcmEncoder(16000, 0, (frame) => frames.push(frame))
    const input = Float32Array.from({ length: 1600 }, (_, index) => index % 2 ? 0.25 : -0.5)
    encoder.push([input])
    expect(frames).toHaveLength(1)
    const view = new DataView(frames[0])
    expect(Array.from(input, (_, index) => view.getInt16(1 + index * 2, true))).toEqual(Array.from(input, floatToInt16))
    expect(encoder.finish()).toBe(0)
  })
  it('clips signed int16 values and rejects nonfinite samples', () => {
    expect([-2, -1, 0, 1, 2].map(floatToInt16)).toEqual([-32768, -32768, 0, 32767, 32767])
    expect(() => floatToInt16(NaN)).toThrow('finite')
  })

  it.each([44100, 48000, 16000, 8000, 96000])('resamples a stereo 1 kHz tone from %i Hz with the correct count', (rate) => {
    const input = tone(rate, 1000)
    const { samples, frames, padding } = encode(rate, [input, input])
    expect(samples.length).toBe(16000)
    expect(padding).toBe(0)
    expect(frames.length).toBe(10)
    for (const frame of frames) { expect(frame.byteLength).toBe(3201); validatePcmFrame(frame, 0) }
    // Compare DFT bins around the expected dominant frequency, away from filter edges.
    const magnitudes = [500, 900, 1000, 1100, 2000].map((frequency) => {
      let real = 0; let imaginary = 0
      for (let i = 160; i < 15840; i++) {
        real += samples[i] * Math.cos(2 * Math.PI * frequency * i / 16000)
        imaginary += samples[i] * Math.sin(2 * Math.PI * frequency * i / 16000)
      }
      return Math.hypot(real, imaginary)
    })
    expect(magnitudes.indexOf(Math.max(...magnitudes))).toBe(2)
  })

  it('preserves chunk continuity, suppresses aliasing, and downmixes opposite channels to silence', () => {
    const input = tone(48000, 1000)
    expect(encode(48000, [input], 127).samples).toEqual(encode(48000, [input], 1024).samples)
    const silent = encode(48000, [input, input.map((value) => -value)])
    expect(silent.samples.every((value) => value === 0)).toBe(true)
    const alias = encode(48000, [tone(48000, 12000)]).samples.slice(160, -160)
    expect(Math.max(...alias.map(Math.abs))).toBeLessThan(100)
  })

  it('pads only the last frame and reports exact trim length', () => {
    const result = encode(48000, [new Float32Array(4801)])
    expect(result.samples.length).toBe(1600)
    expect(result.padding).toBe(0)
    const partial = encode(48000, [new Float32Array(5000)])
    expect(partial.samples.length).toBe(1666)
    expect(partial.padding).toBe(1534)
    expect(partial.frames[1].byteLength).toBe(3201)
  })

  it('rejects malformed frames, invalid rates and mismatched channels', () => {
    expect(() => validatePcmFrame(new ArrayBuffer(3200), 0)).toThrow('3200')
    const wrong = new ArrayBuffer(3201); new Uint8Array(wrong)[0] = 1
    expect(() => validatePcmFrame(wrong, 0)).toThrow('source')
    expect(() => new PcmEncoder(0, 0, () => {})).toThrow('rate')
    const encoder = new PcmEncoder(48000, 0, () => {})
    expect(() => encoder.push([new Float32Array(1), new Float32Array(2)])).toThrow('lengths')
    encoder.finish()
    expect(() => encoder.push([])).toThrow('stopped')
  })
})
