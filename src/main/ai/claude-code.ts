import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, AgentStatus } from '../../shared/types'
import { log } from '../log'
import { paths } from '../paths'
import { isMac, isWin, run, shellEnv } from '../util'
import { cliPathProblem, errorDetail, findCli, homeEnv, homeProblem, looksLikeAuthError, openInTerminal, promptFile } from './cli'
import type { CompleteOptions, Completion } from './types'

/** Claude Code (`claude -p`), with the user's own Claude account. */

function candidates(): string[] {
  const h = homedir()
  if (isWin) {
    const appData = process.env.APPDATA ?? join(h, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA ?? join(h, 'AppData', 'Local')
    return [
      join(h, '.local', 'bin', 'claude.exe'),
      join(appData, 'npm', 'claude.cmd'),
      join(local, 'Programs', 'claude', 'claude.exe'),
      join(h, '.bun', 'bin', 'claude.exe')
    ]
  }
  return [
    join(h, '.local', 'bin', 'claude'),
    join(h, '.claude', 'local', 'claude'),
    ...(isMac ? ['/opt/homebrew/bin/claude'] : []),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    join(h, '.npm-global', 'bin', 'claude'),
    join(h, '.bun', 'bin', 'claude')
  ]
}

const cliPath = (cfg: AgentConfig, refresh = false) => findCli('claude', cfg.path, candidates(), refresh)

/** Claude Code's home (settings and sign-in), ~/.claude by default. */
const HOME_VAR = 'CLAUDE_CONFIG_DIR'
const env = (cfg: AgentConfig) => ({ ...shellEnv(), ...homeEnv(HOME_VAR, cfg.home, '.claude') })

export async function claudeStatus(cfg: AgentConfig, refresh: boolean): Promise<AgentStatus> {
  const problem = cliPathProblem(cfg.path, 'claude', HOME_VAR)
  if (problem) return { found: false, error: problem }
  const path = cliPath(cfg, refresh)
  if (!path) return { found: false, error: 'Claude Code not found. Install it from claude.com/claude-code or set its path.' }
  const status: AgentStatus = { found: true, path }
  const badHome = homeProblem(cfg.home)
  if (badHome) return { ...status, error: badHome }
  try {
    status.version = (await run(path, ['--version'], { timeoutMs: 15_000, env: env(cfg) })).stdout.trim().split('\n')[0]
    const a = await run(path, ['auth', 'status', '--json'], { timeoutMs: 15_000, env: env(cfg) })
    const json = JSON.parse(a.stdout.slice(a.stdout.indexOf('{')))
    status.loggedIn = !!json.loggedIn
    status.account = [json.email, json.subscriptionType].filter(Boolean).join(' · ') || undefined
  } catch (err) {
    status.error = `Could not read Claude Code status: ${(err as Error).message}`
  }
  return status
}

export function claudeLogin(cfg: AgentConfig): Promise<void> {
  const path = cliPath(cfg)
  if (!path) throw new Error(cliPathProblem(cfg.path, 'claude', HOME_VAR) ?? 'Claude Code not found')
  const badHome = homeProblem(cfg.home)
  if (badHome) throw new Error(badHome)
  return openInTerminal(path, ['auth', 'login'], 'Claude Code sign-in', homeEnv(HOME_VAR, cfg.home, '.claude'))
}

/** Whether this Claude Code has `--restricted` (file tools kept inside the working directory), by CLI path. */
const restrictedSupport = new Map<string, Promise<boolean>>()

function supportsRestricted(path: string, cfg: AgentConfig): Promise<boolean> {
  let known = restrictedSupport.get(path)
  if (!known) {
    known = run(path, ['--help'], { timeoutMs: 15_000, env: env(cfg) })
      .then((r) => r.stdout.includes('--restricted'))
      .catch(() => false)
    restrictedSupport.set(path, known)
  }
  return known
}

/** How to start this Claude Code for a session of its own (control mode). */
export function claudeLaunch(cfg: AgentConfig): { path: string; env: NodeJS.ProcessEnv } {
  const path = cliPath(cfg)
  if (!path) throw new Error('Claude Code not found. Install it or pick another provider in Speak → settings → ai.')
  return { path, env: env(cfg) }
}

export async function claudeComplete(system: string, user: string, cfg: AgentConfig, opts: CompleteOptions): Promise<Completion> {
  const path = cliPath(cfg)
  if (!path) throw new Error('Claude Code not found. Install it or pick another provider in Speak → settings → ai.')
  // Text only: no tools, no MCP servers, no user/project settings or CLAUDE.md, no saved session.
  // With a folder to read (compose with a context), the tools that read files and nothing else:
  // none writes, runs a command or goes online; the folder is the working directory, and reading
  // outside it is refused (by --restricted where the CLI has it, else by -p's default permissions).
  const read = opts.readDir
  const restricted = read && (await supportsRestricted(path, cfg)) ? ['--restricted'] : []
  const args = [
    '-p',
    ['--model', cfg.model],
    ['--effort', cfg.effort],
    ['--system-prompt-file', await promptFile('claude-system', system)],
    ['--tools', read ? 'Read,Grep,Glob' : ''],
    restricted,
    ['--setting-sources', ''],
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    ['--output-format', 'json']
  ].flat()
  const r = await run(path, args, { input: user, cwd: read ?? paths.tmp, env: env(cfg), timeoutMs: opts.timeoutMs, signal: opts.signal })
  let json: { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> } | null = null
  try {
    json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  } catch {
    // reported below
  }
  if (r.code !== 0 || !json || json.is_error || typeof json.result !== 'string') {
    const detail = errorDetail(json?.result ?? '', r.stderr, r.stdout) || `exit code ${r.code}`
    log.warn('claude -p failed:', detail)
    throw new Error(looksLikeAuthError(detail) ? `Claude Code is not signed in. ${detail}` : `Claude Code failed: ${detail}`)
  }
  const model = Object.keys(json.modelUsage ?? {}).find((m) => m.includes(cfg.model)) ?? cfg.model
  return { text: json.result, model }
}
