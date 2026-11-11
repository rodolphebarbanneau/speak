import { spawn } from 'node:child_process'
import { utilityProcess } from 'electron'
import { log } from '../../log'
import type { Accessibility, BeforeCursor, Element, Focused, WindowInfo } from './types'

/**
 * A helper process kept for the session, answering Speak's requests: its bridge to the system's
 * accessibility API (UI Automation through PowerShell on Windows, AX on macOS, AT-SPI on Linux,
 * the last two in an Electron utility process). Out of Speak's process: an app that hangs, or a
 * crash in the native calls, only stops the bridge, which starts again on the next request.
 */

export interface BridgeReply {
  elements?: Element[]
  focused?: Focused
  before?: BeforeCursor
  /** What a background action did ('invoke', 'value'…), or null when the element doesn't support it. */
  done?: string | null
  /** Window ids (macOS: the minimized ones). */
  ids?: number[]
  error?: string
  /** No answer in time: the request may still run (its deadline drops it if it hasn't started). */
  timedOut?: boolean
}

/**
 * The bridge didn't answer in time. Unlike a refusal, the action may have happened (an app busy
 * with a dialog it just opened answers late): nothing should do it again another way.
 */
export class BridgeTimeout extends Error {}

/**
 * A program answering one JSON line on its standard output for each one on its input (PowerShell),
 * or one of Speak's own bridge scripts (see nodeBridge). `label` is for messages: "UI Automation".
 */
export type BridgeSpec = { label: string; command: string; args: string[] } | { label: string; script: string }

/**
 * One of Speak's own bridge scripts (serve.ts): an Electron utility process, a child of Speak's
 * that macOS counts as Speak for its permissions. Never Electron run as Node: packaged builds turn
 * that off (see electronFuses in electron-builder.yml).
 */
export function nodeBridge(label: string, script: string): BridgeSpec {
  return { label, script }
}

/** A message from the bridge: its `ready`, or the reply to a request (its id). */
type BridgeMessage = BridgeReply & { id?: number; ready?: boolean }

/** A running bridge, however it was started. */
interface Link {
  send(req: Record<string, unknown>): void
  kill(): void
}

interface LinkEvents {
  message(m: BridgeMessage): void
  /** Stopped, or never started: what it was answering is lost. */
  gone(why: string): void
}

function spawnProgram(spec: { label: string; command: string; args: string[] }, on: LinkEvents): Link {
  const proc = spawn(spec.command, spec.args, { windowsHide: true })
  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m: BridgeMessage
      try {
        m = JSON.parse(line)
      } catch {
        continue // not ours
      }
      on.message(m)
    }
  })
  proc.stderr.on('data', (d) => log.warn(`Control ${spec.label}:`, String(d).trim().slice(0, 300)))
  // Gone between two requests: what's written to it then is lost, not an error of Speak's.
  proc.stdin.on('error', (err) => log.warn(`Control ${spec.label}:`, err.message))
  proc.on('error', (err) => {
    // Never started (no exit follows).
    log.warn(`Control ${spec.label} could not start:`, err.message)
    on.gone(`could not start: ${err.message}`)
  })
  proc.on('exit', (code) => {
    if (code) log.warn(`Control ${spec.label} stopped (exit ${code})`)
    on.gone('stopped')
  })
  return { send: (req) => proc.stdin.write(JSON.stringify(req) + '\n'), kill: () => proc.kill() }
}

function forkScript(spec: { label: string; script: string }, on: LinkEvents): Link {
  const child = utilityProcess.fork(spec.script, [], { serviceName: `Speak ${spec.label}`, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr?.on('data', (d) => log.warn(`Control ${spec.label}:`, String(d).trim().slice(0, 300)))
  child.on('message', (m: BridgeMessage) => on.message(m))
  child.on('exit', (code) => {
    if (code) log.warn(`Control ${spec.label} stopped (exit ${code})`)
    on.gone('stopped')
  })
  return { send: (req) => child.postMessage(req), kill: () => void child.kill() }
}

export class Bridge {
  private link: Link | null = null
  private ready: Promise<void> | null = null
  private seq = 0
  /** Each request waiting for its reply, with the bridge it went to. */
  private waiting = new Map<number, { link: Link; done: (r: BridgeReply) => void }>()
  private label = 'The bridge'

  constructor(private spec: () => BridgeSpec) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const spec = this.spec()
    this.label = spec.label
    let link: Link | null = null
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${spec.label} did not start`))
        // Gone for good: the next request starts it again.
        link?.kill()
      }, 15_000)
      const on: LinkEvents = {
        message: (m) => {
          if (m.ready) {
            clearTimeout(timer)
            resolve()
          } else if (m.id !== undefined) {
            this.waiting.get(m.id)?.done(m)
            this.waiting.delete(m.id)
          }
        },
        gone: (why) => {
          clearTimeout(timer)
          reject(new Error(`${spec.label} ${why}`))
          for (const [id, w] of this.waiting) {
            if (w.link !== link) continue
            w.done({ error: `${spec.label} ${why}` })
            this.waiting.delete(id)
          }
          // The next request starts it again (unless it was already replaced).
          if (link && this.link === link) {
            this.link = null
            this.ready = null
          }
        }
      }
      try {
        link = 'script' in spec ? forkScript(spec, on) : spawnProgram(spec, on)
      } catch (err) {
        on.gone(`could not start: ${(err as Error).message}`)
      }
    })
    // Didn't start: refused now, tried again on the next request.
    if (!link) return ready
    this.link = link
    this.ready = ready
    return ready
  }

  /** The request carries its deadline (`until`): past it, the bridge drops it unstarted (it would act too late). */
  async ask(req: Record<string, unknown>, timeoutMs = 8000): Promise<BridgeReply> {
    await this.start()
    const link = this.link
    if (!link) return { error: `${this.label} stopped` }
    const id = ++this.seq
    return new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ error: `${this.label} took too long (the app may not expose its controls)`, timedOut: true })
      }, timeoutMs)
      this.waiting.set(id, {
        link,
        done: (r) => {
          clearTimeout(timer)
          resolve(r)
        }
      })
      link.send({ ...req, id, until: Date.now() + timeoutMs })
    })
  }

  stop(): void {
    this.link?.kill()
    this.link = null
    this.ready = null
  }
}

/**
 * A window's controls through a bridge. Each request names the window (its id, which the Windows
 * script reads as `hwnd`, its app's process, title and place, which AX and AT-SPI need to find it);
 * `context` adds what the bridge needs to find the field with the keyboard (Linux: the app in front).
 */
export class BridgeAccessibility implements Accessibility {
  constructor(
    readonly bridge: Bridge,
    private context: () => Record<string, unknown> = () => ({}),
    private elementsMs = 8000
  ) {}

  private win(w: WindowInfo): Record<string, unknown> {
    return { hwnd: w.id, win: { id: w.id, pid: w.pid, title: w.title, rect: w.rect } }
  }

  async elements(w: WindowInfo, max = 250): Promise<Element[]> {
    const r = await this.bridge.ask({ op: 'elements', ...this.win(w), max }, this.elementsMs)
    if (r.error) throw new Error(r.error)
    return r.elements ?? []
  }

  /**
   * What an action did (null: the element can't do it that way); a refusal throws an Error, no
   * answer in time a BridgeTimeout. The bridge is then started again: an app that blocks on the
   * action (a dialog it opened, waiting for the user) would hold every next request behind it.
   */
  private async act(req: Record<string, unknown>): Promise<string | null> {
    const r = await this.bridge.ask(req)
    if (r.timedOut) {
      this.bridge.stop()
      throw new BridgeTimeout(
        "The app didn't answer in time: the action may have been done anyway (an app answers late while a dialog it just opened waits). Look at the window before trying again, and don't do it another way meanwhile."
      )
    }
    if (r.error) throw new Error(r.error)
    return r.done ?? null
  }

  press(w: WindowInfo, index: number): Promise<string | null> {
    return this.act({ op: 'press', ...this.win(w), index })
  }

  fill(w: WindowInfo, index: number, text: string): Promise<string | null> {
    return this.act({ op: 'fill', ...this.win(w), index, text })
  }

  scroll(w: WindowInfo, index: number | undefined, dy: number): Promise<string | null> {
    return this.act({ op: 'scroll', ...this.win(w), index: index ?? 0, dy })
  }

  async focus(w: WindowInfo, index: number): Promise<boolean> {
    const r = await this.bridge.ask({ op: 'focus', ...this.win(w), index })
    return !r.error
  }

  async focused(): Promise<Focused> {
    const r = await this.bridge.ask({ op: 'focused', ...this.context() }, 3000)
    return r.focused ?? null
  }

  async beforeCursor(n: number): Promise<BeforeCursor> {
    const r = await this.bridge.ask({ op: 'before', n, ...this.context() }, 3000)
    return r.before ?? null
  }

  warm(): void {
    void this.focused().catch(() => undefined)
  }

  stop(): void {
    this.bridge.stop()
  }
}
