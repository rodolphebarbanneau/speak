import { clipboard, ClipboardItem } from 'electron'
import type { PasteKeys } from '../../shared/types'
import { log } from '../log'
import { delay, isLinux, isMac, isWayland, run, which } from '../util'
import { tapKeys, waitForModifiersReleased } from './keyboard'

/** Copy of every format currently on the clipboard (text, HTML, images…). */
async function snapshot(): Promise<ClipboardItem[]> {
  try {
    const items = await clipboard.read()
    return await Promise.all(
      items.map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (t) => [t, await item.getType(t)] as const)))))
    )
  } catch (err) {
    log.warn('Could not read clipboard:', err)
    return []
  }
}

async function restore(items: ClipboardItem[]): Promise<void> {
  try {
    if (items.length) await clipboard.write(items)
    else clipboard.clear()
  } catch (err) {
    log.warn('Could not restore clipboard:', err)
  }
}

async function sendPasteKeystroke(keys: PasteKeys): Promise<boolean> {
  const combo = keys === 'auto' ? (isMac ? 'cmd+v' : 'ctrl+v') : keys
  if (isLinux) {
    // Prefer native tools on Linux: xdotool (X11), wtype/ydotool (Wayland).
    const xdo = { 'ctrl+v': 'ctrl+v', 'ctrl+shift+v': 'ctrl+shift+v', 'shift+insert': 'shift+Insert', 'cmd+v': 'ctrl+v' }[combo]!
    if (!isWayland && which('xdotool')) return (await run('xdotool', ['key', '--clearmodifiers', xdo], { timeoutMs: 3000 })).code === 0
    if (isWayland && which('wtype')) {
      const args =
        combo === 'shift+insert'
          ? ['-M', 'shift', '-k', 'Insert', '-m', 'shift']
          : combo === 'ctrl+shift+v'
            ? ['-M', 'ctrl', '-M', 'shift', '-k', 'v', '-m', 'shift', '-m', 'ctrl']
            : ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']
      return (await run('wtype', args, { timeoutMs: 3000 })).code === 0
    }
    if (isWayland && which('ydotool')) {
      // Linux input event codes: 29 LEFTCTRL, 42 LEFTSHIFT, 47 V, 110 INSERT
      const seq =
        combo === 'shift+insert'
          ? ['42:1', '110:1', '110:0', '42:0']
          : combo === 'ctrl+shift+v'
            ? ['29:1', '42:1', '47:1', '47:0', '42:0', '29:0']
            : ['29:1', '47:1', '47:0', '29:0']
      return (await run('ydotool', ['key', ...seq], { timeoutMs: 3000 })).code === 0
    }
    if (isWayland) return false
  }
  switch (combo) {
    case 'cmd+v':
      return tapKeys('V', ['Meta'])
    case 'ctrl+shift+v':
      return tapKeys('V', ['Ctrl', 'Shift'])
    case 'shift+insert':
      return tapKeys('Insert', ['Shift'])
    default:
      return tapKeys('V', ['Ctrl'])
  }
}

/**
 * Insert text into the focused application: put it on the clipboard, synthesize the
 * paste shortcut, then restore the previous clipboard content.
 * Returns false when the keystroke couldn't be sent (text stays on the clipboard).
 */
export async function pasteText(text: string, opts: { keys: PasteKeys; restoreClipboard: boolean }): Promise<boolean> {
  const previous = opts.restoreClipboard ? await snapshot() : null
  await clipboard.writeText(text)
  await waitForModifiersReleased()
  await delay(40)
  let ok = false
  try {
    ok = await sendPasteKeystroke(opts.keys)
  } catch (err) {
    log.warn('Paste keystroke failed:', err)
  }
  if (ok && previous) {
    // Give the target app time to read the clipboard before restoring it.
    setTimeout(async () => {
      if ((await clipboard.readText()) === text) await restore(previous)
    }, 700)
  }
  return ok
}

export function copyToClipboard(text: string): Promise<void> {
  return clipboard.writeText(text)
}
