import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { arch, homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app, screen, systemPreferences } from 'electron'
import type { BugReport, BugReportRequest } from '../shared/bug-report'
import type { AgentId, Mode } from '../shared/types'
import { themeShown } from '../themes/shared'
import { AGENT_NAMES, agentStatus, askAgent, modelFor } from './ai'
import { ANALYSIS_PROMPT, analysisMessage, diagnosticsText, dictationsCourse, logTail, parseAnalysis, scrub, titleFrom, type Machine } from './bug-report'
import { configStore } from './config'
import { control } from './control'
import { controller } from './controller'
import { history } from './history'
import { hotkeys } from './hotkeys'
import { log } from './log'
import { paths } from './paths'
import { accessibilityTrusted, keyboardHookAvailable } from './platform/keyboard'
import { seasons } from './season'
import { engine } from './stt/engine'
import { isLinux, isMac, isWayland, isWin } from './util'
import { pillState } from './windows'

/**
 * "report a bug", run: the facts gathered and scrubbed, then the user's AI provider asked for the
 * report, text only (no tools, no web), with nothing saved. It sees what the report will hold and
 * nothing more; its answer is scrubbed again. Nothing leaves the app here: the main window opens
 * the report on GitHub, where the user reads it before submitting it.
 */

const ANALYSIS_MINUTES = 4
/** The log's end is what matters: no need to read 5 MB for 60 lines. */
const LOG_BYTES = 64 * 1024
const KEPT_ERRORS = 10

let current: AbortController | null = null

/**
 * The windows' last errors, in memory only: an error's message may quote what was on screen, so
 * it's never written to the log. Gone when Speak quits.
 */
const windowErrors: string[] = []

export function noteWindowError(view: string, message: string): void {
  windowErrors.push(`${new Date().toISOString()} [${String(view).slice(0, 20)}] ${String(message).slice(0, 600)}`)
  if (windowErrors.length > KEPT_ERRORS) windowErrors.shift()
}

function machine(): Machine {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    // No account name on this system: only the home folder is scrubbed.
  }
  return { home: homedir(), user }
}

/** The system as GitHub's form asks it: its name, version and processor. */
function systemLine(): string {
  const version = process.getSystemVersion?.() ?? ''
  if (isMac) return `macOS ${version} (${arch() === 'arm64' ? 'Apple silicon' : 'Intel'})`
  if (isWin) return `Windows ${version} (${arch()})`
  return `Linux ${version} (${arch()})`
}

function linuxSession(): string {
  if (!isLinux) return ''
  const desktop = process.env.XDG_CURRENT_DESKTOP || 'unknown desktop'
  return `, ${desktop}, ${process.env.XDG_SESSION_TYPE || 'unknown'} session, ${app.commandLine.getSwitchValue('ozone-platform') || 'default'} display`
}

function displays(): string {
  const primary = screen.getPrimaryDisplay().id
  return screen
    .getAllDisplays()
    .map((d) => `${d.bounds.width}x${d.bounds.height} at ${d.bounds.x},${d.bounds.y} (${d.scaleFactor}x${d.id === primary ? ', primary' : ''})`)
    .join('; ')
}

function readLogEnd(): string {
  let fd: number | null = null
  try {
    fd = openSync(join(paths.logs, 'speak.log'), 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, LOG_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    // The first line may start midway: dropped.
    const text = buffer.toString('utf8')
    return size > length ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const onOff = (on: boolean) => (on ? 'on' : 'off')

async function transcription(): Promise<string> {
  const t = configStore.get().speech
  const model = t.models[t.engine]
  const status = await engine.status().catch(() => null)
  const bin = status?.binary
  return [
    `${t.engine}, model ${model}${status && !status.models.some((m) => m.id === model && m.installed) ? ' (not installed)' : ''}${engine.modelLoaded ? ', loaded' : ''}`,
    bin ? (bin.found ? `binary ${bin.source ?? 'found'}${bin.variant ? ` ${bin.variant}` : ''}` : 'binary not found') : 'status unknown',
    `gpu ${onOff(t.useGpu)}${status?.gpu.nvidia ? ` (${status.gpu.name})` : ''}`,
    `vad ${onOff(t.vad)}`,
    t.threads ? `${t.threads} threads` : '',
    t.customBinDir ? 'custom binary folder' : ''
  ]
    .filter(Boolean)
    .join(', ')
}

/** Each mode's model, as it runs: "dictate haiku, compose sonnet (picked), control sonnet". */
async function modelsLine(provider: AgentId): Promise<string> {
  const picked = configStore.get().ai[provider === 'claude-code' ? 'claudeCode' : 'codex'].models
  const modes: Mode[] = ['dictate', 'compose', 'control']
  const models = await Promise.all(modes.map((m) => modelFor(provider, m).catch(() => '?')))
  return modes.map((m, i) => `${m} ${models[i]}${picked[m] ? ' (picked)' : ''}`).join(', ')
}

/** The AI provider's name and dictation model, as the form's "AI provider" field says it. */
async function aiLine(): Promise<string> {
  const ai = configStore.get().ai
  if (ai.provider === 'none') return 'none'
  return `${AGENT_NAMES[ai.provider]} (${await modelFor(ai.provider, 'dictate').catch(() => '?')})`
}

async function aiDiagnostics(): Promise<string> {
  const ai = configStore.get().ai
  if (ai.provider === 'none') return 'off'
  const cfg = ai.provider === 'claude-code' ? ai.claudeCode : ai.codex
  const status = await agentStatus(ai.provider).catch(() => null)
  // The account (an email) is left out: only whether the CLI was found and signed in.
  const found = status ? (status.found ? `found${status.version ? `, ${status.version}` : ''}` : 'not found') : 'status unknown'
  return [
    AGENT_NAMES[ai.provider],
    `${found}${status?.loggedIn === false ? ', signed out' : ''}${status?.error ? `, ${status.error}` : ''}`,
    `models ${await modelsLine(ai.provider)}, effort ${cfg.effort}`,
    `timeout ${ai.timeoutSeconds}s`,
    cfg.path ? 'custom cli path' : '',
    cfg.home ? 'custom home path' : '',
    ai.instructions.trim() ? 'custom instructions' : ''
  ]
    .filter(Boolean)
    .join('; ')
}

/** The settings, as the tabs group them, without anything personal (paths, addresses, words). */
function settings(): string {
  const c = configStore.get()
  const r = c.recording
  const w = c.writing
  const ctl = c.control
  return [
    `modes ${Object.entries(c.modes)
      .map(([m, { on, shortcut }]) => `${m} ${on ? shortcut || 'no shortcut' : 'off'}`)
      .join(', ')}`,
    `recording ${r.press}, cancel ${r.cancel || 'none'}, max ${r.maxSeconds}s, sounds ${onOff(r.sounds)}, pill ${onOff(r.indicator)}`,
    `microphone ${c.speech.microphone.id === 'default' ? 'default' : 'chosen'}, spoken ${c.speech.language}`,
    `writing ${w.format} → ${w.language}, then ${w.then} (paste keys ${w.pasteKeys}, restore clipboard ${onOff(w.restoreClipboard)})`,
    // The kind only: a folder's path or a page's address is the user's business.
    `context ${c.context.recent.find((s) => s.location === c.context.current)?.kind ?? 'none'} (${c.context.recent.length} recent)`,
    `control ${ctl.scope}, asks ${ctl.approval}, always-ask ${
      Object.entries(ctl.alwaysAsk)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .join('+') || 'none'
    }, answers ${ctl.language}`,
    `history ${onOff(c.history.enabled)}${c.history.keepAudio ? ' with audio' : ''}`,
    `theme ${seasons.current && themeShown(c, seasons.current) ? seasons.current.id : 'none'}`,
    `launch at login ${onOff(c.app.launchAtLogin)}`,
    `auto updates ${onOff(c.updates.auto)}`
  ].join(', ')
}

function permissions(): string {
  const microphone = isMac || isWin ? systemPreferences.getMediaAccessStatus('microphone') : 'n/a'
  const accessibility = accessibilityTrusted(false)
  return [
    `microphone ${microphone}`,
    `accessibility ${accessibility === null ? 'n/a' : accessibility ? 'granted' : 'not granted'}`,
    `keyboard hook ${keyboardHookAvailable() ? 'available' : 'unavailable'}`,
    isWayland ? 'wayland session' : '',
    hotkeys.error ? `shortcut error: ${hotkeys.error}` : ''
  ]
    .filter(Boolean)
    .join(', ')
}

async function diagnostics(req: BugReportRequest): Promise<string> {
  const [speech, ai, sessions] = await Promise.all([transcription(), aiDiagnostics(), history.list('', 5).catch(() => [])])
  return diagnosticsText({
    app: `Speak ${app.getVersion()}${app.isPackaged ? '' : ' (development run)'}, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
    system: `${systemLine()}, language ${app.getLocale()}${linuxSession()}`,
    displays: displays(),
    transcription: speech,
    ai,
    settings: settings(),
    permissions: permissions(),
    pill: `${pillState()}; dictation ${controller.phase}; ${control.summary()}`,
    screen: String(req.screen ?? '').slice(0, 120) || 'unknown',
    errors: windowErrors,
    dictations: dictationsCourse(sessions),
    log: logTail(readLogEnd())
  })
}

/** The report of what the user saw, analyzed by their AI provider if they asked and it's ready. */
export async function prepareBugReport(req: BugReportRequest): Promise<BugReport> {
  const who = machine()
  const clean = (text: string) => scrub(text, who)
  const words = clean(String(req.description ?? '').slice(0, 4000)).trim()
  const base: BugReport = {
    title: titleFrom(words),
    what: words,
    steps: '',
    analysis: '',
    version: app.getVersion(),
    system: systemLine(),
    ai: await aiLine(),
    diagnostics: clean(await diagnostics(req)),
    analyzedBy: null
  }
  if (!req.analyze) return base
  const provider = configStore.get().ai.provider
  if (provider === 'none') return { ...base, problem: 'no analysis: ai is off (settings → ai)' }
  const name = AGENT_NAMES[provider]
  const status = await agentStatus(provider).catch(() => null)
  if (!status?.found || status.loggedIn === false) return { ...base, problem: "no analysis: the ai isn't ready (settings → ai)" }

  current?.abort()
  const abort = new AbortController()
  current = abort
  try {
    const result = await askAgent(ANALYSIS_PROMPT, analysisMessage(words, base.diagnostics), {
      timeoutMs: ANALYSIS_MINUTES * 60_000,
      signal: abort.signal
    })
    const found = parseAnalysis(result.text)
    log.info(`Bug report analyzed by ${provider}/${result.model} in ${result.ms}ms`)
    return {
      ...base,
      title: clean(found.title) || base.title,
      steps: clean(found.steps),
      analysis: clean(found.analysis),
      analyzedBy: `${name} (${result.model})`
    }
  } catch (err) {
    if (abort.signal.aborted) return { ...base, problem: 'no analysis: stopped' }
    log.warn('Bug report: no analysis from', provider, (err as Error).message)
    return { ...base, problem: `no analysis: the ai failed (${clean((err as Error).message)})` }
  } finally {
    if (current === abort) current = null
  }
}

/** "stop": the analysis under way stops, and the report comes without it. */
export function cancelBugReport(): void {
  current?.abort()
}
