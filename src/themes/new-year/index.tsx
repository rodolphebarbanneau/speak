import { useEffect, type CSSProperties } from 'react'
import { BELL, chime, GLASS, hz, noise, tune } from '../audio'
import { Canvas, cellSize, Pixels, useNudge } from '../pixels'
import type { PillBox, Theme } from '../types'
import { AULD, CHORDS } from './music'
import { BOTTLE, BOTTLE_COLORS, BUBBLES, FLUTE, FLUTE_COLORS, SPARKS, SPRAY, SPRAY_COLOR } from './sprites'
import './new-year.css'

/** Where the flute stands, beside the bottle (its top-left cell). */
const FLUTE_AT = { x: 14, y: 2 }

/**
 * The bottle of champagne and a flute poured beside it: the foil glints, bubbles rise in the
 * glass. Hovered, after a dictation, or now and then, the cork pops and the foam sprays out; on
 * New Year's Eve, it pops by itself at midnight.
 */
function Champagne() {
  const [pop, nudge] = useNudge(1600)
  useEffect(() => {
    const now = new Date()
    if (now.getMonth() !== 11 || now.getDate() !== 31) return
    const midnight = new Date(now.getFullYear() + 1, 0, 1).getTime() - now.getTime()
    const timer = window.setTimeout(nudge, midnight)
    return () => clearTimeout(timer)
  }, [nudge])
  return (
    <span className={`new-year-bottle ${pop ? 'pop' : ''}`} onMouseEnter={nudge}>
      {/* Just the drawing: the cork and the foam fly out of it, so it sits centered on the title's text. */}
      <Canvas cols={FLUTE_AT.x + FLUTE[0].length} rows={BOTTLE.length} cell={cellSize(1.5)}>
        <Pixels rows={BOTTLE} only="gGdLfF" colors={BOTTLE_COLORS} />
        <g className="shine">
          <Pixels rows={BOTTLE} only="F" colors={BOTTLE_COLORS} />
        </g>
        <g className="cork">
          <Pixels rows={BOTTLE} only="cq" colors={BOTTLE_COLORS} />
        </g>
        <g transform={`translate(${FLUTE_AT.x} ${FLUTE_AT.y})`}>
          <Pixels rows={FLUTE} colors={FLUTE_COLORS} />
          {BUBBLES.map((b, i) => (
            <rect key={i} className="bubble" x={b.x} y={6} width={1} height={1} style={{ animationDelay: `${b.delay}s` }} />
          ))}
        </g>
        <g transform={`translate(0 ${-SPRAY.length + 2})`}>
          <g className="spray">
            <Pixels rows={SPRAY} colors={{ w: SPRAY_COLOR }} />
          </g>
        </g>
      </Canvas>
    </span>
  )
}

/** A firework: where it bursts over the pill, how often (seconds), its color, and where each spark flies (px from the burst). */
interface Shot {
  x: number
  y: number
  every: number
  delay: number
  color: string
  /** Each spark: where it flies (px from the burst), and its angle (it streaks that way). */
  sparks: Spark[]
  /** The bright core of the burst. */
  core?: Spark[]
}

interface Spark {
  x: number
  y: number
  a: number
}

/** A ring of sparks, unevenly spread and flung. */
const ring = (count: number, radius: number): Spark[] =>
  Array.from({ length: count }, (_, i) => {
    const angle = ((i + Math.random() * 0.4) / count) * Math.PI * 2
    const r = radius * (0.75 + Math.random() * 0.35)
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, a: (angle * 180) / Math.PI + 90 }
  })

/** Picked once: across the sky over the pill (0 to 1), how high, how often, which color. */
const SHOTS = [0.12, 0.5, 0.86].map((across, i) => ({
  across,
  high: Math.random(),
  every: 4.6 + i * 1.3,
  delay: -Math.random() * 4,
  color: SPARKS[(i + 1) % 3],
  sparks: ring(18, 32),
  core: ring(8, 11)
}))
const CONFETTI = Array.from({ length: 18 }, (_, i) => ({
  across: (i + Math.random()) / 18,
  delay: -Math.random() * 9,
  fall: 6 + Math.random() * 4,
  flip: 0.7 + Math.random() * 0.9,
  color: SPARKS[i % SPARKS.length],
  tall: i % 3 === 0
}))

function Firework({ shot, launch }: { shot: Shot; launch: number }) {
  return (
    <div
      className="new-year-shot"
      style={
        {
          left: shot.x,
          top: shot.y,
          '--every': `${shot.every}s`,
          '--delay': `${shot.delay}s`,
          '--color': shot.color,
          '--rise': `${launch - shot.y}px`
        } as CSSProperties
      }
    >
      <i className="rocket" />
      <i className="flash" />
      {[...shot.sparks.map((s) => [s, 'spark'] as const), ...(shot.core ?? []).map((s) => [s, 'spark core'] as const)].map(([s, kind], i) => (
        <i key={i} className={kind} style={{ '--x': `${s.x}px`, '--y': `${s.y}px`, '--a': `${s.a}deg` } as CSSProperties} />
      ))}
    </div>
  )
}

/** The sky over the recording pill at midnight: rockets going up from behind it and bursting, confetti coming down. */
function Midnight({ box }: { box: PillBox }) {
  const sky = { left: box.x + 40, width: box.w - 80, top: box.y - 100, height: 40 }
  const shots: Shot[] = SHOTS.map((s) => ({ ...s, x: sky.left + s.across * sky.width, y: sky.top + s.high * sky.height }))
  return (
    <>
      {CONFETTI.map((c, i) => (
        <div
          key={i}
          className="new-year-confetti"
          style={
            {
              left: box.x - 20 + c.across * (box.w + 40),
              top: box.y - 130,
              animationDuration: `${c.fall}s`,
              animationDelay: `${c.delay}s`,
              '--fall': `${130 + box.h / 2}px`,
              '--flip': `${c.flip}s`
            } as CSSProperties
          }
        >
          <i style={{ background: c.color, height: c.tall ? 8 : 5 }} />
        </div>
      ))}
      {shots.map((s, i) => (
        <Firework key={i} shot={s} launch={box.y + 6} />
      ))}
    </>
  )
}

/** Auld Lang Syne on crystal glasses, an octave up: each click its next note, and a bar's chord under it when one starts. */
const auldLangSyne = tune(
  AULD.map(([note]) => hz(note, 12)),
  AULD.flatMap(([, beats], i) => (beats >= 3 ? [i] : []))
)

function toast(index: number, at: number, long: boolean): void {
  const [note, , chord] = AULD[index]
  chime(hz(note, 12), at, long ? 2.4 : 1.2, 0.04, GLASS)
  if (chord) for (const n of CHORDS[chord]) chime(hz(n, 12), at, 2.2, 0.011, GLASS)
}

/** A cork popping: the bang, its hollow note, then the fizz. */
function cork(at: number): void {
  noise(at, 0.05, 1300, 0.8, 0.22)
  chime(240, at, 0.12, 0.04, GLASS)
  noise(at + 0.06, 1.1, 6500, 0.6, 0.012)
}

export const theme: Theme = {
  Logo: Champagne,
  offTitle: 'cork the champagne',
  onTitle: 'pop the champagne',
  PillDecor: Midnight,
  sounds: {
    click() {
      const note = auldLangSyne.next()
      toast(note.index, 0, note.held)
    },
    danger() {
      // The midnight bell.
      chime(130.81, 0, 2.4, 0.03, BELL)
    },
    on() {
      // The cork, then "Should auld…"; clicks carry on from there.
      cork(0)
      toast(0, 0.55, false)
      toast(1, 0.85, false)
      auldLangSyne.from(2)
    },
    off() {
      // Two glasses: cheers.
      chime(1760, 0, 1.4, 0.022, GLASS)
      chime(2093, 0.03, 1.4, 0.018, GLASS)
    }
  }
}
