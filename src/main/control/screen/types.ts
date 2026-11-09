import type { NativeImage } from 'electron'

/**
 * The screen as control mode sees it, on every system. Coordinates are the system's own screen
 * space, the one its windows, its input and its accessibility API share: physical pixels on
 * Windows (Speak is per-monitor DPI aware) and X11, points on macOS (Electron's DIPs there).
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface WindowInfo {
  /** The system's window id: an HWND on Windows, a CGWindowID on macOS, an X11 window on Linux. */
  id: number
  title: string
  pid: number
  /** The program: "OUTLOOK.EXE", "Mail", "firefox". */
  exe: string
  rect: Rect
  minimized: boolean
  focused: boolean
}

/** A control of a window, as the accessibility API lists it (UI Automation, AX, AT-SPI). */
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

export interface Shot {
  image: NativeImage
  /** The area shot, in screen coordinates. */
  area: Rect
  /** Screen units per image pixel. */
  scale: number
}

/** The control with the keyboard focus, and the app it's in. */
export type Focused = { type?: string; name: string; password: boolean; pid?: number } | null

/** The field with the keyboard: the `text` before its cursor, else its whole `value` (neither for a password). */
export type BeforeCursor = { pid: number; text?: string; value?: string; password?: boolean } | null

export type Button = 'left' | 'right' | 'middle'

/**
 * A window's controls, read and acted on in the background, through the system's accessibility
 * API (each in a process of its own, kept for the session: a slow or hung app never blocks Speak).
 */
export interface Accessibility {
  /** Lists a window's controls, and keeps them, numbered, to act on them. */
  elements(w: WindowInfo, max: number): Promise<Element[]>
  /** Press an element in the background (its default action). Null: it has none, a real click is needed. */
  press(w: WindowInfo, index: number): Promise<string | null>
  /** Set a field's whole value in the background. Null: it can't be set that way. */
  fill(w: WindowInfo, index: number, text: string): Promise<string | null>
  /** Scroll an element's list or page (or the window's first) in the background. Null: nothing scrolls that way. */
  scroll(w: WindowInfo, index: number | undefined, dy: number): Promise<string | null>
  /** Give an element the keyboard focus (its window is in front). */
  focus(w: WindowInfo, index: number): Promise<boolean>
  /** The control with the keyboard focus (to notice a password field). */
  focused(): Promise<Focused>
  /** Up to `n` characters before the cursor, in the field with the keyboard (to check what was typed). */
  beforeCursor(n: number): Promise<BeforeCursor>
  /** Start it ahead (it takes a moment). */
  warm(): void
  stop(): void
}

/**
 * What each system provides, in its screen coordinates. The shared parts (sharing the mouse and
 * the keyboard with the user, typing and pasting, screenshots) are built on these, in index.ts.
 */
export interface ScreenBackend {
  /** Why control can't run on this computer, or null. */
  unsupported(): string | null
  /** The windows on screen (and minimized), front to back: titled, not tool windows nor other desktops'. */
  listWindows(): WindowInfo[]
  /** A window by id (null: gone, or not a window it lists). */
  windowInfo(id: number): WindowInfo | null
  /** The window with the keyboard. */
  foregroundWindow(): WindowInfo | null
  /** The top window under a point. Speak's own windows that let clicks through aren't hit. */
  windowAt(x: number, y: number): WindowInfo | null
  /** Bring a window to the front, with the keyboard. True once it's there. */
  focusWindow(id: number): Promise<boolean>
  /** A minimized window shown again, without taking the focus when the system allows. */
  unminimize(id: number): Promise<void>
  /** Whether the keyboard still goes to that window (or a dialog or menu it owns). */
  hasKeyboard(id: number): boolean
  /** What the user holds down right now, asked of the system directly (ahead of the input hook). */
  held(): { modifiers: boolean; buttons: boolean }
  cursorPos(): Point
  /** The pointer put there (`dragging`: the left button is down). The input hook sees it at the anchor. */
  movePointer(x: number, y: number, dragging?: boolean): void
  /** A mouse button down or up, at the pointer (put there first). `clicks`: which click of a double click. */
  button(button: Button, down: boolean, at: Point, clicks?: number): void
  /** Wheel notches at the pointer: dy > 0 scrolls down, dx > 0 right. */
  wheel(at: Point, dy: number, dx: number): void
  /** Press a key or a shortcut ("ctrl+s", "enter"); throws on a key it doesn't know. */
  pressKeys(combo: string): void
  /** Type one character (a code point) as text: never a key's meaning or a shortcut. */
  typeChar(ch: string): void
  /** Keep one of Speak's windows (`frame`, its native handle) just above `target` in the stacking order. */
  stackAbove(frame: number, target: number): void
  /** A window's picture as it draws itself, without bringing it forward. Null: it doesn't draw that way here. */
  captureWindow(w: WindowInfo): Promise<{ image: NativeImage; area: Rect } | null>
  /** An area of the screen as it is in front, without Speak's windows. Null: use the generic screenshot. */
  captureArea(area: Rect): Promise<NativeImage | null>
  /** What a backend adds before the AI lists windows (macOS: which ones are minimized). */
  refresh(): Promise<void>
  readonly a11y: Accessibility
  /** The shortcut modifier: paste and select all are mod+v and mod+a. */
  readonly mod: 'ctrl' | 'cmd'
}
