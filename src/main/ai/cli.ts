import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../paths'
import { isMac, isWin, run, which } from '../util'

/**
 * Helpers shared by the coding-agent CLIs (Claude Code, Codex). Speak always runs the user's
 * own, unmodified CLI with their own login, and never reads or stores their credentials.
 */

const resolved = new Map<string, string | null>()

/** Configured path, else PATH, else the usual install locations. */
export function findCli(name: string, configured: string, candidates: string[], refresh = false): string | null {
  const custom = configured.trim()
  if (custom) return existsSync(custom) ? custom : null
  if (!refresh && resolved.has(name)) return resolved.get(name)!
  const found = which(name) ?? candidates.find((c) => existsSync(c)) ?? null
  resolved.set(name, found)
  return found
}

/** Write a system prompt once per content hash and return its path. */
export async function promptFile(prefix: string, content: string): Promise<string> {
  const file = join(paths.tmp, `${prefix}-${createHash('sha1').update(content).digest('hex').slice(0, 12)}.txt`)
  if (!existsSync(file)) await writeFile(file, content, 'utf8')
  return file
}

/** Open a terminal running `<cli> <args>`, so sign-in happens in the vendor's own flow. */
export async function openInTerminal(cli: string, args: string[], title: string): Promise<void> {
  const line = [`"${cli}"`, ...args].join(' ')
  if (isWin) {
    spawn('cmd.exe', ['/d', '/s', '/c', `"start "${title}" cmd.exe /k "${line}""`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (isMac) {
    const script = `tell application "Terminal" to do script "${line.replace(/"/g, '\\"')}"\ntell application "Terminal" to activate`
    await run('osascript', ['-e', script])
    return
  }
  const plain = [cli, ...args].join(' ')
  const terminals: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', plain]],
    ['gnome-terminal', ['--', cli, ...args]],
    ['konsole', ['-e', cli, ...args]],
    ['xfce4-terminal', ['-e', plain]],
    ['kitty', [cli, ...args]],
    ['alacritty', ['-e', cli, ...args]],
    ['xterm', ['-e', plain]]
  ]
  const found = terminals.find(([t]) => which(t))
  if (!found) throw new Error(`No terminal found. Run "${plain}" in a terminal.`)
  void run(found[0], found[1]).catch(() => undefined)
}

/** Short, single-line error detail from a CLI's output. */
export function errorDetail(...outputs: string[]): string {
  const text = outputs.find((o) => o.trim()) ?? ''
  return text.trim().split('\n').slice(-6).join(' ').slice(0, 400)
}

export const looksLikeAuthError = (detail: string) => /log ?in|sign ?in|auth|credential|unauthori|401/i.test(detail)
