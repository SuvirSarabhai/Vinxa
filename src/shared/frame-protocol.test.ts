import { expect, it } from 'vitest'
import { clockEstimate, encodeTimedFrame } from './frame-protocol'

it('encodes little-endian timing while keeping PCM unchanged', () => {
  const pcm = new Uint8Array(3200).fill(5)
  const packet = encodeTimedFrame('system', pcm, { startSample: 11200, sequence: 7,
    captureTimeMs: 1234.5, captureErrorMs: 0.25, sampleCount: 1600 }, 1334.5)
  const header = new DataView(packet.buffer)
  expect([...packet.subarray(0, 4)]).toEqual([86, 88, 2, 1])
  expect(header.getUint32(4, true)).toBe(7)
  expect(header.getFloat64(8, true)).toBe(11200)
  expect(header.getFloat64(16, true)).toBe(1234.5)
  expect(header.getFloat64(24, true)).toBe(1334.5)
  expect(packet.subarray(48)).toEqual(pcm)
  expect(() => encodeTimedFrame('mic', pcm, { startSample: 0 }, 1)).toThrow()
})

it('translates monotonic clock origins and bounds exchange uncertainty', () => {
  expect(clockEstimate(10, 1012, 1013, 15)).toEqual({ offsetMs: 1000, uncertaintyMs: 2 })
  expect(() => clockEstimate(10, 1012, 1013, 9)).toThrow()
})
