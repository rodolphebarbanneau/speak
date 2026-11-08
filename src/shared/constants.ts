import type { AgentModel, Config, ControlApproval, ControlScope, EngineId, Mode, Style } from './types'

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
export const FORMATS = STYLES.filter((s) => s.id !== 'compose')

export const MODES: Array<{ id: Mode; label: string; description: string }> = [
  { id: 'dictate', label: 'dictate', description: 'writes what you said' },
  { id: 'compose', label: 'compose', description: 'writes what you ask for' },
  { id: 'control', label: 'control', description: 'does what you ask, on the computer' }
]

/** Each mode's shortcut in the settings (dictation's is `record`). */
export const MODE_SHORTCUT: Record<Mode, 'record' | 'compose' | 'control'> = { dictate: 'record', compose: 'compose', control: 'control' }

/** The modes that are on, in order. */
export function modesOn(c: Pick<Config, 'modes'>): Mode[] {
  return MODES.map((m) => m.id).filter((id) => c.modes[id])
}

/** The shortcut of the first of these modes that's on and has one ('' when none): what to show as "press … to". */
export function firstShortcut(c: Pick<Config, 'modes' | 'shortcuts'>, among: Mode[] = ['dictate', 'compose', 'control']): string {
  for (const m of among) if (c.modes[m] && c.shortcuts[MODE_SHORTCUT[m]]) return c.shortcuts[MODE_SHORTCUT[m]]
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

/** Fallback when Codex's own model catalog (~/.codex/models_cache.json) can't be read. */
export const CODEX_MODELS: AgentModel[] = [
  { id: 'gpt-6-luna', label: 'gpt-6-luna' },
  { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
  { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }
]

export const DEFAULT_CONFIG: Config = {
  onboarded: false,
  modes: { dictate: true, compose: true, control: true },
  // The same on every system (Ctrl is ⌘ on a Mac): Ctrl+Shift for all, Alt for the AI modes; Space
  // for the modes that write, Enter for the one that acts. macOS keeps the other Space chords.
  shortcuts: {
    record: 'CommandOrControl+Shift+Space',
    compose: 'CommandOrControl+Shift+Alt+Space',
    control: 'CommandOrControl+Shift+Alt+Enter',
    cancel: 'Escape'
  },
  recordMode: 'hybrid',
  // The result stays on the clipboard, so Ctrl+V pastes it again if the app ignored Speak's paste.
  output: { mode: 'preview', restoreClipboard: false, pasteKeys: 'auto' },
  language: { input: 'auto', output: 'same' },
  style: 'clean',
  vocabulary: '',
  context: { current: '', recent: [] },
  audio: { deviceId: 'default', deviceLabel: '', maxSeconds: 600, sounds: true },
  transcription: {
    engine: 'whisper',
    whisperModel: 'large-v3-turbo-q8_0',
    parakeetModel: 'parakeet-tdt-0.6b-v3-q8_0',
    useGpu: true,
    vad: true,
    keepLoadedMinutes: 30,
    threads: 0,
    customBinDir: ''
  },
  ai: {
    provider: 'claude-code',
    // Cheap yet effective defaults: dictation cleanup doesn't need frontier models. Compose writes
    // freely from a brief, and sonnet stays faithful to it where haiku sometimes embellishes.
    // Control sees the screen and acts on it: the compose model unless set.
    claudeCode: { path: '', home: '', model: 'haiku', composeModel: 'sonnet', controlModel: '', effort: 'medium' },
    codex: { path: '', home: '', model: 'gpt-6-luna', composeModel: '', controlModel: '', effort: 'medium' },
    customInstructions: '',
    timeoutSeconds: 90
  },
  history: { enabled: true, keepAudio: true, retentionDays: 90 },
  control: {
    scope: 'app',
    approval: 'plan',
    alwaysAsk: { money: true, secrets: true, delete: true, send: true },
    speak: false,
    idleMinutes: 30,
    handsSeconds: 2
  },
  ui: { showOverlay: true, launchAtLogin: false, easterEggs: true, themeOff: '', lastVersion: '' },
  updates: { auto: true }
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
