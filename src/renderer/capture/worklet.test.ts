import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

async function processor(source = 0, micGain?: number, diagnostics = false, timed = false): Promise<{ port: { onmessage: (event: { data: unknown }) => void }; process(inputs: Float32Array[][]): boolean; messages: any[] }> {
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
  return Object.assign(new Constructor({ processorOptions: { source, micGain, diagnostics, timed } }), { messages })
}

describe('AudioWorklet lifecycle', () => {
  it('emits acquisition estimates on the audio sample clock with monotonic sequences', async () => {
    const worklet = await processor(1, undefined, false, true)
    for (let index = 0; index < 80; index++) {
      vi.stubGlobal('currentFrame', index * 128)
      worklet.process([[new Float32Array(128).fill(0.2)]])
    }
    worklet.port.onmessage({ data: { type: 'stop' } })
    const frames = worklet.messages.filter((message) => message.type === 'frame')
    expect(frames.map((message) => message.timing.sequence)).toEqual([0, 1, 2])
    expect(frames.map((message) => message.timing.audioTime)).toEqual([0, 0.1, 0.2])
    expect(frames.every((message) => message.timing.sampleCount === 1600 && message.timing.errorMs > 0)).toBe(true)
  })

  it('reports an audio graph clock discontinuity instead of compressing the timeline', async () => {
    const worklet = await processor(0, undefined, false, true)
    vi.stubGlobal('currentFrame', 0)
    expect(worklet.process([[new Float32Array(128)]])).toBe(true)
    vi.stubGlobal('currentFrame', 256)
    expect(worklet.process([[new Float32Array(128)]])).toBe(false)
    expect(worklet.messages.at(-1).type).toBe('error')
  })

  it('preserves diagnostic sequence through transferred frames and includes the padded tail', async () => {
    const worklet = await processor(1, undefined, true)
    for (let i = 0; i < 80; i++) worklet.process([[new Float32Array(128).fill(0.2)]])
    worklet.port.onmessage({ data: { type: 'stop' } })
    const frames = worklet.messages.filter((message) => message.type === 'frame')
    expect(frames.map((message) => message.diagnostics.sequence)).toEqual([0, 1, 2])
    expect(frames.map((message) => message.diagnostics.producedSamples)).toEqual([1600, 3200, 4800])
    expect(worklet.messages.at(-1).diagnostics.producedFrames).toBe(3)
    expect(frames.every((message) => message.frame.byteLength === 3201 && new Uint8Array(message.frame)[0] === 1)).toBe(true)
  })
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
