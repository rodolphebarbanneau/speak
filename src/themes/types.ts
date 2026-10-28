import type { ComponentType } from 'react'

/** Sounds a theme plays on clicks (never while recording, and only with sounds on). */
export interface ThemeSounds {
  /** A button, option or slider. */
  click(): void
  /** A destructive action (delete…). */
  danger(): void
  /** The theme turned back on, from "speak" in the title row. */
  on(): void
  /** The theme turned off, from its logo. */
  off(): void
}

/** Where the recording pill is, in the overlay window. */
export interface PillBox {
  x: number
  y: number
  w: number
  h: number
}

/** What a theme folder's index.tsx exports as `theme`. Its palette is in palette.ts, its dates in ../schedule.ts. */
export interface Theme {
  /** Replaces "speak" in the title row. Clicking it turns the theme off. */
  Logo: ComponentType
  /** Tooltip on the logo. */
  offTitle: string
  /** Tooltip on "speak" once the theme is off: clicking it brings the theme back. */
  onTitle: string
  sounds: ThemeSounds
  /** Drawn behind the recording pill while recording. */
  PillDecor: ComponentType<{ box: PillBox }>
}
