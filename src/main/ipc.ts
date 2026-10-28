import { app, clipboard, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { RELEASES_URL } from '../shared/constants'
import type { AgentId, BinaryVariant, Config, DeepPartial, MainSection, PermissionStatus, RecordingAction, Style } from '../shared/types'
import { agentLogin, agentModels, agentStatus, testAi } from './ai'
import { configStore } from './config'
import { controller } from './controller'
import { downloads } from './download'
import { history } from './history'
import { hotkeys } from './hotkeys'
import { paths } from './paths'
import { accessibilityTrusted, keyboardHookAvailable, startKeyboardHook } from './platform/keyboard'
import { seasons } from './season'
import { engine } from './stt/engine'
import { updater } from './updater'
import { isMac, isWayland } from './util'
import { broadcast, mainWindow, setOverlayInteractive, showMain } from './windows'

function permissions(): PermissionStatus {
  return {
    microphone: isMac || process.platform === 'win32' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
    accessibility: accessibilityTrusted(false),
    hookAvailable: keyboardHookAvailable(),
    wayland: isWayland
  }
}

export function registerIpc(): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(`speak:${channel}`, (_e, ...args) => fn(...args))
  const on = (channel: string, fn: (...args: any[]) => void) => ipcMain.on(`speak:${channel}`, (_e, ...args) => fn(...args))

  // App
  handle('getSeason', () => seasons.current)
  handle('getInfo', () => ({ version: app.getVersion(), platform: process.platform, dataDir: paths.home, shortcutError: hotkeys.error }))
  on('openMain', (section?: MainSection) => showMain(section))
  on('openDataDir', () => void shell.openPath(paths.home))
  on('openSoundSettings', () => {
    if (process.platform === 'win32') void shell.openExternal('ms-settings:sound')
    else if (isMac) void shell.openExternal('x-apple.systempreferences:com.apple.Sound-Settings.extension')
  })
  on('openExternal', (url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  // Updates
  handle('getUpdateState', () => updater.state)
  on('checkForUpdates', () => void updater.check())
  on('downloadUpdate', () => void updater.download())
  on('installUpdate', () => void updater.install())
  on('openReleases', () => void shell.openExternal(RELEASES_URL))

  // Config
  handle('getConfig', () => configStore.get())
  handle('setConfig', (patch: DeepPartial<Config>) => {
    configStore.update(patch)
    return configStore.get()
  })
  on('suspendShortcuts', (suspended: boolean) => hotkeys.suspend(suspended))
  handle('getPermissions', () => permissions())
  handle('requestPermission', async (kind: 'microphone' | 'accessibility') => {
    if (kind === 'microphone' && isMac) await systemPreferences.askForMediaAccess('microphone')
    if (kind === 'accessibility' && isMac) {
      accessibilityTrusted(true)
      startKeyboardHook()
    }
    return permissions()
  })

  // Engine
  handle('getEngineStatus', () => engine.status())
  handle('installBinary', (variant: BinaryVariant) => engine.installBinary(variant))
  handle('installModel', (id: string) => engine.installModel(id))
  handle('deleteModel', (id: string) => engine.deleteModel(id))
  on('cancelDownload', (id: string) => downloads.cancel(id))

  // AI
  handle('getAgentStatus', (id: AgentId, refresh?: boolean) => agentStatus(id, !!refresh))
  handle('openAgentLogin', (id: AgentId) => agentLogin(id))
  handle('listAgentModels', (id: AgentId) => agentModels(id))
  handle('testAi', () => testAi())

  // Dictation
  on('toggleRecording', () => controller.toggle())
  on('cancel', () => controller.cancel())

  // History
  handle('listSessions', (query?: string, limit?: number) => history.list(query, limit))
  handle('getSessionAudio', async (id: string) => {
    const buf = await history.audio(id)
    return buf ? new Uint8Array(buf) : null
  })
  handle('deleteSession', (id: string) => history.delete(id))
  handle('historyStats', () => history.stats())
  handle('clearHistory', async () => {
    const { count } = await history.stats()
    if (!count) return false
    const what = count === 1 ? 'your dictation' : `all ${count} dictations`
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Delete history',
      message: `Delete ${what} and ${count === 1 ? 'its recording' : 'their recordings'}?`,
      detail: "This can't be undone. Your settings, speech models and engine are kept.",
      buttons: ['Cancel', 'Delete all'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }
    const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
    if (response !== 1) return false
    await history.clear()
    return true
  })
  handle('reprocessSession', (id: string, style: Style, outputLanguage: string, inputLanguage?: string) =>
    controller.reprocessHistory(id, style, outputLanguage, inputLanguage)
  )
  on('revealSession', (id: string) => shell.showItemInFolder(`${history.dir(id)}/session.json`))
  on('copyText', (text: string) => void clipboard.writeText(text))

  // Preview dialog
  on('previewReady', () => controller.previewReady())
  on('previewInsert', (text: string) => void controller.previewInsert(text))
  on('previewCopy', (text: string) => void controller.previewCopy(text))
  on('previewCancel', () => void controller.previewCancel())
  on('previewReprocess', (style: Style, outputLanguage: string) => void controller.previewReprocess(style, outputLanguage))
  on('previewRetranscribe', (language: string) => void controller.previewRetranscribe(language))
  on('previewVoiceEdit', () => controller.previewVoiceEdit())
  on('previewUndo', () => void controller.previewUndo())

  // Recorder
  on('recorderStarted', (ok: boolean, error?: string, device?: string) => controller.recorderStarted(ok, error, device))
  on('recorderNoSignal', (device: string) => controller.recorderNoSignal(device))
  on('overlayInteractive', (interactive: boolean) => setOverlayInteractive(interactive))
  on('recordingAction', (action: RecordingAction) => controller.recordingAction(action))
  on('recorderResult', (reqId: number, samples: Float32Array | null, error?: string) => controller.recorderResult(reqId, samples, error))

  // Push events
  downloads.on('progress', (p) => broadcast('download', p))
  history.on('changed', () => broadcast('historyChanged'))
  updater.on('change', (s) => broadcast('update', s))
  configStore.on('change', () => broadcast('config', configStore.get()))
}
