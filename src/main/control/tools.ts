import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { shell } from 'electron'
import type { ControlAlwaysAsk, ControlRisk, ControlScope } from '../../shared/types'
import { log } from '../log'
import { delay, isMac, isWin } from '../util'
import { makeFolder, moveItem, trashItem, type FileOp } from './files'
import { openApp } from './open'
import {
  a11y,
  BridgeTimeout,
  captureWindow,
  click,
  cursorPos,
  desktopRect,
  displayRects,
  drag,
  focusWindow,
  foregroundWindow,
  hasKeyboard,
  insertText,
  listWindows,
  markBox,
  moveMouse,
  pressing,
  pressKeys,
  refreshWindows,
  scroll,
  shoot,
  shortcutMod,
  unminimize,
  windowAt,
  windowInfo,
  type Element,
  type Rect,
  type Shot,
  type WindowInfo
} from './screen'

/**
 * Speak's tools for the AI of a control session, served as an MCP server on 127.0.0.1 (with a
 * token): the screen, undoable file changes, and talking to the user (a plan to approve, a
 * question). Every action goes through the session's gate first, and keeps to the scope here, in
 * Speak's code: the AI is told its scope, but doesn't decide it.
 *
 * The screen is shared with the user, who may be working on something else meanwhile. So Speak acts
 * in the background whenever it can: it looks at windows without bringing them forward, and
 * presses, fills and scrolls through the system's accessibility API (UI Automation, AX, AT-SPI),
 * without the mouse or the keyboard. What needs the real mouse or keyboard borrows them: it waits
 * until the user's hands are still, acts, and gives them back (the pointer where it was, the focus
 * to the user's window); the user touching them meanwhile stops that action there.
 */

/** An action, as the gate sees it. key: what "always" approves (the same kind of action). */
export interface ActionRequest {
  title: string
  detail?: string
  risk: ControlRisk
  category?: keyof ControlAlwaysAsk
  key: string
  /** Typed into a password field: the panel doesn't show the text. */
  secret?: boolean
  /** Where it will act, on its latest look (a data URL, the spot boxed): shown with the approval. */
  image?: string
  /** Where it will act on the screen, to box it there while asking (when it's visible), and in which window. */
  area?: Rect
  areaWindow?: number
}

export type Gate = { ok: true; step: string } | { ok: false; reason: string }

export interface StepResult {
  ok: boolean
  error?: string
  op?: FileOp
  /** A small screenshot (data URL). */
  image?: string
  detail?: string
}

export interface ToolHost {
  readonly session: string
  scope(): { kind: ControlScope; apps: Array<{ pid: number; exe: string; title: string }>; label: string }
  gate(req: ActionRequest): Promise<Gate>
  finish(step: string, result: StepResult): void
  /** A step that only looks (shown, never asked). */
  looked(text: string, image?: string): void
  /** Before anything that touches the screen, even only to look: waits while paused; false once stopped or ended. */
  hold(): Promise<boolean>
  /**
   * Before borrowing the user's mouse and keyboard: waits until their hands have been still for a
   * moment (or they say go). False once stopped or ended.
   */
  handsFree(what: string): Promise<boolean>
  /** When the user last touched the mouse or the keyboard (ms timestamp; 0: not since the session started). */
  lastInput(): number
  /** Whether actions may go on: not paused, stopped or ended. */
  running(): boolean
  /** The user took the mouse or the keyboard during an action: Speak doesn't take them again until they say to. */
  tookOver(): void
  plan(steps: string[], summary?: string): Promise<{ approved: boolean; reason?: string }>
  ask(question: string): Promise<string>
  /** Add an app to the scope (asks the user). */
  widen(app: WindowInfo, why: string): Promise<boolean>
  /** Speak has the mouse and the keyboard, there (a frame around it), or not anymore (null). */
  acting(win: WindowInfo | null): void
}

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, any>) => Promise<Content[]>
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const text = (t: string): Content[] => [{ type: 'text', text: t }]

/**
 * A background action that failed: a real click, or typing, does it instead. Unless the bridge
 * didn't answer in time: the action may have happened anyway, and must not happen twice.
 */
const refused = (err: unknown): null => {
  if (err instanceof BridgeTimeout) throw err
  return null
}
const HELD = 'The user stopped you. Wait for their next order: do nothing more.'
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const INTENT = { type: 'string', description: 'What this does and why, in a short phrase in the user\'s language: "click Send to send the reply".' }
const RISKY = { type: 'boolean', description: 'True when it sends or publishes as the user, pays or buys, deletes for good, or changes passwords or security.' }

/** The user was working moments ago: what Speak borrowed goes back to them. */
const BUSY_MS = 20_000

const CATEGORIES: Array<[keyof ControlAlwaysAsk, RegExp]> = [
  ['money', /\b(pay|payer|paiement|buy|acheter|achat|purchase|checkout|order now|commander|transfer|virement|subscribe|s'abonner|place order)\b/i],
  ['secrets', /\b(password|mot de passe|passcode|2fa|two-factor|security|sécurité|credential|token|secret|pin)\b/i],
  ['delete', /\b(delete|supprimer|remove|retirer|erase|effacer|empty (the )?(trash|recycle bin)|vider la corbeille|uninstall|désinstaller)\b/i],
  ['send', /\b(send|envoyer|post|poster|publish|publier|reply|répondre|submit|soumettre|tweet|share|partager|comment|commenter)\b/i]
]

/** What an action touches among the always-ask items, from what the AI says it does and the control's name. */
export function categoryOf(...texts: Array<string | undefined>): keyof ControlAlwaysAsk | undefined {
  const all = texts.filter(Boolean).join(' · ')
  return CATEGORIES.find(([, re]) => re.test(all))?.[0]
}

/** A window's title, short enough for a line of the panel. */
function windowName(w: WindowInfo): string {
  const title = w.title.trim() || w.exe.replace(/\.exe$/i, '')
  return title.length > 48 ? `${title.slice(0, 47)}…` : title
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const inRect = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h

class Held extends Error {}

/** On the panel, why an action stopped on the way. */
const STOPPED_LABEL: Record<'hands' | 'focus' | 'halted', string> = {
  hands: 'you took the mouse or the keyboard',
  focus: 'another window took the keyboard',
  halted: 'paused or stopped'
}

/**
 * Why a real-input action stopped before its end: the user's hands on the mouse or the keyboard,
 * the keyboard gone to another window (it never types there), or paused, stopped or ended.
 */
type Stopped = 'hands' | 'focus' | 'halted'

/** What a real-input action left: its result, and why it stopped, if it did. */
interface Borrowed<T> {
  result?: T
  stopped?: Stopped
}

/** Typed text read back from its field: there, or what's before the cursor instead. Null: the field can't be read. */
type Check = { ok: true } | { ok: false; shows: string } | null

/** What a borrowed action needs: the keyboard on its window (typing, keys), a button held (a drag). */
interface BorrowNeeds {
  keyboard?: boolean
  holdsButton?: boolean
}

export class ToolServer {
  private server: Server | null = null
  readonly token = randomBytes(24).toString('hex')
  url = ''
  /** The latest look at each window ('screen' for a display): to map its pixels back, and show where it acts. */
  private shots = new Map<string, Shot>()
  /** The window it looked at or acted on last: the default one. */
  private current: number | null = null
  /** A window whose cursor turned out to be in a password field when Speak was about to type: its next text goes in as a password. */
  private passwordIn: number | null = null
  /** The elements listed per window, by number (e1, e2…), as the accessibility bridge keeps them. */
  private elements = new Map<number, Element[]>()
  /** One action on the screen at a time: the AI may ask for several at once. */
  private lock: Promise<unknown> = Promise.resolve()

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  constructor(private host: ToolHost) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`
  }

  stop(): void {
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let msg: { id?: string | number; method?: string; params?: any }
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }
    if (msg.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const reply = (payload: Record<string, unknown>) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }))
    }
    switch (msg.method) {
      case 'initialize':
        return reply({
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'speak', version: '1' },
            instructions: "Speak's tools to act on the user's computer, within the session's scope."
          }
        })
      case 'ping':
        return reply({ result: {} })
      case 'tools/list':
        return reply({ result: { tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
      case 'tools/call': {
        const tool = this.tools().find((t) => t.name === msg.params?.name)
        if (!tool) return reply({ result: { content: text(`No tool ${msg.params?.name} in this scope.`), isError: true } })
        try {
          const content = await tool.run(msg.params?.arguments ?? {})
          return reply({ result: { content } })
        } catch (err) {
          if (err instanceof Held) return reply({ result: { content: text(HELD), isError: true } })
          log.warn(`Control tool ${tool.name} failed:`, (err as Error).message)
          return reply({ result: { content: text((err as Error).message), isError: true } })
        }
      }
      default:
        return reply({ error: { code: -32601, message: `Unknown method ${msg.method}` } })
    }
  }

  // ---------------------------------------------------------------- tools

  private tools(): Tool[] {
    const scope = this.host.scope()
    return [...this.talkTools(), ...this.screenTools(scope.kind), ...(scope.kind === 'full' ? this.fileTools() : [])]
  }

  private talkTools(): Tool[] {
    return [
      {
        name: 'propose_plan',
        description: 'Show the user your plan before acting: short steps in their language. Returns whether they approved it, or what they want instead.',
        inputSchema: obj(
          { summary: { type: 'string', description: 'One line, in their language: what you will do.' }, steps: { type: 'array', items: { type: 'string' } } },
          ['summary', 'steps']
        ),
        run: async (a) => {
          const r = await this.host.plan(a.steps ?? [], a.summary)
          return text(r.approved ? 'The user approved the plan: go ahead.' : `The user did not approve the plan${r.reason ? `: "${r.reason}"` : ''}. Adapt it.`)
        }
      },
      {
        name: 'ask_user',
        description: 'Ask the user a question and wait for their spoken answer. Only when you cannot go on without it.',
        inputSchema: obj({ question: { type: 'string' } }, ['question']),
        run: async (a) => text(`The user answered: "${await this.host.ask(String(a.question ?? ''))}"`)
      }
    ]
  }

  private screenTools(kind: ControlScope): Tool[] {
    const target = { window: { type: 'number', description: 'A window id from windows (default: the one you looked at or acted on last).' } }
    const element = { element: { type: 'string', description: 'An element id from elements, such as "e12".' } }
    const point = {
      ...element,
      x: { type: 'number', description: 'Without an element: x in the pixels of your latest look at that window.' },
      y: { type: 'number' }
    }
    const tools: Tool[] = [
      {
        name: 'windows',
        description: 'List the windows you may act on: id, app, title, which one the user is in.',
        inputSchema: obj({}),
        run: async () => {
          await refreshWindows()
          const wins = this.allowedWindows()
          if (!wins.length) return text('No window in your scope is open.')
          return text(
            wins.map((w) => `${w.id} · ${w.exe} · "${w.title}"${w.focused ? ' · the user is in it' : ''}${w.minimized ? ' · minimized' : ''}`).join('\n')
          )
        }
      },
      {
        name: 'look',
        description:
          "A screenshot of a window, even behind others, without disturbing the user. With screen: true, the whole display as it is in front (not in the app scope). x, y for click are in this picture's pixels.",
        inputSchema: obj({ ...target, screen: { type: 'boolean' } }),
        run: (a) => this.look(a.window, !!a.screen && kind !== 'app')
      },
      {
        name: 'elements',
        description:
          "List a window's controls (buttons, fields, links, menu items, text) with their ids, names, values and places. Acting on them by id works in the background. Some apps don't expose them: use look then.",
        inputSchema: obj({ ...target, filter: { type: 'string', description: 'Only those whose name or value contains this.' } }),
        run: (a) => this.listElements(a.window, a.filter)
      },
      {
        name: 'click',
        description:
          'Click an element (pressed in the background when it can be: buttons, links, checkboxes, tabs, list and menu items) or a point (borrows the mouse).',
        inputSchema: obj(
          { ...target, ...point, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' }, intent: INTENT, risky: RISKY },
          ['intent']
        ),
        run: (a) => this.click(a)
      },
      {
        name: 'fill',
        description: "Set a field's whole text (an input, a search box, a form field): in the background when the field allows it.",
        inputSchema: obj({ ...target, ...element, text: { type: 'string' }, intent: INTENT, risky: RISKY }, ['element', 'text', 'intent']),
        run: (a) => this.fill(a)
      },
      {
        name: 'type',
        description:
          'Type text where the cursor is, or into an element (a document, an email body, an editor): borrows the keyboard. It never presses Enter: long text, or text with line breaks, is pasted in one go (the clipboard is put back after), and a tab is a tab character. To send or submit, use key. For a form field, prefer fill.',
        inputSchema: obj({ ...target, ...element, text: { type: 'string' }, intent: INTENT, risky: RISKY }, ['text', 'intent']),
        run: (a) => this.type(a)
      },
      {
        name: 'key',
        description: isMac
          ? 'Press a key or a shortcut in a window: "enter", "tab", "escape", "cmd+s", "cmd+shift+t" (cmd is ⌘, ctrl is Control). Borrows the keyboard.'
          : 'Press a key or a shortcut in a window: "enter", "tab", "escape", "ctrl+s", "ctrl+shift+t". Borrows the keyboard.',
        inputSchema: obj({ ...target, keys: { type: 'string' }, intent: INTENT, risky: RISKY }, ['keys', 'intent']),
        run: (a) => this.key(a)
      },
      {
        name: 'scroll',
        description: 'Scroll a window, a list or a page: dy > 0 scrolls down, in notches (about 3 lines each). In the background when it can be.',
        inputSchema: obj({ ...target, ...point, dy: { type: 'number' } }, ['dy']),
        run: (a) => this.scroll(a)
      },
      {
        name: 'drag',
        description: 'Drag from one point of a window to another (pixels of your latest look). Borrows the mouse.',
        inputSchema: obj(
          {
            ...target,
            from_x: { type: 'number' },
            from_y: { type: 'number' },
            to_x: { type: 'number' },
            to_y: { type: 'number' },
            intent: INTENT,
            risky: RISKY
          },
          ['from_x', 'from_y', 'to_x', 'to_y', 'intent']
        ),
        run: (a) => this.drag(a)
      },
      {
        name: 'wait',
        description: 'Wait a moment for something to load (milliseconds, up to 10000).',
        inputSchema: obj({ ms: { type: 'number' } }, ['ms']),
        run: async (a) => {
          await delay(Math.max(100, Math.min(10_000, Number(a.ms) || 1000)))
          return text('Waited.')
        }
      }
    ]
    if (kind === 'app')
      tools.push({
        name: 'request_app',
        description: 'Ask the user to let you act on another open window too (another app), when the task needs it. Without window: the list of other windows.',
        inputSchema: obj({ window: { type: 'number' }, why: { type: 'string' } }, ['why']),
        run: (a) => this.requestApp(a.window, a.why)
      })
    else
      tools.push({
        name: 'open',
        description: `Open an app (by name, e.g. ${isMac ? '"textedit", "mail"' : isWin ? '"notepad", "outlook"' : '"gedit", "firefox"'}), a file, a folder or a web address. It opens behind the user's window when they are busy.`,
        inputSchema: obj({ target: { type: 'string' }, intent: INTENT }, ['target', 'intent']),
        run: (a) => this.open(a)
      })
    return tools
  }

  private fileTools(): Tool[] {
    const path = (p: string) => {
      if (!p) throw new Error('No path given.')
      return isAbsolute(p) ? p : resolve(homedir(), p)
    }
    const act = async (req: ActionRequest, fn: () => Promise<FileOp | null>, done: string) => {
      const g = await this.host.gate(req)
      if (!g.ok) return text(g.reason)
      try {
        const op = await fn()
        this.host.finish(g.step, { ok: true, op: op ?? undefined })
        return text(done)
      } catch (err) {
        this.host.finish(g.step, { ok: false, error: (err as Error).message })
        throw err
      }
    }
    return [
      {
        name: 'move',
        description: 'Move or rename a file or folder (into a folder: keeps its name). Never overwrites. Undoable.',
        inputSchema: obj({ from: { type: 'string' }, to: { type: 'string' }, intent: INTENT }, ['from', 'to', 'intent']),
        run: (a) => {
          const from = path(a.from)
          const to = path(a.to)
          return act({ title: a.intent || `move ${from}`, detail: `${from} → ${to}`, risk: 'change', key: 'move' }, () => moveItem(from, to), 'Moved.')
        }
      },
      {
        name: 'make_folder',
        description: 'Make a folder (and its parents). Undoable.',
        inputSchema: obj({ path: { type: 'string' }, intent: INTENT }, ['path', 'intent']),
        run: (a) => {
          const p = path(a.path)
          return act({ title: a.intent || `make folder ${p}`, detail: p, risk: 'change', key: 'make_folder' }, () => makeFolder(p), 'Done.')
        }
      },
      {
        name: 'trash',
        description: "Put a file or folder in Speak's trash (the user can undo it). The only way to delete.",
        inputSchema: obj({ path: { type: 'string' }, intent: INTENT }, ['path', 'intent']),
        run: (a) => {
          const p = path(a.path)
          return act({ title: a.intent || `trash ${p}`, detail: p, risk: 'change', key: 'trash' }, () => trashItem(this.host.session, p), 'Put in the trash.')
        }
      }
    ]
  }

  // ---------------------------------------------------------------- scope

  private inScope(w: WindowInfo): boolean {
    if (w.pid === process.pid) return false
    const scope = this.host.scope()
    if (scope.kind !== 'app') return true
    const same = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
    // Its process, unless that says nothing (no process known), or the apps differ: on Linux a
    // window's process is what the app says, and sandboxed ones (Flatpak) all say the same.
    return scope.apps.some((a) => (a.pid > 0 && a.pid === w.pid && (!a.exe || !w.exe || same(a.exe, w.exe))) || same(a.exe, w.exe))
  }

  /** A minimized window shown again may bring its app forward (macOS): the focus goes back to the user then. */
  private restored<T>(w: WindowInfo, fn: () => Promise<T>): Promise<T> {
    return w.minimized ? this.backgroundNow(w, fn) : fn()
  }

  private allowedWindows(): WindowInfo[] {
    return listWindows().filter((w) => this.inScope(w))
  }

  /** The window to act on: the one asked for, else the last one it looked at or acted on, else the scope's. */
  private pick(id?: number): WindowInfo {
    if (id !== undefined && id !== null) {
      const w = windowInfo(Number(id))
      if (!w) throw new Error(`No window ${id}: call windows.`)
      if (!this.inScope(w)) throw new Error(`Window ${id} (${w.exe}) is outside your scope.`)
      this.current = w.id
      return w
    }
    const last = this.current !== null ? windowInfo(this.current) : null
    if (last && this.inScope(last)) return last
    const scope = this.host.scope()
    const front = foregroundWindow()
    const w = scope.kind === 'app' ? this.allowedWindows()[0] : front && this.inScope(front) ? front : null
    if (!w) throw new Error('Say which window: call windows, then pass its id.')
    this.current = w.id
    return w
  }

  /** Its window to the front, with the keyboard (only while Speak has borrowed the mouse and keyboard). */
  private async front(w: WindowInfo): Promise<WindowInfo> {
    const now = windowInfo(w.id)
    if (!now) throw new Error(`"${windowName(w)}" is closed.`)
    if (!now.focused || now.minimized) {
      const from = foregroundWindow()
      await focusWindow(w.id)
      const fg = foregroundWindow()
      const ok = !!fg && fg.id === w.id
      log.info(`Control: ${ok ? 'brought' : 'could not bring'} ${now.exe || 'a window'} to the front (from ${from?.exe || 'no window'})`)
      if (!ok) throw new Error(`Could not bring "${windowName(w)}" to the front.`)
    }
    return windowInfo(w.id) ?? now
  }

  // ---------------------------------------------------------------- sharing the screen with the user

  /**
   * Run something that needs the real mouse or keyboard: once the user's hands are still, with the
   * window in front; then the pointer goes back where it was and, if the user was working, the
   * focus goes back to their window. Their hands on the mouse or the keyboard stop it there.
   */
  private borrow<T>(what: string, w: WindowInfo, fn: (stop: () => boolean, win: WindowInfo) => Promise<T>, needs: BorrowNeeds = {}): Promise<Borrowed<T>> {
    return this.serial(() => this.borrowNow(what, w, fn, needs))
  }

  private async borrowNow<T>(what: string, w: WindowInfo, fn: (stop: () => boolean, win: WindowInfo) => Promise<T>, needs: BorrowNeeds): Promise<Borrowed<T>> {
    if (!(await this.host.handsFree(what))) throw new Held()
    const saved = { fg: foregroundWindow(), cursor: cursorPos(), busy: Date.now() - this.host.lastInput() < BUSY_MS }
    const since = Date.now()
    let stopped: Stopped | undefined
    let target: number | null = null
    /**
     * Asked before each burst of input, and between steps: once it says stop, it stays so. The
     * user's hands (what the hook saw, and what the system says is held down right now, ahead of
     * the hook), then pause and stop, then the keyboard still on the window it acts on.
     */
    const stop = (): boolean => {
      if (stopped) return true
      if (this.host.lastInput() > since || pressing(!needs.holdsButton)) stopped = 'hands'
      else if (!this.host.running()) stopped = 'halted'
      else if (needs.keyboard && target !== null && !hasKeyboard(target)) stopped = 'focus'
      return !!stopped
    }
    try {
      if (stop()) return { stopped }
      const win = await this.front(w)
      target = win.id
      this.host.acting(win)
      const result = await fn(stop, win)
      return { result, stopped }
    } finally {
      this.host.acting(null)
      // Taken back by the user: theirs now, pointer and focus where they put them.
      if (stopped === 'hands') this.host.tookOver()
      else await this.giveBack(saved, w)
    }
  }

  /**
   * After Speak acted (or an app took the focus when acted on): the pointer back where it was, and
   * the focus back to the user's window when they were working in it, or when it's on another
   * screen (it then doesn't hide the app Speak works in).
   */
  private async giveBack(saved: { fg: WindowInfo | null; cursor: { x: number; y: number }; busy: boolean }, w: WindowInfo): Promise<void> {
    const now = cursorPos()
    if (now.x !== saved.cursor.x || now.y !== saved.cursor.y) await moveMouse(saved.cursor.x, saved.cursor.y)
    const fg = saved.fg
    if (!fg || fg.id === w.id || fg.pid === process.pid || !windowInfo(fg.id)) return
    const elsewhere = !displayRects().some((d) => inRect(center(fg.rect), d) && inRect(center(w.rect), d))
    if (saved.busy || elsewhere) {
      log.info(`Control: focus back to ${fg.exe || "the user's window"}`)
      await focusWindow(fg.id)
    }
  }

  /** A background action: some apps take the focus when acted on; it goes back to the user. */
  private background<T>(w: WindowInfo, fn: () => Promise<T>): Promise<T> {
    return this.serial(() => this.backgroundNow(w, fn))
  }

  private async backgroundNow<T>(w: WindowInfo, fn: () => Promise<T>): Promise<T> {
    const saved = { fg: foregroundWindow(), cursor: cursorPos(), busy: Date.now() - this.host.lastInput() < BUSY_MS }
    const result = await fn()
    const fg = foregroundWindow()
    if (saved.fg && fg && fg.id !== saved.fg.id && saved.fg.id !== w.id) await this.giveBack(saved, w)
    return result
  }

  // ---------------------------------------------------------------- what it acts on, shown with the approval

  /** The element or point it will act on, boxed, on its latest look of the window (for the approval). */
  private spot(w: WindowInfo, area: Rect): { image?: string; area?: Rect; areaWindow?: number } {
    // Boxed on the screen too, while it asks, when that spot is in sight (not behind another window).
    const c = center(area)
    const shown = windowAt(Math.round(c.x), Math.round(c.y))?.id === w.id ? { area, areaWindow: w.id } : {}
    const shot = this.shots.get(String(w.id))
    if (!shot || !inRect(c, shot.area)) return shown
    const s = shot.scale
    const box = { x: (area.x - shot.area.x) / s, y: (area.y - shot.area.y) / s, w: area.w / s, h: area.h / s }
    const size = shot.image.getSize()
    const pad = 90
    const crop = {
      x: Math.max(0, Math.round(box.x - pad * 1.6)),
      y: Math.max(0, Math.round(box.y - pad)),
      width: 0,
      height: 0
    }
    crop.width = Math.min(size.width - crop.x, Math.round(box.w + pad * 3.2))
    crop.height = Math.min(size.height - crop.y, Math.round(box.h + pad * 2))
    if (crop.width < 8 || crop.height < 8) return shown
    let image = markBox(shot.image.crop(crop), { x: box.x - crop.x - 3, y: box.y - crop.y - 3, w: box.w + 6, h: box.h + 6 }, [224, 175, 104])
    if (image.getSize().width > 440) image = image.resize({ width: 440, quality: 'good' })
    return { image: `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`, ...shown }
  }

  // ---------------------------------------------------------------- screen

  private async look(id: number | undefined, whole: boolean): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    let shot: Shot | null
    let label: string
    let key: string
    let forward = false
    if (whole) {
      const front = foregroundWindow()
      const area = (front && displayRects().find((d) => inRect(center(front.rect), d))) || desktopRect()
      shot = await shoot(area)
      key = 'screen'
      label = 'the screen'
    } else {
      const w = this.pick(id)
      key = String(w.id)
      label = windowName(w)
      shot = await this.restored(w, () => captureWindow(w.id))
      // An app that doesn't draw for a background picture: it comes forward a moment to be seen.
      if (!shot) {
        forward = true
        const r = await this.borrow(`look at ${label}`, w, async (_stop, win) => {
          await delay(150)
          return shoot(win.rect)
        })
        shot = r.result ?? null
        if (!shot) throw new Error(`Could not see "${label}".`)
      }
    }
    this.shots.set(key, shot)
    const size = shot.image.getSize()
    this.host.looked(`looked at ${label}${forward ? ' (brought forward a moment)' : ''}`, thumb(shot))
    return [
      { type: 'text', text: `${whole ? 'the screen' : `window ${key} · "${label}"`} · ${size.width}×${size.height} px (x, y for click are in these pixels)` },
      { type: 'image', data: shot.image.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' }
    ]
  }

  private async listElements(id: number | undefined, filter?: string): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const w = this.pick(id)
    await this.restored(w, () => unminimize(w.id))
    const all = await a11y.elements(w, 300)
    this.elements.set(w.id, all)
    const shot = this.shots.get(String(w.id))
    const f = filter?.toLowerCase()
    const lines = all
      .map((e, i) => ({ e, id: `e${i + 1}` }))
      .filter(({ e }) => !f || e.name.toLowerCase().includes(f) || e.value?.toLowerCase().includes(f))
      .map(({ e, id }) => {
        const at = shot ? `at ${Math.round((e.x + e.w / 2 - shot.area.x) / shot.scale)},${Math.round((e.y + e.h / 2 - shot.area.y) / shot.scale)}` : ''
        const flags = [e.disabled && 'disabled', e.focused && 'focused', e.password && 'password'].filter(Boolean).join(' ')
        const value = e.value && !e.password ? ` = "${e.value.replace(/\s+/g, ' ').slice(0, 160)}"` : ''
        return `${id} ${e.type} "${e.name}"${value}${flags ? ` (${flags})` : ''} ${at}`.trim()
      })
    this.host.looked(`read the controls of ${windowName(w)}`)
    if (!all.length) return text(`"${windowName(w)}" exposes no controls: use look, and click at x, y.`)
    return text(`Window ${w.id} · "${w.title}" · ${lines.length} controls${shot ? ' (at: pixels of your latest look)' : ''}:\n${lines.join('\n')}`)
  }

  private element(w: WindowInfo, id: string): { index: number; e: Element } {
    const index = Number(String(id).replace(/^e/i, ''))
    const e = this.elements.get(w.id)?.[index - 1]
    if (!e) throw new Error(`No element ${id} for "${windowName(w)}": call elements for that window.`)
    return { index, e }
  }

  /** A screen point for x, y in the pixels of the latest look at a window. */
  private pointOf(w: WindowInfo, x: unknown, y: unknown): { x: number; y: number } {
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('Give an element id, or x and y.')
    const shot = this.shots.get(String(w.id))
    if (!shot) throw new Error(`Look at "${windowName(w)}" first, to click in its pixels.`)
    return { x: shot.area.x + x * shot.scale, y: shot.area.y + y * shot.scale }
  }

  /** Once its window is in front, the point must land on it (or on another window in the scope, such as its dialog). */
  private landsOn(win: WindowInfo, p: { x: number; y: number }): void {
    const under = windowAt(Math.round(p.x), Math.round(p.y))
    if (under && this.inScope(under)) return
    const what = under?.pid === process.pid ? "Speak's panel" : `${under?.exe || 'something'}, outside your scope`
    throw new Error(`That point of "${windowName(win)}" is covered by ${what}: look again.`)
  }

  private async click(a: Record<string, any>): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const w = this.pick(a.window)
    const el = a.element ? this.element(w, a.element) : null
    const p = el ? center(el.e) : this.pointOf(w, a.x, a.y)
    const name = el ? `${el.e.type} "${el.e.name}"` : undefined
    const area = el ? { x: el.e.x, y: el.e.y, w: el.e.w, h: el.e.h } : { x: p.x - 14, y: p.y - 14, w: 28, h: 28 }
    const category = categoryOf(a.intent, name)
    const how = a.double ? 'double-click' : a.button === 'right' ? 'right-click' : 'click'
    const g = await this.host.gate({
      title: a.intent || `${how} ${name ?? 'a point'}`,
      detail: `${how} ${name ?? ''} in ${windowName(w)}`.replace(/\s+/g, ' '),
      risk: a.risky || category ? 'risky' : 'change',
      category,
      key: `click:${w.exe}`,
      ...this.spot(w, area)
    })
    if (!g.ok) return text(g.reason)
    try {
      // An element with a default action: pressed in the background.
      if (el && !a.double && (!a.button || a.button === 'left')) {
        const done = await this.background(w, () => a11y.press(w, el.index)).catch(refused)
        if (done) {
          await delay(250)
          this.host.finish(g.step, { ok: true, detail: `${name} pressed in the background` })
          return text(`Pressed ${name}${done === 'toggle' ? ' (toggled)' : done === 'expand' ? ' (expanded or collapsed)' : ''}.`)
        }
      }
      const r = await this.borrow(a.intent || 'click', w, async (stop, win) => {
        this.landsOn(win, p)
        if (stop()) return
        await click(p.x, p.y, a.button ?? 'left', a.double ? 2 : 1, stop)
        await delay(250)
      })
      return this.ended(g.step, r, `Clicked${name ? ` ${name}` : ''}.`)
    } catch (err) {
      return this.failed(g.step, err)
    }
  }

  private async fill(a: Record<string, any>): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const w = this.pick(a.window)
    const el = this.element(w, a.element)
    const value = String(a.text ?? '')
    const secret = !!el.e.password
    const category = secret ? 'secrets' : categoryOf(a.intent)
    const g = await this.host.gate({
      title: a.intent || `fill ${el.e.name || el.e.type}`,
      detail: secret
        ? `${value.length} characters into a password field`
        : `${el.e.name || el.e.type}: ${value.length > 300 ? `${value.slice(0, 300)}…` : value}`,
      risk: a.risky || category ? 'risky' : 'change',
      category,
      key: `fill:${w.exe}`,
      secret,
      ...this.spot(w, el.e)
    })
    if (!g.ok) return text(g.reason)
    try {
      const done = await this.background(w, () => a11y.fill(w, el.index, value)).catch(refused)
      if (done) {
        this.host.finish(g.step, { ok: true, detail: `${secret ? 'password field' : el.e.name || el.e.type} filled in the background` })
        return text(`Filled ${el.e.type} "${el.e.name}".`)
      }
      // The field takes no value from outside: click it, select what's there, type.
      let check = null as Check
      const r = await this.borrow(
        a.intent || 'fill a field',
        w,
        async (stop, win) => {
          const p = center(el.e)
          this.landsOn(win, p)
          if (!(await click(p.x, p.y, 'left', 1, stop))) return 0
          await delay(120)
          if (stop()) return 0
          pressKeys(`${shortcutMod()}+a`)
          const sent = await insertText(value, stop, secret)
          check = await this.typedCheck(win, value, sent, secret)
          return sent
        },
        { keyboard: true }
      )
      return this.ended(g.step, r, `Filled ${el.e.type} "${el.e.name}".`, secret ? undefined : value, check)
    } catch (err) {
      return this.failed(g.step, err)
    }
  }

  private async type(a: Record<string, any>): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const w = this.pick(a.window)
    const el = a.element ? this.element(w, a.element) : null
    const value = String(a.text ?? '')
    // The field with the keyboard counts only when it's in that app: another app's says nothing about it.
    const focused = el ? null : await a11y.focused().catch(() => null)
    const secret = el ? !!el.e.password : (focused?.pid === w.pid && focused.password) || this.passwordIn === w.id
    if (this.passwordIn === w.id) this.passwordIn = null
    const category = secret ? 'secrets' : categoryOf(a.intent)
    const g = await this.host.gate({
      title: a.intent || `type in ${windowName(w)}`,
      detail: secret ? `${value.length} characters into a password field` : value.length > 400 ? `${value.slice(0, 400)}…` : value,
      risk: a.risky || category ? 'risky' : 'change',
      category,
      key: `type:${w.exe}`,
      secret,
      ...(el ? this.spot(w, el.e) : {})
    })
    if (!g.ok) return text(g.reason)
    try {
      let check = null as Check
      let password = false as boolean
      const r = await this.borrow(
        a.intent || 'type',
        w,
        async (stop, win) => {
          if (el) {
            // Into that element: focused through the accessibility API, else clicked.
            if (!(await a11y.focus(w, el.index))) {
              const p = center(el.e)
              this.landsOn(win, p)
              if (!(await click(p.x, p.y, 'left', 1, stop))) return 0
            }
            await delay(120)
          } else if (!secret) {
            // The window in front now, the field with the keyboard is its own: a password field after all
            // isn't typed into as plain text (it would be pasted when long, and kept in the history).
            const now = await a11y.focused().catch(() => null)
            if (now?.password && now.pid === win.pid) {
              password = true
              return 0
            }
          }
          const sent = await insertText(value, stop, secret)
          check = await this.typedCheck(win, value, sent, secret)
          return sent
        },
        { keyboard: true }
      )
      if (password) {
        this.passwordIn = w.id
        // Its text off the step (and the history): it was meant for a password field.
        this.host.finish(g.step, { ok: false, detail: `${value.length} characters`, error: 'not typed: the cursor is in a password field' })
        return text('Not typed: the cursor is in a password field. Call type again to type it there as a password (the user may be asked first).')
      }
      return this.ended(g.step, r, 'Typed.', secret ? undefined : value, check)
    } catch (err) {
      return this.failed(g.step, err)
    }
  }

  private async key(a: Record<string, any>): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const w = this.pick(a.window)
    const keys = String(a.keys ?? '')
    const category = categoryOf(a.intent)
    const g = await this.host.gate({
      title: a.intent || `press ${keys}`,
      detail: `${keys} in ${windowName(w)}`,
      risk: a.risky || category ? 'risky' : 'change',
      category,
      key: `key:${w.exe}`
    })
    if (!g.ok) return text(g.reason)
    try {
      const r = await this.borrow(
        a.intent || `press ${keys}`,
        w,
        async (stop) => {
          if (stop()) return
          pressKeys(keys)
          await delay(200)
        },
        { keyboard: true }
      )
      return this.ended(g.step, r, `Pressed ${keys}.`)
    } catch (err) {
      return this.failed(g.step, err)
    }
  }

  private async scroll(a: Record<string, any>): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const w = this.pick(a.window)
    const dy = Number(a.dy) || 0
    const el = a.element ? this.element(w, a.element) : null
    // In the background: the element's list or page, else the window's first.
    if (typeof a.x !== 'number') {
      const done = await this.background(w, () => a11y.scroll(w, el?.index, dy)).catch(refused)
      if (done) {
        this.host.looked(`scrolled ${windowName(w)}`)
        return text('Scrolled.')
      }
    }
    const p = el ? center(el.e) : typeof a.x === 'number' ? this.pointOf(w, a.x, a.y) : center(w.rect)
    const r = await this.borrow(`scroll ${windowName(w)}`, w, async (stop, win) => {
      this.landsOn(win, p)
      if (stop()) return
      await scroll(p.x, p.y, dy)
      await delay(150)
    })
    if (r.stopped) return this.notDone(r.stopped, 'Not scrolled')
    this.host.looked(`scrolled ${windowName(w)}`)
    return text('Scrolled.')
  }

  private async drag(a: Record<string, any>): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const w = this.pick(a.window)
    const from = this.pointOf(w, a.from_x, a.from_y)
    const to = this.pointOf(w, a.to_x, a.to_y)
    const category = categoryOf(a.intent)
    const g = await this.host.gate({
      title: a.intent || 'drag',
      detail: `in ${windowName(w)}`,
      risk: a.risky || category ? 'risky' : 'change',
      category,
      key: `drag:${w.exe}`,
      ...this.spot(w, { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x) + 2, h: Math.abs(to.y - from.y) + 2 })
    })
    if (!g.ok) return text(g.reason)
    try {
      const r = await this.borrow(
        a.intent || 'drag',
        w,
        async (stop, win) => {
          this.landsOn(win, from)
          this.landsOn(win, to)
          await drag(from, to, stop)
        },
        { holdsButton: true }
      )
      return this.ended(g.step, r, 'Dragged.')
    } catch (err) {
      return this.failed(g.step, err)
    }
  }

  private async requestApp(id: number | undefined, why: string): Promise<Content[]> {
    if (id === undefined || id === null) {
      await refreshWindows()
      const others = listWindows().filter((w) => !this.inScope(w) && w.pid !== process.pid)
      return text(
        others.length ? `Open windows outside your scope:\n${others.map((w) => `${w.id} · ${w.exe} · "${w.title}"`).join('\n')}` : 'No other window is open.'
      )
    }
    const w = windowInfo(Number(id))
    if (!w || w.pid === process.pid) throw new Error(`No window ${id}.`)
    const ok = await this.host.widen(w, why)
    return text(ok ? `The user let you act on ${w.exe} too.` : `The user did not let you act on ${w.exe}.`)
  }

  private async open(a: Record<string, any>): Promise<Content[]> {
    if (!(await this.host.hold())) throw new Held()
    const target = String(a.target ?? '').trim()
    if (!target) throw new Error('Nothing to open.')
    const g = await this.host.gate({ title: a.intent || `open ${target}`, detail: target, risk: 'change', key: 'open' })
    if (!g.ok) return text(g.reason)
    try {
      // A new window takes the focus: not while the user types.
      if (!(await this.host.handsFree(`open ${target}`))) throw new Held()
      const saved = { fg: foregroundWindow(), cursor: cursorPos(), busy: Date.now() - this.host.lastInput() < BUSY_MS }
      const before = new Set(listWindows().map((w) => w.id))
      // On macOS, it opens without taking the focus while the user works.
      if (/^https?:\/\//i.test(target)) await shell.openExternal(target, { activate: !saved.busy })
      else if (isAbsolute(target) || /^~[\/]/.test(target)) {
        const error = await shell.openPath(target.startsWith('~') ? resolve(homedir(), target.slice(2)) : target)
        if (error) throw new Error(error)
      } else await openApp(target, saved.busy)
      let opened: WindowInfo | undefined
      for (let i = 0; i < 20 && !opened; i++) {
        await delay(250)
        opened = listWindows().find((w) => !before.has(w.id) && this.inScope(w))
      }
      if (opened) {
        this.current = opened.id
        await this.giveBack(saved, opened)
      }
      this.host.finish(g.step, { ok: true })
      return text(opened ? `Opened: window ${opened.id} · "${opened.title}". Look at it or list its elements.` : `Opened ${target}: call windows to find it.`)
    } catch (err) {
      return this.failed(g.step, err)
    }
  }

  // ---------------------------------------------------------------- endings

  /**
   * What Speak typed, read back from its field while the window is still in front: an app may take
   * a key for one of its shortcuts (after a lone Alt, Notepad's "b" is Bold), and the AI would say
   * it typed what isn't there. Never a password's; logged as a count only. Null: it can't be read.
   */
  private async typedCheck(win: WindowInfo, typed: string, sent: number, secret: boolean): Promise<Check> {
    let check: Check = null
    if (!secret && sent === typed.length) {
      // Line breaks, tabs and an app's curly quotes aren't a difference.
      // Nor are the dashes and ellipses macOS's smart punctuation makes of what's typed.
      const flat = (s: string) =>
        s
          .replace(/\s+/g, ' ')
          .replace(/[‘’]/g, "'")
          .replace(/[“”]/g, '"')
          .replace(/[–—]|--/g, '-')
          .replace(/…/g, '...')
      const want = flat(typed).slice(-200)
      if (want.trim()) {
        await delay(150) // the last keys reach the app
        const r = await a11y.beforeCursor(want.length + 200).catch(() => null)
        const got = r && r.pid === win.pid && !r.password ? (r.text ?? r.value) : undefined
        if (got !== undefined) {
          const ok = r?.text !== undefined ? flat(got).endsWith(want) : flat(got).includes(want)
          check = ok ? { ok: true } : { ok: false, shows: flat(got).slice(-(want.length + 20)) }
        }
      }
    }
    log.info(`Control: typed ${sent} of ${typed.length} characters${check ? (check.ok ? ', read back' : ', but the field shows something else') : ''}`)
    return check
  }

  /** A real-input action's end: done (and what it typed there, when read back), or stopped on the way (how far it got, for text). */
  private ended(step: string, r: Borrowed<unknown>, done: string, typed?: string, check: Check = null): Content[] {
    if (!r.stopped) {
      if (check && !check.ok) {
        this.host.finish(step, { ok: false, error: `the field shows "…${check.shows.slice(-60)}"` })
        return text(
          `${done.replace(/\.$/, '')}, but the text before the cursor is now "${check.shows}": not what was sent (the app may have taken a key for one of its shortcuts). Look at the window and fix it before going on: don't send it all again blindly.`
        )
      }
      this.host.finish(step, { ok: true })
      return text(done)
    }
    const count = typeof r.result === 'number' ? r.result : 0
    const where =
      typed === undefined
        ? ''
        : count === 0
          ? ', before any of the text'
          : ` after ${count} of ${typed.length} characters (it ends with "${typed.slice(0, count).slice(-40)}")`
    this.host.finish(step, { ok: false, error: `${STOPPED_LABEL[r.stopped]}: stopped${where}` })
    return this.notDone(r.stopped, `Stopped${where}`)
  }

  /** What the AI is told when its action stopped on the way. */
  private notDone(why: Stopped, what: string): Content[] {
    if (why === 'hands')
      return text(
        `${what}: the user took the mouse or the keyboard. Speak won't use them again until the user says to continue: your next action that needs them waits for that. Then look at the window before going on (it may have changed).`
      )
    if (why === 'focus') return text(`${what}: another window took the keyboard, and Speak never types into it. Look again before going on.`)
    return text(`${what}: the user paused or stopped you.`)
  }

  private failed(step: string, err: unknown): Content[] {
    if (err instanceof Held) {
      this.host.finish(step, { ok: false, error: 'stopped' })
      throw err
    }
    this.host.finish(step, { ok: false, error: (err as Error).message })
    throw err
  }
}

/** A small copy of a screenshot, for the panel's [see]. */
function thumb(shot: Shot): string {
  const small = shot.image.getSize().width > 480 ? shot.image.resize({ width: 480, quality: 'good' }) : shot.image
  return `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}`
}
