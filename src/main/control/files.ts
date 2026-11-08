import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat, cp } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { paths } from '../paths'
import { isMac, isWin } from '../util'

/**
 * File changes control mode can undo: each one is journaled, with a copy of what it replaced.
 * Speak's "trash" moves things into ~/.speak/control/trash/<session>, from where undo brings them
 * back (the system trash can't be emptied back programmatically).
 */

export type FileOp =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'trash'; path: string; kept: string }
  /** A file written or edited: `backup` is its content before (none: it didn't exist). */
  | { kind: 'write'; path: string; backup?: string }

const same = (a: string, b: string) => (isWin || isMac ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Whether `path` is `root` or inside it. */
export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) || same(resolve(root), resolve(path))
}

export function controlDir(session: string): string {
  return join(paths.home, 'control', session)
}

/** Where a session's trash and backups go. */
const trashDir = (session: string) => join(controlDir(session), 'trash')
const backupDir = (session: string) => join(controlDir(session), 'backup')

async function exists(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => null))
}

/** Move (or rename) a file or folder; never over something that exists. */
export async function moveItem(from: string, to: string): Promise<FileOp> {
  if (!(await exists(from))) throw new Error(`Not found: ${from}`)
  // Into an existing folder: keep the name.
  const target = (await stat(to).catch(() => null))?.isDirectory() && !same(dirname(from), resolve(to)) ? join(to, basename(from)) : to
  if (await exists(target)) throw new Error(`Already exists: ${target}`)
  await mkdir(dirname(target), { recursive: true })
  await moveAcross(from, target)
  return { kind: 'move', from, to: target }
}

/** rename, or copy then delete across drives. */
async function moveAcross(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

export async function makeFolder(path: string): Promise<FileOp | null> {
  if (await exists(path)) return null
  await mkdir(path, { recursive: true })
  return { kind: 'mkdir', path }
}

export async function trashItem(session: string, path: string): Promise<FileOp> {
  if (!(await exists(path))) throw new Error(`Not found: ${path}`)
  const kept = join(trashDir(session), `${randomBytes(3).toString('hex')}-${basename(path)}`)
  await mkdir(dirname(kept), { recursive: true })
  await moveAcross(path, kept)
  return { kind: 'trash', path, kept }
}

/** Before a file is written or edited: keep a copy of it, to undo. */
export async function backupBeforeWrite(session: string, path: string): Promise<FileOp> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return { kind: 'write', path }
  const backup = join(backupDir(session), `${randomBytes(3).toString('hex')}-${basename(path)}`)
  await mkdir(dirname(backup), { recursive: true })
  await copyFile(path, backup)
  return { kind: 'write', path, backup }
}

/** Take a change back. */
export async function undoOp(op: FileOp): Promise<void> {
  switch (op.kind) {
    case 'move':
      if (await exists(op.from)) throw new Error(`Something is already at ${op.from}`)
      await mkdir(dirname(op.from), { recursive: true })
      await moveAcross(op.to, op.from)
      return
    case 'mkdir':
      // Only an empty folder: what was put in it since is undone separately.
      if ((await readdir(op.path).catch(() => [])).length) throw new Error(`${op.path} is not empty`)
      await rm(op.path, { recursive: true, force: true })
      return
    case 'trash':
      if (await exists(op.path)) throw new Error(`Something is already at ${op.path}`)
      await mkdir(dirname(op.path), { recursive: true })
      await moveAcross(op.kept, op.path)
      return
    case 'write':
      if (op.backup && existsSync(op.backup)) await copyFile(op.backup, op.path)
      else await rm(op.path, { force: true })
  }
}

/** A line for the panel: what the change was. */
export function describeOp(op: FileOp): string {
  switch (op.kind) {
    case 'move':
      return same(dirname(op.from), dirname(op.to)) ? `renamed ${basename(op.from)} → ${basename(op.to)}` : `moved ${basename(op.from)} → ${dirname(op.to)}`
    case 'mkdir':
      return `made folder ${op.path}`
    case 'trash':
      return `trashed ${basename(op.path)}`
    case 'write':
      return `${op.backup ? 'edited' : 'wrote'} ${op.path}`
  }
}
