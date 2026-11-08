import { useEffect, useState } from 'react'
import { firstShortcut, modesOn } from '@shared/constants'
import type { AgentStatus, Config, DeepPartial, EngineStatus, MainSection, Mode, PermissionStatus, RecordMode } from '@shared/types'
import { SCHEDULE } from '@themes/schedule'
import { Dropdown } from '../components/dropdown'
import { Action, Bar, Check, displayShortcut, formatSize, List, ListRow, Row, Sep, ShortcutInput } from '../components/ui'
import { ipcError, sizeMB } from '../lib/format'
import type { TestVerdict } from '../lib/microphone'
import { useDownloads } from './hooks'

const api = window.speak

/** The modes, as the settings show them: what each does. */
const MODE_ROWS: Array<{ id: Mode; hint: string }> = [
  { id: 'dictate', hint: 'writes what you say, where your cursor is, in any application · see settings → writing' },
  { id: 'compose', hint: 'say what to write: the ai writes the email, message or text you ask for · see settings → writing' },
  { id: 'control', hint: 'say what to do: the ai does it on the computer · see settings → control' }
]

/** The holidays with a theme, as the schedule lists them: "halloween, christmas and the new year". */
const HOLIDAY_NAMES = SCHEDULE.map((e) => e.name)
const HOLIDAYS = HOLIDAY_NAMES.length > 1 ? `${HOLIDAY_NAMES.slice(0, -1).join(', ')} and ${HOLIDAY_NAMES[HOLIDAY_NAMES.length - 1]}` : HOLIDAY_NAMES.join('')

interface Props {
  config: Config
  update: (patch: DeepPartial<Config>) => Promise<void>
  onNavigate: (s: MainSection) => void
  /** The outcome of the microphone test on speech, while the settings are open. */
  micVerdict: TestVerdict | null
}

function Setup({ config, update, onNavigate, micVerdict }: Props) {
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [agent, setAgent] = useState<AgentStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const downloads = useDownloads()
  useEffect(() => {
    void api.getEngineStatus().then(setEngine)
    if (config.ai.provider !== 'none') void api.getAgentStatus(config.ai.provider).then(setAgent)
    return api.onDownload((p) => {
      if (p.state === 'done') void api.getEngineStatus().then(setEngine)
    })
  }, [config.ai.provider])

  const modelId = config.speech.models[config.speech.engine]
  const model = engine?.models.find((m) => m.id === modelId)
  const engineOk = !!engine?.binary.found
  const build = engine?.binaryOptions.find((o) => o.variant === engine.recommendedVariant)

  // Speech recognition = the engine + the selected model: one step, installed together.
  const pending = ['binary', 'model:vad', `model:${modelId}`].map((id) => downloads[id]).filter((d) => d && d.state !== 'error')
  const received = pending.reduce((n, d) => n + d.received, 0)
  const total = pending.reduce((n, d) => n + d.total, 0)
  const extracting = pending.some((d) => d.state === 'extracting')
  const installSize = (engineOk ? 0 : (build?.sizeMB ?? 0)) + (model?.installed ? 0 : (model?.sizeMB ?? 0))
  const installSpeech = () => {
    setError(null)
    api
      .installModel(modelId)
      .catch((e: Error) => !/cancel/i.test(e.message) && setError(ipcError(e)))
      .finally(() => void api.getEngineStatus().then(setEngine))
  }

  const aiOk = config.ai.provider === 'none' || !!agent?.loggedIn
  const steps = [
    {
      ok: micVerdict === 'ok',
      label: 'microphone',
      meta: 'test your input',
      hint: 'the default device may be a silent virtual one',
      action: <Action onClick={() => onNavigate('speech')}>test</Action>
    },
    {
      ok: engineOk && !!model?.installed,
      label: 'speech recognition',
      meta: pending.length ? <Bar value={received} total={total} label={extracting ? 'installing the engine…' : undefined} /> : sizeMB(installSize),
      hint: `whisper.cpp${engine?.binary.found ? '' : build ? ` (${build.label.toLowerCase()})` : ''} + ${model?.label.toLowerCase() ?? 'a speech model'}, running on this computer`,
      // Without a downloadable engine build (e.g. macOS dev runs), the speech page explains the options.
      action: pending.length ? null : engineOk || build ? (
        <Action onClick={installSpeech}>install</Action>
      ) : (
        <Action onClick={() => onNavigate('speech')}>set up</Action>
      )
    },
    {
      ok: aiOk,
      label: 'ai provider',
      meta: 'claude code or codex',
      hint: 'cleanup & translation, with your own claude code or codex login',
      action: <Action onClick={() => onNavigate('ai')}>set up</Action>
    }
  ]
  const done = steps.every((s) => s.ok)

  return (
    <section>
      <Sep tail={<Action onClick={() => update({ state: { onboarded: true } })}>{done ? 'done' : 'hide'}</Action>}>setup</Sep>
      {error && <p className="line error">✗ {error}</p>}
      <List>
        {steps.map((s) => (
          <ListRow key={s.label} hint={s.hint} meta={!s.ok && s.meta} actions={s.ok ? <span className="green">ready</span> : s.action}>
            <span className={s.ok ? 'acc' : 'muted'}>[{s.ok ? 'x' : ' '}]</span> {s.label}
          </ListRow>
        ))}
      </List>
      <p className="note">
        then put your cursor in any text field and press <span className="acc">{displayShortcut(firstShortcut(config))}</span>: hold it while speaking, or tap
        to start and tap again to stop.
      </p>
    </section>
  )
}

/** stored   312 dictations · 1.2 GB   [ delete all ] (asks for confirmation first) */
function StoredRow() {
  const [stats, setStats] = useState<{ count: number; bytes: number } | null>(null)
  useEffect(() => {
    const load = () => void api.historyStats().then(setStats)
    load()
    return api.onHistoryChanged(load)
  }, [])
  const count = stats?.count ?? 0
  return (
    <Row
      label="stored"
      hint="dictations and their recordings in ~/.speak/history · settings and speech models are not affected"
      actions={
        <Action danger disabled={!count} onClick={() => void api.clearHistory()}>
          delete all
        </Action>
      }
    >
      {stats && (
        <span>
          {count} {count === 1 ? 'dictation' : 'dictations'} <span className="dim">· {formatSize(stats.bytes)}</span>
        </span>
      )}
    </Row>
  )
}

export function General(props: Props) {
  const { config, update, micVerdict } = props
  const [perm, setPerm] = useState<PermissionStatus | null>(null)
  const [shortcutError, setShortcutError] = useState<string | undefined>()

  useEffect(() => {
    void api.getPermissions().then(setPerm)
    void api.getInfo().then((i) => setShortcutError(i.shortcutError))
  }, [config.modes])

  return (
    <>
      {!config.state.onboarded && <Setup {...props} micVerdict={micVerdict} />}

      <section>
        <Sep>modes</Sep>
        {MODE_ROWS.map(({ id, hint }) => {
          const { on, shortcut } = config.modes[id]
          // Speak needs one: the last mode on stays on.
          const last = on && modesOn(config).length === 1
          return (
            <Row
              key={id}
              label={id}
              hint={
                last
                  ? `${hint} · the last mode on: speak needs one`
                  : on
                    ? `${hint} · click the shortcut, then press the keys`
                    : `off: ${hint} · its shortcut is free for other apps, and it isn't offered on the pill or the tray`
              }
            >
              <Check checked={on} disabled={last} onChange={(v) => update({ modes: { [id]: { on: v } } })}>
                {on ? 'on' : 'off'}
              </Check>
              <ShortcutInput value={shortcut} disabled={!on} onChange={(v) => update({ modes: { [id]: { shortcut: v } } })} />
            </Row>
          )
        })}
        {shortcutError && <p className="line error">✗ {shortcutError}</p>}
      </section>

      <section>
        <Sep>recording</Sep>
        <Row
          label="shortcuts"
          hint={
            perm && !perm.hookAvailable
              ? 'hold-to-talk needs keyboard access, unavailable here: the shortcut toggles'
              : 'hold the shortcut while speaking, or tap to start and tap again to stop'
          }
        >
          <Dropdown<RecordMode>
            value={config.recording.press}
            onChange={(v) => update({ recording: { press: v } })}
            options={[
              { value: 'hybrid', label: 'hold or tap' },
              { value: 'hold', label: 'hold' },
              { value: 'toggle', label: 'tap' }
            ]}
          />
        </Row>
        <Row label="cancel" hint="only grabbed while recording or processing · click, then press the key">
          <ShortcutInput value={config.recording.cancel} onChange={(v) => update({ recording: { cancel: v } })} allowBare />
        </Row>
        <Row label="max length" hint="recording stops automatically after this long">
          <Dropdown
            value={String(config.recording.maxSeconds)}
            onChange={(v) => update({ recording: { maxSeconds: Number(v) } })}
            options={[60, 180, 300, 600, 1200].map((s) => ({ value: String(s), label: `${s / 60} min` }))}
          />
        </Row>
        <Row label="sounds" hint="short cues when recording starts and stops">
          <Check checked={config.recording.sounds} onChange={(v) => update({ recording: { sounds: v } })} />
        </Row>
        <Row label="indicator" hint="the pill at the bottom of the screen while recording and processing">
          <Check checked={config.recording.indicator} onChange={(v) => update({ recording: { indicator: v } })} />
        </Row>
      </section>

      <section>
        <Sep>app</Sep>
        <Row label="launch at login" hint="speak runs in the system tray">
          <Check checked={config.app.launchAtLogin} onChange={(v) => update({ app: { launchAtLogin: v } })} />
        </Row>
        <Row label="easter eggs" hint={`a seasonal look around ${HOLIDAYS} · click its logo, top left, to turn it off · off: never shown`}>
          <Check checked={config.app.easterEggs} onChange={(v) => update({ app: { easterEggs: v } })} />
        </Row>
      </section>

      <section>
        <Sep>history</Sep>
        <Row label="keep history" hint="transcripts are saved in ~/.speak/history">
          <Check checked={config.history.enabled} onChange={(v) => update({ history: { enabled: v } })} />
        </Row>
        <Row label="keep audio" hint="save the recording next to each transcript">
          <Check checked={config.history.keepAudio} onChange={(v) => update({ history: { keepAudio: v } })} />
        </Row>
        <Row label="delete after" hint="older dictations are removed automatically">
          <Dropdown
            value={String(config.history.retentionDays)}
            onChange={(v) => update({ history: { retentionDays: Number(v) } })}
            options={[7, 30, 90, 365, 0].map((d) => ({ value: String(d), label: d ? `${d} days` : 'never' }))}
          />
        </Row>
        <StoredRow />
      </section>
    </>
  )
}
