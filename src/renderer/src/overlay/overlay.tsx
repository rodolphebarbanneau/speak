import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CONTROL_APPROVALS, CONTROL_SCOPES, FORMATS, LANGUAGES, MODES, spokenLanguages } from '@shared/constants'
import type { ClipboardInfo, Config, DeepPartial, Mode, OutputMode, OverlayState } from '@shared/types'
import { PillDecor } from '@themes/components'
import { Boundary, Spinner } from '../components/ui'
import { CONTEXT_KINDS, ipcError, shorten } from '../lib/format'
import { microphoneError } from '../lib/microphone'
import { cancelCapture, pauseCapture, playSound, setLevelListener, startCapture, stopCapture } from './recorder'

const api = window.speak
const LEVELS = 10
/** Bar heights, in eighths like the ▁…█ block characters. */
const STEPS = 8

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

interface Option {
  key: string
  label: string
  /** Dim, after the label. */
  note?: string
  /** On hover: the full path or address. */
  title?: string
  on?: boolean
  apply: () => void
}
const OUTPUTS = [{ code: 'same', name: 'as spoken' }, ...LANGUAGES.map((l) => ({ code: l.code, name: l.name.toLowerCase() }))]
const THEN: OutputMode[] = ['preview', 'paste']

/** The pill's buttons, drawn in SVG: the ⏸ ▶ ✓ ✕ characters come from fallback fonts of uneven size. */
const ICONS = {
  pause: <path d="M4 3h3v10H4zM9 3h3v10H9z" />,
  resume: <path d="M4.5 2.5v11L13.5 8z" />,
  finish: <path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2" />,
  cancel: <path d="M3.5 3.5l9 9m0-9l-9 9" fill="none" stroke="currentColor" strokeWidth="2" />
}

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

/**
 * The context list: none, the recent ones (a choice stays for the next dictations), the clipboard
 * for this dictation only, and to add: the folder or address on the clipboard, an address to type,
 * or a folder picked with the system dialog.
 */
function contextOptions(config: Config, clipboard: boolean, clip: ClipboardInfo | null, typeAddress: () => void): Option[] {
  const { current, recent } = config.context
  const options: Option[] = [
    { key: 'none', label: 'none', on: !clipboard && !current, apply: () => api.chooseContext('') },
    ...recent.map((s) => ({
      key: s.location,
      label: shorten(s.label, 40),
      note: s.kind === 'folder' ? undefined : s.kind === 'url' ? 'page' : 'git',
      title: s.location,
      on: !clipboard && current === s.location,
      apply: () => api.chooseContext(s.location)
    }))
  ]
  const found = clip?.source
  // A path or an address on the clipboard is something to add, not text to give.
  if (found && !recent.some((s) => s.location === found.location)) {
    options.push({
      key: 'add',
      label: `+ ${shorten(found.label, 38)}`,
      note: `${found.kind === 'url' ? 'page' : found.kind} from the clipboard`,
      title: found.location,
      apply: () => void api.addContextFromClipboard()
    })
  } else if (clip?.chars || clipboard) {
    options.push({
      key: 'clipboard',
      label: 'clipboard',
      note: `${clip?.chars ?? 0} characters · this dictation only`,
      on: clipboard,
      apply: () => api.chooseContext('clipboard')
    })
  }
  options.push({ key: 'url', label: '+ url…', note: 'git or web', apply: typeAddress })
  options.push({ key: 'browse', label: '+ folder…', apply: () => void api.browseContextFolder() })
  return options
}

/**
 * A field to type a git or web address (or a folder path) into. The pill takes the keyboard while
 * it's open, and the recording pauses; then the focus goes back to the app being dictated into.
 * Enter adds it as the context, Esc or a click elsewhere closes the field.
 */
function AddressField({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let open = true
    void api.contextKeyboard(true).then(() => open && input.current?.focus())
    return () => {
      open = false
      void api.contextKeyboard(false)
    }
  }, [])
  const add = () => {
    if (!value.trim()) return onDone()
    busy.current = true
    api
      .addContext(value.trim())
      .then(onDone)
      .catch((e: Error) => {
        busy.current = false
        setError(ipcError(e))
        input.current?.focus()
      })
  }
  return (
    <div className="overlay-field">
      <label>
        <span className="acc">url ›</span>
        <input
          ref={input}
          value={value}
          placeholder="https://…"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
            else if (e.key === 'Escape') onDone()
          }}
          onBlur={() => !busy.current && onDone()}
        />
      </label>
      <p className={error ? 'red' : 'dim'}>{error ?? 'a git repository or a web page · enter to add · esc to close'}</p>
    </div>
  )
}

/** The formats in the sheet: the default first. */
const SHEET_FORMATS = ['clean', 'verbatim', 'prompt', 'summary'].map((id) => FORMATS.find((s) => s.id === id)!).filter(Boolean)

/** What the sheet shows: its rows, or one long list (languages, contexts), or the field for an address. */
type View = 'main' | 'spoken' | 'output' | 'context' | 'url'

/** A choice of the sheet: every option on one line, the current one highlighted. */
function Seg<T extends string>({ options, value, onPick }: { options: Array<{ id: T; label: string; title?: string }>; value: T; onPick: (v: T) => void }) {
  return (
    <span className="seg">
      {options.map((o) => (
        <button key={o.id} className={o.id === value ? 'on' : ''} title={o.title} onClick={() => onPick(o.id)}>
          {o.label}
        </button>
      ))}
    </span>
  )
}

function SheetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="srow">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  )
}

/** A value that opens its list: "auto ▾". */
function Chip({ children, title, onClick }: { children: ReactNode; title?: string; onClick: () => void }) {
  return (
    <button className="chip" title={title} onClick={onClick}>
      {children} <span className="chev">▾</span>
    </button>
  )
}

/**
 * The pill's settings: on the pill, the mode and only what changes the result (a format other than
 * clean, a translation, a context; for control, what it acts on and when it asks); one click opens
 * the sheet with every choice of that mode. The mode switches only this recording; the rest becomes
 * the new default and applies to it too. The pill can't take the focus, so nothing tells a click
 * elsewhere: the sheet closes once the pointer has left it a moment.
 */
function Choices({ config, mode, clipboard, target }: { config: Config; mode: Mode; clipboard: boolean; target?: string }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('main')
  const [clip, setClip] = useState<ClipboardInfo | null>(null)
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (closing.current) clearTimeout(closing.current)
    },
    []
  )
  const close = () => {
    setOpen(false)
    setView('main')
  }
  const toggle = () => {
    if (open) return close()
    setOpen(true)
    setView('main')
    void api.clipboardInfo().then(setClip)
  }
  const leave = () => {
    if (view === 'url') return // typing an address: the field closes it
    closing.current = setTimeout(close, 600)
  }
  const enter = () => {
    if (closing.current) clearTimeout(closing.current)
    closing.current = null
  }
  const setDefault = (patch: DeepPartial<Config>) => void api.setConfig(patch)

  const context = clipboard ? 'clipboard' : config.context.recent.find((s) => s.location === config.context.current)
  const contextLabel = typeof context === 'object' ? shorten(context.label, 18) : context
  const approval = CONTROL_APPROVALS.find((a) => a.id === config.control.approval)
  const scope = config.control.scope
  const summary =
    mode === 'control'
      ? [scope === 'app' ? target || 'app' : scope, approval?.label ?? '']
      : [
          ...(mode === 'dictate' && config.style !== 'clean' ? [FORMATS.find((s) => s.id === config.style)?.label.toLowerCase() ?? config.style] : []),
          ...(config.language.output !== 'same' ? [`→ ${config.language.output}`] : []),
          ...(contextLabel ? [contextLabel] : [])
        ]

  const spoken = [
    { code: 'auto', name: 'auto-detect' },
    ...spokenLanguages(config.transcription.engine).map((l) => ({ code: l.code, name: l.name.toLowerCase() }))
  ]
  const back = () => setView('main')
  const lists: Partial<Record<View, { title: string; options: Option[] }>> = {
    spoken: {
      title: 'spoken language',
      options: spoken.map((o) => ({
        key: o.code,
        label: o.name,
        on: config.language.input === o.code,
        apply: () => setDefault({ language: { input: o.code } })
      }))
    },
    output: {
      title: 'write in',
      options: OUTPUTS.map((o) => ({
        key: o.code,
        label: o.name,
        on: config.language.output === o.code,
        apply: () => setDefault({ language: { output: o.code } })
      }))
    },
    context: { title: 'context', options: contextOptions(config, clipboard, clip, () => setView('url')) }
  }
  const list = lists[view]

  const contextRow = (label: string, empty: string) => (
    <SheetRow label={label}>
      <Chip title={typeof context === 'object' ? context.location : undefined} onClick={() => setView('context')}>
        {contextLabel ?? empty}
      </Chip>
      {typeof context === 'object' && <span className="dim">{CONTEXT_KINDS[context.kind]}</span>}
    </SheetRow>
  )

  return (
    <span className="choices" onMouseLeave={open ? leave : undefined} onMouseEnter={open ? enter : undefined}>
      <button className={`summary ${open ? 'open' : ''}`} title="settings for this recording" onClick={toggle}>
        <span className="mode">{mode}</span>
        {summary.length > 0 && <span className="dim">{summary.join(' · ')}</span>}
        <span className="chev">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="pill-sheet">
          {view === 'url' ? (
            <AddressField onDone={back} />
          ) : list ? (
            <>
              <div className="slist-head">
                <button className="sback" onClick={back}>
                  ‹ back
                </button>
                <span className="dim">{list.title}</span>
              </div>
              <div className="slist">
                {list.options.map((o) => (
                  <button
                    key={o.key}
                    className={o.on ? 'on' : ''}
                    title={o.title}
                    onClick={() => {
                      o.apply()
                      if (o.key !== 'url') back()
                    }}
                  >
                    {o.label}
                    {o.note && <span className="dim"> {o.note}</span>}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <SheetRow label="mode">
                <Seg options={MODES.map((m) => ({ id: m.id, label: m.label, title: m.description }))} value={mode} onPick={(m) => api.recordingAction(m)} />
              </SheetRow>
              {mode === 'control' ? (
                <>
                  <SheetRow label="scope">
                    <Seg
                      options={CONTROL_SCOPES.map((s) => ({ id: s.id, label: s.label, title: s.description }))}
                      value={scope}
                      onPick={(v) => setDefault({ control: { scope: v } })}
                    />
                  </SheetRow>
                  <SheetRow label="asks">
                    <Seg
                      options={CONTROL_APPROVALS.map((a) => ({ id: a.id, label: a.label, title: a.description }))}
                      value={config.control.approval}
                      onPick={(v) => setDefault({ control: { approval: v } })}
                    />
                  </SheetRow>
                  <p className="sfoot">
                    {scope === 'app'
                      ? `app: ${target ? `${target}, the one` : 'the one'} in front when you pressed the shortcut`
                      : CONTROL_SCOPES.find((s) => s.id === scope)?.description}
                  </p>
                </>
              ) : (
                <>
                  {mode === 'dictate' && (
                    <SheetRow label="format">
                      <Seg
                        options={SHEET_FORMATS.map((s) => ({ id: s.id, label: s.label.toLowerCase(), title: s.description.toLowerCase() }))}
                        value={config.style}
                        onPick={(v) => setDefault({ style: v })}
                      />
                    </SheetRow>
                  )}
                  <SheetRow label="language">
                    <Chip title="spoken language" onClick={() => setView('spoken')}>
                      {config.language.input}
                    </Chip>
                    <span className="dim">→</span>
                    <Chip title="write in" onClick={() => setView('output')}>
                      {config.language.output === 'same' ? 'as spoken' : config.language.output}
                    </Chip>
                  </SheetRow>
                  <SheetRow label="then">
                    <Seg options={THEN.map((t) => ({ id: t, label: t }))} value={config.output.mode} onPick={(v) => setDefault({ output: { mode: v } })} />
                  </SheetRow>
                  {contextRow('context', 'none')}
                  <p className="sfoot">mode: this recording only · the rest becomes your default</p>
                </>
              )}
            </>
          )}
        </div>
      )}
    </span>
  )
}

export function Overlay() {
  const [state, setState] = useState<OverlayState>({ phase: 'idle' })
  const [levels, setLevels] = useState<number[]>(Array(LEVELS).fill(0))
  const [now, setNow] = useState(Date.now())
  const [config, setConfig] = useState<Config | null>(null)
  const lastLevel = useRef(0)
  const [pill, setPill] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    void api.getOverlayState().then(setState)
    return api.onOverlay(setState)
  }, [])
  useEffect(() => {
    void api.getConfig().then(setConfig)
    return api.onConfig(setConfig)
  }, [])
  // The pill only catches clicks while recording; a vanished pill can't report the pointer leaving.
  useEffect(() => {
    if (state.phase !== 'recording') api.overlayInteractive(false)
  }, [state.phase])

  useEffect(() => {
    setLevelListener((level) => {
      const t = performance.now()
      if (t - lastLevel.current < 60) return
      lastLevel.current = t
      setLevels((prev) => [...prev.slice(1), level])
    })
    return () => setLevelListener(null)
  }, [])

  useEffect(
    () =>
      api.onRecorderCommand(async (cmd) => {
        if (cmd.type === 'sound') return playSound(cmd.name)
        if (cmd.type === 'start') {
          setLevels(Array(LEVELS).fill(0))
          try {
            if (cmd.sounds) playSound('start')
            const device = await startCapture(cmd.deviceId, cmd.deviceLabel, (d) => api.recorderNoSignal(d))
            api.recorderStarted(true, undefined, device)
          } catch (err) {
            api.recorderStarted(false, microphoneError(err))
          }
        } else if (cmd.type === 'stop') {
          try {
            const samples = await stopCapture()
            api.recorderResult(cmd.reqId, samples)
          } catch (err) {
            api.recorderResult(cmd.reqId, null, (err as Error).message)
          }
        } else if (cmd.type === 'pause' || cmd.type === 'resume') {
          pauseCapture(cmd.type === 'pause')
          setLevels(Array(LEVELS).fill(0))
        } else if (cmd.type === 'cancel') {
          await cancelCapture()
        }
      }),
    []
  )

  useEffect(() => {
    if (state.phase !== 'recording') return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.phase])

  if (state.phase === 'idle') return null

  const edit = state.purpose === 'edit'
  const compose = state.purpose === 'compose'
  const ctrl = state.purpose === 'control'
  const mode: Mode = ctrl ? 'control' : compose ? 'compose' : 'dictate'
  const paused = state.pausedAt !== undefined
  let content
  let tone = ''
  switch (state.phase) {
    case 'recording':
      // Paused, the word takes the meter's place: the pill keeps its width, so the button stays under the pointer.
      content = (
        <>
          <span className={paused ? 'yellow' : 'red'} title={paused ? 'paused' : 'recording'}>
            <span className={paused ? undefined : 'blink'}>●</span>
          </span>
          <span className="hi">{formatTime((state.pausedAt ?? now) - (state.startedAt ?? now))}</span>
          <span className={`levels ${paused ? 'paused' : ''}`}>
            {paused ? 'paused' : levels.map((l, i) => <i key={i} style={{ height: `${((Math.min(STEPS - 1, Math.floor(l * STEPS)) + 1) / STEPS) * 100}%` }} />)}
          </span>
          {state.talk ? (
            <span className="acc">talking to control</span>
          ) : (
            !edit && config && <Choices config={config} mode={mode} clipboard={!!state.clipboard} target={state.target} />
          )}
          <span className="controls">
            {!edit && (
              <button
                className={paused ? 'resume' : 'pause'}
                title={paused ? 'resume' : 'pause'}
                onClick={() => api.recordingAction(paused ? 'resume' : 'pause')}
              >
                <Icon name={paused ? 'resume' : 'pause'} />
              </button>
            )}
            <button className="done" title="done: stop and process" onClick={() => api.recordingAction('finish')}>
              <Icon name="finish" />
            </button>
            <button className="esc" title="cancel (esc)" onClick={() => api.recordingAction('cancel')}>
              <Icon name="cancel" />
            </button>
          </span>
        </>
      )
      break
    case 'transcribing':
      content = (
        <>
          <Spinner />
          <span>transcribing</span>
          {state.message && <span className="dim">· {state.message}</span>}
        </>
      )
      break
    case 'processing':
      content = (
        <>
          <Spinner />
          <span>{edit ? 'applying edit' : compose ? 'composing' : ctrl ? 'control' : 'processing'}</span>
          {state.message && <span className="dim">· {state.message}</span>}
        </>
      )
      break
    case 'error':
      tone = 'error'
      content = (
        <>
          <span className="red">✗</span>
          <span className="msg">{state.message}</span>
        </>
      )
      break
    default:
      tone = 'info'
      content = (
        <>
          <span className="dim">·</span>
          <span className="msg">{state.message}</span>
        </>
      )
  }

  const interactive = state.phase === 'recording'
  return (
    <div className="overlay-root">
      {state.phase === 'recording' && (
        <Boundary label="pill decoration">
          <PillDecor pill={pill} />
        </Boundary>
      )}
      <div
        ref={setPill}
        className={`osd ${tone}`}
        onMouseEnter={interactive ? () => api.overlayInteractive(true) : undefined}
        onMouseLeave={interactive ? () => api.overlayInteractive(false) : undefined}
      >
        {content}
      </div>
    </div>
  )
}
