import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import type { MainSection } from '../shared/types'
import { resource } from './paths'
import { bringToFront } from './platform/focus'
import { isMac, isWin } from './util'

type View = 'overlay' | 'preview' | 'main'

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

// Tokyo Night (Omarchy default theme).
const BACKGROUND = '#1a1b26'
const FOREGROUND = '#a9b1d6'
const ACCENT = '#7aa2f7'
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
  return {
    backgroundColor: BACKGROUND,
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? true : { color: BACKGROUND, symbolColor: FOREGROUND, height: TITLE_BAR_HEIGHT },
    ...(isMac ? { trafficLightPosition: { x: 12, y: (TITLE_BAR_HEIGHT - 14) / 2 } } : {}),
    ...(isWin ? { accentColor: false } : {})
  }
}

/** Windows convention: only the active window's border carries the accent color. */
function followActivation(win: BrowserWindow): void {
  if (!isWin) return
  win.on('focus', () => win.setAccentColor(ACCENT))
  win.on('blur', () => win.setAccentColor(false))
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
    ...(isMac ? { type: 'panel' } : {}),
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

export function showOverlay(): void {
  if (!overlay) return
  const { workArea } = cursorDisplay()
  overlay.setBounds({
    x: Math.round(workArea.x + (workArea.width - OVERLAY_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_SIZE.height - 40),
    ...OVERLAY_SIZE
  })
  if (!overlay.isVisible()) overlay.showInactive()
}

export function hideOverlay(): void {
  setOverlayInteractive(false)
  overlay?.hide()
}

/** Catch clicks while the pointer is over the pill; otherwise pass them through (still reporting moves). */
export function setOverlayInteractive(interactive: boolean): void {
  if (interactive) overlay?.setIgnoreMouseEvents(false)
  else overlay?.setIgnoreMouseEvents(true, { forward: true })
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
