import type { AgentModel, Config, Style } from './types'

/** Releases are published here; the updater reads them through electron-builder's update manifests. */
export const RELEASES_URL = 'https://github.com/rodolphebarbanneau/speak/releases'

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
/** Styles for plain dictation; compose has its own shortcut. */
export const DICTATION_STYLES = STYLES.filter((s) => s.id !== 'compose')

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
  // Compose is the dictation shortcut plus Alt (⌥).
  shortcuts: { record: 'CommandOrControl+Shift+Space', compose: 'CommandOrControl+Shift+Alt+Space', cancel: 'Escape' },
  recordMode: 'hybrid',
  // The result stays on the clipboard, so Ctrl+V pastes it again if the app ignored Speak's paste.
  output: { mode: 'preview', restoreClipboard: false, pasteKeys: 'auto' },
  language: { input: 'auto', output: 'same' },
  style: 'clean',
  vocabulary: '',
  compose: { useSelection: true },
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
    claudeCode: { path: '', model: 'haiku', composeModel: 'sonnet', effort: 'medium' },
    codex: { path: '', model: 'gpt-6-luna', composeModel: '', effort: 'medium' },
    customInstructions: '',
    timeoutSeconds: 90
  },
  history: { enabled: true, keepAudio: true, retentionDays: 90 },
  ui: { showOverlay: true, launchAtLogin: false },
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
