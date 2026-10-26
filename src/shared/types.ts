export type RecordMode = 'hybrid' | 'toggle' | 'hold'
export type OutputMode = 'preview' | 'paste'
export type Style = 'verbatim' | 'clean' | 'prompt' | 'summary'
export type EngineId = 'whisper' | 'parakeet'
/** Coding-agent CLIs Speak can drive with the user's own login. */
export type AgentId = 'claude-code' | 'codex'
export type ProviderId = AgentId | 'none'
export type PasteKeys = 'auto' | 'ctrl+v' | 'ctrl+shift+v' | 'shift+insert'
export type BinaryVariant = 'cuda12' | 'cuda11' | 'cpu'
export type Effort = 'low' | 'medium' | 'high'

export interface Config {
  onboarded: boolean
  shortcuts: { record: string; cancel: string }
  recordMode: RecordMode
  output: { mode: OutputMode; restoreClipboard: boolean; pasteKeys: PasteKeys }
  /** input: 'auto' or an ISO 639-1 code. output: 'same' or an ISO 639-1 code. */
  language: { input: string; output: string }
  style: Style
  /** Preferred spellings of names and technical terms, one per line or comma separated. */
  vocabulary: string
  /** deviceId differs between origins (dev server vs packaged app), so the label is kept to find the device again. */
  audio: { deviceId: string; deviceLabel: string; maxSeconds: number; sounds: boolean }
  transcription: {
    engine: EngineId
    whisperModel: string
    parakeetModel: string
    useGpu: boolean
    vad: boolean
    keepLoadedMinutes: number
    threads: number
    /** Directory containing whisper-server / parakeet-cli. Empty = managed install or PATH. */
    customBinDir: string
  }
  ai: {
    provider: ProviderId
    claudeCode: AgentConfig
    codex: AgentConfig
    customInstructions: string
    timeoutSeconds: number
  }
  history: { enabled: boolean; keepAudio: boolean; retentionDays: number }
  ui: { showOverlay: boolean; launchAtLogin: boolean }
  /** Download updates in the background and install them when Speak quits. */
  updates: { auto: boolean }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export type VersionKind = 'processed' | 'edit' | 'manual'

export interface SessionVersion {
  id: string
  at: string
  kind: VersionKind
  text: string
  style?: Style
  outputLanguage?: string
  instruction?: string
  provider?: string
  model?: string
  ms?: number
}

export type SessionAction = 'inserted' | 'pasted' | 'copied' | 'cancelled'

export interface Session {
  id: string
  createdAt: string
  updatedAt: string
  durationMs: number
  hasAudio: boolean
  transcription: { engine: EngineId; model: string; language: string; ms: number; text: string }
  style: Style
  outputLanguage: string
  versions: SessionVersion[]
  /** Current text (latest version, or the raw transcript when no AI processing ran). */
  text: string
  error?: string
  action?: SessionAction
}

export type Phase = 'idle' | 'recording' | 'transcribing' | 'processing'

export interface OverlayState {
  phase: Phase | 'done' | 'error' | 'info'
  purpose?: 'dictation' | 'edit'
  message?: string
  startedAt?: number
}

export interface PreviewState {
  session: Session
  busy: null | 'listening' | 'transcribing' | 'processing'
  error?: string
  /** Title of the window the text will be inserted into, when known. */
  targetTitle?: string
}

export interface ModelInfo {
  id: string
  engine: EngineId
  file: string
  url: string
  label: string
  sizeMB: number
  note?: string
  installed: boolean
}

export interface BinaryOption {
  variant: BinaryVariant
  label: string
  sizeMB: number
  url: string
}

export interface EngineStatus {
  platform: string
  binary: { found: boolean; dir?: string; source?: 'custom' | 'managed' | 'bundled' | 'system'; variant?: string; hasParakeet: boolean }
  binaryOptions: BinaryOption[]
  recommendedVariant?: BinaryVariant
  platformNote?: string
  gpu: { nvidia: boolean; name?: string }
  models: ModelInfo[]
  vadInstalled: boolean
  serverRunning: boolean
}

export interface DownloadProgress {
  id: string
  label: string
  received: number
  total: number
  state: 'running' | 'extracting' | 'done' | 'error' | 'cancelled'
  error?: string
}

export interface AgentConfig {
  /** Path to the CLI; empty = find it automatically. */
  path: string
  model: string
  effort: Effort
}

export interface AgentStatus {
  found: boolean
  path?: string
  version?: string
  loggedIn?: boolean
  /** e.g. "you@example.com · max" or "chatgpt". */
  account?: string
  error?: string
}

export interface AgentModel {
  id: string
  label: string
}

export interface AiTestResult {
  ok: boolean
  text?: string
  error?: string
  ms?: number
  model?: string
}

export interface PermissionStatus {
  microphone: string
  accessibility: boolean | null
  hookAvailable: boolean
  wayland: boolean
}

export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'
  current: string
  latest?: string
  percent?: number
  error?: string
  checkedAt?: string
}

export interface AppInfo {
  version: string
  platform: string
  dataDir: string
  shortcutError?: string
}

export type RecorderCommand =
  | { type: 'start'; deviceId: string; deviceLabel: string; sounds: boolean }
  | { type: 'stop'; reqId: number }
  | { type: 'cancel' }
  | { type: 'sound'; name: 'start' | 'stop' | 'error' | 'done' }

export type MainSection = 'history' | 'general' | 'transcription' | 'ai' | 'about'
