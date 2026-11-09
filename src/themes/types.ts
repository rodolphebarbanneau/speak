import type { ComponentType } from 'react'

/** Sounds a theme plays on clicks (never while recording, and only with sounds on). */
export interface ThemeSounds {
  /** A button, option or slider, pressed: its notes ring on for as long as it's held. */
  click(): void
  /** A destructive action (delete…), pressed: held the same way. */
  danger(): void
  /** The theme turned back on, from "speak" in the title row (or a secret theme summoned). */
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

/** What a theme folder's index.tsx exports as `theme`. Its palette is in palette.ts, its dates in ../schedule.ts (unless it's secret). */
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
  /**
   * A secret theme, on no schedule: typing `word` in the history search, then Ctrl+Enter (⌘+Enter),
   * summons it while easter eggs are allowed (index.ts, summon). `Scene` plays over the window as
   * it comes, for `ms`.
   */
  secret?: { word: string; Scene: ComponentType; ms: number }
}
