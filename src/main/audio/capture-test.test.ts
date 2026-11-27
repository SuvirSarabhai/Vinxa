import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '../../shared/ipc-channels'

const fake = vi.hoisted(() => ({
  packaged: false, speechService: undefined as any,
  outputChanged: undefined as (() => void) | undefined,
  outputFailed: undefined as ((message: string) => void) | undefined,
  stopMonitor: vi.fn().mockResolvedValue(undefined),
  directory: '', handlers: new Map<string, any>(), windows: [] as any[],
  checkPermission: null as any, requestPermission: null as any, display: null as any,
  getSources: vi.fn().mockResolvedValue([{ id: 'screen:0:0', name: 'Screen' }]),
  dialog: vi.fn()
}))

vi.mock('../speech-service', () => ({ getAppSpeech: () => fake.speechService }))

vi.mock('./windows-output-monitor', () => ({
  watchWindowsDefaultOutput: vi.fn(async (_path: string, changed: () => void, failed: (message: string) => void) => {
    fake.outputChanged = changed
    fake.outputFailed = failed
    return { stop: fake.stopMonitor }
  })
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => fake.directory, getPath: () => join(fake.directory, 'user-data'), get isPackaged() { return fake.packaged } },
  ipcMain: { handle: (name: string, handler: any) => fake.handlers.set(name, handler), removeHandler: (name: string) => fake.handlers.delete(name) },
  desktopCapturer: { getSources: fake.getSources },
  dialog: { showMessageBox: fake.dialog },
  session: { fromPartition: () => ({
    setPermissionCheckHandler: (handler: any) => { fake.checkPermission = handler },
    setPermissionRequestHandler: (handler: any) => { fake.requestPermission = handler },
    setDisplayMediaRequestHandler: (handler: any) => { fake.display = handler }
  }) },
  BrowserWindow: class {
    destroyed = false
    source = ''
    webContents = { mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
    loadFile = vi.fn().mockImplementation(async (_file, options) => { this.source = options.query.source })
    loadURL = vi.fn()
    isDestroyed = () => this.destroyed
    destroy = () => { this.destroyed = true }
    constructor() { fake.windows.push(this) }
  }
}))

afterEach(async () => {
  fake.packaged = false
  fake.speechService = undefined
  fake.outputChanged = undefined
  fake.outputFailed = undefined
  vi.useRealTimers()
  if (fake.directory) await rm(fake.directory, { recursive: true, force: true })
  fake.windows.length = 0
  fake.handlers.clear()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function start(mode: 'mic' | 'system' | 'both') {
  fake.directory = await mkdtemp(join(tmpdir(), 'vinxa-capture-'))
  fake.dialog.mockImplementation((_owner, options) => options.title === 'Audio capture test'
    ? Promise.resolve({ response: 1 }) : options.title === 'Audio recording'
      ? new Promise(() => {}) : Promise.resolve({ response: 0 }))
  const owner = { isDestroyed: () => false }
  const { startCaptureTest } = await import('./capture-test')
  const test = await startCaptureTest(owner as any, mode)
  return { test: test!, owner }
}

async function finishAll() {
  const finished = fake.handlers.get(ipcChannels.captureFinished)
  for (const window of fake.windows) finished({ senderFrame: window.webContents.mainFrame }, { error: null, paddedSamples: 0 })
}

describe('capture coordinator source isolation', () => {
  it('routes an explicitly enabled speech diagnostic through consent, timing, finalization and the warmed bridge', async () => {
    vi.stubEnv('VINXA_CAPTURE_SPEECH', '1')
    const bridge = { active: false, start: vi.fn(async () => { bridge.active = true }),
      taggedFrame: vi.fn().mockReturnValue(true), sourceEnd: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(async () => { bridge.active = false }) }
    fake.speechService = { selectedModel: 'base.en', selectedLanguage: 'en',
      createBridge: vi.fn().mockReturnValue(bridge) }
    const { test } = await start('mic')
    const recordingOwner = fake.speechService.createBridge.mock.calls[0][0]
    expect(recordingOwner.getState()).toBe('recording')
    const window = fake.windows[0]
    const metadata = { startSample: 0, sequence: 0, captureTimeMs: 100, captureErrorMs: 1,
      sampleCount: 1600, captureKind: 'render-estimate' }
    const packet = new ArrayBuffer(3201)
    await fake.handlers.get(ipcChannels.captureFrame)({ senderFrame: window.webContents.mainFrame }, packet, metadata)
    expect(bridge.taggedFrame).toHaveBeenCalledWith(expect.any(String), packet, metadata)
    await finishAll()
    await test.stop()
    expect(bridge.sourceEnd).toHaveBeenCalledWith(expect.any(String), 'mic', 0)
    expect(bridge.stop).toHaveBeenCalledOnce()
    expect(recordingOwner.getState()).toBe('stopping')
  })

  it('stops both sources on a native default-output change without a browser devicechange event', async () => {
    const { test } = await start('both')
    expect(fake.outputChanged).toBeTypeOf('function')
    fake.outputChanged!()
    for (const window of fake.windows) expect(window.webContents.send).toHaveBeenCalledWith(ipcChannels.captureStop)
    await finishAll()
    await test.stop()
    expect(fake.stopMonitor).toHaveBeenCalled()
    expect(fake.dialog).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      type: 'error', message: expect.stringContaining('Windows default audio output changed')
    }))
    expect(fake.windows.every((window) => window.destroyed)).toBe(true)
  })

  it('stops capture instead of silently losing output-change monitoring', async () => {
    const { test } = await start('system')
    fake.outputFailed!('Windows output monitor exited unexpectedly; capture must be restarted')
    await finishAll()
    await test.stop()
    expect(fake.dialog).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      type: 'error', message: expect.stringContaining('monitor exited unexpectedly')
    }))
  })

  it('does not load capture pages when native monitoring cannot start', async () => {
    const { watchWindowsDefaultOutput } = await import('./windows-output-monitor')
    vi.mocked(watchWindowsDefaultOutput).mockRejectedValueOnce(new Error('missing resource'))
    const { test } = await start('system')
    await test.stop()
    expect(fake.windows[0].loadFile).not.toHaveBeenCalled()
    expect(fake.windows[0].destroyed).toBe(true)
    expect(fake.dialog).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      type: 'error', message: expect.stringContaining('monitoring could not start')
    }))
  })

  it('does not require a system-output monitor for a microphone-only test', async () => {
    const { test } = await start('mic')
    expect(fake.outputChanged).toBeUndefined()
    await finishAll()
    await test.stop()
  })

  it('passes microphone gain separately while system gain remains unity', async () => {
    vi.stubEnv('VINXA_MIC_GAIN', '0.5')
    const { test } = await start('both')
    expect(fake.windows[0].loadFile.mock.calls[0][1].query).toEqual({ source: 'mic', micGain: '0.5' })
    expect(fake.windows[1].loadFile.mock.calls[0][1].query).toEqual({ source: 'system', micGain: '1' })
    await finishAll()
    await test.stop()
  })

  it('rejects invalid microphone gain without opening files or capture windows', async () => {
    vi.stubEnv('VINXA_MIC_GAIN', '2')
    const { test } = await start('mic')
    expect(test).toBeUndefined()
    expect(fake.windows).toHaveLength(0)
    expect(fake.dialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'Invalid microphone gain' }))
  })

  it('stores packaged diagnostic WAVs under writable user data instead of the ASAR app path', async () => {
    fake.packaged = true
    const { test } = await start('mic')
    await finishAll()
    await test.stop()
    expect((await readFile(join(fake.directory, 'user-data/test_recordings/mic.wav'))).length).toBe(44)
  })

  it('uses acceptance filenames and preserves an existing recording in a configured directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vinxa-acceptance-'))
    vi.stubEnv('VINXA_CAPTURE_DIR', directory)
    vi.stubEnv('VINXA_CAPTURE_ACCEPTANCE', '1')
    try {
      const { test } = await start('both')
      await finishAll()
      await test.stop()
      const mic = await readFile(join(directory, 'microphone.wav'))
      const system = await readFile(join(directory, 'system_audio.wav'))
      expect(mic.length).toBe(44)
      expect(system.length).toBe(44)
      const { startCaptureTest } = await import('./capture-test')
      const again = await startCaptureTest({ isDestroyed: () => false } as any, 'both')
      expect(again).toBeUndefined()
      expect(await readFile(join(directory, 'microphone.wav'))).toEqual(mic)
      expect(await readFile(join(directory, 'system_audio.wav'))).toEqual(system)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('grants loopback only to its system renderer and denies untrusted requests', async () => {
    const { test } = await start('system')
    const system = fake.windows[0]
    expect(fake.checkPermission(system.webContents, 'display-capture', '', {})).toBe(true)
    expect(fake.checkPermission(system.webContents, 'media', '', { mediaType: 'audio' })).toBe(false)
    expect(fake.checkPermission({}, 'display-capture', '', {})).toBe(false)
    const denied = vi.fn()
    fake.display({ frame: {}, videoRequested: true, audioRequested: true }, denied)
    expect(denied).toHaveBeenCalledWith(null)
    const granted = vi.fn()
    fake.display({ frame: system.webContents.mainFrame, videoRequested: true, audioRequested: true }, granted)
    await vi.waitFor(() => expect(granted).toHaveBeenCalledWith({ video: { id: 'screen:0:0', name: 'Screen' }, audio: 'loopback' }))
    await finishAll()
    await test.stop()
    expect(system.destroyed).toBe(true)
    expect(fake.display).toBeNull()
  })

  it('routes both source tags into independent WAVs and stops both windows', async () => {
    const { test } = await start('both')
    const write = fake.handlers.get(ipcChannels.captureFrame)
    for (const [id, window] of fake.windows.entries()) {
      const frame = new ArrayBuffer(3201)
      new Uint8Array(frame)[0] = id
      new DataView(frame).setInt16(1, id === 0 ? 100 : 200, true)
      await write({ senderFrame: window.webContents.mainFrame }, frame)
    }
    const stopping = test.stop()
    for (const window of fake.windows) expect(window.webContents.send).toHaveBeenCalledWith(ipcChannels.captureStop)
    await finishAll()
    await stopping
    const mic = await readFile(join(fake.directory, 'test_recordings/mic.wav'))
    const system = await readFile(join(fake.directory, 'test_recordings/system.wav'))
    expect(mic.readInt16LE(44)).toBe(100)
    expect(system.readInt16LE(44)).toBe(200)
    expect(mic.readUInt32LE(40)).toBe(3200)
    expect(system.readUInt32LE(40)).toBe(3200)
    expect(fake.windows.every((window) => window.destroyed)).toBe(true)
  })

  it('stops the other source when loopback reports a missing audio track', async () => {
    const { test } = await start('both')
    const [mic, system] = fake.windows
    const finished = fake.handlers.get(ipcChannels.captureFinished)
    finished({ senderFrame: system.webContents.mainFrame }, { error: 'System capture returned no audio track', paddedSamples: 0 })
    expect(mic.webContents.send).toHaveBeenCalledWith(ipcChannels.captureStop)
    finished({ senderFrame: mic.webContents.mainFrame }, { error: null, paddedSamples: 0 })
    await test.stop()
    expect(fake.dialog).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'error', message: 'System capture returned no audio track' }))
  })

  it('validates optional timing in main without changing the Phase 1 PCM layout', async () => {
    const { test } = await start('mic')
    const window = fake.windows[0]
    const write = fake.handlers.get(ipcChannels.captureFrame)
    const frame = new ArrayBuffer(3201)
    await expect(write({ senderFrame: window.webContents.mainFrame }, frame, { startSample: -1 })).rejects.toThrow()
    await write({ senderFrame: window.webContents.mainFrame }, frame, { startSample: 1600 })
    await finishAll()
    await test.stop()
    const mic = await readFile(join(fake.directory, 'test_recordings/mic.wav'))
    expect(mic.readUInt32LE(40)).toBe(3200)
  })

  it('finalizes capture with a clear error if its page reloads during startup', async () => {
    const { test } = await start('system')
    const window = fake.windows[0]
    const navigate = window.webContents.on.mock.calls.find(([name]: [string]) => name === 'did-start-navigation')[1]
    navigate({}, 'file:///capture/index.html?source=system', false, true)
    navigate({}, 'file:///capture/index.html?source=system', false, true)
    await test.stop()
    expect(window.destroyed).toBe(true)
    expect(fake.dialog).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      type: 'error', message: 'Audio capture page reloaded during startup or recording; rebuild and retry'
    }))
  })

  it('writes diagnostics to a file even when the launch terminal pipe is broken', async () => {
    vi.stubEnv('VINXA_CAPTURE_DEBUG', '1')
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('EPIPE: broken pipe, write') })
    const { test } = await start('system')
    const system = fake.windows[0]
    expect(() => fake.checkPermission(system.webContents, 'display-capture', '', {})).not.toThrow()
    await finishAll()
    await test.stop()
    const diagnostics = await readFile(join(fake.directory, 'test_recordings/capture-debug.log'), 'utf8')
    expect(diagnostics).toContain('permission-check system display-capture')
    expect(consoleInfo).not.toHaveBeenCalled()
  })
})
