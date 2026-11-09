import { desktopCapturer, type NativeImage } from 'electron'
import { isMac } from '../../util'
import type { Rect, WindowInfo } from './types'

/** Widest picture the AI gets: wider ones are scaled down. */
export const MAX_SHOT = 1366

/**
 * Whether a BGRA picture is empty: all black or transparent, as an app that didn't draw for a
 * background picture leaves it (or the system, without the permission to record the screen).
 */
export function blank(pixels: Buffer): boolean {
  let lit = 0
  for (let i = 0; i < pixels.length && lit < 4; i += 4096) {
    if (pixels[i + 3] > 0 && (pixels[i] > 16 || pixels[i + 1] > 16 || pixels[i + 2] > 16)) lit++
  }
  return lit < 4
}

/**
 * A window's picture through Chromium's own window capture (macOS, X11), even behind others,
 * without bringing it forward: what Electron offers for picking a window to share. Every window is
 * captured at once, at most at the size asked, so the size is the window's, capped.
 */
export async function windowSource(w: WindowInfo): Promise<{ image: NativeImage; area: Rect } | null> {
  if (w.rect.w <= 0 || w.rect.h <= 0) return null
  // Asked in pixels: a Mac's windows are in points, two pixels each on a Retina display.
  const width = Math.min(Math.round(w.rect.w * (isMac ? 2 : 1)), 2 * MAX_SHOT)
  const thumbnailSize = { width, height: Math.round((width * w.rect.h) / w.rect.w) }
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize, fetchWindowIcons: false })
  const source = sources.find((s) => s.id.startsWith(`window:${w.id}:`))
  if (!source || source.thumbnail.isEmpty()) return null
  if (blank(source.thumbnail.toBitmap())) return null
  return { image: source.thumbnail, area: w.rect }
}
