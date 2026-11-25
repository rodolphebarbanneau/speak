import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, crashReporter } from 'electron'
import { log } from './log'
import { paths } from './paths'

/** Crash reports kept in the logs folder, the latest first. */
const KEEP_REPORTS = 5

/**
 * What ends Speak unexpectedly, in its log: an error in the main process that nothing caught (it
 * goes on, as Electron does, without Electron's dialog), and a crash of any of its processes,
 * which Chromium writes as a report on the computer (never sent anywhere). The next start says
 * when it happened, and keeps the report in the logs folder.
 */
export function watchCrashes(): void {
  process.on('uncaughtException', (err) => log.error('Uncaught error in the main process:', err))
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection in the main process:', reason))
  try {
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch (err) {
    log.warn('Crash reports unavailable:', err)
  }
}

/** After startup: the crash reports written since the last start, logged and moved into the logs folder. */
export function reportCrashes(): void {
  try {
    // Crashpad's folders: reports on Windows, completed (and pending) on macOS and Linux.
    const root = app.getPath('crashDumps')
    const found = ['reports', 'completed', 'pending'].flatMap((sub) => {
      try {
        return readdirSync(join(root, sub))
          .filter((f) => f.endsWith('.dmp'))
          .map((f) => ({ dir: join(root, sub), file: f }))
      } catch {
        return []
      }
    })
    if (!found.length) return
    const keep = join(paths.logs, 'crashes')
    mkdirSync(keep, { recursive: true })
    for (const { dir, file } of found) {
      const at = statSync(join(dir, file)).mtime
      const name = `${at.toISOString().replace(/[:.]/g, '-')}-${file}`
      // Copied, then removed: the logs folder may be on another drive (SPEAK_HOME).
      copyFileSync(join(dir, file), join(keep, name))
      rmSync(join(dir, file), { force: true })
      log.warn(`Speak crashed at ${at.toISOString()}: report kept in logs/crashes/${name}`)
    }
    const kept = readdirSync(keep)
      .filter((f) => f.endsWith('.dmp'))
      .sort()
      .reverse()
    for (const old of kept.slice(KEEP_REPORTS)) rmSync(join(keep, old), { force: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Could not read the crash reports:', err)
  }
}
