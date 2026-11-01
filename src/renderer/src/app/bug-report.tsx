import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bugReportMarkdown, bugReportUrl, type BugReport } from '@shared/bug-report'
import type { AgentStatus, Config } from '@shared/types'
import { Action, Check, Key, MOD, Sep, Spinner } from '../components/ui'

const api = window.speak

const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const

/**
 * "report a bug", from the bug in the title row or the tray: the user says what they saw, their AI
 * provider reads it with Speak's diagnostics and writes the report (main/bug-reporter.ts), the user
 * reads it all and opens it on GitHub's bug form, where they read it again before submitting it.
 * Nothing is sent from here.
 */

type Step = { kind: 'write' } | { kind: 'working'; analyze: boolean } | { kind: 'review'; report: BugReport } | { kind: 'opened'; shortened: boolean }

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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  )
}

export function BugReportPage({ config, screen, onClose }: { config: Config; screen: string; onClose: () => void }) {
  const provider = config.ai.provider
  const name = provider === 'none' ? null : AGENT_NAMES[provider]
  const [agent, setAgent] = useState<AgentStatus | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'write' })
  const [words, setWords] = useState(draft)
  const [analyze, setAnalyze] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const working = useRef(false)
  working.current = step.kind === 'working'
  // Left while the AI works (cancel, or another page): it stops, and what it would have written is lost.
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
  const checking = !!name && !agent
  const ready = !!name && !!agent?.found && agent.loggedIn !== false
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
    setStep({ kind: 'opened', shortened: sent.shortened })
  }
  const copy = () => {
    if (!report) return
    api.copyText(bugReportMarkdown(report))
    setCopied(true)
    setTimeout(() => mounted.current && setCopied(false), 2000)
  }

  // mod+enter: the step's main action (enter alone writes a new line). Esc never drops a report
  // the AI took a minute to write: it leaves the other steps, or stops the analysis. On the window,
  // since the steps without a text field leave nothing focused.
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Enter' && mod) {
      e.preventDefault()
      if (step.kind === 'write') prepare()
      else if (step.kind === 'review') publish()
      else if (step.kind === 'opened') onClose()
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && step.kind === 'review') {
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
    const listener = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  return (
    <div className="bug">
      <div className="page">
        <div className="page-inner">
          {step.kind === 'write' && (
            <section>
              <Sep>report a bug</Sep>
              <p className="block-text">
                Say what you saw. {ready ? `${name} will turn it into` : 'Speak will make it'} a report for the people who build Speak: what happened, how to
                make it happen again, where it may come from.
              </p>
              <Field label="what happened">
                <textarea
                  className="words"
                  autoFocus
                  value={words}
                  spellCheck={false}
                  onChange={(e) => write(e.target.value)}
                  placeholder="what you were doing, what you expected, what speak did instead (any language)"
                />
              </Field>
              {failure && <p className="line red">✗ the report could not be prepared: {failure}</p>}
              <div className="check-line">
                <Check checked={asked} disabled={!ready} onChange={setAnalyze} />
                <span className={ready ? '' : 'dim'}>
                  {ready
                    ? `analyze with ${name}, with no tools and no web: your words, the settings, the pill, the last dictations without their words, the end of the log`
                    : checking
                      ? `checking ${name}…`
                      : name
                        ? `${name} isn't ready (settings → ai): the report will have no analysis`
                        : 'ai is off (settings → ai): the report will have no analysis'}
                </span>
              </div>
              <p className="note">
                Nothing is sent from here. The report opens on GitHub, where you read it before submitting it, with a GitHub account. It will be public: Speak
                first takes out what it knows to be personal (your user name and folder, the windows you dictated into, emails, numbers), and never includes
                what you dictated. Don't write names, addresses or numbers.
              </p>
            </section>
          )}

          {step.kind === 'working' && (
            <section>
              <Sep>report a bug</Sep>
              <p className="line" role="status">
                <Spinner /> {step.analyze ? `${name} is reading the diagnostics and writing the report` : 'preparing the report'} <Elapsed />
              </p>
              {step.analyze && <p className="note">Usually under a minute. With no tools and no web: it reads only what Speak gives it.</p>}
            </section>
          )}

          {report && (
            <section>
              <Sep>report</Sep>
              {report.problem ? (
                <p className="line red">✗ {report.problem}</p>
              ) : (
                report.analyzedBy && <p className="note">Written by {report.analyzedBy}, in English like the project's issues. Your words stay yours.</p>
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
                Read it all: you can change anything, and take out what looks personal. "open on github" opens Speak's bug form, filled in.
                {sent?.shortened && ' The report is too long for a link, so it is shortened there: "copy" keeps it whole.'}
              </p>
            </section>
          )}

          {step.kind === 'opened' && (
            <section>
              <Sep>report a bug</Sep>
              <p className="block-text">The form is open in your browser. Read it, then "Create" submits it. Thank you: that's how Speak gets better.</p>
              {step.shortened && <p className="note">It is shortened there: paste the copied report in a comment to give it whole.</p>}
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
            <Action onClick={() => setStep({ kind: 'write' })}>back to my words</Action>
          </>
        )}
        {step.kind === 'opened' && (
          <Key k={`${MOD}+enter`} primary onClick={onClose}>
            close
          </Key>
        )}
      </div>
    </div>
  )
}
