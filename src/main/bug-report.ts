import type { BugReport } from '../shared/bug-report'
import type { Session } from '../shared/types'

/**
 * The pure part of "report a bug" (bug-reporter.ts runs it): what is scrubbed out of a report, the
 * diagnostics it joins, and what the AI is asked. The report is public: every field goes through
 * `scrub`, the AI's answer too, and the user reads it all again on GitHub before submitting it.
 */

/** Where the user's identity shows in technical text: their home folder, their account's name. */
export interface Machine {
  home: string
  user: string
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Patterns of what may be someone's, with what replaces them. */
const PERSONAL: [RegExp, string][] = [
  // The window dictated into: its title may name a document, a chat or an email.
  [/(Focus target: )"[^"\n]*"/g, '$1"<window>"'],
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, '<email>'],
  [/(?<![\w+])\+\d{1,3}(?:[\s.-]?\d{1,4}){3,6}(?!\d)/g, '<phone>'],
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, '<iban>'],
  // Nine digits or more: a phone, card or account number. Times, sizes and durations are shorter runs.
  [/(?<![\d.])\d(?:[ ]?\d){8,}(?![\d])/g, '<number>']
]

/**
 * `text` without what could identify someone: the home folder as ~, the account's name, the
 * window dictated into, then emails, owners' names on devices, phone numbers, IBANs, long numbers
 * and addresses past their site. Run on everything a report holds, the AI's answer included.
 */
export function scrub(text: string, machine: Machine): string {
  if (!text) return text
  let out = text
  const home = machine.home.replace(/[\\/]+$/, '')
  if (home.length > 3) {
    // As Node, a file URL or JSON writes it: \, / or \\ between its parts.
    const parts = home.split(/[\\/]+/).map(escape)
    out = out.replace(new RegExp(parts.join('(?:\\\\{1,2}|/)'), 'gi'), '~')
  }
  if (machine.user.length >= 3) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(machine.user)}(?![\\p{L}\\p{N}])`, 'giu'), '<user>')
  // An address keeps its site only.
  out = out.replace(/\b(https?:\/\/[^\s/"'<>)\]]+)\/[^\s"'<>)\]]+/gi, '$1/…')
  for (const [pattern, mark] of PERSONAL) out = out.replace(pattern, mark)
  // A microphone named after its owner, as the log quotes it: "Jane's AirPods".
  return out.replace(/"[^"\n]*"/g, (quoted) => quoted.replace(/(?<![\p{L}\p{N}])\p{Lu}\p{Ll}+['’]s(?![\p{L}\p{N}])/gu, "<name>'s"))
}

/** At most `lines` lines from the end of the log, each cut to `width` characters. */
export function logTail(text: string, lines = 60, width = 240): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .map((l) => (l.length > width ? `${l.slice(0, width)}…` : l))
    .join('\n')
}

const oneLine = (s: string, width = 160) => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, width)}…` : line
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/**
 * The last dictations, the latest last: when, how long, how they were transcribed and processed,
 * and how they ended. Never what was said, written or selected.
 */
export function dictationsCourse(sessions: Session[]): string {
  if (!sessions.length) return 'none in the history'
  return [...sessions]
    .reverse()
    .map((s) => {
      const t = s.transcription
      const heard = t.detected && t.detected !== t.language ? `${t.language} (heard ${t.detected})` : t.language
      const ai = s.versions.filter((v) => v.provider).at(-1)
      const kinds = [...new Set(s.versions.map((v) => v.kind))].join(', ')
      const parts = [
        s.createdAt.slice(0, 16).replace('T', ' '),
        seconds(s.durationMs),
        `${t.engine}/${t.model} in ${seconds(t.ms)}`,
        `${heard} → ${s.outputLanguage}`,
        s.style,
        ai ? `${ai.provider}/${ai.model}${ai.ms ? ` in ${seconds(ai.ms)}` : ''}` : 'no ai',
        kinds && `versions: ${kinds}`,
        s.context !== undefined && 'with selected text',
        s.action ?? 'no action'
      ]
      const line = `- ${parts.filter(Boolean).join(' · ')}`
      return s.error ? `${line}\n  error: ${oneLine(s.error, 240)}` : line
    })
    .join('\n')
}

/** The facts the diagnostics are written from. */
export interface Facts {
  app: string
  system: string
  displays: string
  transcription: string
  ai: string
  settings: string
  permissions: string
  pill: string
  screen: string
  errors: string[]
  dictations: string
  log: string
}

/** The diagnostics, in the order the report's address keeps them when it must shorten them: the environment first, the log's latest last. */
export function diagnosticsText(f: Facts): string {
  const errors = f.errors.length ? f.errors.slice(-10).map((e) => `- ${oneLine(e, 300)}`) : ['none']
  return [
    `App: ${f.app}`,
    `System: ${f.system}`,
    `Displays: ${f.displays}`,
    `Transcription: ${f.transcription}`,
    `AI: ${f.ai}`,
    `Settings: ${f.settings}`,
    `Permissions: ${f.permissions}`,
    `Pill: ${f.pill}`,
    `Screen: ${f.screen}`,
    '',
    'Window errors:',
    ...errors,
    '',
    'Last dictations, the latest last:',
    f.dictations,
    '',
    'Log, the latest last:',
    f.log || '(empty)'
  ].join('\n')
}

/** What the AI is told: the report's instructions, in English as the project's issues are. */
export const ANALYSIS_PROMPT = `You help a user of Speak report a bug to its developers on GitHub. Speak is a desktop voice dictation app (Electron, React, TypeScript) for Windows, macOS and Linux: a global shortcut starts recording from the microphone, a small always-on-top window (the "pill") shows the recording, whisper.cpp or NVIDIA Parakeet transcribes it on the computer, then the user's own Claude Code or Codex command-line program can clean it up, restyle, translate or compose from it, and the text is pasted where the cursor is or shown in a preview window first. The main window holds the history and the settings.

You receive the user's own words, in any language, and Speak's diagnostics: its version, the system and displays, the transcription and AI settings, the permissions, the state of the pill, the screen the user was on, the windows' last errors, the course of the last dictations (never their words) and the end of Speak's log.

Write what the developers need to reproduce the bug and find its cause. Answer with one JSON object and nothing else:
{"title": "...", "steps": "...", "analysis": "..."}

- title: one line under 80 characters saying what fails and where, e.g. "Pill stays hidden while recording on a second display".
- steps: numbered steps to reproduce, from the user's words and the diagnostics; write "Unknown" for what they don't tell.
- analysis: Markdown under these headings: "#### Expected", "#### Actual", "#### Evidence" (the log lines or errors that bear on it, quoted in a code block, 15 lines at most; "None in the diagnostics" if there are none), "#### Likely cause" (the part of Speak at fault and why, said as a hypothesis when it is one).

Write in English, whatever language the user wrote in. The report is public: never write a name, an address, a number, an email or anything else personal, even if you see one; keep <marks> such as <user> or <window> as they are and never guess what they stand for. Say what the diagnostics don't show rather than invent. You have no tools: answer from what you were given.`

/** The user's turn: their words, then the diagnostics. */
export const analysisMessage = (words: string, diagnostics: string) =>
  `What the user saw, in their words:\n\n${words.trim() || '(nothing written)'}\n\nSpeak's diagnostics:\n\n${diagnostics}`

/** What the AI's answer gives the report: its JSON, fenced or not; anything else as the analysis. */
export function parseAnalysis(answer: string): Pick<BugReport, 'title' | 'steps' | 'analysis'> {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      const field = (k: string) => (typeof json[k] === 'string' ? (json[k] as string).trim() : '')
      if (field('analysis') || field('steps')) return { title: oneLine(field('title'), 120), steps: field('steps'), analysis: field('analysis') }
    } catch {
      // Not JSON after all: the text is the analysis.
    }
  }
  return { title: '', steps: '', analysis: text }
}

/** A title from the user's words when the AI gave none: their first line, short. */
export const titleFrom = (words: string): string => oneLine(words.split('\n').find((l) => l.trim()) ?? '', 80) || 'Bug report'
