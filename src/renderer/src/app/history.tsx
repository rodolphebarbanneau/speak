import { useCallback, useEffect, useRef, useState } from 'react'
import { languageName, shortModel, STYLES } from '@shared/constants'
import type { Config, EngineId, Session, Style } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, displayShortcut, Row, Sep, Spinner, Track } from '../components/ui'
import { ipcError } from '../lib/format'
import { outputOptions, spokenOptions } from '../lib/languages'

const api = window.speak

const ACTION_TONE: Record<string, string> = { inserted: 'green', pasted: 'green', copied: 'acc', cancelled: 'dim' }
const styleOptions = STYLES.map((s) => ({ value: s.id, label: s.label.toLowerCase() }))

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const hms = (d: Date) => `${hm(d)}:${pad(d.getSeconds())}`
const clock = (s: number) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`
const lang = (code: string) => languageName(code).toLowerCase()

/** 14:32 today, otherwise 2026-10-24 14:32. */
function when(iso: string): string {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? hm(d) : `${ymd(d)} ${hm(d)}`
}

/** audio   0:04 / 0:13  ━━━━━━────────   [ play ] */
function AudioRow({ id }: { id: string }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    let objectUrl: string | null = null
    setUrl(null)
    setPlaying(false)
    setTime(0)
    void api.getSessionAudio(id).then((bytes) => {
      if (!bytes) return
      objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }))
      setUrl(objectUrl)
    })
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id])

  if (!url) return null
  const width = 16
  const filled = duration ? Math.round((time / duration) * width) : 0
  const toggle = () => {
    const a = audio.current
    if (!a) return
    if (a.paused) void a.play().then(() => setPlaying(true))
    else {
      a.pause()
      setPlaying(false)
    }
  }
  return (
    <Row label="audio" hint="the original recording" actions={<Action onClick={toggle}>{playing ? 'pause' : 'play'}</Action>}>
      <audio
        ref={audio}
        src={url}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
      />
      <span>
        <span className="hi">{clock(time)}</span>
        <span className="dim"> / {clock(duration)}</span>
      </span>
      <Track cells={width}>
        <span className="acc">{'━'.repeat(filled)}</span>
        <span className="muted">{'─'.repeat(width - filled)}</span>
      </Track>
    </Row>
  )
}

function Detail({ session, engine, onChanged }: { session: Session; engine: EngineId; onChanged: (s: Session | null) => void }) {
  const t = session.transcription
  const [spoken, setSpoken] = useState(t.language)
  const [style, setStyle] = useState<Style>(session.style)
  const [output, setOutput] = useState(session.outputLanguage)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSpoken(t.language)
    setStyle(session.style)
    setOutput(session.outputLanguage)
    setError(null)
  }, [session.id, t.language, session.style, session.outputLanguage])

  const reprocess = () => {
    setBusy(true)
    setError(null)
    api
      .reprocessSession(session.id, style, output, spoken)
      .then(onChanged)
      .catch((e: Error) => setError(ipcError(e)))
      .finally(() => setBusy(false))
  }

  // What auto-detect heard, when it did.
  const heard = t.detected ? `${lang(t.detected)} (detected)` : lang(t.language)
  const created = new Date(session.createdAt)
  return (
    <>
      <section>
        <Sep
          tail={
            <>
              <Action onClick={() => api.revealSession(session.id)}>files</Action>
              <Action danger onClick={() => void api.deleteSession(session.id).then(() => onChanged(null))}>
                delete
              </Action>
            </>
          }
        >
          {ymd(created)} {hms(created)}
        </Sep>
        {session.hasAudio && <AudioRow id={session.id} />}
        <Row label="speech" hint="transcription engine and model">
          <span>
            {t.engine}{' '}
            <span className="dim">
              · {t.model} · {(t.ms / 1000).toFixed(1)}s
            </span>
          </span>
        </Row>
        <Row label="languages">
          {heard} → {session.outputLanguage === 'same' ? lang(t.detected ?? t.language) : lang(session.outputLanguage)}
        </Row>
        {session.action && (
          <Row label="outcome">
            <span className={ACTION_TONE[session.action]}>{session.action}</span>
          </Row>
        )}
      </section>

      <section>
        <Sep tail={<Action onClick={() => api.copyText(session.text)}>copy</Action>}>result</Sep>
        <p className="block-text hi selectable">{session.text}</p>
      </section>

      <section>
        <Sep tail={<Action onClick={() => api.copyText(t.text)}>copy</Action>}>transcript</Sep>
        <p className="block-text dim selectable">{t.text}</p>
      </section>

      {session.context && (
        <section>
          <Sep tail={<Action onClick={() => api.copyText(session.context!)}>copy</Action>}>selected text</Sep>
          <p className="block-text dim selectable">{session.context}</p>
        </section>
      )}

      <section>
        <Sep>re-process</Sep>
        {session.hasAudio && (
          <Row label="spoken" hint="transcribe the recording again in another language">
            <Dropdown value={spoken} onChange={setSpoken} options={spokenOptions(engine, t.language, t.detected)} />
          </Row>
        )}
        <Row label="style">
          <Dropdown<Style> value={style} onChange={setStyle} options={styleOptions} />
        </Row>
        <Row label="output" actions={busy ? <Spinner /> : <Action onClick={reprocess}>run</Action>}>
          <Dropdown value={output} onChange={setOutput} options={outputOptions} />
        </Row>
        {error && <p className="under error">✗ {error}</p>}
      </section>

      {session.versions.length > 0 && (
        <section>
          <Sep>versions ({session.versions.length})</Sep>
          {session.versions.map((v) => (
            <div key={v.id} className="version">
              <p className="dim">
                {hms(new Date(v.at))} · {v.kind}
                {v.inputLanguage ? ` · from ${lang(v.inputLanguage)}` : ''}
                {v.style ? ` · ${v.style}` : ''}
                {v.outputLanguage ? ` · ${lang(v.outputLanguage)}` : ''}
                {v.model ? ` · ${shortModel(v.model)}` : ''}
                {v.instruction ? ` · “${v.instruction}”` : ''}
              </p>
              <p className="selectable">{v.text}</p>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

/** `onSetup` opens settings → general, where a new install finishes its setup. */
export function History({ config, onSetup }: { config: Config; onSetup: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(() => void api.listSessions(query, 300).then(setSessions), [query])
  useEffect(() => {
    load()
    return api.onHistoryChanged(load)
  }, [load])

  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0]

  return (
    <div className="history">
      <div className="history-list">
        <label className="search">
          <span className="acc">/</span>
          <input placeholder="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="history-items">
          {!config.history.enabled && <p className="empty">history is off · settings → general → keep history</p>}
          {sessions.length === 0 && (
            <p className="empty">
              {query ? 'no match' : 'no dictations yet'}
              {!query &&
                (config.onboarded ? (
                  <span className="acc">{displayShortcut(config.shortcuts.record)} anywhere to start</span>
                ) : (
                  <span className="setup">
                    first, <Action onClick={onSetup}>set up speak</Action>
                  </span>
                ))}
            </p>
          )}
          {sessions.map((s) => (
            <button key={s.id} className={`item ${selected?.id === s.id ? 'on' : ''}`} onClick={() => setSelectedId(s.id)}>
              <span className="meta">
                <span>{when(s.createdAt)}</span>
                {s.action && <span className={ACTION_TONE[s.action]}>{s.action}</span>}
              </span>
              <span className="text">{s.text || s.transcription.text}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="history-detail">
        <div className="page-inner">
          {selected && (
            <Detail
              session={selected}
              engine={config.transcription.engine}
              onChanged={(s) => (s ? setSessions((list) => list.map((x) => (x.id === s.id ? s : x))) : load())}
            />
          )}
        </div>
      </div>
    </div>
  )
}
