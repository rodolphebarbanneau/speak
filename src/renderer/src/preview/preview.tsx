import { useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGES, shortModel, STYLES } from '@shared/constants'
import type { PreviewState, Style } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, displayShortcut, Key, MOD, Sep, Spinner, TitleBar, useWindowFocus } from '../components/ui'

const api = window.speak

const styleOptions = STYLES.map((s) => ({ value: s.id, label: s.label.toLowerCase() }))
const outputOptions = [{ value: 'same', label: 'as spoken' }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name.toLowerCase() }))]
const langName = (code: string) => (code === 'auto' ? 'auto' : code === 'same' ? 'same' : code)

export function Preview() {
  useWindowFocus()
  const [state, setState] = useState<PreviewState | null>(null)
  const [text, setText] = useState('')
  const [recordShortcut, setRecordShortcut] = useState('')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const versionKey = state ? `${state.session.id}:${state.session.versions.length}:${state.session.text.length}` : ''

  useEffect(() => {
    const off = api.onPreview(setState)
    api.previewReady()
    void api.getConfig().then((c) => setRecordShortcut(displayShortcut(c.shortcuts.record)))
    return off
  }, [])

  // Reset the editor whenever a new session or version arrives.
  useEffect(() => {
    if (!state) return
    setText(state.session.text)
    setTimeout(() => {
      const el = editorRef.current
      if (!el || state.busy) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 30)
  }, [versionKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const busy = state?.busy ?? null
  const session = state?.session

  const actions = useMemo(
    () => ({
      insert: () => text.trim() && api.previewInsert(text),
      copy: () => text.trim() && api.previewCopy(text),
      cancel: () => api.previewCancel(),
      voiceEdit: () => api.previewVoiceEdit(),
      undo: () => api.previewUndo()
    }),
    [text]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.ctrlKey || e.metaKey
      const inSelect = e.target instanceof HTMLSelectElement
      if (e.key === 'Escape') {
        e.preventDefault()
        actions.cancel()
      } else if (e.key === 'Enter' && !e.shiftKey && !inSelect) {
        // Enter inserts; Shift+Enter adds a new line in the editor.
        e.preventDefault()
        if (!busy || busy === 'listening') actions.insert()
      } else if (cmd && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        actions.copy()
      } else if (cmd && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        actions.voiceEdit()
      } else if (cmd && e.key.toLowerCase() === 'z' && !e.shiftKey && session && text === session.text && session.versions.length > 0) {
        // Undo the last AI/voice change when the editor has no pending manual edits.
        e.preventDefault()
        actions.undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, busy, session, text])

  if (!state || !session) {
    return (
      <div className="frame">
        <TitleBar>
          <b>speak</b> · preview
        </TitleBar>
        <div className="preview-body dim">waiting for dictation…</div>
      </div>
    )
  }

  const reprocess = (style: Style, lang: string) => api.previewReprocess(style, lang)
  const last = session.versions[session.versions.length - 1]
  const working = busy === 'transcribing' || busy === 'processing'

  return (
    <div className="frame">
      <TitleBar
        right={
          <span>{`${langName(session.transcription.language)} → ${langName(session.outputLanguage === 'same' ? session.transcription.language : session.outputLanguage)}`}</span>
        }
      >
        <b>speak</b> · preview
      </TitleBar>

      <div className="preview-body">
        {state.error && <div className="line error">✗ {state.error}</div>}
        <textarea ref={editorRef} className="editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} disabled={working} />
        <Sep tail={text !== session.transcription.text && <Action onClick={() => setText(session.transcription.text)}>use original</Action>}>transcript</Sep>
        <div className="transcript">{session.transcription.text}</div>
      </div>

      <div className="preview-meta">
        {busy === 'listening' ? (
          <span>
            <span className="red blink">●</span> listening for your edit{' '}
            <span className="dim">
              · {MOD}+e or {recordShortcut} to finish
            </span>
          </span>
        ) : working ? (
          <span>
            <Spinner /> {busy === 'transcribing' ? 'transcribing' : 'processing'}…
          </span>
        ) : (
          <>
            <span>
              <span className="dim">style</span>{' '}
              <Dropdown<Style> value={session.style} options={styleOptions} onChange={(v) => reprocess(v, session.outputLanguage)} />
            </span>
            <span>
              <span className="dim">output</span>{' '}
              <Dropdown value={session.outputLanguage} options={outputOptions} onChange={(v) => reprocess(session.style, v)} />
            </span>
            {state.targetTitle && (
              <span className="target" title={state.targetTitle}>
                <span className="dim">→</span> {state.targetTitle}
              </span>
            )}
            {last?.model && (
              <span>
                <span className="dim">{last.kind === 'edit' ? 'edited by' : 'by'}</span> {shortModel(last.model)}
                {last.ms ? <span className="dim"> · {(last.ms / 1000).toFixed(1)}s</span> : ''}
              </span>
            )}
          </>
        )}
      </div>

      <div className="preview-keys">
        <Key k="enter" primary onClick={actions.insert} disabled={!text.trim() || working}>
          insert
        </Key>
        <Key k={`${MOD}+e`} onClick={actions.voiceEdit} disabled={working} danger={busy === 'listening'}>
          {busy === 'listening' ? 'stop' : 'edit by voice'}
        </Key>
        <Key k={`${MOD}+z`} onClick={actions.undo} disabled={!!busy || session.versions.length === 0}>
          undo
        </Key>
        <Key k={`${MOD}+shift+c`} onClick={actions.copy} disabled={!text.trim()}>
          copy
        </Key>
        <Key k="esc" onClick={actions.cancel}>
          cancel
        </Key>
      </div>
    </div>
  )
}
