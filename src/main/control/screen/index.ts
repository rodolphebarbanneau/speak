import { clipboard, desktopCapturer, nativeImage, screen, systemPreferences, type ClipboardItem, type NativeImage } from 'electron'
import { log } from '../../log'
import { dipToScreen } from '../../platform/coords'
import { keyboardHookAvailable, startKeyboardHook } from '../../platform/keyboard'
import { restoreClipboard, snapshotClipboard } from '../../platform/paste'
import { delay, isLinux, isMac, isWin } from '../../util'
import { MAX_SHOT } from './capture'
import { inRect, intersect, unavailable } from './common'
import { setAnchor } from './hands'
import { createMacBackend, requestScreenCapture } from './mac'
import type { Accessibility, Button, Point, Rect, ScreenBackend, Shot, WindowInfo } from './types'
import { createWin32Backend } from './win32'
import { createX11Backend } from './x11'

export type { BeforeCursor, Element, Focused, Rect, Shot, WindowInfo } from './types'
export { BridgeTimeout } from './bridge'
export { onUsersInput } from './hands'

/**
 * The screen as control mode sees and drives it, on Windows, macOS and Linux (X11): the windows
 * (what app, where), what a window shows (a screenshot, the names and places of its buttons and
 * fields through the system's accessibility API), and the mouse and keyboard, like a person's.
 * Each system's own calls are in its backend (win32.ts, mac.ts, x11.ts); what they share is here.
 */

let made: { backend: ScreenBackend; error: string | null } | undefined

function make(): { backend: ScreenBackend; error: string | null } {
  if (made) return made
  let backend: ScreenBackend
  try {
    backend = isWin
      ? createWin32Backend()
      : isMac
        ? createMacBackend()
        : isLinux
          ? createX11Backend()
          : unavailable('Control works on Windows, macOS and Linux.')
  } catch (err) {
    log.warn('Control: the screen is unavailable:', err)
    backend = unavailable(`Speak can't reach the screen here: ${(err as Error).message}`)
  }
  made = { backend, error: backend.unsupported() }
  if (made.error) log.warn(`Control: ${made.error}`)
  return made
}

function need(): ScreenBackend {
  const m = make()
  if (m.error) throw new Error(m.error)
  return m.backend
}

/** Why control can't run on this computer at all (the system, a missing part), or null. */
export function screenUnsupported(): string | null {
  return make().error
}

/**
 * Why a session can't start now, or null: control unsupported here, a permission it lacks
 * (macOS: Accessibility, Screen Recording), or the input hook that tells the user's hands from
 * Speak's not running. `prompt` asks the system for what's missing.
 */
export function screenReady(prompt: boolean): string | null {
  const unsupported = screenUnsupported()
  if (unsupported) return unsupported
  if (isMac) {
    const missing: string[] = []
    if (!systemPreferences.isTrustedAccessibilityClient(prompt)) missing.push('Accessibility')
    const recording = systemPreferences.getMediaAccessStatus('screen') !== 'granted'
    if (recording) {
      missing.push('Screen Recording')
      if (prompt) requestScreenCapture()
    }
    if (missing.length)
      return `Control needs macOS's permission to see and use the screen: in System Settings → Privacy & Security, turn Speak on under ${missing.join(' and under ')}. Then try again${recording ? ' (macOS may ask you to reopen Speak first)' : ''}.`
  }
  // Without the hook, Speak couldn't tell when the user takes the mouse or the keyboard back.
  if (!keyboardHookAvailable() && !startKeyboardHook())
    return isMac
      ? 'Control needs Accessibility to notice your mouse and keyboard: turn Speak on in System Settings → Privacy & Security → Accessibility.'
      : "Speak can't watch the mouse and the keyboard here (its input hook didn't start), so it can't share them with you safely."
  return null
}

/** macOS: ask for Screen Recording (the system's prompt the first time, then its settings). */
export function requestScreenRecording(): void {
  if (!isMac) return
  make()
  requestScreenCapture()
}

// ---------------------------------------------------------------- Speak's own windows

/**
 * Where Speak's own clickable windows are (the control panel, the pill), in screen coordinates.
 * A point there is Speak's: not a window the AI may act on, nor the user taking the mouse back.
 * On Linux, where nothing keeps them out of screenshots, they're blanked in them.
 */
let ownAreas: () => Rect[] = () => []

export function setOwnAreas(fn: () => Rect[]): void {
  ownAreas = fn
}

function ownAt(x: number, y: number): Rect | undefined {
  try {
    return ownAreas().find((r) => inRect({ x, y }, r))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- windows

/** The windows on screen, front to back: titled, visible, not Speak's own. */
export function listWindows(): WindowInfo[] {
  return need()
    .listWindows()
    .filter((w) => w.pid !== process.pid)
}

export function windowInfo(id: number): WindowInfo | null {
  return need().windowInfo(id)
}

export function foregroundWindow(): WindowInfo | null {
  return need().foregroundWindow()
}

/** Before the AI lists the windows: what the backend learns in the background (macOS: the minimized ones). */
export async function refreshWindows(): Promise<void> {
  await need()
    .refresh()
    .catch((err) => log.warn('Control: could not refresh the windows:', (err as Error).message))
}

/** The top-level window under a point of the screen (Speak's panel and pill included). */
export function windowAt(x: number, y: number): WindowInfo | null {
  const own = ownAt(x, y)
  if (own) return { id: 0, title: 'Speak', pid: process.pid, exe: 'Speak', rect: own, minimized: false, focused: false }
  return need().windowAt(x, y)
}

/** Bring a window to the front with the keyboard focus. */
export function focusWindow(id: number): Promise<boolean> {
  return need().focusWindow(id)
}

/** A minimized window shown again without taking the focus (to look at it, or read its controls). */
export function unminimize(id: number): Promise<void> {
  return need().unminimize(id)
}

/** Whether the keyboard still goes to that window (or a dialog or menu it owns). */
export function hasKeyboard(id: number): boolean {
  return need().hasKeyboard(id)
}

/**
 * Keep one of Speak's windows (the frame) just above `target` in the z-order, as if part of it:
 * a window that covers the target covers it too, and so do Speak's panel and pill (always on top).
 */
export function stackAbove(frame: number, target: number): void {
  const m = make()
  if (m.error) return
  try {
    m.backend.stackAbove(frame, target)
  } catch (err) {
    log.warn('Control: could not keep the frame on its window:', (err as Error).message)
  }
}

// ---------------------------------------------------------------- input

/**
 * Whether the user holds a key that changes what Speak's input does (Ctrl with a letter is a
 * shortcut), or a mouse button: asked of the system directly, ahead of the hook. Speak never leaves
 * its own down between two bursts, except the button of a drag (`buttons: false` then).
 */
export function pressing(buttons = true): boolean {
  const m = make()
  if (m.error) return false
  const held = m.backend.held()
  if (held.modifiers) return true
  if (!buttons || !held.buttons) return false
  // A click on Speak's own panel or pill (pause, stop, see) isn't taking the mouse back.
  const p = cursorPos()
  return windowAt(p.x, p.y)?.pid !== process.pid
}

/** Where the user's pointer is (to put it back). */
export function cursorPos(): Point {
  return need().cursorPos()
}

/** The pointer put somewhere by Speak: where the user's next move starts. */
function putPointer(x: number, y: number, dragging = false): Point {
  const p = { x: Math.round(x), y: Math.round(y) }
  setAnchor(p.x, p.y)
  need().movePointer(p.x, p.y, dragging)
  return p
}

/** The shortcut modifier here: cmd on macOS, ctrl elsewhere. */
export function shortcutMod(): 'ctrl' | 'cmd' {
  return make().backend.mod
}

export function pressKeys(combo: string): void {
  need().pressKeys(combo)
}

/**
 * Type one line as text: any keyboard layout, and no key's meaning. Never Enter: a line break would
 * be one (see insertText), so it's a space here. One character at a time, `stop` asked before each
 * (the user's hands, the keyboard still on the window): if another window takes the keyboard on its
 * own, at most one can reach it before Speak sees. (Each key waits for the system's keyboard hooks
 * anyway: more at once isn't faster.) Returns how many characters (UTF-16 units) went out.
 */
export async function typeText(text: string, stop: () => boolean): Promise<number> {
  const s = text.replace(/\r\n?|\n/g, ' ')
  const backend = need()
  let sent = 0
  for (const ch of s) {
    if (stop()) return sent
    backend.typeChar(ch)
    sent += ch.length
    await delay(4)
  }
  return sent
}

/** Terminals of Linux desktops, by their window class: their paste is ctrl+shift+v. */
const TERMINAL = /term|konsole|kitty|alacritty|tilix|wezterm|rxvt|^foot|guake|yakuake/i

/** The paste shortcut of the window in front: cmd+v, ctrl+v, or a Linux terminal's (its ctrl+v is a key of the shell's). */
function pasteKeys(): string {
  if (!isLinux) return `${shortcutMod()}+v`
  let app = ''
  try {
    app = need().foregroundWindow()?.exe ?? ''
  } catch {
    // ctrl+v
  }
  return TERMINAL.test(app) ? 'ctrl+shift+v' : 'ctrl+v'
}

/** The user's clipboard while Speak pastes, put back after (kept across pastes in a row). */
let clipboardSaved: { items: ClipboardItem[]; text: string; timer: NodeJS.Timeout } | null = null
/** The user's clipboard going back: the next paste waits for it (or it would save Speak's text as theirs). */
let restoring: Promise<void> = Promise.resolve()

/**
 * Paste text in one go, the user's clipboard put back after. Typed, a line break is Enter, which
 * sends a message or submits a form (even Shift+Enter, in a one-line field); pasted, it's only
 * text, and nothing goes out key by key into another window. Returns whether it went out.
 */
export async function pasteText(text: string, stop: () => boolean): Promise<boolean> {
  await restoring
  let items: ClipboardItem[]
  if (clipboardSaved) {
    clearTimeout(clipboardSaved.timer)
    items = (await clipboard.readText()) === clipboardSaved.text ? clipboardSaved.items : await snapshotClipboard()
    clipboardSaved = null
  } else items = await snapshotClipboard()
  const putBack = (): Promise<void> => {
    clipboardSaved = null
    // Unless the user copied something meanwhile.
    restoring = (async () => {
      if ((await clipboard.readText()) === text) await restoreClipboard(items)
    })()
    return restoring
  }
  await clipboard.writeText(text)
  await delay(40)
  if (stop()) {
    await putBack()
    return false
  }
  pressKeys(pasteKeys())
  // The app reads the clipboard when it pastes: the user's goes back a moment later.
  clipboardSaved = { items, text, timer: setTimeout(() => void putBack(), 800) }
  await delay(150)
  return true
}

/**
 * Beyond this, a line is pasted rather than typed. Each key Speak sends waits for every keyboard
 * hook on the system (a mouse's or a keyboard's software often has one): a timer tick each, about
 * 30 characters a second on some machines. A paste is one shortcut, whatever the length, so the
 * user's hands have nothing to cross.
 */
const PASTE_FROM = 40

/**
 * Text where the cursor is: a short line is typed; a longer one, or several lines, pasted in one
 * go (see pasteText). So is a tab outside Windows, where a typed tab moves to the next field. A
 * password is always typed: never on the clipboard (its history, other devices). Returns how many
 * characters went out.
 */
export async function insertText(text: string, stop: () => boolean, secret = false): Promise<number> {
  const paste = /[\r\n]/.test(text) || (!isWin && text.includes('\t')) || text.length > PASTE_FROM
  if (!secret && paste) return (await pasteText(text, stop)) ? text.length : 0
  return typeText(text, stop)
}

/** A click at a point. `stop` is asked once the pointer is there, before the button goes down. */
export async function click(x: number, y: number, button: Button = 'left', count = 1, stop: () => boolean = () => false): Promise<boolean> {
  const at = putPointer(x, y)
  await delay(40)
  const backend = need()
  for (let i = 0; i < count; i++) {
    if (stop()) return false
    backend.button(button, true, at, i + 1)
    backend.button(button, false, at, i + 1)
    if (i < count - 1) await delay(60)
  }
  return true
}

export async function moveMouse(x: number, y: number): Promise<void> {
  putPointer(x, y)
  await delay(30)
}

/** A drag, in steps; `stop` is asked before the button goes down and between steps (the button comes up anyway). */
export async function drag(from: Point, to: Point, stop: () => boolean): Promise<boolean> {
  let at = putPointer(from.x, from.y)
  await delay(60)
  if (stop()) return false
  const backend = need()
  backend.button('left', true, at)
  try {
    for (let i = 1; i <= 10; i++) {
      if (stop()) return false
      at = putPointer(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10, true)
      await delay(25)
    }
    return true
  } finally {
    backend.button('left', false, at)
  }
}

/** Scroll at a point: dy > 0 scrolls down, in notches. */
export async function scroll(x: number, y: number, dy: number, dx = 0): Promise<void> {
  await moveMouse(x, y)
  need().wheel({ x: Math.round(x), y: Math.round(y) }, Math.round(dy), Math.round(dx))
}

// ---------------------------------------------------------------- screenshots

/** The displays in screen coordinates (Electron gives DIPs: scaled by each display's factor on Windows and X11). */
function screenDisplays(): Array<{ id: number; rect: Rect }> {
  return screen.getAllDisplays().map((d) => {
    const p = dipToScreen(d.bounds)
    return { id: d.id, rect: { x: p.x, y: p.y, w: p.width, h: p.height } }
  })
}

/** The whole desktop, every display, in screen coordinates. */
export function desktopRect(): Rect {
  const all = screenDisplays().map((d) => d.rect)
  const x = Math.min(...all.map((r) => r.x))
  const y = Math.min(...all.map((r) => r.y))
  return { x, y, w: Math.max(...all.map((r) => r.x + r.w)) - x, h: Math.max(...all.map((r) => r.y + r.h)) - y }
}

export function displayRects(): Rect[] {
  return screenDisplays().map((d) => d.rect)
}

function fit(image: NativeImage, area: Rect): Shot {
  const width = image.getSize().width
  if (width <= MAX_SHOT) return { image, area, scale: area.w / width }
  return { image: image.resize({ width: MAX_SHOT, quality: 'good' }), area, scale: area.w / MAX_SHOT }
}

/**
 * Speak's windows painted over, where the system can't keep them out of screenshots (Linux): the
 * AI doesn't take its panel for something to act on. `area` is what the picture shows.
 */
function blankOwn(image: NativeImage, area: Rect): NativeImage {
  if (!isLinux) return image
  let areas: Rect[]
  try {
    areas = ownAreas()
  } catch {
    return image
  }
  const hit = areas.map((r) => intersect(r, area)).filter((r): r is Rect => !!r)
  if (!hit.length) return image
  const { width, height } = image.getSize()
  const k = width / area.w
  const px = Buffer.from(image.toBitmap())
  for (const r of hit) {
    const x0 = Math.max(0, Math.floor((r.x - area.x) * k))
    const y0 = Math.max(0, Math.floor((r.y - area.y) * k))
    const x1 = Math.min(width, Math.ceil((r.x + r.w - area.x) * k))
    const y1 = Math.min(height, Math.ceil((r.y + r.h - area.y) * k))
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4
        px[o] = px[o + 1] = px[o + 2] = 40
        px[o + 3] = 255
      }
  }
  return nativeImage.createFromBitmap(px, { width, height })
}

/**
 * A screenshot of an area of the screen as it is in front (a display, a window brought forward).
 * Speak's own windows aren't in it (excluded from capture, left out, or blanked).
 */
export async function shoot(area: Rect): Promise<Shot> {
  const displays = screenDisplays()
  let best: { id: number; rect: Rect; part: Rect } | null = null
  for (const d of displays) {
    const part = intersect(area, d.rect)
    if (part && (!best || part.w * part.h > best.part.w * best.part.h)) best = { ...d, part }
  }
  if (!best) throw new Error('That area is off screen.')
  // The system's own picture of the area, when it can leave Speak's windows out (macOS).
  const own = await need()
    .captureArea(best.part)
    .catch((err) => {
      log.warn('Control: screenshot through the system failed:', (err as Error).message)
      return null
    })
  if (own) return fit(own, best.part)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: best.rect.w, height: best.rect.h } })
  let source = sources.find((s) => s.display_id === String(best!.id))
  // One source for everything (some X11 setups): the whole desktop, not this display.
  let base = best.rect
  if (!source && sources.length === 1) {
    source = sources[0]
    const size = source.thumbnail.getSize()
    const desktop = desktopRect()
    if (displays.length > 1 && Math.abs(size.width / size.height - desktop.w / desktop.h) < Math.abs(size.width / size.height - base.w / base.h)) base = desktop
  }
  if (!source || source.thumbnail.isEmpty()) throw new Error('Could not take a screenshot.')
  const image = source.thumbnail
  // The thumbnail may come scaled: map screen coordinates to its pixels.
  const k = image.getSize().width / base.w
  const cropped = image.crop({
    x: Math.round((best.part.x - base.x) * k),
    y: Math.round((best.part.y - base.y) * k),
    width: Math.round(best.part.w * k),
    height: Math.round(best.part.h * k)
  })
  return fit(blankOwn(cropped, best.part), best.part)
}

/**
 * A window's picture as it draws itself, even behind other windows or on another screen, without
 * bringing it forward. Null when the app doesn't draw that way (an empty picture): then it has to
 * come to the front to be seen.
 */
export async function captureWindow(id: number): Promise<Shot | null> {
  const backend = need()
  let w = backend.windowInfo(id)
  if (!w) return null
  if (w.minimized) {
    await backend.unminimize(id)
    w = backend.windowInfo(id) ?? w
  }
  const r = await backend.captureWindow(w)
  return r ? fit(r.image, r.area) : null
}

/** A box drawn on a picture (where it will click, what it will fill), in the picture's pixels. */
export function markBox(image: NativeImage, box: { x: number; y: number; w: number; h: number }, rgb: [number, number, number]): NativeImage {
  const { width, height } = image.getSize()
  const px = Buffer.from(image.toBitmap())
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const o = (y * width + x) * 4
    px[o] = rgb[2]
    px[o + 1] = rgb[1]
    px[o + 2] = rgb[0]
    px[o + 3] = 255
  }
  const x0 = Math.round(box.x)
  const y0 = Math.round(box.y)
  const x1 = Math.round(box.x + box.w)
  const y1 = Math.round(box.y + box.h)
  for (let t = 0; t < 3; t++) {
    for (let x = x0 - t; x <= x1 + t; x++) {
      set(x, y0 - t)
      set(x, y1 + t)
    }
    for (let y = y0 - t; y <= y1 + t; y++) {
      set(x0 - t, y)
      set(x1 + t, y)
    }
  }
  return nativeImage.createFromBitmap(px, { width, height })
}

// ---------------------------------------------------------------- controls

/** A window's controls, through the system's accessibility API (UI Automation, AX, AT-SPI). */
export const a11y: Accessibility = {
  elements: (w, max) => need().a11y.elements(w, max),
  press: (w, index) => need().a11y.press(w, index),
  fill: (w, index, text) => need().a11y.fill(w, index, text),
  scroll: (w, index, dy) => need().a11y.scroll(w, index, dy),
  focus: (w, index) => need().a11y.focus(w, index),
  focused: () => need().a11y.focused(),
  beforeCursor: (n) => need().a11y.beforeCursor(n),
  warm: () => warmScreen(),
  stop: () => make().backend.a11y.stop()
}

/** Warm the accessibility bridge up (it takes a second or two to start). */
export function warmScreen(): void {
  const m = make()
  if (!m.error) m.backend.a11y.warm()
}
