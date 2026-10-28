import type { BrowserWindow } from 'electron'
import type { LoadingState } from '../shared/types'
import { delay } from './util'
import { createLoader } from './windows'

/** A step: what it does (shown under the bar), and the work. */
export type Step = [label: string, run: () => unknown]

/** Usually the plain label; now and then a lighter one that says the same thing. */
export function label(plain: string, light: string): string {
  return Math.random() < 0.2 ? light : plain
}

/**
 * Run steps one after the other, letting the event loop breathe between them (input, IPC and
 * painting go through), with a loading dialog if they take more than a moment: a progress bar,
 * the step in progress under it, and the overall status.
 */
export async function withLoading(
  title: string,
  steps: Step[],
  opts: {
    /** Show the dialog only if the steps aren't done by then (0: right away). */
    showAfterMs?: number
    /** Once on screen, keep it at least this long, so it can be read. */
    minShownMs?: number
    note?: string
    /** Leave it open after the last step (it ends by quitting the app). */
    leaveOpen?: boolean
  } = {}
): Promise<void> {
  const minShownMs = opts.minShownMs ?? 800
  let win: BrowserWindow | null = null
  /** Resolves when the dialog is on screen. */
  let shown: Promise<number> | null = null
  let state: LoadingState = { title, done: 0, total: steps.length, item: steps[0]?.[0] ?? '', note: opts.note }
  const send = () => {
    if (win && !win.isDestroyed()) win.webContents.send('speak:loading', state)
  }
  /** Once the dialog is up, wait until it has been on screen long enough to read. */
  const readable = async () => {
    if (!shown) return
    const at = await shown
    await delay(Math.max(0, minShownMs - (Date.now() - at)))
  }
  const open = () => {
    shown = new Promise((resolve) => {
      win = createLoader(() => {
        send()
        resolve(Date.now())
      })
    })
  }
  // Shown right away (just updated, updating): the steps wait for it, so they can be seen going by.
  const showAfterMs = opts.showAfterMs ?? 700
  const timer = showAfterMs > 0 ? setTimeout(open, showAfterMs) : null
  if (!timer) {
    open()
    await shown
  }

  for (const [i, [item, run]] of steps.entries()) {
    state = { ...state, done: i, item }
    send()
    if (i === steps.length - 1) await readable()
    await run()
    await new Promise((resolve) => setImmediate(resolve))
  }
  if (timer) clearTimeout(timer)
  if (!win || opts.leaveOpen) return
  const dialog: BrowserWindow = win
  state = { ...state, done: steps.length, item: 'ready' }
  send()
  await readable()
  await delay(300) // "ready", briefly
  if (!dialog.isDestroyed()) dialog.destroy()
}
