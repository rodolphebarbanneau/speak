import { readFileSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { log } from '../../log'
import { delay, isWayland } from '../../util'
import atspiScript from './atspi?modulePath'
import { Bridge, BridgeAccessibility, nodeBridge } from './bridge'
import { windowSource } from './capture'
import { inRect, unavailable } from './common'
import { announce } from './hands'
import { parseCombo } from './keys'
import type { Button, Point, Rect, ScreenBackend, WindowInfo } from './types'

/**
 * Linux, in an X11 session: the windows through the window manager's EWMH hints (the client list,
 * the active window), a window's picture through Chromium's window capture (even behind others),
 * its controls through AT-SPI (in a bridge process: see atspi.ts), and the mouse and keyboard
 * through XTEST, like a person's. Coordinates are the root window's pixels. libX11 and libXtst are
 * there wherever Electron runs on X11. Wayland lets no app see or drive another's windows: control
 * needs an X11 session there.
 */

type Ptr = bigint | null

const ANY = 0 // AnyPropertyType
const XA = { atom: 4, cardinal: 6, string: 31, window: 33, wmName: 39, wmClass: 67, transientFor: 68 }
const MASK = { shift: 1, lock: 2, ctrl: 4, alt: 8, meta: 64, buttons: (1 << 8) | (1 << 9) | (1 << 10) }
const BUTTON: Record<Button, number> = { left: 1, middle: 2, right: 3 }
const CLIENT_MESSAGE = 33
const SUBSTRUCTURE = (1 << 19) | (1 << 20) // SubstructureNotifyMask | SubstructureRedirectMask
/** Window types that aren't windows a person works in (a dock, the desktop, menus, tooltips…). */
const NOT_WINDOWS = ['DESKTOP', 'DOCK', 'TOOLBAR', 'MENU', 'UTILITY', 'SPLASH', 'NOTIFICATION', 'DROPDOWN_MENU', 'POPUP_MENU', 'TOOLTIP', 'COMBO', 'DND']
/** Keys by name → X keysym names. */
const KEYSYM: Record<string, string> = {
  Enter: 'Return',
  Tab: 'Tab',
  Escape: 'Escape',
  Space: 'space',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Menu: 'Menu',
  CapsLock: 'Caps_Lock',
  PrintScreen: 'Print',
  Pause: 'Pause'
}
const MODIFIER_KEYSYM = { ctrl: 'Control_L', shift: 'Shift_L', alt: 'Alt_L', meta: 'Super_L' }

/** A keysym's two cases (Latin-1 and Unicode keysyms): the same twice when it has none. */
function cases(k: number): [number, number] {
  if ((k >= 0x41 && k <= 0x5a) || (k >= 0xc0 && k <= 0xde && k !== 0xd7)) return [k + 0x20, k]
  if ((k >= 0x61 && k <= 0x7a) || (k >= 0xe0 && k <= 0xfe && k !== 0xf7)) return [k, k - 0x20]
  // Unicode keysyms only: the vendors' (XF86's media keys…) are above them.
  if (k >= 0x1000100 && k <= 0x110ffff) {
    const ch = String.fromCodePoint(k - 0x1000000)
    const lower = ch.toLowerCase()
    const upper = ch.toUpperCase()
    if (lower !== upper && [...lower].length === 1 && [...upper].length === 1) return [0x1000000 + lower.codePointAt(0)!, 0x1000000 + upper.codePointAt(0)!]
  }
  return [k, k]
}

/**
 * A key's keysyms in a layout group, plain and with Shift, by the core protocol's rules (Xlib's
 * own): two per group for the first two groups, a short list repeated, and a lone letter standing
 * for both its cases.
 */
function corePair(list: number[], group: number): [number, number] {
  let n = list.length
  while (n > 0 && !list[n - 1]) n--
  const syms = n === 1 ? [list[0], 0, list[0], 0] : n === 2 ? [list[0], list[1], list[0], list[1]] : list.slice(0, Math.max(n, 4))
  const g = group & 1
  let plain = syms[g * 2] ?? 0
  let shifted = syms[g * 2 + 1] ?? 0
  if (!plain && !shifted) [plain, shifted] = [syms[0] ?? 0, syms[1] ?? 0]
  if (!shifted) {
    const [lower, upper] = cases(plain)
    if (lower !== upper) [plain, shifted] = [lower, upper]
    else shifted = plain
  }
  return [plain, shifted]
}

function bind() {
  const koffi = require('koffi') as typeof import('koffi')
  const x = koffi.load('libX11.so.6')
  const xt = koffi.load('libXtst.so.6')
  const libc = koffi.load('libc.so.6')
  const ErrorHandler = koffi.proto('int SpeakXErrorHandler(void *display, void *event)')
  // Xlib's Bool is an int: declared so, never as a C bool.
  return {
    koffi,
    ErrorHandler,
    XOpenDisplay: x.func('void *XOpenDisplay(const char *name)'),
    XDefaultRootWindow: x.func('unsigned long XDefaultRootWindow(void *display)'),
    XInternAtom: x.func('unsigned long XInternAtom(void *display, const char *name, int onlyIfExists)'),
    XGetWindowProperty: x.func(
      'int XGetWindowProperty(void *display, unsigned long w, unsigned long property, long offset, long length, int remove, unsigned long type, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *items, _Out_ unsigned long *after, _Out_ void **data)'
    ),
    XFree: x.func('int XFree(void *data)'),
    XGetGeometry: x.func(
      'int XGetGeometry(void *display, unsigned long d, _Out_ unsigned long *root, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *w, _Out_ unsigned int *h, _Out_ unsigned int *border, _Out_ unsigned int *depth)'
    ),
    XTranslateCoordinates: x.func(
      'int XTranslateCoordinates(void *display, unsigned long src, unsigned long dst, int x, int y, _Out_ int *dx, _Out_ int *dy, _Out_ unsigned long *child)'
    ),
    XQueryPointer: x.func(
      'int XQueryPointer(void *display, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *mask)'
    ),
    XSendEvent: x.func('int XSendEvent(void *display, unsigned long w, int propagate, long mask, void *event)'),
    XFlush: x.func('int XFlush(void *display)'),
    XSync: x.func('int XSync(void *display, int discard)'),
    XMapWindow: x.func('int XMapWindow(void *display, unsigned long w)'),
    XCreateSimpleWindow: x.func(
      'unsigned long XCreateSimpleWindow(void *display, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderColor, unsigned long background)'
    ),
    XDestroyWindow: x.func('int XDestroyWindow(void *display, unsigned long w)'),
    XKeysymToKeycode: x.func('uint8_t XKeysymToKeycode(void *display, unsigned long keysym)'),
    XStringToKeysym: x.func('unsigned long XStringToKeysym(const char *name)'),
    XkbGetState: x.func('int XkbGetState(void *display, unsigned int device, _Out_ uint8_t *state)'),
    XDisplayKeycodes: x.func('int XDisplayKeycodes(void *display, _Out_ int *min, _Out_ int *max)'),
    XGetKeyboardMapping: x.func('void *XGetKeyboardMapping(void *display, uint8_t first, int count, _Out_ int *perCode)'),
    XChangeKeyboardMapping: x.func('int XChangeKeyboardMapping(void *display, int first, int perCode, void *keysyms, int count)'),
    XSetErrorHandler: x.func('void *XSetErrorHandler(void *handler)'),
    XQueryTree: x.func(
      'int XQueryTree(void *display, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *count)'
    ),
    XTestQueryExtension: xt.func('int XTestQueryExtension(void *display, _Out_ int *event, _Out_ int *error, _Out_ int *major, _Out_ int *minor)'),
    XTestFakeKeyEvent: xt.func('int XTestFakeKeyEvent(void *display, unsigned int code, int press, unsigned long delay)'),
    XTestFakeButtonEvent: xt.func('int XTestFakeButtonEvent(void *display, unsigned int button, int press, unsigned long delay)'),
    XTestFakeMotionEvent: xt.func('int XTestFakeMotionEvent(void *display, int screen, int x, int y, unsigned long delay)'),
    memcpy: libc.func('void *memcpy(_Out_ uint8_t *dst, void *src, size_t n)'),
    xres: resources(koffi)
  }
}

/**
 * The X server's Resource extension (libXRes), when there: which process really holds a window,
 * from its connection. What a window says of itself (_NET_WM_PID) may be missing, or a sandbox's
 * own numbering (Flatpak).
 */
function resources(koffi: typeof import('koffi')) {
  try {
    const r = koffi.load('libXRes.so.1')
    return {
      query: r.func('int XResQueryClientIds(void *display, long count, uint8_t *specs, _Out_ long *found, _Out_ void **ids)'),
      pidOf: r.func('int XResGetClientPid(void *value)'),
      destroy: r.func('void XResClientIdsDestroy(long count, void *ids)')
    }
  } catch {
    return null
  }
}

type X11 = ReturnType<typeof bind>

export function createX11Backend(): ScreenBackend {
  if (isWayland)
    return unavailable(
      "Control needs an X11 session on Linux: Wayland doesn't let an app see or drive other apps' windows. Choose an X11 (Xorg) session when you log in to use it."
    )
  let X: X11
  try {
    X = bind()
  } catch (err) {
    log.warn('Control: X11 bindings unavailable:', err)
    return unavailable(`Speak could not load the X11 libraries to control apps (libX11, libXtst): ${(err as Error).message}`)
  }
  const dpy: Ptr = X.XOpenDisplay(null)
  if (!dpy) return unavailable(`Speak can't reach the X server${process.env.DISPLAY ? ` (${process.env.DISPLAY})` : ": $DISPLAY isn't set"}.`)
  if (!X.XTestQueryExtension(dpy, [0], [0], [0], [0])) return unavailable("Control needs the X server's XTEST extension, to send the mouse and the keyboard.")

  // Xlib's own error handler ends the process (a window gone between two calls is an error): Speak's
  // ignores its connection's errors (the call then returns its failure), and passes on the others'.
  let previous: Ptr = null
  const handler = X.koffi.register((display: Ptr, event: Ptr) => {
    if (display === dpy || !previous) return 0
    try {
      return X.koffi.call(previous, X.ErrorHandler, display, event)
    } catch {
      return 0
    }
  }, X.koffi.pointer(X.ErrorHandler))
  previous = X.XSetErrorHandler(handler)

  const root = Number(X.XDefaultRootWindow(dpy))
  const atoms = new Map<string, number>()
  const atom = (name: string): number => {
    let a = atoms.get(name)
    if (a === undefined) atoms.set(name, (a = Number(X.XInternAtom(dpy, name, 0))))
    return a
  }
  const skipTypes = new Set(NOT_WINDOWS.map((t) => atom(`_NET_WM_WINDOW_TYPE_${t}`)))
  const desktopType = atom('_NET_WM_WINDOW_TYPE_DESKTOP')

  /** A property's data (format 32 items are C longs: 8 bytes each). */
  function prop(win: number, property: number, type = ANY, max = 4096): { format: number; items: number; data: Buffer } | null {
    const actualType = [0]
    const format = [0]
    const count = [0]
    const after = [0]
    const data: Ptr[] = [null]
    if (X.XGetWindowProperty(dpy, win, property, 0, max, 0, type, actualType, format, count, after, data) !== 0 || !data[0]) return null
    try {
      const n = Number(count[0])
      const f = format[0]
      const bytes = f === 32 ? n * 8 : f === 16 ? n * 2 : n
      const buf = Buffer.alloc(bytes)
      if (bytes) X.memcpy(buf, data[0], bytes)
      return { format: f, items: n, data: buf }
    } finally {
      X.XFree(data[0])
    }
  }
  const longs = (win: number, property: number): number[] => {
    const p = prop(win, property)
    if (!p || p.format !== 32) return []
    return Array.from({ length: p.items }, (_, i) => Number(p.data.readBigUInt64LE(i * 8) & 0xffffffffn))
  }
  const one = (win: number, property: number): number | undefined => longs(win, property)[0]
  function title(win: number): string {
    const net = prop(win, atom('_NET_WM_NAME'), atom('UTF8_STRING'))
    if (net?.items) return net.data.toString('utf8')
    const old = prop(win, XA.wmName)
    return old?.items ? old.data.toString('latin1') : ''
  }

  /** A window's process, as the X server knows it from its connection (0: it can't say). */
  function serverPid(win: number): number {
    let pid = 0
    if (X.xres) {
      const spec = Buffer.alloc(16) // XResClientIdSpec: the window, and the PID mask
      spec.writeBigUInt64LE(BigInt(win), 0)
      spec.writeUInt32LE(2, 8) // XRES_CLIENT_ID_PID_MASK
      const found = [0]
      const ids: Ptr[] = [null]
      if (X.xres.query(dpy, 1, spec, found, ids) === 0 && ids[0]) {
        try {
          // XResClientIdValue: 32 bytes each.
          for (let i = 0; i < Number(found[0]) && pid <= 0; i++) pid = Number(X.xres.pidOf(ids[0] + BigInt(i * 32)))
        } finally {
          X.xres.destroy(found[0], ids[0])
        }
      }
    }
    return Math.max(0, pid)
  }
  /**
   * Whether the X server counts processes as Speak does: not one in another container, or in
   * WSLg's system distribution, whose numbers mean other processes here. Asked of a window of
   * Speak's own (never shown).
   */
  const sameProcesses = (() => {
    if (!X.xres) return false
    const probe = Number(X.XCreateSimpleWindow(dpy, root, 0, 0, 1, 1, 0, 0, 0))
    try {
      return !!probe && serverPid(probe) === process.pid
    } finally {
      if (probe) X.XDestroyWindow(dpy, probe)
      X.XFlush(dpy)
    }
  })()
  const owners = new Map<number, number>()
  /** Each window's process: the X server's word when it counts as Speak does, else 0. */
  function ownerOf(win: number): number {
    if (!sameProcesses) return 0
    const known = owners.get(win)
    if (known !== undefined) return known
    const pid = serverPid(win)
    if (pid) owners.set(win, pid)
    return pid
  }

  /** The app, as X names it (WM_CLASS: "firefox", "Gnome-terminal", an Electron app's own name). */
  function classOf(win: number): string {
    const p = prop(win, XA.wmClass)
    if (!p?.items) return ''
    const [instance, cls] = p.data.toString('latin1').split('\0')
    return cls || instance || ''
  }

  const exes = new Map<number, string>()
  function exeOf(pid: number): string {
    if (!pid) return ''
    let exe = exes.get(pid)
    if (exe !== undefined) return exe
    try {
      exe = basename(readlinkSync(`/proc/${pid}/exe`))
    } catch {
      try {
        exe = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
      } catch {
        exe = ''
      }
    }
    exes.set(pid, exe)
    return exe
  }

  /** Where a window is on the screen: its own area (a window manager's frame around it isn't part of it). */
  function geometry(win: number): Rect | null {
    const w = [0]
    const h = [0]
    if (!X.XGetGeometry(dpy, win, [0], [0], [0], w, h, [0], [0])) return null
    const x = [0]
    const y = [0]
    if (!X.XTranslateCoordinates(dpy, win, root, 0, 0, x, y, [0])) return null
    return { x: x[0], y: y[0], w: w[0], h: h[0] }
  }

  const activeWindow = () => one(root, atom('_NET_ACTIVE_WINDOW')) ?? 0
  const currentDesktop = () => one(root, atom('_NET_CURRENT_DESKTOP'))

  /** A window's children, bottom to top. */
  function treeChildren(win: number): number[] {
    const kids: Ptr[] = [null]
    const n = [0]
    if (!X.XQueryTree(dpy, win, [0], [0], kids, n) || !kids[0]) return []
    try {
      const buf = Buffer.alloc(n[0] * 8)
      X.memcpy(buf, kids[0], buf.length)
      return Array.from({ length: n[0] }, (_, i) => Number(buf.readBigUInt64LE(i * 8) & 0xffffffffn))
    } finally {
      X.XFree(kids[0])
    }
  }
  /** The app's own window in a window manager's frame: the one with WM_STATE (ICCCM). */
  function clientIn(win: number, depth: number): number {
    if (prop(win, atom('WM_STATE'))) return win
    if (depth <= 0) return 0
    for (const kid of treeChildren(win)) {
      const c = clientIn(kid, depth - 1)
      if (c) return c
    }
    return 0
  }
  /**
   * The managed windows, bottom to top: the window manager's stacking list, else (a window manager
   * that keeps none, as some XWayland ones) the root's children, framed or not, in their real order.
   */
  const stacking = () => {
    const s = longs(root, atom('_NET_CLIENT_LIST_STACKING'))
    if (s.length) return s
    return treeChildren(root)
      .map((top) => clientIn(top, 2))
      .filter(Boolean)
  }

  function info(id: number, active: number, desktop: number | undefined, all = false): WindowInfo | null {
    if (!id) return null
    const types = longs(id, atom('_NET_WM_WINDOW_TYPE'))
    if (types.some((t) => (all ? t === desktopType : skipTypes.has(t)))) return null
    const onDesktop = one(id, atom('_NET_WM_DESKTOP'))
    if (desktop !== undefined && onDesktop !== undefined && onDesktop !== 0xffffffff && onDesktop !== desktop) return null
    const name = title(id)
    if (!name && !all) return null
    const rect = geometry(id)
    if (!rect) return null
    const pid = ownerOf(id) || (one(id, atom('_NET_WM_PID')) ?? 0)
    // ICCCM's WM_STATE: withdrawn (0) isn't on screen at all, iconic (3) is minimized.
    const wmState = one(id, atom('WM_STATE'))
    if (wmState === 0) return null
    const minimized = wmState === 3 || longs(id, atom('_NET_WM_STATE')).includes(atom('_NET_WM_STATE_HIDDEN'))
    return { id, title: name, pid, exe: classOf(id) || exeOf(pid), rect, minimized, focused: id === active }
  }

  /** Minimized: iconic (ICCCM), or hidden (EWMH). */
  const iconic = (id: number) => one(id, atom('WM_STATE')) === 3 || longs(id, atom('_NET_WM_STATE')).includes(atom('_NET_WM_STATE_HIDDEN'))

  function flush(): void {
    X.XSync(dpy, 0)
  }

  function clientMessage(win: number, type: string, data: number[]): void {
    const ev = Buffer.alloc(192) // sizeof(XEvent)
    ev.writeInt32LE(CLIENT_MESSAGE, 0)
    ev.writeInt32LE(1, 16) // send_event
    ev.writeBigUInt64LE(BigInt(dpy ?? 0), 24)
    ev.writeBigUInt64LE(BigInt(win), 32)
    ev.writeBigUInt64LE(BigInt(atom(type)), 40)
    ev.writeInt32LE(32, 48) // format
    data.forEach((v, i) => ev.writeBigInt64LE(BigInt(v), 56 + i * 8))
    X.XSendEvent(dpy, root, 0, SUBSTRUCTURE, ev)
    X.XFlush(dpy)
  }

  function pointer(): { x: number; y: number; mask: number } {
    const x = [0]
    const y = [0]
    const mask = [0]
    X.XQueryPointer(dpy, root, [0], [0], x, y, [0], [0], mask)
    return { x: x[0], y: y[0], mask: mask[0] }
  }

  function key(code: number, down: boolean): void {
    if (down) announce('key')
    X.XTestFakeKeyEvent(dpy, code, down ? 1 : 0, 0)
  }

  type KeyMap = Map<number, { code: number; shift: boolean }>
  /**
   * Which key types each keysym, with Shift or not, in each of the first two layout groups (the
   * active one is `group`): the keyboard's own keys first (shortcuts, and apps that read keys).
   * Read again every second: the user may switch layouts.
   */
  let keyMap: { at: number; group: number; maps: KeyMap[] } | null = null
  function layout(): { group: number; maps: KeyMap[] } {
    const state = Buffer.alloc(32)
    const group = X.XkbGetState(dpy, 0x100, state) === 0 ? state[0] & 1 : 0 // XkbUseCoreKbd; XkbStateRec.group
    if (keyMap && keyMap.group === group && Date.now() - keyMap.at < 1000) return keyMap
    // Asked of the server each time: Xlib's own copy follows changes only for a connection that
    // reads its events, which Speak's doesn't (and the keymap changes with the layout).
    const min = [0]
    const max = [0]
    X.XDisplayKeycodes(dpy, min, max)
    const count = max[0] - min[0] + 1
    const per = [0]
    const mapping: Ptr = X.XGetKeyboardMapping(dpy, min[0], count, per)
    if (!mapping) return { group, maps: [new Map(), new Map()] }
    const syms = Buffer.alloc(count * per[0] * 8)
    try {
      X.memcpy(syms, mapping, syms.length)
    } finally {
      X.XFree(mapping)
    }
    const lists: Array<[number, number[]]> = []
    for (let i = 0; i < count; i++) {
      const code = min[0] + i
      // The spare key is only lent: never one of the layout's.
      if (code === spare) continue
      lists.push([code, Array.from({ length: per[0] }, (_, j) => Number(syms.readBigUInt64LE((i * per[0] + j) * 8) & 0xffffffffn))])
    }
    const maps = [0, 1].map((g) => {
      const map: KeyMap = new Map()
      const pairs = lists.map(([code, list]) => [code, ...corePair(list, g)] as const)
      // Plain keys first: a character on two keys is typed without Shift.
      for (const [code, plain] of pairs) if (plain && !map.has(plain)) map.set(plain, { code, shift: false })
      for (const [code, , shifted] of pairs) if (shifted && !map.has(shifted)) map.set(shifted, { code, shift: true })
      return map
    })
    keyMap = { at: Date.now(), group, maps }
    return keyMap
  }
  /** The active layout group's keys. */
  const keys = (): KeyMap => {
    const l = layout()
    return l.maps[l.group]
  }

  /** A keysym for a character: Latin-1 as itself, the rest as X's Unicode keysyms. */
  function keysymOf(ch: string): number {
    const c = ch.codePointAt(0) ?? 0
    if (ch === '\t') return 0xff09
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) return c
    return 0x01000000 + c
  }

  /** A key no layout uses, lent a character for a moment (as xdotool does), and given back after. */
  let spare: number | null | undefined
  let spareReset: NodeJS.Timeout | null = null
  function spareKey(): number | null {
    if (spare !== undefined) return spare
    spare = null
    const min = [0]
    const max = [0]
    X.XDisplayKeycodes(dpy, min, max)
    const count = max[0] - min[0] + 1
    const per = [0]
    const mapping: Ptr = X.XGetKeyboardMapping(dpy, min[0], count, per)
    if (!mapping) return null
    try {
      const syms = Buffer.alloc(count * per[0] * 8)
      X.memcpy(syms, mapping, syms.length)
      for (let i = count - 1; i >= 0 && spare === null; i--) {
        let free = true
        for (let j = 0; j < per[0] && free; j++) if (syms.readBigUInt64LE((i * per[0] + j) * 8) !== 0n) free = false
        if (free) spare = min[0] + i
      }
    } finally {
      X.XFree(mapping)
    }
    return spare
  }
  function lend(code: number, sym: number): void {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(BigInt(sym))
    X.XChangeKeyboardMapping(dpy, code, 1, buf, 1)
    flush()
  }

  function lookup(ch: string): { code: number; shift: boolean } | undefined {
    return keys().get(keysymOf(ch))
  }
  /**
   * A shortcut's key: in the active group, else in the other one (ctrl+c on a Russian layout is
   * the C key of the Latin one: GTK, Qt and Chromium match shortcuts on any group's keys).
   */
  function shortcutKey(ch: string): { code: number; shift: boolean } | undefined {
    const l = layout()
    const sym = keysymOf(ch)
    return l.maps[l.group].get(sym) ?? l.maps[l.group ^ 1].get(sym)
  }
  /** The key of a keysym ("Return", "Shift_L"), from the layout as it is now. */
  function codeOf(name: string): number {
    const sym = Number(X.XStringToKeysym(name))
    return sym ? (keys().get(sym)?.code ?? Number(X.XKeysymToKeycode(dpy, sym))) : 0
  }

  const bridge = new Bridge(() => nodeBridge('AT-SPI', atspiScript))
  const front = (): Record<string, unknown> => {
    const id = activeWindow()
    const w = id ? info(id, id, undefined, true) : null
    return w ? { front: { id: w.id, pid: w.pid, title: w.title, rect: w.rect } } : {}
  }

  return {
    unsupported: () => null,
    mod: 'ctrl',
    a11y: new BridgeAccessibility(bridge, front, 12_000),
    refresh: async () => undefined,

    /** Front to back, on the current workspace: the window manager's stacking, top first. */
    listWindows(): WindowInfo[] {
      const active = activeWindow()
      const desktop = currentDesktop()
      return stacking()
        .reverse()
        .map((id) => info(id, active, desktop))
        .filter((w): w is WindowInfo => !!w)
    },

    windowInfo(id: number): WindowInfo | null {
      return info(id, activeWindow(), undefined)
    },

    foregroundWindow(): WindowInfo | null {
      const id = activeWindow()
      return id ? info(id, id, undefined, true) : null
    },

    /** The top window there (docks and panels included, the desktop not); Speak's own aren't hit. */
    windowAt(x: number, y: number): WindowInfo | null {
      const active = activeWindow()
      const desktop = currentDesktop()
      for (const id of stacking().reverse()) {
        const rect = geometry(id)
        if (!rect || !inRect({ x, y }, rect)) continue
        const w = info(id, active, desktop, true)
        if (!w || w.minimized || w.pid === process.pid) continue
        return w
      }
      return null
    },

    /** As a pager asks it of the window manager (the user's own request, past focus-stealing prevention). */
    async focusWindow(id: number): Promise<boolean> {
      if (activeWindow() === id) return true
      if (iconic(id)) X.XMapWindow(dpy, id)
      clientMessage(id, '_NET_ACTIVE_WINDOW', [2, 0, activeWindow()])
      for (let i = 0; i < 16; i++) {
        await delay(50)
        if (activeWindow() === id) return true
      }
      return false
    },

    async unminimize(id: number): Promise<void> {
      if (!iconic(id)) return
      X.XMapWindow(dpy, id)
      flush()
      await delay(250)
    },

    /** The active window, or a dialog it owns. */
    hasKeyboard(id: number): boolean {
      const active = activeWindow()
      return !!active && (active === id || one(active, XA.transientFor) === id)
    },

    held() {
      const { mask } = pointer()
      return { modifiers: (mask & (MASK.shift | MASK.ctrl | MASK.alt | MASK.meta)) !== 0, buttons: (mask & MASK.buttons) !== 0 }
    },

    cursorPos(): Point {
      const { x, y } = pointer()
      return { x, y }
    },

    /** XTEST's motion: apps see the pointer there (a drag's moves with the button down), the hook at the anchor. */
    movePointer(x: number, y: number): void {
      X.XTestFakeMotionEvent(dpy, -1, Math.round(x), Math.round(y), 0)
      flush()
    },

    button(button: Button, down: boolean): void {
      if (down) announce('mouse')
      X.XTestFakeButtonEvent(dpy, BUTTON[button], down ? 1 : 0, 0)
      flush()
    },

    /** Buttons 4 and 5 (6 and 7 sideways), a notch each. */
    wheel(_at: Point, dy: number, dx: number): void {
      const turn = (button: number, n: number) => {
        for (let i = 0; i < n; i++) {
          announce('mouse')
          X.XTestFakeButtonEvent(dpy, button, 1, 0)
          X.XTestFakeButtonEvent(dpy, button, 0, 0)
        }
      }
      if (dy) turn(dy > 0 ? 5 : 4, Math.abs(dy))
      if (dx) turn(dx > 0 ? 7 : 6, Math.abs(dx))
      flush()
    },

    pressKeys(combo: string): void {
      const codes: number[] = []
      let shift = false
      for (const t of parseCombo(combo, false)) {
        let code = 0
        if ('mod' in t) code = codeOf(MODIFIER_KEYSYM[t.mod])
        else if ('key' in t) code = codeOf(KEYSYM[t.key] ?? t.key)
        else {
          const k = shortcutKey(/^[A-Z]$/.test(t.char) ? t.char.toLowerCase() : t.char)
          if (k?.shift) shift = true
          code = k?.code ?? 0
        }
        if (!code) throw new Error(`Unknown key "${'mod' in t ? t.mod : 'key' in t ? t.key : t.char}"`)
        if (!codes.includes(code)) codes.push(code)
      }
      if (!codes.length) throw new Error('No key to press')
      const shiftKey = codeOf('Shift_L')
      if (shift && shiftKey && !codes.includes(shiftKey)) codes.unshift(shiftKey)
      for (const c of codes) key(c, true)
      for (const c of [...codes].reverse()) key(c, false)
      flush()
    },

    /**
     * The key that types it on the user's layout (with Shift as needed, Caps Lock taken into
     * account); a character the layout doesn't have goes through a spare key lent to it.
     */
    typeChar(ch: string): void {
      const k = lookup(ch)
      if (k) {
        const letter = ch.toLowerCase() !== ch.toUpperCase()
        const caps = letter && (pointer().mask & MASK.lock) !== 0
        const shift = k.shift !== caps
        const shiftKey = codeOf('Shift_L')
        if (shift) key(shiftKey, true)
        key(k.code, true)
        key(k.code, false)
        if (shift) key(shiftKey, false)
        flush()
        return
      }
      const code = spareKey()
      if (!code) throw new Error(`"${ch}" can't be typed on this keyboard: paste it instead.`)
      if (spareReset) clearTimeout(spareReset)
      lend(code, keysymOf(ch))
      key(code, true)
      key(code, false)
      flush()
      spareReset = setTimeout(() => {
        spareReset = null
        lend(code, 0)
      }, 200)
    },

    /** Asked of the window manager (_NET_RESTACK_WINDOW), when the frame isn't just above already. */
    stackAbove(frame: number, target: number): void {
      const order = stacking()
      const i = order.indexOf(target)
      if (i < 0 || order[i + 1] === frame) return
      clientMessage(frame, '_NET_RESTACK_WINDOW', [2, target, 0])
    },

    captureWindow: (w: WindowInfo) => windowSource(w),
    /** Speak's windows are blanked in the generic screenshot instead (X11 can't keep them out). */
    captureArea: async () => null
  }
}
