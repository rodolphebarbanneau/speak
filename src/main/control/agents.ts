import type { ChildProcess } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentConfig, ControlScope } from '../../shared/types'
import { claudeLaunch } from '../ai/claude-code'
import { codexLaunch, codexUserMcpServers } from '../ai/codex'
import { log } from '../log'
import { paths } from '../paths'
import { isWin, spawnPiped } from '../util'

/**
 * The AI of a control session: the user's own Claude Code or Codex, run as a live session (it
 * keeps the conversation, takes new messages while it works, can be interrupted), whose built-in
 * actions (commands, file edits) Speak approves, and whose screen and file tools are Speak's.
 */

/** A built-in action of the CLI, for the gate: a command, a file written or read… */
export interface NativeAction {
  /** Claude Code's tool name, or Codex's "command" / "file change". */
  tool: string
  input: Record<string, unknown>
  /** To match its result (the step ends when it does). */
  id: string
}

export interface AgentEvents {
  /** It says something (final: its answer at the end of a turn). */
  text(text: string): void
  /** A turn started (busy) or ended. */
  busy(busy: boolean): void
  /** A built-in action asks to run: allow or not (with why). */
  approve(action: NativeAction): Promise<{ ok: true } | { ok: false; reason: string }>
  /** A built-in action ran without asking (reads, commands Codex deems safe). */
  ran(action: NativeAction): void
  /** A built-in action ended. */
  done(id: string, ok: boolean, output?: string): void
  /** The session can't go on. */
  failed(error: string): void
}

export interface AgentOptions {
  scope: ControlScope
  /** Working folder: the user's home. */
  cwd: string
  system: string
  model: string
  effort: string
  mcp: { url: string; token: string }
  cfg: AgentConfig
}

export interface ControlAgent {
  readonly label: string
  start(first: string): Promise<void>
  send(text: string): void
  interrupt(): void
  close(): void
}

/** JSON lines from a child's stdout. */
function lines(child: ChildProcess, onLine: (msg: any) => void): void {
  let buf = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      try {
        onLine(msg)
      } catch (err) {
        log.warn('Control: could not handle a message:', err)
      }
    }
  })
}

// ---------------------------------------------------------------- Claude Code

/** Claude Code's built-in tools per scope: the screen goes through Speak's tools only. */
function claudeTools(scope: ControlScope): string {
  return scope === 'full' ? 'Read,Glob,Grep,Write,Edit,Bash' : ''
}

export class ClaudeAgent implements ControlAgent {
  readonly label: string
  private child: ChildProcess | null = null
  private files: string[] = []
  private closed = false
  private stderr = ''

  constructor(
    private o: AgentOptions,
    private on: AgentEvents
  ) {
    this.label = `claude code · ${o.model}`
  }

  async start(first: string): Promise<void> {
    const { path, env } = claudeLaunch(this.o.cfg)
    const id = `${process.pid}-${Date.now()}`
    const system = join(paths.tmp, `control-system-${id}.txt`)
    const mcp = join(paths.tmp, `control-mcp-${id}.json`)
    await writeFile(system, this.o.system, 'utf8')
    await writeFile(
      mcp,
      JSON.stringify({ mcpServers: { speak: { type: 'http', url: this.o.mcp.url, headers: { Authorization: `Bearer ${this.o.mcp.token}` } } } }),
      'utf8'
    )
    this.files = [system, mcp]
    const args = [
      '-p',
      ['--input-format', 'stream-json'],
      ['--output-format', 'stream-json'],
      '--verbose',
      // Its permission prompts come to Speak, on stdin/stdout.
      ['--permission-prompt-tool', 'stdio'],
      ['--model', this.o.model],
      ['--effort', this.o.effort],
      ['--system-prompt-file', system],
      ['--tools', claudeTools(this.o.scope)],
      ['--setting-sources', ''],
      '--strict-mcp-config',
      ['--mcp-config', mcp],
      '--disable-slash-commands',
      '--no-session-persistence'
    ].flat()
    // Speak's tools may wait long for the user (an approval, a question).
    const child = spawnPiped(path, args, { cwd: this.o.cwd, env: { ...env, MCP_TOOL_TIMEOUT: '3600000' } })
    this.child = child
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-2000)))
    child.on('error', (err) => this.on.failed(`Claude Code did not start: ${err.message}`))
    child.on('exit', (code) => {
      if (!this.closed)
        this.on.failed(`Claude Code stopped (exit ${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)
    })
    lines(child, (m) => this.message(m))
    this.send(first)
  }

  private write(msg: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  send(text: string): void {
    this.on.busy(true)
    this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
  }

  interrupt(): void {
    this.write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } })
  }

  private message(m: any): void {
    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) this.on.text(block.text.trim())
        // Speak's own tools log themselves; the built-in ones that don't ask are noted when they end.
        else if (block.type === 'tool_use' && !String(block.name).startsWith('mcp__'))
          this.pending.set(block.id, { tool: block.name, input: block.input ?? {}, id: block.id })
      }
    } else if (m.type === 'user') {
      for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (block.type !== 'tool_result') continue
        const action = this.pending.get(block.tool_use_id)
        if (!action) continue
        this.pending.delete(block.tool_use_id)
        const output = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c.text ?? '').join('\n')
        if (!this.asked.has(block.tool_use_id)) this.on.ran(action)
        this.on.done(block.tool_use_id, !block.is_error, output)
      }
    } else if (m.type === 'result') {
      if (m.is_error && m.result) this.on.failed(String(m.result))
      this.on.busy(false)
    } else if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      void this.permission(m.request_id, m.request)
    } else if (m.type === 'control_cancel_request') {
      // The CLI gave up on a prompt (interrupted): nothing to answer.
    }
  }

  /** Built-in tool uses seen, until their result. */
  private pending = new Map<string, NativeAction>()
  /** Those that asked (the gate made their step). */
  private asked = new Set<string>()

  private async permission(requestId: string, req: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }): Promise<void> {
    const respond = (response: Record<string, unknown>) =>
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    // Speak's tools go through the gate inside Speak, when they run.
    if (req.tool_name.startsWith('mcp__speak__')) return respond({ behavior: 'allow', updatedInput: req.input })
    const id = req.tool_use_id ?? requestId
    this.asked.add(id)
    const r = await this.on.approve({ tool: req.tool_name, input: req.input ?? {}, id })
    respond(r.ok ? { behavior: 'allow', updatedInput: req.input } : { behavior: 'deny', message: r.reason })
  }

  close(): void {
    this.closed = true
    this.child?.stdin?.end()
    const child = this.child
    setTimeout(() => child?.kill(), 1500)
    this.child = null
    for (const f of this.files) void rm(f, { force: true })
  }
}

// ---------------------------------------------------------------- Codex

/** Codex features that would act beyond Speak's tools (its own computer use, browser, apps…). */
const CODEX_OFF = ['apps', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'plugins', 'image_generation', 'multi_agent', 'memories']

export class CodexAgent implements ControlAgent {
  readonly label: string
  private child: ChildProcess | null = null
  private seq = 0
  private calls = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>()
  private thread = ''
  private turn: string | null = null
  private closed = false
  private stderr = ''
  /** Messages said while no turn runs yet (the thread starting). */
  private queue: string[] = []

  constructor(
    private o: AgentOptions,
    private on: AgentEvents
  ) {
    this.label = `codex · ${o.model}`
  }

  async start(first: string): Promise<void> {
    const { path, env } = codexLaunch(this.o.cfg)
    const theirs = await codexUserMcpServers()
    const args = [
      'app-server',
      ...CODEX_OFF.flatMap((f) => ['--disable', f]),
      ...theirs.flatMap((name) => ['-c', `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`]),
      ['-c', 'project_doc_max_bytes=0'],
      ...(isWin ? [['-c', 'windows.sandbox="unelevated"']] : [])
    ].flat()
    const child = spawnPiped(path, args, { cwd: this.o.cwd, env })
    this.child = child
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-2000)))
    child.on('error', (err) => this.on.failed(`Codex did not start: ${err.message}`))
    child.on('exit', (code) => {
      if (!this.closed) this.on.failed(`Codex stopped (exit ${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)
      for (const c of this.calls.values()) c.reject(new Error('Codex stopped'))
      this.calls.clear()
    })
    lines(child, (m) => this.message(m))
    this.on.busy(true)
    try {
      await this.call('initialize', { clientInfo: { name: 'speak', title: 'Speak', version: '1' }, capabilities: null })
      this.write({ method: 'initialized' })
      const sandbox = this.o.scope === 'full' ? 'danger-full-access' : 'read-only'
      const t = await this.call('thread/start', {
        cwd: this.o.cwd,
        model: this.o.model,
        approvalPolicy: 'untrusted',
        sandbox,
        ephemeral: true,
        developerInstructions: this.o.system,
        // Speak's tools may wait long for the user (an approval, a question).
        config: { mcp_servers: { speak: { url: this.o.mcp.url, http_headers: { Authorization: `Bearer ${this.o.mcp.token}` }, tool_timeout_sec: 3600 } } }
      })
      this.thread = t.thread.id
      await this.startTurn(first)
      for (const text of this.queue.splice(0)) this.send(text)
    } catch (err) {
      this.on.failed(`Codex could not start the session: ${(err as Error).message}`)
    }
  }

  private write(msg: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private call(method: string, params: unknown): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  private async startTurn(text: string): Promise<void> {
    this.on.busy(true)
    const r = await this.call('turn/start', { threadId: this.thread, input: [{ type: 'text', text, text_elements: [] }], effort: this.o.effort })
    this.turn = r.turn?.id ?? this.turn
  }

  send(text: string): void {
    if (!this.thread) {
      this.queue.push(text)
      return
    }
    // While it works, what's said steers the turn under way.
    if (this.turn)
      this.call('turn/steer', { threadId: this.thread, expectedTurnId: this.turn, input: [{ type: 'text', text, text_elements: [] }] }).catch(() =>
        this.startTurn(text).catch((err) => this.on.failed((err as Error).message))
      )
    else this.startTurn(text).catch((err) => this.on.failed((err as Error).message))
  }

  interrupt(): void {
    if (this.thread && this.turn) void this.call('turn/interrupt', { threadId: this.thread, turnId: this.turn }).catch(() => undefined)
  }

  /** Item ids that asked (the gate made their step). */
  private asked = new Set<string>()

  private message(m: any): void {
    // A reply to one of ours.
    if (m.id !== undefined && m.method === undefined) {
      const c = this.calls.get(m.id)
      this.calls.delete(m.id)
      if (m.error) c?.reject(new Error(m.error.message ?? JSON.stringify(m.error)))
      else c?.resolve(m.result)
      return
    }
    // A request from Codex: approvals, mostly.
    if (m.id !== undefined && m.method) return void this.request(m.id, m.method, m.params ?? {})
    const p = m.params ?? {}
    switch (m.method) {
      case 'turn/started':
        this.turn = p.turn?.id ?? this.turn
        this.on.busy(true)
        return
      case 'turn/completed':
        this.turn = null
        if (p.turn?.status === 'failed' && p.turn?.error?.message) this.on.failed(p.turn.error.message)
        this.on.busy(false)
        return
      case 'item/started': {
        const item = p.item ?? {}
        if (item.type === 'commandExecution' && !this.asked.has(item.id)) this.on.ran({ tool: 'command', input: { command: item.command }, id: item.id })
        return
      }
      case 'item/completed': {
        const item = p.item ?? {}
        if (item.type === 'agentMessage' && item.text?.trim()) this.on.text(item.text.trim())
        else if (item.type === 'commandExecution') this.on.done(item.id, item.status === 'completed' && (item.exitCode ?? 0) === 0, item.aggregatedOutput)
        else if (item.type === 'fileChange') {
          if (!this.asked.has(item.id)) this.on.ran({ tool: 'file change', input: { changes: item.changes }, id: item.id })
          this.on.done(item.id, item.status === 'completed')
        }
        return
      }
      case 'error':
        if (p.error?.message && !p.willRetry) this.on.failed(p.error.message)
        return
    }
  }

  private async request(id: number | string, method: string, p: any): Promise<void> {
    const reply = (result: unknown) => this.write({ id, result })
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const itemId = p.itemId ?? String(id)
      this.asked.add(itemId)
      const r = await this.on.approve({ tool: 'command', input: { command: p.command, cwd: p.cwd, reason: p.reason }, id: itemId })
      return reply({ decision: r.ok ? 'accept' : 'decline' })
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const itemId = p.itemId ?? String(id)
      this.asked.add(itemId)
      const r = await this.on.approve({ tool: 'file change', input: { reason: p.reason, grantRoot: p.grantRoot }, id: itemId })
      return reply({ decision: r.ok ? 'accept' : 'decline' })
    }
    if (method === 'item/permissions/requestApproval') return reply({ decision: 'decline' })
    // Codex asks before calling an MCP server's tool: Speak's own are gated inside Speak, when they run.
    if (method === 'mcpServer/elicitation/request')
      return reply(p.serverName === 'speak' ? { action: 'accept', content: {} } : { action: 'decline', content: null })
    if (method === 'item/tool/requestUserInput') return reply({ answers: {} })
    this.write({ id, error: { code: -32601, message: `Speak does not handle ${method}` } })
  }

  close(): void {
    this.closed = true
    this.child?.stdin?.end()
    const child = this.child
    setTimeout(() => child?.kill(), 1500)
    this.child = null
  }
}
