import { randomBytes } from 'node:crypto'
import { clipboard } from 'electron'
import { log } from '../log'
import { delay, isLinux, isMac, isWayland, run, which } from '../util'
import { tapKeys, waitForModifiersReleased } from './keyboard'
import { restoreClipboard, snapshotClipboard } from './paste'

const COPY_WAIT_MS = 600

/** Send the copy shortcut. Ctrl+Insert rather than Ctrl+C: in a terminal, Ctrl+C interrupts the running program. */
async function sendCopyKeystroke(): Promise<boolean> {
  if (isMac) return tapKeys('C', ['Meta'])
  if (isLinux && which('xdotool')) return (await run('xdotool', ['key', '--clearmodifiers', 'ctrl+Insert'], { timeoutMs: 3000 })).code === 0
  return tapKeys('Insert', ['Ctrl'])
}

/**
 * The text selected in the focused application ('' when there is none): copy it through a
 * marker on the clipboard, which tells "nothing selected" apart from an unchanged clipboard,
 * then put the clipboard back as it was.
 */
export async function readSelection(): Promise<string> {
  if (isWayland) return '' // keystrokes can't be synthesized
  const previous = await snapshotClipboard()
  const marker = `speak:${randomBytes(8).toString('hex')}`
  let text = ''
  try {
    await clipboard.writeText(marker)
    await waitForModifiersReleased()
    await delay(40)
    if (await sendCopyKeystroke()) {
      const until = Date.now() + COPY_WAIT_MS
      while (Date.now() < until) {
        await delay(30)
        const current = await clipboard.readText()
        if (current !== marker) {
          text = current.trim()
          break
        }
      }
    }
  } catch (err) {
    log.warn('Could not read the selection:', err)
  } finally {
    await restoreClipboard(previous)
  }
  return text
}
