import type { Rect, ScreenBackend } from './types'

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const bt = Math.min(a.y + a.h, b.y + b.h)
  return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : null
}

export const inRect = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h

/** A backend that can't act: every call says why. */
export function unavailable(reason: string): ScreenBackend {
  const fail = (): never => {
    throw new Error(reason)
  }
  return {
    unsupported: () => reason,
    mod: 'ctrl',
    a11y: {
      elements: async () => fail(),
      press: async () => fail(),
      fill: async () => fail(),
      scroll: async () => fail(),
      focus: async () => false,
      focused: async () => null,
      beforeCursor: async () => null,
      warm: () => undefined,
      stop: () => undefined
    },
    refresh: async () => undefined,
    listWindows: fail,
    windowInfo: fail,
    foregroundWindow: fail,
    windowAt: fail,
    focusWindow: async () => fail(),
    unminimize: async () => fail(),
    hasKeyboard: () => false,
    held: () => ({ modifiers: false, buttons: false }),
    cursorPos: fail,
    movePointer: fail,
    button: fail,
    wheel: fail,
    pressKeys: fail,
    typeChar: fail,
    stackAbove: () => undefined,
    captureWindow: async () => null,
    captureArea: async () => null
  }
}
