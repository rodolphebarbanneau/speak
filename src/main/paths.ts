import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/** Root of all user data: ~/.speak (override with SPEAK_HOME). */
export const home = process.env.SPEAK_HOME || join(homedir(), '.speak')

export const paths = {
  home,
  config: join(home, 'config.json'),
  history: join(home, 'history'),
  models: join(home, 'models'),
  bin: join(home, 'bin'),
  logs: join(home, 'logs'),
  tmp: join(home, 'tmp')
}

export function ensureDirs(): void {
  for (const dir of [paths.home, paths.history, paths.models, paths.bin, paths.logs, paths.tmp]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Static app resources (icons). Inside the asar when packaged. */
export function resource(name: string): string {
  return join(app.getAppPath(), 'resources', name)
}
