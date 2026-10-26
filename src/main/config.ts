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

class ConfigStore extends EventEmitter {
  private config: Config = structuredClone(DEFAULT_CONFIG)

  load(): Config {
    try {
      this.config = merge(structuredClone(DEFAULT_CONFIG), JSON.parse(readFileSync(paths.config, 'utf8')))
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
