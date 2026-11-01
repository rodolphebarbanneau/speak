/**
 * The windows' uncaught errors, for "report a bug": each goes to the main process, which keeps the
 * last ones in memory only (an error's message may quote what was on screen), never on disk.
 */

const api = window.speak

/** An error's message and where it was thrown: the first lines of its stack. */
export function describeError(error: unknown, fallback = ''): string {
  if (error instanceof Error) {
    const at = (error.stack ?? '')
      .split('\n')
      .slice(1, 4)
      .map((l) => l.trim())
      .filter(Boolean)
    return [`${error.name}: ${error.message}`, ...at].join(' | ')
  }
  return String(error ?? fallback)
}

/** Keep an error of this window (`view`: main, overlay, preview…). */
export function noteError(view: string, line: string): void {
  api.windowError(view, line)
}

/** Report this window's uncaught errors and rejected promises (React's uncaught render errors among them). */
export function watchErrors(view: string): void {
  window.addEventListener('error', (e) => noteError(view, describeError(e.error, `${e.message} (${e.filename}:${e.lineno})`)))
  window.addEventListener('unhandledrejection', (e) => noteError(view, `unhandled rejection: ${describeError(e.reason)}`))
}
