import { app, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { LANGUAGES, languageName, STYLES } from '../shared/constants'
import type { Phase } from '../shared/types'
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

function prettyShortcut(accel: string): string {
  return accel.replace('CommandOrControl', isMac ? 'Cmd' : 'Ctrl')
}

function buildMenu(phase: Phase): Menu {
  const cfg = configStore.get()
  const busy = phase !== 'idle'
  const outputLanguages = ['same', 'en', 'fr', ...LANGUAGES.map((l) => l.code).filter((c) => c !== 'en' && c !== 'fr')].slice(0, 8)
  const update = updater.state
  return Menu.buildFromTemplate([
    ...(update.status === 'downloaded'
      ? ([{ label: `Restart to update (${update.latest})`, click: () => updater.install() }, { type: 'separator' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: phase === 'recording' ? 'Stop recording' : busy ? 'Working…' : 'Start dictation',
      accelerator: prettyShortcut(cfg.shortcuts.record),
      enabled: phase === 'idle' || phase === 'recording',
      click: () => controller.toggle()
    },
    { label: 'Cancel', visible: busy, click: () => controller.cancel() },
    { type: 'separator' },
    {
      label: `Style: ${STYLES.find((s) => s.id === cfg.style)?.label}`,
      submenu: STYLES.map((s) => ({ label: s.label, type: 'radio', checked: cfg.style === s.id, click: () => configStore.update({ style: s.id }) }))
    },
    {
      label: `Output language: ${languageName(cfg.language.output)}`,
      submenu: outputLanguages.map((code) => ({
        label: languageName(code),
        type: 'radio',
        checked: cfg.language.output === code,
        click: () => configStore.update({ language: { output: code } })
      }))
    },
    {
      label: 'After dictation',
      submenu: [
        {
          label: 'Show preview dialog',
          type: 'radio',
          checked: cfg.output.mode === 'preview',
          click: () => configStore.update({ output: { mode: 'preview' } })
        },
        { label: 'Paste directly', type: 'radio', checked: cfg.output.mode === 'paste', click: () => configStore.update({ output: { mode: 'paste' } }) }
      ]
    },
    { type: 'separator' },
    { label: 'Copy last result', enabled: !!controller.lastResult(), click: () => void copyToClipboard(controller.lastResult()) },
    { label: 'History…', click: () => showMain('history') },
    { label: 'Settings…', click: () => showMain('general') },
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
