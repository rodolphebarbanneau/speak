import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { DEFAULT_CONFIG } from '../shared/constants'
import type { Config, DeepPartial } from '../shared/types'
import { log } from './log'
import { paths } from './paths'
import { isMac } from './util'

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

/** Defaults, adjusted for this platform. */
function defaults(): Config {
  const config = structuredClone(DEFAULT_CONFIG)
  // ⌘⌥Space opens Finder search on macOS.
  if (isMac) config.shortcuts.compose = 'Command+Shift+Alt+Space'
  return config
}

class ConfigStore extends EventEmitter {
  private config: Config = defaults()

  load(): Config {
    try {
      this.config = merge(defaults(), JSON.parse(readFileSync(paths.config, 'utf8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Invalid config.json, using defaults:', err)
      this.config = defaults()
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
