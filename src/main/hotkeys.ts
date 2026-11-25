import { EventEmitter } from 'node:events'
import { globalShortcut } from 'electron'
import type { Config, Mode } from '../shared/types'
import { log } from './log'
import { keyboardHookAvailable, keycodeFor, keysHeld, modifierKeycodes, onKeyPress, onKeyRelease, type KeyPress } from './platform/keyboard'
import { isMac } from './util'

/** The ways to record: plain dictation, a brief the AI composes from, or an order it carries out. */
export type RecordAction = Mode

const NAMES: Record<RecordAction, string> = { dictate: 'dictation', compose: 'compose', control: 'control' }

/** uiohook keycodes of an accelerator's keys, one group per key (a modifier's left and right), to notice when the combination is released. */
function comboKeys(accelerator: string): number[][] {
  const keys: number[][] = []
  for (const token of accelerator.split('+')) {
    const mods = modifierKeycodes(token)
    if (mods.length) keys.push(mods)
    else {
      const code = keycodeFor(token)
      if (code !== null) keys.push([code])
    }
  }
  return keys
}

/** Whether a key going down is the accelerator ("Escape", "Ctrl+Shift+X"), with exactly its modifiers. */
function isCombo(accelerator: string, e: KeyPress): boolean {
  const want = { ctrl: false, alt: false, shift: false, meta: false }
  let key: number | null = null
  for (const token of accelerator.split('+').map((t) => t.trim())) {
    const t = token.toLowerCase()
    if (t === 'ctrl' || t === 'control') want.ctrl = true
    else if (t === 'commandorcontrol' || t === 'cmdorctrl') want[isMac ? 'meta' : 'ctrl'] = true
    else if (t === 'command' || t === 'cmd' || t === 'super' || t === 'meta') want.meta = true
    else if (t === 'alt' || t === 'option' || t === 'altgr') want.alt = true
    else if (t === 'shift') want.shift = true
    else key = keycodeFor(token)
  }
  return key !== null && e.keycode === key && e.ctrl === want.ctrl && e.alt === want.alt && e.shift === want.shift && e.meta === want.meta
}

/**
 * The cancel shortcut: off; grabbed while recording (the keys are Speak's: the app in front
 * doesn't get them); watched while the dictation is worked on (the app in front still gets
 * them: Esc there closes its own menus as usual).
 */
export type CancelMode = 'off' | 'grab' | 'watch'

/** While a shortcut is held, how often the keyboard itself is asked whether it still is (see watchHeld). */
const HELD_POLL_MS = 100
/**
 * A press while the shortcut still looks held, when nothing can tell whether it is: its own
 * auto-repeat before this (the first repeat comes after a pause), a new press after (the release
 * went unseen).
 */
const HELD_UNSURE_MS = 1500

/**
 * Global shortcuts. Emits:
 *  - 'press' (action)    dictate, compose or control shortcut pressed
 *  - 'release' (heldMs)  that shortcut released (only when the keyboard hook is available)
 *  - 'cancel'            cancel shortcut pressed (only while a dictation is under way, see setCancel)
 */
class Hotkeys extends EventEmitter {
  private shortcuts: Record<RecordAction, string> = { dictate: '', compose: '', control: '' }
  private cancel = ''
  private cancelMode: CancelMode = 'off'
  private suspended = false
  /** Keys of the combination being held, while the keyboard hook can report its release. */
  private held: Set<number> | null = null
  /** The same keys, by key (see comboKeys), and the timer asking the keyboard about them. */
  private heldKeys: number[][] = []
  private heldPoll: NodeJS.Timeout | null = null
  /** The keyboard itself showed the shortcut held: it can tell its release too. */
  private heldSeen = false
  private pressAt = 0
  private lastEventAt = 0
  error: string | undefined

  constructor() {
    super()
    onKeyRelease((code) => {
      if (this.held?.has(code)) this.released()
    })
    onKeyPress((e) => {
      if (this.cancelMode === 'watch' && !this.suspended && this.cancel && isCombo(this.cancel, e)) this.emit('cancel')
    })
  }

  private released(): void {
    this.held = null
    if (this.heldPoll) clearInterval(this.heldPoll)
    this.heldPoll = null
    this.emit('release', Date.now() - this.pressAt)
  }

  /**
   * The keyboard hook misses a release made in an administrator's window (Windows keeps the keys
   * from other apps there): the shortcut then looked held for good, and every later press was
   * taken for its auto-repeat and ignored. Where the keyboard can say (Windows), it is asked
   * while the shortcut is held, and a key up there is the release.
   */
  private watchHeld(): void {
    if (this.heldPoll) clearInterval(this.heldPoll)
    this.heldPoll = null
    this.heldSeen = false
    if (keysHeld(this.heldKeys) === null) return
    this.heldPoll = setInterval(() => {
      if (!this.held) return
      const down = keysHeld(this.heldKeys)
      if (down) this.heldSeen = true
      else if (this.heldSeen) this.released()
      else {
        // Never seen held (let go at once, or a window the keyboard can't be read in): unsure.
        if (this.heldPoll) clearInterval(this.heldPoll)
        this.heldPoll = null
      }
    }, HELD_POLL_MS)
  }

  /** The shortcuts of the modes that are on (one that's off leaves its keys to other apps). */
  apply(modes: Config['modes'], cancel: string): string | undefined {
    this.shortcuts = {
      dictate: modes.dictate.on ? modes.dictate.shortcut : '',
      compose: modes.compose.on ? modes.compose.shortcut : '',
      control: modes.control.on ? modes.control.shortcut : ''
    }
    this.cancel = cancel
    this.registerAll()
    return this.error
  }

  private registerAll(): void {
    globalShortcut.unregisterAll()
    this.error = undefined
    if (this.suspended) return
    const errors: string[] = []
    const actions = ['dictate', 'compose', 'control'] as const
    for (const action of actions) {
      const accelerator = this.shortcuts[action]
      if (!accelerator) continue
      const same = actions.find((other) => other !== action && this.shortcuts[other] === accelerator)
      if (same && actions.indexOf(same) < actions.indexOf(action)) {
        errors.push(`The ${NAMES[action]} shortcut is the same as the ${NAMES[same]} shortcut.`)
        continue
      }
      try {
        if (!globalShortcut.register(accelerator, () => this.onPress(action))) {
          errors.push(`The ${NAMES[action]} shortcut ${accelerator} is already used by another application.`)
        }
      } catch {
        errors.push(`Invalid ${NAMES[action]} shortcut: ${accelerator}`)
      }
    }
    this.error = errors.join(' ') || undefined
    if (this.error) log.warn(this.error)
    if (this.cancelMode === 'grab') this.registerCancel()
  }

  private registerCancel(): void {
    if (!this.cancel || Object.values(this.shortcuts).includes(this.cancel) || globalShortcut.isRegistered(this.cancel)) return
    try {
      globalShortcut.register(this.cancel, () => this.emit('cancel'))
    } catch {
      log.warn('Invalid cancel shortcut', this.cancel)
    }
  }

  private onPress(action: RecordAction): void {
    const now = Date.now()
    const repeat = now - this.lastEventAt < 350
    this.lastEventAt = now
    // Ignore key auto-repeat while the combination is held down. A release nobody saw (see
    // watchHeld) mustn't leave it looking held for good, every later press ignored.
    if (repeat) return
    if (this.held) {
      if (this.heldSeen || now - this.pressAt < HELD_UNSURE_MS) return
      log.info('The shortcut was pressed again while it looked held (its release went unseen): a new press')
    }
    this.heldKeys = keyboardHookAvailable() ? comboKeys(this.shortcuts[action]) : []
    this.held = this.heldKeys.length ? new Set(this.heldKeys.flat()) : null
    this.pressAt = now
    if (this.held) this.watchHeld()
    this.emit('press', action)
  }

  /** The cancel shortcut (e.g. Escape), see CancelMode. Watched only through the keyboard hook: without it, grabbed. */
  setCancel(mode: CancelMode): void {
    if (mode === 'watch' && !keyboardHookAvailable()) mode = 'grab'
    if (mode === this.cancelMode) return
    this.cancelMode = mode
    if (this.suspended) return
    if (mode === 'grab') this.registerCancel()
    else if (this.cancel && !Object.values(this.shortcuts).includes(this.cancel) && globalShortcut.isRegistered(this.cancel))
      globalShortcut.unregister(this.cancel)
  }

  /** Temporarily release all shortcuts (while the user records a new one in Settings). */
  suspend(suspended: boolean): void {
    this.suspended = suspended
    this.registerAll()
  }
}

export const hotkeys = new Hotkeys()
