import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { paths } from './paths'

const file = () => join(paths.logs, 'speak.log')
const MAX_BYTES = 5 * 1024 * 1024

function write(level: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${format(...args)}\n`
  if (level === 'error') process.stderr.write(line)
  else process.stdout.write(line)
  try {
    try {
      if (statSync(file()).size > MAX_BYTES) renameSync(file(), join(paths.logs, 'speak.old.log'))
    } catch {
      // no log file yet
    }
    appendFileSync(file(), line)
  } catch {
    // logging must never crash the app
  }
}

export const log = {
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args)
}
