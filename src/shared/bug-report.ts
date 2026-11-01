import { REPO_URL } from './constants'

/**
 * "report a bug": the user's words and Speak's diagnostics, written up by their own AI provider,
 * then opened on GitHub's bug form (.github/ISSUE_TEMPLATE/bug.yml) for them to read again and
 * submit. Nothing is sent from the app: the report travels in the form's address.
 */

/** What the main window asks for. */
export interface BugReportRequest {
  /** What the user saw, in their words. */
  description: string
  /** Where they were in the main window: "history", "settings · ai"… */
  screen: string
  /** Have the AI provider analyze; false: the report holds the user's words and the diagnostics alone. */
  analyze: boolean
}

/** A report for GitHub's bug form, each field scrubbed of anything personal Speak knows of. */
export interface BugReport {
  title: string
  /** The user's own words. */
  what: string
  steps: string
  /** The AI's analysis (Markdown): expected, actual, evidence, likely cause. */
  analysis: string
  version: string
  system: string
  /** The AI provider and its model, or "none". */
  ai: string
  /** The environment, the settings, the windows' errors, the last dictations (never their words), the log's end. */
  diagnostics: string
  /** The provider that wrote the analysis, or null. */
  analyzedBy: string | null
  /** Why there is no analysis, when one was asked for. */
  problem?: string
}

/** The fields of the form the report fills, by their ids in bug.yml: text fields all, which GitHub fills from the address. */
export const BUG_FORM_FIELDS = ['what', 'steps', 'analysis', 'version', 'system', 'ai', 'diagnostics'] as const

/** GitHub answers "414 URI Too Long" past about 8 KB of address: stay under it, with room to spare. */
export const MAX_URL_LENGTH = 7500

const address = (r: BugReport): string => {
  const query = new URLSearchParams({ template: 'bug.yml', title: r.title })
  for (const field of BUG_FORM_FIELDS) if (r[field].trim()) query.set(field, r[field])
  return `${REPO_URL}/issues/new?${query.toString()}`
}

/** `text` cut to `chars`, with a mark where it was cut. */
const cut = (text: string, chars: number): string => (text.length <= chars ? text : `${text.slice(0, Math.max(0, chars)).trimEnd()}\n[…]`)

/** The diagnostics' first lines (the environment and settings) and their last `tail` (the log's latest), the middle left out. */
function shorten(diagnostics: string, tail: number): string {
  const lines = diagnostics.split('\n')
  const head = 16
  if (lines.length <= head + tail) return diagnostics
  const left = lines.length - head - tail
  return [...lines.slice(0, head), `[… ${left} line${left > 1 ? 's' : ''} left out …]`, ...(tail ? lines.slice(-tail) : [])].join('\n')
}

/**
 * The address of the bug form filled with `report`. When it's too long for GitHub, the diagnostics
 * give way first, from the middle of the log, then the analysis, then the user's words: `shortened`
 * says so, and the full report is there to copy.
 */
export function bugReportUrl(report: BugReport): { url: string; shortened: boolean } {
  let r = report
  let url = address(r)
  if (url.length <= MAX_URL_LENGTH) return { url, shortened: false }
  const lines = r.diagnostics.split('\n').length
  for (let tail = lines; tail >= 0 && url.length > MAX_URL_LENGTH; tail -= 4) url = address((r = { ...report, diagnostics: shorten(report.diagnostics, tail) }))
  for (const field of ['analysis', 'what', 'steps'] as const) {
    while (url.length > MAX_URL_LENGTH && r[field].length > 200) {
      // An encoded character takes up to nine: cut by what is over, at least a tenth.
      const over = Math.max(Math.ceil((url.length - MAX_URL_LENGTH) / 3), Math.ceil(r[field].length / 10))
      url = address((r = { ...r, [field]: cut(r[field], r[field].length - over) }))
    }
  }
  return { url, shortened: true }
}

/** The whole report as GitHub shows it once submitted, to copy and paste. */
export function bugReportMarkdown(r: BugReport): string {
  const sections: [string, string][] = [
    ['What happened', r.what],
    ['Steps to reproduce', r.steps],
    ['Analysis', r.analysis],
    ['Version', r.version],
    ['Operating system', r.system],
    ['AI provider', r.ai],
    ['Diagnostics', r.diagnostics ? '```text\n' + r.diagnostics + '\n```' : '']
  ]
  return [`# ${r.title}`, ...sections.filter(([, text]) => text.trim()).map(([heading, text]) => `### ${heading}\n\n${text.trim()}`)].join('\n\n') + '\n'
}
