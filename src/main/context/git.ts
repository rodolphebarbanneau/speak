import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errorDetail } from '../ai/cli'
import { log } from '../log'
import { paths } from '../paths'
import { run, shellEnv, which } from '../util'

/**
 * Git repositories, read from Speak's own shallow clone in ~/.speak/context/git: never a folder of
 * the user's. The clone is brought up to date when it's used, at most every few minutes; offline,
 * the last copy is used. It runs the user's own git, with their credentials, so private
 * repositories work as they do in a terminal (a credential helper may ask to sign in once).
 */

const REFRESH_MS = 10 * 60_000
const fetched = new Map<string, number>()
const pending = new Map<string, Promise<string>>()

export function cloneDir(url: string): string {
  const name = url
    .replace(/\.git\/?$/, '')
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-1)[0]
    ?.replace(/[^\w.-]/g, '_')
  return join(paths.context, 'git', `${name || 'repo'}-${createHash('sha1').update(url).digest('hex').slice(0, 10)}`)
}

const gitEnv = () => ({ ...shellEnv(), GIT_TERMINAL_PROMPT: '0' })

async function update(git: string, url: string, dir: string): Promise<void> {
  const f = await run(git, ['fetch', '--depth', '1', '--no-tags', 'origin'], { cwd: dir, env: gitEnv(), timeoutMs: 60_000 }).catch((err: Error) => ({
    code: 1,
    stdout: '',
    stderr: err.message
  }))
  if (f.code !== 0) {
    log.warn(`git fetch ${url} failed, using the copy from before:`, errorDetail(f.stderr, f.stdout))
    return
  }
  // Speak's own clone, where nothing else writes: it simply follows the remote.
  const r = await run(git, ['reset', '--hard', '--quiet', 'FETCH_HEAD'], { cwd: dir, env: gitEnv(), timeoutMs: 30_000 }).catch((err: Error) => ({
    code: 1,
    stdout: '',
    stderr: err.message
  }))
  if (r.code !== 0) log.warn(`git reset in ${dir} failed:`, errorDetail(r.stderr, r.stdout))
  fetched.set(url, Date.now())
}

async function clone(git: string, url: string, dir: string): Promise<void> {
  const part = `${dir}.part`
  await rm(part, { recursive: true, force: true, maxRetries: 3 })
  await mkdir(join(paths.context, 'git'), { recursive: true })
  const c = await run(git, ['clone', '--depth', '1', '--single-branch', '--no-tags', '--', url, part], { env: gitEnv(), timeoutMs: 180_000 }).catch(
    (err: Error) => ({ code: 1, stdout: '', stderr: err.message })
  )
  if (c.code !== 0) {
    await rm(part, { recursive: true, force: true, maxRetries: 3 })
    throw new Error(`Could not clone ${url}: ${errorDetail(c.stderr, c.stdout) || `exit code ${c.code}`}`)
  }
  await rename(part, dir)
  fetched.set(url, Date.now())
  log.info(`Cloned ${url} into ${dir}`)
}

/** The folder holding an up-to-date copy of the repository at `url`. */
export function checkout(url: string): Promise<string> {
  const running = pending.get(url)
  if (running) return running
  const work = (async () => {
    const git = which('git')
    if (!git) throw new Error('Reading a git repository needs git: install it from git-scm.com, then try again.')
    const dir = cloneDir(url)
    if (!existsSync(join(dir, '.git'))) await clone(git, url, dir)
    else if (Date.now() - (fetched.get(url) ?? 0) > REFRESH_MS) await update(git, url, dir)
    return dir
  })().finally(() => pending.delete(url))
  pending.set(url, work)
  return work
}

/** Delete Speak's copy of a repository (when it's removed from the recent contexts). */
export async function removeClone(url: string): Promise<void> {
  fetched.delete(url)
  await rm(cloneDir(url), { recursive: true, force: true, maxRetries: 3 })
}
