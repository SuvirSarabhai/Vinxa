import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '../../shared/ipc-channels'

const fake = vi.hoisted(() => ({
  directory: '', handlers: new Map<string, any>(), windows: [] as any[],
  checkPermission: null as any, requestPermission: null as any, display: null as any,
  getSources: vi.fn().mockResolvedValue([{ id: 'screen:0:0', name: 'Screen' }]),
  dialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => fake.directory },
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
  vi.useRealTimers()
  if (fake.directory) await rm(fake.directory, { recursive: true, force: true })
  fake.windows.length = 0
  fake.handlers.clear()
  vi.clearAllMocks()
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
})
