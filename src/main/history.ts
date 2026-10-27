import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '../shared/types'
import { configStore } from './config'
import { log } from './log'
import { paths } from './paths'

const pad = (n: number) => String(n).padStart(2, '0')

export function newSessionId(date = new Date()): string {
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const t = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${d}-${t}-${randomBytes(2).toString('hex')}`
}

/** history/YYYY-MM-DD/<id>/ */
function sessionDir(id: string): string {
  const day = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`
  return join(paths.history, day, id)
}

class History extends EventEmitter {
  private cache = new Map<string, Session>()

  dir(id: string): string {
    return sessionDir(id)
  }

  async save(session: Session, audio?: Buffer): Promise<void> {
    this.cache.set(session.id, session)
    const cfg = configStore.get().history
    if (!cfg.enabled) return
    const dir = sessionDir(session.id)
    try {
      await mkdir(dir, { recursive: true })
      if (audio && cfg.keepAudio) await writeFile(join(dir, 'audio.wav'), audio)
      await writeFile(join(dir, 'session.json'), JSON.stringify(session, null, 2))
      this.emit('changed')
    } catch (err) {
      log.error('Failed to save session', session.id, err)
    }
  }

  async get(id: string): Promise<Session | null> {
    const cached = this.cache.get(id)
    if (cached) return cached
    try {
      const s = JSON.parse(await readFile(join(sessionDir(id), 'session.json'), 'utf8')) as Session
      this.cache.set(id, s)
      return s
    } catch {
      return null
    }
  }

  async audio(id: string): Promise<Buffer | null> {
    try {
      return await readFile(join(sessionDir(id), 'audio.wav'))
    } catch {
      return null
    }
  }

  async list(query = '', limit = 200): Promise<Session[]> {
    const out: Session[] = []
    const q = query.trim().toLowerCase()
    let days: string[] = []
    try {
      days = (await readdir(paths.history))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()
    } catch {
      return out
    }
    for (const day of days) {
      const ids = (await readdir(join(paths.history, day))).sort().reverse()
      for (const id of ids) {
        const s = await this.get(id)
        if (!s) continue
        if (q && !`${s.text}\n${s.transcription.text}`.toLowerCase().includes(q)) continue
        out.push(s)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  async delete(id: string): Promise<void> {
    this.cache.delete(id)
    await rm(sessionDir(id), { recursive: true, force: true })
    this.emit('changed')
  }

  /**
   * A dictation cancelled in the preview is kept only until the next one is saved: a safety net
   * for a mistaken Esc, without filling the history with discarded text.
   */
  async dropCancelled(keepId: string): Promise<void> {
    for (const s of await this.list('', Infinity)) if (s.action === 'cancelled' && s.id !== keepId) await this.delete(s.id)
  }

  /** How many dictations are stored, and their size on disk (transcripts and recordings). */
  async stats(): Promise<{ count: number; bytes: number }> {
    let count = 0
    let bytes = 0
    if (!existsSync(paths.history)) return { count, bytes }
    for (const day of await readdir(paths.history)) {
      const dayDir = join(paths.history, day)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      for (const id of await readdir(dayDir)) {
        const files = await readdir(join(dayDir, id)).catch((): string[] => [])
        if (files.includes('session.json')) count++
        for (const f of files) bytes += (await stat(join(dayDir, id, f)).catch(() => null))?.size ?? 0
      }
    }
    return { count, bytes }
  }

  /** Delete every dictation, transcripts and recordings. */
  async clear(): Promise<void> {
    this.cache.clear()
    if (existsSync(paths.history)) {
      for (const day of await readdir(paths.history)) await rm(join(paths.history, day), { recursive: true, force: true })
    }
    log.info('History cleared')
    this.emit('changed')
  }

  /** Delete sessions older than the retention period (0 = keep forever). */
  async prune(): Promise<void> {
    const days = configStore.get().history.retentionDays
    if (!days || days <= 0 || !existsSync(paths.history)) return
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    for (const day of await readdir(paths.history)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
        await rm(join(paths.history, day), { recursive: true, force: true })
        log.info('Pruned history day', day)
      }
    }
    this.cache.clear()
  }
}

export const history = new History()
