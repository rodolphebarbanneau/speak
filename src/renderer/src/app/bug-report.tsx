import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bugReportMarkdown, bugReportUrl, type BugReport } from '@shared/bug-report'
import type { AgentStatus, Config } from '@shared/types'
import { Action, Check, Key, MOD, Sep, Spinner } from '../components/ui'

const api = window.speak

/**
 * "report a bug", a dialog over the window from the bug in the title row or the tray: the user says
 * what they saw, their AI provider reads it with Speak's diagnostics and writes the report
 * (main/bug-reporter.ts), the user reads it all and opens it on GitHub's bug form, where they read it
 * again before submitting it. Nothing is sent from here. Settings can open over it, to check
 * something: it waits behind, as it was. Its words name no provider: "the ai" is whichever is set.
 */

type Step =
  { kind: 'write' } | { kind: 'working'; analyze: boolean } | { kind: 'review'; report: BugReport } | { kind: 'opened'; report: BugReport; shortened: boolean }

/** The description, kept while the window is open: going to the settings to check something doesn't lose it. */
let draft = ''

/** Seconds since the analysis began: it can take a minute, and the user sees it moving. */
function Elapsed() {
  const [since] = useState(() => Date.now())
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="dim">· {Math.floor((Date.now() - since) / 1000)}s</span>
}

function Field({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
    </label>
  )
}

export function BugReportDialog({ config, screen, onClose }: { config: Config; screen: string; onClose: () => void }) {
  const provider = config.ai.provider
  const box = useRef<HTMLDivElement>(null)
  // Where the focus was before the dialog (before its field took it): it goes back there after.
  const [before] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) box.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [before])
  const [agent, setAgent] = useState<AgentStatus | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'write' })
  const [words, setWords] = useState(draft)
  const [analyze, setAnalyze] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const working = useRef(false)
  working.current = step.kind === 'working'
  // Closed while the AI works: it stops, and what it would have written is lost.
  useEffect(
    () => () => {
      mounted.current = false
      if (working.current) api.cancelBugReport()
    },
    []
  )
  useEffect(() => {
    if (provider !== 'none') void api.getAgentStatus(provider).then((s) => mounted.current && setAgent(s))
  }, [provider])
  const checking = provider !== 'none' && !agent
  const ready = provider !== 'none' && !!agent?.found && agent.loggedIn !== false
  const asked = analyze && ready

  const write = (text: string) => {
    draft = text
    setWords(text)
  }
  const prepare = () => {
    if (!words.trim() || step.kind !== 'write') return
    setFailure(null)
    setStep({ kind: 'working', analyze: asked })
    api
      .prepareBugReport({ description: words, screen, analyze: asked })
      .then((report) => mounted.current && setStep({ kind: 'review', report }))
      // Never a report Speak couldn't scrub: back to the words, with what went wrong.
      .catch((err: Error) => {
        if (!mounted.current) return
        setFailure(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        setStep({ kind: 'write' })
      })
  }
  const report = step.kind === 'review' ? step.report : null
  const edit = (patch: Partial<BugReport>) => report && setStep({ kind: 'review', report: { ...report, ...patch } })
  const sent = report ? bugReportUrl(report) : null
  const publish = () => {
    if (!report || !sent || !report.title.trim()) return
    api.openExternal(sent.url)
    draft = ''
    setStep({ kind: 'opened', report, shortened: sent.shortened })
  }
  // The whole report: from the review, or after opening a shortened one, to paste in a comment.
  const copyable = step.kind === 'review' || (step.kind === 'opened' && step.shortened) ? step.report : null
  const copy = () => {
    if (!copyable) return
    api.copyText(bugReportMarkdown(copyable))
    setCopied(true)
    setTimeout(() => mounted.current && setCopied(false), 2000)
  }

  // mod+enter: the step's main action (enter alone writes a new line). Esc never drops a report
  // the AI took a minute to write: it leaves the other steps, or stops the analysis. On the window,
  // since the steps without a text field leave nothing focused; not the keys of settings over it.
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Enter' && mod) {
      e.preventDefault()
      if (step.kind === 'write') prepare()
      else if (step.kind === 'review') publish()
      else if (step.kind === 'opened') onClose()
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && copyable) {
      e.preventDefault()
      copy()
    } else if (e.key === 'Escape' && step.kind !== 'review') {
      e.preventDefault()
      if (step.kind === 'working' && step.analyze) api.cancelBugReport()
      else onClose()
    }
  }
  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    // Only when it's in front: settings or the setup can open over it. And not a key a dialog in
    // front already took: closing, it may be gone by the time this listener runs.
    const listener = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (!e.defaultPrevented && dialogs[dialogs.length - 1] === box.current) keys.current(e)
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  // A click beside it closes it as Esc does, never over a report being written or to review.
  const closable = step.kind === 'write' || step.kind === 'opened'
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closable && onClose()}>
      <div ref={box} className="dialog bug" role="dialog" aria-modal="true" aria-label="report a bug" tabIndex={-1}>
        <div className="page">
          <div className="page-inner">
            {step.kind === 'write' && (
              <>
                <section>
                  <Sep>what happened</Sep>
                  <p className="block-text">
                    describe what went wrong: speak turns it into a report for its developers, which you review before anything is shared.
                  </p>
                  <Field>
                    <textarea
                      className="words"
                      autoFocus
                      value={words}
                      spellCheck={false}
                      onChange={(e) => write(e.target.value)}
                      placeholder="what you did, what you expected, what happened instead · any language"
                    />
                  </Field>
                  {failure && <p className="line red">✗ couldn't prepare the report: {failure}</p>}
                  <div className="check-line">
                    <Check checked={asked} disabled={!ready} onChange={setAnalyze} />
                    <span>
                      <span className={ready ? '' : 'dim'}>analyze with ai</span>
                      <span className="dim">
                        {' · '}
                        {ready
                          ? 'suggests how to reproduce it and where it may come from'
                          : checking
                            ? 'checking the ai…'
                            : provider === 'none'
                              ? 'ai is off (settings → ai)'
                              : "the ai isn't ready (settings → ai)"}
                      </span>
                    </span>
                  </div>
                </section>
                <section>
                  <Sep>privacy</Sep>
                  <ul className="facts">
                    <li>
                      nothing is sent from here: the report opens on github, where you review it and submit it yourself (with a github account; issues are
                      public)
                    </li>
                    <li>
                      the ai only reads your description and speak's diagnostics (settings, the pill, recent dictations without their text, the end of the log),
                      with no tools and no web
                    </li>
                    <li>personal details are taken out: your user name and home folder, the windows you dictated into, emails, phone and account numbers</li>
                    <li>what you dictated is never included, but your description is shared as written: leave out names and addresses</li>
                  </ul>
                </section>
              </>
            )}

            {step.kind === 'working' && (
              <section>
                <Sep>{step.analyze ? 'analyzing' : 'preparing'}</Sep>
                <p className="line" role="status">
                  <Spinner /> {step.analyze ? 'the ai is reading your description and the diagnostics' : 'preparing the report'} <Elapsed />
                </p>
                {step.analyze && <p className="note">usually under a minute · stop to get the report without the analysis</p>}
              </section>
            )}

            {report && (
              <section>
                <Sep>review</Sep>
                {report.problem ? (
                  <p className="line red">✗ {report.problem}</p>
                ) : (
                  report.analyzedBy && (
                    <p className="note">
                      analysis by {report.analyzedBy.toLowerCase()} · in english, like the project's issues · your description is kept as written
                    </p>
                  )
                )}
                <Field label="title">
                  <input value={report.title} spellCheck={false} onChange={(e) => edit({ title: e.target.value })} />
                </Field>
                <Field label="what happened">
                  <textarea value={report.what} spellCheck={false} onChange={(e) => edit({ what: e.target.value })} />
                </Field>
                {(report.analyzedBy || report.steps) && (
                  <Field label="steps to reproduce">
                    <textarea value={report.steps} spellCheck={false} onChange={(e) => edit({ steps: e.target.value })} />
                  </Field>
                )}
                {(report.analyzedBy || report.analysis) && (
                  <Field label="analysis">
                    <textarea className="analysis" value={report.analysis} spellCheck={false} onChange={(e) => edit({ analysis: e.target.value })} />
                  </Field>
                )}
                <Field label={`diagnostics · speak ${report.version} · ${report.system} · ai ${report.ai}`}>
                  <textarea className="diagnostics" value={report.diagnostics} spellCheck={false} onChange={(e) => edit({ diagnostics: e.target.value })} />
                </Field>
                <p className="note">
                  read it all: change anything, and take out what looks personal · "open on github" opens speak's bug form, filled in
                  {sent?.shortened && ' · too long for a link: github gets a shortened report, "copy" keeps it whole'}
                </p>
              </section>
            )}

            {step.kind === 'opened' && (
              <section>
                <Sep>opened on github</Sep>
                <p className="block-text">
                  the bug form is open in your browser: review it, then submit it with "create". thank you, it helps make speak better.
                </p>
                {step.shortened && <p className="note">it's shortened there: "copy" the whole report and paste it in a comment</p>}
              </section>
            )}
          </div>
        </div>

        <div className="keys-bar">
          {step.kind === 'write' && (
            <>
              <Key k={`${MOD}+enter`} primary onClick={prepare} disabled={!words.trim()}>
                {asked ? 'analyze' : 'prepare report'}
              </Key>
              <Key k="esc" onClick={onClose}>
                cancel
              </Key>
            </>
          )}
          {step.kind === 'working' && (
            <Key k="esc" onClick={() => (step.analyze ? api.cancelBugReport() : onClose())}>
              {step.analyze ? 'stop' : 'cancel'}
            </Key>
          )}
          {report && (
            <>
              <Key k={`${MOD}+enter`} primary onClick={publish} disabled={!report.title.trim()}>
                open on github ↗
              </Key>
              <Key k={`${MOD}+shift+c`} onClick={copy}>
                {copied ? 'copied ✓' : 'copy'}
              </Key>
              <Action onClick={() => setStep({ kind: 'write' })}>edit description</Action>
            </>
          )}
          {step.kind === 'opened' && (
            <>
              <Key k={`${MOD}+enter`} primary onClick={onClose}>
                close
              </Key>
              {step.shortened && (
                <Key k={`${MOD}+shift+c`} onClick={copy}>
                  {copied ? 'copied ✓' : 'copy'}
                </Key>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
