import { useEffect, useState } from 'react'
import { shortModel } from '@shared/constants'
import type { AgentId, AgentModel, AgentStatus, AiTestResult, Config, DeepPartial, Effort, ProviderId } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, List, ListRow, Radio, Row, Sep, Spinner, TextInput } from '../components/ui'

const api = window.speak

type Update = (patch: DeepPartial<Config>) => Promise<void>

const PROVIDERS: Array<{ id: ProviderId; label: string; tag: string; hint: string }> = [
  { id: 'claude-code', label: 'claude code', tag: 'your claude account', hint: 'uses the claude cli installed on this computer, with your own claude account' },
  { id: 'codex', label: 'codex', tag: 'your chatgpt account', hint: 'uses the codex cli installed on this computer, with your own chatgpt / openai account' },
  { id: 'none', label: 'none', tag: 'raw transcript', hint: 'no ai pass: verbatim style only, no translation' }
]

const AGENTS: Record<AgentId, { name: string; configKey: 'claudeCode' | 'codex'; install: string; command: string; modelHint: string }> = {
  'claude-code': {
    name: 'claude code',
    configKey: 'claudeCode',
    install: 'https://claude.com/claude-code',
    command: 'claude',
    modelHint: 'haiku is fast and cheap, and plenty for dictation · opus gives the best rewrites'
  },
  codex: {
    name: 'codex',
    configKey: 'codex',
    install: 'https://developers.openai.com/codex',
    command: 'codex',
    modelHint: 'luna is fast and cheap, and plenty for dictation · sol gives the best rewrites'
  }
}

const EFFORTS: Array<{ value: Effort; label: string }> = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' }
]

/** Status, sign-in, model and effort for one coding-agent CLI. */
function AgentSection({ id, config, update }: { id: AgentId; config: Config; update: Update }) {
  const agent = AGENTS[id]
  const cfg = config.ai[agent.configKey]
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [models, setModels] = useState<AgentModel[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = (force = true) => {
    setLoading(true)
    void api
      .getAgentStatus(id, force)
      .then(setStatus)
      .finally(() => setLoading(false))
  }
  useEffect(() => refresh(false), [id, cfg.path]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void api.listAgentModels(id).then(setModels), [id])

  const set = (patch: Partial<Config['ai']['claudeCode']>) => update({ ai: { [agent.configKey]: patch } })
  // Keep the configured model selectable even if the catalog doesn't list it.
  const modelOptions = (models.some((m) => m.id === cfg.model) ? models : [{ id: cfg.model, label: cfg.model }, ...models]).map((m) => ({
    value: m.id,
    label: m.label
  }))

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
      {status?.error && status.found && <p className="under error">✗ {status.error}</p>}
      <Row label="model" hint={agent.modelHint}>
        <Dropdown value={cfg.model} onChange={(model) => set({ model })} options={modelOptions} disabled={!modelOptions.length} />
      </Row>
      <Row label="effort" hint="medium is a good balance · low is faster">
        <Dropdown<Effort> value={cfg.effort} onChange={(effort) => set({ effort })} options={EFFORTS} />
      </Row>
      <Row label="cli path" hint={`leave empty to find ${agent.command} automatically`}>
        <TextInput value={cfg.path} onCommit={(v) => set({ path: v.trim() })} placeholder="auto" />
      </Row>
      <p className="note">
        runs your unmodified {agent.command} non-interactively, with no tools, no plugins and no project settings. usage counts toward your plan limits.
      </p>
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

      {provider !== 'none' && (
        <section>
          <Sep>instructions</Sep>
          <Row block label="custom" hint='added to every request, e.g. "use british spelling" or "i mostly dictate prompts for a coding agent"'>
            <TextInput
              multiline
              rows={3}
              value={config.ai.customInstructions}
              onCommit={(v) => update({ ai: { customInstructions: v } })}
              placeholder="optional"
            />
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
