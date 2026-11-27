import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./worklet.ts?worker&url', () => ({ default: 'worklet.js' }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

function setup(source = 'mic') {
  const stopTrack = vi.fn()
  const track = { stop: stopTrack, addEventListener: vi.fn(), getSettings: () => ({ deviceId: 'microphone' }) }
  const stopVideo = vi.fn()
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [{ stop: stopVideo }] }
  const getUserMedia = vi.fn().mockResolvedValue(stream)
  const getDisplayMedia = vi.fn().mockResolvedValue(stream)
  const finished = vi.fn().mockResolvedValue(undefined)
  let stop: () => void = () => {}
  let node: any
  const closeContext = vi.fn().mockResolvedValue(undefined)
  const disconnect = vi.fn()
  const contextOptions = vi.fn()
  class Context {
    constructor(options?: AudioContextOptions) { contextOptions(options) }
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
    destination = {}
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect })
    resume = vi.fn().mockResolvedValue(undefined)
    close = closeContext
  }
  class Worklet {
    port = {
      onmessage: (_event: { data: unknown }) => {}, close: vi.fn(),
      postMessage: (data: any) => {
        if (data.type === 'stop') queueMicrotask(() => this.port.onmessage({ data: { type: 'finished', paddedSamples: 200 } }))
      }
    }
    connect = vi.fn()
    disconnect = disconnect
    constructor(_context: unknown, _name: string, readonly options: AudioWorkletNodeOptions) { node = this }
  }
  vi.stubGlobal('window', { vinxaCapture: {
    onStop: (listener: () => void) => { stop = listener; return vi.fn() },
    ready: vi.fn().mockResolvedValue(undefined), frame: vi.fn().mockResolvedValue(undefined), finished
  } })
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia, getDisplayMedia, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'microphone' }])
  } })
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('AudioWorkletNode', Worklet)
  vi.stubGlobal('location', { search: `?source=${source}` })
  return { stream, stopTrack, stopVideo, getUserMedia, getDisplayMedia, finished, closeContext, contextOptions, disconnect, stop: () => stop(), node: () => node }
}

describe('hidden microphone capture lifecycle', () => {
  it('requests native 16 kHz and falls back only if that rate is unsupported', async () => {
    const test = setup()
    test.contextOptions.mockImplementationOnce(() => { throw new DOMException('unsupported', 'NotSupportedError') })
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    expect(test.contextOptions.mock.calls).toEqual([
      [{ sampleRate: 16000, latencyHint: 'interactive' }], [{ latencyHint: 'interactive' }]
    ])
    test.stop()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalled())
  })

  it.each(['PCM_QUEUE_FULL', 'AUDIO_CLOCK_RESET', 'INVALID_PCM'])('preserves the specific worklet failure %s', async (code) => {
    const test = setup()
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    expect(test.contextOptions).toHaveBeenCalledWith({ sampleRate: 16000, latencyHint: 'interactive' })
    test.node().port.onmessage({ data: { type: 'error', code } })
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({ error: expect.stringContaining(code), paddedSamples: 0 }))
    expect(test.stopTrack).toHaveBeenCalled()
  })
  it('translates worklet sample timing into the main clock and preserves it through IPC calls', async () => {
    const test = setup()
    window.vinxaCapture.clockSync = vi.fn(async (sent) => ({ mainReceiveMs: sent + 1000,
      mainSendMs: sent + 1000, sessionStartMs: 0 }))
    Object.defineProperty(AudioContext.prototype, 'currentTime', { configurable: true, value: 0 })
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    expect(window.vinxaCapture.clockSync).toHaveBeenCalledTimes(3)
    expect(test.node().options.processorOptions.timed).toBe(true)
    for (let sequence = 0; sequence < 2; sequence++) test.node().port.onmessage({ data: {
      type: 'frame', frame: new ArrayBuffer(3201), timing: { sequence, audioTime: sequence / 10,
        sampleCount: 1600, errorMs: 5 }
    } })
    await vi.waitFor(() => expect(window.vinxaCapture.frame).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(window.vinxaCapture.frame).mock.calls
    expect(calls[0][1]).toMatchObject({ sequence: 0, sampleCount: 1600, captureKind: 'render-estimate' })
    expect(calls[1][1]!.startSample - calls[0][1]!.startSample).toBe(1600)
    expect(calls[1][1]!.captureTimeMs! - calls[0][1]!.captureTimeMs!).toBeCloseTo(100)
    expect(calls[0][1]!.captureErrorMs).toBeGreaterThanOrEqual(5)
    test.stop()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalled())
  })
  it('passes configured gain to mic worklet and ignores it for system capture', async () => {
    const test = setup('mic&micGain=0.5')
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    expect(test.node().options.processorOptions).toEqual({ source: 0, micGain: 0.5 })
    test.stop()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalled())
  })

  it('keeps recording after a graph gap and preserves acquisition time across the IPC boundary', async () => {
    const test = setup()
    window.vinxaCapture.clockSync = vi.fn(async (sent) => ({ mainReceiveMs: sent + 1000,
      mainSendMs: sent + 1000, sessionStartMs: 0 }))
    Object.defineProperty(AudioContext.prototype, 'currentTime', { configurable: true, value: 0 })
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    const sendFrame = (sequence: number, audioTime: number) => test.node().port.onmessage({ data: {
      type: 'frame', frame: new ArrayBuffer(3201), timing: { sequence, audioTime, sampleCount: 1600, errorMs: 5 }
    } })
    sendFrame(0, 2)
    test.node().port.onmessage({ data: { type: 'gap', missingInputFrames: 14400, sampleRate: 16000, recovery: 'reanchor' } })
    sendFrame(1, 3)
    sendFrame(2, 3.1)
    await vi.waitFor(() => expect(window.vinxaCapture.frame).toHaveBeenCalledTimes(3))
    const calls = vi.mocked(window.vinxaCapture.frame).mock.calls
    expect(calls.map((call) => call[1]!.sequence)).toEqual([0, 1, 2])
    expect(calls[1][1]!.startSample - calls[0][1]!.startSample).toBe(16000)
    expect(calls[2][1]!.startSample - calls[1][1]!.startSample).toBe(1600)
    expect(test.stopTrack).not.toHaveBeenCalled()
    expect(test.finished).not.toHaveBeenCalled()
    test.stop()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({ error: null, paddedSamples: 200 }))
  })

  it('rejects invalid microphone gain before acquiring an input track', async () => {
    const test = setup('mic&micGain=invalid')
    await import('./capture')
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({
      error: 'Microphone gain must be a finite number between 0.1 and 1', paddedSamples: 0
    }))
    expect(test.getUserMedia).not.toHaveBeenCalled()
    expect(test.node()).toBeUndefined()
  })

  it('uses the microphone selected by the consent-owning recording flow', async () => {
    const test = setup('mic&microphoneDeviceId=selected-input')
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    expect(test.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'selected-input' } }, video: false })
    test.stop()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalled())
  })

  it('warns about saturated input without changing the public completion payload', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const test = setup()
      await import('./capture')
      await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
      const levels = { gain: 0.75, inputPeak: 1, inputFullScaleSamples: 3, outputFullScaleSamples: 0 }
      test.node().port.onmessage({ data: { type: 'finished', paddedSamples: 0, levels } })
      await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({ error: null, paddedSamples: 0 }))
      expect(info).toHaveBeenCalledWith('[vinxa-capture] levels ' + JSON.stringify(levels))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Attenuation cannot restore clipped speech'))
    } finally { info.mockRestore(); warning.mockRestore() }
  })

  it('writes frames then closes the track, context, and port before reporting completion', async () => {
    const test = setup()
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    test.node().port.onmessage({ data: { type: 'frame', frame: new ArrayBuffer(3201) } })
    test.stop()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({ error: null, paddedSamples: 200 }))
    expect(window.vinxaCapture.frame).toHaveBeenCalledTimes(1)
    expect(test.stopTrack).toHaveBeenCalled()
    expect(test.closeContext).toHaveBeenCalled()
    expect(test.disconnect).toHaveBeenCalled()
    expect(test.node().port.close).toHaveBeenCalled()
  })

  it('reports denied permission without creating an audio context', async () => {
    const test = setup()
    test.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await import('./capture')
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({ error: 'Microphone permission was denied', paddedSamples: 0 }))
    expect(test.node()).toBeUndefined()
  })

  it('stops a device acquired after cancellation during the permission prompt', async () => {
    const test = setup()
    let acquired: (stream: unknown) => void = () => {}
    test.getUserMedia.mockReturnValue(new Promise((resolve) => { acquired = resolve }))
    await import('./capture')
    test.stop()
    acquired(test.stream)
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalled())
    expect(test.stopTrack).toHaveBeenCalled()
    expect(test.node()).toBeUndefined()
  })

  it('captures display audio and discards video immediately without opening the microphone', async () => {
    const test = setup('system')
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    expect(test.getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true })
    expect(test.node().options.processorOptions).toEqual({ source: 1, micGain: 1 })
    expect(test.getUserMedia).not.toHaveBeenCalled()
    expect(test.stopVideo).toHaveBeenCalledOnce()
    test.stop()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalled())
    expect(test.stopTrack).toHaveBeenCalled()
    expect(test.closeContext).toHaveBeenCalled()
  })

  it('reports missing loopback audio and stops all returned tracks', async () => {
    const test = setup('system')
    test.stream.getAudioTracks = () => []
    await import('./capture')
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({ error: 'System capture returned no audio track', paddedSamples: 0 }))
    expect(test.getUserMedia).not.toHaveBeenCalled()
    expect(test.stopVideo).toHaveBeenCalled()
    expect(test.stopTrack).toHaveBeenCalled()
  })

  it('reports denied display capture without falling back to microphone input', async () => {
    const test = setup('system')
    test.getDisplayMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await import('./capture')
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({ error: 'System audio permission was denied', paddedSamples: 0 }))
    expect(test.getUserMedia).not.toHaveBeenCalled()
  })

  it('stops and warns when audio devices change during system recording', async () => {
    const test = setup('system')
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    const listener = vi.mocked(navigator.mediaDevices.addEventListener).mock.calls[0][1] as () => Promise<void>
    await listener()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({
      error: 'Audio devices changed during system capture; check Windows default output and repeat the test', paddedSamples: 0
    }))
    expect(test.stopTrack).toHaveBeenCalled()
  })

  it('stops on a system devicechange even if hidden-window enumeration would never resolve', async () => {
    const test = setup('system')
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockReturnValue(new Promise(() => {}))
    await import('./capture')
    await vi.waitFor(() => expect(window.vinxaCapture.ready).toHaveBeenCalled())
    const listener = vi.mocked(navigator.mediaDevices.addEventListener).mock.calls[0][1] as () => Promise<void>
    await listener()
    await vi.waitFor(() => expect(test.finished).toHaveBeenCalledWith({
      error: 'Audio devices changed during system capture; check Windows default output and repeat the test', paddedSamples: 0
    }))
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled()
    expect(test.stopTrack).toHaveBeenCalled()
  })
})
