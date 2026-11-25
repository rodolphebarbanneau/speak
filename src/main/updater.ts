import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import { app, Notification, powerMonitor, shell } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import { RELEASES_URL } from '../shared/constants'
import type { UpdateState } from '../shared/types'
import { configStore } from './config'
import { control } from './control'
import { controller } from './controller'
import { log } from './log'
import { label, withLoading } from './loading'
import { startKeyboardHook, stopKeyboardHook } from './platform/keyboard'
import { engine } from './stt/engine'
import { isMac, run } from './util'
import { allowQuit, hideWindows, mainWindow, previewVisible } from './windows'

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 3600_000
/** A downloaded update installs by itself once nothing has been typed or moved for this long. */
const AWAY_SECONDS = 10 * 60
const AWAY_CHECK_MS = 60_000

/**
 * A Mac build replaces itself only when Apple's Developer ID signs it: the release workflow signs
 * with an ad hoc signature when the repository has no certificate, and macOS then refuses the new
 * version once downloaded. Such a build points to the releases page instead.
 */
async function canReplaceItself(): Promise<boolean> {
  if (!isMac) return true
  // …/Speak.app/Contents/MacOS/Speak
  const bundle = dirname(dirname(dirname(process.execPath)))
  const r = await run('codesign', ['--display', '--verbose=2', bundle], { timeoutMs: 10_000 }).catch(() => null)
  return !!r && /Authority=Developer ID Application/.test(r.stdout + r.stderr)
}

/**
 * Updates from GitHub Releases via electron-updater: the release workflow uploads installers
 * and their update manifests (latest.yml…); the app checks them and downloads in the background.
 * A downloaded update installs when Speak quits, or by itself once the computer has been left
 * alone a while (Windows quits apps at shutdown without the quit that would install it, so an
 * update otherwise waited for a quit from the tray), or right away on request. A check the user
 * asks for (settings → about) downloads nothing by itself: it shows the new version, and waits
 * for their "download". Disabled in development builds.
 */
class Updater extends EventEmitter {
  state: UpdateState = { status: app.isPackaged ? 'idle' : 'disabled', current: app.getVersion() }
  private updater: AppUpdater | null = null
  /** This build can't replace itself (see canReplaceItself): a new version is shown, not downloaded. */
  private manual = false
  /** The new version already announced, for a build that can't replace itself. */
  private announced = ''
  private installing = false

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
    // With an update already downloaded, a check looks for a newer one: what's ready stays shown meanwhile.
    autoUpdater.on('checking-for-update', () => {
      if (this.state.status !== 'downloaded') this.set({ status: 'checking', error: undefined })
    })
    autoUpdater.on('update-not-available', () => {
      // The version downloaded was withdrawn (its release deleted): not installed at quit either.
      if (this.state.status === 'downloaded') {
        log.info(`[update] ${this.state.latest} is no longer released: it won't be installed`)
        autoUpdater.autoInstallOnAppQuit = false
      }
      this.set({ status: 'latest', latest: undefined, checkedAt: new Date().toISOString() })
    })
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      // The one already downloaded: electron-updater finds it in its cache and says so again.
      if (this.state.status === 'downloaded' && info.version === this.state.latest) return
      // Downloading by itself (a background check, updates automatic): no "download" to offer.
      this.set({
        status: autoUpdater.autoDownload ? 'downloading' : 'available',
        percent: 0,
        latest: info.version,
        manual: this.manual || undefined,
        checkedAt: new Date().toISOString()
      })
      if (this.manual) this.announce(info.version)
    })
    autoUpdater.on('download-progress', (p: ProgressInfo) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      const again = this.state.status === 'downloaded' && info.version === this.state.latest
      this.applyConfig()
      this.set({ status: 'downloaded', latest: info.version, percent: 100 })
      if (again || !Notification.isSupported()) return
      new Notification({
        title: `Speak ${info.version} is ready`,
        body: 'It installs when Speak quits or while you are away, or restart now from the tray menu.',
        silent: true
      }).show()
    })
    autoUpdater.on('error', (err: Error) => {
      // A failed check or download leaves the update already downloaded as it was.
      if (this.state.status === 'downloaded' && !this.installing) return log.warn('[update] Check failed, the update downloaded stays:', err?.message)
      this.set(this.describeError(err))
    })

    void canReplaceItself().then((can) => {
      this.manual = !can
      if (this.manual) log.info('[update] This build is not signed by Apple: new versions are pointed to on the releases page')
      setTimeout(() => void this.check(), FIRST_CHECK_MS).unref()
    })
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref()
    setInterval(() => this.installIfAway(), AWAY_CHECK_MS).unref()
  }

  /**
   * Follow the "install updates automatically" setting. Whether a check downloads is decided as it
   * starts (see check): turning the setting on doesn't make the user's own check download.
   */
  applyConfig(): void {
    if (!this.updater) return
    this.updater.autoInstallOnAppQuit = configStore.get().updates.auto
  }

  /**
   * Look for a new version. `byUser`: the user asked (settings → about): what it finds waits for
   * their "download". Otherwise (the checks in the background), it downloads by itself when updates
   * are automatic, a newer one too when one is already downloaded.
   */
  async check(byUser = false): Promise<void> {
    const busy = this.state.status === 'checking' || this.state.status === 'downloading' || (byUser && this.state.status === 'downloaded')
    if (!this.updater || busy || this.installing) return
    // Read by electron-updater while the check runs, when it finds a new version.
    this.updater.autoDownload = !byUser && !this.manual && configStore.get().updates.auto
    try {
      await this.updater.checkForUpdates()
    } catch {
      // reported through the 'error' event
    }
  }

  async download(): Promise<void> {
    if (!this.updater || this.state.status !== 'available') return
    if (this.manual) return void shell.openExternal(RELEASES_URL)
    try {
      await this.updater.downloadUpdate()
    } catch {
      // reported through the 'error' event
    }
  }

  /** Once per version, for a build that can't replace itself: where to get it. */
  private announce(version: string): void {
    if (this.announced === version || !Notification.isSupported()) return
    this.announced = version
    const n = new Notification({ title: `Speak ${version} is out`, body: 'This build cannot update itself: download it from the releases page.', silent: true })
    n.on('click', () => void shell.openExternal(RELEASES_URL))
    n.show()
  }

  /**
   * Install the update downloaded while the computer is left alone: nothing typed or moved for a
   * while, no dictation or control session under way, no dictation waiting in the preview. Speak
   * comes back as it was (in the tray, or with its window open), without the "updated" dialog.
   */
  private installIfAway(): void {
    if (this.state.status !== 'downloaded' || this.installing || !configStore.get().updates.auto) return
    if (powerMonitor.getSystemIdleTime() < AWAY_SECONDS) return
    if (controller.phase !== 'idle' || control.active || previewVisible()) return
    log.info(`[update] Installing ${this.state.latest} while the computer is left alone`)
    void this.install({ away: true })
  }

  /**
   * Quit and run the installer, then relaunch. A loading dialog shows Speak letting go of what it
   * holds first (the speech model, the keyboard), as the installer itself runs out of sight. `away`:
   * nobody is watching: no dialog.
   */
  async install(opts: { away?: boolean } = {}): Promise<void> {
    const updater = this.updater
    if (!updater || this.state.status !== 'downloaded' || this.installing) return
    this.installing = true
    const steps: Array<[string, () => unknown]> = [
      [label('stopping the speech engine', 'letting the speech engine finish its sentence'), () => engine.shutdown()],
      [label('releasing the keyboard', 'handing the keyboard back'), () => stopKeyboardHook()],
      ['closing windows', () => hideWindows()],
      [
        label('starting the installer', 'handing over to the installer'),
        () => {
          allowQuit()
          updater.quitAndInstall(true, true)
          // electron-updater reports a failure to start the installer through 'error', at once.
          if (this.state.status === 'error') this.installFailed()
        }
      ]
    ]
    if (!opts.away) {
      await withLoading(`updating to ${this.state.latest}`, steps, {
        showAfterMs: 0,
        minShownMs: 1500,
        note: 'speak reopens by itself in a few seconds',
        leaveOpen: true
      })
      return
    }
    configStore.update({ state: { reopen: mainWindow?.isVisible() ? 'main' : 'tray' } })
    for (const [, step] of steps) await step()
  }

  /** The installer didn't start: Speak goes on as it was (the speech engine starts again when needed). */
  private installFailed(): void {
    log.warn(`[update] The installer did not start: Speak goes on with ${this.state.current}`)
    this.installing = false
    startKeyboardHook()
    if (configStore.get().state.reopen) configStore.update({ state: { reopen: '' } })
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
