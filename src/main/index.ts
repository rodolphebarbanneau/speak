import { readFileSync } from 'node:fs'
import { app, Notification, session } from 'electron'
import type { Config } from '../shared/types'
import { decodeWav } from './audio'
import { configStore } from './config'
import { controller } from './controller'
import { history } from './history'
import { hotkeys } from './hotkeys'
import { registerIpc } from './ipc'
import { log } from './log'
import { ensureDirs } from './paths'
import { setLaunchAtLogin } from './platform/autostart'
import { startKeyboardHook, stopKeyboardHook } from './platform/keyboard'
import { engine } from './stt/engine'
import { createTray } from './tray'
import { updater } from './updater'
import { isMac, isWin, loadShellEnv } from './util'
import { createOverlay, createPreview, showMain } from './windows'

/*
 * Command line (also forwarded to the running instance):
 *   --toggle | --start | --stop | --cancel   control dictation (bind these to desktop shortcuts on Wayland)
 *   --show                                    open the main window
 *   --hidden                                  start in the tray (used by launch-at-login)
 *   --file=<audio.wav>                        run the pipeline on a WAV file (debugging)
 */
function handleArgs(argv: string[]): void {
  const has = (flag: string) => argv.includes(flag)
  // Chromium reorders forwarded arguments, so values must use the --flag=value form.
  const file = argv.find((a) => a.startsWith('--file='))?.slice('--file='.length)
  if (has('--toggle')) controller.toggle()
  else if (has('--start') && controller.phase === 'idle') controller.toggle()
  else if (has('--stop') && controller.phase === 'recording') controller.toggle()
  else if (has('--cancel')) controller.cancel()
  else if (file) {
    try {
      void controller.runFile(decodeWav(readFileSync(file)))
    } catch (err) {
      log.error('Could not read --file:', err)
    }
  } else if (!has('--hidden')) showMain('history')
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => handleArgs(argv))
  // Windows takes the taskbar icon from the Start menu shortcut registered for this ID (Electron
  // writes one on the first notification). Dev runs (electron.exe) get their own ID so they never
  // share the installed app's shortcut, icon or pinning.
  if (isWin) app.setAppUserModelId(app.isPackaged ? 'io.github.rodolphebarbanneau.speak' : 'io.github.rodolphebarbanneau.speak.dev')
  // Tray app: keep running with no windows open.
  app.on('window-all-closed', () => undefined)

  app.whenReady().then(async () => {
    ensureDirs()
    log.info(`Speak ${app.getVersion()} starting (${process.platform}-${process.arch}, electron ${process.versions.electron})`)
    await loadShellEnv()
    const config = configStore.load()
    if (isMac) app.dock?.hide()

    // Allow microphone access for our own pages only.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const local = wc.getURL().startsWith('file://') || wc.getURL().startsWith('http://localhost')
      callback(local && (permission === 'media' || permission === 'clipboard-sanitized-write'))
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write')

    registerIpc()
    createOverlay()
    createPreview()
    createTray()

    startKeyboardHook()
    applyShortcuts(config)
    hotkeys.on('press', () => controller.onShortcutPress())
    hotkeys.on('release', (ms: number) => controller.onShortcutRelease(ms))
    hotkeys.on('cancel', () => controller.cancel())

    configStore.on('change', (next: Config, prev: Config) => {
      if (next.shortcuts.record !== prev.shortcuts.record || next.shortcuts.cancel !== prev.shortcuts.cancel) applyShortcuts(next)
      if (next.ui.launchAtLogin !== prev.ui.launchAtLogin) setLaunchAtLogin(next.ui.launchAtLogin)
      if (JSON.stringify(next.transcription) !== JSON.stringify(prev.transcription)) engine.stopServer()
      if (next.updates.auto !== prev.updates.auto) updater.applyConfig()
    })

    updater.init()

    void history.prune()
    setInterval(() => void history.prune(), 6 * 3600_000).unref()

    handleArgs(process.argv)
  })

  app.on('will-quit', () => {
    engine.stopServer()
    stopKeyboardHook()
  })
}

function applyShortcuts(config: Config): void {
  const error = hotkeys.apply(config.shortcuts.record, config.shortcuts.cancel)
  if (error && Notification.isSupported())
    new Notification({ title: 'Speak shortcut unavailable', body: `${error} Change it in Speak → settings → general.` }).show()
}
