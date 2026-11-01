import { readFileSync } from 'node:fs'
import { app, Notification, session } from 'electron'
import type { Config } from '../shared/types'
import { themeShown } from '../themes/shared'
import { decodeWav } from './audio'
import { configStore } from './config'
import { controller } from './controller'
import { history } from './history'
import { hotkeys, type RecordAction } from './hotkeys'
import { registerIpc } from './ipc'
import { label, withLoading } from './loading'
import { log } from './log'
import { seasons } from './season'
import { ensureDirs } from './paths'
import { setLaunchAtLogin } from './platform/autostart'
import { startKeyboardHook, stopKeyboardHook } from './platform/keyboard'
import { engine } from './stt/engine'
import { createTray } from './tray'
import { updater } from './updater'
import { isLinux, isMac, isWayland, isWin, loadShellEnv } from './util'
import { applyChrome, broadcast, createOverlay, createPreview, showMain } from './windows'

/*
 * Command line (also forwarded to the running instance):
 *   --toggle | --start | --stop | --cancel   control dictation (bind these to desktop shortcuts on Wayland)
 *   --compose                                 start / stop a compose dictation (with --file: compose from the file)
 *   --show                                    open the main window
 *   --hidden                                  start in the tray (used by launch-at-login)
 *   --file=<audio.wav>                        run the pipeline on a WAV file (debugging)
 */
function handleArgs(argv: string[]): void {
  const has = (flag: string) => argv.includes(flag)
  // Chromium reorders forwarded arguments, so values must use the --flag=value form.
  const file = argv.find((a) => a.startsWith('--file='))?.slice('--file='.length)
  if (has('--toggle')) controller.toggle()
  else if (has('--compose') && !file) controller.toggle('compose')
  else if (has('--start') && controller.phase === 'idle') controller.toggle()
  else if (has('--stop') && controller.phase === 'recording') controller.toggle()
  else if (has('--cancel')) controller.cancel()
  else if (file) {
    try {
      void controller.runFile(decodeWav(readFileSync(file)), { compose: has('--compose') })
    } catch (err) {
      log.error('Could not read --file:', err)
    }
  } else if (!has('--hidden')) showMain('history')
}

/**
 * Linux, in a Wayland session: since Electron 38, Speak runs as a native Wayland client, and Wayland
 * lets no ordinary window stay above the others, place itself, or show without taking the focus.
 * The pill then opened behind the app being dictated into, or wherever the compositor put it
 * (tiled, on Hyprland), if at all. Through XWayland it floats at the bottom of the screen, above
 * everything, without the focus, as on X11. So start again there, unless the command line already
 * chose (`--ozone-platform=wayland` keeps the native client) or there is no XWayland ($DISPLAY).
 */
function relaunchOnXWayland(): boolean {
  if (!isLinux || !isWayland || !app.isPackaged || !process.env.DISPLAY) return false
  if (process.argv.some((a) => a.startsWith('--ozone-platform'))) return false
  if (app.commandLine.getSwitchValue('ozone-platform') === 'x11') return false
  // An AppImage runs from a mount that goes away with this process: start the AppImage itself again.
  app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args: [...process.argv.slice(1), '--ozone-platform=x11'] })
  app.exit(0)
  return true
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else if (relaunchOnXWayland()) {
  // Starting again through XWayland.
} else {
  app.on('second-instance', (_e, argv) => handleArgs(argv))
  // Windows takes the taskbar icon from the Start menu shortcut registered for this ID (Electron
  // writes one on the first notification). Dev runs (electron.exe) get their own ID so they never
  // share the installed app's shortcut, icon or pinning.
  if (isWin) app.setAppUserModelId(app.isPackaged ? 'io.github.rodolphebarbanneau.speak' : 'io.github.rodolphebarbanneau.speak.dev')
  // Tray app: keep running with no windows open.
  app.on('window-all-closed', () => undefined)
  // A window's page, or Chromium's GPU process, gone: logged for bug reports (the pill's page reloads, see windows.ts).
  app.on('render-process-gone', (_e, contents, d) => {
    if (d.reason !== 'clean-exit') log.warn(`Page process gone (${contents.getURL().split('#')[1] || 'window'}): ${d.reason}, exit code ${d.exitCode}`)
  })
  app.on('child-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') log.warn(`${d.name ?? d.type} process gone: ${d.reason}, exit code ${d.exitCode}`)
  })

  app.whenReady().then(async () => {
    ensureDirs()
    const version = app.getVersion()
    const display = isLinux
      ? `, ${process.env.XDG_SESSION_TYPE || 'unknown'} session, ${app.commandLine.getSwitchValue('ozone-platform') || 'default'} display`
      : ''
    log.info(`Speak ${version} starting (${process.platform}-${process.arch}, electron ${process.versions.electron}${display})`)
    const config = configStore.load()
    seasons.start() // the easter egg theme in season, before any window takes its colors
    if (isMac) app.dock?.hide()
    // Right after "restart & update", say so: the new version shows up instead of reappearing silently.
    const updated = !!config.ui.lastVersion && config.ui.lastVersion !== version
    registerIpc() // first: the loading dialog asks for the settings (its theme)

    // A loading dialog shows only if startup is slow (or just updated). Speech models load later,
    // on the first dictation.
    await withLoading(
      updated ? `updated to ${version}` : `starting ${version}`,
      [
        [label('reading your environment', 'finding your tools'), () => loadShellEnv()],
        [
          label('opening windows', 'setting up the desk'),
          () => {
            // Allow microphone access for our own pages only.
            session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
              const local = wc.getURL().startsWith('file://') || wc.getURL().startsWith('http://localhost')
              callback(local && (permission === 'media' || permission === 'clipboard-sanitized-write'))
            })
            session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write')
            createOverlay()
            createPreview()
            createTray()
          }
        ],
        [
          label('connecting your shortcuts', 'listening for your shortcut'),
          () => {
            startKeyboardHook()
            applyShortcuts(config)
            hotkeys.on('press', (action: RecordAction) => controller.onShortcutPress(action))
            hotkeys.on('release', (ms: number) => controller.onShortcutRelease(ms))
            hotkeys.on('cancel', () => controller.cancel())
            configStore.on('change', (next: Config, prev: Config) => {
              if (JSON.stringify(next.shortcuts) !== JSON.stringify(prev.shortcuts)) applyShortcuts(next)
              if (next.ui.launchAtLogin !== prev.ui.launchAtLogin) setLaunchAtLogin(next.ui.launchAtLogin)
              if (JSON.stringify(next.transcription) !== JSON.stringify(prev.transcription)) engine.stopServer()
              if (next.updates.auto !== prev.updates.auto) updater.applyConfig()
              if (themeShown(next.ui, seasons.current) !== themeShown(prev.ui, seasons.current)) applyChrome()
            })
            seasons.on('change', (season) => {
              applyChrome()
              broadcast('season', season)
            })
            updater.init()
          }
        ],
        [label('tidying up your history', 'dusting off old dictations'), () => history.prune()]
      ],
      updated ? { showAfterMs: 0, minShownMs: 1500 } : {}
    )
    if (config.ui.lastVersion !== version) configStore.update({ ui: { lastVersion: version } })
    setInterval(() => void history.prune(), 6 * 3600_000).unref()

    handleArgs(process.argv)
  })

  app.on('will-quit', () => {
    engine.stopServer()
    stopKeyboardHook()
  })
}

function applyShortcuts(config: Config): void {
  const error = hotkeys.apply(config.shortcuts)
  if (error && Notification.isSupported())
    new Notification({ title: 'Speak shortcut unavailable', body: `${error} Change it in Speak → settings → general.` }).show()
}
