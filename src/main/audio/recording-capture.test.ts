import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '../../shared/ipc-channels'

const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[],
  permission: null as any, changed: undefined as (() => void) | undefined, monitorStop: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./windows-output-monitor', () => ({ watchWindowsDefaultOutput: vi.fn(async (_path: string, changed: () => void) => {
  fake.changed = changed
  return { stop: fake.monitorStop }
}) }))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: (name: string, handler: any) => fake.handlers.set(name, handler), removeHandler: (name: string) => fake.handlers.delete(name) },
  desktopCapturer: { getSources: vi.fn().mockResolvedValue([{ id: 'screen' }]) },
  session: { defaultSession: { setPermissionCheckHandler: (handler: any) => { fake.permission = handler },
    setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() } },
  BrowserWindow: class {
    destroyed = false
    frame = {}
    webContents = { mainFrame: this.frame, on: vi.fn(), setWindowOpenHandler: vi.fn(),
      send: vi.fn(() => queueMicrotask(() => fake.handlers.get(ipcChannels.captureFinished)?.(
        { senderFrame: this.frame }, { error: null, paddedSamples: 12 }))) }
    loadFile = vi.fn(async () => { await fake.handlers.get(ipcChannels.captureReady)!({ senderFrame: this.frame }) })
    loadURL = this.loadFile
    isDestroyed = () => this.destroyed
    destroy = () => { this.destroyed = true }
    constructor() { fake.windows.push(this) }
  }
}))

import { RecordingCapture } from './recording-capture'
let capture: RecordingCapture | undefined
afterEach(async () => {
  await capture?.abort()
  capture = undefined
  fake.handlers.clear(); fake.windows.length = 0; fake.changed = undefined
  vi.clearAllMocks(); vi.unstubAllEnvs()
})

describe('production capture coordinator', () => {
  it('keeps system audio after mic loss, finalizes the lost source, and supports an explicit replacement on the same timeline',async()=>{
    vi.stubEnv('ELECTRON_RENDERER_URL','')
    const frame=vi.fn(),failure=vi.fn(),notice=vi.fn(),sourceLost=vi.fn().mockResolvedValue(undefined)
    capture=new RecordingCapture(frame,vi.fn(),failure,{notice,sourceLost})
    await capture.start({title:'Devices',microphoneEnabled:true,systemAudioEnabled:true,microphoneDeviceId:'original'},100)
    await fake.handlers.get(ipcChannels.captureFinished)!({senderFrame:fake.windows[0].frame},{error:'mic audio track ended',paddedSamples:0})
    expect(sourceLost).toHaveBeenCalledExactlyOnceWith('mic',0)
    const system=new ArrayBuffer(3201);new Uint8Array(system)[0]=1
    fake.handlers.get(ipcChannels.captureFrame)!({senderFrame:fake.windows[1].frame},system,{sequence:0,startSample:16000,captureTimeMs:1100,captureErrorMs:1,sampleCount:1600,captureKind:'render-estimate'})
    expect(frame).toHaveBeenCalled();expect(failure).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledWith(expect.stringContaining('System audio continues'))
    fake.changed!();expect(notice).toHaveBeenCalledWith(expect.stringContaining('default output changed'));expect(failure).not.toHaveBeenCalled()
    expect(()=>capture!.selectMicrophone('replacement')).toThrow('Pause')
    await capture.stop();capture.selectMicrophone('replacement');await capture.resume()
    expect(fake.windows[2].loadFile.mock.calls[0][1].query.microphoneDeviceId).toBe('replacement')
    expect(fake.handlers.get(ipcChannels.captureClock)!({senderFrame:fake.windows[2].frame},0).sessionStartMs).toBe(100)
    expect(fake.windows.slice(0,2).every(window=>window.destroyed)).toBe(true)
    await capture.stop()
  })
  it('passes forward acquisition gaps to speech but rejects overlapping or skipped-sequence packets', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    const frame = vi.fn()
    capture = new RecordingCapture(frame, vi.fn(), vi.fn())
    await capture.start({ title: 'Meeting', microphoneEnabled: true, systemAudioEnabled: false, microphoneDeviceId: null }, 100)
    const sender = { senderFrame: fake.windows[0].frame }
    const deliver = (sequence: number, startSample: number) => fake.handlers.get(ipcChannels.captureFrame)!(
      sender, new ArrayBuffer(3201), { sequence, startSample, captureTimeMs: 100 + startSample / 16,
        captureErrorMs: 1, sampleCount: 1600, captureKind: 'render-estimate' })
    deliver(0, 0)
    deliver(1, 16000)
    deliver(2, 17600)
    expect(frame.mock.calls.map((call) => call[2].startSample)).toEqual([0, 16000, 17600])
    expect(() => deliver(3, 17600)).toThrow('continuity')
    expect(() => deliver(5, 20000)).toThrow('continuity')
    await capture.stop()
  })
  it('recreates microphone capture over repeated pauses with fresh sequences and the original session clock', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    const delivered = vi.fn()
    const failed = vi.fn()
    capture = new RecordingCapture(delivered, vi.fn(), failed)
    await capture.start({ title: 'Meeting', microphoneEnabled: true, systemAudioEnabled: false, microphoneDeviceId: null }, 100)
    for (let cycle = 0; cycle < 5; cycle++) {
      const sender = { senderFrame: fake.windows[cycle].frame }
      expect(fake.handlers.get(ipcChannels.captureClock)!(sender, 10).sessionStartMs).toBe(100)
      fake.handlers.get(ipcChannels.captureFrame)!(sender, new ArrayBuffer(3201), {
        sequence: 0, startSample: cycle * 32000, captureTimeMs: 100 + cycle * 2000,
        captureErrorMs: 1, sampleCount: 1600, captureKind: 'render-estimate'
      })
      await capture.stop()
      expect(fake.handlers.size).toBe(0)
      if (cycle < 4) {
        await capture.resume()
        expect(() => fake.handlers.get(ipcChannels.captureFrame)!(sender, new ArrayBuffer(3201))).toThrow('Untrusted')
      }
    }
    expect(delivered).toHaveBeenCalledTimes(5)
    expect(failed).not.toHaveBeenCalled()
    expect(fake.windows.every((window) => window.destroyed)).toBe(true)
  })
  it('binds measured PCM to its source, preserves the epoch across resume, and rejects old senders', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    vi.stubEnv('VINXA_MIC_GAIN', '0.75')
    const frame = vi.fn()
    capture = new RecordingCapture(frame, vi.fn(), vi.fn())
    expect(fake.windows).toHaveLength(0)
    await capture.start({ title: 'Meeting', microphoneEnabled: true, systemAudioEnabled: false, microphoneDeviceId: 'selected' })
    const sender = { senderFrame: fake.windows[0].frame }
    const epoch = fake.handlers.get(ipcChannels.captureClock)!(sender, 10).sessionStartMs
    expect(fake.windows[0].loadFile.mock.calls[0][1].query.microphoneDeviceId).toBe('selected')
    const mic = new ArrayBuffer(3201)
    const metadata = { sequence: 0, startSample: 0, captureTimeMs: 10, captureErrorMs: 1, sampleCount: 1600, captureKind: 'render-estimate' }
    fake.handlers.get(ipcChannels.captureFrame)!(sender, mic, metadata)
    expect(frame.mock.calls[0][1]).toHaveLength(3200)
    expect(() => fake.handlers.get(ipcChannels.captureFrame)!(sender, mic, metadata)).toThrow('continuity')
    const wrong = new ArrayBuffer(3201)
    new Uint8Array(wrong)[0] = 1
    expect(() => fake.handlers.get(ipcChannels.captureFrame)!(sender, wrong, { ...metadata, sequence: 1, startSample: 1600 })).toThrow('source')
    await capture.stop()
    expect(capture.finalPadding).toEqual({ mic: 12 })
    await capture.resume()
    const newSender = { senderFrame: fake.windows[1].frame }
    expect(fake.handlers.get(ipcChannels.captureClock)!(newSender, 10).sessionStartMs).toBe(epoch)
    expect(() => fake.handlers.get(ipcChannels.captureClock)!(sender, 10)).toThrow('Untrusted')
    await capture.stop()
    expect(fake.handlers.size).toBe(0)
    expect(fake.windows.every((window) => window.destroyed)).toBe(true)
  })

  it('denies unrelated renderers and surfaces Windows output changes', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    const failure = vi.fn()
    capture = new RecordingCapture(vi.fn(), vi.fn(), failure)
    await capture.start({ title: 'Meeting', microphoneEnabled: false, systemAudioEnabled: true, microphoneDeviceId: null })
    expect(fake.permission({}, 'display-capture', '', {})).toBe(false)
    expect(fake.permission(fake.windows[0].webContents, 'media', '', { mediaType: 'audio' })).toBe(false)
    fake.changed!()
    expect(failure).toHaveBeenCalledWith(expect.stringContaining('default output changed'))
    await capture.abort()
    expect(fake.monitorStop).toHaveBeenCalled()
  })
})
