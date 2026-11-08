import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopCapturer, nativeImage, screen, type NativeImage } from 'electron'
import { log } from '../log'
import { paths } from '../paths'
import { delay, isWin } from '../util'

/**
 * The screen as control mode sees and drives it, on Windows: the windows (what app, where), what
 * a window shows (a screenshot, the names and places of its buttons and fields through UI
 * Automation), and the mouse and keyboard (SendInput, like a person's). Coordinates are physical
 * screen pixels, as Windows gives them to this (per-monitor DPI aware) process.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface WindowInfo {
  /** HWND, as a number (fits: handles are 32-bit values). */
  id: number
  title: string
  pid: number
  /** The program: "OUTLOOK.EXE". */
  exe: string
  rect: Rect
  minimized: boolean
  focused: boolean
}

export interface Element {
  type: string
  name: string
  x: number
  y: number
  w: number
  h: number
  value?: string
  disabled?: boolean
  password?: boolean
  focused?: boolean
  aid?: string
}

export const screenSupported = isWin

// ---------------------------------------------------------------- Win32

interface Win32 {
  EnumWindows: (cb: bigint, l: number) => boolean
  IsWindowVisible: (h: number) => boolean
  IsWindow: (h: number) => boolean
  IsIconic: (h: number) => boolean
  GetWindowTextW: (h: number, buf: Buffer, max: number) => number
  GetWindowThreadProcessId: (h: number, pid: number[]) => number
  GetWindowLongPtrW: (h: number, idx: number) => number | bigint
  DwmGetWindowAttribute: (h: number, attr: number, buf: Buffer, size: number) => number
  OpenProcess: (access: number, inherit: boolean, pid: number) => number | bigint
  CloseHandle: (h: number | bigint) => boolean
  QueryFullProcessImageNameW: (h: number | bigint, flags: number, buf: Buffer, size: number[]) => boolean
  GetForegroundWindow: () => number | bigint
  SetForegroundWindow: (h: number) => boolean
  BringWindowToTop: (h: number) => boolean
  ShowWindow: (h: number, cmd: number) => boolean
  AttachThreadInput: (a: number, b: number, attach: boolean) => boolean
  GetCurrentThreadId: () => number
  WindowFromPoint: (pt: { x: number; y: number }) => number | bigint
  GetAncestor: (h: number, flags: number) => number | bigint
  SetCursorPos: (x: number, y: number) => boolean
  SendInput: (count: number, inputs: Buffer, size: number) => number
  MapVirtualKeyW: (code: number, type: number) => number
  VkKeyScanW: (ch: number) => number
  register: (fn: (h: number) => boolean) => bigint
  unregister: (cb: bigint) => void
  GetWindowRect: (h: number, r: Buffer) => boolean
  GetCursorPos: (pt: Buffer) => boolean
  GetDC: (h: number) => number | bigint
  ReleaseDC: (h: number, dc: number | bigint) => number
  CreateCompatibleDC: (dc: number | bigint) => number | bigint
  CreateCompatibleBitmap: (dc: number | bigint, w: number, h: number) => number | bigint
  SelectObject: (dc: number | bigint, obj: number | bigint) => number | bigint
  DeleteObject: (obj: number | bigint) => boolean
  DeleteDC: (dc: number | bigint) => boolean
  PrintWindow: (h: number, dc: number | bigint, flags: number) => boolean
  GetDIBits: (dc: number | bigint, bmp: number | bigint, start: number, lines: number, bits: Buffer, info: Buffer, usage: number) => number
}

let win32: Win32 | null | undefined

function load(): Win32 | null {
  if (win32 !== undefined) return win32
  win32 = null
  if (!isWin) return null
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    const dwm = koffi.load('dwmapi.dll')
    const gdi32 = koffi.load('gdi32.dll')
    const POINT = koffi.struct('SPEAK_POINT', { x: 'int32', y: 'int32' })
    const EnumProc = koffi.proto('bool __stdcall SpeakEnumWindowsProc(intptr_t hwnd, intptr_t lParam)')
    win32 = {
      EnumWindows: user32.func('bool __stdcall EnumWindows(SpeakEnumWindowsProc *cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t h)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t h)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t h)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t h, _Out_ uint8_t *buf, int max)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t h, _Out_ uint32 *pid)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t h, int idx)'),
      DwmGetWindowAttribute: dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr_t h, uint32 attr, _Out_ uint8_t *buf, uint32 size)'),
      OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ uint8_t *buf, _Inout_ uint32 *size)'
      ),
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t h)'),
      BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr_t h)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t h, int cmd)'),
      AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool attach)'),
      GetCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
      WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(SPEAK_POINT pt)'),
      GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t h, uint32 flags)'),
      SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
      SendInput: user32.func('uint32 __stdcall SendInput(uint32 count, const uint8_t *inputs, int size)'),
      MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 code, uint32 type)'),
      VkKeyScanW: user32.func('int16 __stdcall VkKeyScanW(uint16 ch)'),
      register: (fn) => koffi.register((h: number) => fn(Number(h)), koffi.pointer(EnumProc)),
      unregister: (cb) => koffi.unregister(cb),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t h, _Out_ uint8_t *r)'),
      GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ uint8_t *pt)'),
      GetDC: user32.func('intptr_t __stdcall GetDC(intptr_t h)'),
      ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr_t h, intptr_t dc)'),
      CreateCompatibleDC: gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t dc)'),
      CreateCompatibleBitmap: gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t dc, int w, int h)'),
      SelectObject: gdi32.func('intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)'),
      DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t obj)'),
      DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr_t dc)'),
      PrintWindow: user32.func('bool __stdcall PrintWindow(intptr_t h, intptr_t dc, uint32 flags)'),
      GetDIBits: gdi32.func(
        'int __stdcall GetDIBits(intptr_t dc, intptr_t bmp, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ uint8_t *info, uint32 usage)'
      )
    } as Win32
    void POINT
  } catch (err) {
    log.warn('Control: Win32 bindings unavailable:', err)
  }
  return win32
}

function need(): Win32 {
  const w = load()
  if (!w) throw new Error('Controlling apps is only available on Windows for now.')
  return w
}

const exeCache = new Map<number, string>()

function exeOf(w: Win32, pid: number): string {
  const known = exeCache.get(pid)
  if (known !== undefined) return known
  let exe = ''
  const h = w.OpenProcess(0x1000, false, pid) // PROCESS_QUERY_LIMITED_INFORMATION
  if (h) {
    const buf = Buffer.alloc(2080)
    const size = [1040]
    if (w.QueryFullProcessImageNameW(h, 0, buf, size))
      exe =
        buf
          .toString('utf16le', 0, size[0] * 2)
          .split(/[\\/]/)
          .pop() ?? ''
    w.CloseHandle(h)
  }
  exeCache.set(pid, exe)
  return exe
}

function info(w: Win32, h: number, fg: number): WindowInfo | null {
  if (!w.IsWindowVisible(h)) return null
  const buf = Buffer.alloc(1024)
  const n = w.GetWindowTextW(h, buf, 512)
  const title = buf.toString('utf16le', 0, n * 2)
  if (!title) return null
  const cloaked = Buffer.alloc(4)
  w.DwmGetWindowAttribute(h, 14, cloaked, 4) // DWMWA_CLOAKED: on another virtual desktop, or a hidden UWP frame
  if (cloaked.readUInt32LE(0)) return null
  if (Number(w.GetWindowLongPtrW(h, -20)) & 0x80) return null // WS_EX_TOOLWINDOW
  const r = Buffer.alloc(16)
  w.DwmGetWindowAttribute(h, 9, r, 16) // DWMWA_EXTENDED_FRAME_BOUNDS: the visible frame, without the invisible resize borders
  const pid = [0]
  w.GetWindowThreadProcessId(h, pid)
  const rect = { x: r.readInt32LE(0), y: r.readInt32LE(4), w: r.readInt32LE(8) - r.readInt32LE(0), h: r.readInt32LE(12) - r.readInt32LE(4) }
  return { id: h, title, pid: pid[0], exe: exeOf(w, pid[0]), rect, minimized: w.IsIconic(h), focused: h === fg }
}

/** The windows on screen, front to back: titled, visible, not Speak's own. */
export function listWindows(): WindowInfo[] {
  const w = need()
  const fg = Number(w.GetForegroundWindow())
  const out: WindowInfo[] = []
  const cb = w.register((h) => {
    const i = info(w, h, fg)
    if (i && i.pid !== process.pid) out.push(i)
    return true
  })
  try {
    w.EnumWindows(cb, 0)
  } finally {
    w.unregister(cb)
  }
  return out
}

export function windowInfo(id: number): WindowInfo | null {
  const w = need()
  if (!w.IsWindow(id)) return null
  return info(w, id, Number(w.GetForegroundWindow()))
}

export function foregroundWindow(): WindowInfo | null {
  const w = need()
  const fg = Number(w.GetForegroundWindow())
  return fg ? info(w, fg, fg) : null
}

/** The top-level window under a point of the screen. */
export function windowAt(x: number, y: number): WindowInfo | null {
  const w = need()
  const h = Number(w.WindowFromPoint({ x, y }))
  if (!h) return null
  const root = Number(w.GetAncestor(h, 2)) || h // GA_ROOT
  const fg = Number(w.GetForegroundWindow())
  const pid = [0]
  w.GetWindowThreadProcessId(root, pid)
  const i = info(w, root, fg)
  return i ?? { id: root, title: '', pid: pid[0], exe: exeOf(w, pid[0]), rect: { x, y, w: 0, h: 0 }, minimized: false, focused: root === fg }
}

/**
 * Bring a window to the front with the keyboard focus. Windows only lets the foreground process
 * do that: Speak borrows the foreground thread's input queue, and taps Alt (which unlocks it).
 */
export async function focusWindow(id: number): Promise<boolean> {
  const w = need()
  if (!w.IsWindow(id)) return false
  if (w.IsIconic(id)) w.ShowWindow(id, 9) // SW_RESTORE
  if (Number(w.GetForegroundWindow()) === id) return true
  const fgThread = w.GetWindowThreadProcessId(Number(w.GetForegroundWindow()), [0])
  const self = w.GetCurrentThreadId()
  const attach = fgThread && fgThread !== self
  if (attach) w.AttachThreadInput(self, fgThread, true)
  keyEvents([
    [VK.Alt, false],
    [VK.Alt, true]
  ])
  w.SetForegroundWindow(id)
  w.BringWindowToTop(id)
  if (attach) w.AttachThreadInput(self, fgThread, false)
  await delay(120)
  return Number(w.GetForegroundWindow()) === id
}

// ---------------------------------------------------------------- input

/** sizeof(INPUT) on 64-bit Windows. */
const INPUT_SIZE = 40
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const KEYEVENTF_UNICODE = 0x4
const MOUSE = { leftDown: 0x2, leftUp: 0x4, rightDown: 0x8, rightUp: 0x10, middleDown: 0x20, middleUp: 0x40, wheel: 0x800, hwheel: 0x1000 }

/** Speak's own input, to tell it from the user's (whose input pauses the session). */
let injectingUntil = 0
export const injecting = () => Date.now() < injectingUntil

function send(buf: Buffer, count: number): void {
  const w = need()
  injectingUntil = Date.now() + 400
  const sent = w.SendInput(count, buf, INPUT_SIZE)
  if (sent !== count) throw new Error('Windows did not take the input (an app running as administrator, or a secure screen, is in front).')
}

function mouseEvents(events: Array<{ flags: number; data?: number }>): void {
  const buf = Buffer.alloc(INPUT_SIZE * events.length)
  events.forEach((e, i) => {
    const o = i * INPUT_SIZE
    buf.writeUInt32LE(INPUT_MOUSE, o)
    buf.writeInt32LE(e.data ?? 0, o + 16) // mi.mouseData
    buf.writeUInt32LE(e.flags, o + 20) // mi.dwFlags
  })
  send(buf, events.length)
}

export const VK: Record<string, number> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Shift: 0x10,
  Ctrl: 0x11,
  Alt: 0x12,
  Pause: 0x13,
  CapsLock: 0x14,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  Win: 0x5b,
  Menu: 0x5d,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b
}
const ALIASES: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  win: 'Win',
  windows: 'Win',
  super: 'Win',
  meta: 'Win',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  menu: 'Menu',
  capslock: 'CapsLock',
  printscreen: 'PrintScreen'
}
/** Keys sharing a scan code with the numpad: the dedicated keys are the extended ones. */
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5d])

function keyEvents(keys: Array<[number, boolean]>): void {
  const w = need()
  const buf = Buffer.alloc(INPUT_SIZE * keys.length)
  keys.forEach(([vk, up], i) => {
    const scan = w.MapVirtualKeyW(vk, 4) // MAPVK_VK_TO_VSC_EX
    const extended = EXTENDED.has(vk) || (scan & 0xff00) === 0xe000
    const o = i * INPUT_SIZE
    buf.writeUInt32LE(INPUT_KEYBOARD, o)
    buf.writeUInt16LE(vk, o + 8)
    buf.writeUInt16LE(scan & 0xff, o + 10)
    buf.writeUInt32LE((up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0), o + 12)
  })
  send(buf, keys.length)
}

/** "ctrl+shift+s", "enter", "alt+f4" → virtual keys; throws on a key it doesn't know. */
export function parseKeys(combo: string): number[] {
  const w = need()
  return combo
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const name = ALIASES[k.toLowerCase()] ?? (VK[k] !== undefined ? k : /^f([1-9]|1[0-2])$/i.test(k) ? k.toUpperCase() : '')
      if (name && VK[name] !== undefined) return VK[name]
      if (k.length === 1) {
        const scan = w.VkKeyScanW(k.charCodeAt(0))
        if (scan !== -1) return scan & 0xff
      }
      throw new Error(`Unknown key "${k}"`)
    })
}

export function pressKeys(combo: string): void {
  const vks = parseKeys(combo)
  if (!vks.length) throw new Error('No key to press')
  keyEvents([...vks.map((vk) => [vk, false] as [number, boolean]), ...[...vks].reverse().map((vk) => [vk, true] as [number, boolean])])
}

/**
 * Type text as Unicode characters (any keyboard layout); new lines as Enter, tabs as Tab. In short
 * bursts (some apps drop characters sent too fast), checking `stop` between them: the user's hands
 * on the keyboard end it there. Returns how many characters went out.
 */
export async function typeText(text: string, stop: () => boolean = () => false): Promise<number> {
  const s = text.replace(/\r\n?/g, '\n')
  const BURST = 8
  let sent = 0
  for (let start = 0; start < s.length; start += BURST) {
    if (stop()) return sent
    const part = s.slice(start, start + BURST)
    const buf = Buffer.alloc(INPUT_SIZE * part.length * 2)
    for (let i = 0; i < part.length; i++) {
      const ch = part[i]
      const vk = ch === '\n' ? VK.Enter : ch === '\t' ? VK.Tab : 0
      for (const up of [false, true]) {
        const o = (i * 2 + (up ? 1 : 0)) * INPUT_SIZE
        buf.writeUInt32LE(INPUT_KEYBOARD, o)
        if (vk) {
          buf.writeUInt16LE(vk, o + 8)
          buf.writeUInt32LE(up ? KEYEVENTF_KEYUP : 0, o + 12)
        } else {
          buf.writeUInt16LE(part.charCodeAt(i), o + 10)
          buf.writeUInt32LE(KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), o + 12)
        }
      }
    }
    send(buf, part.length * 2)
    sent += part.length
    await delay(12)
  }
  return sent
}

export async function click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', count = 1): Promise<void> {
  const w = need()
  injectingUntil = Date.now() + 400
  w.SetCursorPos(Math.round(x), Math.round(y))
  await delay(40)
  const [down, up] =
    button === 'right' ? [MOUSE.rightDown, MOUSE.rightUp] : button === 'middle' ? [MOUSE.middleDown, MOUSE.middleUp] : [MOUSE.leftDown, MOUSE.leftUp]
  for (let i = 0; i < count; i++) {
    mouseEvents([{ flags: down }, { flags: up }])
    if (i < count - 1) await delay(60)
  }
}

export async function moveMouse(x: number, y: number): Promise<void> {
  injectingUntil = Date.now() + 400
  need().SetCursorPos(Math.round(x), Math.round(y))
  await delay(30)
}

/** Where the user's pointer is (to put it back). */
export function cursorPos(): { x: number; y: number } {
  const buf = Buffer.alloc(8)
  need().GetCursorPos(buf)
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) }
}

export async function drag(from: { x: number; y: number }, to: { x: number; y: number }, stop: () => boolean = () => false): Promise<void> {
  const w = need()
  injectingUntil = Date.now() + 1500
  w.SetCursorPos(Math.round(from.x), Math.round(from.y))
  await delay(60)
  mouseEvents([{ flags: MOUSE.leftDown }])
  try {
    for (let i = 1; i <= 10; i++) {
      if (stop()) break
      injectingUntil = Date.now() + 400
      w.SetCursorPos(Math.round(from.x + ((to.x - from.x) * i) / 10), Math.round(from.y + ((to.y - from.y) * i) / 10))
      await delay(25)
    }
  } finally {
    mouseEvents([{ flags: MOUSE.leftUp }])
  }
}

/** Scroll at a point: dy > 0 scrolls down, in notches. */
export async function scroll(x: number, y: number, dy: number, dx = 0): Promise<void> {
  await moveMouse(x, y)
  if (dy) mouseEvents([{ flags: MOUSE.wheel, data: -Math.round(dy) * 120 }])
  if (dx) mouseEvents([{ flags: MOUSE.hwheel, data: Math.round(dx) * 120 }])
}

/** A minimized window shown again without taking the focus (to look at it, or read its controls). */
export async function unminimize(id: number): Promise<void> {
  const w = need()
  if (!w.IsIconic(id)) return
  w.ShowWindow(id, 4) // SW_SHOWNOACTIVATE
  await delay(250)
}

// ---------------------------------------------------------------- screenshots

export interface Shot {
  image: NativeImage
  /** The area shot, in screen pixels. */
  area: Rect
  /** Screen pixels per image pixel. */
  scale: number
}

const MAX_SHOT = 1366

/** The displays in screen pixels (Electron gives DIPs: scaled by each display's factor). */
function physicalDisplays(): Array<{ id: number; rect: Rect }> {
  return screen.getAllDisplays().map((d) => {
    const p = screen.dipToScreenRect(null, d.bounds)
    return { id: d.id, rect: { x: p.x, y: p.y, w: p.width, h: p.height } }
  })
}

/** The whole desktop, every display, in screen pixels. */
export function desktopRect(): Rect {
  const all = physicalDisplays().map((d) => d.rect)
  const x = Math.min(...all.map((r) => r.x))
  const y = Math.min(...all.map((r) => r.y))
  return { x, y, w: Math.max(...all.map((r) => r.x + r.w)) - x, h: Math.max(...all.map((r) => r.y + r.h)) - y }
}

export function displayRects(): Rect[] {
  return physicalDisplays().map((d) => d.rect)
}

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const bt = Math.min(a.y + a.h, b.y + b.h)
  return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : null
}

function fit(image: NativeImage, area: Rect): Shot {
  const width = image.getSize().width
  if (width <= MAX_SHOT) return { image, area, scale: area.w / width }
  return { image: image.resize({ width: MAX_SHOT, quality: 'good' }), area, scale: area.w / MAX_SHOT }
}

/**
 * A screenshot of an area of the screen as it is in front (a display, a window brought forward).
 * Speak's own windows aren't in it (they're excluded from capture).
 */
export async function shoot(area: Rect): Promise<Shot> {
  const displays = physicalDisplays()
  let best: { id: number; rect: Rect; part: Rect } | null = null
  for (const d of displays) {
    const part = intersect(area, d.rect)
    if (part && (!best || part.w * part.h > best.part.w * best.part.h)) best = { ...d, part }
  }
  if (!best) throw new Error('That area is off screen.')
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: best.rect.w, height: best.rect.h } })
  const source = sources.find((s) => s.display_id === String(best!.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) throw new Error('Could not take a screenshot.')
  const image = source.thumbnail
  // The thumbnail may come scaled: map screen pixels to its pixels.
  const k = image.getSize().width / best.rect.w
  const cropped = image.crop({
    x: Math.round((best.part.x - best.rect.x) * k),
    y: Math.round((best.part.y - best.rect.y) * k),
    width: Math.round(best.part.w * k),
    height: Math.round(best.part.h * k)
  })
  return fit(cropped, best.part)
}

/**
 * A window's picture as it draws itself, even behind other windows or on another screen, without
 * bringing it forward (PrintWindow with PW_RENDERFULLCONTENT). Null when the app doesn't draw that
 * way (an empty, black picture): then it has to come to the front to be seen.
 */
export async function captureWindow(id: number): Promise<Shot | null> {
  const w = need()
  if (!w.IsWindow(id)) return null
  await unminimize(id)
  const wr = Buffer.alloc(16)
  w.GetWindowRect(id, wr)
  const outer = { x: wr.readInt32LE(0), y: wr.readInt32LE(4), w: wr.readInt32LE(8) - wr.readInt32LE(0), h: wr.readInt32LE(12) - wr.readInt32LE(4) }
  const frame = info(w, id, 0)?.rect ?? outer
  if (outer.w <= 0 || outer.h <= 0 || outer.w > 16384 || outer.h > 16384) return null
  const screenDc = w.GetDC(0)
  const dc = w.CreateCompatibleDC(screenDc)
  const bmp = w.CreateCompatibleBitmap(screenDc, outer.w, outer.h)
  const old = w.SelectObject(dc, bmp)
  try {
    if (!w.PrintWindow(id, dc, 2)) return null // PW_RENDERFULLCONTENT
    const header = Buffer.alloc(44)
    header.writeUInt32LE(40, 0) // biSize
    header.writeInt32LE(outer.w, 4)
    header.writeInt32LE(-outer.h, 8) // top-down
    header.writeUInt16LE(1, 12) // biPlanes
    header.writeUInt16LE(32, 14) // biBitCount
    const pixels = Buffer.alloc(outer.w * outer.h * 4)
    w.SelectObject(dc, old)
    if (!w.GetDIBits(dc, bmp, 0, outer.h, pixels, header, 0)) return null
    // GDI leaves alpha at 0: opaque it. And an all-black picture is an app that didn't draw.
    let lit = 0
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + 3] = 255
      if (lit < 64 && (pixels[i] > 16 || pixels[i + 1] > 16 || pixels[i + 2] > 16) && i % 4096 === 0) lit++
    }
    if (lit < 4) return null
    const image = nativeImage.createFromBitmap(pixels, { width: outer.w, height: outer.h })
    const part = intersect(frame, outer) ?? outer
    const cropped = image.crop({ x: part.x - outer.x, y: part.y - outer.y, width: part.w, height: part.h })
    return fit(cropped, part)
  } finally {
    w.SelectObject(dc, old)
    w.DeleteObject(bmp)
    w.DeleteDC(dc)
    w.ReleaseDC(0, screenDc)
  }
}

/** A box drawn on a picture (where it will click, what it will fill), in the picture's pixels. */
export function markBox(image: NativeImage, box: { x: number; y: number; w: number; h: number }, rgb: [number, number, number]): NativeImage {
  const { width, height } = image.getSize()
  const px = Buffer.from(image.toBitmap())
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const o = (y * width + x) * 4
    px[o] = rgb[2]
    px[o + 1] = rgb[1]
    px[o + 2] = rgb[0]
    px[o + 3] = 255
  }
  const x0 = Math.round(box.x)
  const y0 = Math.round(box.y)
  const x1 = Math.round(box.x + box.w)
  const y1 = Math.round(box.y + box.h)
  for (let t = 0; t < 3; t++) {
    for (let x = x0 - t; x <= x1 + t; x++) {
      set(x, y0 - t)
      set(x, y1 + t)
    }
    for (let y = y0 - t; y <= y1 + t; y++) {
      set(x0 - t, y)
      set(x1 + t, y)
    }
  }
  return nativeImage.createFromBitmap(px, { width, height })
}

// ---------------------------------------------------------------- UI Automation

/**
 * Speak's bridge to UI Automation: a PowerShell process kept for the session, answering JSON lines.
 * It keeps the elements it listed per window, so that the AI can act on them by number, in the
 * background: press (invoke, toggle, select, expand), fill (set a field's value), scroll, focus.
 */
const UIA_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SpeakDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][SpeakDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.ControlType]
$keep = @{}
foreach ($n in 'Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem','RadioButton','Slider','Spinner','SplitButton','TabItem','TreeItem','DataItem','Document','Text','Menu','Header','HeaderItem') { $keep[$T::($n).Id] = $n.ToLower() }
$script:snap = @{}

function Elements($hwnd, $max) {
  $root = $A::FromHandle([IntPtr]::new([long]$hwnd))
  $cache = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in $A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty, $A::IsEnabledProperty, $A::IsPasswordProperty, $A::AutomationIdProperty, $A::HasKeyboardFocusProperty) { $cache.Add($p) }
  $cache.Add([System.Windows.Automation.ValuePattern]::Pattern)
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
  $cond = New-Object System.Windows.Automation.PropertyCondition($A::IsOffscreenProperty, $false)
  $act = $cache.Activate()
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) } finally { $act.Dispose() }
  $out = New-Object System.Collections.ArrayList
  $kept = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    if ($out.Count -ge $max) { break }
    $c = $e.Cached
    $type = $keep[$c.ControlType.Id]
    if (-not $type) { continue }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 2 -or $r.Height -lt 2) { continue }
    $name = [string]$c.Name
    if ($type -eq 'text' -and -not $name) { continue }
    $o = [ordered]@{ type = $type; name = $name.Substring(0, [Math]::Min(120, $name.Length)); x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    if (-not $c.IsEnabled) { $o.disabled = $true }
    if ($c.IsPassword) { $o.password = $true }
    if ($c.HasKeyboardFocus) { $o.focused = $true }
    if ($c.AutomationId) { $o.aid = [string]$c.AutomationId }
    if (-not $c.IsPassword) {
      try { $v = $e.GetCachedPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value; if ($v) { $o.value = $v.Substring(0, [Math]::Min(300, $v.Length)) } } catch {}
    }
    [void]$out.Add($o)
    [void]$kept.Add($e)
  }
  $script:snap["$hwnd"] = $kept
  return $out
}

function Get($hwnd, $index) {
  $list = $script:snap["$hwnd"]
  if (-not $list -or $index -lt 1 -or $index -gt $list.Count) { throw "No element e$index for this window: list its elements again." }
  return $list[$index - 1]
}

function Press($e) {
  [object]$p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return 'toggle' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return 'select' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
    if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $p.Expand() } else { $p.Collapse() }
    return 'expand'
  }
  return $null
}

function Fill($e, $text) {
  [object]$p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly) { $p.SetValue([string]$text); return 'value' }
  return $null
}

function ScrollIn($hwnd, $index, $dy) {
  [object]$p = $null
  if ($index) {
    $cur = Get $hwnd $index
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  } else {
    $root = $A::FromHandle([IntPtr]::new([long]$hwnd))
    $cond = New-Object System.Windows.Automation.PropertyCondition($A::IsScrollPatternAvailableProperty, $true)
    $cur = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $walker = $null
  }
  while ($cur) {
    if ($cur.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p) -and $p.Current.VerticallyScrollable) {
      $amount = if ($dy -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
      for ($i = 0; $i -lt [Math]::Abs([int]$dy) * 3; $i++) { $p.ScrollVertical($amount) }
      return 'scroll'
    }
    if (-not $walker) { break }
    $cur = $walker.GetParent($cur)
  }
  return $null
}

function Focused() {
  $e = $A::FocusedElement
  if (-not $e) { return $null }
  $c = $e.Current
  return [ordered]@{ type = $keep[$c.ControlType.Id]; name = [string]$c.Name; password = [bool]$c.IsPassword }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$stdin = [Console]::In
Write-Output (ConvertTo-Json -Compress @{ ready = $true })
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  $res = @{}
  try {
    $req = ConvertFrom-Json $line
    $res.id = $req.id
    switch ($req.op) {
      'elements' { $res.elements = @(Elements $req.hwnd $req.max) }
      'focused' { $res.focused = Focused }
      'press' { $res.done = Press (Get $req.hwnd $req.index) }
      'fill' { $res.done = Fill (Get $req.hwnd $req.index) $req.text }
      'scroll' { $res.done = ScrollIn $req.hwnd $req.index $req.dy }
      'focus' { (Get $req.hwnd $req.index).SetFocus(); $res.done = 'focus' }
      default { $res.error = "unknown op $($req.op)" }
    }
  } catch { $res.error = $_.Exception.Message }
  Write-Output (ConvertTo-Json -Compress -Depth 5 $res)
}
`

type Focused = { type?: string; name: string; password: boolean } | null
interface UiaReply {
  elements?: Element[]
  focused?: Focused
  /** What a background action did ('invoke', 'value'…), or null when the element doesn't support it. */
  done?: string | null
  error?: string
}

class Uia {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private buf = ''
  private seq = 0
  private waiting = new Map<number, (r: UiaReply) => void>()

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const file = join(paths.tmp, 'speak-uia.ps1')
    writeFileSync(file, UIA_SCRIPT, 'utf8')
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true })
    this.proc = proc
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UI Automation did not start')), 15_000)
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (d: string) => {
        this.buf += d
        let i: number
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim()
          this.buf = this.buf.slice(i + 1)
          if (!line) continue
          try {
            const m = JSON.parse(line)
            if (m.ready) {
              clearTimeout(timer)
              resolve()
            } else this.waiting.get(m.id)?.(m)
            this.waiting.delete(m.id)
          } catch {
            // not ours
          }
        }
      })
      proc.stderr.on('data', (d) => log.warn('Control UI Automation:', String(d).trim().slice(0, 300)))
      proc.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('UI Automation stopped'))
        for (const done of this.waiting.values()) done({ error: 'UI Automation stopped' })
        this.waiting.clear()
        this.proc = null
        this.ready = null
      })
    })
    return this.ready
  }

  private async ask(req: Record<string, unknown>, timeoutMs = 8000): Promise<UiaReply> {
    await this.start()
    const id = ++this.seq
    return new Promise<UiaReply>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ error: 'UI Automation took too long (the app may not expose its controls)' })
      }, timeoutMs)
      this.waiting.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.proc?.stdin.write(JSON.stringify({ ...req, id }) + '\n')
    })
  }

  async elements(hwnd: number, max = 250): Promise<Element[]> {
    const r = await this.ask({ op: 'elements', hwnd, max })
    if (r.error) throw new Error(r.error)
    return r.elements ?? []
  }

  /** Press an element in the background (its default action). Null: it has none, a real click is needed. */
  async press(hwnd: number, index: number): Promise<string | null> {
    const r = await this.ask({ op: 'press', hwnd, index })
    if (r.error) throw new Error(r.error)
    return r.done ?? null
  }

  /** Set a field's whole value in the background. Null: it can't be set that way. */
  async fill(hwnd: number, index: number, text: string): Promise<string | null> {
    const r = await this.ask({ op: 'fill', hwnd, index, text })
    if (r.error) throw new Error(r.error)
    return r.done ?? null
  }

  /** Scroll an element's list or page (or the window's first) in the background. Null: nothing scrolls that way. */
  async scroll(hwnd: number, index: number | undefined, dy: number): Promise<string | null> {
    const r = await this.ask({ op: 'scroll', hwnd, index: index ?? 0, dy })
    if (r.error) throw new Error(r.error)
    return r.done ?? null
  }

  /** Give an element the keyboard focus (its window comes to the front). */
  async focus(hwnd: number, index: number): Promise<boolean> {
    const r = await this.ask({ op: 'focus', hwnd, index })
    return !r.error
  }

  /** The control with the keyboard focus (to notice a password field). */
  async focused(): Promise<Focused> {
    const r = await this.ask({ op: 'focused' }, 3000)
    return r.focused ?? null
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }
}

export const uia = new Uia()

/** Warm the UI Automation bridge up (it takes a second or two to start). */
export function warmScreen(): void {
  if (isWin) void uia.focused().catch(() => undefined)
}
