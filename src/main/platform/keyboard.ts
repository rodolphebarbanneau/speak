import { powerMonitor, systemPreferences } from 'electron'
import { log } from '../log'
import { delay, isMac, isWayland, isWin } from '../util'
import { keyIsDown, sendKeyCombo, VK } from './send-input'

type Uiohook = typeof import('uiohook-napi')

/**
 * Low-level keyboard access via libuiohook: detects key releases (Electron's
 * globalShortcut only reports presses) and synthesizes the paste keystroke.
 */
let mod: Uiohook | null = null
let started = false
const pressed = new Set<number>()
const releaseListeners = new Set<(keycode: number) => void>()

/** A key going down, with the modifiers held with it. */
export type KeyPress = { keycode: number; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
const pressListeners = new Set<(e: KeyPress) => void>()

/** A key pressed, a click, a wheel turn or the pointer moving, from anyone (Speak's own input included). */
export type UserInput = { kind: 'key'; keycode: number; modifiers: boolean } | { kind: 'mouse'; x: number; y: number } | { kind: 'move'; x: number; y: number }
const inputListeners = new Set<(e: UserInput) => void>()

function load(): Uiohook | null {
  if (mod) return mod
  try {
    mod = require('uiohook-napi') as Uiohook
  } catch (err) {
    log.warn('uiohook-napi unavailable:', err)
  }
  return mod
}

export function keyboardHookAvailable(): boolean {
  return started
}

/** For `--self-check`: the hook's native module loads (on macOS, even before Accessibility lets it start). Null when it does. */
export function checkKeyboardHook(): string | null {
  if (isWayland) return null
  return load() ? null : "the keyboard hook's native module didn't load (uiohook-napi)"
}

export function accessibilityTrusted(prompt = false): boolean | null {
  if (!isMac) return null
  return systemPreferences.isTrustedAccessibilityClient(prompt)
}

export function startKeyboardHook(): boolean {
  if (started) return true
  if (isWayland) return false // global key events aren't observable on Wayland
  if (isMac && !accessibilityTrusted(false)) return false
  const m = load()
  if (!m) return false
  try {
    m.uIOhook.on('keydown', (e) => {
      pressed.add(e.keycode)
      if (inputListeners.size) for (const l of inputListeners) l({ kind: 'key', keycode: e.keycode, modifiers: e.ctrlKey || e.altKey || e.metaKey })
      if (pressListeners.size) {
        const press = { keycode: e.keycode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
        for (const l of pressListeners) l(press)
      }
    })
    m.uIOhook.on('mousedown', (e) => {
      if (inputListeners.size) for (const l of inputListeners) l({ kind: 'mouse', x: e.x, y: e.y })
    })
    m.uIOhook.on('mousemove', (e) => {
      if (inputListeners.size) for (const l of inputListeners) l({ kind: 'move', x: e.x, y: e.y })
    })
    m.uIOhook.on('wheel', (e) => {
      if (inputListeners.size) for (const l of inputListeners) l({ kind: 'mouse', x: e.x, y: e.y })
    })
    m.uIOhook.on('keyup', (e) => {
      pressed.delete(e.keycode)
      for (const l of releaseListeners) l(e.keycode)
    })
    m.uIOhook.start()
    started = true
    log.info('Keyboard hook started')
    // The lock screen takes the keys held to lock (Win+L): their releases never come.
    if (!locking) {
      locking = true
      powerMonitor.on('lock-screen', forgetPressed)
    }
  } catch (err) {
    log.warn('Keyboard hook failed to start:', err)
  }
  return started
}

export function stopKeyboardHook(): void {
  if (started && mod) {
    try {
      mod.uIOhook.stop()
    } catch {
      // ignore
    }
  }
  started = false
}

/** Every key press, click, wheel turn and pointer move (control mode shares the mouse and the keyboard with the user). */
export function onUserInput(cb: (e: UserInput) => void): () => void {
  inputListeners.add(cb)
  return () => inputListeners.delete(cb)
}

/** Every key going down (seen, not taken: the app in front gets it too). */
export function onKeyPress(cb: (e: KeyPress) => void): () => void {
  pressListeners.add(cb)
  return () => pressListeners.delete(cb)
}

export function onKeyRelease(cb: (keycode: number) => void): () => void {
  releaseListeners.add(cb)
  return () => releaseListeners.delete(cb)
}

let locking = false

/** Every key the hook saw go down, released: nothing is held at the lock screen. */
function forgetPressed(): void {
  const codes = [...pressed]
  pressed.clear()
  for (const code of codes) for (const l of releaseListeners) l(code)
}

/**
 * Whether a key is held. On Windows, as the keyboard is now: the hook misses the releases made
 * in an administrator's window (Windows keeps them from other apps) and on the lock screen, and
 * a key it saw go down then looks held for good. Elsewhere, as the hook saw it.
 */
export function isPressed(code: number): boolean {
  if (!isWin) return pressed.has(code)
  const down = keyIsDown(code)
  if (down === null) return pressed.has(code)
  if (!down) pressed.delete(code)
  return down
}

/**
 * Whether a combination is held, as the keyboard itself says (Windows): each key down (a key: one
 * of its codes, a modifier's left or right). Null when it can't tell, elsewhere or for a key
 * Windows can't name from its code.
 */
export function keysHeld(keys: number[][]): boolean | null {
  if (!isWin || !keys.length) return null
  let held = true
  for (const codes of keys) {
    const states = codes.map(keyIsDown)
    if (states.includes(null)) return null
    if (!states.includes(true)) held = false
  }
  return held
}

const MODIFIER_CODES = [29, 3613, 42, 54, 56, 3640, 3675, 3676]

/** Wait (bounded) until the user has released all modifier keys, so the paste isn't Ctrl+Shift+V by accident. */
export async function waitForModifiersReleased(maxMs = 1500): Promise<void> {
  if (!started) return
  const until = Date.now() + maxMs
  while (MODIFIER_CODES.some(isPressed) && Date.now() < until) await delay(25)
}

/** Map an Electron accelerator key token to a uiohook keycode. */
export function keycodeFor(token: string): number | null {
  const m = load()
  if (!m) return null
  const K = m.UiohookKey as unknown as Record<string, number>
  const t = token.length === 1 ? token.toUpperCase() : token
  const aliases: Record<string, string> = {
    Return: 'Enter',
    Esc: 'Escape',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Plus: 'Equal',
    ';': 'Semicolon',
    '=': 'Equal',
    ',': 'Comma',
    '-': 'Minus',
    '.': 'Period',
    '/': 'Slash',
    '`': 'Backquote',
    '[': 'BracketLeft',
    '\\': 'Backslash',
    ']': 'BracketRight',
    "'": 'Quote'
  }
  const name = aliases[t] ?? t
  return typeof K[name] === 'number' ? K[name] : null
}

export function modifierKeycodes(modifier: string): number[] {
  switch (modifier.toLowerCase()) {
    case 'ctrl':
    case 'control':
      return [29, 3613]
    case 'commandorcontrol':
    case 'cmdorctrl':
      return isMac ? [3675, 3676] : [29, 3613]
    case 'command':
    case 'cmd':
    case 'super':
    case 'meta':
      return [3675, 3676]
    case 'alt':
    case 'option':
    case 'altgr':
      return [56, 3640]
    case 'shift':
      return [42, 54]
    default:
      return []
  }
}

/** Synthesize a key combination (layout-independent physical keys). */
export function tapKeys(key: 'C' | 'V' | 'Insert', modifiers: Array<'Ctrl' | 'Shift' | 'Meta'>): boolean {
  if (isWin && !modifiers.includes('Meta')) {
    const sent = sendKeyCombo(
      VK[key],
      modifiers.map((k) => VK[k as 'Ctrl' | 'Shift'])
    )
    if (sent !== null) return sent
  }
  const m = load()
  if (!m) return false
  try {
    m.uIOhook.keyTap(
      m.UiohookKey[key],
      modifiers.map((k) => m.UiohookKey[k])
    )
    return true
  } catch (err) {
    log.warn('keyTap failed:', err)
    return false
  }
}
