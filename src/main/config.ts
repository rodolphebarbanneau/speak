import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (isObject(v) ? v : {})

/**
 * An AI provider's settings from layout 1. Its models chained (compose: '' = dictation's; control:
 * '' = compose's), hidden from the user: now each mode has its own, '' = the recommended one. A
 * model left at the old default becomes the recommended, which follows Speak's advice as models
 * change; one the user picked stays.
 */
function agentFromV1(v: unknown, was: { dictate: string; compose: string }): Raw {
  const a = obj(v)
  const kept = (model: unknown, old: string) => (typeof model === 'string' && model !== old ? model : '')
  return {
    path: a.path,
    home: a.home,
    models: { dictate: kept(a.model, was.dictate), compose: kept(a.composeModel, was.compose), control: kept(a.controlModel, '') },
    effort: a.effort
  }
}

/**
 * Layout 1 (up to 0.3.2), grouped as features came, to layout 2, grouped as the settings tabs. A
 * value missing here is left out, and the default fills it. Control mode (0.3) brought a shortcut:
 * its default, unless the user already used those keys for dictation or compose (then none, to
 * pick in settings).
 */
function fromV1(old: Raw): Raw {
  const shortcuts = obj(old.shortcuts)
  const modes = obj(old.modes)
  const output = obj(old.output)
  const language = obj(old.language)
  const audio = obj(old.audio)
  const t = obj(old.transcription)
  const ai = obj(old.ai)
  const ui = obj(old.ui)
  const control = obj(old.control)
  const controlKey =
    shortcuts.control === undefined && [shortcuts.record, shortcuts.compose].some((v) => sameKeys(v, DEFAULT_CONFIG.modes.control.shortcut))
      ? ''
      : shortcuts.control
  return {
    version: 2,
    modes: {
      dictate: { on: modes.dictate, shortcut: shortcuts.record },
      compose: { on: modes.compose, shortcut: shortcuts.compose },
      control: { on: modes.control, shortcut: controlKey }
    },
    recording: { press: old.recordMode, cancel: shortcuts.cancel, maxSeconds: audio.maxSeconds, sounds: audio.sounds, indicator: ui.showOverlay },
    app: { launchAtLogin: ui.launchAtLogin, easterEggs: ui.easterEggs },
    history: old.history,
    speech: {
      microphone: { id: audio.deviceId, label: audio.deviceLabel },
      language: language.input,
      vocabulary: old.vocabulary,
      engine: t.engine,
      models: { whisper: t.whisperModel, parakeet: t.parakeetModel },
      useGpu: t.useGpu,
      vad: t.vad,
      keepLoadedMinutes: t.keepLoadedMinutes,
      threads: t.threads,
      customBinDir: t.customBinDir
    },
    ai: {
      provider: ai.provider,
      claudeCode: agentFromV1(ai.claudeCode, { dictate: 'haiku', compose: 'sonnet' }),
      codex: agentFromV1(ai.codex, { dictate: 'gpt-6-luna', compose: '' }),
      instructions: ai.customInstructions,
      timeoutSeconds: ai.timeoutSeconds
    },
    writing: { format: old.style, language: language.output, then: output.mode, pasteKeys: output.pasteKeys, restoreClipboard: output.restoreClipboard },
    context: old.context,
    control: {
      scope: control.scope === 'folder' ? 'app' : control.scope,
      approval: control.approval,
      alwaysAsk: control.alwaysAsk,
      readAloud: control.speak,
      language: control.replyLanguage,
      idleMinutes: control.idleMinutes,
      handsSeconds: control.handsSeconds
    },
    updates: old.updates,
    state: { onboarded: old.onboarded, lastVersion: ui.lastVersion, themeOff: ui.themeOff }
  }
}

/** Settings saved by an older version, in this version's layout. */
function migrate(raw: unknown): unknown {
  if (!isObject(raw)) return raw
  return typeof raw.version === 'number' && raw.version >= 2 ? raw : fromV1(raw)
}

/** Next to config.json: the copy that last loaded, and an unreadable one, kept aside. */
const sibling = (name: string) => paths.config.replace(/config\.json$/, name)

/** Wait, without an event loop (the settings load before anything else runs). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type Read = { ok: true; raw: string; value: unknown } | { ok: false; missing: boolean; error: unknown }

/** A settings file, read and parsed. A file another program holds (an antivirus) is tried again, briefly. */
function readSettings(file: string): Read {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = readFileSync(file, 'utf8')
      return { ok: true, raw, value: JSON.parse(raw) }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { ok: false, missing: true, error: err }
      if ((code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') && attempt < 4) {
        pause(100)
        continue
      }
      return { ok: false, missing: false, error: err }
    }
  }
}

const SAVE_RETRY_MS = 1000
const SAVE_RETRIES = 5

class ConfigStore extends EventEmitter {
  private config: Config = structuredClone(DEFAULT_CONFIG)
  private retry: NodeJS.Timeout | null = null
  private retries = 0

  /**
   * The settings, from config.json. A file that can't be read or isn't valid is never replaced by
   * the defaults: it's kept aside as config.broken.json, and the copy that last loaded
   * (config.backup.json) is used instead, else the defaults.
   */
  load(): Config {
    const read = readSettings(paths.config)
    if (read.ok) {
      const layout = isObject(read.value) && typeof read.value.version === 'number' ? read.value.version : 1
      this.config = merge(structuredClone(DEFAULT_CONFIG), migrate(read.value))
      // Brought up to date (an older layout, or new settings with their defaults): kept that way.
      // An older layout's file is kept as it was, next to it.
      if (JSON.stringify(this.config, null, 2) !== read.raw) {
        if (layout < DEFAULT_CONFIG.version) this.copy(paths.config, sibling(`config.v${layout}.json`))
        log.info(layout < DEFAULT_CONFIG.version ? `Settings moved from layout ${layout} to ${DEFAULT_CONFIG.version}` : 'Settings updated to this version')
        this.save()
      }
      this.copy(paths.config, sibling('config.backup.json'))
      return this.config
    }
    this.config = structuredClone(DEFAULT_CONFIG)
    if (!read.missing) {
      log.warn('config.json could not be read, kept aside as config.broken.json:', read.error)
      this.copy(paths.config, sibling('config.broken.json'))
      const backup = readSettings(sibling('config.backup.json'))
      if (backup.ok) {
        this.config = merge(structuredClone(DEFAULT_CONFIG), migrate(backup.value))
        log.info('Settings restored from config.backup.json')
      } else log.warn('No backup of the settings to restore: the defaults are used')
    }
    this.save()
    return this.config
  }

  private copy(from: string, to: string): void {
    try {
      copyFileSync(from, to)
    } catch (err) {
      log.warn(`Could not copy ${from} to ${to}:`, err)
    }
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

  /**
   * Write the settings. A write that fails (a disk full, a file another program holds) is tried
   * again a few times; meanwhile the settings in use are the ones changed, and nothing is lost.
   */
  private save(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const tmp = paths.config + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(this.config, null, 2))
      renameSync(tmp, paths.config)
      this.retries = 0
    } catch (err) {
      if (this.retries++ >= SAVE_RETRIES) {
        this.retries = 0
        return log.error('Could not save the settings (they apply until Speak quits):', err)
      }
      log.warn('Could not save the settings, trying again:', (err as Error).message)
      this.retry = setTimeout(() => this.save(), SAVE_RETRY_MS)
    }
  }
}

export const configStore = new ConfigStore()
