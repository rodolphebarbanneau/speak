import type { AgentId, AgentModel, Config, ControlApproval, ControlScope, EngineId, Format, Mode, Style } from './types'

/** The project on GitHub: its releases, and its issues (where "report a bug" opens the bug form). */
export const REPO_URL = 'https://github.com/rodolphebarbanneau/speak'

/** Releases are published here; the updater reads them through electron-builder's update manifests. */
export const RELEASES_URL = `${REPO_URL}/releases`

export const LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'el', name: 'Greek' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' }
]

/** Languages supported by Parakeet TDT 0.6B v3 (auto-detected, no language hint). */
export const PARAKEET_LANGUAGES = new Set('bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro sk sl es sv ru uk'.split(' '))

/** The spoken languages to offer for an engine: Parakeet knows 25 of them. */
export function spokenLanguages(engine: EngineId): typeof LANGUAGES {
  return engine === 'parakeet' ? LANGUAGES.filter((l) => PARAKEET_LANGUAGES.has(l.code)) : LANGUAGES
}

export function languageName(code: string): string {
  if (code === 'auto') return 'Auto-detect'
  if (code === 'same') return 'Same as spoken'
  return LANGUAGES.find((l) => l.code === code)?.name ?? code
}

export const STYLES: Array<{ id: Style; label: string; description: string }> = [
  { id: 'verbatim', label: 'Verbatim', description: 'Exactly what you said (no AI unless translating).' },
  { id: 'clean', label: 'Clean', description: 'Removes fillers, repetitions and self-corrections; fixes punctuation.' },
  { id: 'prompt', label: 'Structured', description: 'Clean and well organized, ready to send as a prompt or message.' },
  { id: 'summary', label: 'Summary', description: 'Condensed to the key points.' },
  { id: 'compose', label: 'Compose', description: 'Follows your spoken instructions: writes the text you ask for from the context you give.' }
]
/** A dictation's formats: compose is a mode of its own. */
export const FORMATS = STYLES.filter((s): s is (typeof STYLES)[number] & { id: Format } => s.id !== 'compose')

export const MODES: Array<{ id: Mode; label: string; description: string }> = [
  { id: 'dictate', label: 'dictate', description: 'writes what you said' },
  { id: 'compose', label: 'compose', description: 'writes what you ask for' },
  { id: 'control', label: 'control', description: 'does what you ask, on the computer' }
]

/** The modes that are on, in order. */
export function modesOn(c: Pick<Config, 'modes'>): Mode[] {
  return MODES.map((m) => m.id).filter((id) => c.modes[id].on)
}

/** The shortcut of the first of these modes that's on and has one ('' when none): what to show as "press … to". */
export function firstShortcut(c: Pick<Config, 'modes'>, among: Mode[] = ['dictate', 'compose', 'control']): string {
  for (const m of among) if (c.modes[m].on && c.modes[m].shortcut) return c.modes[m].shortcut
  return ''
}

export const CONTROL_SCOPES: Array<{ id: ControlScope; label: string; description: string }> = [
  { id: 'app', label: 'app', description: 'the windows of the app in front when it starts: look, click, type' },
  { id: 'screen', label: 'screen', description: 'any window: look, click, type · no files, no commands' },
  { id: 'full', label: 'full', description: 'everything: any window, any file, any command' }
]

export const CONTROL_APPROVALS: Array<{ id: ControlApproval; label: string; description: string }> = [
  { id: 'step', label: 'every step', description: 'each action waits for you' },
  { id: 'plan', label: 'the plan', description: 'you approve its plan once: it asks again for a risky step or one off the plan' },
  { id: 'risky', label: 'when risky', description: 'it acts, and asks before what is hard to take back' },
  { id: 'never', label: 'never', description: 'full autonomy: only the always-ask list still asks' }
]

/** Claude Code model aliases always resolve to the latest model of each family. */
export const CLAUDE_CODE_MODELS: AgentModel[] = [
  { id: 'haiku', label: 'haiku' },
  { id: 'sonnet', label: 'sonnet' },
  { id: 'opus', label: 'opus' }
]

/** Fallback when Codex's own model catalog (~/.codex/models_cache.json) can't be read: its order, the workhorse first. */
export const CODEX_MODELS: AgentModel[] = [
  { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
  { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
  { id: 'gpt-6-luna', label: 'gpt-6-luna' }
]

/**
 * The model Speak recommends for each mode, the default. Dictate cleans up and translates: a
 * small fast model is plenty. Compose writes from a brief, where staying faithful matters; control
 * sees the screen and acts, where reliability matters: a larger one. Codex's ('' here) is the first
 * of its catalog, its workhorse, as the catalog changes (main/ai/index.ts).
 */
export const RECOMMENDED_MODELS: Record<AgentId, Record<Mode, string>> = {
  'claude-code': { dictate: 'haiku', compose: 'sonnet', control: 'sonnet' },
  codex: { dictate: 'gpt-6-luna', compose: '', control: '' }
}

export const DEFAULT_CONFIG: Config = {
  version: 2,
  // The same on every system (Ctrl is ⌘ on a Mac): Ctrl+Shift for all, Alt for the AI modes; Space
  // for the modes that write, Enter for the one that acts. macOS keeps the other Space chords.
  modes: {
    dictate: { on: true, shortcut: 'CommandOrControl+Shift+Space' },
    compose: { on: true, shortcut: 'CommandOrControl+Shift+Alt+Space' },
    control: { on: true, shortcut: 'CommandOrControl+Shift+Alt+Enter' }
  },
  recording: { press: 'hybrid', cancel: 'Escape', maxSeconds: 600, sounds: true, indicator: true },
  app: { launchAtLogin: false, easterEggs: true },
  history: { enabled: true, keepAudio: true, retentionDays: 90 },
  speech: {
    microphone: { id: 'default', label: '' },
    language: 'auto',
    vocabulary: '',
    engine: 'whisper',
    models: { whisper: 'large-v3-turbo-q8_0', parakeet: 'parakeet-tdt-0.6b-v3-q8_0' },
    useGpu: true,
    vad: true,
    keepLoadedMinutes: 30,
    threads: 0,
    customBinDir: ''
  },
  ai: {
    provider: 'claude-code',
    // '' = the recommended model of each mode (RECOMMENDED_MODELS).
    claudeCode: { path: '', home: '', models: { dictate: '', compose: '', control: '' }, effort: 'medium' },
    codex: { path: '', home: '', models: { dictate: '', compose: '', control: '' }, effort: 'medium' },
    instructions: '',
    timeoutSeconds: 90
  },
  // The result stays on the clipboard, so Ctrl+V pastes it again if the app ignored Speak's paste.
  writing: { format: 'clean', language: 'same', then: 'preview', pasteKeys: 'auto', restoreClipboard: false },
  context: { current: '', recent: [] },
  control: {
    scope: 'app',
    approval: 'plan',
    alwaysAsk: { money: true, secrets: true, delete: true, send: true },
    readAloud: false,
    language: 'same',
    idleMinutes: 30,
    handsSeconds: 2
  },
  updates: { auto: true },
  state: { onboarded: false, lastVersion: '', themeOff: '', formatBeforeNone: '', summoned: '' }
}

/** claude-opus-5-5 → opus 5.5 (other model names are returned unchanged). */
export function shortModel(model: string): string {
  const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/)
  return m ? `${m[1]} ${m[2]}${m[3] ? '.' + m[3] : ''}` : model
}

/** True when the chosen style/language needs an AI pass. */
export function needsAi(style: Style, outputLanguage: string): boolean {
  return style !== 'verbatim' || outputLanguage !== 'same'
}
