/// <reference types="vite/client" />
/**
 * Easter egg themes, one folder each (halloween/, christmas/…), shown at the times of the year
 * listed in schedule.ts. Shared by the main process (which works out the theme in season and
 * paints the window chrome) and the renderers.
 */
import type { Appearance, Config } from '../shared/types'
import type { Season } from './calendar'
import { DARK, LIGHT } from './looks'

export { seasonAt, type Season } from './calendar'

/** The settings a theme depends on. */
export type ThemeSettings = Pick<Config, 'app' | 'state'>

/** Whether the theme is on: one is in season, easter eggs are allowed, and the user hasn't turned it off. */
export function themeShown(c: ThemeSettings, season: Season | null): boolean {
  return !!season && c.app.easterEggs && c.state.themeOff !== season.key
}

/** The palette variables of styles.css a theme can override. */
export type PaletteVar =
  | '--bg'
  | '--bg-dark'
  | '--bg-light'
  | '--sel'
  | '--hover'
  | '--muted'
  | '--dim'
  | '--fg'
  | '--hi'
  | '--accent'
  | '--red'
  | '--green'
  | '--yellow'
  | '--purple'
  | '--backdrop'
  | '--shadow'
  | '--hot'
  | '--hot-fg'
  | '--hot-on'

/**
 * A theme's colors. Background, text and accent are required: the native window chrome uses them.
 * What a palette leaves out stays as in styles.css (Tokyo Night), dark unless it says light.
 */
export type Palette = Record<'--bg' | '--fg' | '--accent', string> & Partial<Record<PaletteVar, string>> & { 'color-scheme'?: 'light' }

/** Tokyo Night, the usual look (styles.css). */
export const DEFAULT_PALETTE: Palette = { '--bg': '#1a1b26', '--fg': '#a9b1d6', '--accent': '#7aa2f7' }

const palettes = import.meta.glob<Palette>('./*/palette.ts', { eager: true, import: 'palette' })

/** Whether a theme folder exists. */
export function themeExists(id: string): boolean {
  return !!palettes[`./${id}/palette.ts`]
}

/** The user's colors, under any easter egg. */
function basePalette(appearance: Appearance, systemDark: boolean): Palette {
  const look = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance
  return look === 'light' ? LIGHT : look === 'dark' ? DARK : DEFAULT_PALETTE
}

/**
 * The palette in use: the easter egg theme's while it's on, whatever the user's colors. Themes are
 * drawn for Tokyo Night, and take what they leave out from it, not from the user's colors.
 */
export function activePalette(c: ThemeSettings, season: Season | null, systemDark: boolean): Palette {
  return (season && themeShown(c, season) && palettes[`./${season.id}/palette.ts`]) || basePalette(c.app.appearance, systemDark)
}

/** What the OS draws for Speak (menus, macOS's title bar) follows the colors in use: an easter egg is dark. */
export function nativeScheme(c: ThemeSettings, season: Season | null): 'system' | 'light' | 'dark' {
  if (themeShown(c, season)) return 'dark'
  return c.app.appearance === 'system' || c.app.appearance === 'light' ? c.app.appearance : 'dark'
}
