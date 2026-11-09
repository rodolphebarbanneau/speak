import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { CONTROL_APPROVALS, CONTROL_SCOPES, languageName } from '../../shared/constants'
import type { ControlAlwaysAsk, ControlAsk, ControlApproval, ControlScope, ControlState, ControlStep, Session } from '../../shared/types'
import { configStore } from '../config'
import { history, newSessionId } from '../history'
import { log } from '../log'
import { dipToScreen } from '../platform/coords'
import {
  broadcast,
  controlPanel,
  controlPanelRect,
  hideControlPanel,
  hideFrame,
  overlay,
  setControlCollapsed,
  setControlKeyboard,
  setOverlayCaptureExcluded,
  showControlPanel,
  showFrame
} from '../windows'
import { modelFor } from '../ai'
import { ClaudeAgent, CodexAgent, type ControlAgent, type NativeAction } from './agents'
import { backupBeforeWrite, describeOp, undoOp, type FileOp } from './files'
import { controlPrompt, replyIn } from './prompt'
import {
  a11y,
  foregroundWindow,
  listWindows,
  onUsersInput,
  screenReady,
  screenUnsupported,
  setOwnAreas,
  stackAbove,
  warmScreen,
  type Rect,
  type WindowInfo
} from './screen'
import { categoryOf, ToolServer, type ActionRequest, type Gate, type StepResult, type ToolHost } from './tools'

/**
 * Control mode: a session with the user's AI that acts on the computer, within a scope (
 * an app, the screen, everything), asking first as the approval level says. The panel shows the
 * conversation and what it does, asks for approvals, and lets the user pause, stop, restart or end
 * it; the user keeps talking to it with the shortcut. Dictation and compose never change anything:
 * only this mode does, and only while a session runs.
 */

type Decision = 'yes' | 'always' | 'no'

interface Framed {
  rect: Rect
  window: number
}
interface Answer {
  decision: Decision
  /** What the user said instead (a correction, or the answer to a question). */
  message?: string
}

const MAX_STEPS = 400
/** Screenshots kept in the panel's latest steps only. */
const KEEP_IMAGES = 12

const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.!?,;:…"«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const YES =
  /^(yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|approve|approved|fine|oui|ouais|ok d'accord|d'accord|vas-y|vas y|valide|c'est bon|allez)( please| merci| s'il te plait)?$/
const ALWAYS = /^(always|yes always|always allow|toujours|oui toujours)$/
const NO = /^(no|nope|non|don't|do not|refuse|cancel|annule|pas ca|surtout pas)$/
const STOP = /^(stop|arrete|arrete-toi|stop everything|halt)$/
const PAUSE = /^(wait|pause|hold on|attends|attend|une seconde)$/
const RESUME = /^(go on|continue|resume|carry on|vas-y continue|reprends|continue s'il te plait)$/
const END = /^(that's all|thats all|that is all|end|end control|end session|we're done|done|c'est tout|termine|fin|fin du controle|arrete le controle)$/

class Control extends EventEmitter implements ToolHost {
  state: ControlState = this.blank()
  private agent: ControlAgent | null = null
  private tools: ToolServer | null = null
  private scopeInfo: ReturnType<ToolHost['scope']> = { kind: 'app', apps: [], label: '' }
  private asks: Array<{ ask: ControlAsk; resolve: (a: Answer) => void }> = []
  private paused = false
  private resumeWaiters: Array<() => void> = []
  /** The user stopped it: what it tries until their next message is refused. */
  private stopped = false
  private planApproved = false
  private always = new Set<string>()
  private ops = new Map<string, FileOp>()
  /** Built-in actions of the CLI → their step. */
  private native = new Map<string, string>()
  private busy = false
  private orders: string[] = []
  private idleTimer: NodeJS.Timeout | null = null
  /** Where Speak has the mouse and the keyboard now (the frame), and where an action waiting for approval would act. */
  /** Where it acts, or what it asks about: framed on the screen, in that window. */
  private actingArea: Framed | null = null
  private askArea: Framed | null = null
  /** When the user last touched the mouse or the keyboard (0: they handed over, by approving or saying go). */
  private lastUserInput = 0
  private goAhead = false
  /** The user took the mouse or the keyboard during an action: Speak doesn't take them again until they say to. */
  private handsTaken = false
  private unhook: (() => void) | null = null
  /** The window in front when the shortcut was pressed (the app scope's app). */
  private pendingTarget: WindowInfo | null = null

  private blank(): ControlState {
    const cfg = configStore.get().control
    return {
      active: false,
      id: '',
      status: 'ended',
      scope: cfg.scope,
      scopeLabel: '',
      approval: cfg.approval,
      agent: '',
      startedAt: 0,
      steps: [],
      listening: false,
      collapsed: false
    }
  }

  get session(): string {
    return this.state.id
  }

  get active(): boolean {
    return this.state.active
  }

  scope(): ReturnType<ToolHost['scope']> {
    return this.scopeInfo
  }

  // ---------------------------------------------------------------- lifecycle

  /** The shortcut was pressed for a new session: note the app in front (before anything of Speak's shows). */
  noteTarget(): void {
    const supported = !screenUnsupported()
    try {
      this.pendingTarget = supported ? foregroundWindow() : null
    } catch {
      this.pendingTarget = null
    }
    if (supported) warmScreen()
  }

  /** The app of the window whose title contains `title`, instead of the one in front (`--app=` on the command line). */
  noteTargetByTitle(title: string): boolean {
    if (screenUnsupported()) return false
    const t = title.toLowerCase()
    const found = listWindows().find((w) => w.title.toLowerCase().includes(t))
    if (found) this.pendingTarget = found
    warmScreen()
    return !!found
  }

  /** Start a session with its first order. */
  async start(order: string): Promise<void> {
    if (this.state.active) return this.receive(order)
    const cfg = configStore.get()
    const id = newSessionId()
    this.state = { ...this.blank(), active: true, id, status: 'starting', startedAt: Date.now() }
    this.reset()
    this.addStep({ who: 'you', text: order })
    this.orders = [order]
    showControlPanel(this.pendingTarget?.rect)
    setOverlayCaptureExcluded(true)
    this.hook()
    // What the system must allow first (macOS asks the user now): without it, not even the app in
    // front can be found (macOS hides other apps' window titles without Screen Recording).
    const blocked = screenReady(true)
    if (blocked) return this.fail(blocked)
    try {
      this.scopeInfo = this.resolveScope(this.state.scope)
    } catch (err) {
      return this.fail((err as Error).message)
    }
    this.state.scopeLabel = this.scopeInfo.label
    this.push()
    await this.launch(order, cfg.ai.provider)
  }

  /** The AI is gone (it failed, or never started): start it again for this order, the scope checked again. */
  private async relaunch(order: string): Promise<void> {
    // The user may have allowed what was missing meanwhile; the app in front is the one now.
    const blocked = screenReady(true)
    if (blocked) return this.fail(blocked)
    if (this.state.scope === 'app' && !this.pendingTarget) this.noteTarget()
    try {
      this.scopeInfo = this.resolveScope(this.state.scope)
    } catch (err) {
      return this.fail((err as Error).message)
    }
    this.state.scopeLabel = this.scopeInfo.label
    await this.launch(order, configStore.get().ai.provider)
  }

  private reset(): void {
    // A session that didn't start yet (a permission missing) acts on nothing of the last one's.
    this.scopeInfo = { kind: this.state.scope, apps: [], label: '' }
    this.asks = []
    this.paused = false
    this.stopped = false
    this.planApproved = false
    this.always.clear()
    this.ops.clear()
    this.native.clear()
    this.busy = false
    this.actingArea = null
    this.askArea = null
    this.lastUserInput = 0
    this.goAhead = false
    this.handsTaken = false
  }

  private async launch(order: string, provider: string): Promise<void> {
    const cfg = configStore.get()
    if (provider !== 'claude-code' && provider !== 'codex')
      return this.fail('Control needs an AI provider: pick Claude Code or Codex in Speak → settings → ai.')
    const agentCfg = provider === 'codex' ? cfg.ai.codex : cfg.ai.claudeCode
    const model = await modelFor(provider, 'control')
    this.tools = new ToolServer(this)
    await this.tools.start()
    const scope = this.scopeInfo
    const system = controlPrompt({
      scope: scope.kind,
      scopeLabel: scope.label,
      approval: this.state.approval,
      replyLanguage: cfg.control.language
    })
    const options = {
      scope: scope.kind,
      cwd: homedir(),
      system,
      model,
      effort: agentCfg.effort,
      mcp: { url: this.tools.url, token: this.tools.token },
      cfg: agentCfg
    }
    const events = {
      text: (text: string) => this.aiSays(text),
      busy: (busy: boolean) => this.setBusy(busy),
      approve: (a: NativeAction) => this.approveNative(a),
      ran: (a: NativeAction) => this.nativeRan(a),
      done: (nid: string, ok: boolean, output?: string) => this.nativeDone(nid, ok, output),
      failed: (error: string) => this.agentFailed(error)
    }
    const agent: ControlAgent = provider === 'codex' ? new CodexAgent(options, events) : new ClaudeAgent(options, events)
    this.agent = agent
    this.state.agent = agent.label
    this.state.error = undefined
    this.push()
    log.info(`Control session ${this.state.id}: ${scope.kind} (${scope.label}), ${this.state.approval}, ${agent.label}`)
    try {
      await agent.start(order)
    } catch (err) {
      this.fail((err as Error).message)
    }
  }

  private resolveScope(kind: ControlScope): ReturnType<ToolHost['scope']> {
    const unsupported = screenUnsupported()
    if (unsupported) throw new Error(unsupported)
    if (kind === 'app') {
      const t = this.pendingTarget
      if (!t || t.pid === process.pid) throw new Error('Put the app to control in front, then press the control shortcut: it acts on that app.')
      return { kind, apps: [{ pid: t.pid, exe: t.exe, title: t.title }], label: appName(t) }
    }
    if (kind === 'screen') return { kind, apps: [], label: 'screen' }
    return { kind, apps: [], label: 'everything' }
  }

  /** End the session: the AI stops, the panel goes, the history keeps what happened. */
  async end(reason?: string): Promise<void> {
    if (!this.state.active) return
    if (reason) this.addStep({ who: 'info', text: reason })
    const asks = this.asks.splice(0)
    for (const a of asks) a.resolve({ decision: 'no', message: 'The session ended.' })
    this.wake()
    this.agent?.close()
    this.agent = null
    this.tools?.stop()
    this.tools = null
    a11y.stop()
    this.unhook?.()
    this.unhook = null
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    setOverlayCaptureExcluded(false)
    setControlKeyboard(false)
    hideControlPanel()
    const ended = this.state
    this.state = { ...ended, active: false, status: 'ended', ask: undefined, listening: false }
    this.push()
    log.info(`Control session ${ended.id} ended`)
    await this.save(ended).catch((err) => log.warn('Could not save the control session:', err))
  }

  private async save(s: ControlState): Promise<void> {
    if (!s.steps.some((step) => step.who === 'you')) return
    const cfg = configStore.get()
    const first = s.steps.find((step) => step.who === 'you')!.text
    const now = new Date().toISOString()
    const session: Session = {
      id: s.id,
      createdAt: new Date(s.startedAt).toISOString(),
      updatedAt: now,
      durationMs: Date.now() - s.startedAt,
      hasAudio: false,
      transcription: { engine: cfg.speech.engine, model: '', language: cfg.speech.language, ms: 0, text: first },
      style: cfg.writing.format,
      outputLanguage: 'same',
      versions: [],
      text: first,
      control: {
        scope: s.scope,
        scopeLabel: s.scopeLabel,
        approval: s.approval,
        agent: s.agent,
        // Screenshots stay out of the history.
        steps: s.steps.map(({ image: _image, ...step }) => step)
      }
    }
    await history.save(session)
  }

  private fail(error: string): void {
    this.state.error = error
    this.addStep({ who: 'error', text: error })
    this.setBusy(false)
  }

  // ---------------------------------------------------------------- talking

  /** What the user said (transcribed), or typed in the panel. */
  receive(text: string): void {
    const said = text.trim()
    if (!said || !this.state.active) return
    const n = norm(said)
    const ask = this.asks[0]
    if (this.state.hands && !ask && (YES.test(n) || RESUME.test(n))) {
      this.addStep({ who: 'you', text: said })
      return this.goNow()
    }
    if (ask) {
      this.addStep({ who: 'you', text: said })
      if (ask.ask.kind === 'question') return this.answer(ask.ask.id, 'yes', said)
      if (ALWAYS.test(n) && ask.ask.always) return this.answer(ask.ask.id, 'always')
      if (YES.test(n)) return this.answer(ask.ask.id, 'yes')
      if (NO.test(n)) return this.answer(ask.ask.id, 'no')
      // Anything else is what to do instead.
      return this.answer(ask.ask.id, 'no', said)
    }
    if (END.test(n)) {
      this.addStep({ who: 'you', text: said })
      void this.end()
      return
    }
    if (STOP.test(n)) {
      this.addStep({ who: 'you', text: said })
      return this.stop()
    }
    if (PAUSE.test(n) && this.busy) {
      this.addStep({ who: 'you', text: said })
      return this.pause()
    }
    if (RESUME.test(n) && this.paused) {
      this.addStep({ who: 'you', text: said })
      return this.resume()
    }
    this.addStep({ who: 'you', text: said })
    this.stopped = false
    // A new order: they let it act again (what needs their hands still waits for them to be still).
    this.handsTaken = false
    if (this.paused) this.resume(true)
    this.orders.push(said)
    if (!this.agent) return void this.relaunch(said)
    this.agent.send(said)
  }

  /** The panel's buttons, or the user's voice, on what it waits for. */
  answer(id: string, decision: Decision, message?: string): void {
    const i = this.asks.findIndex((a) => a.ask.id === id)
    if (i < 0) return
    const [a] = this.asks.splice(i, 1)
    // Approving hands over: what it was asked for doesn't then wait for the user's hands to be still.
    if (decision !== 'no') {
      this.lastUserInput = 0
      this.handsTaken = false
    }
    a.resolve({ decision, message })
    this.refresh()
  }

  private asking(ask: Omit<ControlAsk, 'id'>): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      const full = { ...ask, id: randomBytes(4).toString('hex') }
      this.asks.push({ ask: full, resolve })
      if (this.asks.length === 1) this.say(full.kind === 'question' ? full.title : `${full.title || 'Approve its plan'}?`)
      this.refresh()
    })
  }

  private aiSays(text: string): void {
    // Plain text in the panel (and aloud): no markdown marks.
    this.addStep({ who: 'ai', text: text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1') })
  }

  /** Read aloud in the panel, when asked to. */
  private say(text: string): void {
    if (configStore.get().control.readAloud) controlPanel?.webContents.send('speak:controlSay', text)
  }

  // ---------------------------------------------------------------- the gate

  /** Whether an action may run now: maybe after asking the user, and never while paused. */
  async gate(req: ActionRequest): Promise<Gate> {
    if (!this.state.active) return { ok: false, reason: 'The control session ended.' }
    await this.whilePaused()
    if (!this.state.active) return { ok: false, reason: 'The control session ended.' }
    if (this.stopped) return { ok: false, reason: 'The user stopped you. Wait for their next order: do nothing more.' }
    const cfg = configStore.get().control
    const level = this.state.approval
    const because = req.category && cfg.alwaysAsk[req.category] ? ALWAYS_ASK_LABEL[req.category] : undefined
    const always = alwaysOf(req, because ? req.category : undefined)
    let ask = false
    if (req.risk !== 'look') {
      if (always && this.always.has(always.key)) ask = false
      else if (because) ask = true
      else if (level === 'step') ask = true
      else if (level === 'plan') {
        if (!this.planApproved) return { ok: false, reason: 'Call propose_plan first: the user approves your plan before you act.' }
        ask = req.risk === 'risky'
      } else if (level === 'risky') ask = req.risk === 'risky'
    }
    if (ask) {
      this.askArea = req.area && req.areaWindow ? { rect: req.area, window: req.areaWindow } : null
      const answer = await this.asking({
        kind: 'action',
        title: req.title,
        detail: req.detail,
        risk: req.risk,
        because,
        always: always?.label,
        image: req.image
      })
      this.askArea = null
      if (!this.state.active) return { ok: false, reason: 'The control session ended.' }
      if (answer.decision === 'no') {
        this.addStep({ who: 'action', text: req.title, detail: req.detail, risk: req.risk, state: 'rejected' })
        return {
          ok: false,
          reason: answer.message
            ? `The user refused, and said: "${answer.message}"`
            : 'The user refused this action. Ask what they want instead, or try another way.'
        }
      }
      if (answer.decision === 'always' && always) {
        this.always.add(always.key)
        this.addStep({ who: 'info', text: `${always.label}: approved for this session` })
      }
      // Approved after a stop: they want it.
      this.stopped = false
    }
    const step = this.addStep({ who: 'action', text: req.title, detail: req.detail, risk: req.risk, state: 'running' })
    this.refresh()
    return { ok: true, step: step.id }
  }

  finish(id: string, r: StepResult): void {
    const step = this.state.steps.find((s) => s.id === id)
    if (!step) return
    step.state = r.ok ? 'done' : 'failed'
    if (r.detail) step.detail = r.detail
    if (r.error) step.detail = step.detail ? `${step.detail}\n${r.error}` : r.error
    if (r.op) {
      this.ops.set(step.id, r.op)
      step.undoable = true
      step.detail = describeOp(r.op)
    }
    if (r.image) step.image = r.image
    this.refresh()
  }

  async hold(): Promise<boolean> {
    await this.whilePaused()
    return this.state.active && !this.stopped
  }

  looked(text: string, image?: string): void {
    this.addStep({ who: 'action', text, risk: 'look', state: 'done', image })
  }

  async plan(steps: string[], summary?: string): Promise<{ approved: boolean; reason?: string }> {
    await this.whilePaused()
    const level = this.state.approval
    // Its one line, when it gave one: the panel's heading already says it's a plan.
    const title = summary?.trim() ?? ''
    // At "the plan" (and every step), the plan is asked; otherwise shown.
    if (level === 'risky' || level === 'never') {
      this.addStep({ who: 'ai', text: title || 'my plan', detail: steps.map((s, i) => `${i + 1}. ${s}`).join('\n') })
      this.planApproved = true
      return { approved: true }
    }
    const answer = await this.asking({ kind: 'plan', title, steps })
    if (answer.decision === 'no') return { approved: false, reason: answer.message }
    this.planApproved = true
    this.addStep({ who: 'info', text: 'plan approved', detail: steps.map((s, i) => `${i + 1}. ${s}`).join('\n') })
    return { approved: true }
  }

  async ask(question: string): Promise<string> {
    const answer = await this.asking({ kind: 'question', title: question })
    return answer.message ?? (answer.decision === 'no' ? '(no answer)' : 'yes')
  }

  async widen(app: WindowInfo, why: string): Promise<boolean> {
    const answer = await this.asking({ kind: 'scope', title: `act on ${appName(app)} too`, detail: why })
    if (answer.decision === 'no') return false
    this.scopeInfo.apps.push({ pid: app.pid, exe: app.exe, title: app.title })
    this.scopeInfo.label = this.scopeInfo.apps.map((a) => appName(a)).join(' + ')
    this.state.scopeLabel = this.scopeInfo.label
    this.push()
    return true
  }

  acting(win: WindowInfo | null): void {
    this.actingArea = win && { rect: win.rect, window: win.id }
    this.refresh()
  }

  lastInput(): number {
    return this.lastUserInput
  }

  running(): boolean {
    return this.state.active && !this.stopped && !this.paused
  }

  tookOver(): void {
    this.handsTaken = true
  }

  /**
   * Before borrowing the mouse and the keyboard: wait until the user's hands have been still for a
   * moment (settings → control), or they say go. After they took them back during an action, only
   * their word gives them to it again (a pause of theirs isn't a yes). Paused, it waits for resume too.
   */
  async handsFree(what: string): Promise<boolean> {
    const free = () => !this.handsTaken && Date.now() - this.lastUserInput >= configStore.get().control.handsSeconds * 1000
    if (!(await this.hold())) return false
    if (free()) return true
    this.state.hands = what
    this.state.tookOver = this.handsTaken || undefined
    this.refresh()
    while (this.state.active && !this.stopped && !this.goAhead && !free()) {
      await this.whilePaused()
      await new Promise((r) => setTimeout(r, 150))
      // A new order lets it go on (it then waits for still hands only).
      if (!!this.state.tookOver !== this.handsTaken) {
        this.state.tookOver = this.handsTaken || undefined
        this.refresh()
      }
    }
    this.goAhead = false
    this.state.hands = undefined
    this.state.tookOver = undefined
    this.refresh()
    return this.state.active && !this.stopped
  }

  /** The user lets it take the mouse and the keyboard now. */
  goNow(): void {
    if (!this.state.hands) return
    this.goAhead = true
    this.handsTaken = false
  }

  // ---------------------------------------------------------------- built-in actions

  /** The CLI asks to run one of its own tools: within the scope, and through the gate. */
  private async approveNative(a: NativeAction): Promise<{ ok: true } | { ok: false; reason: string }> {
    const scope = this.scopeInfo
    const input = a.input
    const path =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : typeof input.notebook_path === 'string'
            ? input.notebook_path
            : undefined
    const abs = path ? (isAbsolute(path) ? path : resolve(homedir(), path)) : undefined
    if ((scope.kind === 'app' || scope.kind === 'screen') && a.tool !== 'Read')
      return { ok: false, reason: 'No files or commands in this scope: use the screen tools.' }
    const req = nativeRequest(a, abs)
    const g = await this.gate(req)
    if (!g.ok) return g
    this.native.set(a.id, g.step)
    // A file about to be written: keep it, to undo.
    if ((a.tool === 'Write' || a.tool === 'Edit' || a.tool === 'MultiEdit') && abs) {
      try {
        this.ops.set(g.step, await backupBeforeWrite(this.state.id, abs))
      } catch (err) {
        log.warn('Control: no backup of', abs, err)
      }
    }
    return { ok: true }
  }

  private nativeRan(a: NativeAction): void {
    const req = nativeRequest(a)
    const step = this.addStep({ who: 'action', text: req.title, detail: req.detail, risk: req.risk, state: 'running' })
    this.native.set(a.id, step.id)
  }

  private nativeDone(id: string, ok: boolean, output?: string): void {
    const stepId = this.native.get(id)
    if (!stepId) return
    this.native.delete(id)
    const step = this.state.steps.find((s) => s.id === stepId)
    if (!step) return
    step.state = ok ? 'done' : 'failed'
    if (!ok && output) step.detail = `${step.detail ? `${step.detail}\n` : ''}${output.trim().slice(0, 400)}`
    const op = this.ops.get(stepId)
    if (op && ok) step.undoable = true
    this.refresh()
  }

  private agentFailed(error: string): void {
    log.warn('Control agent:', error)
    this.addStep({ who: 'error', text: error })
    // The CLI is gone: the next order starts it again.
    if (/stopped|did not start|could not start/i.test(error)) {
      this.agent?.close()
      this.agent = null
      this.tools?.stop()
      this.tools = null
    }
    this.setBusy(false)
  }

  // ---------------------------------------------------------------- controls

  pause(): void {
    if (this.paused || !this.state.active) return
    this.paused = true
    this.addStep({ who: 'info', text: 'paused: nothing runs until you resume' })
  }

  resume(quiet = false): void {
    if (!this.paused) return
    this.paused = false
    // Resuming is their word to go on, hands included.
    this.handsTaken = false
    if (!quiet) this.addStep({ who: 'info', text: 'resumed' })
    this.wake()
  }

  private wake(): void {
    for (const w of this.resumeWaiters.splice(0)) w()
    this.refresh()
  }

  private async whilePaused(): Promise<void> {
    while (this.paused && this.state.active) await new Promise<void>((r) => this.resumeWaiters.push(r))
  }

  /** Stop what it's doing: the turn is interrupted, what waits is refused; the session stays for the next order. */
  stop(): void {
    if (!this.state.active) return
    this.stopped = true
    for (const a of this.asks.splice(0)) a.resolve({ decision: 'no', message: 'The user stopped you.' })
    this.paused = false
    this.wake()
    this.agent?.interrupt()
    this.addStep({ who: 'info', text: 'stopped: tell it what to do next' })
  }

  /** Stop, then give it the last order again. */
  restart(): void {
    const order = this.orders[this.orders.length - 1]
    if (!order || !this.state.active) return
    this.stop()
    setTimeout(() => {
      this.stopped = false
      this.addStep({ who: 'info', text: 'restarted with your last order' })
      if (!this.agent) void this.relaunch(order)
      else this.agent.send(`Start again: ${order}`)
    }, 600)
  }

  setApproval(approval: ControlApproval): void {
    if (!this.state.active || approval === this.state.approval) return
    this.state.approval = approval
    if (approval === 'step') this.always.clear()
    this.addStep({ who: 'info', text: `approval: ${CONTROL_APPROVALS.find((a) => a.id === approval)?.label}` })
    this.agent?.send(`(Speak: the user changed the approval level to "${approval}": ${CONTROL_APPROVALS.find((a) => a.id === approval)?.description}.)`)
  }

  /** Another language for its answers, from the settings or the pill: the AI is told. */
  setReplyLanguage(replyLanguage: string): void {
    if (!this.state.active) return
    this.addStep({ who: 'info', text: `answers: ${replyLanguage === 'same' ? 'as you speak' : languageName(replyLanguage).toLowerCase()}` })
    this.agent?.send(`(Speak: the user changed the language you write in. From now on, write in ${replyIn(replyLanguage)}.)`)
  }

  /** Another scope: the AI starts again with it, and the last order. */
  setScope(scope: ControlScope): void {
    if (!this.state.active || scope === this.state.scope) return
    let info
    try {
      info = this.resolveScope(scope)
    } catch (err) {
      this.addStep({ who: 'error', text: (err as Error).message })
      return
    }
    this.stop()
    this.agent?.close()
    this.agent = null
    this.tools?.stop()
    this.tools = null
    this.scopeInfo = info
    this.state.scope = scope
    this.state.scopeLabel = info.label
    this.planApproved = false
    this.always.clear()
    this.addStep({ who: 'info', text: `scope: ${CONTROL_SCOPES.find((s) => s.id === scope)?.label} · ${info.label}` })
    this.stopped = false
    const order = this.orders[this.orders.length - 1]
    if (order) void this.launch(order, configStore.get().ai.provider)
  }

  async undo(stepId: string): Promise<void> {
    const op = this.ops.get(stepId)
    const step = this.state.steps.find((s) => s.id === stepId)
    if (!op || !step) return
    try {
      await undoOp(op)
      step.state = 'undone'
      step.undoable = false
      this.ops.delete(stepId)
      this.agent?.send(`(Speak: the user undid "${step.text}" (${describeOp(op)}).)`)
    } catch (err) {
      this.addStep({ who: 'error', text: `Could not undo: ${(err as Error).message}` })
    }
    this.refresh()
  }

  collapse(collapsed: boolean): void {
    this.state.collapsed = collapsed
    setControlCollapsed(collapsed)
    this.push()
  }

  /** The user records something for the session (the pill), or stopped. */
  setListening(listening: boolean): void {
    if (!this.state.active || this.state.listening === listening) return
    this.state.listening = listening
    this.refresh()
  }

  // ---------------------------------------------------------------- state

  private addStep(step: Omit<ControlStep, 'id' | 'at'>): ControlStep {
    const full: ControlStep = { ...step, id: randomBytes(4).toString('hex'), at: Date.now() }
    const steps = [...this.state.steps, full].slice(-MAX_STEPS)
    // Screenshots only in the latest steps: the panel's memory stays small.
    let images = 0
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].image && ++images > KEEP_IMAGES) steps[i] = { ...steps[i], image: undefined }
    this.state.steps = steps
    if (step.who === 'ai') this.say(step.text)
    this.refresh()
    return full
  }

  private setBusy(busy: boolean): void {
    this.busy = busy
    if (!busy) {
      // A turn ended: what was running didn't report back.
      for (const s of this.state.steps) if (s.state === 'running' && !this.native.size) s.state = 'done'
      this.stopped = false
    }
    this.refresh()
  }

  private refresh(): void {
    const s = this.state
    if (!s.active) return this.push()
    s.ask = this.asks[0]?.ask
    s.status = s.listening
      ? 'listening'
      : this.paused
        ? 'paused'
        : s.ask
          ? 'waiting'
          : s.hands
            ? 'hands'
            : this.busy
              ? s.steps.some((x) => x.state === 'running')
                ? 'acting'
                : 'thinking'
              : 'idle'
    // A frame where Speak has the mouse and the keyboard, or around what an approval is about.
    const framed = this.actingArea ?? (s.ask ? this.askArea : null)
    if (framed) showFrame(framed.rect, this.actingArea ? 'acting' : 'waiting', (frame) => stackAbove(frame, framed.window))
    else hideFrame()
    this.armIdle()
    this.push()
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.state.active || this.state.status !== 'idle') return
    const minutes = configStore.get().control.idleMinutes
    if (minutes > 0) this.idleTimer = setTimeout(() => void this.end(`ended after ${minutes} minutes with nothing to do`), minutes * 60_000)
  }

  private push(): void {
    broadcast('control', this.state)
    this.emit('change', this.state)
  }

  /**
   * The user's hands: when they last touched the mouse or the keyboard, so that what needs them
   * waits until they're still. Speak's own input doesn't count, nor what they do on Speak's panel
   * and pill (answering it).
   */
  private hook(): void {
    this.unhook?.()
    this.unhook = onUsersInput((e) => {
      if (!this.state.active) return
      if (e.kind !== 'key' && speakAreas().some((r) => e.x >= r.x && e.x < r.x + r.w && e.y >= r.y && e.y < r.y + r.h)) return
      this.lastUserInput = Date.now()
    })
  }

  /** The panel takes the keyboard to type an order (on), or gives it back. */
  keyboard(on: boolean): void {
    setControlKeyboard(on)
  }

  /** The app in front, for the pill's label before a session starts. */
  targetLabel(): string {
    return this.pendingTarget ? appName(this.pendingTarget) : ''
  }

  /** For bug reports: no content, only the shape. */
  summary(): string {
    if (!this.state.active) return 'no control session'
    return `control ${this.state.scope}, ${this.state.approval}, ${this.state.status}, ${this.state.steps.length} steps`
  }
}

/**
 * Where Speak's own windows take clicks, in screen coordinates: the control panel, and the pill
 * (the bottom of its window: the rest lets clicks through). A click there answers Speak.
 */
function speakAreas(): Rect[] {
  const areas: Rect[] = []
  const panel = controlPanelRect()
  if (panel) areas.push(panel)
  if (overlay?.isVisible()) {
    const b = dipToScreen(overlay.getBounds())
    const pill = Math.min(90 * (b.height / overlay.getBounds().height || 1), b.height)
    areas.push({ x: b.x, y: b.y + b.height - pill, w: b.width, h: pill })
  }
  return areas
}

// Speak's own windows for the screen: the panel (a click there is Speak's, not the AI's to make).
// The pill's strip isn't one: most of it lets clicks through to what's under it.
setOwnAreas(() => {
  const panel = controlPanelRect()
  return panel ? [panel] : []
})

const ALWAYS_ASK_LABEL = { money: 'money', secrets: 'passwords and security', delete: 'deleting', send: 'sending as you' } as const

/** The screen actions, by their key's kind ("click:Discord.exe"): what "always" says it approves. */
const IN_APP: Record<string, string> = { click: 'clicks', fill: 'filling fields', type: 'typing', key: 'keys', drag: 'dragging' }
const OTHER: Record<string, string> = {
  open: 'opening apps and links',
  move: 'moving files',
  make_folder: 'making folders',
  trash: 'putting files in the trash',
  write: 'writing files',
  'file change': 'changing files'
}

/**
 * What "always" approves for the rest of the session, and how the panel says it: the same kind of
 * action in the same app ("clicks in Discord"). An always-ask item, the item in that app, whatever
 * the action ("sending as you in Discord"). Paying and passwords are never approved in advance.
 */
function alwaysOf(req: ActionRequest, category?: keyof ControlAlwaysAsk): { key: string; label: string } | undefined {
  if (category === 'money' || category === 'secrets') return undefined
  const i = req.key.indexOf(':')
  const kind = i < 0 ? req.key : req.key.slice(0, i)
  const rest = i < 0 ? '' : req.key.slice(i + 1)
  const app = IN_APP[kind] && rest ? rest.replace(/\.exe$/i, '') : ''
  const what = app ? `${IN_APP[kind]} in ${app}` : kind === 'command' ? `running ${rest || 'commands'}` : (OTHER[kind] ?? `using ${req.key}`)
  if (!category) return { key: req.key, label: what }
  const item = ALWAYS_ASK_LABEL[category]
  return app ? { key: `${category}:${rest}`, label: `${item} in ${app}` } : { key: `${category}:${req.key}`, label: `${item} (${what})` }
}

function appName(w: { exe: string; title: string }): string {
  const exe = w.exe.replace(/\.exe$/i, '')
  // "Inbox - marc@x.com - Outlook" → the app's own name when the title ends with it.
  const tail = w.title
    .split(/ [-–—|] /)
    .pop()
    ?.trim()
  return tail && tail.length <= 30 && tail.toLowerCase().replace(/\s/g, '').includes(exe.toLowerCase().slice(0, 4)) ? tail : exe || w.title.slice(0, 30)
}

/** A CLI's own action, for the gate. */
function nativeRequest(a: NativeAction, abs?: string): ActionRequest {
  const input = a.input
  const where = abs ?? (typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '')
  switch (a.tool) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return { title: `read ${where || String(input.pattern ?? '')}`.trim(), risk: 'look', key: 'read' }
    case 'Write':
      return { title: `write ${shortPath(where)}`, detail: where, risk: 'change', key: 'write' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { title: `edit ${shortPath(where)}`, detail: where, risk: 'change', key: 'write' }
    case 'Bash':
    case 'PowerShell':
    case 'command': {
      const command = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? '')
      const category = /\b(rm|del|erase|rmdir|rd|remove-item|shred|format)\b/i.test(command) ? 'delete' : categoryOf(String(input.description ?? ''))
      return {
        title: String(input.description ?? '') || `run ${command.split(/\s+/)[0] ?? 'a command'}`,
        detail: command,
        risk: 'risky',
        category,
        key: `command:${command.trim().split(/\s+/)[0] ?? ''}`
      }
    }
    case 'file change':
      return { title: 'change files', detail: String(input.reason ?? ''), risk: 'change', key: 'file change' }
    default:
      return { title: `use ${a.tool}`, detail: JSON.stringify(input).slice(0, 300), risk: 'risky', key: a.tool }
  }
}

const shortPath = (p: string) => p.split(/[\\/]/).slice(-2).join('/')

export const control = new Control()
