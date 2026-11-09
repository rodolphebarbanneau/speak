import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { log } from '../../log'
import type { Accessibility, BeforeCursor, Element, Focused, WindowInfo } from './types'

/**
 * A helper process kept for the session, answering JSON lines: Speak's bridge to the system's
 * accessibility API (UI Automation through PowerShell on Windows, AX on macOS, AT-SPI on Linux,
 * the last two through Electron run as Node). Out of Speak's process: an app that hangs, or a
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

export interface BridgeSpec {
  /** For messages: "UI Automation". */
  label: string
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** How to run one of Speak's own bridge scripts: Electron as plain Node, which still reads the app's archive. */
export function nodeBridge(label: string, script: string): BridgeSpec {
  return { label, command: process.execPath, args: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}

export class Bridge {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private buf = ''
  private seq = 0
  private waiting = new Map<number, (r: BridgeReply) => void>()
  private label = 'The bridge'

  constructor(private spec: () => BridgeSpec) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const spec = this.spec()
    this.label = spec.label
    const proc = spawn(spec.command, spec.args, { windowsHide: true, env: spec.env ?? process.env })
    this.proc = proc
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${spec.label} did not start`))
        // Gone for good: the next request starts it again.
        proc.kill()
      }, 15_000)
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (d: string) => {
        this.buf += d
        let i: number
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim()
          this.buf = this.buf.slice(i + 1)
          if (!line) continue
          try {
            const m = JSON.parse(line)
            if (m.ready) {
              clearTimeout(timer)
              resolve()
            } else this.waiting.get(m.id)?.(m)
            this.waiting.delete(m.id)
          } catch {
            // not ours
          }
        }
      })
      proc.stderr.on('data', (d) => log.warn(`Control ${spec.label}:`, String(d).trim().slice(0, 300)))
      // Gone between two requests: what's written to it then is lost, not an error of Speak's.
      proc.stdin.on('error', (err) => log.warn(`Control ${spec.label}:`, err.message))
      proc.on('error', (err) => {
        // Never started (no exit follows): the next request tries again.
        log.warn(`Control ${spec.label} could not start:`, err.message)
        clearTimeout(timer)
        reject(new Error(`${spec.label} could not start: ${err.message}`))
        for (const done of this.waiting.values()) done({ error: `${spec.label} could not start` })
        this.waiting.clear()
        if (this.proc === proc) {
          this.proc = null
          this.ready = null
          this.buf = ''
        }
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        if (code) log.warn(`Control ${spec.label} stopped (exit ${code})`)
        reject(new Error(`${spec.label} stopped`))
        for (const done of this.waiting.values()) done({ error: `${spec.label} stopped` })
        this.waiting.clear()
        if (this.proc === proc) {
          this.proc = null
          this.ready = null
          this.buf = ''
        }
      })
    })
    return this.ready
  }

  /** The request carries its deadline (`until`): past it, the bridge drops it unstarted (it would act too late). */
  async ask(req: Record<string, unknown>, timeoutMs = 8000): Promise<BridgeReply> {
    await this.start()
    const id = ++this.seq
    return new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ error: `${this.label} took too long (the app may not expose its controls)`, timedOut: true })
      }, timeoutMs)
      this.waiting.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.proc?.stdin.write(JSON.stringify({ ...req, id, until: Date.now() + timeoutMs }) + '\n')
    })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
    this.buf = ''
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
