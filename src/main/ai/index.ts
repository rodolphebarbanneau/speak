import { CLAUDE_CODE_MODELS, RECOMMENDED_MODELS } from '../../shared/constants'
import type { AgentConfig, AgentId, AgentModel, AgentModels, AgentStatus, AiTestResult, Mode, ProviderId, Style } from '../../shared/types'
import { configStore } from '../config'
import { log } from '../log'
import { claudeComplete, claudeLogin, claudeStatus } from './claude-code'
import { codexComplete, codexLogin, codexModels, codexStatus } from './codex'
import {
  cleanOutput,
  COMPOSE_SYSTEM,
  composeMessage,
  EDIT_SYSTEM,
  editMessage,
  PROCESS_SYSTEM,
  processMessage,
  stripSubjectLine,
  type PromptContext
} from './prompts'
import type { CompleteOptions, Completion } from './types'

export interface AiResult {
  text: string
  provider: string
  model: string
  ms: number
}

/**
 * A dictation's context, for the AI. `dir`: a folder compose may read (read-only), the working
 * directory of the CLI; dictation only gets `text`, to spell names the way the project does.
 */
export interface AiContext extends PromptContext {
  dir?: string
}

/** The AI found nothing to write and said so, as the prompts ask, with a reply like "[Nothing intelligible to write]". */
export class NothingToWrite extends Error {}

/** "[Nothing intelligible to write]": words, not dictated code such as "[1, 2, 3]", "['a', 'b']" or "[x == y]". */
function bracketedError(text: string): string | undefined {
  const inner = text.match(/^\[([^[\]\n]{1,200})\]$/)?.[1].trim()
  if (!inner || !/^\p{L}/u.test(inner) || !/\p{L}{3}/u.test(inner) || !/\s/.test(inner) || /["`=(){}<>;]/.test(inner)) return undefined
  return inner
}

function written(result: AiResult): AiResult {
  const error = bracketedError(result.text)
  if (error) throw new NothingToWrite(error)
  return result
}

interface Agent {
  config: () => AgentConfig
  status: (cfg: AgentConfig, refresh: boolean) => Promise<AgentStatus>
  login: (cfg: AgentConfig) => Promise<void>
  models: () => Promise<AgentModel[]>
  complete: (system: string, user: string, cfg: AgentConfig, opts: CompleteOptions) => Promise<Completion>
}

const AGENTS: Record<AgentId, Agent> = {
  'claude-code': {
    config: () => configStore.get().ai.claudeCode,
    status: claudeStatus,
    login: claudeLogin,
    models: async () => CLAUDE_CODE_MODELS,
    complete: claudeComplete
  },
  codex: {
    config: () => configStore.get().ai.codex,
    status: codexStatus,
    login: codexLogin,
    models: codexModels,
    complete: codexComplete
  }
}

const statusCache = new Map<AgentId, { at: number; key: string; status: AgentStatus }>()

export async function agentStatus(id: AgentId, refresh = false): Promise<AgentStatus> {
  const agent = AGENTS[id]
  const cfg = agent.config()
  // A changed cli path or home path means another CLI or account: check again.
  const key = `${cfg.path}
${cfg.home}`
  const cached = statusCache.get(id)
  if (!refresh && cached && cached.key === key && Date.now() - cached.at < 60_000) return cached.status
  const status = await agent.status(cfg, refresh)
  statusCache.set(id, { at: Date.now(), key, status })
  return status
}

export async function agentLogin(id: AgentId): Promise<void> {
  statusCache.delete(id)
  await AGENTS[id].login(AGENTS[id].config())
}

/**
 * A provider's models, and the one recommended for each mode: Claude Code's aliases follow the
 * latest of each family; Codex's workhorse is the first of its catalog.
 */
export async function agentModels(id: AgentId): Promise<AgentModels> {
  const models = await AGENTS[id].models()
  const first = models[0]?.id ?? ''
  const recommended = Object.fromEntries(Object.entries(RECOMMENDED_MODELS[id]).map(([mode, model]) => [mode, model || first])) as Record<Mode, string>
  return { models, recommended }
}

/** The model a mode runs on: the one picked in the settings, else the recommended one. */
export async function modelFor(provider: AgentId, mode: Mode): Promise<string> {
  return AGENTS[provider].config().models[mode] || (await agentModels(provider)).recommended[mode]
}

export function aiConfigured(): boolean {
  return configStore.get().ai.provider !== 'none'
}

const OTHER: Record<AgentId, AgentId> = { 'claude-code': 'codex', codex: 'claude-code' }
/** A provider that failed for want of an account (signed out, limit reached, gone) is left aside this long, when the other can write. */
const RESTING_MS = 30 * 60_000
const resting = new Map<AgentId, number>()

/** The provider can't write for now, whatever is asked: its account, its limits, its install. */
function unavailable(message: string): boolean {
  return / not signed in| not found|limit|quota|usage|credit|billing|429|exceeded/i.test(message)
}

/**
 * Run the request on the chosen provider. When it fails (signed out, weekly limit reached, an
 * error), the other provider writes it instead (settings → ai → fall back): tried right away, as
 * asking whether it's signed in takes as long as a CLI start, and one not installed fails at once.
 * A provider that failed for want of an account is tried second for a while, not waited for every
 * time. A cancel or a timeout is no reason to switch: it would only make the wait longer.
 */
async function complete(system: string, user: string, mode: Mode, signal?: AbortSignal, readDir?: string): Promise<AiResult> {
  const ai = configStore.get().ai
  const provider: ProviderId = ai.provider
  if (provider === 'none') throw new Error('AI processing is off. Pick Claude Code or Codex in Speak → settings → ai, or use the verbatim format.')
  if (!ai.fallback) return completeWith(provider, system, user, mode, signal, readDir)
  const [first, second] = (resting.get(provider) ?? 0) > Date.now() ? [OTHER[provider], provider] : [provider, OTHER[provider]]
  try {
    return await completeWith(first, system, user, mode, signal, readDir)
  } catch (err) {
    const message = (err as Error).message
    if (signal?.aborted || /timed out/i.test(message)) throw err
    if (first === provider && unavailable(message)) {
      resting.set(provider, Date.now() + RESTING_MS)
      log.warn(`${AGENT_NAMES[provider]} is unavailable: ${AGENT_NAMES[second]} is tried first for the next ${RESTING_MS / 60_000} minutes`)
    } else log.warn(`${AGENT_NAMES[first]} failed: ${AGENT_NAMES[second]} writes this one`)
    try {
      return await completeWith(second, system, user, mode, signal, readDir)
    } catch (again) {
      log.warn(`${AGENT_NAMES[second]} failed too:`, (again as Error).message)
      // The chosen provider's error says what to fix.
      throw first === provider ? err : again
    }
  }
}

async function completeWith(provider: AgentId, system: string, user: string, mode: Mode, signal?: AbortSignal, readDir?: string): Promise<AiResult> {
  const ai = configStore.get().ai
  const agent = AGENTS[provider]
  const model = await modelFor(provider, mode)
  const started = Date.now()
  // Reading files takes a few more round trips: twice the time.
  const timeoutMs = Math.max(10, ai.timeoutSeconds) * 1000 * (readDir ? 2 : 1)
  const result = await agent.complete(system, user, agent.config(), { model, timeoutMs, signal, readDir })
  const text = cleanOutput(result.text)
  if (!text) throw new Error('The AI returned an empty result.')
  const ms = Date.now() - started
  log.info(`AI ${provider}/${result.model} took ${ms}ms${readDir ? ' (reading the context folder)' : ''}`)
  // It answered: it is no longer left aside.
  resting.delete(provider)
  return { text, provider, model: result.model, ms }
}

/** The provider's name as people know it. */
export const AGENT_NAMES: Record<AgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

/**
 * Ask the AI provider anything else than a dictation (a bug report's analysis): the reply as it
 * came, text only, with the dictation model and none of the dictation's clean-up.
 */
export async function askAgent(system: string, user: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<AiResult> {
  const ai = configStore.get().ai
  if (ai.provider === 'none') throw new Error('AI processing is off.')
  const started = Date.now()
  const model = await modelFor(ai.provider, 'dictate')
  const result = await AGENTS[ai.provider].complete(system, user, AGENTS[ai.provider].config(), { ...opts, model })
  return { text: result.text, provider: ai.provider, model: result.model, ms: Date.now() - started }
}

/**
 * Rewrite a transcript in a style, spelling names as `context` does; or (compose) write the text
 * its brief asks for, with `context` as material, and its folder to read.
 */
export async function processTranscript(
  transcript: string,
  opts: { inputLanguage: string; style: Style; outputLanguage: string; context?: AiContext; signal?: AbortSignal }
): Promise<AiResult> {
  const cfg = configStore.get()
  if (opts.style === 'compose') {
    const user = composeMessage({
      transcript,
      inputLanguage: opts.inputLanguage,
      outputLanguage: opts.outputLanguage,
      vocabulary: cfg.speech.vocabulary,
      custom: cfg.ai.instructions,
      context: opts.context,
      canRead: !!opts.context?.dir
    })
    const result = written(await complete(COMPOSE_SYSTEM, user, 'compose', opts.signal, opts.context?.dir))
    return { ...result, text: stripSubjectLine(result.text, transcript) }
  }
  const user = processMessage({
    transcript,
    inputLanguage: opts.inputLanguage,
    style: opts.style,
    outputLanguage: opts.outputLanguage,
    vocabulary: cfg.speech.vocabulary,
    custom: cfg.ai.instructions,
    context: opts.context
  })
  return written(await complete(PROCESS_SYSTEM, user, 'dictate', opts.signal))
}

export function editText(text: string, instruction: string, signal?: AbortSignal): Promise<AiResult> {
  const cfg = configStore.get()
  return complete(EDIT_SYSTEM, editMessage({ text, instruction, vocabulary: cfg.speech.vocabulary, custom: cfg.ai.instructions }), 'dictate', signal)
}

export async function testAi(): Promise<AiTestResult> {
  const sample = "euh alors je voudrais que tu, que tu écrives une fonction qui calcule la somme, non pardon, la moyenne d'une liste en type script"
  try {
    const r = await processTranscript(sample, { inputLanguage: 'fr', style: 'clean', outputLanguage: 'en' })
    return { ok: true, text: r.text, ms: r.ms, model: r.model }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
