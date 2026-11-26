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
  class Context {
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
    constructor() { node = this }
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
  return { stream, stopTrack, stopVideo, getUserMedia, getDisplayMedia, finished, closeContext, disconnect, stop: () => stop(), node: () => node }
}

describe('hidden microphone capture lifecycle', () => {
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
})
