import { useCallback, useEffect, useState, type ReactNode } from 'react'

/** Pixel art for themes: maps are rows of characters, one per pixel, '.' transparent. */

interface Run {
  x: number
  y: number
  w: number
  ch: string
}

/** Horizontal runs of same-character pixels (only the given characters, if any). */
function runs(rows: string[], only?: string): Run[] {
  const out: Run[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ch = row[x]
      let w = 1
      while (row[x + w] === ch) w++
      if (ch !== '.' && (!only || only.includes(ch))) out.push({ x, y, w, ch })
      x += w
    }
  })
  return out
}

/** A pixel size that is a whole number of device pixels, so pixels stay square and crisp. */
export function cellSize(target: number): number {
  const dpr = window.devicePixelRatio || 1
  return Math.max(1, Math.round(target * dpr)) / dpr
}

/** The pixels of a map as SVG rects: colored from `colors`, or left to CSS `fill` without it. */
export function Pixels({ rows, colors, only }: { rows: string[]; colors?: Record<string, string>; only?: string }) {
  return (
    <>
      {runs(rows, only).map((r) => (
        <rect key={`${r.x}.${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={colors?.[r.ch]} />
      ))}
    </>
  )
}

/** An SVG canvas `cols` × `rows` pixels of `cell` CSS pixels each. */
export function Canvas({ cols, rows, cell, className, children }: { cols: number; rows: number; cell: number; className?: string; children: ReactNode }) {
  return (
    <svg className={className} width={cols * cell} height={rows * cell} viewBox={`0 0 ${cols} ${rows}`} shapeRendering="crispEdges" aria-hidden>
      {children}
    </svg>
  )
}

/**
 * A logo's little gesture (a wink, a flick of the tongue): `ms` long, on hover (call the returned
 * function), every 20 to 60 seconds, and after each dictation.
 */
export function useNudge(ms: number): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const nudge = useCallback(() => {
    setOn(true)
    setTimeout(() => setOn(false), ms)
  }, [ms])
  useEffect(() => {
    let timer = 0
    const later = () => {
      timer = window.setTimeout(
        () => {
          nudge()
          later()
        },
        20_000 + Math.random() * 40_000
      )
    }
    later()
    const off = window.speak.onHistoryChanged(nudge)
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [nudge])
  return [on, nudge]
}
