import { serve, type Request } from './serve'

/**
 * Speak's bridge to AT-SPI, Linux's accessibility API, in a process of its own (Electron run as
 * Node, see bridge.ts), as UI Automation's is on Windows. It lists a window's controls (buttons,
 * fields, links, menu items, text) with their places, keeps them numbered, and acts on them in the
 * background: press, set a text, scroll, focus. libatspi is there wherever Electron runs on Linux
 * (Chromium's own accessibility uses it). Apps expose their controls when the desktop's
 * accessibility is on (GTK and Qt apps always, Chromium and Electron apps when it is).
 */

const koffi = require('koffi') as typeof import('koffi')

type Ptr = bigint
type MaybePtr = Ptr | null

const at = koffi.load('libatspi.so.0')
const glib = koffi.load('libglib-2.0.so.0')
const gobject = koffi.load('libgobject-2.0.so.0')
const gio = koffi.load('libgio-2.0.so.0')
const optional = (lib: ReturnType<typeof koffi.load>, def: string) => {
  try {
    return lib.func(def)
  } catch {
    return undefined
  }
}

// Every GError ** is passed NULL (errors ignored: the call returns its failure value), and every
// gboolean is an int.
const atspi_init = at.func('int atspi_init()')
const atspi_get_desktop = at.func('void *atspi_get_desktop(int i)')
const childCount = at.func('int atspi_accessible_get_child_count(void *obj, void *error)')
const childAt = at.func('void *atspi_accessible_get_child_at_index(void *obj, int index, void *error)')
const getName = at.func('void *atspi_accessible_get_name(void *obj, void *error)')
const getRoleName = at.func('void *atspi_accessible_get_role_name(void *obj, void *error)')
const getPid = at.func('unsigned int atspi_accessible_get_process_id(void *obj, void *error)')
const getParent = at.func('void *atspi_accessible_get_parent(void *obj, void *error)')
const indexInParent = at.func('int atspi_accessible_get_index_in_parent(void *obj, void *error)')
const getStateSet = at.func('void *atspi_accessible_get_state_set(void *obj)')
const stateContains = at.func('int atspi_state_set_contains(void *set, int state)')
const getComponent = at.func('void *atspi_accessible_get_component_iface(void *obj)')
const getExtents = at.func('void *atspi_component_get_extents(void *component, int coordType, void *error)')
const grabFocus = at.func('int atspi_component_grab_focus(void *component, void *error)')
const getAction = at.func('void *atspi_accessible_get_action_iface(void *obj)')
const actionCount = at.func('int atspi_action_get_n_actions(void *action, void *error)')
const actionName = at.func('void *atspi_action_get_action_name(void *action, int i, void *error)')
const doAction = at.func('int atspi_action_do_action(void *action, int i, void *error)')
const getEditable = at.func('void *atspi_accessible_get_editable_text_iface(void *obj)')
const setText = at.func('int atspi_editable_text_set_text_contents(void *editable, const char *text, void *error)')
const getTextIface = at.func('void *atspi_accessible_get_text_iface(void *obj)')
const caretOffset = at.func('int atspi_text_get_caret_offset(void *text, void *error)')
const characterCount = at.func('int atspi_text_get_character_count(void *text, void *error)')
const getText = at.func('void *atspi_text_get_text(void *text, int start, int end, void *error)')
const getValueIface = at.func('void *atspi_accessible_get_value_iface(void *obj)')
const valueNow = at.func('double atspi_value_get_current_value(void *value, void *error)')
const valueSet = at.func('int atspi_value_set_current_value(void *value, double v, void *error)')
const valueStep = at.func('double atspi_value_get_minimum_increment(void *value, void *error)')
const getSelection = at.func('void *atspi_accessible_get_selection_iface(void *obj)')
const selectChild = at.func('int atspi_selection_select_child(void *selection, int index, void *error)')
const clearCache = optional(at, 'void atspi_accessible_clear_cache(void *obj)')
const getAccessibleId = optional(at, 'void *atspi_accessible_get_accessible_id(void *obj, void *error)')
const g_free = glib.func('void g_free(void *p)')
const g_main_context_iteration = glib.func('int g_main_context_iteration(void *context, int mayBlock)')
const g_object_ref = gobject.func('void *g_object_ref(void *object)')
const g_object_unref = gobject.func('void g_object_unref(void *object)')
const g_bus_get_sync = gio.func('void *g_bus_get_sync(int type, void *cancellable, void *error)')
const g_dbus_connection_call_sync = gio.func(
  'void *g_dbus_connection_call_sync(void *connection, const char *name, const char *path, const char *iface, const char *method, void *parameters, void *replyType, int flags, int timeout, void *cancellable, void *error)'
)
const g_variant_get_child_value = glib.func('void *g_variant_get_child_value(void *value, size_t index)')
const g_variant_get_string = glib.func('const char *g_variant_get_string(void *value, void *length)')
const g_variant_unref = glib.func('void g_variant_unref(void *value)')

/** AtspiStateType */
const STATE = { active: 1, checked: 4, editable: 7, enabled: 8, focused: 12, sensitive: 24, showing: 25, vertical: 29 }
const SCREEN = 0 // ATSPI_COORD_TYPE_SCREEN

/**
 * Where the accessibility bus is, found before libatspi looks: it ends the process when it can't
 * (no session bus, or the desktop's accessibility off). As libatspi does: its variable, else the
 * session bus's org.a11y.Bus. Null: found (and passed on to libatspi); else why not.
 */
function findBus(): string | null {
  if (process.env.AT_SPI_BUS_ADDRESS) return null
  const off =
    "The desktop's accessibility bus isn't running, so apps don't expose their controls: turn on accessibility in the desktop's settings (or start at-spi-bus-launcher)."
  const session = g_bus_get_sync(2, null, null) as MaybePtr // G_BUS_TYPE_SESSION
  if (!session) return off
  try {
    const reply = g_dbus_connection_call_sync(
      session,
      'org.a11y.Bus',
      '/org/a11y/bus',
      'org.a11y.Bus',
      'GetAddress',
      null,
      null,
      0,
      2000,
      null,
      null
    ) as MaybePtr
    if (!reply) return off
    try {
      const child = g_variant_get_child_value(reply, 0) as MaybePtr
      if (!child) return off
      try {
        const address = String(g_variant_get_string(child, null) ?? '')
        if (!address) return off
        process.env.AT_SPI_BUS_ADDRESS = address
        return null
      } finally {
        g_variant_unref(child)
      }
    } finally {
      g_variant_unref(reply)
    }
  } finally {
    g_object_unref(session)
  }
}

const busError = findBus()
if (!busError) atspi_init()

// ---------------------------------------------------------------- GLib values

/** A string AT-SPI gave (and freed). */
function text(p: MaybePtr): string {
  if (!p) return ''
  try {
    return String(koffi.decode.string(p) ?? '')
  } finally {
    g_free(p)
  }
}

/** An interface of an object, released after use (null: the object hasn't it). */
function withIface<T>(obj: Ptr, get: (o: Ptr) => MaybePtr, fn: (iface: Ptr) => T): T | undefined {
  const iface = get(obj)
  if (!iface) return undefined
  try {
    return fn(iface)
  } finally {
    g_object_unref(iface)
  }
}

const nameOf = (obj: Ptr) => text(getName(obj, null))
const roleOf = (obj: Ptr) => text(getRoleName(obj, null))

function states(obj: Ptr): (state: number) => boolean {
  const set = getStateSet(obj) as MaybePtr
  if (!set) return () => false
  const known = new Map<number, boolean>()
  try {
    for (const s of Object.values(STATE)) known.set(s, !!stateContains(set, s))
  } finally {
    g_object_unref(set)
  }
  return (state) => known.get(state) ?? false
}

function extents(obj: Ptr): { x: number; y: number; w: number; h: number } | null {
  return (
    withIface(obj, getComponent, (c) => {
      const r = getExtents(c, SCREEN, null) as MaybePtr
      if (!r) return null
      try {
        const [x, y, w, h] = koffi.decode(r, 'int', 4) as number[]
        return { x, y, w, h }
      } finally {
        g_free(r)
      }
    }) ?? null
  )
}

/** Up to `max` characters of an object's text (its content: a label's, a field's). */
function textOf(obj: Ptr, max: number): string | undefined {
  return withIface(obj, getTextIface, (t) => {
    const n = Number(characterCount(t, null))
    return n > 0 ? text(getText(t, 0, Math.min(n, max), null)) : ''
  })
}

function children(obj: Ptr, max = 2000): number {
  return Math.min(Math.max(0, Number(childCount(obj, null))), max)
}

/** Each child, released after `fn` (return true to stop). */
function eachChild(obj: Ptr, fn: (child: Ptr, i: number) => boolean | void): void {
  const n = children(obj)
  for (let i = 0; i < n; i++) {
    const child = childAt(obj, i, null) as MaybePtr
    if (!child) continue
    let stop: boolean | void
    try {
      stop = fn(child, i)
    } finally {
      g_object_unref(child)
    }
    if (stop) return
  }
}

/** The events AT-SPI queued (its cache follows the apps through them). */
function drain(): void {
  for (let i = 0; i < 200 && g_main_context_iteration(null, 0); i++);
}

// ---------------------------------------------------------------- windows

interface Win {
  id: number
  pid: number
  title: string
  rect: { x: number; y: number; w: number; h: number }
}

const FRAMES = new Set(['frame', 'window', 'dialog', 'alert', 'file chooser', 'color chooser', 'font chooser'])
const near = (a: Win['rect'] | null, b: Win['rect']) =>
  !!a && Math.abs(a.x - b.x) <= 60 && Math.abs(a.y - b.y) <= 60 && Math.abs(a.w - b.w) <= 80 && Math.abs(a.h - b.h) <= 80

const frames = new Map<number, Ptr>()
/** A window of the screen as AT-SPI knows it: its app by process, then the frame by title, place, or being active. */
function findFrame(w: Win): MaybePtr {
  const known = frames.get(w.id)
  if (known) {
    if (roleOf(known)) return known
    g_object_unref(known)
    frames.delete(w.id)
  }
  const desktop = atspi_get_desktop(0) as MaybePtr
  if (!desktop) return null
  let found: MaybePtr = null
  try {
    eachChild(desktop, (app) => {
      if (Number(getPid(app, null)) !== w.pid) return
      const candidates: Array<{ obj: Ptr; score: number }> = []
      eachChild(app, (frame) => {
        if (!FRAMES.has(roleOf(frame))) return
        const title = nameOf(frame)
        const score = (title && title === w.title ? 4 : 0) + (near(extents(frame), w.rect) ? 2 : 0) + (states(frame)(STATE.active) ? 1 : 0)
        candidates.push({ obj: g_object_ref(frame) as Ptr, score })
      })
      candidates.sort((a, b) => b.score - a.score)
      if (candidates.length) found = candidates[0].obj
      for (const c of candidates.slice(found ? 1 : 0)) g_object_unref(c.obj)
      return !!found
    })
  } finally {
    g_object_unref(desktop)
  }
  if (found) frames.set(w.id, found)
  return found
}

function needFrame(w: Win): Ptr {
  const frame = findFrame(w)
  if (!frame) throw new Error(`AT-SPI doesn't see "${w.title || 'that window'}": its app may not expose its controls (turn on the desktop's accessibility).`)
  // What it knew of it may be old: read again.
  clearCache?.(frame)
  return frame
}

// ---------------------------------------------------------------- controls

/** AT-SPI's role names as the kinds of controls the AI is told about (UI Automation's names, as on Windows). */
function kind(role: string, has: (s: number) => boolean): string | undefined {
  switch (role) {
    case 'push button':
    case 'toggle button':
    case 'push button menu':
    case 'button':
      return 'button'
    case 'check box':
    case 'switch':
      return 'checkbox'
    case 'radio button':
      return 'radiobutton'
    case 'combo box':
      return 'combobox'
    case 'entry':
    case 'password text':
      return 'edit'
    case 'text':
      return has(STATE.editable) ? 'edit' : 'text'
    case 'link':
      return 'hyperlink'
    case 'menu item':
    case 'check menu item':
    case 'radio menu item':
      return 'menuitem'
    case 'page tab':
      return 'tabitem'
    case 'list item':
      return 'listitem'
    case 'tree item':
      return 'treeitem'
    case 'table cell':
      return 'dataitem'
    case 'slider':
      return 'slider'
    case 'spin button':
      return 'spinner'
    case 'label':
    case 'static':
    case 'heading':
    case 'paragraph':
    case 'caption':
      return 'text'
    case 'document web':
    case 'document frame':
    case 'document text':
      return 'document'
    case 'column header':
    case 'table column header':
    case 'row header':
      return 'headeritem'
    default:
      return undefined
  }
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
  /** Screen pixels per unit of the app's places (1, or GTK's scale on a scaled X11 desktop). */
  scale: number
}

const crosses = (r: Win['rect'], f: Win['rect']) => r.x < f.x + f.w && r.x + r.w > f.x && r.y < f.y + f.h && r.y + r.h > f.y

/** The controls of a window in the order of its tree, as UI Automation lists them: what's on screen only. */
function walk(obj: Ptr, depth: number, s: Walk): void {
  if (s.out.length >= s.max || s.visited >= 6000 || depth > 64 || Date.now() > s.deadline) return
  s.visited++
  const has = states(obj)
  // Not on screen: neither it nor what's in it.
  if (depth > 0 && !has(STATE.showing)) return
  const found = extents(obj)
  const rect = found && s.scale !== 1 ? { x: found.x * s.scale, y: found.y * s.scale, w: found.w * s.scale, h: found.h * s.scale } : found
  if (rect && rect.w > 0 && rect.h > 0 && !crosses(rect, s.frame)) return
  const role = roleOf(obj)
  const type = kind(role, has)
  let at = -1
  if (type && rect && rect.w >= 2 && rect.h >= 2) {
    const password = role === 'password text'
    let name = nameOf(obj)
    let value: string | undefined
    if (type === 'edit' && !password) value = textOf(obj, 300)
    else if (type === 'slider' || type === 'spinner') value = withIface(obj, getValueIface, (v) => String(Math.round(Number(valueNow(v, null)) * 100) / 100))
    else if (type === 'checkbox' || type === 'radiobutton') value = has(STATE.checked) ? 'on' : 'off'
    if (type === 'text' && !name) name = textOf(obj, 120) ?? ''
    if (type !== 'text' || name.trim()) {
      const e: Element = { type, name: name.slice(0, 120), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
      if (!has(STATE.enabled) && !has(STATE.sensitive)) e.disabled = true
      if (password) e.password = true
      if (has(STATE.focused)) e.focused = true
      const aid = getAccessibleId ? text(getAccessibleId(obj, null)) : ''
      if (aid) e.aid = aid
      if (value) e.value = value.slice(0, 300)
      s.kept.push(g_object_ref(obj) as Ptr)
      s.out.push(e)
      at = s.out.length - 1
    }
  }
  eachChild(obj, (child) => {
    walk(child, depth + 1, s)
    return s.out.length >= s.max || Date.now() > s.deadline
  })
  // A row, a cell or a button without a name of its own: the first text in it.
  if (at >= 0 && !s.out[at].name) {
    const label = s.out.slice(at + 1).find((x) => x.type === 'text' && x.name)
    if (label) s.out[at].name = label.name
  }
}

/** The controls listed last, per window, kept (referenced) to act on by number. */
const snap = new Map<number, Ptr[]>()

function elements(req: Request): Record<string, unknown> {
  const w = req.win as Win
  const frame = needFrame(w)
  // GTK on a scaled X11 desktop gives places in its own units, not the screen's pixels: the frame's
  // size against the window's says by how much.
  const own = extents(frame)
  const ratio = own && own.w > 0 ? w.rect.w / own.w : 1
  const scale = Math.abs(ratio - 1) > 0.2 ? Math.round(ratio * 4) / 4 : 1
  const s: Walk = { out: [], kept: [], visited: 0, deadline: Date.now() + 6000, max: Number(req.max) || 250, frame: w.rect, scale }
  walk(frame, 0, s)
  for (const old of snap.get(w.id) ?? []) g_object_unref(old)
  snap.set(w.id, s.kept)
  return { elements: s.out }
}

function get(req: Request): Ptr {
  const list = snap.get(Number((req.win as Win | undefined)?.id ?? req.hwnd))
  const index = Number(req.index)
  if (!list || index < 1 || index > list.length) throw new Error(`No element e${index} for this window: list its elements again.`)
  return list[index - 1]
}

/** The actions toolkits name for a press, in the order they're tried. */
const PRESS = ['click', 'press', 'activate', 'toggle', 'jump', 'open', 'expand or contract', 'select', 'invoke']

function press(req: Request): Record<string, unknown> {
  const el = get(req)
  const role = roleOf(el)
  const pressed = withIface(el, getAction, (a) => {
    const names = Array.from({ length: Math.max(0, Number(actionCount(a, null))) }, (_, i) => text(actionName(a, i, null)).toLowerCase())
    const i = PRESS.map((p) => names.indexOf(p)).find((i) => i >= 0) ?? (names.length ? 0 : -1)
    if (i < 0 || !doAction(a, i, null)) return null
    return names[i]
  })
  if (pressed) {
    if (role === 'check box' || role === 'toggle button' || role === 'switch' || pressed === 'toggle') return { done: 'toggle' }
    if (role === 'combo box' || pressed === 'expand or contract') return { done: 'expand' }
    return { done: pressed === 'select' ? 'select' : 'invoke' }
  }
  // An item of a list or a tree: selected through its parent.
  const parent = getParent(el, null) as MaybePtr
  if (!parent) return { done: null }
  try {
    const index = Number(indexInParent(el, null))
    const ok = index >= 0 && withIface(parent, getSelection, (sel) => !!selectChild(sel, index, null))
    return { done: ok ? 'select' : null }
  } finally {
    g_object_unref(parent)
  }
}

function fill(req: Request): Record<string, unknown> {
  const done = withIface(get(req), getEditable, (e) => !!setText(e, String(req.text ?? ''), null))
  return { done: done ? 'value' : null }
}

/** The first scroll pane in a window, depth first (referenced: the caller releases it). */
function firstScrollPane(root: Ptr, budget = { left: 800 }): MaybePtr {
  if (budget.left-- <= 0) return null
  if (roleOf(root) === 'scroll pane') return g_object_ref(root) as Ptr
  let found: MaybePtr = null
  eachChild(root, (child) => {
    found = firstScrollPane(child, budget)
    return !!found
  })
  return found
}

/** Scroll a scroll pane by notches (about 3 lines each), through its vertical bar's value. */
function scrollPane(pane: Ptr, dy: number): boolean {
  let done = false
  eachChild(pane, (child) => {
    if (roleOf(child) !== 'scroll bar' || !states(child)(STATE.vertical)) return
    done = !!withIface(child, getValueIface, (v) => {
      const step = Number(valueStep(v, null)) || 0
      return !!valueSet(v, Number(valueNow(v, null)) + dy * 3 * (step > 0 ? step : 17), null)
    })
    return true
  })
  return done
}

function scroll(req: Request): Record<string, unknown> {
  const dy = Number(req.dy) || 0
  let cur: MaybePtr = req.index ? (g_object_ref(get(req)) as Ptr) : firstScrollPane(needFrame(req.win as Win))
  try {
    for (let i = 0; cur && i < 40; i++) {
      if (roleOf(cur) === 'scroll pane' && scrollPane(cur, dy)) return { done: 'scroll' }
      const parent = getParent(cur, null) as MaybePtr
      g_object_unref(cur)
      cur = parent
    }
    return { done: null }
  } finally {
    if (cur) g_object_unref(cur)
  }
}

function focus(req: Request): Record<string, unknown> {
  if (!withIface(get(req), getComponent, (c) => !!grabFocus(c, null))) throw new Error('That element takes no keyboard focus.')
  return { done: 'focus' }
}

/** The control with the keyboard in the window in front (AT-SPI has no system-wide focus to ask). */
function findFocused(front: Win | undefined): MaybePtr {
  if (!front) return null
  const frame = findFrame(front)
  if (!frame) return null
  clearCache?.(frame)
  const deadline = Date.now() + 1500
  let left = 4000
  const search = (obj: Ptr, depth: number): MaybePtr => {
    if (left-- <= 0 || depth > 64 || Date.now() > deadline) return null
    const has = states(obj)
    if (depth > 0 && !has(STATE.showing)) return null
    if (depth > 0 && has(STATE.focused)) return g_object_ref(obj) as Ptr
    let found: MaybePtr = null
    eachChild(obj, (child) => {
      found = search(child, depth + 1)
      return !!found
    })
    return found
  }
  return search(frame, 0)
}

function focused(req: Request): Record<string, unknown> {
  const front = req.front as Win | undefined
  const el = findFocused(front)
  if (!el) return { focused: null }
  try {
    const role = roleOf(el)
    return { focused: { type: kind(role, states(el)), name: nameOf(el), password: role === 'password text', pid: front?.pid } }
  } finally {
    g_object_unref(el)
  }
}

/** The text just before the cursor, in the field with the keyboard (to check what was typed). Never a password's. */
function before(req: Request): Record<string, unknown> {
  const front = req.front as Win | undefined
  const n = Math.max(1, Number(req.n) || 200)
  const el = findFocused(front)
  if (!el || !front) return { before: null }
  try {
    const o: { pid: number; text?: string; password?: boolean } = { pid: front.pid }
    if (roleOf(el) === 'password text') {
      o.password = true
      return { before: o }
    }
    const t = withIface(el, getTextIface, (t) => {
      const caret = Number(caretOffset(t, null))
      return caret >= 0 ? text(getText(t, Math.max(0, caret - n), caret, null)) : undefined
    })
    if (t !== undefined) o.text = t
    return { before: o }
  } finally {
    g_object_unref(el)
  }
}

serve((req) => {
  if (busError) throw new Error(busError)
  drain()
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
      return focused(req)
    case 'before':
      return before(req)
    default:
      return { error: `unknown op ${req.op}` }
  }
})
