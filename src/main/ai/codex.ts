import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CODEX_MODELS } from '../../shared/constants'
import type { AgentConfig, AgentModel, AgentStatus } from '../../shared/types'
import { log } from '../log'
import { paths } from '../paths'
import { isMac, isWin, run } from '../util'
import { errorDetail, findCli, looksLikeAuthError, openInTerminal, promptFile } from './cli'
import type { Completion } from './types'

/** OpenAI Codex CLI (`codex exec`), with the user's own ChatGPT/OpenAI login. */

const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex')

function candidates(): string[] {
  const h = homedir()
  if (isWin) {
    const appData = process.env.APPDATA ?? join(h, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA ?? join(h, 'AppData', 'Local')
    return [join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), join(appData, 'npm', 'codex.cmd'), join(h, '.local', 'bin', 'codex.exe')]
  }
  return [
    join(h, '.local', 'bin', 'codex'),
    ...(isMac ? ['/opt/homebrew/bin/codex', '/Applications/Codex.app/Contents/Resources/codex'] : []),
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    join(h, '.npm-global', 'bin', 'codex')
  ]
}

const cliPath = (cfg: AgentConfig, refresh = false) => findCli('codex', cfg.path, candidates(), refresh)

export async function codexStatus(cfg: AgentConfig, refresh: boolean): Promise<AgentStatus> {
  const path = cliPath(cfg, refresh)
  if (!path) return { found: false, error: 'Codex not found. Install it from developers.openai.com/codex or set its path.' }
  const status: AgentStatus = { found: true, path }
  try {
    status.version = (await run(path, ['--version'], { timeoutMs: 15_000 })).stdout.trim().split('\n')[0]
    // e.g. "Logged in using ChatGPT" / "Not logged in"
    const a = await run(path, ['login', 'status'], { timeoutMs: 15_000 })
    const line =
      `${a.stdout}\n${a.stderr}`
        .trim()
        .split('\n')
        .find((l) => /logged in/i.test(l)) ?? ''
    status.loggedIn = a.code === 0 && /^logged in/i.test(line.trim())
    status.account = line
      .match(/using (.+)$/i)?.[1]
      ?.trim()
      .toLowerCase()
  } catch (err) {
    status.error = `Could not read Codex status: ${(err as Error).message}`
  }
  return status
}

export function codexLogin(cfg: AgentConfig): Promise<void> {
  const path = cliPath(cfg)
  if (!path) throw new Error('Codex not found')
  return openInTerminal(path, ['login'], 'Codex sign-in')
}

/** Models from Codex's own catalog (kept up to date by the CLI), else a built-in list. */
export async function codexModels(): Promise<AgentModel[]> {
  try {
    const cache = JSON.parse(await readFile(join(codexHome(), 'models_cache.json'), 'utf8')) as { models?: Array<{ slug?: string; visibility?: string }> }
    const models = (cache.models ?? []).filter((m) => m.slug && m.visibility === 'list').map((m) => ({ id: m.slug!, label: m.slug! }))
    if (models.length) return models
  } catch {
    // no cache yet
  }
  return CODEX_MODELS
}

export async function codexComplete(system: string, user: string, cfg: AgentConfig, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<Completion> {
  const path = cliPath(cfg)
  if (!path) throw new Error('Codex not found. Install it or pick another provider in Speak → ai.')
  const instructions = await promptFile('codex-system', system)
  const out = join(paths.tmp, `codex-out-${process.pid}-${Date.now()}.txt`)
  // Text only: our instructions replace the coding-agent prompt; no user config (MCP servers,
  // plugins), no rules, read-only sandbox, no saved session.
  const args = [
    'exec',
    ['-m', cfg.model],
    ['-c', `model_reasoning_effort="${cfg.effort}"`],
    // TOML string; forward slashes keep Windows paths free of escapes.
    ['-c', `model_instructions_file="${instructions.replace(/\\/g, '/')}"`],
    '--ignore-user-config',
    '--ignore-rules',
    ['--sandbox', 'read-only'],
    '--ephemeral',
    '--skip-git-repo-check',
    ['--color', 'never'],
    ['-o', out],
    '-'
  ].flat()
  try {
    const r = await run(path, args, { input: user, cwd: paths.tmp, timeoutMs: opts.timeoutMs, signal: opts.signal })
    const text = await readFile(out, 'utf8').catch(() => '')
    if (r.code !== 0 || !text.trim()) {
      const detail = errorDetail(r.stderr, r.stdout) || `exit code ${r.code}`
      log.warn('codex exec failed:', detail)
      throw new Error(looksLikeAuthError(detail) ? `Codex is not signed in. ${detail}` : `Codex failed: ${detail}`)
    }
    return { text, model: cfg.model }
  } finally {
    await rm(out, { force: true })
  }
}
