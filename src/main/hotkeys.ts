import { EventEmitter } from 'node:events'
import { globalShortcut } from 'electron'
import type { Config } from '../shared/types'
import { log } from './log'
import { keyboardHookAvailable, keycodeFor, modifierKeycodes, onKeyRelease } from './platform/keyboard'

/** The two ways to record: plain dictation, or a brief the AI composes from. */
export type RecordAction = 'dictate' | 'compose'

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
 *  - 'press' (action)    dictate or compose shortcut pressed
 *  - 'release' (heldMs)  that shortcut released (only when the keyboard hook is available)
 *  - 'cancel'            cancel shortcut pressed (only registered while active)
 */
class Hotkeys extends EventEmitter {
  private shortcuts: Record<RecordAction, string> = { dictate: '', compose: '' }
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

  apply(shortcuts: Config['shortcuts']): string | undefined {
    this.shortcuts = { dictate: shortcuts.record, compose: shortcuts.compose }
    this.cancel = shortcuts.cancel
    this.registerAll()
    return this.error
  }

  private registerAll(): void {
    globalShortcut.unregisterAll()
    this.error = undefined
    if (this.suspended) return
    const errors: string[] = []
    for (const action of ['dictate', 'compose'] as const) {
      const accelerator = this.shortcuts[action]
      if (!accelerator) continue
      if (action === 'compose' && accelerator === this.shortcuts.dictate) {
        errors.push('The compose shortcut is the same as the dictation shortcut.')
        continue
      }
      try {
        if (!globalShortcut.register(accelerator, () => this.onPress(action))) {
          errors.push(`The ${action === 'dictate' ? 'dictation' : 'compose'} shortcut ${accelerator} is already used by another application.`)
        }
      } catch {
        errors.push(`Invalid ${action === 'dictate' ? 'dictation' : 'compose'} shortcut: ${accelerator}`)
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
