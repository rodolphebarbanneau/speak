import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { log } from '../log'
import { run, shellEnv, which } from '../util'

/**
 * A folder's overview for the AI: what the project is (the start of its README), its files and
 * the names declared in its code. Dictation uses it to spell file names, functions and terms the
 * way the project does; compose starts from it before reading the files it needs.
 *
 * Only reads. In a git repository, the file list comes from `git ls-files`, which reads the index
 * and never writes it (optional locks off, no fsmonitor).
 */

/** The most files listed, and source files scanned for names. */
const MAX_FILES = 800
const MAX_SCANNED = 400
/** Names are what dictation needs most: up to this many characters of them, the files take the rest. */
const NAMES_CHARS = 12_000
const MAX_FILE_BYTES = 256 * 1024
const README_CHARS = 2500

/** Folders skipped outside git repositories (inside, .gitignore decides). */
const SKIP = new Set([
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
  'site-packages',
  'Pods',
  'DerivedData'
])

const SOURCE = new Set(
  '.ts .tsx .js .jsx .mjs .cjs .vue .svelte .py .rs .go .java .kt .kts .swift .rb .php .cs .fs .cpp .cc .c .h .hpp .m .mm .scala .dart .ex .exs .lua .sh .ps1 .sql .zig .jl .r'.split(
    ' '
  )
)

/** `function foo`, `class Foo`, `def foo`, `fn foo`, `func (r) Foo`, `const fooBar`… */
const DECLARATION =
  /\b(?:function\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|const|let|var|static|module|record|object)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/g
/** Methods, indented: `  async startRecording(`, `  private readTaken(`. */
const METHOD = /^[ \t]+(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(/gm

/** Names worth spelling out: camelCase, PascalCase, snake_case. Plain words ("data") aren't. */
function distinctive(name: string): boolean {
  return name.length >= 4 && (/[a-z][A-Z]/.test(name) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(name) || /^[A-Z][a-z]+[A-Z]?/.test(name))
}

const depth = (path: string) => path.split('/').length

/** Shallow files first (they say most about a project), then alphabetical. */
const byDepth = (a: string, b: string) => depth(a) - depth(b) || a.localeCompare(b)

/** Files git knows about (tracked, and untracked but not ignored), or null outside a repository. */
async function gitFiles(dir: string): Promise<string[] | null> {
  const git = which('git')
  if (!git) return null
  try {
    const r = await run(git, ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: dir,
      timeoutMs: 8000,
      env: { ...shellEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    })
    if (r.code !== 0) return null
    return [...new Set(r.stdout.split('\0').filter(Boolean))]
  } catch {
    return null
  }
}

/** Files under `dir`, breadth first, skipping hidden and generated folders, within a time limit. */
async function walk(dir: string, limit = 5000, deadlineMs = 2000): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = ['']
  const until = Date.now() + deadlineMs
  while (queue.length && files.length < limit && Date.now() < until) {
    const rel = queue.shift()!
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && depth(path) <= 8) queue.push(path)
      } else if (e.isFile()) files.push(path)
    }
  }
  return files
}

/** Names declared in the project's source files, the most used first. */
async function codeNames(dir: string, files: string[]): Promise<string[]> {
  const sources = files
    .filter((f) => SOURCE.has(extname(f).toLowerCase()))
    .sort(byDepth)
    .slice(0, MAX_SCANNED)
  const counts = new Map<string, number>()
  for (let i = 0; i < sources.length; i += 32) {
    await Promise.all(
      sources.slice(i, i + 32).map(async (file) => {
        const path = join(dir, file)
        const info = await stat(path).catch(() => null)
        if (!info || info.size > MAX_FILE_BYTES) return
        const text = await readFile(path, 'utf8').catch(() => '')
        for (const m of [...text.matchAll(DECLARATION), ...text.matchAll(METHOD)]) {
          const name = m[1]
          if (distinctive(name)) counts.set(name, (counts.get(name) ?? 0) + 1)
        }
      })
    )
  }
  const names: string[] = []
  let size = 0
  for (const [name] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    size += name.length + 2
    if (size > NAMES_CHARS) break
    names.push(name)
  }
  return names
}

async function readme(dir: string, files: string[]): Promise<string> {
  const file = files.filter((f) => !f.includes('/') && /^readme(\.(md|markdown|txt|rst|adoc))?$/i.test(f)).sort()[0]
  if (!file) return ''
  const text = await readFile(join(dir, file), 'utf8').catch(() => '')
  return text.length > README_CHARS ? `${text.slice(0, README_CHARS).trimEnd()}\n[…]` : text.trim()
}

/** The overview of `dir`, at most `maxChars` long. `origin`: where a copy came from (a git address). */
export async function folderOverview(dir: string, name: string, maxChars: number, origin?: string): Promise<string> {
  const started = Date.now()
  const files = (await gitFiles(dir)) ?? (await walk(dir))
  const [intro, names] = await Promise.all([readme(dir, files), codeNames(dir, files)])
  const shown = files.slice().sort(byDepth).slice(0, MAX_FILES).sort()
  log.info(`Context "${name}": ${files.length} files, ${names.length} names, read in ${Date.now() - started}ms`)

  const head = origin ? `Project "${name}", a copy of the git repository ${origin}.` : `Project "${name}", the folder ${dir}.`
  const parts = [head]
  if (intro) parts.push(`README (start):\n${intro}`)
  if (names.length) parts.push(`Names declared in its code:\n${names.join(', ')}`)
  const listed = `Files (${files.length}${files.length > shown.length ? `, the first ${shown.length} shown` : ''}):\n`
  // The file list takes the room the rest leaves.
  const room = maxChars - parts.join('\n\n').length - listed.length - 2
  let list = ''
  for (const f of shown) {
    if (list.length + f.length + 1 > room) break
    list += `${f}\n`
  }
  if (list) parts.push(listed + list.trimEnd())
  return parts.join('\n\n').slice(0, maxChars)
}
