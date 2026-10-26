import { systemPreferences } from 'electron'
import { log } from '../log'
import { delay, isMac, isWayland } from '../util'

type Uiohook = typeof import('uiohook-napi')

/**
 * Low-level keyboard access via libuiohook: detects key releases (Electron's
 * globalShortcut only reports presses) and synthesizes the paste keystroke.
 */
let mod: Uiohook | null = null
let started = false
const pressed = new Set<number>()
const releaseListeners = new Set<(keycode: number) => void>()

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
    m.uIOhook.on('keydown', (e) => pressed.add(e.keycode))
    m.uIOhook.on('keyup', (e) => {
      pressed.delete(e.keycode)
      for (const l of releaseListeners) l(e.keycode)
    })
    m.uIOhook.start()
    started = true
    log.info('Keyboard hook started')
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

export function onKeyRelease(cb: (keycode: number) => void): () => void {
  releaseListeners.add(cb)
  return () => releaseListeners.delete(cb)
}

const MODIFIER_CODES = [29, 3613, 42, 54, 56, 3640, 3675, 3676]

/** Wait (bounded) until the user has released all modifier keys, so the paste isn't Ctrl+Shift+V by accident. */
export async function waitForModifiersReleased(maxMs = 1500): Promise<void> {
  if (!started) return
  const until = Date.now() + maxMs
  while (MODIFIER_CODES.some((c) => pressed.has(c)) && Date.now() < until) await delay(25)
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
export function tapKeys(key: 'V' | 'Insert', modifiers: Array<'Ctrl' | 'Shift' | 'Meta'>): boolean {
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
