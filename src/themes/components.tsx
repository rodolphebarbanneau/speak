import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { setThemeShown, useTheme } from '.'
import type { PillBox } from './types'

/**
 * The app name in the title row: "speak", or the theme's logo while it's on. Clicking the logo
 * turns the theme off; clicking "speak" while the theme is in season brings it back. A secret theme
 * summoned plays its scene over the window.
 */
export function AppName() {
  const { theme, shown, available, summoning } = useTheme()
  const Scene = summoning?.secret?.Scene
  return (
    <>
      {theme && shown ? (
        <button className="theme-toggle logo" title={theme.offTitle} aria-label={theme.offTitle} onClick={() => setThemeShown(false)}>
          <theme.Logo />
        </button>
      ) : theme && available ? (
        <button className="theme-toggle" title={theme.onTitle} onClick={() => setThemeShown(true)}>
          <b>speak</b>
        </button>
      ) : (
        <b>speak</b>
      )}
      {Scene &&
        createPortal(
          <div className="theme-scene" aria-hidden>
            <Scene />
          </div>,
          document.body
        )}
    </>
  )
}

/** The theme's decorations around the recording pill (the element), drawn behind it. */
export function PillDecor({ pill }: { pill: HTMLElement | null }) {
  const { theme, shown } = useTheme()
  const [box, setBox] = useState<PillBox | null>(null)
  useLayoutEffect(() => {
    const el = pill
    if (!el || !shown) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setBox((b) => (b && b.x === r.x && b.y === r.y && b.w === r.width && b.h === r.height ? b : { x: r.x, y: r.y, w: r.width, h: r.height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [pill, shown])
  if (!theme || !shown || !box || matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  return (
    <div className="pill-decor" aria-hidden>
      <theme.PillDecor box={box} />
    </div>
  )
}
