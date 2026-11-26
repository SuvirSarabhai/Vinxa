import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

async function processor(source = 0, micGain?: number): Promise<{ port: { onmessage: (event: { data: unknown }) => void }; process(inputs: Float32Array[][]): boolean; messages: any[] }> {
  vi.resetModules()
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
  return Object.assign(new Constructor({ processorOptions: { source, micGain } }), { messages })
}

describe('AudioWorklet lifecycle', () => {
  it('uses conservative microphone gain and emits upstream level evidence on stop', async () => {
    const worklet = await processor()
    for (let i = 0; i < 40; i++) worklet.process([[new Float32Array(128).fill(1)]])
    worklet.port.onmessage({ data: { type: 'stop' } })
    expect(worklet.messages.at(-1)).toMatchObject({ type: 'finished', levels: {
      gain: 0.75, inputSamples: 5120, inputPeak: 1, inputFullScaleSamples: 5120, outputFullScaleSamples: 0
    } })
  })

  it('uses explicit mic gain but keeps system gain at unity', async () => {
    const mic = await processor(0, 0.5)
    mic.process([[new Float32Array(128).fill(0.2)]])
    mic.port.onmessage({ data: { type: 'stop' } })
    expect(mic.messages.at(-1).levels.gain).toBe(0.5)
    const system = await processor(1, 0.5)
    system.process([[new Float32Array(128).fill(0.2)]])
    system.port.onmessage({ data: { type: 'stop' } })
    expect(system.messages.at(-1).levels.gain).toBe(1)
  })

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

  it('keeps the system source tag on every frame', async () => {
    const worklet = await processor(1)
    for (let i = 0; i < 40; i++) worklet.process([[new Float32Array(128).fill(0.2)]])
    worklet.port.onmessage({ data: { type: 'stop' } })
    const frames = worklet.messages.filter((message) => message.type === 'frame')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((message) => new Uint8Array(message.frame)[0] === 1)).toBe(true)
  })
})
