import { useEffect, useState } from 'react'
import { MODES, shortModel } from '@shared/constants'
import type { AgentId, AgentModel, AgentModels, AgentStatus, AiTestResult, Config, DeepPartial, Effort, Mode, ProviderId } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, List, ListRow, Radio, Row, Sep, Spinner, TextInput } from '../components/ui'

const api = window.speak

type Update = (patch: DeepPartial<Config>) => Promise<void>

const PROVIDERS: Array<{ id: ProviderId; label: string; tag: string; hint: string }> = [
  { id: 'claude-code', label: 'claude code', tag: 'your claude account', hint: 'uses the claude cli installed on this computer, with your own claude account' },
  { id: 'codex', label: 'codex', tag: 'your chatgpt account', hint: 'uses the codex cli installed on this computer, with your own chatgpt / openai account' },
  { id: 'none', label: 'none', tag: 'raw transcript', hint: 'no ai pass: verbatim style only, no translation' }
]

const AGENTS: Record<
  AgentId,
  {
    name: string
    configKey: 'claudeCode' | 'codex'
    install: string
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

/** One coding-agent CLI: its status and sign-in, and where it is. */
function AgentSection({ id, config, update }: { id: AgentId; config: Config; update: Update }) {
  const agent = AGENTS[id]
  const cfg = config.ai[agent.configKey]
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = (force = true) => {
    setLoading(true)
    void api
      .getAgentStatus(id, force)
      .then(setStatus)
      .finally(() => setLoading(false))
  }
  useEffect(() => refresh(false), [id, cfg.path, cfg.home]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Config['ai']['claudeCode']>) => update({ ai: { [agent.configKey]: patch } })

  return (
    <section>
      <Sep
        tail={
          <Action onClick={() => refresh()} disabled={loading}>
            {loading ? 'checking' : 'refresh'}
          </Action>
        }
      >
        {agent.name}
      </Sep>
      <Row label="cli" hint={status?.path} actions={status && !status.found && <Action onClick={() => api.openExternal(agent.install)}>install</Action>}>
        {!status ? (
          <Spinner />
        ) : status.found ? (
          <span>
            <span className="green">found</span> <span className="dim">· {status.version}</span>
          </span>
        ) : (
          <span className="yellow">not found</span>
        )}
      </Row>
      {status?.found && (
        <Row
          label="account"
          hint={`sign-in happens in ${agent.name} itself: speak never sees or stores your credentials`}
          actions={!status.loggedIn && <Action onClick={() => void api.openAgentLogin(id).then(() => setTimeout(() => refresh(), 1500))}>sign in</Action>}
        >
          {status.loggedIn ? (
            <span>
              <span className="green">signed in</span>
              {status.account && <span className="dim"> · {status.account}</span>}
            </span>
          ) : (
            <span className="yellow">not signed in</span>
          )}
        </Row>
      )}
      {status?.error && <p className="under error">✗ {status.error}</p>}
      <Row label="home path" hint={`${agent.command}'s settings and sign-in · another folder (e.g. ${agent.home}_work) uses another account`}>
        <TextInput value={cfg.home} onCommit={(v) => set({ home: v.trim() })} placeholder={`auto (${agent.home})`} />
      </Row>
      <Row label="cli path" hint={`the ${agent.command} program · leave empty to find it automatically`}>
        <TextInput value={cfg.path} onCommit={(v) => set({ path: v.trim() })} placeholder="auto" />
      </Row>
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

export function AiSettings({ config, update }: { config: Config; update: Update }) {
  const [test, setTest] = useState<AiTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const provider = config.ai.provider

  useEffect(() => setTest(null), [provider])

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
      <section>
        <Sep>provider</Sep>
        <List>
          {PROVIDERS.map((p) => (
            <ListRow key={p.id} hint={p.hint} meta={p.tag} selected={provider === p.id}>
              <button className="choice" role="radio" aria-checked={provider === p.id} onClick={() => update({ ai: { provider: p.id } })}>
                <Radio on={provider === p.id} /> {p.label}
              </button>
            </ListRow>
          ))}
        </List>
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
          <Row
            label="test"
            hint="runs a french sample through the provider and translates it to english"
            actions={
              <Action onClick={runTest} disabled={testing}>
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
        </section>
      )}
    </>
  )
}
