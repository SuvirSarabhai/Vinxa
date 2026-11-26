import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import { join } from 'node:path'
import { FixturePlayer } from './fixture-player'
import { ipcChannels } from '../shared/ipc-channels'
import { fixtureCommandSchema } from '../shared/schemas'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let isQuitting = false
let fixturePlayer: FixturePlayer | undefined

function openLibrary(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', openLibrary)
  app.on('before-quit', () => {
    isQuitting = true
    fixturePlayer?.stop()
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
    app.on('activate', openLibrary)
  }).catch((error: unknown) => {
    console.error('Vinxa startup failed', error)
    app.exit(1)
  })
}

