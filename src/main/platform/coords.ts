import { screen } from 'electron'
import { isLinux, isWin } from '../util'

/**
 * Electron places windows in DIPs; the system's screen space (its windows, its input, the input
 * hook) is physical pixels on Windows (Speak is per-monitor DPI aware) and X11, and points on
 * macOS, which are DIPs already. These convert between the two.
 */

type R = { x: number; y: number; width: number; height: number }

/** A DIP rect (Electron's) in the system's screen space. */
export function dipToScreen(r: R): R {
  if (isWin) return screen.dipToScreenRect(null, r)
  if (isLinux) {
    // The rect version is Windows only: its corners, each scaled by its display.
    const a = screen.dipToScreenPoint({ x: r.x, y: r.y })
    const b = screen.dipToScreenPoint({ x: r.x + r.width, y: r.y + r.height })
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }
  }
  return { ...r }
}

/** A rect of the system's screen space in DIPs (to place one of Speak's windows there). */
export function screenToDip(r: R): R {
  if (isWin) return screen.screenToDipRect(null, r)
  if (isLinux) {
    const a = screen.screenToDipPoint({ x: r.x, y: r.y })
    const b = screen.screenToDipPoint({ x: r.x + r.width, y: r.y + r.height })
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }
  }
  return { ...r }
}
