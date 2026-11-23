import type { Palette } from './shared'

/**
 * White and ink, built like every other theme: the same roles, the same hover rules. Its colors
 * are brbnn.com's red and yellow, with a green and a plum (its red and blue mixed, for control
 * mode) drawn to sit beside them. The site's blue is kept for one thing: the mark of the control
 * under the pointer, which black and white can't show. Red and yellow are darkened to read on white.
 */
export const LIGHT: Palette = {
  'color-scheme': 'light',
  '--bg': '#ffffff',
  '--bg-dark': '#fafafa',
  '--bg-light': '#f5f5f5',
  '--sel': '#e5e5e5',
  '--hover': 'rgba(0, 0, 0, 0.04)',
  '--muted': '#949494',
  '--dim': '#666666',
  '--fg': '#404040',
  '--hi': '#0a0a0a',
  '--accent': '#000000',
  '--red': '#c9341a',
  '--green': '#157542',
  '--yellow': '#856400',
  '--purple': '#86307a',
  '--backdrop': 'rgba(0, 0, 0, 0.28)',
  '--shadow': '0 0 0 1px #e5e5e5, 0 18px 48px rgba(0, 0, 0, 0.16)',
  '--hot': '#1c3fb7',
  '--hot-fg': '#1c3fb7',
  '--hot-on': '#6b8cff'
}

/** Black and white, the same system as LIGHT inverted, in brbnn.com's colors for a dark page. */
export const DARK: Palette = {
  '--bg': '#000000',
  '--bg-dark': '#0a0a0a',
  '--bg-light': '#111111',
  '--sel': '#262626',
  '--hover': 'rgba(255, 255, 255, 0.05)',
  '--muted': '#5c5c5c',
  '--dim': '#858585',
  '--fg': '#a1a1a1',
  '--hi': '#ededed',
  '--accent': '#ffffff',
  '--red': '#f0603c',
  '--green': '#62c98f',
  '--yellow': '#f6c62a',
  '--purple': '#d483c2',
  '--backdrop': 'rgba(0, 0, 0, 0.72)',
  '--shadow': '0 0 0 1px #262626, 0 18px 48px rgba(0, 0, 0, 0.8)',
  '--hot': '#6b8cff',
  '--hot-fg': '#6b8cff',
  '--hot-on': '#1c3fb7'
}
