/**
 * A shortcut the AI asks for ("ctrl+shift+t", "enter", "cmd+s"), by what each key means: the
 * modifiers, named keys and characters. Each system maps them to its own key codes (macOS and X11;
 * Windows keeps its own table, in win32.ts).
 */

export type Modifier = 'ctrl' | 'shift' | 'alt' | 'meta'
export type KeyToken = { mod: Modifier } | { key: string } | { char: string }

const MODIFIERS: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  meta: 'meta'
}

/** Named keys: lower-case aliases → a name each system maps. */
const NAMED: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  forwarddelete: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  menu: 'Menu',
  contextmenu: 'Menu',
  capslock: 'CapsLock',
  printscreen: 'PrintScreen',
  print: 'PrintScreen',
  pause: 'Pause'
}

/**
 * "cmd+shift+t" → its keys. `mac`: cmd is the Command key, and "delete" the key a Mac keyboard
 * labels so (backspace); elsewhere cmd means ctrl, as Windows shortcuts are written. Throws on a
 * key it doesn't know.
 */
export function parseCombo(combo: string, mac: boolean): KeyToken[] {
  // "ctrl++": the plus key itself.
  const parts = combo.trim().replace(/\+\+$/, '+plus').split('+')
  return parts
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k): KeyToken => {
      const l = k.toLowerCase()
      if (l === 'cmd' || l === 'command') return { mod: mac ? 'meta' : 'ctrl' }
      if (MODIFIERS[l]) return { mod: MODIFIERS[l] }
      if (mac && l === 'delete') return { key: 'Backspace' }
      if (NAMED[l]) return { key: NAMED[l] }
      if (/^f([1-9]|1\d|2[0-4])$/.test(l)) return { key: l.toUpperCase() }
      if (l === 'plus') return { char: '+' }
      if (l === 'minus') return { char: '-' }
      if ([...k].length === 1) return { char: k }
      throw new Error(`Unknown key "${k}"`)
    })
}
