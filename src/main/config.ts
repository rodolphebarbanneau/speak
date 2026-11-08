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

class ConfigStore extends EventEmitter {
  private config: Config = structuredClone(DEFAULT_CONFIG)

  load(): Config {
    try {
      const raw = readFileSync(paths.config, 'utf8')
      const parsed = JSON.parse(raw)
      const layout = isObject(parsed) && typeof parsed.version === 'number' ? parsed.version : 1
      this.config = merge(structuredClone(DEFAULT_CONFIG), migrate(parsed))
      // Brought up to date (an older layout, or new settings with their defaults): kept that way.
      // An older layout's file is kept as it was, next to it.
      if (JSON.stringify(this.config, null, 2) !== raw) {
        if (layout < DEFAULT_CONFIG.version) copyFileSync(paths.config, `${paths.config.replace(/\.json$/, '')}.v${layout}.json`)
        log.info(layout < DEFAULT_CONFIG.version ? `Settings moved from layout ${layout} to ${DEFAULT_CONFIG.version}` : 'Settings updated to this version')
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
