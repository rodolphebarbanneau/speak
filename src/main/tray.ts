import { app, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { DICTATION_STYLES, LANGUAGES, languageName, spokenLanguages, STYLES } from '../shared/constants'
import type { OutputMode, Phase } from '../shared/types'
import { configStore } from './config'
import { controller } from './controller'
import { paths, resource } from './paths'
import { copyToClipboard } from './platform/paste'
import { isMac } from './util'
import { updater } from './updater'
import { showMain } from './windows'

let tray: Tray | null = null

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
  return [
    { label: 'Start dictation', accelerator: prettyShortcut(shortcuts.record), click: () => controller.toggle() },
    { label: 'Start composing', accelerator: prettyShortcut(shortcuts.compose), click: () => controller.toggle('compose') }
  ]
}

/**
 * The pill's choices: a style, language or mode becomes the default and applies to the recording
 * in progress. While recording a dictation, compose switches only that recording.
 */
function choices(): Item[] {
  const cfg = configStore.get()
  const recording = controller.recording
  const compose = recording?.purpose === 'compose'
  const style = compose ? 'Compose' : STYLES.find((s) => s.id === cfg.style)?.label
  const spoken = ['auto', ...spokenLanguages(cfg.transcription.engine).map((l) => l.code)]
  // A language the engine doesn't list stays visible, so the current choice is never hidden.
  if (!spoken.includes(cfg.language.input)) spoken.push(cfg.language.input)
  return [
    {
      label: `Style: ${style}`,
      submenu: [
        ...DICTATION_STYLES.map<Item>((s) => ({
          label: s.label,
          type: 'radio',
          checked: !compose && cfg.style === s.id,
          click: () => {
            configStore.update({ style: s.id })
            if (compose) controller.recordingAction('dictate')
          }
        })),
        ...(recording && recording.purpose !== 'edit'
          ? [{ label: 'Compose (this recording)', type: 'radio', checked: compose, click: () => controller.recordingAction('compose') } as Item]
          : [])
      ]
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
    }
  ]
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
  configStore.on('change', refresh)
  nativeTheme.on('updated', refresh)
  updater.on('change', refresh)
  if (!isMac) tray.on('click', () => showMain('history'))
  return tray
}
