import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { log } from '../log'
import { isLinux } from '../util'

export function setLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return // don't register the dev Electron binary
  try {
    if (isLinux) {
      const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart')
      const file = join(dir, 'speak.desktop')
      if (!enabled) return rmSync(file, { force: true })
      const exec = process.env.APPIMAGE || process.execPath
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Speak\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`)
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    }
  } catch (err) {
    log.warn('Could not update launch-at-login:', err)
  }
}
