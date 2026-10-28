/**
 * Renderer side of the easter egg themes (see shared.ts): applies the theme in season while it's
 * on, plays its click sounds, and turns it off or back on from the title row.
 */
import { useSyncExternalStore } from 'react'
import type { Config } from '@shared/types'
import { setRecording, setSoundsAllowed } from './audio'
import { activePalette, themeShown, type Season } from './shared'
import type { Theme } from './types'
import './themes.css'

const api = window.speak

const themes = import.meta.glob<Theme>('./*/index.tsx', { eager: true, import: 'theme' })

interface ThemeState {
  /** The theme in season (schedule.ts), if any. */
  theme: Theme | null
  season: Season | null
  /** The theme is on. */
  shown: boolean
  /** A theme is in season and easter eggs are allowed: "speak" can bring it back. */
  available: boolean
}

let state: ThemeState = { theme: null, season: null, shown: false, available: false }
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Turn the theme off (its logo) or back on ("speak"), for this season: the choice is saved. */
export function setThemeShown(on: boolean): void {
  const { theme, season } = state
  if (!theme || !season) return
  const root = document.documentElement
  root.classList.add('theme-fade')
  setTimeout(() => root.classList.remove('theme-fade'), 900)
  if (on) theme.sounds.on()
  else theme.sounds.off()
  void api.setConfig({ ui: { themeOff: on ? '' : season.key } })
}

let painted: string[] = []

/** Put the theme's palette over styles.css (or take it off). */
function paint(ui: Config['ui'], season: Season | null): void {
  const root = document.documentElement
  for (const name of painted) root.style.removeProperty(name)
  painted = []
  if (!season || !themeShown(ui, season)) {
    delete root.dataset.theme
    return
  }
  root.dataset.theme = season.id
  for (const [name, value] of Object.entries(activePalette(ui, season))) {
    root.style.setProperty(name, value)
    painted.push(name)
  }
}

let ui: Config['ui'] | null = null
let season: Season | null = null

/** Settings or season changed: work out the theme, and repaint if it changed. */
function update(): void {
  if (!ui) return
  const theme = (season && themes[`./${season.id}/index.tsx`]) || null
  const next: ThemeState = { theme, season, shown: !!theme && themeShown(ui, season), available: !!theme && ui.easterEggs }
  if (next.theme === state.theme && next.season?.key === state.season?.key && next.shown === state.shown && next.available === state.available) return
  state = next
  paint(ui, season)
  listeners.forEach((cb) => cb())
}

export function initThemes(view: string): void {
  const onConfig = (config: Config) => {
    ui = config.ui
    setSoundsAllowed(config.audio.sounds)
    update()
  }
  const onSeason = (next: Season | null) => {
    season = next
    update()
  }
  void api.getConfig().then(onConfig)
  api.onConfig(onConfig)
  void api.getSeason().then(onSeason)
  api.onSeason(onSeason)
  if (view === 'overlay') return // the pill gets the palette and its decorations, no sounds
  api.onOverlay((s) => setRecording(s.phase === 'recording'))
  window.addEventListener('click', onClick, true)
}

function onClick(e: MouseEvent): void {
  const { theme, shown } = state
  if (!shown || !theme) return
  const el = (e.target as Element).closest('button, [role="option"], [role="slider"]')
  if (!el || el.closest('.theme-toggle')) return
  if (el.matches('.action.danger')) theme.sounds.danger()
  else theme.sounds.click()
}
