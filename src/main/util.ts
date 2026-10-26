import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'

export const isWin = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'
export const isWayland = isLinux && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run a command to completion; never throws for non-zero exit (check `code`). */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { cwd: opts.cwd, env: opts.env ?? shellEnv(), windowsHide: true }
    // .cmd/.bat shims need a shell on Windows.
    const viaShell = isWin && /\.(cmd|bat)$/i.test(cmd)
    const child = viaShell ? spawn(`"${cmd}"`, args.map(quoteCmdArg), { ...spawnOpts, shell: true }) : spawn(cmd, args, spawnOpts)
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill()
          finish(new Error(`${cmd} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`))
        }, opts.timeoutMs)
      : null
    const onAbort = () => {
      child.kill()
      finish(new Error('Cancelled'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    function finish(err: Error | null, result?: RunResult) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(result!)
    }
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (err) => finish(err))
    child.on('close', (code) => finish(null, { code, stdout, stderr }))
    if (opts.input !== undefined) child.stdin?.end(opts.input, 'utf8')
    else child.stdin?.end()
  })
}

function quoteCmdArg(arg: string): string {
  if (arg === '') return '""'
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

let cachedEnv: NodeJS.ProcessEnv | null = null

/**
 * Environment for child processes. GUI apps on macOS/Linux don't inherit the login
 * shell PATH, so tools like `claude` installed under ~/.local/bin wouldn't be found.
 */
export function shellEnv(): NodeJS.ProcessEnv {
  return cachedEnv ?? process.env
}

export async function loadShellEnv(): Promise<void> {
  const env = { ...process.env }
  delete env.CLAUDECODE // allow spawning claude when Speak itself was started from Claude Code
  if (!isWin) {
    const shell = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash')
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(shell, ['-ilc', 'printf "__SPEAK_PATH__%s__" "$PATH"'], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
      )
      const m = out.match(/__SPEAK_PATH__(.*)__/)
      if (m?.[1]) env.PATH = m[1]
    } catch {
      // keep the inherited PATH
    }
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(process.env.HOME ?? '', '.local/bin')]
    const parts = (env.PATH ?? '').split(delimiter)
    for (const p of extra) if (p && !parts.includes(p)) parts.push(p)
    env.PATH = parts.join(delimiter)
  }
  cachedEnv = env
}

/** Find an executable on PATH (plus Windows PATHEXT handling). */
export function which(name: string): string | null {
  const env = shellEnv()
  const exts = isWin ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** Recursively find the first directory containing `file`. */
export async function findDirContaining(root: string, file: string, depth = 4): Promise<string | null> {
  if (existsSync(join(root, file))) return root
  if (depth <= 0) return null
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findDirContaining(join(root, e.name), file, depth - 1)
      if (found) return found
    }
  }
  return null
}
