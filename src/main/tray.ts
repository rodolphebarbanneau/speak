import { app, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { CONTROL_APPROVALS, CONTROL_SCOPES, FORMATS, LANGUAGES, languageName, spokenLanguages } from '../shared/constants'
import type { OutputMode, Phase } from '../shared/types'
import { configStore } from './config'
import { currentSource, recentSources } from './context'
import { control } from './control'
import { controller } from './controller'
import { paths, resource } from './paths'
import { copyToClipboard } from './platform/paste'
import { isMac } from './util'
import { updater } from './updater'
import { showMain } from './windows'

let tray: Tray | null = null
let lastControl = ''

function icon(recording: boolean): Electron.NativeImage {
  if (isMac) {
    const img = nativeImage.createFromPath(resource(recording ? 'tray-mac-recording.png' : 'tray-mac-template.png'))
    if (!recording) img.setTemplateImage(true)
    return img
  }
  if (recording) return nativeImage.createFromPath(resource('tray-recording.png'))
  // White glyph on dark taskbars, black on light ones (Windows reports the taskbar theme separately).
  const dark = process.platform === 'win32' ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI : true
  return nativeImage.createFromPath(resource(dark ? 'tray-dark.png' : 'tray-light.png'))
}

function prettyShortcut(accel: string): string | undefined {
  return accel ? accel.replace('CommandOrControl', isMac ? 'Cmd' : 'Ctrl') : undefined
}

type Item = Electron.MenuItemConstructorOptions

/** A submenu of radio items, one per option. */
function choose<T extends string>(current: T, options: Array<[T, string]>, set: (value: T) => void): Item[] {
  return options.map(([value, label]) => ({ label, type: 'radio', checked: current === value, click: () => set(value) }))
}

/** What the recording, or the app, can do right now: the same as the pill's buttons while recording. */
function actions(phase: Phase): Item[] {
  const { shortcuts } = configStore.get()
  const recording = controller.recording
  if (recording) {
    return [
      { label: 'Finish recording', accelerator: prettyShortcut(shortcuts.record), click: () => controller.recordingAction('finish') },
      ...(recording.purpose === 'edit'
        ? []
        : [
            {
              label: recording.paused ? 'Resume recording' : 'Pause recording',
              click: () => controller.recordingAction(recording.paused ? 'resume' : 'pause')
            }
          ]),
      { label: 'Cancel recording', accelerator: prettyShortcut(shortcuts.cancel), click: () => controller.cancel() }
    ]
  }
  if (phase !== 'idle') {
    return [
      { label: phase === 'transcribing' ? 'Transcribing…' : 'Processing…', enabled: false },
      { label: 'Cancel', accelerator: prettyShortcut(shortcuts.cancel), click: () => controller.cancel() }
    ]
  }
  // A control session: talk to it, or end it.
  if (control.active) {
    return [
      { label: 'Talk to control', accelerator: prettyShortcut(shortcuts.control || shortcuts.record), click: () => controller.toggle('control') },
      { label: 'Stop what it does', click: () => control.stop() },
      { label: 'End control', click: () => void control.end() }
    ]
  }
  return [
    { label: 'Start dictation', accelerator: prettyShortcut(shortcuts.record), click: () => controller.toggle() },
    { label: 'Start composing', accelerator: prettyShortcut(shortcuts.compose), click: () => controller.toggle('compose') },
    { label: 'Start control', accelerator: prettyShortcut(shortcuts.control), click: () => controller.toggle('control') }
  ]
}

/** Control mode's defaults (and the session's, while one runs). */
function controlChoices(): Item {
  const cfg = configStore.get().control
  const active = control.active
  const scope = active ? control.state.scope : cfg.scope
  const approval = active ? control.state.approval : cfg.approval
  const scopeLabel = CONTROL_SCOPES.find((s) => s.id === scope)?.label ?? scope
  const approvalLabel = CONTROL_APPROVALS.find((a) => a.id === approval)?.label ?? approval
  return {
    label: `Control: ${scopeLabel}, asks ${approvalLabel}`,
    submenu: [
      { label: 'Scope', enabled: false },
      ...choose(
        scope,
        CONTROL_SCOPES.map((s) => [s.id, s.label]),
        (v) => (active ? control.setScope(v) : configStore.update({ control: { scope: v } }))
      ),
      { type: 'separator' },
      { label: 'Asks first', enabled: false },
      ...choose(
        approval,
        CONTROL_APPROVALS.map((a) => [a.id, a.label]),
        (v) => (active ? control.setApproval(v) : configStore.update({ control: { approval: v } }))
      ),
      { type: 'separator' },
      { label: 'Control settings…', click: () => showMain('control') }
    ]
  }
}

/**
 * The pill's choices: a format, language or output becomes the default and applies to the recording
 * in progress. While recording, the mode (dictate, compose, control) switches only that recording.
 */
function choices(): Item[] {
  const cfg = configStore.get()
  const recording = controller.recording
  const compose = recording?.purpose === 'compose'
  const format = FORMATS.find((s) => s.id === cfg.style)?.label
  const spoken = ['auto', ...spokenLanguages(cfg.transcription.engine).map((l) => l.code)]
  // A language the engine doesn't list stays visible, so the current choice is never hidden.
  if (!spoken.includes(cfg.language.input)) spoken.push(cfg.language.input)
  return [
    ...(recording && recording.purpose !== 'edit' && !recording.talk
      ? [
          {
            label: `Mode: ${recording.purpose === 'control' ? 'Control' : compose ? 'Compose' : 'Dictate'}`,
            submenu: [
              { label: 'Dictate', type: 'radio', checked: recording.purpose === 'dictation', click: () => controller.recordingAction('dictate') },
              { label: 'Compose', type: 'radio', checked: compose, click: () => controller.recordingAction('compose') },
              { label: 'Control', type: 'radio', checked: recording.purpose === 'control', click: () => controller.recordingAction('control') }
            ]
          } as Item
        ]
      : []),
    {
      label: `Format: ${format}`,
      submenu: FORMATS.map<Item>((s) => ({
        label: s.label,
        type: 'radio',
        checked: cfg.style === s.id,
        click: () => {
          configStore.update({ style: s.id })
          if (compose) controller.recordingAction('dictate')
        }
      }))
    },
    {
      label: `Spoken language: ${languageName(cfg.language.input)}`,
      submenu: choose(
        cfg.language.input,
        spoken.map((code) => [code, languageName(code)]),
        (input) => configStore.update({ language: { input } })
      )
    },
    {
      label: `Output language: ${languageName(cfg.language.output)}`,
      submenu: choose(
        cfg.language.output,
        ['same', ...LANGUAGES.map((l) => l.code)].map((code) => [code, languageName(code)]),
        (output) => configStore.update({ language: { output } })
      )
    },
    {
      label: `After dictation: ${cfg.output.mode === 'paste' ? 'Paste directly' : 'Show preview'}`,
      submenu: choose<OutputMode>(
        cfg.output.mode,
        [
          ['preview', 'Show preview'],
          ['paste', 'Paste directly']
        ],
        (mode) => configStore.update({ output: { mode } })
      )
    },
    context(),
    controlChoices()
  ]
}

/**
 * The context, as on the pill: none, a recent one (it stays), or the clipboard for the recording
 * in progress. The labels are the user's own folder and page names: no "&" shortcut markers.
 */
function context(): Item {
  const recording = controller.recording
  const clipboard = !!recording?.clipboard
  const current = currentSource()
  const label = (text: string) => text.replace(/&/g, '&&')
  return {
    label: `Context: ${clipboard ? 'Clipboard' : label(current?.label ?? 'None')}`,
    submenu: [
      { label: 'None', type: 'radio', checked: !clipboard && !current, click: () => controller.chooseContext('') },
      ...recentSources().map<Item>((s) => ({
        label: label(s.label),
        sublabel: s.kind === 'folder' ? undefined : s.kind,
        toolTip: s.location,
        type: 'radio',
        checked: !clipboard && current?.location === s.location,
        click: () => controller.chooseContext(s.location)
      })),
      ...(recording && recording.purpose !== 'edit'
        ? [{ label: 'Clipboard (this recording)', type: 'radio', checked: clipboard, click: () => controller.chooseContext('clipboard') } as Item]
        : []),
      { type: 'separator' },
      { label: 'Choose a folder…', click: () => void controller.browseContextFolder(null) },
      { label: 'Manage contexts…', click: () => showMain('context') }
    ]
  }
}

function buildMenu(phase: Phase): Menu {
  const cfg = configStore.get()
  const update = updater.state
  return Menu.buildFromTemplate([
    ...(update.status === 'downloaded'
      ? ([{ label: `Restart to update (${update.latest})`, click: () => void updater.install() }, { type: 'separator' }] as Item[])
      : []),
    ...actions(phase),
    { type: 'separator' },
    ...choices(),
    { type: 'separator' },
    { label: 'Sounds', type: 'checkbox', checked: cfg.audio.sounds, click: () => configStore.update({ audio: { sounds: !cfg.audio.sounds } }) },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: cfg.ui.launchAtLogin,
      click: () => configStore.update({ ui: { launchAtLogin: !cfg.ui.launchAtLogin } })
    },
    { type: 'separator' },
    { label: 'Copy last result', enabled: !!controller.lastResult(), click: () => void copyToClipboard(controller.lastResult()) },
    { label: 'History', click: () => showMain('history') },
    { label: 'Settings', click: () => showMain('general') },
    { label: 'Open data folder', click: () => void shell.openPath(paths.home) },
    { label: 'Report a bug…', click: () => showMain('bug') },
    { type: 'separator' },
    { label: 'Quit Speak', click: () => app.quit() }
  ])
}

export function createTray(): Tray {
  tray = new Tray(icon(false))
  tray.setToolTip('Speak')
  const refresh = () => {
    if (!tray) return
    const phase = controller.phase
    tray.setImage(icon(phase === 'recording'))
    tray.setToolTip(phase === 'idle' ? 'Speak' : `Speak — ${phase}…`)
    tray.setContextMenu(buildMenu(phase))
  }
  refresh()
  controller.on('phase', refresh)
  control.on('change', () => {
    // The tray follows the session's scope, approval and whether it runs, not every step.
    const key = `${control.active}|${control.state.scope}|${control.state.approval}`
    if (key !== lastControl) {
      lastControl = key
      refresh()
    }
  })
  configStore.on('change', refresh)
  nativeTheme.on('updated', refresh)
  updater.on('change', refresh)
  if (!isMac) tray.on('click', () => showMain('history'))
  return tray
}
