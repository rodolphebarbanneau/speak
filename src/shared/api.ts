import type {
  UpdateState,
  AgentId,
  AgentModel,
  AgentStatus,
  AiTestResult,
  AppInfo,
  BinaryVariant,
  Config,
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

/** API exposed to renderers as `window.speak` by the preload script. */
export interface SpeakApi {
  platform: string

  // App
  getInfo(): Promise<AppInfo>
  openMain(section?: MainSection): void
  openDataDir(): void
  openExternal(url: string): void
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
  onOverlay(cb: (s: OverlayState) => void): () => void

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
  /** Pill buttons: finish (process), cancel or pause the recording, or switch it to compose or dictation. */
  recordingAction(action: RecordingAction): void
}
