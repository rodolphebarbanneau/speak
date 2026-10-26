import { useEffect, useRef, useState } from 'react'
import type { OverlayState } from '@shared/types'
import { Spinner } from '../components/ui'
import { microphoneError } from '../lib/microphone'
import { cancelCapture, playSound, setLevelListener, startCapture, stopCapture } from './recorder'

const api = window.speak
const BLOCKS = '▁▂▃▄▅▆▇█'
const LEVELS = 10

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function Overlay() {
  const [state, setState] = useState<OverlayState>({ phase: 'idle' })
  const [levels, setLevels] = useState<number[]>(Array(LEVELS).fill(0))
  const [now, setNow] = useState(Date.now())
  const lastLevel = useRef(0)

  useEffect(() => api.onOverlay(setState), [])

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
  let content
  let tone = ''
  switch (state.phase) {
    case 'recording':
      content = (
        <>
          <span className="red">
            <span className="blink">●</span> {edit ? 'edit' : 'rec'}
          </span>
          <span className="hi">{formatTime(now - (state.startedAt ?? now))}</span>
          <span className="levels">{levels.map((l) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(l * BLOCKS.length))]).join('')}</span>
          <span className="dim">esc</span>
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
          <span>{edit ? 'applying edit' : 'processing'}</span>
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

  return (
    <div className="overlay-root">
      <div className={`osd ${tone}`}>{content}</div>
    </div>
  )
}
