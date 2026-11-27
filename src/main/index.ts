import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import { join } from 'node:path'
import { FixturePlayer } from './fixture-player'
import { installPhase2 } from './phase2'
import { ipcChannels } from '../shared/ipc-channels'
import { fixtureCommandSchema } from '../shared/schemas'
import { startCaptureTest } from './audio/capture-test'
import type { CaptureTestMode } from './audio/capture-test'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let isQuitting = false
let hideRequested = false
let fixturePlayer: FixturePlayer | undefined
let captureTest: Awaited<ReturnType<typeof startCaptureTest>>
let removeNativeCloseHooks: (() => void) | undefined
let disposePhase2: (() => void) | undefined
const requestedCaptureMode = process.env.VINXA_CAPTURE_TEST
const captureMode: CaptureTestMode | undefined = requestedCaptureMode === 'mic' || requestedCaptureMode === 'system' || requestedCaptureMode === 'both'
  ? requestedCaptureMode : undefined

function openLibrary(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  hideRequested = false
  mainWindow.setSkipTaskbar(false)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideLibrary(): void {
  if (isQuitting || hideRequested) return
  hideRequested = true
  const window = mainWindow
  setImmediate(() => {
    if (!hideRequested || isQuitting || !window || window.isDestroyed()) return
    window.hide()
    window.setSkipTaskbar(true)
  })
}

function createTray(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray.ico')
    : join(app.getAppPath(), 'resources', 'tray.ico')
  tray = new Tray(iconPath)
  tray.setToolTip('Vinxa Desktop — Idle')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Start', enabled: false },
    { label: 'Pause', enabled: false },
    { label: 'Stop', enabled: false },
    { type: 'separator' },
    { label: 'Open Library', click: openLibrary },
    { label: 'Quit', click: () => app.quit() }
  ]))
  tray.on('double-click', openLibrary)
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    closable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!hideRequested && !isQuitting) mainWindow?.show()
  })
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideLibrary()
  })
  if (process.platform === 'win32') {
    const WM_CLOSE = 0x0010
    const WM_SYSCOMMAND = 0x0112
    const WM_NCLBUTTONUP = 0x00a2
    const SC_CLOSE = 0xf060
    const HTCLOSE = 20
    mainWindow.hookWindowMessage(WM_CLOSE, hideLibrary)
    mainWindow.hookWindowMessage(WM_SYSCOMMAND, (command) => {
      if ((command.readUInt32LE(0) & 0xfff0) === SC_CLOSE) hideLibrary()
    })
    mainWindow.hookWindowMessage(WM_NCLBUTTONUP, (hitTest) => {
      if (hitTest.readUInt32LE(0) === HTCLOSE) hideLibrary()
    })
    const window = mainWindow
    removeNativeCloseHooks = () => {
      if (window.isDestroyed()) return
      for (const message of [WM_CLOSE, WM_SYSCOMMAND, WM_NCLBUTTONUP]) {
        window.unhookWindowMessage(message)
      }
    }
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (captureMode) url.hash = 'capture-test'
    void mainWindow.loadURL(url.toString())
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), captureMode ? { hash: 'capture-test' } : undefined)
  }
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', openLibrary)
  app.on('before-quit', (event) => {
    if (isQuitting) return
    isQuitting = true
    disposePhase2?.()
    removeNativeCloseHooks?.()
    fixturePlayer?.stop()
    if (captureTest) {
      event.preventDefault()
      void captureTest.stop().finally(() => app.quit())
    }
  })
  app.whenReady().then(() => {
    createTray()
    createMainWindow()
    fixturePlayer = new FixturePlayer(
      (segment) => mainWindow?.webContents.send(ipcChannels.transcriptSegment, segment),
      (status) => mainWindow?.webContents.send(ipcChannels.fixtureStatus, status)
    )
    ipcMain.handle(ipcChannels.fixtureCommand, (event, payload: unknown) => {
      if (event.senderFrame !== mainWindow?.webContents.mainFrame) throw new Error('Untrusted sender')
      const command = fixtureCommandSchema.parse(payload)
      if (command === 'play') fixturePlayer?.play()
      else if (command === 'pause') fixturePlayer?.pause()
      else fixturePlayer?.stop()
    })
    mainWindow?.webContents.on('did-start-loading', () => fixturePlayer?.stop())
    app.on('activate', () => {
      if (!hideRequested) openLibrary()
    })
    if (!mainWindow || !tray) throw new Error('Desktop shell was not initialized')
    if (captureMode) {
      tray.setToolTip('Vinxa — Audio diagnostic mode')
      void startCaptureTest(mainWindow, captureMode).then((test) => { captureTest = test }).catch(() => {
        console.error('Audio diagnostic could not start; check output file and disk space')
      })
    } else {
      disposePhase2 = installPhase2(mainWindow, tray, openLibrary)
    }
  }).catch((error: unknown) => {
    console.error('Vinxa startup failed', error)
    app.exit(1)
  })
}

