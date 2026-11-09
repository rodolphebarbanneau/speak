import { useEffect, useRef, useState, type ReactNode } from 'react'
import { firstShortcut, MODES, modesOn } from '@shared/constants'
import type { AgentId, Config, DeepPartial, PermissionKind, PermissionStatus, ProviderId, Session } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, Bar, displayShortcut, Key, MOD, percent, Row, Sep, Spinner, useHelpLine } from '../components/ui'
import { sizeMB } from '../lib/format'
import { spokenOptions } from '../lib/languages'
import type { TestVerdict } from '../lib/microphone'
import { AGENTS, AgentHeading, AgentRows, AiTest, ProviderList, providerPatch } from './ai-settings'
import { agentReady, useAgentStatus, useSpeechSetup } from './hooks'
import { InputSettings } from './input-settings'
import type { SettingsSection } from './settings'

const api = window.speak
const isMac = api.platform === 'darwin'

/**
 * The guided setup: a dialog over the window, opened by itself on the first launch (main/app.tsx),
 * and from history's "set up speak" or settings → general after that. Each step does its job in
 * place: the speech download (started first: it's the longest, and goes on during the other
 * steps), the microphone, the ai with its install and sign-in, macOS's permissions, and a first
 * dictation. Steps can be taken in any order. Esc closes it for now; "skip setup" and "finish" for
 * good (state.onboarded).
 */

type StepId = 'speech' | 'microphone' | 'ai' | 'access' | 'try'

/** The provider is picked for the user at most once per run of Speak (see SetupDialog). */
let autoPicked = false
type Agents = Record<AgentId, ReturnType<typeof useAgentStatus>>
type Update = (patch: DeepPartial<Config>) => Promise<void>

interface Props {
  config: Config
  update: Update
  onClose: () => void
  /** A settings page, over the setup: it waits behind. */
  onSettings: (section: SettingsSection) => void
}

export function SetupDialog({ config, update, onClose, onSettings }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<StepId>('speech')
  const [micVerdict, setMicVerdict] = useState<TestVerdict | null>(null)
  const [perm, setPerm] = useState<PermissionStatus | null>(null)
  const [heard, setHeard] = useState<Session | null>(null)
  /** Something was pasted into the try-it box: with the history off, the only sign a dictation came. */
  const [pasted, setPasted] = useState(false)
  const provider = config.ai.provider
  // A row's help on the status line belongs to its step.
  const setHelp = useHelpLine()
  useEffect(() => setHelp(''), [step, setHelp])

  const speech = useSpeechSetup(config)
  // Both at once: the one that's ready is picked. The one picked is watched while its step is open.
  const agents: Agents = {
    'claude-code': useAgentStatus('claude-code', {
      key: `${config.ai.claudeCode.path}|${config.ai.claudeCode.home}`,
      poll: step === 'ai' && provider === 'claude-code'
    }),
    codex: useAgentStatus('codex', { key: `${config.ai.codex.path}|${config.ai.codex.home}`, poll: step === 'ai' && provider === 'codex' })
  }

  // The keys are the dialog's; the focus goes back where it was after.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    box.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  // macOS's permissions change in System Settings: look again while their step is open.
  useEffect(() => {
    const look = () => void api.getPermissions().then(setPerm)
    look()
    if (step !== 'access') return
    const timer = setInterval(look, 2000)
    window.addEventListener('focus', look)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', look)
    }
  }, [step])

  // A dictation since the setup opened, from any step: it works.
  useEffect(() => {
    const since = Date.now()
    return api.onHistoryChanged(
      () =>
        void api.listSessions(undefined, 1).then(([s]) => {
          if (s && !s.control && Date.parse(s.createdAt) >= since) setHeard(s)
        })
    )
  }, [])

  // Claude Code is the default: when it isn't installed at all and Codex is, Codex instead. Only
  // away from the default (one installed but not signed in yet may be the one someone chose), only
  // before the setup was ever finished or skipped, and once per run: the setup closed with "later"
  // and opened again leaves the provider alone.
  const claude = agents['claude-code'].status
  const codex = agents.codex.status
  useEffect(() => {
    if (autoPicked || config.state.onboarded || !claude || !codex) return
    autoPicked = true
    if (provider === 'claude-code' && !claude.found && codex.found) void update({ ai: { provider: 'codex' } })
  }, [claude, codex]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (id: ProviderId) => void update(providerPatch(config, id))

  // The download goes on during the other steps: they show how far it is, or that it failed.
  const steps: Array<{ id: StepId; label: string; done: boolean; meta?: ReactNode }> = [
    {
      id: 'speech',
      label: 'speech',
      done: speech.ready,
      meta:
        speech.downloading && speech.total ? (
          <span className="dim">{percent(speech.received / speech.total).trim()}</span>
        ) : speech.error && !speech.ready ? (
          <span className="red">failed</span>
        ) : undefined
    },
    { id: 'microphone', label: 'microphone', done: micVerdict === 'ok' },
    { id: 'ai', label: 'ai', done: provider === 'none' || agentReady(agents[provider].status) },
    ...(isMac
      ? [
          {
            id: 'access' as const,
            label: 'access',
            // Screen Recording is for control mode only.
            done: !!perm && perm.microphone === 'granted' && !!perm.accessibility && (!config.modes.control.on || perm.screen === 'granted')
          }
        ]
      : []),
    { id: 'try', label: 'try it', done: !!heard || pasted }
  ]
  const index = steps.findIndex((s) => s.id === step)
  const last = index === steps.length - 1
  const ready = steps.filter((s) => s.done).length

  const finish = () => {
    void update({ state: { onboarded: true } })
    onClose()
  }
  const next = () => (last ? finish() : setStep(steps[index + 1].id))
  // On the first step, the speech download starts as it's left: it goes on during the others.
  const startDownload = step === 'speech' && !!speech.engine && !speech.ready && !speech.downloading && speech.canInstall
  const primary = () => {
    if (startDownload) speech.install()
    next()
  }

  // mod+enter: the step's main key (enter alone writes a new line in the try-it box); esc: later.
  // Only when it's in front: settings or the bug report can open over it. A key it takes is marked
  // (preventDefault), so the bug report behind it leaves that key alone.
  const onKeyDown = (e: KeyboardEvent) => {
    const dialogs = document.querySelectorAll('[role="dialog"]')
    if (e.defaultPrevented || dialogs[dialogs.length - 1] !== box.current) return
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      primary()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  return (
    <div className="dialog-backdrop">
      <div ref={box} className="dialog setup" role="dialog" aria-modal="true" aria-label="set up speak" tabIndex={-1}>
        <div className="setup-body">
          <nav className="nav">
            {steps.map((s) => (
              <button key={s.id} className={step === s.id ? 'on' : ''} onClick={() => setStep(s.id)}>
                <span className={s.done ? 'acc' : 'muted'}>[{s.done ? 'x' : ' '}]</span> {s.label}
                {s.meta && <> {s.meta}</>}
              </button>
            ))}
            <span className="nav-foot dim">
              {ready} of {steps.length} ready
            </span>
          </nav>
          {/* A page of its own each time: it opens at the top. */}
          <div className="page" key={step}>
            <div className="page-inner">
              {step === 'speech' && <SpeechStep speech={speech} onSettings={onSettings} />}
              {step === 'microphone' && <MicrophoneStep config={config} update={update} onVerdict={setMicVerdict} />}
              {step === 'ai' && <AiStep provider={provider} agents={agents} onChoose={choose} />}
              {step === 'access' && perm && <AccessStep perm={perm} onPerm={setPerm} control={config.modes.control.on} />}
              {step === 'try' && <TryStep config={config} perm={perm} heard={heard} pasted={pasted} onPaste={() => setPasted(true)} onSettings={onSettings} />}
            </div>
          </div>
        </div>

        <div className="keys-bar">
          <Key k={`${MOD}+enter`} primary onClick={primary}>
            {last ? 'finish' : startDownload ? 'download & continue' : 'next'}
          </Key>
          {index > 0 && <Action onClick={() => setStep(steps[index - 1].id)}>back</Action>}
          <span className="keys-gap" />
          {!last && <Action onClick={finish}>skip setup</Action>}
          <Key k="esc" onClick={onClose} title="close for now: it opens again from history, or settings → general">
            later
          </Key>
        </div>
      </div>
    </div>
  )
}

/** Speech recognition: whisper.cpp and a model, on this computer. */
function SpeechStep({ speech, onSettings }: { speech: ReturnType<typeof useSpeechSetup>; onSettings: (s: SettingsSection) => void }) {
  const { engine, model, build } = speech
  if (!engine) return <Spinner />
  return (
    <section>
      <Sep>speech recognition</Sep>
      <p className="block-text">
        speak turns your voice into text on this computer: what you say is never sent online. it needs a speech engine and a model, downloaded once
        {speech.installSize ? <span className="hi"> ({sizeMB(speech.installSize)})</span> : ''}.
      </p>
      <Row label="engine" hint={engine.binary.dir ?? 'whisper.cpp, the speech engine, built for this computer'}>
        {speech.engineOk ? (
          <span>
            <span className="green">installed</span>
            <span className="dim"> · whisper.cpp{engine.binary.variant ? ` · ${engine.binary.variant}` : ''}</span>
          </span>
        ) : build ? (
          <span>
            <span className="yellow">to download</span>
            <span className="dim">
              {' '}
              · whisper.cpp · {build.label.toLowerCase()} · {sizeMB(build.sizeMB)}
            </span>
          </span>
        ) : (
          <span className="yellow">not installed</span>
        )}
      </Row>
      <Row label="model" hint={model?.note?.toLowerCase() ?? 'what the engine recognizes speech with'}>
        {model?.installed ? (
          <span>
            <span className="green">installed</span> <span className="dim">· {model.label.toLowerCase()}</span>
          </span>
        ) : (
          <span>
            <span className="yellow">to download</span>
            {model && (
              <span className="dim">
                {' '}
                · {model.label.toLowerCase()} · {sizeMB(model.sizeMB)}
              </span>
            )}
          </span>
        )}
      </Row>
      {speech.downloading && (
        <Row label="download" hint="it goes on while you set up the rest" actions={<Action onClick={speech.cancel}>cancel</Action>}>
          <Bar value={speech.received} total={speech.total} label={speech.extracting ? 'installing the engine…' : undefined} />
        </Row>
      )}
      {!speech.ready && !speech.downloading && speech.canInstall && (
        <Row
          label="download"
          hint="or with the key at the bottom: it downloads while you set up the rest"
          actions={<Action onClick={speech.install}>download</Action>}
        >
          <span className="dim">not started</span>
        </Row>
      )}
      {speech.error && <p className="line error">✗ {speech.error}</p>}
      {!speech.canInstall && engine.platformNote && <p className="note">{engine.platformNote.toLowerCase()}</p>}
      <p className="note">
        {speech.ready ? 'ready · ' : speech.downloading ? 'downloading in the background · ' : ''}other models, a smaller download or the gpu:{' '}
        <Action onClick={() => onSettings('speech')}>settings → speech</Action>
      </p>
    </section>
  )
}

/** The microphone and its test, then the language spoken. */
function MicrophoneStep({ config, update, onVerdict }: { config: Config; update: Update; onVerdict: (v: TestVerdict) => void }) {
  return (
    <>
      <section>
        <InputSettings config={config} update={update} onVerdict={onVerdict} />
        <p className="note">test it: the default device may be a silent virtual one (voicemod, voicemeeter…), and the test tells.</p>
      </section>
      <section>
        <Sep>language</Sep>
        <Row label="spoken" hint="the language you speak, in every mode · picking it is more accurate than auto-detect">
          <Dropdown
            value={config.speech.language}
            onChange={(v) => update({ speech: { language: v } })}
            options={spokenOptions(config.speech.engine, config.speech.language)}
          />
        </Row>
      </section>
    </>
  )
}

/** The ai: claude code, codex or none, then the one picked: installed, signed in, tested. */
function AiStep({ provider, agents, onChoose }: { provider: ProviderId; agents: Agents; onChoose: (id: ProviderId) => void }) {
  const state = (id: ProviderId) => {
    if (id === 'none') return <span className="dim">text as spoken</span>
    const s = agents[id].status
    if (!s) return agents[id].error ? <span className="red">couldn't check</span> : <Spinner />
    if (agentReady(s)) return <span className="green">ready</span>
    return s.found ? <span className="yellow">not signed in</span> : <span className="dim">not installed</span>
  }
  return (
    <>
      <section>
        <Sep>ai</Sep>
        <p className="block-text">
          an ai tidies up what you say (the "um"s, false starts and corrections) and can translate it. speak uses claude code or codex on this computer, with
          your own account: only the text goes to it, never your voice.
        </p>
        <ProviderList provider={provider} onChoose={onChoose} meta={state} />
      </section>
      {provider === 'none' ? (
        <section>
          <p className="note">
            dictations come out word for word, as the speech engine heard them: no clean-up and no translation, and compose and control (which need an ai) don't
            work. the format is set to verbatim · add an ai any time in settings → ai.
          </p>
        </section>
      ) : (
        <AgentSetup key={provider} id={provider} agent={agents[provider]} />
      )}
    </>
  )
}

/** Install (the vendor's page), sign in (its own sign-in, in a terminal), test. */
function AgentSetup({ id, agent }: { id: AgentId; agent: Agents[AgentId] }) {
  return (
    <section>
      <AgentHeading id={id} agent={agent} />
      <AgentRows id={id} agent={agent} steps />
      <AiTest label="3 · test" disabled={!agentReady(agent.status)} />
      <p className="note">
        {AGENTS[id].name} works with {AGENTS[id].account}
      </p>
    </section>
  )
}

/** macOS: the microphone, accessibility (to paste, and for hold-to-talk), and screen recording (for control mode). */
function AccessStep({ perm, onPerm, control }: { perm: PermissionStatus; onPerm: (p: PermissionStatus) => void; control: boolean }) {
  const ask = (kind: PermissionKind) => void api.requestPermission(kind).then(onPerm)
  const micDenied = perm.microphone === 'denied' || perm.microphone === 'restricted'
  return (
    <section>
      <Sep>access</Sep>
      <p className="block-text">macos asks you once before an app can use the microphone, or type into other apps.</p>
      <Row
        label="microphone"
        hint={micDenied ? 'turned off: turn speak on in system settings → privacy & security → microphone' : 'to hear you'}
        actions={perm.microphone !== 'granted' && !micDenied && <Action onClick={() => ask('microphone')}>allow</Action>}
      >
        {perm.microphone === 'granted' ? (
          <span className="green">allowed</span>
        ) : (
          <span className="yellow">{micDenied ? 'turned off' : 'not allowed yet'}</span>
        )}
      </Row>
      <Row
        label="accessibility"
        hint="to paste the text where your cursor is, and for hold-to-talk"
        actions={!perm.accessibility && <Action onClick={() => ask('accessibility')}>allow</Action>}
      >
        {perm.accessibility ? <span className="green">allowed</span> : <span className="yellow">not allowed yet</span>}
      </Row>
      <Row
        label="screen recording"
        hint={`for control mode: to see the windows it acts on${control ? '' : ' · only if you use it'}`}
        actions={perm.screen !== 'granted' && <Action onClick={() => ask('screen')}>allow</Action>}
      >
        {perm.screen === 'granted' ? <span className="green">allowed</span> : <span className={control ? 'yellow' : 'dim'}>not allowed yet</span>}
      </Row>
      <p className="note">
        accessibility and screen recording open system settings: turn speak on in the list, then come back here. after screen recording, macos may ask to reopen
        speak.
      </p>
    </section>
  )
}

/** A first dictation, into a box here: the shortcut, and what came of it. */
function TryStep({
  config,
  perm,
  heard,
  pasted,
  onPaste,
  onSettings
}: {
  config: Config
  perm: PermissionStatus | null
  heard: Session | null
  pasted: boolean
  onPaste: () => void
  onSettings: (s: SettingsSection) => void
}) {
  const [shortcutError, setShortcutError] = useState<string | undefined>()
  useEffect(() => void api.getInfo().then((i) => setShortcutError(i.shortcutError)), [config.modes])
  const shortcut = firstShortcut(config, ['dictate']) || firstShortcut(config)
  const key = <span className="acc">{displayShortcut(shortcut)}</span>
  const others = modesOn(config).filter((m) => m !== 'dictate' && config.modes[m].shortcut)
  const hold = config.recording.press !== 'toggle' && perm?.hookAvailable !== false

  return (
    <>
      <section>
        <Sep>try it</Sep>
        <p className="block-text">
          click in the box, then press {key}
          {hold ? ': hold it while you speak and let go, or tap it, speak, and tap it again' : ', speak, and press it again'}. speak writes what you said where
          your cursor is, here as in any app.
        </p>
        <label className="field">
          <textarea className="try" autoFocus spellCheck={false} placeholder="your words land here" onPaste={onPaste} />
        </label>
        {shortcutError && (
          <p className="line error">
            ✗ {shortcutError} <Action onClick={() => onSettings('general')}>change it</Action>
          </p>
        )}
        {heard ? <Heard session={heard} /> : pasted && <p className="line green">✓ it works: that is all there is to it</p>}
        <p className="note">
          {config.writing.then === 'preview'
            ? 'the text shows in a preview first: check it, edit it by voice, then insert it'
            : 'the text is pasted right away, without a preview'}{' '}
          · <Action onClick={() => onSettings('writing')}>settings → writing</Action>
        </p>
        {perm?.wayland && <p className="note">wayland: install wtype or ydotool for speak to paste, and bind a desktop shortcut to `speak --toggle`.</p>}
      </section>
      {others.length > 0 && (
        <section>
          <Sep>and then</Sep>
          {others.map((m) => (
            <Row key={m} label={m} hint={MODES.find((x) => x.id === m)?.description}>
              <span>
                <span className="acc">{displayShortcut(config.modes[m].shortcut)}</span>{' '}
                <span className="dim">· {MODES.find((x) => x.id === m)?.description}</span>
              </span>
            </Row>
          ))}
        </section>
      )}
    </>
  )
}

/** What came of the dictation: it works, or what went wrong. */
function Heard({ session }: { session: Session }) {
  const text = session.text || session.transcription.text
  if (session.error)
    return (
      <>
        <p className="line yellow">! speak heard you, but: {session.error}</p>
        {text && <p className="block-text dim selectable">{text}</p>}
      </>
    )
  const outcome =
    session.action === 'inserted' || session.action === 'pasted'
      ? 'it works: that is all there is to it'
      : session.action === 'copied'
        ? `it works · it's on the clipboard: ${MOD}+v pastes it`
        : session.action === 'cancelled' || session.action === 'closed'
          ? 'speak heard you · that one was cancelled'
          : 'speak heard you · waiting for the preview'
  return (
    <>
      <p className="line green">✓ {outcome}</p>
      {session.action !== 'inserted' && session.action !== 'pasted' && text && <p className="block-text dim selectable">{text}</p>}
    </>
  )
}
