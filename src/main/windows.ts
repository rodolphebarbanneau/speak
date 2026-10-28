import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron'
import type { MainSection } from '../shared/types'
import { activePalette } from '../themes/shared'
import { configStore } from './config'
import { seasons } from './season'
import { resource } from './paths'
import { bringToFront, restoreMouseInput } from './platform/focus'
import { isMac, isWin } from './util'

type View = 'overlay' | 'preview' | 'main' | 'loader'

let quitting = false
app.on('before-quit', () => (quitting = true))

/** Let windows close for real (they normally hide): needed before the updater quits the app. */
export function allowQuit(): void {
  quitting = true
}

function load(win: BrowserWindow, view: View): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}#${view}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: view })
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    backgroundThrottling: false,
    spellcheck: false
  }
}

// Tokyo Night (Omarchy default theme), or the easter egg theme in season while it's on.
const palette = () => activePalette(configStore.get().ui, seasons.current)
export const TITLE_BAR_HEIGHT = 32
/** Windows picks the right size from the multi-resolution .ico; elsewhere a PNG is used. */
const APP_ICON = isWin ? 'icon.ico' : 'icon.png'

/**
 * Native window chrome: the OS draws the frame, corners, shadow, resize edges and caption
 * buttons (snap layouts on Windows 11, traffic lights on macOS); our title row is laid out
 * around them with the Window Controls Overlay CSS env() variables. On Windows the DWM
 * border follows the window shape and uses our accent while the window is active.
 */
function nativeChrome(): Partial<Electron.BrowserWindowConstructorOptions> {
  const { '--bg': background, '--fg': foreground } = palette()
  return {
    backgroundColor: background,
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? true : { color: background, symbolColor: foreground, height: TITLE_BAR_HEIGHT },
    ...(isMac ? { trafficLightPosition: { x: 12, y: (TITLE_BAR_HEIGHT - 14) / 2 } } : {}),
    ...(isWin ? { accentColor: false } : {})
  }
}

/** Windows convention: only the active window's border carries the accent color. */
function followActivation(win: BrowserWindow): void {
  if (!isWin) return
  win.on('focus', () => win.setAccentColor(palette()['--accent']))
  win.on('blur', () => win.setAccentColor(false))
}

/** Repaint the native chrome (background, caption buttons, active border) after the palette changes. */
export function applyChrome(): void {
  const { '--bg': background, '--fg': foreground, '--accent': accent } = palette()
  for (const win of [mainWindow, preview]) {
    if (!win || win.isDestroyed()) continue
    win.setBackgroundColor(background)
    if (!isMac) win.setTitleBarOverlay({ color: background, symbolColor: foreground, height: TITLE_BAR_HEIGHT })
    if (isWin && win.isFocused()) win.setAccentColor(accent)
  }
}

function cursorDisplay(): Electron.Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/**
 * The overlay pill: always on top, never takes focus, hosts the microphone recorder. The window
 * leaves room above the pill for its settings list, and lets clicks through except over the pill.
 */
export let overlay: BrowserWindow | null = null
const OVERLAY_SIZE = { width: 640, height: 320 }

/**
 * Whether the pill follows the pointer. On Windows, Electron does it with a system-wide mouse hook
 * run by the main thread: while that thread is busy (starting, quitting, installing an update),
 * every mouse movement on the computer waits for it, up to half a second each. So only while the
 * pill can be clicked; otherwise it lets every click through without watching.
 */
let tracking = false

export function createOverlay(): BrowserWindow {
  overlay = new BrowserWindow({
    ...OVERLAY_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // The pill is never the active window: on macOS its buttons must take the first click.
    ...(isMac ? { type: 'panel', acceptFirstMouse: true } : {}),
    webPreferences: webPreferences()
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  setOverlayInteractive(false)
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.on('close', (e) => {
    if (!quitting) e.preventDefault()
  })
  load(overlay, 'overlay')
  return overlay
}

/**
 * Show the pill. `clickable` (while recording) lets it notice the pointer, to take clicks while
 * hovered: see setOverlayInteractive.
 */
export function showOverlay(clickable = false): void {
  if (!overlay) return
  if (clickable !== tracking) {
    tracking = clickable
    setOverlayInteractive(false)
  }
  const { workArea } = cursorDisplay()
  overlay.setBounds({
    x: Math.round(workArea.x + (workArea.width - OVERLAY_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_SIZE.height - 40),
    ...OVERLAY_SIZE
  })
  if (!overlay.isVisible()) {
    overlay.showInactive()
    restoreMouseInput(overlay)
  }
}

/** Hide every window (the loading dialog aside): the app is about to go. */
export function hideWindows(): void {
  mainWindow?.hide()
  preview?.hide()
  hideOverlay()
}

export function hideOverlay(): void {
  tracking = false
  setOverlayInteractive(false)
  overlay?.hide()
}

/** Catch clicks while the pointer is over the pill; otherwise pass them through (still reporting moves while recording). */
export function setOverlayInteractive(interactive: boolean): void {
  if (interactive && tracking) overlay?.setIgnoreMouseEvents(false)
  else overlay?.setIgnoreMouseEvents(true, tracking ? { forward: true } : undefined)
}

/**
 * The loading dialog (see loading.ts): a small box in the middle of the screen, above everything,
 * that never takes the focus. Shown once its page listens, with the progress so far.
 */
export function createLoader(onReady: () => void): BrowserWindow {
  const size = { width: 460, height: 124 }
  const { workArea } = cursorDisplay()
  const win = new BrowserWindow({
    ...size,
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2.4),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Speak',
    backgroundColor: palette()['--bg'],
    webPreferences: webPreferences()
  })
  const listening = (e: IpcMainEvent) => {
    if (e.sender !== win.webContents) return
    ipcMain.off('speak:loaderReady', listening)
    onReady()
    if (!win.isDestroyed()) win.showInactive()
  }
  ipcMain.on('speak:loaderReady', listening)
  win.on('closed', () => ipcMain.off('speak:loaderReady', listening))
  load(win, 'loader')
  return win
}

/** Preview dialog: created once, reused. Closing it means "cancel". */
export let preview: BrowserWindow | null = null
let previewCloseHandler: () => void = () => undefined

export function onPreviewClose(handler: () => void): void {
  previewCloseHandler = handler
}

export function createPreview(): BrowserWindow {
  preview = new BrowserWindow({
    width: 720,
    height: 460,
    minWidth: 520,
    minHeight: 320,
    show: false,
    title: 'Speak',
    icon: resource(APP_ICON),
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    ...nativeChrome(),
    webPreferences: webPreferences()
  })
  preview.removeMenu()
  followActivation(preview)
  preview.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    previewCloseHandler()
  })
  load(preview, 'preview')
  return preview
}

export function showPreview(): void {
  if (!preview) return
  if (!preview.isVisible()) {
    const { workArea } = cursorDisplay()
    const [w, h] = preview.getSize()
    preview.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + (workArea.height - h) / 2.4))
  }
  bringToFront(preview)
}

export function hidePreview(): void {
  preview?.hide()
}

export function previewVisible(): boolean {
  return !!preview?.isVisible()
}

/** Main window: history + settings. Hidden (not destroyed) on close. */
export let mainWindow: BrowserWindow | null = null

export function showMain(section?: MainSection): void {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1120,
      height: 720,
      minWidth: 900,
      minHeight: 540,
      show: false,
      title: 'Speak',
      icon: resource(APP_ICON),
      ...nativeChrome(),
      webPreferences: webPreferences()
    })
    mainWindow.removeMenu()
    followActivation(mainWindow)
    mainWindow.on('close', (e) => {
      if (quitting) return
      e.preventDefault()
      mainWindow?.hide()
      if (isMac) app.dock?.hide()
    })
    mainWindow.once('ready-to-show', () => {
      if (isMac) void app.dock?.show()
      bringToFront(mainWindow!)
    })
    load(mainWindow, 'main')
    if (section) mainWindow.webContents.once('did-finish-load', () => mainWindow?.webContents.send('speak:navigate', section))
    return
  }
  if (section) mainWindow.webContents.send('speak:navigate', section)
  if (isMac) void app.dock?.show()
  bringToFront(mainWindow)
}

/** Send an event to every renderer. */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(`speak:${channel}`, payload)
  }
}
