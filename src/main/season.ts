import { EventEmitter } from 'node:events'
import { seasonAt, themeExists, type Season } from '../themes/shared'
import { log } from './log'

/**
 * The easter egg theme in season on this computer, by its clock (themes/schedule.ts). Checked
 * every 10 minutes, so a theme comes and goes by itself while Speak runs. SPEAK_THEME=<theme>
 * shows one out of season, to try it.
 */
class Seasons extends EventEmitter {
  current: Season | null = null

  start(): void {
    this.check()
    setInterval(() => this.check(), 10 * 60_000).unref()
  }

  private check(): void {
    const now = new Date()
    const forced = process.env.SPEAK_THEME?.trim()
    if (forced && !themeExists(forced)) log.warn(`SPEAK_THEME=${forced}: no such theme in src/themes`)
    const next = forced && themeExists(forced) ? { id: forced, key: `${forced}-${now.getFullYear()}` } : seasonAt(now)
    if (next?.key === this.current?.key) return
    this.current = next
    if (next) log.info('Theme in season:', next.key)
    this.emit('change', next)
  }
}

export const seasons = new Seasons()
