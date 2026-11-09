import { serve, sleep, type Request } from './serve'

/**
 * Speak's bridge to macOS Accessibility (AX), in a process of its own (Electron run as Node, see
 * bridge.ts), as UI Automation's is on Windows. It lists a window's controls (buttons, fields,
 * links, menu items, text) with their places, keeps them numbered, and acts on them in the
 * background: press, set a value, scroll, focus. It also brings a window to the front, shows a
 * minimized one again, and tells which are minimized. Its access comes from Speak's own
 * Accessibility permission (a process Speak starts is Speak's, to macOS).
 */

const koffi = require('koffi') as typeof import('koffi')

type Ptr = bigint
type MaybePtr = Ptr | null

const FW = (name: string) => `/System/Library/Frameworks/${name}.framework/${name}`
const cf = koffi.load(FW('CoreFoundation'))
const ax = koffi.load(FW('ApplicationServices'))
const objc = koffi.load('/usr/lib/libobjc.A.dylib')
try {
  koffi.load(FW('AppKit')) // NSRunningApplication
} catch {
  // activating through AX only
}

const UTF8 = 0x08000100
const DOUBLE = 13 // kCFNumberDoubleType
const AX_POINT = 1
const AX_SIZE = 2
const AX_RANGE = 4
const AX_ERROR = 5
/** NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps (the latter ignored since macOS 14). */
const ACTIVATE = 3

const CFRelease = cf.func('void CFRelease(void *cf)')
const CFRetain = cf.func('void *CFRetain(void *cf)')
const CFGetTypeID = cf.func('unsigned long CFGetTypeID(void *cf)')
const CFArrayGetCount = cf.func('long CFArrayGetCount(void *array)')
const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)')
const CFArrayCreate = cf.func('void *CFArrayCreate(void *allocator, void *values, long count, void *callbacks)')
const CFStringCreateWithCString = cf.func('void *CFStringCreateWithCString(void *allocator, const char *s, uint32_t encoding)')
const CFStringGetLength = cf.func('long CFStringGetLength(void *s)')
const CFStringGetCString = cf.func('bool CFStringGetCString(void *s, _Out_ uint8_t *buf, long size, uint32_t encoding)')
const CFNumberGetValue = cf.func('bool CFNumberGetValue(void *n, long type, _Out_ uint8_t *value)')
const CFNumberCreate = cf.func('void *CFNumberCreate(void *allocator, long type, const uint8_t *value)')
const CFBooleanGetValue = cf.func('bool CFBooleanGetValue(void *b)')
const kCFBooleanTrue: Ptr = koffi.decode(cf.symbol('kCFBooleanTrue'), 'void *')
const kCFBooleanFalse: Ptr = koffi.decode(cf.symbol('kCFBooleanFalse'), 'void *')
const kCFTypeArrayCallBacks: Ptr = cf.symbol('kCFTypeArrayCallBacks')

const AXIsProcessTrusted = ax.func('bool AXIsProcessTrusted()')
const AXUIElementCreateApplication = ax.func('void *AXUIElementCreateApplication(int32_t pid)')
const AXUIElementCreateSystemWide = ax.func('void *AXUIElementCreateSystemWide()')
const AXUIElementCopyAttributeValue = ax.func('int32_t AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)')
const AXUIElementCopyMultipleAttributeValues = ax.func(
  'int32_t AXUIElementCopyMultipleAttributeValues(void *element, void *attributes, uint32_t options, _Out_ void **values)'
)
const AXUIElementSetAttributeValue = ax.func('int32_t AXUIElementSetAttributeValue(void *element, void *attribute, void *value)')
const AXUIElementIsAttributeSettable = ax.func('int32_t AXUIElementIsAttributeSettable(void *element, void *attribute, _Out_ uint8_t *settable)')
const AXUIElementPerformAction = ax.func('int32_t AXUIElementPerformAction(void *element, void *action)')
const AXUIElementCopyActionNames = ax.func('int32_t AXUIElementCopyActionNames(void *element, _Out_ void **names)')
const AXUIElementCopyParameterizedAttributeValue = ax.func(
  'int32_t AXUIElementCopyParameterizedAttributeValue(void *element, void *attribute, void *parameter, _Out_ void **value)'
)
const AXUIElementGetPid = ax.func('int32_t AXUIElementGetPid(void *element, _Out_ int32_t *pid)')
const AXUIElementSetMessagingTimeout = ax.func('int32_t AXUIElementSetMessagingTimeout(void *element, float seconds)')
const AXValueGetType = ax.func('uint32_t AXValueGetType(void *value)')
const AXValueGetValue = ax.func('bool AXValueGetValue(void *value, uint32_t type, _Out_ uint8_t *out)')
const AXValueCreate = ax.func('void *AXValueCreate(uint32_t type, const uint8_t *value)')
/** The window number of an AX window: private, but what every window tool on macOS relies on. */
let AXGetWindow: ((element: Ptr, out: number[]) => number) | null = null
try {
  AXGetWindow = ax.func('int32_t _AXUIElementGetWindow(void *element, _Out_ uint32_t *window)')
} catch {
  // matched by place and title instead
}

const objc_getClass = objc.func('void *objc_getClass(const char *name)')
const sel_registerName = objc.func('void *sel_registerName(const char *name)')
const msgWithPid = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'int32_t'])
const msgActivate = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'unsigned long'])
const poolPush = objc.func('void *objc_autoreleasePoolPush()')
const poolPop = objc.func('void objc_autoreleasePoolPop(void *pool)')

/**
 * The window server's own way to bring a window forward with the keyboard, as window switchers do
 * (AltTab, yabai): since macOS 14, apps activate others only cooperatively, and this process isn't
 * one. Private, so optional: AX and NSRunningApplication remain.
 */
const sky = (() => {
  try {
    const lib = koffi.load('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight')
    return {
      front: lib.func('int32_t _SLPSSetFrontProcessWithOptions(uint8_t *psn, uint32_t window, uint32_t mode)'),
      post: lib.func('int32_t SLPSPostEventRecordTo(uint8_t *psn, uint8_t *bytes)'),
      psnOf: ax.func('int32_t GetProcessForPID(int32_t pid, _Out_ uint8_t *psn)')
    }
  } catch {
    return null
  }
})()

const TYPE = {
  string: Number(cf.func('unsigned long CFStringGetTypeID()')()),
  number: Number(cf.func('unsigned long CFNumberGetTypeID()')()),
  boolean: Number(cf.func('unsigned long CFBooleanGetTypeID()')()),
  array: Number(cf.func('unsigned long CFArrayGetTypeID()')()),
  value: Number(ax.func('unsigned long AXValueGetTypeID()')())
}

// ---------------------------------------------------------------- Core Foundation values

const strings = new Map<string, Ptr>()
/** An attribute or action name, as a CFString kept for the process's life. */
function cfs(s: string): Ptr {
  let p = strings.get(s)
  if (!p) strings.set(s, (p = CFStringCreateWithCString(null, s, UTF8) as Ptr))
  return p
}

const typeOf = (v: MaybePtr) => (v ? Number(CFGetTypeID(v)) : -1)

function str(v: MaybePtr): string | undefined {
  if (typeOf(v) !== TYPE.string) return undefined
  const len = Number(CFStringGetLength(v))
  if (!len) return ''
  const size = len * 4 + 1
  const buf = Buffer.alloc(size)
  if (!CFStringGetCString(v, buf, size, UTF8)) return undefined
  const end = buf.indexOf(0)
  return buf.toString('utf8', 0, end < 0 ? size : end)
}

const nbuf = Buffer.alloc(8)
function num(v: MaybePtr): number | undefined {
  const t = typeOf(v)
  if (t === TYPE.boolean) return CFBooleanGetValue(v) ? 1 : 0
  if (t !== TYPE.number || !CFNumberGetValue(v, DOUBLE, nbuf)) return undefined
  return nbuf.readDoubleLE(0)
}

function bool(v: MaybePtr): boolean | undefined {
  const n = num(v)
  return n === undefined ? undefined : n !== 0
}

/** A point, a size (doubles) or a range (two longs) wrapped in an AXValue. */
function pair(v: MaybePtr, type: number): [number, number] | undefined {
  if (typeOf(v) !== TYPE.value || AXValueGetType(v) !== type) return undefined
  const b = Buffer.alloc(16)
  if (!AXValueGetValue(v, type, b)) return undefined
  return type === AX_RANGE ? [Number(b.readBigInt64LE(0)), Number(b.readBigInt64LE(8))] : [b.readDoubleLE(0), b.readDoubleLE(8)]
}

/** A CFArray's items (owned by the array). */
function items(v: MaybePtr): Ptr[] {
  if (typeOf(v) !== TYPE.array) return []
  const n = Number(CFArrayGetCount(v))
  const out: Ptr[] = []
  for (let i = 0; i < n; i++) {
    const item = CFArrayGetValueAtIndex(v, i) as MaybePtr
    if (item) out.push(item)
  }
  return out
}

/** An attribute's value, owned by the caller (null: none). */
function copy(element: Ptr, attribute: string): MaybePtr {
  const out: MaybePtr[] = [null]
  return AXUIElementCopyAttributeValue(element, cfs(attribute), out) === 0 && out[0] ? out[0] : null
}

/** An attribute read, and its value released. */
function read<T>(element: Ptr, attribute: string, as: (v: MaybePtr) => T | undefined): T | undefined {
  const v = copy(element, attribute)
  if (!v) return undefined
  try {
    return as(v)
  } finally {
    CFRelease(v)
  }
}

function settable(element: Ptr, attribute: string): boolean {
  const out = Buffer.alloc(1)
  return AXUIElementIsAttributeSettable(element, cfs(attribute), out) === 0 && out[0] !== 0
}

function setBool(element: Ptr, attribute: string, value: boolean): boolean {
  return AXUIElementSetAttributeValue(element, cfs(attribute), value ? kCFBooleanTrue : kCFBooleanFalse) === 0
}

function actions(element: Ptr): string[] {
  const out: MaybePtr[] = [null]
  if (AXUIElementCopyActionNames(element, out) !== 0 || !out[0]) return []
  try {
    return items(out[0])
      .map((a) => str(a))
      .filter((a): a is string => !!a)
  } finally {
    CFRelease(out[0])
  }
}

const perform = (element: Ptr, action: string) => AXUIElementPerformAction(element, cfs(action)) === 0

function pidOf(element: Ptr): number {
  const out = [0]
  return AXUIElementGetPid(element, out) === 0 ? out[0] : 0
}

function windowNumber(element: Ptr): number {
  if (!AXGetWindow) return 0
  const out = [0]
  return AXGetWindow(element, out) === 0 ? out[0] : 0
}

// ---------------------------------------------------------------- apps and windows

interface Win {
  id: number
  pid: number
  title: string
  rect: { x: number; y: number; w: number; h: number }
}

let systemWide: MaybePtr = null
function system(): Ptr {
  if (!systemWide) {
    systemWide = AXUIElementCreateSystemWide() as Ptr
    // On the system-wide element: every app's (a hung one answers nothing within this).
    AXUIElementSetMessagingTimeout(systemWide, 3)
  }
  return systemWide
}

const apps = new Map<number, Ptr>()
function appOf(pid: number): Ptr {
  let app = apps.get(pid)
  if (app) return app
  app = AXUIElementCreateApplication(pid) as Ptr
  apps.set(pid, app)
  AXUIElementSetMessagingTimeout(app, 3)
  return app
}

const woken = new Set<number>()
/**
 * Chromium and Electron apps build their tree only for an assistive app that asks for it (and keep
 * it up after): asked once, only of the app whose controls are listed.
 */
function wake(pid: number): void {
  if (woken.has(pid)) return
  woken.add(pid)
  if (setBool(appOf(pid), 'AXManualAccessibility', true)) sleep(400)
}

const near = (a: [number, number] | undefined, b: number, c: number) => !!a && Math.abs(a[0] - b) <= 4 && Math.abs(a[1] - c) <= 4

const windows = new Map<number, Ptr>()
/** The AX element of a window of the screen (by its number, else its place and title), kept. */
function findWindow(w: Win): Ptr | null {
  const known = windows.get(w.id)
  if (known) {
    if (read(known, 'AXRole', str)) return known
    CFRelease(known)
    windows.delete(w.id)
  }
  const list = copy(appOf(w.pid), 'AXWindows')
  if (!list) return null
  try {
    const all = items(list)
    const at = (x: Ptr) =>
      near(
        read(x, 'AXPosition', (v) => pair(v, AX_POINT)),
        w.rect.x,
        w.rect.y
      )
    const sized = (x: Ptr) =>
      near(
        read(x, 'AXSize', (v) => pair(v, AX_SIZE)),
        w.rect.w,
        w.rect.h
      )
    const found =
      (AXGetWindow && all.find((x) => windowNumber(x) === w.id)) ||
      all.find((x) => at(x) && sized(x) && (!w.title || read(x, 'AXTitle', str) === w.title)) ||
      all.find((x) => at(x) && sized(x))
    if (!found) return null
    CFRetain(found)
    windows.set(w.id, found)
    return found
  } finally {
    CFRelease(list)
  }
}

function needWindow(w: Win): Ptr {
  const found = findWindow(w)
  if (!found) throw new Error(`Accessibility doesn't see "${w.title || 'that window'}": its app may not expose it.`)
  return found
}

/** The window server brings the window forward and makes it the key window (true: it took the request). */
function front(pid: number, window: number): boolean {
  if (!sky) return false
  try {
    const psn = Buffer.alloc(8) // ProcessSerialNumber
    if (sky.psnOf(pid, psn) !== 0 || sky.front(psn, window, 0x200) !== 0) return false // kCPSUserGenerated
    // The two event records that make it key, as the window server's own clients send them.
    const bytes = Buffer.alloc(0xf8)
    bytes[0x04] = 0xf8
    bytes[0x3a] = 0x10
    bytes.writeUInt32LE(window, 0x3c)
    bytes.fill(0xff, 0x20, 0x30)
    bytes[0x08] = 0x01
    sky.post(psn, bytes)
    bytes[0x08] = 0x02
    sky.post(psn, bytes)
    return true
  } catch {
    return false
  }
}

/** Make an app frontmost (NSRunningApplication, then AX, which the app itself answers). */
function activate(pid: number): void {
  try {
    const cls = objc_getClass('NSRunningApplication') as MaybePtr
    const running = cls ? (msgWithPid(cls, sel_registerName('runningApplicationWithProcessIdentifier:'), pid) as MaybePtr) : null
    if (running) msgActivate(running, sel_registerName('activateWithOptions:'), ACTIVATE)
  } catch {
    // AX below
  }
  setBool(appOf(pid), 'AXFrontmost', true)
}

// ---------------------------------------------------------------- controls

/** The attributes read at once, per element (one round trip to the app). */
const ATTRS = [
  'AXRole',
  'AXSubrole',
  'AXTitle',
  'AXDescription',
  'AXValue',
  'AXPosition',
  'AXSize',
  'AXEnabled',
  'AXFocused',
  'AXIdentifier',
  'AXPlaceholderValue',
  'AXChildren'
]
const AT = Object.fromEntries(ATTRS.map((a, i) => [a, i])) as Record<(typeof ATTRS)[number], number>
let attrArray: MaybePtr = null
function attributes(): Ptr {
  if (attrArray) return attrArray
  const values = Buffer.alloc(ATTRS.length * 8)
  ATTRS.forEach((a, i) => values.writeBigUInt64LE(BigInt(cfs(a)), i * 8))
  attrArray = CFArrayCreate(null, values, ATTRS.length, kCFTypeArrayCallBacks) as Ptr
  return attrArray
}

/** An AX role as the kinds of controls the AI is told about (UI Automation's names, as on Windows). */
function kind(role: string, subrole: string): string | undefined {
  switch (role) {
    case 'AXButton':
    case 'AXMenuButton':
    case 'AXDisclosureTriangle':
    case 'AXColorWell':
      return 'button'
    case 'AXPopUpButton':
    case 'AXComboBox':
      return 'combobox'
    case 'AXCheckBox':
      return 'checkbox'
    case 'AXRadioButton':
      return subrole === 'AXTabButton' ? 'tabitem' : 'radiobutton'
    case 'AXTab':
      return 'tabitem'
    case 'AXTextField':
    case 'AXTextArea':
    case 'AXSearchField':
    case 'AXDateField':
    case 'AXTimeField':
      return 'edit'
    case 'AXLink':
      return 'hyperlink'
    case 'AXMenuItem':
    case 'AXMenuBarItem':
      return 'menuitem'
    case 'AXSlider':
      return 'slider'
    case 'AXIncrementor':
    case 'AXStepper':
      return 'spinner'
    case 'AXRow':
      return subrole === 'AXOutlineRow' ? 'treeitem' : 'listitem'
    case 'AXCell':
      return 'dataitem'
    case 'AXStaticText':
    case 'AXHeading':
      return 'text'
    case 'AXWebArea':
      return 'document'
    default:
      return undefined
  }
}

function valueText(v: MaybePtr, type: string): string | undefined {
  if (!v) return undefined
  const s = str(v)
  if (s !== undefined) return s
  const n = num(v)
  if (n === undefined) return undefined
  if (type === 'checkbox' || type === 'radiobutton' || type === 'tabitem') return n ? 'on' : 'off'
  return type === 'slider' || type === 'spinner' ? String(Math.round(n * 100) / 100) : undefined
}

interface Element {
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

interface Walk {
  out: Element[]
  kept: Ptr[]
  visited: number
  deadline: number
  max: number
  frame: Win['rect']
}

const crosses = (r: { x: number; y: number; w: number; h: number }, f: Win['rect']) => r.x < f.x + f.w && r.x + r.w > f.x && r.y < f.y + f.h && r.y + r.h > f.y

/** The controls of a window in the order of its tree, as UI Automation lists them: what's on screen only. */
function walk(element: Ptr, depth: number, s: Walk): void {
  if (s.out.length >= s.max || s.visited >= 8000 || depth > 64 || Date.now() > s.deadline) return
  s.visited++
  const out: MaybePtr[] = [null]
  if (AXUIElementCopyMultipleAttributeValues(element, attributes(), 0, out) !== 0 || !out[0]) return
  const values = out[0]
  try {
    const v = (name: string): MaybePtr => {
      const x = CFArrayGetValueAtIndex(values, AT[name]) as MaybePtr
      return x && !(typeOf(x) === TYPE.value && AXValueGetType(x) === AX_ERROR) ? x : null
    }
    const role = str(v('AXRole')) ?? ''
    const subrole = str(v('AXSubrole')) ?? ''
    const pos = pair(v('AXPosition'), AX_POINT)
    const size = pair(v('AXSize'), AX_SIZE)
    const rect = pos && size ? { x: pos[0], y: pos[1], w: size[0], h: size[1] } : null
    // Out of the window (scrolled away, a hidden part): neither it nor what's in it.
    if (rect && rect.w > 0 && rect.h > 0 && !crosses(rect, s.frame)) return
    const type = kind(role, subrole)
    let at = -1
    if (type && rect && rect.w >= 2 && rect.h >= 2) {
      const secure = subrole === 'AXSecureTextField'
      const value = secure ? undefined : valueText(v('AXValue'), type)
      const name = str(v('AXTitle')) || str(v('AXDescription')) || (type === 'text' ? value : '') || str(v('AXPlaceholderValue')) || ''
      if (type !== 'text' || name) {
        const e: Element = { type, name: name.slice(0, 120), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
        if (bool(v('AXEnabled')) === false) e.disabled = true
        if (secure) e.password = true
        if (bool(v('AXFocused'))) e.focused = true
        const aid = str(v('AXIdentifier'))
        if (aid) e.aid = aid
        if (value && type !== 'text') e.value = value.slice(0, 300)
        CFRetain(element)
        s.kept.push(element)
        s.out.push(e)
        at = s.out.length - 1
      }
    }
    for (const child of items(v('AXChildren'))) walk(child, depth + 1, s)
    // A row, a cell or a button without a name of its own: the first text in it.
    if (at >= 0 && !s.out[at].name) {
      const label = s.out.slice(at + 1).find((x) => x.type === 'text' && x.name)
      if (label) s.out[at].name = label.name
    }
  } finally {
    CFRelease(values)
  }
}

/** The controls listed last, per window, kept (retained) to act on by number. */
const snap = new Map<number, Ptr[]>()

/** Anywhere on the screen: menus open where they open, not in the window. */
const EVERYWHERE = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }

/**
 * The app's menu bar (at the top of the screen, outside its windows, unlike on Windows): its
 * menus' titles, and what's in a menu that's open. A closed menu's items aren't listed (there may
 * be hundreds): pressing its title opens it.
 */
function menuBar(pid: number, s: Walk): void {
  const bar = copy(appOf(pid), 'AXMenuBar')
  if (!bar) return
  try {
    const kids = copy(bar, 'AXChildren')
    if (!kids) return
    const frame = s.frame
    s.frame = EVERYWHERE
    try {
      items(kids).forEach((item, i) => {
        if (s.out.length >= s.max) return
        const title = read(item, 'AXTitle', str) ?? ''
        // The Apple menu first: the system's, not the app's.
        if (i === 0 && (!title || title === 'Apple')) return
        const pos = read(item, 'AXPosition', (v) => pair(v, AX_POINT))
        const size = read(item, 'AXSize', (v) => pair(v, AX_SIZE))
        if (!title || !pos || !size) return
        CFRetain(item)
        s.kept.push(item)
        s.out.push({
          type: 'menuitem',
          name: title.slice(0, 120),
          x: Math.round(pos[0]),
          y: Math.round(pos[1]),
          w: Math.round(size[0]),
          h: Math.round(size[1])
        })
        // Its menu, when it's open.
        if (!read(item, 'AXSelected', bool)) return
        const menus = copy(item, 'AXChildren')
        if (!menus) return
        try {
          for (const menu of items(menus)) walk(menu, 1, s)
        } finally {
          CFRelease(menus)
        }
      })
    } finally {
      s.frame = frame
      CFRelease(kids)
    }
  } finally {
    CFRelease(bar)
  }
}

/** A context menu the app has open: a child of the app, not of a window. */
function openMenus(pid: number, s: Walk): void {
  const kids = copy(appOf(pid), 'AXChildren')
  if (!kids) return
  const frame = s.frame
  s.frame = EVERYWHERE
  try {
    for (const child of items(kids)) if (read(child, 'AXRole', str) === 'AXMenu') walk(child, 1, s)
  } finally {
    s.frame = frame
    CFRelease(kids)
  }
}

function elements(req: Request): Record<string, unknown> {
  const w = req.win as Win
  wake(w.pid)
  const win = needWindow(w)
  const s: Walk = { out: [], kept: [], visited: 0, deadline: Date.now() + 6000, max: Number(req.max) || 250, frame: w.rect }
  openMenus(w.pid, s)
  walk(win, 0, s)
  menuBar(w.pid, s)
  for (const old of snap.get(w.id) ?? []) CFRelease(old)
  snap.set(w.id, s.kept)
  return { elements: s.out }
}

function get(req: Request): Ptr {
  const list = snap.get(Number((req.win as Win | undefined)?.id ?? req.hwnd))
  const index = Number(req.index)
  if (!list || index < 1 || index > list.length) throw new Error(`No element e${index} for this window: list its elements again.`)
  return list[index - 1]
}

/** The app didn't answer in time: busy, as when the press opened a dialog that waits for the user. It was pressed. */
const CANNOT_COMPLETE = -25204

function press(req: Request): Record<string, unknown> {
  const el = get(req)
  const names = actions(el)
  const role = read(el, 'AXRole', str) ?? ''
  const pressed = names.includes('AXPress') ? AXUIElementPerformAction(el, cfs('AXPress')) : null
  if (pressed === 0 || pressed === CANNOT_COMPLETE) {
    const done = role === 'AXCheckBox' ? 'toggle' : ['AXPopUpButton', 'AXComboBox', 'AXMenuButton', 'AXDisclosureTriangle'].includes(role) ? 'expand' : 'invoke'
    return { done }
  }
  if (settable(el, 'AXSelected') && setBool(el, 'AXSelected', true)) return { done: 'select' }
  if (names.includes('AXShowMenu') && perform(el, 'AXShowMenu')) return { done: 'expand' }
  if (names.includes('AXConfirm') && perform(el, 'AXConfirm')) return { done: 'invoke' }
  if (names.includes('AXPick') && perform(el, 'AXPick')) return { done: 'select' }
  return { done: null }
}

function fill(req: Request): Record<string, unknown> {
  const el = get(req)
  if (!settable(el, 'AXValue')) return { done: null }
  const text = CFStringCreateWithCString(null, String(req.text ?? ''), UTF8) as MaybePtr
  if (!text) return { done: null }
  try {
    return { done: AXUIElementSetAttributeValue(el, cfs('AXValue'), text) === 0 ? 'value' : null }
  } finally {
    CFRelease(text)
  }
}

/** The first scroll area of a window, depth first (retained: the caller releases it). */
function firstScrollArea(root: Ptr, budget = { left: 600 }): MaybePtr {
  if (budget.left-- <= 0) return null
  if (read(root, 'AXRole', str) === 'AXScrollArea') return CFRetain(root) as Ptr
  const kids = copy(root, 'AXChildren')
  if (!kids) return null
  try {
    for (const child of items(kids)) {
      const found = firstScrollArea(child, budget)
      if (found) return found
    }
    return null
  } finally {
    CFRelease(kids)
  }
}

/** Scroll a scroll area by notches (about 3 lines each): its bar's value moved, else the bar's own arrows. */
function scrollArea(area: Ptr, dy: number): boolean {
  const bar = copy(area, 'AXVerticalScrollBar')
  if (!bar) return false
  try {
    if (settable(bar, 'AXValue')) {
      const now = read(bar, 'AXValue', num) ?? 0
      const visible = read(area, 'AXSize', (v) => pair(v, AX_SIZE))?.[1] ?? 0
      const contents = copy(area, 'AXContents')
      let total = 0
      if (contents) {
        try {
          const first = items(contents)[0]
          total = first ? (read(first, 'AXSize', (v) => pair(v, AX_SIZE))?.[1] ?? 0) : 0
        } finally {
          CFRelease(contents)
        }
      }
      const span = total - visible
      const next = Math.min(1, Math.max(0, now + (span > 0 ? (dy * 48) / span : dy * 0.05)))
      const b = Buffer.alloc(8)
      b.writeDoubleLE(next)
      const n = CFNumberCreate(null, DOUBLE, b) as MaybePtr
      if (n) {
        try {
          if (AXUIElementSetAttributeValue(bar, cfs('AXValue'), n) === 0) return true
        } finally {
          CFRelease(n)
        }
      }
    }
    const action = dy > 0 ? 'AXIncrement' : 'AXDecrement'
    if (!actions(bar).includes(action)) return false
    for (let i = 0; i < Math.abs(dy) * 3; i++) perform(bar, action)
    return true
  } finally {
    CFRelease(bar)
  }
}

function scroll(req: Request): Record<string, unknown> {
  const dy = Number(req.dy) || 0
  // From the element (or the window's first scroll area) up to what scrolls.
  let cur: MaybePtr = req.index ? (CFRetain(get(req)) as Ptr) : firstScrollArea(needWindow(req.win as Win))
  try {
    for (let i = 0; cur && i < 40; i++) {
      if (read(cur, 'AXRole', str) === 'AXScrollArea' && scrollArea(cur, dy)) return { done: 'scroll' }
      const parent = copy(cur, 'AXParent')
      CFRelease(cur)
      cur = parent
    }
    return { done: null }
  } finally {
    if (cur) CFRelease(cur)
  }
}

function focus(req: Request): Record<string, unknown> {
  if (!setBool(get(req), 'AXFocused', true)) throw new Error('That element takes no keyboard focus.')
  return { done: 'focus' }
}

const isSecure = (el: Ptr) => read(el, 'AXSubrole', str) === 'AXSecureTextField' || read(el, 'AXRole', str) === 'AXSecureTextField'

function focused(): Record<string, unknown> {
  const el = copy(system(), 'AXFocusedUIElement')
  if (!el) return { focused: null }
  try {
    const role = read(el, 'AXRole', str) ?? ''
    const name = read(el, 'AXTitle', str) || read(el, 'AXDescription', str) || ''
    return { focused: { type: kind(role, read(el, 'AXSubrole', str) ?? ''), name, password: isSecure(el), pid: pidOf(el) } }
  } finally {
    CFRelease(el)
  }
}

/** The text just before the cursor, in the field with the keyboard (to check what was typed). Never a password's. */
function before(req: Request): Record<string, unknown> {
  const n = Math.max(1, Number(req.n) || 200)
  const el = copy(system(), 'AXFocusedUIElement')
  if (!el) return { before: null }
  try {
    const o: { pid: number; text?: string; value?: string; password?: boolean } = { pid: pidOf(el) }
    if (isSecure(el)) {
      o.password = true
      return { before: o }
    }
    // The cursor is where the selection starts (an app may select what it suggests after it).
    const range = read(el, 'AXSelectedTextRange', (v) => pair(v, AX_RANGE))
    if (range) {
      const start = Math.max(0, range[0] - n)
      const b = Buffer.alloc(16)
      b.writeBigInt64LE(BigInt(start), 0)
      b.writeBigInt64LE(BigInt(range[0] - start), 8)
      const param = AXValueCreate(AX_RANGE, b) as MaybePtr
      if (param) {
        try {
          const out: MaybePtr[] = [null]
          if (AXUIElementCopyParameterizedAttributeValue(el, cfs('AXStringForRange'), param, out) === 0 && out[0]) {
            try {
              const text = str(out[0])
              if (text !== undefined) {
                o.text = text
                return { before: o }
              }
            } finally {
              CFRelease(out[0])
            }
          }
        } finally {
          CFRelease(param)
        }
      }
    }
    const value = read(el, 'AXValue', str)
    if (value !== undefined) o.value = value.slice(-4000)
    return { before: o }
  } finally {
    CFRelease(el)
  }
}

/** Bring a window to the front with the keyboard: shown again if minimized, its app frontmost, it raised and main. */
function raise(req: Request): Record<string, unknown> {
  const w = req.win as Win
  const win = findWindow(w)
  if (win && read(win, 'AXMinimized', bool)) setBool(win, 'AXMinimized', false)
  const fronted = front(w.pid, w.id)
  if (win) {
    perform(win, 'AXRaise')
    setBool(win, 'AXMain', true)
  }
  if (!fronted) activate(w.pid)
  return { done: 'raise' }
}

function unminimize(req: Request): Record<string, unknown> {
  const win = needWindow(req.win as Win)
  return { done: setBool(win, 'AXMinimized', false) ? 'unminimize' : null }
}

/** The window numbers of the minimized windows of these apps. */
function minimized(req: Request): Record<string, unknown> {
  const ids: number[] = []
  for (const pid of (req.pids as number[]) ?? []) {
    const list = copy(appOf(Number(pid)), 'AXWindows')
    if (!list) continue
    try {
      for (const w of items(list)) {
        if (!read(w, 'AXMinimized', bool)) continue
        const id = windowNumber(w)
        if (id) ids.push(id)
      }
    } finally {
      CFRelease(list)
    }
  }
  return { ids }
}

serve((req) => {
  const pool = poolPush()
  try {
    if (!AXIsProcessTrusted()) throw new Error("Speak isn't allowed to use Accessibility: turn it on in System Settings → Privacy & Security → Accessibility.")
    switch (req.op) {
      case 'elements':
        return elements(req)
      case 'press':
        return press(req)
      case 'fill':
        return fill(req)
      case 'scroll':
        return scroll(req)
      case 'focus':
        return focus(req)
      case 'focused':
        return focused()
      case 'before':
        return before(req)
      case 'raise':
        return raise(req)
      case 'unminimize':
        return unminimize(req)
      case 'minimized':
        return minimized(req)
      default:
        return { error: `unknown op ${req.op}` }
    }
  } finally {
    poolPop(pool)
  }
})
