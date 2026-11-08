import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SpeakApi } from '../shared/api'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`speak:${channel}`, ...args)
const send = (channel: string, ...args: unknown[]) => ipcRenderer.send(`speak:${channel}`, ...args)
const listen =
  <T>(channel: string) =>
  (cb: (payload: T) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
    ipcRenderer.on(`speak:${channel}`, handler)
    return () => ipcRenderer.removeListener(`speak:${channel}`, handler)
  }

const api: SpeakApi = {
  platform: process.platform,

  getInfo: () => invoke('getInfo'),
  openMain: (section) => send('openMain', section),
  openDataDir: () => send('openDataDir'),
  openExternal: (url) => send('openExternal', url),
  prepareBugReport: (req) => invoke('prepareBugReport', req),
  cancelBugReport: () => send('cancelBugReport'),
  windowError: (view, message) => send('windowError', view, message),
  openSoundSettings: () => send('openSoundSettings'),
  onNavigate: listen('navigate'),
  onLoading: listen('loading'),
  loaderReady: () => send('loaderReady'),
  getSeason: () => invoke('getSeason'),
  onSeason: listen('season'),

  getUpdateState: () => invoke('getUpdateState'),
  checkForUpdates: () => send('checkForUpdates'),
  downloadUpdate: () => send('downloadUpdate'),
  installUpdate: () => send('installUpdate'),
  openReleases: () => send('openReleases'),
  onUpdate: listen('update'),

  getConfig: () => invoke('getConfig'),
  setConfig: (patch) => invoke('setConfig', patch),
  onConfig: listen('config'),
  suspendShortcuts: (suspended) => send('suspendShortcuts', suspended),
  getPermissions: () => invoke('getPermissions'),
  requestPermission: (kind) => invoke('requestPermission', kind),

  getEngineStatus: () => invoke('getEngineStatus'),
  installBinary: (variant) => invoke('installBinary', variant),
  installModel: (id) => invoke('installModel', id),
  deleteModel: (id) => invoke('deleteModel', id),
  cancelDownload: (id) => send('cancelDownload', id),
  onDownload: listen('download'),

  getAgentStatus: (id, refresh) => invoke('getAgentStatus', id, refresh),
  openAgentLogin: (id) => invoke('openAgentLogin', id),
  listAgentModels: (id) => invoke('listAgentModels', id),
  testAi: () => invoke('testAi'),

  toggleRecording: () => send('toggleRecording'),
  cancel: () => send('cancel'),
  getOverlayState: () => invoke('getOverlayState'),
  onOverlay: listen('overlay'),

  chooseContext: (choice) => send('chooseContext', choice),
  addContext: (input, check) => invoke('addContext', input, check),
  addContextFromClipboard: () => invoke('addContextFromClipboard'),
  contextKeyboard: (on) => invoke('contextKeyboard', on),
  browseContextFolder: () => invoke('browseContextFolder'),
  removeContext: (location) => invoke('removeContext', location),
  clipboardInfo: () => invoke('clipboardInfo'),

  listSessions: (query, limit) => invoke('listSessions', query, limit),
  getSessionAudio: (id) => invoke('getSessionAudio', id),
  deleteSession: (id) => invoke('deleteSession', id),
  historyStats: () => invoke('historyStats'),
  clearHistory: () => invoke('clearHistory'),
  reprocessSession: (id, style, outputLanguage, inputLanguage) => invoke('reprocessSession', id, style, outputLanguage, inputLanguage),
  revealSession: (id) => send('revealSession', id),
  copyText: (text) => send('copyText', text),
  onHistoryChanged: listen('historyChanged'),

  onPreview: listen('preview'),
  previewReady: () => send('previewReady'),
  previewInsert: (text) => send('previewInsert', text),
  previewCopy: (text) => send('previewCopy', text),
  previewCancel: () => send('previewCancel'),
  previewReprocess: (style, outputLanguage) => send('previewReprocess', style, outputLanguage),
  previewRetranscribe: (language) => send('previewRetranscribe', language),
  previewVoiceEdit: () => send('previewVoiceEdit'),
  previewUndo: () => send('previewUndo'),

  onRecorderCommand: listen('recorder'),
  recorderStarted: (ok, error, device) => send('recorderStarted', ok, error, device),
  recorderNoSignal: (device) => send('recorderNoSignal', device),
  overlayInteractive: (interactive) => send('overlayInteractive', interactive),
  recordingAction: (action) => send('recordingAction', action),

  getControlState: () => invoke('getControlState'),
  onControl: listen('control'),
  controlAnswer: (id, decision, message) => send('controlAnswer', id, decision, message),
  controlPause: () => send('controlPause'),
  controlResume: () => send('controlResume'),
  controlStop: () => send('controlStop'),
  controlRestart: () => send('controlRestart'),
  controlEnd: () => send('controlEnd'),
  controlSend: (text) => send('controlSend', text),
  controlTalk: () => send('controlTalk'),
  controlUndo: (stepId) => send('controlUndo', stepId),
  controlGoNow: () => send('controlGoNow'),
  controlCollapse: (collapsed) => send('controlCollapse', collapsed),
  controlSetScope: (scope) => send('controlSetScope', scope),
  controlSetApproval: (approval) => send('controlSetApproval', approval),
  controlKeyboard: (on) => send('controlKeyboard', on),
  onControlSay: listen('controlSay'),
  onFrame: listen('frame'),
  recorderResult: (reqId, samples, error) => send('recorderResult', reqId, samples, error)
}

contextBridge.exposeInMainWorld('speak', api)
