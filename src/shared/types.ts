export type RecordMode = 'hybrid' | 'toggle' | 'hold'
export type OutputMode = 'preview' | 'paste'
/**
 * What Speak does with what you say. dictate: writes what you said (in a format) · compose: writes
 * what you ask for · control: does what you ask, on the computer. Each has its own shortcut.
 */
export type Mode = 'dictate' | 'compose' | 'control'
/**
 * A dictation's format (verbatim, clean, prompt = structured, summary), or compose for a brief the
 * AI writes from: dictations saved with it keep it, and history can redo one as the other.
 */
export type Style = 'verbatim' | 'clean' | 'prompt' | 'summary' | 'compose'
export type EngineId = 'whisper' | 'parakeet'
/** Coding-agent CLIs Speak can drive with the user's own login. */
export type AgentId = 'claude-code' | 'codex'
export type ProviderId = AgentId | 'none'
export type PasteKeys = 'auto' | 'ctrl+v' | 'ctrl+shift+v' | 'shift+insert'
export type BinaryVariant = 'cuda12' | 'cuda11' | 'cpu'
export type Effort = 'low' | 'medium' | 'high'

/**
 * Where a dictation's context comes from: a folder, a git repository (cloned by Speak), a web
 * page (copied by Speak) or the clipboard. The AI only ever reads it: nothing is written there.
 */
export type ContextKind = 'folder' | 'git' | 'url' | 'clipboard'

export interface ContextSource {
  kind: ContextKind
  /** folder: its absolute path · git, url: the address · clipboard: "clipboard". */
  location: string
  /** Short name: the folder's, the repository's (owner/name), the page's address without https://. */
  label: string
}

export interface Config {
  onboarded: boolean
  /** record: dictate · compose: dictate a brief the AI writes from · control: an order the AI carries out (empty = off). */
  shortcuts: { record: string; compose: string; control: string; cancel: string }
  recordMode: RecordMode
  output: { mode: OutputMode; restoreClipboard: boolean; pasteKeys: PasteKeys }
  /** input: 'auto' or an ISO 639-1 code. output: 'same' or an ISO 639-1 code. */
  language: { input: string; output: string }
  style: Style
  /** Preferred spellings of names and technical terms, one per line or comma separated. */
  vocabulary: string
  /**
   * The context the AI reads along with what you say. current: the location of a recent source,
   * '' = none; it stays until changed. recent: the sources used, most recent first. The clipboard
   * is never stored: it is picked for one recording at a time.
   */
  context: { current: string; recent: ContextSource[] }
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
  /** Control mode: what a new control session may touch, and when it asks first (both can change during it). */
  control: ControlConfig
  /**
   * easterEggs: allow the seasonal themes (src/themes/schedule.ts). themeOff: the season of the
   * theme the user turned off by clicking its logo ("christmas-2026"), off until the next season.
   * lastVersion: the version that last started, to tell when an update was just installed.
   */
  ui: { showOverlay: boolean; launchAtLogin: boolean; easterEggs: boolean; themeOff: string; lastVersion: string }
  /** Download updates in the background and install them when Speak quits. */
  updates: { auto: boolean }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** transcribed: the recording transcribed again in another spoken language, then processed. */
export type VersionKind = 'processed' | 'transcribed' | 'edit' | 'manual'

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
  /** transcribed: the spoken language it was transcribed in. */
  inputLanguage?: string
  /** transcribed: the transcription it replaced, which undo restores. */
  previous?: Transcription
}

export interface Transcription {
  engine: EngineId
  model: string
  /** The spoken language setting: 'auto' or an ISO 639-1 code. */
  language: string
  /** The language whisper heard, when it was auto-detected (ISO code, or its English name). */
  detected?: string
  ms: number
  text: string
}

/** closed: the preview window was closed (✕, ⌘W) without choosing an action; kept in the history. */
export type SessionAction = 'inserted' | 'pasted' | 'copied' | 'cancelled' | 'closed'

export interface Session {
  id: string
  createdAt: string
  updatedAt: string
  durationMs: number
  hasAudio: boolean
  transcription: Transcription
  style: Style
  outputLanguage: string
  versions: SessionVersion[]
  /** Current text (latest version, or the raw transcript when no AI processing ran). */
  text: string
  /** The context the AI was given: where it came from. */
  source?: ContextSource
  /**
   * Text given to the AI as context: the clipboard's, when it was the source. Dictations made
   * before contexts existed have the text that was selected when composing, and no source.
   */
  context?: string
  /** Why the context could not be read: the dictation went on without it. */
  contextError?: string
  error?: string
  action?: SessionAction
  /** A control session (text: what you asked first; the steps are here). */
  control?: ControlRecord
}

export type Phase = 'idle' | 'recording' | 'transcribing' | 'processing'

/** What the pill's buttons do to the recording in progress: dictate, compose and control switch its mode. */
export type RecordingAction = 'finish' | 'cancel' | 'pause' | 'resume' | Mode

export interface OverlayState {
  phase: Phase | 'done' | 'error' | 'info'
  /** control: an order for control mode, or (talk) something said to the control session under way. */
  purpose?: 'dictation' | 'compose' | 'edit' | 'control'
  /** Recording for the control session under way: what's said goes to it. */
  talk?: boolean
  /** Recording an order for a new control session: the app it would act on (app scope). */
  target?: string
  message?: string
  /** Recording: when it started, moved forward by the time spent paused. */
  startedAt?: number
  /** Recording: set while paused, since when. */
  pausedAt?: number
  /** Recording: this dictation takes the clipboard as its context, instead of the chosen one. */
  clipboard?: boolean
}

/** What is on the clipboard, for the pill's context list. */
export interface ClipboardInfo {
  /** Characters of text (0: none). */
  chars: number
  /** The text is a folder path, or a git or web address, that can be added as a context. */
  source?: ContextSource
}

/** The loading dialog: a few steps (starting, updating), the one in progress under the bar. */
export interface LoadingState {
  /** What is happening: "starting speak 0.2.8", "updating to 0.2.9"… */
  title: string
  /** Steps finished, of `total`. */
  done: number
  total: number
  /** The step in progress. */
  item: string
  /** What happens next, under the status. */
  note?: string
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
  /** Path to the CLI executable; empty = find it automatically. */
  path: string
  /**
   * The CLI's home folder (settings and sign-in: CLAUDE_CONFIG_DIR / CODEX_HOME), to use another
   * account, e.g. ~/.claude_ai; empty = the CLI's default (~/.claude, ~/.codex).
   */
  home: string
  /** Model for dictation (cleanup, translation, edits). */
  model: string
  /** Model for compose, where staying faithful to the brief matters most; empty = `model`. */
  composeModel: string
  /** Model for control sessions, which see the screen and act; empty = the compose model. */
  controlModel: string
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
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'sound'; name: 'start' | 'stop' | 'error' | 'done' }

/** bug: "report a bug", from the title row's bug or the tray. */
export type MainSection = 'history' | 'general' | 'transcription' | 'ai' | 'context' | 'control' | 'about' | 'bug'

// ------------------------------------------------------------------ control mode

/**
 * What a control session may touch. app: the windows of one app (the one in front when it
 * started) · screen: any window, no files or commands · full: everything, files and commands included.
 */
export type ControlScope = 'app' | 'screen' | 'full'

/**
 * When it asks first. step: before every action · plan: once, for its plan, then again only for
 * a risky step or one off the plan · risky: only before risky actions · never: never, except for
 * the always-ask list.
 */
export type ControlApproval = 'step' | 'plan' | 'risky' | 'never'

/** Actions that ask first whatever the approval level, while on. */
export interface ControlAlwaysAsk {
  /** Paying, buying, ordering, transferring money. */
  money: boolean
  /** Passwords, security and account settings. */
  secrets: boolean
  /** Deleting for good (Speak's own trash can be undone and doesn't count). */
  delete: boolean
  /** Sending, posting or publishing as you: emails, messages, comments. */
  send: boolean
}

export interface ControlConfig {
  scope: ControlScope
  approval: ControlApproval
  alwaysAsk: ControlAlwaysAsk
  /** Read the AI's answers and questions aloud. */
  speak: boolean
  /** The session ends after this long with nothing to do. */
  idleMinutes: number
  /**
   * What needs the real mouse or keyboard waits until the user's hands have been still this long
   * (seconds), then gives them back.
   */
  handsSeconds: number
}

/**
 * listening: you're speaking to it · thinking, acting: it works · waiting: it waits for your answer ·
 * hands: it waits for your hands to be still, to borrow the mouse or the keyboard · idle: done.
 */
export type ControlStatus = 'starting' | 'listening' | 'thinking' | 'acting' | 'waiting' | 'hands' | 'paused' | 'idle' | 'ended'

/** look: only looks or reads · change: changes something that can be undone or redone · risky: hard to take back. */
export type ControlRisk = 'look' | 'change' | 'risky'

export interface ControlStep {
  id: string
  at: number
  /** you: what you said · ai: what it says · action: something it does · info, error: from Speak. */
  who: 'you' | 'ai' | 'action' | 'info' | 'error'
  text: string
  /** More: a command, a path, the text typed, a plan's steps. */
  detail?: string
  risk?: ControlRisk
  state?: 'running' | 'done' | 'failed' | 'rejected' | 'undone'
  /** It can be undone from the panel (a file moved, written or put in Speak's trash). */
  undoable?: boolean
  /** What it saw (a small screenshot), for [see]. */
  image?: string
}

/** Something it waits for you on: an action to approve, its plan, a wider scope, or a question. */
export interface ControlAsk {
  id: string
  kind: 'action' | 'plan' | 'question' | 'scope'
  title: string
  detail?: string
  /** plan: its steps. */
  steps?: string[]
  risk?: ControlRisk
  /** Why it asks although the level wouldn't: an always-ask item. */
  because?: string
  /** "always" is offered: approve this kind of action for the rest of the session. */
  always?: boolean
  /** Where it will act, boxed on its latest look (a data URL). */
  image?: string
}

export interface ControlState {
  active: boolean
  id: string
  status: ControlStatus
  scope: ControlScope
  /** The app, "screen" or "everything". */
  scopeLabel: string
  approval: ControlApproval
  /** The AI driving it: "claude code · sonnet". */
  agent: string
  startedAt: number
  steps: ControlStep[]
  ask?: ControlAsk
  /** What waits for your hands to be still (it needs the real mouse or keyboard): "click Send". */
  hands?: string
  /** You're speaking to it (the pill records). */
  listening: boolean
  /** The panel is reduced to its title row. */
  collapsed: boolean
  /** Why it stopped, or can't start (no AI provider, no app in front…). */
  error?: string
}

/** A control session, as the history keeps it. */
export interface ControlRecord {
  scope: ControlScope
  scopeLabel: string
  approval: ControlApproval
  agent: string
  steps: ControlStep[]
}
