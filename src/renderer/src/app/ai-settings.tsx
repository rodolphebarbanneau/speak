import { useEffect, useState, type ReactNode } from 'react'
import { MODES, shortModel } from '@shared/constants'
import type { AgentId, AgentModel, AgentModels, AiTestResult, Config, DeepPartial, Effort, Mode, ProviderId } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, List, ListRow, Radio, Row, Sep, Spinner, TextInput } from '../components/ui'
import { ipcError } from '../lib/format'
import { useAgentStatus } from './hooks'

const api = window.speak

type Update = (patch: DeepPartial<Config>) => Promise<void>
type AgentState = ReturnType<typeof useAgentStatus>

export const PROVIDERS: Array<{ id: ProviderId; label: string; tag: string; hint: string }> = [
  { id: 'claude-code', label: 'claude code', tag: 'your claude account', hint: 'uses the claude cli installed on this computer, with your own claude account' },
  { id: 'codex', label: 'codex', tag: 'your chatgpt account', hint: 'uses the codex cli installed on this computer, with your own chatgpt / openai account' },
  { id: 'none', label: 'none', tag: 'raw transcript', hint: 'no ai pass: the format switches to verbatim, no translation' }
]

/**
 * Picking a provider. Without an ai, a format that needs one would only warn and give the raw
 * transcript: verbatim instead, and the format it replaced is kept (state.formatBeforeNone). An ai
 * picked again gets that format back, unless the format was changed meanwhile: verbatim chosen
 * on purpose stays.
 */
export function providerPatch(config: Config, id: ProviderId): DeepPartial<Config> {
  const { provider } = config.ai
  const { format } = config.writing
  const before = config.state.formatBeforeNone
  if (id === 'none' && provider !== 'none' && format !== 'verbatim')
    return { ai: { provider: id }, writing: { format: 'verbatim' }, state: { formatBeforeNone: format } }
  if (id !== 'none' && provider === 'none' && before)
    return { ai: { provider: id }, writing: format === 'verbatim' ? { format: before } : {}, state: { formatBeforeNone: '' } }
  return { ai: { provider: id } }
}

/** The providers to pick from; `meta`: what to show for each (the account, or whether it's ready). */
export function ProviderList({ provider, onChoose, meta }: { provider: ProviderId; onChoose: (id: ProviderId) => void; meta: (id: ProviderId) => ReactNode }) {
  return (
    <List>
      {PROVIDERS.map((p) => (
        <ListRow key={p.id} hint={p.hint} meta={meta(p.id)} selected={provider === p.id}>
          <button className="choice" role="radio" aria-checked={provider === p.id} onClick={() => onChoose(p.id)}>
            <Radio on={provider === p.id} /> {p.label}
          </button>
        </ListRow>
      ))}
    </List>
  )
}

export const AGENTS: Record<
  AgentId,
  {
    name: string
    configKey: 'claudeCode' | 'codex'
    /** The vendor's own page: how to install it, and which accounts it works with. */
    install: string
    /** The account it signs in with. */
    account: string
    command: string
    home: string
    /** What matters for each mode's model, and what to pick. */
    hints: Record<Mode, string>
  }
> = {
  'claude-code': {
    name: 'claude code',
    configKey: 'claudeCode',
    install: 'https://claude.com/claude-code',
    account: 'a paid claude plan (pro, max, team…) or a claude console account',
    command: 'claude',
    home: '~/.claude',
    hints: {
      dictate: 'cleans up, translates and edits by voice: speed matters · haiku is fast, and plenty for it',
      compose: 'writes from your briefs: staying faithful matters most · sonnet adds nothing you did not say',
      control: 'sees the screen and acts: reliability matters · sonnet is reliable, opus for long tasks'
    }
  },
  codex: {
    name: 'codex',
    configKey: 'codex',
    install: 'https://developers.openai.com/codex',
    account: 'your chatgpt account, or an openai api key',
    command: 'codex',
    home: '~/.codex',
    hints: {
      dictate: 'cleans up, translates and edits by voice: speed matters · luna is fast, and plenty for it',
      compose: 'writes from your briefs: staying faithful matters most · a larger model embellishes less',
      control: 'sees the screen and acts: reliability matters · a larger model is more reliable'
    }
  }
}

const EFFORTS: Array<{ value: Effort; label: string }> = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' }
]

/** "── claude code ───── [ refresh ]" */
export function AgentHeading({ id, agent }: { id: AgentId; agent: AgentState }) {
  return (
    <Sep
      tail={
        <Action onClick={agent.refresh} disabled={agent.checking}>
          {agent.checking ? 'checking' : 'refresh'}
        </Action>
      }
    >
      {AGENTS[id].name}
    </Sep>
  )
}

/**
 * Where a coding-agent CLI is: installed (from the vendor's page, which says how), then signed in
 * (its own sign-in, in a terminal). Both happen outside Speak: it looks again until they're done.
 * `steps`: numbered, as the guided setup takes them.
 */
export function AgentRows({ id, agent, steps }: { id: AgentId; agent: AgentState; steps?: boolean }) {
  const info = AGENTS[id]
  const { status, watching, watch } = agent
  const [error, setError] = useState<string | null>(null)
  const install = () => {
    api.openExternal(info.install)
    watch()
  }
  const signIn = () => {
    setError(null)
    api.openAgentLogin(id).then(watch, (e: Error) => setError(ipcError(e)))
  }
  const problem = error ?? status?.error ?? agent.error
  return (
    <>
      <Row
        label={steps ? '1 · install' : 'cli'}
        hint={status?.found ? status.path : `${info.name}'s own page says how to install it · speak finds it once it's there`}
        actions={status && !status.found && <Action onClick={install}>install page ↗</Action>}
      >
        {!status ? (
          agent.error ? (
            <span className="red">couldn't check</span>
          ) : (
            <Spinner />
          )
        ) : status.found ? (
          <span>
            <span className="green">installed</span>
            {status.version && <span className="dim"> · {status.version}</span>}
          </span>
        ) : (
          <span>
            <span className="yellow">not installed</span>
            {watching && <span className="dim"> · looking again every few seconds</span>}
          </span>
        )}
      </Row>
      {(steps || status?.found) && (
        <Row
          label={steps ? '2 · sign in' : 'account'}
          hint={`opens a terminal with ${info.name}'s own sign-in: speak never sees or stores your credentials`}
          actions={status?.found && !status.loggedIn && <Action onClick={signIn}>sign in</Action>}
        >
          {!status?.found ? (
            <span className="dim">once it's installed</span>
          ) : status.loggedIn ? (
            <span>
              <span className="green">signed in</span>
              {status.account && <span className="dim"> · {status.account}</span>}
            </span>
          ) : (
            <span>
              <span className="yellow">not signed in</span>
              {watching && <span className="dim"> · waiting for the sign-in</span>}
            </span>
          )}
        </Row>
      )}
      {problem && <p className="under error">✗ {problem}</p>}
    </>
  )
}

/** One coding-agent CLI: its status and sign-in, and where it is. */
function AgentSection({ id, config, update }: { id: AgentId; config: Config; update: Update }) {
  const info = AGENTS[id]
  const cfg = config.ai[info.configKey]
  const agent = useAgentStatus(id, { key: `${cfg.path}|${cfg.home}` })
  const set = (patch: Partial<Config['ai']['claudeCode']>) => update({ ai: { [info.configKey]: patch } })

  return (
    <section>
      <AgentHeading id={id} agent={agent} />
      <AgentRows id={id} agent={agent} />
      <Row label="home path" hint={`${info.command}'s settings and sign-in · another folder (e.g. ${info.home}_work) uses another account`}>
        <TextInput value={cfg.home} onCommit={(v) => set({ home: v.trim() })} placeholder={`auto (${info.home})`} />
      </Row>
      <Row label="cli path" hint={`the ${info.command} program · leave empty to find it automatically`}>
        <TextInput value={cfg.path} onCommit={(v) => set({ path: v.trim() })} placeholder="auto" />
      </Row>
      <p className="note">
        {info.name} works with {info.account}
      </p>
    </section>
  )
}

/** Each mode's model, and the effort: the recommended ones unless the user picks others. */
function ModelsSection({ id, config, update }: { id: AgentId; config: Config; update: Update }) {
  const agent = AGENTS[id]
  const cfg = config.ai[agent.configKey]
  const [catalog, setCatalog] = useState<AgentModels | null>(null)
  useEffect(() => void api.listAgentModels(id).then(setCatalog), [id])
  const set = (patch: DeepPartial<Config['ai']['claudeCode']>) => update({ ai: { [agent.configKey]: patch } })
  // Keep a picked model selectable even if the catalog no longer lists it.
  const withModel = (list: AgentModel[], model: string) => (!model || list.some((m) => m.id === model) ? list : [{ id: model, label: model }, ...list])
  // First, the recommended one (''), named: what the mode runs on unless another is picked.
  const options = (mode: Mode) => [
    { value: '', label: catalog ? `recommended · ${catalog.recommended[mode]}` : 'recommended' },
    ...withModel(catalog?.models ?? [], cfg.models[mode]).map((m) => ({ value: m.id, label: m.label }))
  ]

  return (
    <section>
      <Sep>models</Sep>
      {MODES.map((m) => (
        <Row key={m.id} label={m.id} hint={agent.hints[m.id]}>
          <Dropdown value={cfg.models[m.id]} onChange={(model) => set({ models: { [m.id]: model } })} options={options(m.id)} />
        </Row>
      ))}
      <Row label="effort" hint="how much it thinks, in every mode · medium is a good balance · low is faster">
        <Dropdown<Effort> value={cfg.effort} onChange={(effort) => set({ effort })} options={EFFORTS} />
      </Row>
    </section>
  )
}

/**
 * Runs a french sample through the provider and translates it to english: the ai pass a dictation
 * gets. Key it by provider, so that another provider starts with no result.
 */
export function AiTest({ label = 'test', disabled }: { label?: string; disabled?: boolean }) {
  const [test, setTest] = useState<AiTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const runTest = () => {
    setTesting(true)
    setTest(null)
    void api
      .testAi()
      .then(setTest)
      .finally(() => setTesting(false))
  }

  return (
    <>
      <Row
        label={label}
        hint="runs a french sample through the provider and translates it to english"
        actions={
          <Action onClick={runTest} disabled={testing || disabled}>
            {testing ? 'testing' : test ? 'test again' : 'test'}
          </Action>
        }
      >
        {testing ? (
          <span>
            <Spinner /> <span className="dim">processing a french sample…</span>
          </span>
        ) : test?.ok ? (
          <span>
            <span className="green">✓ ok</span>
            <span className="dim">
              {' '}
              · {shortModel(test.model ?? '')} · {((test.ms ?? 0) / 1000).toFixed(1)}s
            </span>
          </span>
        ) : test ? (
          <span className="red">✗ failed</span>
        ) : (
          <span className="dim">fr → en sample</span>
        )}
      </Row>
      {test?.ok && <p className="under hi selectable">{test.text}</p>}
      {test && !test.ok && <p className="under error selectable">{test.error}</p>}
    </>
  )
}

export function AiSettings({ config, update }: { config: Config; update: Update }) {
  const provider = config.ai.provider

  return (
    <>
      <section>
        <Sep>provider</Sep>
        <ProviderList provider={provider} onChoose={(id) => update(providerPatch(config, id))} meta={(id) => PROVIDERS.find((p) => p.id === id)?.tag} />
        <p className="note">only the transcript text is sent, never audio.</p>
      </section>

      {provider !== 'none' && <AgentSection key={provider} id={provider} config={config} update={update} />}
      {provider !== 'none' && <ModelsSection key={`${provider}-models`} id={provider} config={config} update={update} />}

      {provider !== 'none' && (
        <section>
          <Sep>instructions</Sep>
          <Row block label="custom" hint='added to every request, e.g. "use british spelling" or "i mostly dictate prompts for a coding agent"'>
            <TextInput multiline rows={3} value={config.ai.instructions} onCommit={(v) => update({ ai: { instructions: v } })} placeholder="optional" />
          </Row>
          <Row label="timeout" hint="give up on the ai pass after this long (the raw transcript is kept)">
            <Dropdown
              value={String(config.ai.timeoutSeconds)}
              onChange={(v) => update({ ai: { timeoutSeconds: Number(v) } })}
              options={[30, 60, 90, 180].map((s) => ({ value: String(s), label: `${s}s` }))}
            />
          </Row>
          <AiTest key={provider} />
        </section>
      )}
    </>
  )
}
