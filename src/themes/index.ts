/**
 * Renderer side of the easter egg themes (see shared.ts): applies the theme in season while it's
 * on, plays its click sounds (held for as long as the mouse button is), turns it off or back on
 * from the title row, and summons a secret theme from the history search.
 */
import { useSyncExternalStore } from 'react'
import type { Config } from '@shared/types'
import { hold, setRecording, setSoundsAllowed } from './audio'
import { activePalette, themeShown, type Season, type ThemeSettings } from './shared'
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
  /** A secret theme coming (see summon): its scene plays over the window. */
  summoning: Theme | null
}

let state: ThemeState = { theme: null, season: null, shown: false, available: false, summoning: null }
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, () => state)
}

function notify(): void {
  listeners.forEach((cb) => cb())
}

/** The palette fades into the next one (themes.css). */
function fade(): void {
  const root = document.documentElement
  root.classList.add('theme-fade')
  setTimeout(() => root.classList.remove('theme-fade'), 900)
}

/**
 * Turn the theme off (its logo) or back on ("speak"), for this season: the choice is saved. A
 * summoned theme, sent away, is gone until it's summoned again.
 */
export function setThemeShown(on: boolean): void {
  const { theme, season } = state
  if (!theme || !season) return
  fade()
  if (on) theme.sounds.on()
  else theme.sounds.off()
  if (!on && settings?.state.summoned === season.id) void api.setConfig({ state: { summoned: '' } })
  else void api.setConfig({ state: { themeOff: on ? '' : season.key } })
}

let summonEnds = 0

/**
 * A secret theme's word (see types.ts), typed in the history search, then Ctrl+Enter (⌘+Enter):
 * the theme comes, while easter eggs are allowed. It shows over any theme in season and stays, even
 * after a restart (the main process keeps it, see season.ts), until its logo sends it away. Returns
 * whether one came.
 */
export function summon(text: string): boolean {
  const word = text.trim().toLowerCase()
  const found = Object.entries(themes).find(([, t]) => t.secret && t.secret.word === word)
  if (!settings?.app.easterEggs || !word || !found) return false
  const [path, theme] = found
  fade()
  theme.sounds.on()
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state = { ...state, summoning: theme }
    notify()
    clearTimeout(summonEnds)
    summonEnds = window.setTimeout(() => {
      state = { ...state, summoning: null }
      notify()
    }, theme.secret!.ms)
  }
  void api.setConfig({ state: { summoned: path.split('/')[1] } })
  return true
}

let painted: string[] = []

/** Put the theme's palette over styles.css (or take it off). */
function paint(settings: ThemeSettings, season: Season | null): void {
  const root = document.documentElement
  for (const name of painted) root.style.removeProperty(name)
  painted = []
  if (!season || !themeShown(settings, season)) {
    delete root.dataset.theme
    return
  }
  root.dataset.theme = season.id
  for (const [name, value] of Object.entries(activePalette(settings, season))) {
    root.style.setProperty(name, value)
    painted.push(name)
  }
}

let settings: ThemeSettings | null = null
let season: Season | null = null

/** Settings or season changed: work out the theme, and repaint if it changed. */
function update(): void {
  if (!settings) return
  const theme = (season && themes[`./${season.id}/index.tsx`]) || null
  const next: ThemeState = {
    theme,
    season,
    shown: !!theme && themeShown(settings, season),
    available: !!theme && settings.app.easterEggs,
    summoning: state.summoning
  }
  if (next.theme === state.theme && next.season?.key === state.season?.key && next.shown === state.shown && next.available === state.available) return
  state = next
  paint(settings, season)
  notify()
}

export function initThemes(view: string): void {
  const onConfig = (config: Config) => {
    settings = { app: config.app, state: config.state }
    setSoundsAllowed(config.recording.sounds)
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
  window.addEventListener('pointerdown', onPress, true)
  window.addEventListener('pointerup', onLetGo, true)
  window.addEventListener('pointercancel', onLetGo, true)
  window.addEventListener('blur', letGoAll)
  window.addEventListener('click', onClick, true)
}

/** The theme's sound for a button, option or slider (the danger one for destructive actions), while it's on. */
function soundOf(target: EventTarget | null): (() => void) | null {
  const { theme, shown } = state
  if (!shown || !theme || !(target instanceof Element)) return null
  const el = target.closest('button, [role="option"], [role="slider"]')
  if (!el || el.matches(':disabled') || el.closest('.theme-toggle')) return null
  return el.matches('.action.danger') ? () => theme.sounds.danger() : () => theme.sounds.click()
}

/** Presses still down, by pointer, each letting its notes go. */
const presses = new Map<number, () => void>()

/** Pressed: the note starts, and rings for as long as the button is held. */
function onPress(e: PointerEvent): void {
  const sound = e.button === 0 && soundOf(e.target)
  if (!sound) return
  presses.get(e.pointerId)?.()
  presses.set(e.pointerId, hold(sound))
}

function onLetGo(e: PointerEvent): void {
  presses.get(e.pointerId)?.()
  presses.delete(e.pointerId)
}

function letGoAll(): void {
  presses.forEach((letGo) => letGo())
  presses.clear()
}

/** A click from the keyboard (Enter, Space) has no press: it plays its note. A mouse click played on its press. */
function onClick(e: MouseEvent): void {
  if (e.detail === 0) soundOf(e.target)?.()
}
