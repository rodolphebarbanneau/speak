import { EventEmitter } from 'node:events'
import { app, Notification } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { configStore } from './config'
import { log } from './log'
import { label, withLoading } from './loading'
import { stopKeyboardHook } from './platform/keyboard'
import { engine } from './stt/engine'
import { allowQuit, hideWindows } from './windows'

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 3600_000

/**
 * Updates from GitHub Releases via electron-updater: the release workflow uploads installers
 * and their update manifests (latest.yml…); the app checks them, downloads in the background
 * and installs on quit (or right away on request). Disabled in development builds.
 */
class Updater extends EventEmitter {
  state: UpdateState = { status: app.isPackaged ? 'idle' : 'disabled', current: app.getVersion() }
  private updater: AppUpdater | null = null

  init(): void {
    if (!app.isPackaged) return
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    this.updater = autoUpdater
    autoUpdater.disableWebInstaller = true
    autoUpdater.logger = {
      info: (m) => log.info('[update]', m),
      warn: (m) => log.warn('[update]', m),
      error: (m) => log.error('[update]', m),
      debug: () => undefined
    }
    // Testing: point at a local folder of release files instead of GitHub (see README).
    if (process.env.SPEAK_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.SPEAK_UPDATE_FEED })
    this.applyConfig()
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: undefined }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest', checkedAt: new Date().toISOString() }))
    autoUpdater.on('update-available', (info: UpdateInfo) => this.set({ status: 'available', latest: info.version, checkedAt: new Date().toISOString() }))
    autoUpdater.on('download-progress', (p: ProgressInfo) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.set({ status: 'downloaded', latest: info.version, percent: 100 })
      if (Notification.isSupported()) {
        new Notification({
          title: `Speak ${info.version} is ready`,
          body: 'It installs when Speak quits, or restart now from the tray menu.',
          silent: true
        }).show()
      }
    })
    autoUpdater.on('error', (err: Error) => this.set(this.describeError(err)))

    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref()
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref()
  }

  /** Follow the "install updates automatically" setting. */
  applyConfig(): void {
    if (!this.updater) return
    const auto = configStore.get().updates.auto
    this.updater.autoDownload = auto
    this.updater.autoInstallOnAppQuit = auto
  }

  async check(): Promise<void> {
    if (!this.updater || this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'downloaded') return
    try {
      await this.updater.checkForUpdates()
    } catch {
      // reported through the 'error' event
    }
  }

  async download(): Promise<void> {
    if (!this.updater || this.state.status !== 'available') return
    try {
      await this.updater.downloadUpdate()
    } catch {
      // reported through the 'error' event
    }
  }

  /**
   * Quit and run the installer, then relaunch. A loading dialog shows Speak letting go of what it
   * holds first (the speech model, the keyboard), as the installer itself runs out of sight.
   */
  async install(): Promise<void> {
    const updater = this.updater
    if (!updater || this.state.status !== 'downloaded') return
    await withLoading(
      `updating to ${this.state.latest}`,
      [
        [label('stopping the speech engine', 'letting the speech engine finish its sentence'), () => engine.shutdown()],
        [label('releasing the keyboard', 'handing the keyboard back'), () => stopKeyboardHook()],
        ['closing windows', () => hideWindows()],
        [
          label('starting the installer', 'handing over to the installer'),
          () => {
            allowQuit()
            updater.quitAndInstall(true, true)
          }
        ]
      ],
      { showAfterMs: 0, minShownMs: 1500, note: 'speak reopens by itself in a few seconds', leaveOpen: true }
    )
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.state)
  }

  private describeError(err: Error): Partial<UpdateState> {
    const message = err?.message ?? String(err)
    // A repository without a published release yet: nothing newer to install.
    if (/latest version on GitHub|No published versions|404/i.test(message)) return { status: 'latest', checkedAt: new Date().toISOString() }
    if (/code signature|not signed/i.test(message))
      return { status: 'error', error: 'This build is not code-signed, so it cannot update itself. Download the new version from the releases page.' }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(message)) return { status: 'error', error: 'Could not reach GitHub. Speak will try again later.' }
    return { status: 'error', error: message.split('\n')[0].slice(0, 200) }
  }
}

export const updater = new Updater()
