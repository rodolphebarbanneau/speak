import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { paths } from '../paths'
import { isMac, isWin, run, shellEnv, which } from '../util'

/**
 * Helpers shared by the coding-agent CLIs (Claude Code, Codex). Speak always runs the user's
 * own, unmodified CLI with their own login, and never reads or stores their credentials.
 */

const resolved = new Map<string, string | null>()

/** `~/x` → absolute path (Node doesn't expand `~`; neither does spawning without a shell). */
export function expandHome(p: string): string {
  const v = p.trim().replace(/^["']|["']$/g, '')
  if (v === '~') return homedir()
  if (/^~[\\/]/.test(v)) return join(homedir(), v.slice(2))
  return v ? resolve(v) : ''
}

const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false

/** Why a configured CLI path can't be used, or null when it's fine (or empty: auto). */
export function cliPathProblem(configured: string, command: string, homeVar: string): string | null {
  const p = expandHome(configured)
  if (!p) return null
  if (!existsSync(p)) return `cli path not found: ${p}`
  if (isDir(p)) return `cli path is a folder (${p}): it should point to the ${command} program. To use another account (${homeVar}), set "home path" instead.`
  return null
}

/** Why a configured home path can't be used, or null. */
export function homeProblem(configured: string): string | null {
  const p = expandHome(configured)
  if (!p) return null
  return isDir(p) ? null : `home path not found: ${p}`
}

/**
 * The CLI's home folder as environment (e.g. CLAUDE_CONFIG_DIR). Empty when it's the default
 * folder: setting the variable even to the default changes where Claude Code looks for its
 * sign-in on macOS (another Keychain entry), so the default stays unset.
 */
export function homeEnv(homeVar: string, home: string, defaultDir: string): Record<string, string> {
  const dir = expandHome(home)
  const same = (a: string, b: string) => (isWin || isMac ? a.toLowerCase() === b.toLowerCase() : a === b)
  return dir && !same(dir.replace(/[\\/]+$/, ''), join(homedir(), defaultDir)) ? { [homeVar]: dir } : {}
}

/** Configured path, else PATH, else the usual install locations. */
export function findCli(name: string, configured: string, candidates: string[], refresh = false): string | null {
  const custom = expandHome(configured)
  if (custom) return existsSync(custom) && !isDir(custom) ? custom : null
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

const shQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * Open a terminal running `<cli> <args>`, so sign-in happens in the vendor's own flow. `env`
 * (e.g. the CLI's home path) is set there too, so it signs in to the account Speak uses.
 */
export async function openInTerminal(cli: string, args: string[], title: string, env: Record<string, string> = {}): Promise<void> {
  if (isWin) {
    // The new console inherits this environment.
    const line = [`"${cli}"`, ...args].join(' ')
    spawn('cmd.exe', ['/d', '/s', '/c', `"start "${title}" cmd.exe /k "${line}""`], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
      env: { ...shellEnv(), ...env }
    }).unref()
    return
  }
  // Terminal.app and gnome-terminal don't inherit our environment: pass it with `env`.
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  const argv = vars.length ? ['env', ...vars, cli, ...args] : [cli, ...args]
  const plain = argv.map(shQuote).join(' ')
  if (isMac) {
    const script = `tell application "Terminal" to do script "${plain.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\ntell application "Terminal" to activate`
    await run('osascript', ['-e', script])
    return
  }
  const terminals: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', plain]],
    ['gnome-terminal', ['--', ...argv]],
    ['konsole', ['-e', ...argv]],
    ['xfce4-terminal', ['-e', plain]],
    ['kitty', argv],
    ['alacritty', ['-e', ...argv]],
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
