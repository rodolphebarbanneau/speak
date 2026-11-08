import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { DEFAULT_CONFIG } from '../shared/constants'
import type { Config, DeepPartial } from '../shared/types'
import { log } from './log'
import { paths } from './paths'

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge `patch` into `base`, ignoring keys that don't exist in `base` and type mismatches. */
function merge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out) || value === undefined) continue
    const current = out[key]
    if (isObject(current)) out[key] = merge(current, value)
    else if (typeof value === typeof current) out[key] = value
  }
  return out as T
}

/** The same keys, in any order: "CommandOrControl+Alt+Shift+Space" is "CommandOrControl+Shift+Alt+Space". */
function sameKeys(a: unknown, b: string): boolean {
  const keys = (v: string) =>
    v
      .toLowerCase()
      .split('+')
      .map((k) => k.trim())
      .sort()
      .join('+')
  return typeof a === 'string' && keys(a) === keys(b)
}

/**
 * Settings saved by an older version, brought up to date. Control mode (0.3) brings a shortcut:
 * its default, unless the user already uses those keys for dictation or compose (then none, to
 * pick in settings).
 */
function migrate(raw: unknown): unknown {
  if (!isObject(raw)) return raw
  if (isObject(raw.control) && raw.control.scope === 'folder') raw.control.scope = 'app'
  if (!isObject(raw.shortcuts)) return raw
  const s = raw.shortcuts
  const control = DEFAULT_CONFIG.shortcuts.control
  if (s.control === undefined && [s.record, s.compose].some((v) => sameKeys(v, control))) s.control = ''
  return raw
}

class ConfigStore extends EventEmitter {
  private config: Config = structuredClone(DEFAULT_CONFIG)

  load(): Config {
    try {
      const raw = readFileSync(paths.config, 'utf8')
      const parsed = JSON.parse(raw)
      const before = JSON.stringify(parsed)
      this.config = merge(structuredClone(DEFAULT_CONFIG), migrate(parsed))
      // Brought up to date: kept that way.
      if (JSON.stringify(parsed) !== before) {
        log.info('Settings updated to this version')
        this.save()
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Invalid config.json, using defaults:', err)
      this.config = structuredClone(DEFAULT_CONFIG)
      this.save()
    }
    return this.config
  }

  get(): Config {
    return this.config
  }

  update(patch: DeepPartial<Config>): Config {
    const previous = this.config
    const next = merge(structuredClone(previous), patch)
    this.config = next
    this.save()
    this.emit('change', next, previous)
    return next
  }

  private save(): void {
    const tmp = paths.config + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.config, null, 2))
    renameSync(tmp, paths.config)
  }
}

export const configStore = new ConfigStore()
