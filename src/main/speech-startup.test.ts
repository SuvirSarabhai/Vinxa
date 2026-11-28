import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined), handlers: new Map<string, any>(), quit: vi.fn(),
  disposePhase2: vi.fn(), installPhase2: vi.fn(), unhook: vi.fn(), intercept:vi.fn(),
  capture: vi.fn(), captureStop: vi.fn().mockResolvedValue(undefined), exit: vi.fn() }))
vi.mock('./speech-service', () => ({ initializeAppSpeech: fake.initialize,
  getAppSpeech: () => ({ shutdown: fake.shutdown }) }))
vi.mock('./db/repository', () => ({ MeetingStore: class { setting() { return '{"speechModel":"small"}' } } }))
vi.mock('./phase2', () => ({ installPhase2: fake.installPhase2 }))
vi.mock('./audio/capture-test', () => ({ startCaptureTest: fake.capture }))
vi.mock('./fixture-player', () => ({ FixturePlayer: class { stop() {} } }))
vi.mock('electron', () => ({
  session:{defaultSession:{webRequest:{onBeforeRequest:fake.intercept}}},
  app: { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getAppPath: () => 'D:/test', getPath: () => 'D:/test', quit: fake.quit, exit: fake.exit,
    on: (name: string, callback: any) => fake.handlers.set(name, callback) },
  ipcMain: { handle: vi.fn() }, Menu: { buildFromTemplate: vi.fn() },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  BrowserWindow: class { webContents = { setWindowOpenHandler() {}, on() {} }
    once() {} on() {} loadFile() {} loadURL() {} hookWindowMessage() {}
    isDestroyed() { return false }
    unhookWindowMessage = fake.unhook }
}))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fake.handlers.clear()
  fake.shutdown.mockResolvedValue(undefined)
  fake.captureStop.mockResolvedValue(undefined)
  fake.capture.mockResolvedValue({ stop: fake.captureStop })
  fake.installPhase2.mockReturnValue(fake.disposePhase2)
  vi.stubEnv('VINXA_CAPTURE_TEST', '')
  vi.stubEnv('VINXA_BACKEND', 'local')
  vi.stubEnv('VINXA_CAPTURE_SPEECH', '')
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('initializes speech and controls, cleans up UI once, and awaits speech shutdown before quitting', async () => {
  let finishShutdown!: () => void
  fake.shutdown.mockReturnValue(new Promise<void>((resolve) => { finishShutdown = resolve }))
  await import('./index')
  await vi.waitFor(() => expect(fake.initialize).toHaveBeenCalledOnce())
  expect(fake.installPhase2).toHaveBeenCalledOnce()
  expect(fake.initialize).toHaveBeenCalledWith(expect.anything(), 'small')
  expect(fake.intercept).toHaveBeenCalledOnce()
  const callback=vi.fn()
  fake.intercept.mock.calls[0][1]({url:'https://example.test'},callback)
  expect(callback).toHaveBeenCalledWith({cancel:true})
  expect(fake.exit).not.toHaveBeenCalled()
  const event = { preventDefault: vi.fn() }
  fake.handlers.get('before-quit')(event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(fake.disposePhase2).toHaveBeenCalledOnce()
  if (process.platform === 'win32') expect(fake.unhook).toHaveBeenCalledTimes(3)
  await vi.waitFor(() => expect(fake.shutdown).toHaveBeenCalledOnce())
  expect(fake.quit).not.toHaveBeenCalled()
  fake.handlers.get('before-quit')({ preventDefault: vi.fn() })
  expect(fake.disposePhase2).toHaveBeenCalledOnce()
  expect(fake.shutdown).toHaveBeenCalledOnce()
  finishShutdown()
  await vi.waitFor(() => expect(fake.quit).toHaveBeenCalledOnce())
})

it('shuts down speech even if diagnostic capture cleanup fails', async () => {
  vi.stubEnv('VINXA_CAPTURE_TEST', 'both')
  fake.captureStop.mockRejectedValue(new Error('Capture cleanup failed'))
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  await import('./index')
  await vi.waitFor(() => expect(fake.capture).toHaveBeenCalledOnce())
  expect(fake.installPhase2).not.toHaveBeenCalled()
  fake.handlers.get('before-quit')({ preventDefault: vi.fn() })
  await vi.waitFor(() => expect(fake.quit).toHaveBeenCalledOnce())
  expect(fake.captureStop).toHaveBeenCalledOnce()
  expect(fake.shutdown).toHaveBeenCalledOnce()
  expect(logged).toHaveBeenCalledWith('Local speech shutdown did not finish normally')
})

it('awaits UI capture disposal before shutting down the speech process', async () => {
  let finishCapture!: () => void
  fake.disposePhase2.mockReturnValueOnce(new Promise<void>((resolve) => { finishCapture = resolve }))
  await import('./index')
  await vi.waitFor(() => expect(fake.installPhase2).toHaveBeenCalledOnce())
  fake.handlers.get('before-quit')({ preventDefault: vi.fn() })
  await Promise.resolve()
  expect(fake.shutdown).not.toHaveBeenCalled()
  finishCapture()
  await vi.waitFor(() => expect(fake.shutdown).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(fake.quit).toHaveBeenCalledOnce())
})

it('keeps the explicitly selected demo independent of Python warm-up', async () => {
  vi.stubEnv('VINXA_BACKEND', 'demo')
  await import('./index')
  await vi.waitFor(() => expect(fake.installPhase2).toHaveBeenCalledOnce())
  expect(fake.initialize).not.toHaveBeenCalled()
})
