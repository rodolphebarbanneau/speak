import type { Palette } from './shared'

/**
 * White and ink, the accent included: color only says something (recording, errors, status), or
 * answers the pointer (the blue of what's under it, the logo's dots). The red and the blue are
 * brbnn.com's, the red darkened to read on light gray.
 */
export const LIGHT: Palette = {
  'color-scheme': 'light',
  '--bg': '#ffffff',
  '--bg-dark': '#fafafa',
  '--bg-light': '#f5f5f5',
  '--sel': '#e5e5e5',
  '--hover': 'rgba(0, 0, 0, 0.04)',
  '--muted': '#a3a3a3',
  '--dim': '#6b6b6b',
  '--fg': '#404040',
  '--hi': '#0a0a0a',
  '--accent': '#000000',
  '--red': '#c9341a',
  '--green': '#0a7f68',
  '--yellow': '#946200',
  '--purple': '#5b3fd6',
  '--backdrop': 'rgba(0, 0, 0, 0.28)',
  '--shadow': '0 0 0 1px #e5e5e5, 0 18px 48px rgba(0, 0, 0, 0.16)',
  '--hot': '#1c3fb7',
  '--hot-fg': '#1c3fb7'
}

/** Black and white, the same system as LIGHT inverted. */
export const DARK: Palette = {
  '--bg': '#000000',
  '--bg-dark': '#0a0a0a',
  '--bg-light': '#111111',
  '--sel': '#262626',
  '--hover': 'rgba(255, 255, 255, 0.05)',
  '--muted': '#3f3f3f',
  '--dim': '#7c7c7c',
  '--fg': '#a1a1a1',
  '--hi': '#ededed',
  '--accent': '#ffffff',
  '--red': '#ff5f56',
  '--green': '#50e3c2',
  '--yellow': '#f5a623',
  '--purple': '#a78bfa',
  '--backdrop': 'rgba(0, 0, 0, 0.72)',
  '--shadow': '0 0 0 1px #262626, 0 18px 48px rgba(0, 0, 0, 0.8)',
  '--hot': '#6b8cff',
  '--hot-fg': '#6b8cff'
}
