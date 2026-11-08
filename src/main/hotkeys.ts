import { EventEmitter } from 'node:events'
import { globalShortcut } from 'electron'
import type { Config, Mode } from '../shared/types'
import { log } from './log'
import { keyboardHookAvailable, keycodeFor, modifierKeycodes, onKeyRelease } from './platform/keyboard'

/** The ways to record: plain dictation, a brief the AI composes from, or an order it carries out. */
export type RecordAction = Mode

const NAMES: Record<RecordAction, string> = { dictate: 'dictation', compose: 'compose', control: 'control' }

/** uiohook keycodes of an accelerator's keys, to notice when the combination is released. */
function comboCodes(accelerator: string): Set<number> {
  const codes = new Set<number>()
  for (const token of accelerator.split('+')) {
    const mods = modifierKeycodes(token)
    if (mods.length) mods.forEach((c) => codes.add(c))
    else {
      const code = keycodeFor(token)
      if (code !== null) codes.add(code)
    }
  }
  return codes
}

/**
 * Global shortcuts. Emits:
 *  - 'press' (action)    dictate, compose or control shortcut pressed
 *  - 'release' (heldMs)  that shortcut released (only when the keyboard hook is available)
 *  - 'cancel'            cancel shortcut pressed (only registered while active)
 */
class Hotkeys extends EventEmitter {
  private shortcuts: Record<RecordAction, string> = { dictate: '', compose: '', control: '' }
  private cancel = ''
  private cancelActive = false
  private suspended = false
  /** Keys of the combination being held, while the keyboard hook can report its release. */
  private held: Set<number> | null = null
  private pressAt = 0
  private lastEventAt = 0
  error: string | undefined

  constructor() {
    super()
    onKeyRelease((code) => {
      if (this.held?.has(code)) {
        this.held = null
        this.emit('release', Date.now() - this.pressAt)
      }
    })
  }

  /** The shortcuts of the modes that are on (one that's off leaves its keys to other apps). */
  apply(shortcuts: Config['shortcuts'], modes: Config['modes']): string | undefined {
    this.shortcuts = {
      dictate: modes.dictate ? shortcuts.record : '',
      compose: modes.compose ? shortcuts.compose : '',
      control: modes.control ? shortcuts.control : ''
    }
    this.cancel = shortcuts.cancel
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
    if (this.cancelActive) this.registerCancel()
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
    // Ignore key auto-repeat while the combination is held down.
    if (this.held || repeat) return
    this.held = keyboardHookAvailable() ? comboCodes(this.shortcuts[action]) : null
    this.pressAt = now
    this.emit('press', action)
  }

  /** The cancel shortcut (e.g. Escape) is only grabbed while recording/processing. */
  setCancelActive(active: boolean): void {
    if (active === this.cancelActive) return
    this.cancelActive = active
    if (this.suspended) return
    if (active) this.registerCancel()
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
