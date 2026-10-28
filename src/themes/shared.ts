/// <reference types="vite/client" />
/**
 * Easter egg themes, one folder each (halloween/, christmas/…), shown at the times of the year
 * listed in schedule.ts. Shared by the main process (which works out the theme in season and
 * paints the window chrome) and the renderers.
 */
import type { Season } from './calendar'

export { seasonAt, type Season } from './calendar'

type Ui = { easterEggs: boolean; themeOff: string }

/** Whether the theme is on: one is in season, easter eggs are allowed, and the user hasn't turned it off. */
export function themeShown(ui: Ui, season: Season | null): boolean {
  return !!season && ui.easterEggs && ui.themeOff !== season.key
}

/** The palette variables of styles.css a theme can override. */
export type PaletteVar =
  '--bg' | '--bg-dark' | '--bg-light' | '--sel' | '--hover' | '--muted' | '--dim' | '--fg' | '--hi' | '--accent' | '--red' | '--green' | '--yellow'

/** A theme's colors. Background, text and accent are required: the native window chrome uses them. */
export type Palette = Record<'--bg' | '--fg' | '--accent', string> & Partial<Record<PaletteVar, string>>

/** Tokyo Night, the usual look (styles.css). */
export const DEFAULT_PALETTE: Palette = { '--bg': '#1a1b26', '--fg': '#a9b1d6', '--accent': '#7aa2f7' }

const palettes = import.meta.glob<Palette>('./*/palette.ts', { eager: true, import: 'palette' })

/** Whether a theme folder exists. */
export function themeExists(id: string): boolean {
  return !!palettes[`./${id}/palette.ts`]
}

/** The palette in use: the theme's while it's on. */
export function activePalette(ui: Ui, season: Season | null): Palette {
  return (season && themeShown(ui, season) && palettes[`./${season.id}/palette.ts`]) || DEFAULT_PALETTE
}
