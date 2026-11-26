import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

async function processor(): Promise<{ port: { onmessage: (event: { data: unknown }) => void }; process(inputs: Float32Array[][]): boolean; messages: any[] }> {
  const messages: any[] = []
  let Constructor: any
  class Processor {
    port = {
      onmessage: () => {},
      postMessage: (data: unknown, transfer: ArrayBuffer[] = []) => messages.push(structuredClone(data, { transfer }))
    }
  }
  vi.stubGlobal('AudioWorkletProcessor', Processor)
  vi.stubGlobal('sampleRate', 48000)
  vi.stubGlobal('registerProcessor', (_name: string, constructor: any) => { Constructor = constructor })
  await import('./worklet')
  return Object.assign(new Constructor(), { messages })
}

describe('AudioWorklet lifecycle', () => {
  it('transfers exact frames, consumes acknowledgements, flushes, and stops processing', async () => {
    const worklet = await processor()
    for (let i = 0; i < 40; i++) worklet.process([[new Float32Array(128).fill(0.1)]])
    expect(worklet.messages[0].type).toBe('frame')
    expect(worklet.messages[0].frame.byteLength).toBe(3201)
    worklet.port.onmessage({ data: { type: 'ack' } })
    worklet.port.onmessage({ data: { type: 'stop' } })
    expect(worklet.messages.at(-1)).toMatchObject({ type: 'finished', paddedSamples: 1494 })
    expect(worklet.process([])).toBe(false)
  })

  it('fails visibly instead of allowing an unbounded frame queue', async () => {
    const worklet = await processor()
    for (let i = 0; i < 250; i++) worklet.process([[new Float32Array(128)]])
    expect(worklet.messages.filter((message) => message.type === 'frame')).toHaveLength(4)
    expect(worklet.messages.at(-1)).toEqual({ type: 'error' })
    expect(worklet.process([])).toBe(false)
  })
})
