import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { DICTATION_STYLES, LANGUAGES, spokenLanguages } from '@shared/constants'
import type { Config, DeepPartial, OutputMode, OverlayState } from '@shared/types'
import { Spinner } from '../components/ui'
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

type Menu = 'style' | 'spoken' | 'output' | 'mode'
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
 * The settings this dictation will use, on the pill while recording. Clicking one opens a list
 * above the pill: a style, language or mode becomes the new default and applies to the recording
 * in progress; compose (which has its own shortcut) switches only this recording. Languages show
 * as codes (fr → en) to keep the pill short; their lists spell them out.
 */
function Choices({ config, compose }: { config: Config; compose: boolean }) {
  const [open, setOpen] = useState<Menu | null>(null)
  const [left, setLeft] = useState(0)
  const toggle = (menu: Menu) => (e: MouseEvent<HTMLButtonElement>) => {
    setLeft(e.currentTarget.offsetLeft)
    setOpen(open === menu ? null : menu)
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
  const options =
    open === 'style'
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
      {open && (
        <div className="overlay-menu" style={{ left }}>
          {options.map((o) => (
            <button
              key={o.key}
              className={o.on ? 'on' : ''}
              onClick={() => {
                o.apply()
                setOpen(null)
              }}
            >
              {o.label}
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

  useEffect(() => api.onOverlay(setState), [])
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
          {!edit && config && <Choices config={config} compose={compose} />}
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
      <div
        className={`osd ${tone}`}
        onMouseEnter={interactive ? () => api.overlayInteractive(true) : undefined}
        onMouseLeave={interactive ? () => api.overlayInteractive(false) : undefined}
      >
        {content}
      </div>
    </div>
  )
}
