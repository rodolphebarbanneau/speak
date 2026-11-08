import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron'
import type { MainSection } from '../shared/types'
import { activePalette } from '../themes/shared'
import { configStore } from './config'
import { seasons } from './season'
import { resource } from './paths'
import { log } from './log'
import { bringToFront, restoreMouseInput } from './platform/focus'
import { isMac, isWin } from './util'

type View = 'overlay' | 'preview' | 'main' | 'loader' | 'control' | 'frame'

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
const OVERLAY_SIZE = { width: 760, height: 320 }

/**
 * Whether the pill follows the pointer. On Windows, Electron does it with a system-wide mouse hook
 * run by the main thread: while that thread is busy (starting, quitting, installing an update),
 * every mouse movement on the computer waits for it, up to half a second each. So only while the
 * pill can be clicked; otherwise it lets every click through without watching.
 */
let tracking = false

/** What the pill did this session, for bug reports. */
const pill = { shown: 0, last: '', reloads: [] as number[] }
let overlayGoneHandler: () => void = () => undefined

/** Called when the pill's page stopped (its recording, if any, is lost) and is being reloaded. */
export function onOverlayGone(handler: () => void): void {
  overlayGoneHandler = handler
}

/** Where a point of the virtual screen is: "display 2 of 2 (1.5x)". */
function displayOf(bounds: Electron.Rectangle): string {
  const all = screen.getAllDisplays()
  const display = screen.getDisplayMatching(bounds)
  return `display ${all.findIndex((d) => d.id === display.id) + 1} of ${all.length} (${display.scaleFactor}x)`
}

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
  // The page holds the pill and the microphone: if it crashes or is killed (out of memory…), both
  // would be gone until Speak restarts. Load it again, unless it keeps crashing.
  overlay.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit' || !overlay || overlay.isDestroyed()) return
    const now = Date.now()
    pill.reloads = [...pill.reloads.filter((t) => now - t < 60_000), now]
    overlayGoneHandler()
    if (pill.reloads.length > 3) return log.error('The pill keeps crashing: not reloading it again. Restart Speak.')
    log.warn('Reloading the pill')
    load(overlay, 'overlay')
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
  const bounds = {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_SIZE.height - 40),
    ...OVERLAY_SIZE
  }
  overlay.setBounds(bounds)
  if (!overlay.isVisible()) {
    overlay.showInactive()
    restoreMouseInput(overlay)
    pill.shown++
    pill.last = `at ${bounds.x},${bounds.y} on ${displayOf(bounds)}`
    log.info(`Pill shown ${pill.last}`)
  }
}

/** The pill's state, for bug reports: shown or not, where, and how it went this session. */
export function pillState(): string {
  if (!overlay || overlay.isDestroyed()) return 'no window'
  const b = overlay.getBounds()
  return [
    overlay.isVisible() ? `shown at ${b.x},${b.y} ${b.width}x${b.height} on ${displayOf(b)}` : 'hidden',
    `shown ${pill.shown} time${pill.shown === 1 ? '' : 's'} this session${pill.last ? `, last ${pill.last}` : ''}`,
    pill.reloads.length ? `reloaded after a crash ${pill.reloads.length} time${pill.reloads.length === 1 ? '' : 's'} in the last minute` : ''
  ]
    .filter(Boolean)
    .join('; ')
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
/**
 * Let the pill take the keyboard, to type an address into it, or give it back. It normally never
 * takes the focus, which stays in the app being dictated into.
 */
export function setOverlayKeyboard(on: boolean): void {
  if (!overlay || overlay.isDestroyed()) return
  overlay.setFocusable(on)
  if (on) bringToFront(overlay)
}

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

// ---------------------------------------------------------------- control mode

/** Speak's control windows stay out of screenshots (SPEAK_DEBUG_CAPTURE=1 lets them in, to take pictures of them). */
const excludeFromCapture = process.env.SPEAK_DEBUG_CAPTURE !== '1'

/**
 * The control panel: a session's conversation, its approvals and controls. Always on top, never
 * takes the focus (the AI's typing goes to the app it acts on), and left out of screenshots (the
 * AI never sees nor clicks it). It sits in the corner of the screen the app it acts on covers least.
 */
export let controlPanel: BrowserWindow | null = null
const PANEL = { width: 540, height: 420, collapsed: 46 }
let panelCollapsed = false

function panelWindow(): BrowserWindow {
  if (controlPanel && !controlPanel.isDestroyed()) return controlPanel
  controlPanel = new BrowserWindow({
    width: PANEL.width,
    height: PANEL.height,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Speak control',
    backgroundColor: palette()['--bg'],
    // Square, like the pill: Windows 11 rounds frameless windows, which cuts the panel's border at the corners.
    roundedCorners: false,
    ...(isMac ? { type: 'panel', acceptFirstMouse: true } : {}),
    webPreferences: webPreferences()
  })
  controlPanel.setAlwaysOnTop(true, 'screen-saver')
  controlPanel.setContentProtection(excludeFromCapture)
  controlPanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  controlPanel.on('close', (e) => {
    if (!quitting) e.preventDefault()
  })
  load(controlPanel, 'control')
  return controlPanel
}

/** Physical screen rect → DIPs (Windows); elsewhere they're the same. */
function toDip(r: { x: number; y: number; w: number; h: number }): Electron.Rectangle {
  const rect = { x: r.x, y: r.y, width: r.w, height: r.h }
  return isWin ? screen.screenToDipRect(null, rect) : rect
}

/** Show the panel, away from `avoid` (the app it acts on, in screen pixels). */
export function showControlPanel(avoid?: { x: number; y: number; w: number; h: number } | null): void {
  const win = panelWindow()
  const height = panelCollapsed ? PANEL.collapsed : PANEL.height
  if (!win.isVisible()) {
    const avoidDip = avoid ? toDip(avoid) : null
    const display = avoidDip ? screen.getDisplayMatching(avoidDip) : cursorDisplay()
    const { workArea: a } = display
    const m = 16
    const corners = [
      { x: a.x + a.width - PANEL.width - m, y: a.y + a.height - PANEL.height - m },
      { x: a.x + m, y: a.y + a.height - PANEL.height - m },
      { x: a.x + a.width - PANEL.width - m, y: a.y + m },
      { x: a.x + m, y: a.y + m }
    ]
    const overlap = (c: { x: number; y: number }) => {
      if (!avoidDip) return 0
      const w = Math.max(0, Math.min(c.x + PANEL.width, avoidDip.x + avoidDip.width) - Math.max(c.x, avoidDip.x))
      const h = Math.max(0, Math.min(c.y + PANEL.height, avoidDip.y + avoidDip.height) - Math.max(c.y, avoidDip.y))
      return w * h
    }
    const best = corners.reduce((b, c) => (overlap(c) < overlap(b) ? c : b), corners[0])
    win.setBounds({ x: Math.round(best.x), y: Math.round(best.y), width: PANEL.width, height })
    win.showInactive()
    restoreMouseInput(win)
  }
}

export function hideControlPanel(): void {
  controlPanel?.hide()
  hideFrame()
}

/** Reduce the panel to its title row, or open it again; it keeps its bottom edge. */
export function setControlCollapsed(collapsed: boolean): void {
  panelCollapsed = collapsed
  const win = controlPanel
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const height = collapsed ? PANEL.collapsed : PANEL.height
  win.setBounds({ x: b.x, y: b.y + b.height - height, width: b.width, height })
}

/** Let the panel take the keyboard, to type an order into it, or give it back. */
export function setControlKeyboard(on: boolean): void {
  if (!controlPanel || controlPanel.isDestroyed()) return
  controlPanel.setFocusable(on)
  if (on) bringToFront(controlPanel)
}

/** Where the panel is, in screen pixels (a click there is the user's, not a hand on the mouse). */
export function controlPanelRect(): { x: number; y: number; w: number; h: number } | null {
  if (!controlPanel?.isVisible()) return null
  const b = isWin ? screen.dipToScreenRect(null, controlPanel.getBounds()) : controlPanel.getBounds()
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

/** The pill is left out of screenshots while a control session runs (it may cover what the AI looks at). */
export function setOverlayCaptureExcluded(on: boolean): void {
  if (overlay && !overlay.isDestroyed()) overlay.setContentProtection(on && excludeFromCapture)
}

/**
 * A frame around where the AI acts (the app's window, the screen): click-through, above all, not
 * in screenshots. Its color says whether the AI acts or waits.
 */
let frame: BrowserWindow | null = null

export function showFrame(area: { x: number; y: number; w: number; h: number }, tone: 'acting' | 'waiting'): void {
  if (!frame || frame.isDestroyed()) {
    frame = new BrowserWindow({
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
      roundedCorners: false,
      webPreferences: webPreferences()
    })
    frame.setAlwaysOnTop(true, 'screen-saver')
    frame.setIgnoreMouseEvents(true)
    frame.setContentProtection(excludeFromCapture)
    frame.on('close', (e) => {
      if (!quitting) e.preventDefault()
    })
    load(frame, 'frame')
  }
  // Around a window, just outside it; around a button or a field, with room to see it.
  const pad = area.w < 400 && area.h < 200 ? 6 : 3
  const b = toDip({ x: area.x - pad, y: area.y - pad, w: area.w + pad * 2, h: area.h + pad * 2 })
  frame.setBounds(b)
  frame.webContents.send('speak:frame', tone)
  if (!frame.isVisible()) frame.showInactive()
}

export function hideFrame(): void {
  frame?.hide()
}

/** Send an event to every renderer. */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(`speak:${channel}`, payload)
  }
}
