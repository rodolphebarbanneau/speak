import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { DICTATION_STYLES, LANGUAGES, spokenLanguages } from '@shared/constants'
import type { ClipboardInfo, Config, DeepPartial, OutputMode, OverlayState } from '@shared/types'
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

/** url: the field to type an address into, opened from the context list. */
type Menu = 'style' | 'spoken' | 'output' | 'mode' | 'context' | 'url'

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
const MODES: OutputMode[] = ['preview', 'paste']

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

/**
 * The settings this dictation will use, on the pill while recording. Clicking one opens a list
 * above the pill: a style, language, mode or context becomes the new default and applies to the
 * recording in progress; compose (which has its own shortcut) and the clipboard switch only this
 * recording. Languages show as codes (fr → en) to keep the pill short; their lists spell them out.
 */
function Choices({ config, compose, clipboard }: { config: Config; compose: boolean; clipboard: boolean }) {
  const [open, setOpen] = useState<Menu | null>(null)
  const [left, setLeft] = useState(0)
  const [clip, setClip] = useState<ClipboardInfo | null>(null)
  const toggle = (menu: Menu) => (e: MouseEvent<HTMLButtonElement>) => {
    setLeft(e.currentTarget.offsetLeft)
    setOpen(open === menu ? null : menu)
    if (menu === 'context' && open !== menu) void api.clipboardInfo().then(setClip)
  }
  const setDefault = (patch: DeepPartial<Config>) => void api.setConfig(patch)
  const styles = [
    ...DICTATION_STYLES.map((s) => ({
      key: s.id,
      label: s.label.toLowerCase(),
      on: !compose && config.style === s.id,
      apply: () => {
        setDefault({ style: s.id })
        if (compose) api.recordingAction('dictate')
      }
    })),
    { key: 'compose', label: 'compose', on: compose, apply: () => api.recordingAction('compose') }
  ]
  const spoken = [
    { code: 'auto', name: 'auto-detect' },
    ...spokenLanguages(config.transcription.engine).map((l) => ({ code: l.code, name: l.name.toLowerCase() }))
  ]
  const options: Option[] =
    open === 'context'
      ? contextOptions(config, clipboard, clip, () => setOpen('url'))
      : open === 'style'
        ? styles
        : open === 'spoken'
          ? spoken.map((o) => ({ key: o.code, label: o.name, on: config.language.input === o.code, apply: () => setDefault({ language: { input: o.code } }) }))
          : open === 'output'
            ? OUTPUTS.map((o) => ({
                key: o.code,
                label: o.name,
                on: config.language.output === o.code,
                apply: () => setDefault({ language: { output: o.code } })
              }))
            : open === 'mode'
              ? MODES.map((m) => ({ key: m, label: m, on: config.output.mode === m, apply: () => setDefault({ output: { mode: m } }) }))
              : []
  const style = compose ? 'compose' : DICTATION_STYLES.find((s) => s.id === config.style)?.label.toLowerCase()
  const context = clipboard ? 'clipboard' : config.context.recent.find((s) => s.location === config.context.current)

  const choice = (menu: Menu, label: string | undefined, title: string) => (
    <button className={open === menu ? 'open' : ''} title={title} onClick={toggle(menu)}>
      {label}
    </button>
  )
  return (
    <span className="choices">
      {choice('style', style, 'style')}
      <span className="dim">·</span>
      {choice('spoken', config.language.input, 'spoken language')}
      <span className="dim">→</span>
      {choice('output', config.language.output, 'output language')}
      <span className="dim">·</span>
      {choice('mode', config.output.mode, 'after dictation')}
      <span className="dim">·</span>
      <button
        className={`${open === 'context' ? 'open' : ''} ${context ? '' : 'dim'}`}
        title={typeof context === 'object' ? `context: ${CONTEXT_KINDS[context.kind]}, ${context.location}` : 'context'}
        onClick={toggle('context')}
      >
        {typeof context === 'object' ? shorten(context.label, 20) : (context ?? 'no context')}
      </button>
      {open && (
        // The context list is wide, and its choice the rightmost: it opens leftward.
        <div className="overlay-menu" style={open === 'context' || open === 'url' ? { right: 0 } : { left }}>
          {open === 'url' && <AddressField onDone={() => setOpen(null)} />}
          {options.map((o) => (
            <button
              key={o.key}
              className={o.on ? 'on' : ''}
              title={o.title}
              onClick={() => {
                o.apply()
                if (o.key !== 'url') setOpen(null)
              }}
            >
              {o.label}
              {o.note && <span className="dim"> {o.note}</span>}
            </button>
          ))}
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
  const paused = state.pausedAt !== undefined
  let content
  let tone = ''
  switch (state.phase) {
    case 'recording':
      // Paused, the word takes the meter's place: the pill keeps its width, so the button stays under the pointer.
      content = (
        <>
          <span className={paused ? 'yellow' : 'red'}>
            <span className={paused ? undefined : 'blink'}>●</span> rec
          </span>
          <span className="hi">{formatTime((state.pausedAt ?? now) - (state.startedAt ?? now))}</span>
          <span className={`levels ${paused ? 'paused' : ''}`}>
            {paused ? 'paused' : levels.map((l, i) => <i key={i} style={{ height: `${((Math.min(STEPS - 1, Math.floor(l * STEPS)) + 1) / STEPS) * 100}%` }} />)}
          </span>
          {!edit && config && <Choices config={config} compose={compose} clipboard={!!state.clipboard} />}
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
          <span>{edit ? 'applying edit' : compose ? 'composing' : 'processing'}</span>
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
