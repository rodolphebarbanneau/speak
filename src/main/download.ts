import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { DownloadProgress } from '../shared/types'
import { log } from './log'

class Downloads extends EventEmitter {
  private active = new Map<string, AbortController>()

  isActive(id: string): boolean {
    return this.active.has(id)
  }

  cancel(id: string): void {
    this.active.get(id)?.abort()
  }

  progress(p: DownloadProgress): void {
    this.emit('progress', p)
  }

  /** Download `url` to `dest` (via a .part file), reporting progress under `id`. */
  async fetch(id: string, label: string, url: string, dest: string): Promise<void> {
    if (this.active.has(id)) throw new Error('Download already in progress')
    const controller = new AbortController()
    this.active.set(id, controller)
    const part = dest + '.part'
    let received = 0
    let total = 0
    try {
      log.info('Downloading', url)
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
      total = Number(res.headers.get('content-length')) || 0
      let last = 0
      const body = Readable.fromWeb(res.body as ReadableStream<Uint8Array>)
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        const now = Date.now()
        if (now - last > 150) {
          last = now
          this.progress({ id, label, received, total, state: 'running' })
        }
      })
      await pipeline(body, createWriteStream(part), { signal: controller.signal })
      await rename(part, dest)
      this.progress({ id, label, received, total: total || received, state: 'done' })
    } catch (err) {
      await rm(part, { force: true })
      const cancelled = controller.signal.aborted
      this.progress({ id, label, received, total, state: cancelled ? 'cancelled' : 'error', error: String((err as Error).message ?? err) })
      throw cancelled ? new Error('Download cancelled') : err
    } finally {
      this.active.delete(id)
    }
  }
}

export const downloads = new Downloads()
