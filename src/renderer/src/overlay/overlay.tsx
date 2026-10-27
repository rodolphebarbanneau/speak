import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { DICTATION_STYLES, LANGUAGES } from '@shared/constants'
import type { Config, DeepPartial, OutputMode, OverlayState } from '@shared/types'
import { Spinner } from '../components/ui'
import { microphoneError } from '../lib/microphone'
import { cancelCapture, playSound, setLevelListener, startCapture, stopCapture } from './recorder'

const api = window.speak
const LEVELS = 10
/** Bar heights, in eighths like the ▁…█ block characters. */
const STEPS = 8

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type Menu = 'style' | 'output' | 'mode'
const OUTPUTS = [{ code: 'same', name: 'as spoken' }, ...LANGUAGES.map((l) => ({ code: l.code, name: l.name.toLowerCase() }))]
const MODES: OutputMode[] = ['preview', 'paste']

/**
 * The settings this dictation will use, on the pill while recording. Clicking one opens a list
 * above the pill: a style, language or mode becomes the new default and applies to the recording
 * in progress; compose (which has its own shortcut) switches only this recording.
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
  const options =
    open === 'style'
      ? styles
      : open === 'output'
        ? OUTPUTS.map((o) => ({ key: o.code, label: o.name, on: config.language.output === o.code, apply: () => setDefault({ language: { output: o.code } }) }))
        : open === 'mode'
          ? MODES.map((m) => ({ key: m, label: m, on: config.output.mode === m, apply: () => setDefault({ output: { mode: m } }) }))
          : []
  const style = compose ? 'compose' : DICTATION_STYLES.find((s) => s.id === config.style)?.label.toLowerCase()
  const output = OUTPUTS.find((o) => o.code === config.language.output)?.name ?? config.language.output

  const choice = (menu: Menu, label: string | undefined) => (
    <button className={open === menu ? 'open' : ''} onClick={toggle(menu)}>
      {label}
    </button>
  )
  return (
    <span className="choices">
      {choice('style', style)}
      <span className="dim">·</span>
      {choice('output', output)}
      <span className="dim">·</span>
      {choice('mode', config.output.mode)}
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
  let content
  let tone = ''
  switch (state.phase) {
    case 'recording':
      content = (
        <>
          <span className="red">
            <span className="blink">●</span> rec
          </span>
          <span className="hi">{formatTime(now - (state.startedAt ?? now))}</span>
          <span className="levels">
            {levels.map((l, i) => (
              <i key={i} style={{ height: `${((Math.min(STEPS - 1, Math.floor(l * STEPS)) + 1) / STEPS) * 100}%` }} />
            ))}
          </span>
          {!edit && config && <Choices config={config} compose={compose} />}
          <span className="finish">
            <button className="done" onClick={() => api.recordingAction('finish')}>
              done
            </button>
            <button className="esc" onClick={() => api.recordingAction('cancel')}>
              esc
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
