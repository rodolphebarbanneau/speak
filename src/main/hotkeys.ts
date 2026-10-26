import { EventEmitter } from 'node:events'
import { globalShortcut } from 'electron'
import { log } from './log'
import { keyboardHookAvailable, keycodeFor, modifierKeycodes, onKeyRelease } from './platform/keyboard'

/**
 * Global shortcuts. Emits:
 *  - 'press'             record shortcut pressed
 *  - 'release' (heldMs)  record shortcut released (only when the keyboard hook is available)
 *  - 'cancel'            cancel shortcut pressed (only registered while active)
 */
class Hotkeys extends EventEmitter {
  private record = ''
  private cancel = ''
  private cancelActive = false
  private suspended = false
  private held = false
  private pressAt = 0
  private lastEventAt = 0
  private comboCodes = new Set<number>()
  error: string | undefined

  constructor() {
    super()
    onKeyRelease((code) => {
      if (this.held && this.comboCodes.has(code)) {
        this.held = false
        this.emit('release', Date.now() - this.pressAt)
      }
    })
  }

  apply(record: string, cancel: string): string | undefined {
    this.record = record
    this.cancel = cancel
    this.comboCodes = new Set()
    for (const token of record.split('+')) {
      const mods = modifierKeycodes(token)
      if (mods.length) mods.forEach((c) => this.comboCodes.add(c))
      else {
        const code = keycodeFor(token)
        if (code !== null) this.comboCodes.add(code)
      }
    }
    this.registerAll()
    return this.error
  }

  private registerAll(): void {
    globalShortcut.unregisterAll()
    this.error = undefined
    if (this.suspended) return
    try {
      if (!globalShortcut.register(this.record, () => this.onPress())) {
        this.error = `The shortcut ${this.record} is already used by another application.`
      }
    } catch {
      this.error = `Invalid shortcut: ${this.record}`
    }
    if (this.error) log.warn(this.error)
    if (this.cancelActive) this.registerCancel()
  }

  private registerCancel(): void {
    if (!this.cancel || this.cancel === this.record || globalShortcut.isRegistered(this.cancel)) return
    try {
      globalShortcut.register(this.cancel, () => this.emit('cancel'))
    } catch {
      log.warn('Invalid cancel shortcut', this.cancel)
    }
  }

  private onPress(): void {
    const now = Date.now()
    const repeat = now - this.lastEventAt < 350
    this.lastEventAt = now
    // Ignore key auto-repeat while the combination is held down.
    if (this.held || repeat) return
    this.held = keyboardHookAvailable()
    this.pressAt = now
    this.emit('press')
  }

  /** The cancel shortcut (e.g. Escape) is only grabbed while recording/processing. */
  setCancelActive(active: boolean): void {
    if (active === this.cancelActive) return
    this.cancelActive = active
    if (this.suspended) return
    if (active) this.registerCancel()
    else if (this.cancel && this.cancel !== this.record && globalShortcut.isRegistered(this.cancel)) globalShortcut.unregister(this.cancel)
  }

  /** Temporarily release all shortcuts (while the user records a new one in Settings). */
  suspend(suspended: boolean): void {
    this.suspended = suspended
    this.registerAll()
  }
}

export const hotkeys = new Hotkeys()
