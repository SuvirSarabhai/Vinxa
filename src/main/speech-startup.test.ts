import { afterEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined), handlers: new Map<string, any>(), quit: vi.fn() }))
vi.mock('./speech-service', () => ({ initializeAppSpeech: fake.initialize,
  getAppSpeech: () => ({ shutdown: fake.shutdown }) }))
vi.mock('./audio/capture-test', () => ({ startCaptureTest: vi.fn() }))
vi.mock('./fixture-player', () => ({ FixturePlayer: class { stop() {} } }))
vi.mock('electron', () => ({
  app: { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getAppPath: () => 'D:/test', quit: fake.quit,
    on: (name: string, callback: any) => fake.handlers.set(name, callback) },
  ipcMain: { handle: vi.fn() }, Menu: { buildFromTemplate: vi.fn() },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  BrowserWindow: class { webContents = { setWindowOpenHandler() {}, on() {} }
    once() {} on() {} loadFile() {} loadURL() {} }
}))
afterEach(() => vi.unstubAllEnvs())

it('starts speech initialization at normal app launch and awaits speech shutdown on quit', async () => {
  vi.stubEnv('VINXA_CAPTURE_TEST', '')
  await import('./index')
  await vi.waitFor(() => expect(fake.initialize).toHaveBeenCalledOnce())
  const event = { preventDefault: vi.fn() }
  fake.handlers.get('before-quit')(event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(fake.shutdown).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(fake.quit).toHaveBeenCalledOnce())
})
