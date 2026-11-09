import { nativeImage, shell, type NativeImage } from 'electron'
import { log } from '../../log'
import { delay } from '../../util'
import { Bridge, BridgeAccessibility, nodeBridge } from './bridge'
import { blank, MAX_SHOT, windowSource } from './capture'
import { inRect, unavailable } from './common'
import { announce } from './hands'
import { parseCombo } from './keys'
import axScript from './mac-ax?modulePath'
import type { Button, Point, Rect, ScreenBackend, WindowInfo } from './types'

/**
 * macOS: the windows through CoreGraphics' window list, a window's picture through the window
 * server (even behind others), its controls through Accessibility (AX, in a bridge process: see
 * mac-ax.ts), and the mouse and keyboard through CGEvent, like a person's. Coordinates are global
 * points (the top left of the main display at 0, 0), as CoreGraphics, AX, the input hook and
 * Electron all give them. It needs Accessibility (to read controls, and to send input) and Screen
 * Recording (to see other apps' windows and their titles): see screenReady.
 */

const FW = (name: string) => `/System/Library/Frameworks/${name}.framework/${name}`

type Ptr = bigint | null

const UTF8 = 0x08000100 // kCFStringEncodingUTF8
const FLOAT64 = 6 // kCFNumberFloat64Type
/** CGWindowListOption */
const LIST = { all: 0, onScreen: 1, including: 8, noDesktop: 16 }
/** CGWindowImageOption */
const IMAGE = { ignoreFraming: 1, best: 8, nominal: 16 }
const HID_STATE = 1 // kCGEventSourceStateHIDSystemState
const HID_TAP = 0 // kCGHIDEventTap
/** CGEventType */
const EVENT = { moved: 5, leftDragged: 6 }
const MOUSE: Record<Button, [number, number, number]> = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] } // down, up, CGMouseButton
const CLICK_STATE = 1 // kCGMouseEventClickState
const FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 }
/** Windows above popup menus (the cursor, the screen saver, overlays): never what a click lands on. */
const POPUP_LEVEL = 101
/** The menu bar's level (kCGMainMenuWindowLevel): it shows, and acts on, the front app's menus. */
const MENU_BAR_LEVEL = 24

/** Virtual key codes of keys that aren't characters (Carbon's kVK_*): the same on every layout. */
const KEY: Record<string, number> = {
  Enter: 0x24,
  Tab: 0x30,
  Space: 0x31,
  Backspace: 0x33,
  Escape: 0x35,
  CapsLock: 0x39,
  Delete: 0x75,
  Home: 0x73,
  End: 0x77,
  PageUp: 0x74,
  PageDown: 0x79,
  Left: 0x7b,
  Right: 0x7c,
  Down: 0x7d,
  Up: 0x7e,
  Insert: 0x72, // Help, where Insert is on a PC keyboard
  F1: 0x7a,
  F2: 0x78,
  F3: 0x63,
  F4: 0x76,
  F5: 0x60,
  F6: 0x61,
  F7: 0x62,
  F8: 0x64,
  F9: 0x65,
  F10: 0x6d,
  F11: 0x67,
  F12: 0x6f,
  F13: 0x69,
  F14: 0x6b,
  F15: 0x71,
  F16: 0x6a,
  F17: 0x40,
  F18: 0x4f,
  F19: 0x50,
  F20: 0x5a
}
const MODIFIER_KEY = { shift: 0x38, ctrl: 0x3b, alt: 0x3a, meta: 0x37 }
/**
 * When the layout can't be read: the letters on the same keys on QWERTY, AZERTY and QWERTZ, the
 * only ones pressed blind (⌘C, ⌘V, ⌘X work; ⌘A could be ⌘Q, so it's refused instead).
 */
// prettier-ignore
const SAME_EVERYWHERE: Record<string, number> = {
  b: 0x0b, c: 0x08, d: 0x02, e: 0x0e, f: 0x03, g: 0x05, h: 0x04, i: 0x22, j: 0x26, k: 0x28,
  l: 0x25, n: 0x2d, o: 0x1f, p: 0x23, r: 0x0f, s: 0x01, t: 0x11, u: 0x20, v: 0x09, x: 0x07
}
/** The numeric keypad: its characters come from the main keys instead. */
const KEYPAD = new Set([0x41, 0x43, 0x45, 0x47, 0x4b, 0x4c, 0x4e, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5b, 0x5c])

type Fn = (...args: any[]) => any

function bind() {
  const koffi = require('koffi') as typeof import('koffi')
  const cf = koffi.load(FW('CoreFoundation'))
  const cg = koffi.load(FW('CoreGraphics'))
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  const libc = koffi.load('/usr/lib/libSystem.B.dylib')
  koffi.struct('SpeakCGPoint', { x: 'double', y: 'double' })
  koffi.struct('SpeakCGSize', { width: 'double', height: 'double' })
  koffi.struct('SpeakCGRect', { origin: 'SpeakCGPoint', size: 'SpeakCGSize' })
  /** A function that recent macOS versions may drop (the legacy screenshot calls): undefined then. */
  const optional = (lib: ReturnType<typeof koffi.load>, def: string): Fn | undefined => {
    try {
      return lib.func(def)
    } catch {
      return undefined
    }
  }
  // The keyboard layout (Carbon's input sources): only to find which key types a character.
  let layout: { [k: string]: Fn | Ptr } = {}
  try {
    const carbon = koffi.load(FW('Carbon'))
    layout = {
      current: carbon.func('void *TISCopyCurrentKeyboardLayoutInputSource()'),
      ascii: carbon.func('void *TISCopyCurrentASCIICapableKeyboardLayoutInputSource()'),
      property: carbon.func('void *TISGetInputSourceProperty(void *source, void *key)'),
      layoutData: koffi.decode(carbon.symbol('kTISPropertyUnicodeKeyLayoutData'), 'void *') as Ptr,
      sourceId: koffi.decode(carbon.symbol('kTISPropertyInputSourceID'), 'void *') as Ptr,
      keyboardType: carbon.func('uint8_t LMGetKbdType()'),
      translate: carbon.func(
        'int32_t UCKeyTranslate(void *layout, uint16_t code, uint16_t action, uint32_t modifiers, uint32_t keyboardType, uint32_t options, _Inout_ uint32_t *deadKeys, unsigned long max, _Out_ unsigned long *length, _Out_ uint16_t *chars)'
      )
    }
  } catch (err) {
    log.warn('Control: the keyboard layout is unavailable:', (err as Error).message)
  }
  return {
    layout,
    CFRelease: cf.func('void CFRelease(void *cf)'),
    CFArrayGetCount: cf.func('long CFArrayGetCount(void *array)'),
    CFArrayGetValueAtIndex: cf.func('void *CFArrayGetValueAtIndex(void *array, long index)'),
    CFArrayCreate: cf.func('void *CFArrayCreate(void *allocator, void *values, long count, void *callbacks)'),
    CFDictionaryGetValue: cf.func('void *CFDictionaryGetValue(void *dict, void *key)'),
    CFStringCreateWithCString: cf.func('void *CFStringCreateWithCString(void *allocator, const char *s, uint32_t encoding)'),
    CFStringGetLength: cf.func('long CFStringGetLength(void *s)'),
    CFStringGetCString: cf.func('bool CFStringGetCString(void *s, _Out_ uint8_t *buf, long size, uint32_t encoding)'),
    CFNumberGetValue: cf.func('bool CFNumberGetValue(void *n, long type, _Out_ uint8_t *value)'),
    CFBooleanGetValue: cf.func('bool CFBooleanGetValue(void *b)'),
    CFDataGetLength: cf.func('long CFDataGetLength(void *data)'),
    CFDataGetBytePtr: cf.func('void *CFDataGetBytePtr(void *data)'),
    memcpy: libc.func('void *memcpy(_Out_ uint8_t *dst, void *src, size_t n)'),
    CGWindowListCopyWindowInfo: cg.func('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeTo)'),
    CGRectMakeWithDictionaryRepresentation: cg.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ SpeakCGRect *rect)'),
    CGWindowListCreateImage: optional(cg, 'void *CGWindowListCreateImage(SpeakCGRect bounds, uint32_t option, uint32_t window, uint32_t imageOption)'),
    CGWindowListCreateImageFromArray: optional(cg, 'void *CGWindowListCreateImageFromArray(SpeakCGRect bounds, void *windows, uint32_t imageOption)'),
    CGImageGetWidth: cg.func('size_t CGImageGetWidth(void *image)'),
    CGImageGetHeight: cg.func('size_t CGImageGetHeight(void *image)'),
    CGImageGetBytesPerRow: cg.func('size_t CGImageGetBytesPerRow(void *image)'),
    CGImageGetBitsPerPixel: cg.func('size_t CGImageGetBitsPerPixel(void *image)'),
    CGImageGetBitsPerComponent: cg.func('size_t CGImageGetBitsPerComponent(void *image)'),
    CGImageGetBitmapInfo: cg.func('uint32_t CGImageGetBitmapInfo(void *image)'),
    CGImageGetDataProvider: cg.func('void *CGImageGetDataProvider(void *image)'),
    CGDataProviderCopyData: cg.func('void *CGDataProviderCopyData(void *provider)'),
    CGImageRelease: cg.func('void CGImageRelease(void *image)'),
    CGEventSourceCreate: cg.func('void *CGEventSourceCreate(int32_t state)'),
    CGEventSourceSetLocalEventsSuppressionInterval: cg.func('void CGEventSourceSetLocalEventsSuppressionInterval(void *source, double seconds)'),
    CGEventSourceFlagsState: cg.func('uint64_t CGEventSourceFlagsState(int32_t state)'),
    CGEventSourceButtonState: cg.func('bool CGEventSourceButtonState(int32_t state, uint32_t button)'),
    CGEventCreate: cg.func('void *CGEventCreate(void *source)'),
    CGEventGetLocation: cg.func('SpeakCGPoint CGEventGetLocation(void *event)'),
    CGEventCreateKeyboardEvent: cg.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t key, bool down)'),
    CGEventKeyboardSetUnicodeString: cg.func('void CGEventKeyboardSetUnicodeString(void *event, unsigned long length, const uint16_t *chars)'),
    CGEventSetFlags: cg.func('void CGEventSetFlags(void *event, uint64_t flags)'),
    CGEventCreateMouseEvent: cg.func('void *CGEventCreateMouseEvent(void *source, uint32_t type, SpeakCGPoint position, uint32_t button)'),
    CGEventSetIntegerValueField: cg.func('void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)'),
    CGEventCreateScrollWheelEvent2: cg.func(
      'void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t count, int32_t wheel1, int32_t wheel2, int32_t wheel3)'
    ),
    CGEventPost: cg.func('void CGEventPost(uint32_t tap, void *event)'),
    CGRequestScreenCaptureAccess: optional(cg, 'bool CGRequestScreenCaptureAccess()'),
    objc_getClass: objc.func('void *objc_getClass(const char *name)'),
    sel_registerName: objc.func('void *sel_registerName(const char *name)'),
    msgPtr: objc.func('objc_msgSend', 'void *', ['void *', 'void *']),
    msgInt: objc.func('objc_msgSend', 'int32_t', ['void *', 'void *']),
    msgOrder: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long', 'long']),
    msgWithPid: objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'int32_t']),
    msgActivate: objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'unsigned long']),
    poolPush: objc.func('void *objc_autoreleasePoolPush()'),
    poolPop: objc.func('void objc_autoreleasePoolPop(void *pool)')
  }
}

type Mac = ReturnType<typeof bind>

let bound: Mac | null = null

/** Ask macOS to let Speak record the screen (its prompt the first time), and open the pane where it's turned on. */
export function requestScreenCapture(): void {
  let granted = false
  try {
    granted = !!bound?.CGRequestScreenCaptureAccess?.()
  } catch (err) {
    log.warn('Control: could not ask for Screen Recording:', (err as Error).message)
  }
  if (!granted) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
}

/** A window of CoreGraphics' list, as it describes it. */
interface Raw {
  id: number
  pid: number
  owner: string
  title: string
  rect: Rect
  layer: number
  alpha: number
  onscreen: boolean
}

const cgRect = (r: Rect) => ({ origin: { x: r.x, y: r.y }, size: { width: r.w, height: r.h } })
/** Pixels for every point when the picture would be narrower than the AI's: one per point otherwise. */
const resolution = (r: Rect) => (r.w < MAX_SHOT ? IMAGE.best : IMAGE.nominal)

export function createMacBackend(): ScreenBackend {
  let m: Mac
  try {
    m = bind()
  } catch (err) {
    log.warn('Control: macOS bindings unavailable:', err)
    return unavailable(`Speak could not reach macOS to control apps: ${(err as Error).message}`)
  }
  bound = m

  const cfstr = (s: string): Ptr => m.CFStringCreateWithCString(null, s, UTF8)
  /** Keys of CoreGraphics' window descriptions (their constants hold their own names). */
  const K = {
    number: cfstr('kCGWindowNumber'),
    pid: cfstr('kCGWindowOwnerPID'),
    owner: cfstr('kCGWindowOwnerName'),
    name: cfstr('kCGWindowName'),
    bounds: cfstr('kCGWindowBounds'),
    layer: cfstr('kCGWindowLayer'),
    alpha: cfstr('kCGWindowAlpha'),
    onscreen: cfstr('kCGWindowIsOnscreen')
  }
  const source: Ptr = m.CGEventSourceCreate(HID_STATE)
  // Speak's events don't hold the user's own back for a moment, as posted events otherwise do.
  if (source) m.CGEventSourceSetLocalEventsSuppressionInterval(source, 0)

  const selectors = new Map<string, Ptr>()
  const sel = (name: string): Ptr => {
    let s = selectors.get(name)
    if (!s) selectors.set(name, (s = m.sel_registerName(name)))
    return s ?? null
  }
  /** Objective-C calls inside a pool of their own: what they return autoreleased goes with it. */
  const pooled = <T>(fn: () => T): T => {
    const pool = m.poolPush()
    try {
      return fn()
    } finally {
      m.poolPop(pool)
    }
  }

  const nbuf = Buffer.alloc(8)
  function num(d: Ptr, key: Ptr): number | undefined {
    const v = m.CFDictionaryGetValue(d, key)
    if (!v || !m.CFNumberGetValue(v, FLOAT64, nbuf)) return undefined
    return nbuf.readDoubleLE(0)
  }
  function str(s: Ptr): string {
    if (!s) return ''
    const len = Number(m.CFStringGetLength(s))
    if (!len) return ''
    const size = len * 4 + 1
    const buf = Buffer.alloc(size)
    if (!m.CFStringGetCString(s, buf, size, UTF8)) return ''
    const end = buf.indexOf(0)
    return buf.toString('utf8', 0, end < 0 ? size : end)
  }

  /** CoreGraphics' window list, front to back. */
  function raw(option: number, relativeTo = 0): Raw[] {
    const list = m.CGWindowListCopyWindowInfo(option, relativeTo)
    if (!list) return []
    const out: Raw[] = []
    try {
      const n = Number(m.CFArrayGetCount(list))
      for (let i = 0; i < n; i++) {
        const d = m.CFArrayGetValueAtIndex(list, i)
        if (!d) continue
        const id = num(d, K.number)
        const pid = num(d, K.pid)
        if (id === undefined || pid === undefined) continue
        const b = m.CFDictionaryGetValue(d, K.bounds)
        const r: { origin?: { x: number; y: number }; size?: { width: number; height: number } } = {}
        const ok = !!b && m.CGRectMakeWithDictionaryRepresentation(b, r) && r.origin && r.size
        const rect = ok
          ? { x: Math.round(r.origin!.x), y: Math.round(r.origin!.y), w: Math.round(r.size!.width), h: Math.round(r.size!.height) }
          : { x: 0, y: 0, w: 0, h: 0 }
        const on = m.CFDictionaryGetValue(d, K.onscreen)
        out.push({
          id,
          pid,
          owner: str(m.CFDictionaryGetValue(d, K.owner)),
          title: str(m.CFDictionaryGetValue(d, K.name)),
          rect,
          layer: num(d, K.layer) ?? 0,
          alpha: num(d, K.alpha) ?? 1,
          onscreen: !!on && !!m.CFBooleanGetValue(on)
        })
      }
    } finally {
      m.CFRelease(list)
    }
    return out
  }

  const onScreen = () => raw(LIST.onScreen | LIST.noDesktop)
  /** An app's window as a person sees one: ordinary (not a panel above the others), titled, not tiny. */
  const ordinary = (r: Raw) => r.layer === 0 && r.alpha > 0 && !!r.title && r.rect.w >= 20 && r.rect.h >= 20
  /** Windows the AI listed as minimized (AX knows, CoreGraphics only says they're off screen). */
  const minimized = new Set<number>()

  let workspace: Ptr = null
  /** The app with the keyboard, as macOS says right now. */
  function frontPid(): number {
    return pooled(() => {
      workspace ??= m.msgPtr(m.objc_getClass('NSWorkspace'), sel('sharedWorkspace'))
      const app = workspace ? m.msgPtr(workspace, sel('frontmostApplication')) : null
      return app ? Number(m.msgInt(app, sel('processIdentifier'))) : 0
    })
  }

  /** The front app's first ordinary window: its key window, unless a sheet or a panel of its own is in front. */
  function frontOf(list: Raw[]): Raw | undefined {
    const pid = frontPid()
    return list.find((r) => r.pid === pid && r.onscreen && ordinary(r))
  }

  const info = (r: Raw, focused?: number): WindowInfo => ({
    id: r.id,
    title: r.title,
    pid: r.pid,
    exe: r.owner,
    rect: r.rect,
    minimized: !r.onscreen,
    focused: r.id === focused
  })

  function byId(id: number): Raw | undefined {
    return raw(LIST.including, id).find((r) => r.id === id)
  }

  /** 32-bit pixels as CoreGraphics lays them out → BGRA rows, as Electron's bitmaps are. */
  function toBGRA(src: Buffer, width: number, height: number, stride: number, bitmapInfo: number): Buffer {
    const alpha = bitmapInfo & 0x1f // CGImageAlphaInfo
    const little = (bitmapInfo & 0x7000) === 0x2000 // kCGBitmapByteOrder32Little
    const first = alpha === 2 || alpha === 4 || alpha === 6 // premultiplied first, first, none skip first
    const opaque = alpha === 0 || alpha === 5 || alpha === 6
    // Where blue, green, red and alpha sit in each pixel's 4 bytes.
    const [b, g, r, a] = little ? (first ? [0, 1, 2, 3] : [1, 2, 3, 0]) : first ? [3, 2, 1, 0] : [2, 1, 0, 3]
    if (b === 0 && g === 1 && r === 2 && a === 3 && stride === width * 4 && !opaque) return src.subarray(0, width * height * 4)
    const out = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
      let s = y * stride
      let o = y * width * 4
      for (let x = 0; x < width; x++, s += 4, o += 4) {
        out[o] = src[s + b]
        out[o + 1] = src[s + g]
        out[o + 2] = src[s + r]
        out[o + 3] = opaque ? 255 : src[s + a]
      }
    }
    return out
  }

  /** A CGImage as an Electron image (and released). */
  function toImage(image: Ptr): NativeImage | null {
    try {
      const width = Number(m.CGImageGetWidth(image))
      const height = Number(m.CGImageGetHeight(image))
      const stride = Number(m.CGImageGetBytesPerRow(image))
      const info = Number(m.CGImageGetBitmapInfo(image))
      // 8 bits a channel, 4 channels, integers in a plain order (not float, nor packed 10-bit).
      const plain = Number(m.CGImageGetBitsPerPixel(image)) === 32 && Number(m.CGImageGetBitsPerComponent(image)) === 8 && !(info & 0xf0100)
      if (!width || !height || !plain) return null
      const data = m.CGDataProviderCopyData(m.CGImageGetDataProvider(image))
      if (!data) return null
      let pixels: Buffer
      try {
        const len = Number(m.CFDataGetLength(data))
        if (len < stride * (height - 1) + width * 4) return null
        pixels = Buffer.alloc(len)
        m.memcpy(pixels, m.CFDataGetBytePtr(data), len)
      } finally {
        m.CFRelease(data)
      }
      const bgra = toBGRA(pixels, width, height, stride, info)
      if (blank(bgra)) return null
      return nativeImage.createFromBitmap(bgra, { width, height })
    } finally {
      m.CGImageRelease(image)
    }
  }

  function post(event: Ptr): void {
    if (!event) throw new Error('macOS did not create the input event.')
    try {
      m.CGEventPost(HID_TAP, event)
    } finally {
      m.CFRelease(event)
    }
  }

  function key(code: number, down: boolean, flags: number, text?: Uint16Array): void {
    const event = m.CGEventCreateKeyboardEvent(source, code, down)
    if (!event) throw new Error('macOS did not create the input event.')
    m.CGEventSetFlags(event, flags)
    if (text) m.CGEventKeyboardSetUnicodeString(event, text.length, text)
    if (down) announce('key')
    post(event)
  }

  type KeyMap = Map<string, { code: number; shift: boolean }>
  /**
   * Which key types each character on the user's layout, with Shift or not: `plain` as it types,
   * `command` with ⌘ held (some layouts have keys of their own for shortcuts: Dvorak – QWERTY ⌘,
   * and non-Latin ones, whose ⌘ keys are Latin; the ASCII-capable layout fills what's missing).
   * Read again whenever the layout changes (macOS may switch it with the app in front), never
   * guessed: null when it can't be read. Dead keys aren't in it (they'd start an accent).
   */
  let keyMap: { id: string; plain: KeyMap; command: KeyMap } | null = null
  function keys(): { plain: KeyMap; command: KeyMap } | null {
    const L = m.layout
    if (!L.translate) return null
    try {
      const current: Ptr = (L.current as Fn)()
      if (!current) return null
      try {
        const id = str((L.property as Fn)(current, L.sourceId)) || 'unknown'
        if (keyMap?.id === id) return keyMap
        const kbd = (L.keyboardType as Fn)()
        const chars = new Uint16Array(4)
        /** One layout's keys, for two modifier states (Carbon's modifier bits >> 8: ⌘ 1, Shift 2), into `map`. */
        const read = (src: Ptr, states: [number, number], map: KeyMap): boolean => {
          const data: Ptr = (L.property as Fn)(src, L.layoutData)
          const layout: Ptr = data ? m.CFDataGetBytePtr(data) : null
          if (!layout) return false
          states.forEach((state, i) => {
            for (let code = 0; code < 128; code++) {
              if (KEYPAD.has(code)) continue
              const dead = [0]
              const length = [0]
              // A key down (kUCKeyActionDown), dead keys on: a dead key types nothing yet.
              if ((L.translate as Fn)(layout, code, 0, state, kbd, 0, dead, 4, length, chars) !== 0 || length[0] !== 1 || dead[0]) continue
              const ch = String.fromCharCode(chars[0])
              if (ch >= ' ' && !map.has(ch)) map.set(ch, { code, shift: i === 1 })
            }
          })
          return true
        }
        const plain: KeyMap = new Map()
        const command: KeyMap = new Map()
        if (!read(current, [0, 2], plain)) return null
        read(current, [1, 3], command)
        const ascii: Ptr = (L.ascii as Fn)()
        if (ascii) {
          try {
            read(ascii, [1, 3], command)
          } finally {
            m.CFRelease(ascii)
          }
        }
        keyMap = { id, plain, command }
        return keyMap
      } finally {
        m.CFRelease(current)
      }
    } catch (err) {
      log.warn('Control: could not read the keyboard layout:', (err as Error).message)
      return null
    }
  }

  const bridge = new Bridge(() => nodeBridge('Accessibility', axScript))
  const winOf = (r: Raw | WindowInfo) => ({ id: r.id, pid: r.pid, title: r.title, rect: r.rect })

  return {
    unsupported: () => null,
    mod: 'cmd',
    a11y: new BridgeAccessibility(bridge, () => ({}), 12_000),

    /** Which windows are minimized: AX knows (CoreGraphics only says a window is off screen). */
    async refresh(): Promise<void> {
      const pids = [
        ...new Set(
          raw(LIST.all | LIST.noDesktop)
            .filter((r) => !r.onscreen && ordinary(r) && r.pid !== process.pid)
            .map((r) => r.pid)
        )
      ]
      if (!pids.length) return minimized.clear()
      const r = await bridge.ask({ op: 'minimized', pids }, 5000)
      if (r.error) throw new Error(r.error)
      minimized.clear()
      for (const id of r.ids ?? []) minimized.add(id)
    },

    listWindows(): WindowInfo[] {
      const all = raw(LIST.all | LIST.noDesktop)
      const fg = frontOf(all)
      return all.filter((r) => ordinary(r) && (r.onscreen || minimized.has(r.id))).map((r) => info(r, fg?.id))
    },

    windowInfo(id: number): WindowInfo | null {
      const r = byId(id)
      if (!r || !ordinary(r)) return null
      return info(r, frontOf(onScreen())?.id)
    },

    foregroundWindow(): WindowInfo | null {
      const fg = frontOf(onScreen())
      return fg ? info(fg, fg.id) : null
    },

    /**
     * Speak's own windows aren't hit: the frame lets clicks through (the panel and pill are told
     * apart in index.ts). The menu bar is the front app's: its menus are what a click there opens.
     */
    windowAt(x: number, y: number): WindowInfo | null {
      const list = onScreen()
      const front = frontOf(list)
      const hit = list.find((r) => r.pid !== process.pid && r.alpha > 0 && r.layer <= POPUP_LEVEL && inRect({ x, y }, r.rect))
      if (!hit) return null
      if (hit.layer === MENU_BAR_LEVEL && front) return { ...info(front, front.id), id: hit.id, title: 'menu bar', rect: hit.rect }
      return info(hit, front?.id)
    },

    /**
     * Through the bridge (the window server made to bring the window forward, as window switchers
     * do; then AX raises it), else asked from Speak's own process, which macOS may honor as an
     * app's request. macOS reports the new front app a moment later.
     */
    async focusWindow(id: number): Promise<boolean> {
      const r = byId(id)
      if (!r) return false
      if (frontOf(onScreen())?.id === id) return true
      const res = await bridge.ask({ op: 'raise', win: winOf(r) }, 5000)
      if (res.error) log.warn('Control: could not raise the window:', res.error)
      const there = async (tries: number) => {
        for (let i = 0; i < tries; i++) {
          await delay(50)
          if (frontOf(onScreen())?.id === id) return true
        }
        return false
      }
      if (await there(10)) return true
      pooled(() => {
        const cls: Ptr = m.objc_getClass('NSRunningApplication')
        const app: Ptr = cls ? m.msgWithPid(cls, sel('runningApplicationWithProcessIdentifier:'), r.pid) : null
        if (app) m.msgActivate(app, sel('activateWithOptions:'), 3) // all windows, ignoring other apps
      })
      if (!(await there(10))) return false
      // Its app is in front now: the window itself on top of its own.
      await bridge.ask({ op: 'raise', win: winOf(r) }, 3000)
      return there(6)
    },

    async unminimize(id: number): Promise<void> {
      const r = byId(id)
      if (!r || r.onscreen) return
      const res = await bridge.ask({ op: 'unminimize', win: winOf(r) }, 4000)
      if (res.error) throw new Error(res.error)
      minimized.delete(id)
      await delay(350) // the window comes back with its animation
    },

    /**
     * The keyboard goes to the front app's key window: the window's app is in front, nothing of
     * another app's covers it, and no other titled window of its own is ahead of it (a sheet, a
     * dialog or a menu of its own is its).
     */
    hasKeyboard(id: number): boolean {
      const pid = frontPid()
      const list = onScreen()
      const target = list.find((r) => r.id === id) ?? byId(id)
      if (!target || target.pid !== pid) return false
      const top = list.find((r) => r.layer === 0 && r.alpha > 0 && r.pid !== process.pid && r.rect.w > 1)
      if (top && top.pid !== pid) return false
      const fg = list.find((r) => r.pid === pid && ordinary(r))
      return !fg || fg.id === id
    },

    /** The hardware's state (not Speak's own events). */
    held() {
      const flags = Number(m.CGEventSourceFlagsState(HID_STATE))
      return {
        modifiers: (flags & (FLAG.shift | FLAG.ctrl | FLAG.alt | FLAG.meta)) !== 0,
        buttons: [0, 1, 2].some((b) => !!m.CGEventSourceButtonState(HID_STATE, b))
      }
    },

    cursorPos(): Point {
      const event = m.CGEventCreate(null)
      if (!event) return { x: 0, y: 0 }
      try {
        const p = m.CGEventGetLocation(event) as { x: number; y: number }
        return { x: Math.round(p.x), y: Math.round(p.y) }
      } finally {
        m.CFRelease(event)
      }
    },

    /** A move event (a drag's, with the button down): apps see the pointer there, the hook at the anchor. */
    movePointer(x: number, y: number, dragging = false): void {
      post(m.CGEventCreateMouseEvent(source, dragging ? EVENT.leftDragged : EVENT.moved, { x, y }, 0))
    },

    button(button: Button, down: boolean, at: Point, clicks = 1): void {
      const [d, u, b] = MOUSE[button]
      const event = m.CGEventCreateMouseEvent(source, down ? d : u, at, b)
      if (!event) throw new Error('macOS did not create the input event.')
      // The second click of a double click says so: apps don't time clicks themselves.
      m.CGEventSetIntegerValueField(event, CLICK_STATE, clicks)
      // The input hook reports the middle button's release as a press too.
      if (down || button === 'middle') announce('mouse')
      post(event)
    },

    /** In lines, three per notch; macOS's wheel goes up for positive values. */
    wheel(_at: Point, dy: number, dx: number): void {
      // The hook doesn't report a turn of nothing: no announcement for it.
      if (!dy && !dx) return
      const event = m.CGEventCreateScrollWheelEvent2(source, 1, 2, -dy * 3, -dx * 3, 0)
      if (!event) throw new Error('macOS did not create the input event.')
      announce('mouse')
      post(event)
    },

    /**
     * The keys with their modifiers set on them, as macOS reads shortcuts: a character's key from
     * the layout's ⌘ keys when ⌘ is held. Never a guess that could be another shortcut.
     */
    pressKeys(combo: string): void {
      const tokens = parseCombo(combo, true)
      const command = tokens.some((t) => 'mod' in t && t.mod === 'meta')
      const layout = keys()
      let flags = 0
      const codes: number[] = []
      for (const t of tokens) {
        if ('mod' in t) flags |= FLAG[t.mod]
        else if ('key' in t) {
          const code = KEY[t.key]
          if (code === undefined) throw new Error(`A Mac has no ${t.key} key.`)
          codes.push(code)
        } else {
          const ch = /^[A-Z]$/.test(t.char) ? t.char.toLowerCase() : t.char
          const k = layout
            ? ((command ? layout.command.get(ch) : undefined) ?? layout.plain.get(ch))
            : SAME_EVERYWHERE[ch] !== undefined
              ? { code: SAME_EVERYWHERE[ch], shift: false }
              : undefined
          if (!k) throw new Error(layout ? `No key types "${t.char}" on this keyboard layout.` : `Speak can't read the keyboard layout to press "${combo}".`)
          if (k.shift) flags |= FLAG.shift
          codes.push(k.code)
        }
      }
      if (codes.length) {
        for (const c of codes) key(c, true, flags)
        for (const c of [...codes].reverse()) key(c, false, flags)
        return
      }
      // Modifiers alone ("shift"): their own keys, each released without its own flag (or it would seem held).
      const mods = tokens.flatMap((t) => ('mod' in t ? [t.mod] : []))
      if (!mods.length) throw new Error('No key to press')
      let held = 0
      for (const mod of mods) key(MODIFIER_KEY[mod], true, (held |= FLAG[mod]))
      for (const mod of [...mods].reverse()) key(MODIFIER_KEY[mod], false, (held &= ~FLAG[mod]))
    },

    /**
     * The character itself goes with the key (a Unicode string): any layout, and no key's meaning.
     * The key is the one that types it on the user's layout, when there's one, for apps that read keys.
     */
    typeChar(ch: string): void {
      const text = Uint16Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i))
      const k = ch.length === 1 ? keys()?.plain.get(ch) : undefined
      const flags = k?.shift ? FLAG.shift : 0
      key(k?.code ?? 0, true, flags, text)
      key(k?.code ?? 0, false, flags, text)
    },

    /** The frame's NSWindow ordered just above the target's (window numbers are the window server's, shared by every app). */
    stackAbove(frame: number, target: number): void {
      if (!byId(target)) return
      pooled(() => {
        const view: Ptr = BigInt(frame)
        const win: Ptr = m.msgPtr(view, sel('window'))
        if (win) m.msgOrder(win, sel('orderWindow:relativeTo:'), 1, target) // NSWindowAbove
      })
    },

    /** The window server's picture of the window, even behind others; else Chromium's window capture. */
    async captureWindow(w: WindowInfo) {
      if (m.CGWindowListCreateImage && w.rect.w > 0 && w.rect.h > 0) {
        const image: Ptr = m.CGWindowListCreateImage(cgRect(w.rect), LIST.including, w.id, IMAGE.ignoreFraming | resolution(w.rect))
        const picture = image ? toImage(image) : null
        if (picture) return { image: picture, area: w.rect }
      }
      return windowSource(w)
    },

    /** The screen as it is, composed from every window but Speak's own (whatever macOS does with protected windows). */
    async captureArea(area: Rect): Promise<NativeImage | null> {
      if (!m.CGWindowListCreateImageFromArray) return null
      const ids = raw(LIST.onScreen)
        .filter((r) => r.pid !== process.pid)
        .map((r) => r.id)
      if (!ids.length) return null
      // A CFArray of window numbers, as CoreGraphics makes them: the values themselves, no callbacks.
      const values = Buffer.alloc(ids.length * 8)
      ids.forEach((id, i) => values.writeBigUInt64LE(BigInt(id), i * 8))
      const array: Ptr = m.CFArrayCreate(null, values, ids.length, null)
      if (!array) return null
      try {
        const image: Ptr = m.CGWindowListCreateImageFromArray(cgRect(area), array, resolution(area))
        return image ? toImage(image) : null
      } finally {
        m.CFRelease(array)
      }
    }
  }
}
