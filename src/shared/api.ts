import type {
  UpdateState,
  AgentId,
  AgentModel,
  AgentStatus,
  AiTestResult,
  AppInfo,
  BinaryVariant,
  ClipboardInfo,
  Config,
  ContextSource,
  ControlApproval,
  ControlScope,
  ControlState,
  DeepPartial,
  DownloadProgress,
  EngineStatus,
  LoadingState,
  MainSection,
  OverlayState,
  PermissionStatus,
  PreviewState,
  RecorderCommand,
  RecordingAction,
  Session,
  Style
} from './types'
import type { Season } from '../themes/shared'
import type { BugReport, BugReportRequest } from './bug-report'

/** API exposed to renderers as `window.speak` by the preload script. */
export interface SpeakApi {
  platform: string

  // App
  getInfo(): Promise<AppInfo>
  openMain(section?: MainSection): void
  openDataDir(): void
  openExternal(url: string): void
  /** "report a bug": the report, scrubbed, analyzed by the AI provider if asked. Nothing is sent. */
  prepareBugReport(req: BugReportRequest): Promise<BugReport>
  /** Stop the analysis under way: the report comes without it. */
  cancelBugReport(): void
  /** A window's uncaught error, kept in memory for bug reports (never written to disk). */
  windowError(view: string, message: string): void
  /** Open the OS sound/input settings (Windows, macOS). */
  openSoundSettings(): void
  onNavigate(cb: (section: MainSection) => void): () => void
  /** The loading dialog's progress. */
  onLoading(cb: (state: LoadingState) => void): () => void
  /** The loading dialog listens: send it the progress. */
  loaderReady(): void
  /** The easter egg theme in season (themes/schedule.ts), if any. */
  getSeason(): Promise<Season | null>
  onSeason(cb: (season: Season | null) => void): () => void

  // Updates
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): void
  downloadUpdate(): void
  installUpdate(): void
  openReleases(): void
  onUpdate(cb: (s: UpdateState) => void): () => void

  // Config
  getConfig(): Promise<Config>
  setConfig(patch: DeepPartial<Config>): Promise<Config>
  onConfig(cb: (config: Config) => void): () => void
  suspendShortcuts(suspended: boolean): void
  getPermissions(): Promise<PermissionStatus>
  requestPermission(kind: 'microphone' | 'accessibility'): Promise<PermissionStatus>

  // Transcription engine
  getEngineStatus(): Promise<EngineStatus>
  installBinary(variant: BinaryVariant): Promise<void>
  installModel(id: string): Promise<void>
  deleteModel(id: string): Promise<void>
  cancelDownload(id: string): void
  onDownload(cb: (p: DownloadProgress) => void): () => void

  // AI
  getAgentStatus(id: AgentId, refresh?: boolean): Promise<AgentStatus>
  /** Opens a terminal running the CLI's own sign-in. */
  openAgentLogin(id: AgentId): Promise<void>
  listAgentModels(id: AgentId): Promise<AgentModel[]>
  testAi(): Promise<AiTestResult>

  // Dictation
  toggleRecording(): void
  cancel(): void
  /** What the pill shows now (its page asks when it loads, or comes back from an error). */
  getOverlayState(): Promise<OverlayState>
  onOverlay(cb: (s: OverlayState) => void): () => void

  // Context (read-only: a folder, a git repository, a web page, or the clipboard for one recording)
  /** '' for none, a recent context's location, or 'clipboard' (the recording in progress only). */
  chooseContext(choice: string): void
  /** Add a folder path, or a git or web address, as the context. `check`: read it first, and fail when that fails. */
  addContext(input: string, check?: boolean): Promise<ContextSource>
  /** The folder or address on the clipboard, made the context; null when there's none. */
  addContextFromClipboard(): Promise<ContextSource | null>
  /**
   * The pill takes the keyboard to type an address into it (the recording pauses meanwhile), or
   * gives it back to the app being dictated into.
   */
  contextKeyboard(on: boolean): Promise<void>
  /** Pick a folder with the system dialog and make it the context; null when cancelled. */
  browseContextFolder(): Promise<ContextSource | null>
  /** Forget a recent context, and delete Speak's copy of it (a clone, a page). */
  removeContext(location: string): Promise<void>
  /** What's on the clipboard, for the pill's context list. */
  clipboardInfo(): Promise<ClipboardInfo>

  // History
  listSessions(query?: string, limit?: number): Promise<Session[]>
  getSessionAudio(id: string): Promise<Uint8Array | null>
  deleteSession(id: string): Promise<void>
  /** Number of stored dictations and their size on disk. */
  historyStats(): Promise<{ count: number; bytes: number }>
  /** Asks for confirmation, then deletes every dictation. True when deleted. */
  clearHistory(): Promise<boolean>
  /** With another spoken language, transcribes the saved recording again first. */
  reprocessSession(id: string, style: Style, outputLanguage: string, inputLanguage?: string): Promise<Session>
  revealSession(id: string): void
  copyText(text: string): void
  onHistoryChanged(cb: () => void): () => void

  // Preview dialog
  onPreview(cb: (s: PreviewState) => void): () => void
  previewReady(): void
  previewInsert(text: string): void
  previewCopy(text: string): void
  previewCancel(): void
  previewReprocess(style: Style, outputLanguage: string): void
  /** Transcribe the recording again in another spoken language, then redo style and translation. */
  previewRetranscribe(language: string): void
  previewVoiceEdit(): void
  previewUndo(): void

  // Recorder (overlay window)
  onRecorderCommand(cb: (cmd: RecorderCommand) => void): () => void
  /** `device` is the label of the microphone actually opened. */
  recorderStarted(ok: boolean, error?: string, device?: string): void
  /** The microphone delivers digital silence (muted, or an idle virtual device). */
  recorderNoSignal(device: string): void
  recorderResult(reqId: number, samples: Float32Array | null, error?: string): void
  /** The pointer is over the pill: catch clicks there instead of passing them through. */
  overlayInteractive(interactive: boolean): void
  /** Pill buttons: finish (process), cancel or pause the recording, or switch its mode (dictate, compose, control). */
  recordingAction(action: RecordingAction): void

  // Control mode (the panel)
  getControlState(): Promise<ControlState>
  onControl(cb: (s: ControlState) => void): () => void
  /** Answer what it waits for: yes, always (this kind of action, this session), or no (with what to do instead). */
  controlAnswer(id: string, decision: 'yes' | 'always' | 'no', message?: string): void
  controlPause(): void
  controlResume(): void
  /** Interrupt what it does; the session stays for the next order. */
  controlStop(): void
  /** Stop, then give it the last order again. */
  controlRestart(): void
  controlEnd(): void
  /** An order typed in the panel. */
  controlSend(text: string): void
  /** Start or stop speaking to it (like the shortcut). */
  controlTalk(): void
  controlUndo(stepId: string): void
  /** It waits for your hands to be still: go now. */
  controlGoNow(): void
  controlCollapse(collapsed: boolean): void
  controlSetScope(scope: ControlScope): void
  controlSetApproval(approval: ControlApproval): void
  /** The panel takes the keyboard to type an order, or gives it back. */
  controlKeyboard(on: boolean): void
  /** Something to read aloud (answers, questions), when that's on. */
  onControlSay(cb: (text: string) => void): () => void
  /** The frame around where it acts: acting or waiting. */
  onFrame(cb: (tone: 'acting' | 'waiting') => void): () => void
}
