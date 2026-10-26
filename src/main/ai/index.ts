import { CLAUDE_CODE_MODELS } from '../../shared/constants'
import type { AgentConfig, AgentId, AgentModel, AgentStatus, AiTestResult, Style } from '../../shared/types'
import { configStore } from '../config'
import { log } from '../log'
import { claudeComplete, claudeLogin, claudeStatus } from './claude-code'
import { codexComplete, codexLogin, codexModels, codexStatus } from './codex'
import { cleanOutput, EDIT_SYSTEM, editMessage, PROCESS_SYSTEM, processMessage } from './prompts'
import type { Completion } from './types'

export interface AiResult {
  text: string
  provider: string
  model: string
  ms: number
}

interface Agent {
  config: () => AgentConfig
  status: (cfg: AgentConfig, refresh: boolean) => Promise<AgentStatus>
  login: (cfg: AgentConfig) => Promise<void>
  models: () => Promise<AgentModel[]>
  complete: (system: string, user: string, cfg: AgentConfig, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<Completion>
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

const statusCache = new Map<AgentId, { at: number; status: AgentStatus }>()

export async function agentStatus(id: AgentId, refresh = false): Promise<AgentStatus> {
  const cached = statusCache.get(id)
  if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.status
  const agent = AGENTS[id]
  const status = await agent.status(agent.config(), refresh)
  statusCache.set(id, { at: Date.now(), status })
  return status
}

export async function agentLogin(id: AgentId): Promise<void> {
  statusCache.delete(id)
  await AGENTS[id].login(AGENTS[id].config())
}

export const agentModels = (id: AgentId) => AGENTS[id].models()

export function aiConfigured(): boolean {
  return configStore.get().ai.provider !== 'none'
}

async function complete(system: string, user: string, signal?: AbortSignal): Promise<AiResult> {
  const ai = configStore.get().ai
  if (ai.provider === 'none') throw new Error('AI processing is off. Pick Claude Code or Codex in Speak → ai, or use the verbatim style.')
  const agent = AGENTS[ai.provider]
  const started = Date.now()
  const result = await agent.complete(system, user, agent.config(), { timeoutMs: Math.max(10, ai.timeoutSeconds) * 1000, signal })
  const text = cleanOutput(result.text)
  if (!text) throw new Error('The AI returned an empty result.')
  const ms = Date.now() - started
  log.info(`AI ${ai.provider}/${result.model} took ${ms}ms`)
  return { text, provider: ai.provider, model: result.model, ms }
}

export function processTranscript(
  transcript: string,
  opts: { inputLanguage: string; style: Style; outputLanguage: string; signal?: AbortSignal }
): Promise<AiResult> {
  const cfg = configStore.get()
  const user = processMessage({
    transcript,
    inputLanguage: opts.inputLanguage,
    style: opts.style,
    outputLanguage: opts.outputLanguage,
    vocabulary: cfg.vocabulary,
    custom: cfg.ai.customInstructions
  })
  return complete(PROCESS_SYSTEM, user, opts.signal)
}

export function editText(text: string, instruction: string, signal?: AbortSignal): Promise<AiResult> {
  const cfg = configStore.get()
  return complete(EDIT_SYSTEM, editMessage({ text, instruction, vocabulary: cfg.vocabulary, custom: cfg.ai.customInstructions }), signal)
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
