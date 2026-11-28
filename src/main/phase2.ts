import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, screen } from 'electron'
import type { Tray } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  announcement, defaultHotkeys, demoAnnouncement, hotkeysSchema,
  overlayDragSchema, phase2Channels, phase2CommandSchema
} from '../shared/phase2'
import type { Hotkeys, Phase2Command, Phase2Snapshot, RecordingBackend, RecordingEngine } from '../shared/phase2'
import { SessionController } from './session-controller'
import { ShortcutBindings } from './hotkeys'
import { createDemoBackend } from './demo-backend'
import { createSpeechBackend } from './speech-backend'
import type { MeetingStore } from './db/repository'
import { saveConsent } from './consent-log'
import { installMeetings } from './meetings'

function statusIcon(red: number, green: number, blue: number): Electron.NativeImage {
  const size = 16
  const bitmap = Buffer.alloc(size * size * 4)
  for (let vertical = 0; vertical < size; vertical += 1) {
    for (let horizontal = 0; horizontal < size; horizontal += 1) {
      if (Math.hypot(horizontal - 7.5, vertical - 7.5) > 6.5) continue
      const offset = (vertical * size + horizontal) * 4
      bitmap.set([blue, green, red, 255], offset)
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

export function installPhase2(
  library: BrowserWindow,
  tray: Tray,
  openLibrary: () => void,
  store?: MeetingStore,
  backend: RecordingBackend = process.env.VINXA_BACKEND === 'demo' ? createDemoBackend() : createSpeechBackend(library)
): () => Promise<void> {
  let overlay: BrowserWindow | undefined
  let setup: BrowserWindow | undefined
  let disposed = false
  let ready = false
  let revision = 0
  let pendingPublish: ReturnType<typeof setImmediate> | undefined
  let nativeStatus = ''
  let menuStatus = ''
  let lastSessionState = 'idle'
  const windowStatus = new WeakMap<BrowserWindow, string>()
  let expandedHeight = 500
  let collapsed = false
  let opacity = 0.95
  let hotkeys: Hotkeys = { ...defaultHotkeys }
  let hotkeyErrors: string[] = []
  let commandError: string | null = null
  let settingsBusy = false
  let engine: RecordingEngine = { ready: backend.mode === 'demo', message: backend.mode === 'demo'
    ? 'Written sample transcript. No audio is captured.' : 'Loading local speech…' }
  let overlayWanted = false
  let overlayLoaded = false
  let dragOrigin: { cursorX: number; cursorY: number; windowX: number; windowY: number } | undefined
  const userData = app.getPath('userData')
  const settingsFile = join(userData, 'phase2-hotkeys.json')
  const idleIcon = nativeImage.createFromPath(app.isPackaged
    ? join(process.resourcesPath, 'tray.ico')
    : join(app.getAppPath(), 'resources', 'tray.ico'))
  const redIcon = statusIcon(239, 68, 68)
  const amberIcon = statusIcon(245, 158, 11)
  const meetings = store ? installMeetings(library, backend, store, id => controller.forgetDeletedMeeting(id)) : undefined
  const controller: SessionController = new SessionController(meetings?.backend ?? backend, record => saveConsent(userData, record))
  const shortcuts = new ShortcutBindings(globalShortcut, (action) => {
    const commands: Record<keyof Hotkeys, Phase2Command> = {
      start: { type: 'start' }, pause: { type: 'pause-resume' }, stop: { type: 'stop' }
    }
    run(commands[action])
  })

  function windows(): BrowserWindow[] {
    return [library, overlay, setup].filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()))
  }

  function snapshot(): Phase2Snapshot {
    const session = controller.snapshot()
    return {
      ...session, error: session.error ?? commandError, busy: session.busy || settingsBusy,
      revision, ready, hotkeys: { ...hotkeys }, activeHotkeys: shortcuts.active(),
      hotkeyErrors: [...hotkeyErrors], collapsed, opacity, engine
    }
  }

  function publish(): void {
    if (disposed || pendingPublish) return
    // PCM acknowledgements must not wait for native menu/icon updates or a
    // structured clone of the transcript. Coalesce changes in the next turn.
    pendingPublish = setImmediate(() => { pendingPublish = undefined; publishNow() })
  }

  function publishNow(): void {
    if (disposed) return
    revision += 1
    const value = snapshot()
    const active = value.state === 'recording' || value.state === 'paused'
    const capturing = value.state === 'recording' || value.state === 'stopping'
    const badge = value.state === 'paused' ? amberIcon : capturing ? redIcon : null
    const status = `${value.mode}: ${value.state}`
    if (nativeStatus !== status) {
      nativeStatus = status
      tray.setImage(badge ?? idleIcon)
      tray.setToolTip(`Vinxa ${value.mode === 'demo' ? 'Demo ' : ''}— ${value.state}`)
    }
    for (const window of windows()) {
      if (windowStatus.get(window) !== status) {
        windowStatus.set(window, status)
        window.setOverlayIcon(badge, status)
      }
      if (!window.webContents.isDestroyed()) window.webContents.send(phase2Channels.changed, value)
    }
    const nextMenuStatus = JSON.stringify([ready, engine.ready, value.busy, value.state])
    if (menuStatus === nextMenuStatus) return
    menuStatus = nextMenuStatus
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Start', enabled: ready && engine.ready && !value.busy && ['idle', 'completed', 'error'].includes(value.state), click: () => run({ type: 'start' }) },
      { label: value.state === 'paused' ? 'Resume' : 'Pause', enabled: active && !value.busy, click: () => run({ type: 'pause-resume' }) },
      { label: 'Stop', enabled: ready && (active || value.state === 'awaiting-consent'), click: () => run({ type: 'stop' }) },
      { type: 'separator' },
      { label: 'Show Overlay', enabled: ready, click: () => run({ type: 'show-overlay' }) },
      { label: 'Open Library / Settings', click: openLibrary },
      { label: 'Quit', click: () => app.quit() }
    ]))
  }

  function createWindow(route: string, options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    const window = new BrowserWindow({
      show: false, backgroundColor: '#F5F5F0', ...options,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '../preload/index.js') }
    })
    window.on('page-title-updated', (event) => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    const loading = process.env.ELECTRON_RENDERER_URL
      ? window.loadURL((() => {
          const url = new URL(process.env.ELECTRON_RENDERER_URL)
          url.hash = route
          return url.toString()
        })())
      : window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
    void loading.catch(() => {
      if (disposed) return
      commandError = `The ${route} window could not load. Restart Vinxa.`
      publish()
    })
    return window
  }

  function overlaySize(): void {
    if (!overlay || overlay.isDestroyed()) return
    if (overlay.isFullScreen()) { overlay.setFullScreen(false); return }
    if (overlay.isMaximized()) overlay.unmaximize()
    const content = overlay.getContentBounds()
    // Minimum size uses window coordinates; setContentSize requests the usable
    // client area. Do not add a measured title-bar delta to the minimum: Windows
    // converts native constraints separately, which can prevent shrinking.
    overlay.setMinimumSize(440, collapsed ? 130 : 360)
    overlay.setContentSize(Math.max(440, content.width), collapsed ? 130 : expandedHeight)
  }

  function rememberExpandedHeight(): void {
    if (!overlay || overlay.isDestroyed()) return
    const bounds = overlay.getBounds()
    const content = overlay.getContentBounds()
    expandedHeight = Math.max(360, overlay.getNormalBounds().height - (bounds.height - content.height))
  }

  function showOverlay(): void {
    overlayWanted = true
    if (overlay && !overlay.isDestroyed()) {
      if (overlayLoaded) {
        if (overlay.isMinimized()) overlay.restore()
        overlay.show()
      }
      return
    }
    overlayLoaded = false
    overlay = createWindow('overlay', {
      title: 'Vinxa Transcript', width: 600, height: collapsed ? 130 : expandedHeight, useContentSize: true,
      minWidth: 440, minHeight: collapsed ? 130 : 360,
      frame: true, titleBarStyle: 'default', autoHideMenuBar: true, icon: idleIcon,
      alwaysOnTop: true, resizable: true, minimizable: true, maximizable: true, closable: true, fullscreenable: true
    })
    overlay.setOpacity(opacity)
    overlay.once('ready-to-show', () => {
      overlayLoaded = true
      if (!disposed && overlayWanted) {
        overlaySize()
        overlay?.show()
        publish()
      }
    })
    overlay.on('close', (event) => {
      if (disposed) return
      event.preventDefault()
      overlayWanted = false
      overlay?.hide()
    })
    overlay.on('maximize', () => {
      if (collapsed) {
        collapsed = false
        publish()
      }
    })
    overlay.on('unmaximize', () => {
      setImmediate(() => {
        if (overlay && !overlay.isDestroyed() && !collapsed && overlay.getContentBounds().height < 360) overlaySize()
      })
    })
    overlay.on('leave-full-screen', overlaySize)
    overlay.on('minimize', () => { dragOrigin = undefined })
    overlay.on('hide', () => { dragOrigin = undefined })
    overlay.on('closed', () => { overlay = undefined; overlayLoaded = false; dragOrigin = undefined })
  }

  function showSetup(): void {
    if (setup && !setup.isDestroyed()) { setup.show(); setup.focus(); return }
    setup = createWindow('setup', {
      title: 'Vinxa — Setup and Consent', width: 580, height: 800,
      minWidth: 500, minHeight: 600, alwaysOnTop: true
    })
    setup.once('ready-to-show', () => {
      if (!disposed && controller.snapshot().state === 'awaiting-consent') { setup?.show(); setup?.focus() }
    })
    setup.on('closed', () => { setup = undefined; controller.cancel() })
  }

  async function saveHotkeys(value: Hotkeys): Promise<void> {
    if (settingsBusy) throw new Error('Hotkey settings are already being saved.')
    settingsBusy = true
    const previous = hotkeys
    const hadPrevious = shortcuts.active().length > 0
    const temporary = join(userData, `phase2-hotkeys-${randomUUID()}.tmp`)
    try {
      shortcuts.apply(value)
      await mkdir(userData, { recursive: true })
      await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
      await rename(temporary, settingsFile)
      hotkeys = { ...value }
      hotkeyErrors = []
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if (hadPrevious) {
        try { shortcuts.apply(previous) } catch {
          hotkeys = shortcuts.bindings() ?? previous
          hotkeyErrors.push('Previous shortcuts could not all be restored. Use the tray menu.')
        }
      } else shortcuts.dispose()
      const message = error instanceof Error ? error.message : 'Hotkeys could not be saved.'
      hotkeyErrors = [...new Set([...hotkeyErrors, message])]
      throw new Error(message)
    } finally {
      settingsBusy = false
      publish()
    }
  }

  async function execute(command: Phase2Command): Promise<void> {
    if (disposed) return
    if (!ready) throw new Error('Settings are loading. Try again in a moment.')
    commandError = null
    try {
      switch (command.type) {
        case 'start':
          if (!engine.ready) throw new Error(engine.message)
          if (controller.requestStart()) showSetup()
          else if (['recording', 'paused'].includes(controller.snapshot().state)) showOverlay()
          break
        case 'confirm':
          if (!engine.ready) throw new Error(engine.message)
          await controller.confirm(command.config, command.consent)
          if (disposed) return
          if (['recording', 'paused'].includes(controller.snapshot().state)) { setup?.close(); showOverlay() }
          break
        case 'cancel': controller.cancel(); setup?.close(); break
        case 'pause-resume': await controller.pauseResume(); break
        case 'select-microphone': await controller.selectMicrophone(command.deviceId); break
        case 'stop':
          await controller.stop()
          if (controller.snapshot().state === 'idle') setup?.close()
          break
        case 'show-overlay': showOverlay(); break
        case 'open-library': openLibrary(); break
        case 'collapse':
          if (!collapsed) rememberExpandedHeight()
          collapsed = !collapsed
          showOverlay()
          overlaySize()
          break
        case 'opacity': opacity = command.value; overlay?.setOpacity(opacity); break
        case 'copy-lines':
          clipboard.writeText(controller.snapshot().segments.filter((segment) => segment.isFinal).slice(-10)
            .map((segment) => `${segment.source === 'mic' ? 'You' : 'Remote'}: ${segment.text}`).join('\n'))
          break
        case 'copy-announcement':
          clipboard.writeText(backend.mode === 'demo' ? demoAnnouncement : announcement)
          controller.markAnnouncementCopied()
          break
        case 'hotkeys': await saveHotkeys(command.value); break
      }
    } catch (error) {
      commandError = error instanceof Error ? error.message : 'The operation could not be completed.'
      throw error
    } finally { publish() }
  }

  function run(command: Phase2Command): void {
    void execute(command).catch(() => undefined)
  }

  function trusted(event: Electron.IpcMainInvokeEvent): void {
    if (!windows().some((window) => window.webContents.mainFrame === event.senderFrame)) throw new Error('Untrusted sender')
  }

  ipcMain.handle(phase2Channels.snapshot, (event) => { trusted(event); return snapshot() })
  const onOverlayDrag = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (disposed || !overlay || overlay.isDestroyed() || event.senderFrame !== overlay.webContents.mainFrame) return
    const result = overlayDragSchema.safeParse(payload)
    if (!result.success) return
    if (result.data === 'end') { dragOrigin = undefined; return }
    if (overlay.isMaximized() || overlay.isFullScreen()) { dragOrigin = undefined; return }
    const cursor = screen.getCursorScreenPoint()
    if (result.data === 'start') {
      const bounds = overlay.getBounds()
      dragOrigin = { cursorX: cursor.x, cursorY: cursor.y, windowX: bounds.x, windowY: bounds.y }
    } else if (dragOrigin) {
      overlay.setPosition(
        Math.round(dragOrigin.windowX + cursor.x - dragOrigin.cursorX),
        Math.round(dragOrigin.windowY + cursor.y - dragOrigin.cursorY)
      )
    }
  }
  ipcMain.on(phase2Channels.overlayDrag, onOverlayDrag)
  ipcMain.handle(phase2Channels.command, (event, payload: unknown) => {
    trusted(event)
    const command = phase2CommandSchema.parse(payload)
    if (['confirm', 'cancel', 'copy-announcement'].includes(command.type) && event.senderFrame !== setup?.webContents.mainFrame) {
      throw new Error('This action must come from the consent window.')
    }
    return execute(command)
  })
  const unsubscribe = controller.subscribe(() => {
    const state = controller.getState()
    if (state === 'recording' && lastSessionState === 'awaiting-consent') showOverlay()
    lastSessionState = state
    publish()
  })
  const unsubscribeEngine = backend.onEngine?.((value) => { engine = value; publish() })

  void (async () => {
    try {
      hotkeys = hotkeysSchema.parse(JSON.parse(await readFile(settingsFile, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') hotkeyErrors.push('Saved hotkeys were invalid. Defaults are being used.')
    }
    if (disposed) return
    try { shortcuts.apply(hotkeys) } catch (error) {
      hotkeyErrors.push(error instanceof Error ? error.message : 'Hotkeys could not be registered. Use the tray menu.')
    }
    ready = true
    publish()
  })()
  publish()

  return async () => {
    disposed = true
    if (pendingPublish) clearImmediate(pendingPublish)
    dragOrigin = undefined
    unsubscribe()
    unsubscribeEngine?.()
    shortcuts.dispose()
    try { await controller.dispose() }
    finally {
      backend.dispose?.()
      ipcMain.removeHandler(phase2Channels.command)
      ipcMain.removeHandler(phase2Channels.snapshot)
      ipcMain.removeListener(phase2Channels.overlayDrag, onOverlayDrag)
      await meetings?.close()
    }
  }
}
