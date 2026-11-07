import { realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, isAbsolute } from 'node:path'
import type { ContextKind, ContextSource } from '../../shared/types'
import { expandHome } from '../ai/cli'
import { configStore } from '../config'
import { log } from '../log'
import { folderOverview } from './folder'
import { checkout, removeClone } from './git'
import { readPage, removePage } from './web'

/**
 * The context of a dictation: a folder, a git repository or a web page the AI reads along with
 * what the user says, or the clipboard's text. Read-only throughout: Speak reads folders and
 * never writes in them, keeps its copies of repositories and pages in its own data folder, and
 * the AI providers get read-only access (see ai/claude-code.ts and ai/codex.ts).
 *
 * The chosen context stays until changed (config.context.current); the ones used before are
 * offered again, most recent first (config.context.recent). The clipboard is chosen for one
 * recording at a time, on the pill: left on, it would send whatever was copied last.
 */

/** The most text a context gives the AI: enough to know a project or a page without slowing every dictation down. */
export const MAX_CONTEXT_CHARS = 30_000
const MAX_RECENT = 12
/** A context read this recently is used as it is: a dictation starts reading it, the next ones reuse it. */
const FRESH_MS = 60_000
/** How long a dictation waits for its context after the transcript is ready, before going on without it. */
const WAIT_MS = 20_000

export const CLIPBOARD: ContextSource = { kind: 'clipboard', location: 'clipboard', label: 'clipboard' }

/** What the AI gets from a context. */
export interface ReadContext {
  source: ContextSource
  /** A folder's overview (README, names in the code, files), a page's text, the clipboard's text. */
  text: string
  /** A folder the AI may read when composing (read-only): the folder itself, or Speak's clone. */
  dir?: string
}

const KINDS: ContextKind[] = ['folder', 'git', 'url']
const GIT_HOSTS = /^(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i

const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false

/** owner/name from a repository address (https://host/owner/name.git, git@host:owner/name). */
function repoName(url: string): string {
  return url
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '')
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .join('/')
}

/** The folder's real path: its true case on Windows and macOS, so the same folder is one context. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * A folder path, or a git or web address, as a context source; null when it's none of them (or
 * the folder doesn't exist). Repository pages (github.com/owner/name) are cloned as repositories;
 * other pages on those sites (an issue, a file) are read as pages.
 */
export function parseSource(input: string): ContextSource | null {
  const raw = input
    .trim()
    .replace(/^["'<]|["'>]$/g, '')
    .trim()
  if (!raw || /[\r\n]/.test(raw)) return null
  if (/^(git@[^:\s]+:|ssh:\/\/|git:\/\/)\S+$/i.test(raw) || /^https?:\/\/\S+\.git\/?$/i.test(raw)) {
    return { kind: 'git', location: raw.replace(/\/$/, ''), label: repoName(raw) }
  }
  if (/^https?:\/\/\S+$/i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (GIT_HOSTS.test(url.hostname) && parts.length === 2 && !url.search) {
      const name = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`
      return { kind: 'git', location: `https://${url.hostname.replace(/^www\./, '')}/${name}`, label: name }
    }
    url.hash = ''
    return { kind: 'url', location: url.toString(), label: `${url.host}${url.pathname}`.replace(/\/$/, '') + url.search }
  }
  let path = raw
  if (/^file:\/\//i.test(raw)) {
    try {
      path = fileURLToPath(raw)
    } catch {
      return null
    }
  }
  if (!isAbsolute(path) && !/^~([\\/]|$)/.test(path)) return null
  path = expandHome(path)
  if (!isDir(path)) return null
  path = canonical(path)
  return { kind: 'folder', location: path, label: basename(path) || path }
}

function valid(s: unknown): s is ContextSource {
  const v = s as ContextSource
  return !!v && KINDS.includes(v.kind) && typeof v.location === 'string' && !!v.location && typeof v.label === 'string'
}

export function recentSources(): ContextSource[] {
  const recent = configStore.get().context?.recent
  return Array.isArray(recent) ? recent.filter(valid) : []
}

/** The chosen context, null for none. */
export function currentSource(): ContextSource | null {
  const location = configStore.get().context?.current
  return (location && recentSources().find((s) => s.location === location)) || null
}

/** Make `source` the context, first of the recent ones, and start reading it. */
export function useSource(source: ContextSource): void {
  if (source.kind === 'clipboard') return
  const recent = [source, ...recentSources().filter((s) => s.location !== source.location)].slice(0, MAX_RECENT)
  configStore.update({ context: { current: source.location, recent } })
  warm(source)
}

/** Choose a recent context by its location, or none (''). */
export function selectSource(location: string): void {
  if (!location) {
    configStore.update({ context: { current: '' } })
    return
  }
  const source = recentSources().find((s) => s.location === location)
  if (source) useSource(source)
}

/** Forget a recent context, and delete Speak's copy of it (a clone, a page). */
export async function removeSource(location: string): Promise<void> {
  const source = recentSources().find((s) => s.location === location)
  const { current } = configStore.get().context
  configStore.update({
    context: { current: current === location ? '' : current, recent: recentSources().filter((s) => s.location !== location) }
  })
  memo.delete(location)
  if (source?.kind === 'git') await removeClone(location).catch((err) => log.warn('Could not delete the clone:', err))
  if (source?.kind === 'url') await removePage(location).catch((err) => log.warn('Could not delete the page:', err))
}

async function load(source: ContextSource): Promise<ReadContext> {
  switch (source.kind) {
    case 'folder': {
      if (!isDir(source.location)) throw new Error(`Folder not found: ${source.location}`)
      return { source, dir: source.location, text: await folderOverview(source.location, source.label, MAX_CONTEXT_CHARS) }
    }
    case 'git': {
      const dir = await checkout(source.location)
      return { source, dir, text: await folderOverview(dir, source.label, MAX_CONTEXT_CHARS, source.location) }
    }
    case 'url': {
      const page = await readPage(source.location)
      const head = `Web page${page.title ? ` "${page.title}"` : ''}, ${source.location}`
      return { source, text: `${head}\n\n${page.text}`.slice(0, MAX_CONTEXT_CHARS) }
    }
    default:
      throw new Error('The clipboard is read when the recording stops.')
  }
}

const memo = new Map<string, { at: number; promise: Promise<ReadContext> }>()

/** Read a context, or reuse the reading under way or just done. */
export function readContext(source: ContextSource): Promise<ReadContext> {
  const hit = memo.get(source.location)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise
  const entry = { at: Date.now(), promise: load(source) }
  memo.set(source.location, entry)
  // A failure is not kept: the next dictation tries again.
  entry.promise.catch(() => memo.get(source.location) === entry && memo.delete(source.location))
  return entry.promise
}

/** Start reading a context in the background (while the user speaks), so it's ready when needed. */
export function warm(source: ContextSource | null): void {
  if (source && source.kind !== 'clipboard') readContext(source).catch((err) => log.warn(`Context "${source.label}":`, (err as Error).message))
}

/** A dictation's context, or why it couldn't be read: dictating goes on without it either way. */
export async function contextFor(source: ContextSource, waitMs = WAIT_MS): Promise<{ context?: ReadContext; error?: string }> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: `${source.label} took too long to read: went on without it.` }), waitMs)
  })
  try {
    return await Promise.race([readContext(source).then((context) => ({ context })), late])
  } catch (err) {
    return { error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

/** Add a folder, git or web address as the context. `check`: read it first, and refuse it when that fails. */
export async function addSource(input: string, check = false): Promise<ContextSource> {
  const source = parseSource(input)
  if (!source) {
    const looksLikePath = /^([a-z]:|[\\/~])/i.test(input.trim())
    throw new Error(
      looksLikePath ? `Folder not found: ${input.trim()}` : 'Enter a folder path, a git repository (https://github.com/owner/name) or a web page address.'
    )
  }
  if (check) await readContext(source)
  useSource(source)
  return source
}
