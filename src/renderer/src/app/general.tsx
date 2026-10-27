import { useEffect, useState } from 'react'
import { DICTATION_STYLES, STYLES } from '@shared/constants'
import type { AgentStatus, Config, DeepPartial, EngineStatus, MainSection, PasteKeys, PermissionStatus, RecordMode, Style } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, Bar, Check, displayShortcut, formatSize, List, ListRow, Row, Sep, ShortcutInput, TextInput } from '../components/ui'
import { ipcError, sizeMB } from '../lib/format'
import { outputOptions, spokenOptions } from '../lib/languages'
import type { TestVerdict } from '../lib/microphone'
import { useDownloads } from './hooks'
import { InputSettings } from './input-settings'

const api = window.speak
const isMac = api.platform === 'darwin'

interface Props {
  config: Config
  update: (patch: DeepPartial<Config>) => Promise<void>
  onNavigate: (s: MainSection) => void
}

const styleOptions = DICTATION_STYLES.map((s) => ({ value: s.id, label: s.label.toLowerCase() }))

function Setup({ config, update, onNavigate, micVerdict }: Props & { micVerdict: TestVerdict | null }) {
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

  const modelId = config.transcription.engine === 'whisper' ? config.transcription.whisperModel : config.transcription.parakeetModel
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
      action: <Action onClick={() => document.getElementById('input-settings')?.scrollIntoView({ behavior: 'smooth' })}>test</Action>
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
        <Action onClick={() => onNavigate('transcription')}>set up</Action>
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
      <Sep tail={<Action onClick={() => update({ onboarded: true })}>{done ? 'done' : 'hide'}</Action>}>setup</Sep>
      {error && <p className="line error">✗ {error}</p>}
      <List>
        {steps.map((s) => (
          <ListRow key={s.label} hint={s.hint} meta={!s.ok && s.meta} actions={s.ok ? <span className="green">ready</span> : s.action}>
            <span className={s.ok ? 'acc' : 'muted'}>[{s.ok ? 'x' : ' '}]</span> {s.label}
          </ListRow>
        ))}
      </List>
      <p className="note">
        then put your cursor in any text field and press <span className="acc">{displayShortcut(config.shortcuts.record)}</span>: hold it while speaking, or tap
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
  const { config, update } = props
  const [micVerdict, setMicVerdict] = useState<TestVerdict | null>(null)
  const [perm, setPerm] = useState<PermissionStatus | null>(null)
  const [shortcutError, setShortcutError] = useState<string | undefined>()

  useEffect(() => {
    void api.getPermissions().then(setPerm)
    void api.getInfo().then((i) => setShortcutError(i.shortcutError))
  }, [config.shortcuts.record, config.shortcuts.compose])

  return (
    <>
      {!config.onboarded && <Setup {...props} micVerdict={micVerdict} />}

      <section id="input-settings">
        <InputSettings config={config} update={update} onVerdict={setMicVerdict} />
      </section>

      <section>
        <Sep>shortcut</Sep>
        <Row label="dictation" hint="global shortcut, works in any application · click, then press the keys">
          <ShortcutInput value={config.shortcuts.record} onChange={(v) => update({ shortcuts: { record: v } })} />
        </Row>
        {shortcutError && !/compose/.test(shortcutError) && <p className="line error">✗ {shortcutError}</p>}
        <Row
          label="record"
          hint={
            perm && !perm.hookAvailable
              ? 'hold-to-talk needs keyboard access, unavailable here: the shortcut toggles'
              : 'hold the shortcut while speaking, or tap to start and tap again to stop'
          }
        >
          <Dropdown<RecordMode>
            value={config.recordMode}
            onChange={(v) => update({ recordMode: v })}
            options={[
              { value: 'hybrid', label: 'hold or tap' },
              { value: 'hold', label: 'hold' },
              { value: 'toggle', label: 'tap' }
            ]}
          />
        </Row>
        <Row label="cancel" hint="only grabbed while recording or processing · click, then press the key">
          <ShortcutInput value={config.shortcuts.cancel} onChange={(v) => update({ shortcuts: { cancel: v } })} allowBare />
        </Row>
      </section>

      <section>
        <Sep>compose</Sep>
        <Row label="shortcut" hint="say what to write and give the context: the ai writes the email, message or text you ask for · click, then press the keys">
          <ShortcutInput value={config.shortcuts.compose} onChange={(v) => update({ shortcuts: { compose: v } })} />
        </Row>
        {shortcutError && /compose/.test(shortcutError) && <p className="line error">✗ {shortcutError}</p>}
        <Row label="selected text" hint="the text selected when you compose (a message to reply to, a draft to rework) goes to the ai with your instructions">
          <Check checked={config.compose.useSelection} onChange={(v) => update({ compose: { useSelection: v } })} />
        </Row>
      </section>

      <section>
        <Sep>output</Sep>
        <Row label="after dictation" hint="preview: check, edit by voice, copy or insert · paste: insert immediately">
          <Dropdown
            value={config.output.mode}
            onChange={(v) => update({ output: { mode: v } })}
            options={[
              { value: 'preview', label: 'preview' },
              { value: 'paste', label: 'paste' }
            ]}
          />
        </Row>
        <Row label="spoken" hint="the language you speak · setting it explicitly is more accurate than auto-detect">
          <Dropdown
            value={config.language.input}
            onChange={(v) => update({ language: { input: v } })}
            options={spokenOptions(config.transcription.engine, config.language.input)}
          />
        </Row>
        <Row label="output" hint="translate what you say into another language">
          <Dropdown value={config.language.output} onChange={(v) => update({ language: { output: v } })} options={outputOptions} />
        </Row>
        <Row label="style" hint={STYLES.find((s) => s.id === config.style)?.description.toLowerCase()}>
          <Dropdown<Style> value={config.style} onChange={(v) => update({ style: v })} options={styleOptions} />
        </Row>
        <Row block label="vocabulary" hint="names and technical terms you use, one per line or comma separated · improves recognition and spelling">
          <TextInput
            multiline
            rows={3}
            value={config.vocabulary}
            onCommit={(v) => update({ vocabulary: v })}
            placeholder="Claude Code, TypeScript, worktree, T3 Code…"
          />
        </Row>
      </section>

      <section>
        <Sep>insertion</Sep>
        <Row label="paste with" hint="keystroke sent to the target app · terminals on linux often need ctrl+shift+v">
          <Dropdown<PasteKeys>
            value={config.output.pasteKeys}
            onChange={(v) => update({ output: { pasteKeys: v } })}
            options={[
              { value: 'auto', label: isMac ? 'auto (cmd+v)' : 'auto (ctrl+v)' },
              { value: 'ctrl+v', label: 'ctrl+v' },
              { value: 'ctrl+shift+v', label: 'ctrl+shift+v' },
              { value: 'shift+insert', label: 'shift+insert' }
            ]}
          />
        </Row>
        <Row label="restore clipboard" hint="put back what was on the clipboard after pasting · off: the text stays on it, so ctrl+v pastes it again if needed">
          <Check checked={config.output.restoreClipboard} onChange={(v) => update({ output: { restoreClipboard: v } })} />
        </Row>
        {isMac && perm && (
          <Row
            label="accessibility"
            hint="needed to paste into other apps and for hold-to-talk"
            actions={!perm.accessibility && <Action onClick={() => void api.requestPermission('accessibility').then(setPerm)}>grant</Action>}
          >
            {perm.accessibility ? <span className="green">granted</span> : <span className="yellow">not granted</span>}
          </Row>
        )}
        {perm?.wayland && <p className="note">wayland: install wtype or ydotool for auto-paste, and bind a desktop shortcut to `speak --toggle`.</p>}
      </section>

      <section>
        <Sep>recording</Sep>
        <Row label="sounds" hint="short cues when recording starts and stops">
          <Check checked={config.audio.sounds} onChange={(v) => update({ audio: { sounds: v } })} />
        </Row>
        <Row label="indicator" hint="status box at the bottom of the screen while recording and processing">
          <Check checked={config.ui.showOverlay} onChange={(v) => update({ ui: { showOverlay: v } })} />
        </Row>
        <Row label="max length" hint="recording stops automatically after this long">
          <Dropdown
            value={String(config.audio.maxSeconds)}
            onChange={(v) => update({ audio: { maxSeconds: Number(v) } })}
            options={[60, 180, 300, 600, 1200].map((s) => ({ value: String(s), label: `${s / 60} min` }))}
          />
        </Row>
      </section>

      <section>
        <Sep>history & startup</Sep>
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
        <Row label="launch at login" hint="speak runs in the system tray">
          <Check checked={config.ui.launchAtLogin} onChange={(v) => update({ ui: { launchAtLogin: v } })} />
        </Row>
      </section>
    </>
  )
}
