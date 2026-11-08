import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CONTROL_APPROVALS, CONTROL_SCOPES } from '@shared/constants'
import type { Config, ControlAsk, ControlState, ControlStatus, ControlStep } from '@shared/types'
import { displayShortcut, Spinner } from '../components/ui'

const api = window.speak

const STATUS: Record<ControlStatus, { label: string; tone: string }> = {
  starting: { label: 'starting', tone: 'dim' },
  listening: { label: 'listening', tone: 'red' },
  thinking: { label: 'thinking', tone: 'acc' },
  acting: { label: 'acting', tone: 'acc' },
  waiting: { label: 'waiting for you', tone: 'yellow' },
  hands: { label: 'waiting for your hands', tone: 'yellow' },
  paused: { label: 'paused', tone: 'yellow' },
  idle: { label: 'ready', tone: 'green' },
  ended: { label: 'ended', tone: 'dim' }
}

/** Soft cues: something waits for you (rising), a task is done (the dictation's "done"). */
let audio: AudioContext | null = null
function chime(kind: 'ask' | 'done'): void {
  audio ??= new AudioContext()
  const c = audio
  const notes = kind === 'ask' ? [587, 880] : [784, 1046]
  notes.forEach((freq, i) => {
    const osc = c.createOscillator()
    const gain = c.createGain()
    const t = c.currentTime + i * 0.11
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.1, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
    osc.connect(gain).connect(c.destination)
    osc.start(t)
    osc.stop(t + 0.17)
  })
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A step's mark: who speaks, or how an action went. */
function mark(step: ControlStep): { text: string; tone: string } {
  if (step.who === 'you') return { text: 'you', tone: 'acc' }
  if (step.who === 'ai') return { text: ' ai', tone: 'green' }
  if (step.who === 'info') return { text: '  ·', tone: 'dim' }
  if (step.who === 'error') return { text: '  ✗', tone: 'red' }
  switch (step.state) {
    case 'running':
      return { text: '  …', tone: 'yellow' }
    case 'failed':
      return { text: '  ✗', tone: 'red' }
    case 'rejected':
      return { text: '  ⊘', tone: 'red' }
    case 'undone':
      return { text: '  ↶', tone: 'dim' }
    default:
      return step.risk === 'look' ? { text: '  ·', tone: 'dim' } : { text: '  ✓', tone: 'green' }
  }
}

function Step({ step }: { step: ControlStep }) {
  const [see, setSee] = useState(false)
  const [open, setOpen] = useState(false)
  const m = mark(step)
  const quiet = step.who === 'info' || (step.who === 'action' && step.risk === 'look')
  const long = (step.detail?.split('\n').length ?? 0) > 3 || (step.detail?.length ?? 0) > 220
  return (
    <div className={`cstep is-${step.who}`}>
      <span className={`cmark ${m.tone}`}>{m.text}</span>
      <div className="cbody">
        <span className={quiet ? 'dim' : step.who === 'error' ? 'red' : step.who === 'you' ? 'hi' : step.state === 'undone' ? 'dim strike' : ''}>
          {step.text}
        </span>
        {step.risk === 'risky' && step.who === 'action' && <span className="yellow"> · risky</span>}
        {step.image && (
          <button className="clink" onClick={() => setSee(!see)}>
            {see ? '[hide]' : '[see]'}
          </button>
        )}
        {step.undoable && step.state !== 'undone' && (
          <button className="clink" onClick={() => api.controlUndo(step.id)}>
            [undo]
          </button>
        )}
        {step.detail && (
          <p className={`cdetail dim selectable ${long && !open ? 'clamp' : ''}`} onClick={() => long && setOpen(!open)}>
            {step.detail}
          </p>
        )}
        {see && step.image && <img className="cshot" src={step.image} alt="what it saw" />}
      </div>
    </div>
  )
}

/** It needs the real mouse or keyboard: it goes once your hands are still, or now. */
function Hands({ what }: { what: string }) {
  return (
    <div className="cask hands">
      <p className="cask-head">
        <span className="yellow">needs your mouse and keyboard a moment</span>
      </p>
      <p className="hi">{what}</p>
      <p className="cask-keys">
        <button className="ckey green" onClick={() => api.controlGoNow()}>
          [go now]
        </button>
        <span className="dim">· or keep working: it goes once your hands are still, then gives them back</span>
      </p>
    </div>
  )
}

function Ask({ ask }: { ask: ControlAsk }) {
  const yes = () => api.controlAnswer(ask.id, 'yes')
  const no = () => api.controlAnswer(ask.id, 'no')
  const head = ask.kind === 'plan' ? 'its plan' : ask.kind === 'question' ? 'it asks' : ask.kind === 'scope' ? 'more scope' : 'approve?'
  return (
    <div className={`cask ${ask.risk === 'risky' || ask.because ? 'risky' : ''}`}>
      <p className="cask-head">
        <span className="yellow">{head}</span>
        {ask.because && <span className="yellow"> · always asks: {ask.because}</span>}
      </p>
      <p className="hi">{ask.title}</p>
      {ask.detail && <p className="cdetail dim selectable clamp">{ask.detail}</p>}
      {ask.image && <img className="cspot" src={ask.image} alt="where it will act" />}
      {ask.steps && (
        <ol className="cplan">
          {ask.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {ask.kind === 'question' ? (
        <p className="dim">answer by voice (talk), or type it below</p>
      ) : (
        <p className="cask-keys">
          <button className="ckey green" onClick={yes}>
            [{ask.kind === 'plan' ? 'approve' : 'yes'}]
          </button>
          {ask.always && (
            <button className="ckey acc" onClick={() => api.controlAnswer(ask.id, 'always')} title="approve this kind of action for the rest of the session">
              [always]
            </button>
          )}
          <button className="ckey red" onClick={no}>
            [no]
          </button>
          <span className="dim"> · or say what to do instead</span>
        </p>
      )}
    </div>
  )
}

/** The field to type an order (or an answer): the panel takes the keyboard while it's in use. */
function OrderField({ question }: { question: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [typing, setTyping] = useState(false)
  const done = () => {
    setTyping(false)
    api.controlKeyboard(false)
  }
  return (
    <label className={`corder ${typing ? 'on' : ''}`}>
      <span className="acc">›</span>
      <input
        ref={input}
        value={value}
        placeholder={question ? 'type your answer…' : 'type an order…'}
        spellCheck={false}
        onMouseDown={() => {
          if (!typing) {
            setTyping(true)
            api.controlKeyboard(true)
            setTimeout(() => input.current?.focus(), 50)
          }
        }}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            api.controlSend(value.trim())
            setValue('')
            done()
            input.current?.blur()
          } else if (e.key === 'Escape') {
            done()
            input.current?.blur()
          }
        }}
        onBlur={() => typing && done()}
      />
    </label>
  )
}

type Menu = 'scope' | 'approval'

export function ControlPanel() {
  const [state, setState] = useState<ControlState | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [now, setNow] = useState(Date.now())
  const [menu, setMenu] = useState<Menu | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    void api.getControlState().then(setState)
    return api.onControl(setState)
  }, [])
  useEffect(() => {
    void api.getConfig().then(setConfig)
    return api.onConfig(setConfig)
  }, [])
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  // A cue when it starts waiting for you (an approval, a question), and when a task is done.
  const previous = useRef<ControlStatus | null>(null)
  useEffect(() => {
    const now = state?.status
    const was = previous.current
    previous.current = now ?? null
    if (!now || !was || now === was || !config?.audio.sounds) return
    // Waiting for your hands needs nothing from you: no cue (it would chime all along while you work).
    if (now === 'waiting' && was !== 'waiting') chime('ask')
    else if (now === 'idle' && (was === 'acting' || was === 'thinking')) chime('done')
  }, [state?.status, config?.audio.sounds])
  // Answers and questions read aloud, when that's on.
  useEffect(
    () =>
      api.onControlSay((text) => {
        const u = new SpeechSynthesisUtterance(text)
        const lang = config?.language.input
        if (lang && lang !== 'auto') u.lang = lang
        speechSynthesis.cancel()
        speechSynthesis.speak(u)
      }),
    [config?.language.input]
  )
  // Follow the newest step, unless scrolled up to read.
  useLayoutEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [state?.steps.length, state?.ask?.id, state?.collapsed])

  if (!state) return null
  const status = STATUS[state.status]
  const last = [...state.steps].reverse().find((s) => s.who !== 'info')
  const scope = CONTROL_SCOPES.find((s) => s.id === state.scope)
  const approval = CONTROL_APPROVALS.find((a) => a.id === state.approval)
  const talkKey = config ? displayShortcut(config.shortcuts.control || config.shortcuts.record) : ''
  const busy = state.status === 'thinking' || state.status === 'acting'
  /** It works, or waits to: pause and stop apply. */
  const working = busy || state.status === 'hands'

  return (
    <div className={`cpanel ${state.collapsed ? 'collapsed' : ''}`}>
      <header className="chead">
        <span className={`cdot ${status.tone}`}>{busy ? <Spinner /> : '●'}</span>
        <span className="hi">control</span>
        <span className="dim">·</span>
        <button className={`cchoice ${menu === 'scope' ? 'open' : ''}`} title={scope?.description} onClick={() => setMenu(menu === 'scope' ? null : 'scope')}>
          {state.scopeLabel || scope?.label}
        </button>
        <span className="dim">· asks</span>
        <button
          className={`cchoice ${menu === 'approval' ? 'open' : ''}`}
          title={approval?.description}
          onClick={() => setMenu(menu === 'approval' ? null : 'approval')}
        >
          {approval?.label}
        </button>
        <span className="cgrow drag" />
        <span className={status.tone}>{status.label}</span>
        <span className="dim">{clock(now - state.startedAt)}</span>
        <button className="cicon" title={state.collapsed ? 'open' : 'reduce'} onClick={() => api.controlCollapse(!state.collapsed)}>
          {state.collapsed ? '▴' : '▾'}
        </button>
        {menu && (
          <div className="cmenu" onMouseLeave={() => setMenu(null)}>
            {(menu === 'scope' ? CONTROL_SCOPES : CONTROL_APPROVALS).map((o) => (
              <button
                key={o.id}
                className={(menu === 'scope' ? state.scope : state.approval) === o.id ? 'on' : ''}
                onClick={() => {
                  if (menu === 'scope') api.controlSetScope(o.id as ControlState['scope'])
                  else api.controlSetApproval(o.id as ControlState['approval'])
                  setMenu(null)
                }}
              >
                {o.label} <span className="dim">{o.description}</span>
              </button>
            ))}
          </div>
        )}
      </header>
      {state.collapsed ? (
        <p className="cline dim">
          {state.ask ? (
            <>
              {/* Reduced, it can still be answered. */}
              {state.ask.kind !== 'question' && (
                <>
                  <button className="ckey green" onClick={() => api.controlAnswer(state.ask!.id, 'yes')}>
                    [yes]
                  </button>
                  <button className="ckey red" onClick={() => api.controlAnswer(state.ask!.id, 'no')}>
                    [no]
                  </button>
                </>
              )}
              <span className="yellow">{state.ask.title}</span>
            </>
          ) : state.hands ? (
            <>
              <button className="ckey green" onClick={() => api.controlGoNow()}>
                [go now]
              </button>
              <span className="yellow">needs your hands: {state.hands}</span>
            </>
          ) : last ? (
            last.text
          ) : (
            ''
          )}
        </p>
      ) : (
        <>
          <div
            className="csteps"
            ref={list}
            onScroll={(e) => {
              const el = e.currentTarget
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
          >
            {state.steps.map((s) => (
              <Step key={s.id} step={s} />
            ))}
            {state.ask && <Ask ask={state.ask} />}
            {!state.ask && state.hands && <Hands what={state.hands} />}
            {state.status === 'listening' && <p className="red cstep-note">● listening…</p>}
          </div>
          <OrderField question={state.ask?.kind === 'question'} />
          <footer className="cfoot">
            <button className={`ckey ${state.listening ? 'red' : 'acc'}`} onClick={() => api.controlTalk()} title="speak to it (the shortcut does the same)">
              [{state.listening ? '■ done' : '● talk'}]
            </button>
            {talkKey && <span className="dim">{talkKey}</span>}
            <span className="cgrow" />
            {state.status === 'paused' ? (
              <button className="ckey yellow" onClick={() => api.controlResume()}>
                [resume]
              </button>
            ) : (
              <button className="ckey" onClick={() => api.controlPause()} disabled={!working} title="hold its next action until you resume">
                [pause]
              </button>
            )}
            <button
              className="ckey"
              onClick={() => api.controlStop()}
              disabled={!working && state.status !== 'waiting' && state.status !== 'paused'}
              title="interrupt what it does"
            >
              [stop]
            </button>
            <button className="ckey" onClick={() => api.controlRestart()} title="stop, and give it your last order again">
              [restart]
            </button>
            <button className="ckey red" onClick={() => api.controlEnd()} title="end control: it stops, and the session goes to the history">
              [end]
            </button>
          </footer>
        </>
      )}
    </div>
  )
}

/** The frame around where the AI acts: click-through, its color says acting or waiting. */
export function ControlFrame() {
  const [tone, setTone] = useState<'acting' | 'waiting'>('acting')
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => api.onFrame(setTone), [])
  useEffect(() => {
    const resize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  // Around a window it says so; around a button or a field (what an approval is about), the box alone.
  const tag = size.w >= 240 && size.h >= 120
  return (
    <div className={`cframe ${tone}`}>
      {tag && <span className="cframe-tag">speak · {tone === 'acting' ? 'has the mouse and keyboard' : 'asks you about this'}</span>}
    </div>
  )
}
