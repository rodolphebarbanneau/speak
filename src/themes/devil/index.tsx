import type { CSSProperties } from 'react'
import { BELL, chime, clip, crackle, horn, hz, noise, rumble, tune, whoosh } from '../audio'
import { Canvas, cellSize, Pixels, useNudge } from '../pixels'
import type { PillBox, Theme } from '../types'
import { DEVIL, DEVIL_COLORS, FLAME_COLORS, FLAMES, GARGOYLE, GARGOYLE_COLORS, PITCHFORK, PITCHFORK_COLORS, TRIDENT, TRIDENT_COLORS } from './sprites'
import { VOICE } from './voice'
import './devil.css'

/** Every color of the devil but its eyes' and its mouth's, which burn on their own. */
const SKIN = Object.keys(DEVIL_COLORS)
  .filter((c) => c !== 'e' && c !== 'm')
  .join('')

/** The devil's head: its eyes smoulder, the fire inside its mouth flickers. */
function Head({ cell }: { cell: number }) {
  return (
    <Canvas cols={DEVIL[0].length} rows={DEVIL.length} cell={cell}>
      <Pixels rows={DEVIL} only={SKIN} colors={DEVIL_COLORS} />
      <g className="eyes">
        <Pixels rows={DEVIL} only="e" />
      </g>
      <g className="mouth">
        <Pixels rows={DEVIL} only="m" />
      </g>
    </Canvas>
  )
}

/** The logo. Hovered, after a dictation, or now and then, the devil laughs. */
function Devil() {
  const [laugh, nudge] = useNudge(1100)
  return (
    <span className={`devil-head ${laugh ? 'laugh' : ''}`} onMouseEnter={nudge}>
      <Head cell={cellSize(1.5)} />
    </span>
  )
}

const FLAME_COLS = FLAMES[0][0].length
const FLAME_ROWS = FLAMES[0].length

/** A flame: its three drawings in turn, `pace` seconds a round, and it swells and settles every `breathe`. */
function Flame({ cell, style }: { cell: number; style: CSSProperties }) {
  return (
    <div className="devil-flame" style={style}>
      {FLAMES.map((rows, i) => (
        <Canvas key={i} cols={FLAME_COLS} rows={FLAME_ROWS} cell={cell} className={`frame f${i}`}>
          <Pixels rows={rows} colors={FLAME_COLORS} />
        </Canvas>
      ))}
    </div>
  )
}

/** Picked once: each flame's height (rows sunk out of sight), its pace and its breath. */
const FIRE = Array.from({ length: 64 }, () => ({
  sink: Math.floor(Math.random() * 4),
  pace: 0.32 + Math.random() * 0.22,
  delay: -Math.random() * 2,
  breathe: 0.7 + Math.random() * 0.9
}))
const flameStyle = (f: (typeof FIRE)[number]) => ({ '--pace': `${f.pace}s`, '--delay': `${f.delay}s`, '--breathe': `${f.breathe}s` }) as CSSProperties

/** Embers flying up, and where along the fire each one rises. */
const EMBERS = Array.from({ length: 40 }, (_, i) => ({
  across: (i % 20) / 20 + Math.random() / 20,
  delay: -Math.random() * 4,
  rise: 1.8 + Math.random() * 1.8,
  drift: (Math.random() - 0.5) * 36,
  size: Math.random() < 0.3 ? 3 : 2,
  hot: Math.random() < 0.4
}))

function Ember({ e, left, top, height }: { e: (typeof EMBERS)[number]; left: number; top: number; height: number }) {
  return (
    <i
      className={`devil-ember ${e.hot ? 'hot' : ''}`}
      style={
        {
          left,
          top,
          width: e.size,
          height: e.size,
          animationDuration: `${e.rise}s`,
          animationDelay: `${e.delay}s`,
          '--drift': `${e.drift}px`,
          '--rise': `${-height}px`
        } as CSSProperties
      }
    />
  )
}

/** A gargoyle on one of the pill's corners, facing in, its eyes alight; `fork` stands behind it, red hot. */
function Perch({ x, y, cell, right, fork, colors }: { x: number; y: number; cell: number; right?: boolean; fork: string[]; colors: Record<string, string> }) {
  const forkW = fork[0].length * cell
  const w = GARGOYLE[0].length * cell
  const h = GARGOYLE.length * cell
  return (
    <div className={`devil-perch ${right ? 'right' : ''}`} style={{ left: x, top: y - h + cell, width: w, height: h }}>
      <div className="fork" style={{ left: 3 * cell - forkW / 2, top: -10 * cell }}>
        <Canvas cols={fork[0].length} rows={fork.length} cell={cell}>
          <Pixels rows={fork} only="iIdD" colors={colors} />
          <g className="tips">
            <Pixels rows={fork} only="t" />
          </g>
        </Canvas>
      </div>
      <div className="gargoyle">
        <Canvas cols={GARGOYLE[0].length} rows={GARGOYLE.length} cell={cell}>
          <Pixels rows={GARGOYLE} only="kGgLcmwW" colors={GARGOYLE_COLORS} />
          <g className="eyes">
            <Pixels rows={GARGOYLE} only="e" />
          </g>
        </Canvas>
      </div>
    </div>
  )
}

/**
 * The recording pill at the gates of hell: fire licking up from behind it, embers flying, and on
 * each end a gargoyle keeping watch, a trident behind the one, a pitchfork behind the other.
 */
function Inferno({ box }: { box: PillBox }) {
  const cell = cellSize(2)
  const gargoyle = GARGOYLE[0].length * cell
  const flame = FLAME_COLS * cell
  const from = box.x + gargoyle
  const to = box.x + box.w - gargoyle - flame
  const count = Math.max(2, Math.min(FIRE.length, Math.round((to - from) / (flame * 0.8))))
  return (
    <>
      <i className="devil-heat" style={{ left: box.x, top: box.y - 40, width: box.w, height: 60 }} />
      {FIRE.slice(0, count).map((f, i) => (
        <Flame key={i} cell={cell} style={{ left: from + (i / (count - 1)) * (to - from), top: box.y - (FLAME_ROWS - 3 - f.sink) * cell, ...flameStyle(f) }} />
      ))}
      {EMBERS.slice(0, 16).map((e, i) => (
        <Ember key={i} e={e} left={from + e.across * (to - from + flame)} top={box.y - 6} height={50 + e.rise * 14} />
      ))}
      <Perch x={box.x + 2} y={box.y} cell={cell} fork={TRIDENT} colors={TRIDENT_COLORS} />
      <Perch x={box.x + box.w - 2 - gargoyle} y={box.y} cell={cell} right fork={PITCHFORK} colors={PITCHFORK_COLORS} />
    </>
  )
}

/** How long the devil takes to come, in ms: as long as its voice. */
const SCENE_MS = 3800

/**
 * The devil coming: the window goes red, a wall of fire rises from the bottom (two rows, the one
 * behind darker), embers fly up, and its face looms through the flames as it speaks.
 */
function Hellfire() {
  const cell = cellSize(9)
  const flame = FLAME_COLS * cell
  const count = Math.ceil(window.innerWidth / (flame * 0.75)) + 1
  const height = window.innerHeight
  return (
    <div className="devil-hellfire">
      <i className="glow" />
      <div className="face">
        <Head cell={cellSize(13)} />
      </div>
      {[0, 1].map((row) => (
        <div key={row} className={`wall row${row}`} style={{ height: FLAME_ROWS * cell }}>
          {Array.from({ length: count }, (_, i) => {
            const f = FIRE[(row * count + i) % FIRE.length]
            return <Flame key={i} cell={cell} style={{ left: (i - row / 2) * flame * 0.75, bottom: -(f.sink + row * 2) * cell, ...flameStyle(f) }} />
          })}
        </div>
      ))}
      {EMBERS.map((e, i) => (
        <Ember key={i} e={e} left={e.across * window.innerWidth} top={height - 40} height={height * (0.45 + e.rise / 8)} />
      ))}
    </div>
  )
}

/** "Dies irae", the day of wrath (Gregorian chant, public domain), on horns from below: each click its next note. */
const diesIrae = tune(
  ['F3', 'E3', 'F3', 'D3', 'E3', 'C3', 'D3', 'D3'].map((n) => hz(n)),
  [7]
)

export const theme: Theme = {
  Logo: Devil,
  offTitle: 'exorcise the devil',
  onTitle: 'summon the devil',
  PillDecor: Inferno,
  secret: { word: 'sheitan', Scene: Hellfire, ms: SCENE_MS },
  sounds: {
    click() {
      // The chant, then again an octave down, over its own octave below.
      const octave = Math.floor(diesIrae.played / 8) % 2 ? 0.5 : 1
      const note = diesIrae.next()
      const length = note.held ? 0.55 : 0.16
      horn(note.freq * octave, 0, length, 0.026)
      horn(note.freq * octave * 0.5, 0, length, 0.016)
    },
    danger() {
      // The devil's interval, a tritone, from the depths, and the ground shaking.
      horn(hz('D2'), 0, 0.9, 0.028)
      horn(hz('G#2'), 0.03, 0.85, 0.024)
      horn(hz('D3'), 0.06, 0.8, 0.016)
      rumble(0, 1.4, 0.14, 0.12)
    },
    on() {
      // The ground shakes, fire roars up, and a voice from below.
      rumble(0, 4, 0.22, 0.15)
      whoosh(0, 1.9, 0.08)
      crackle(0.25, 3.2, 24)
      clip(VOICE, 0.55, 0.65, 0.45)
    },
    off() {
      // Exorcised: a church bell, and the fire hissing out.
      noise(0, 1.1, 5000, 0.6, 0.05)
      chime(hz('G4'), 0.05, 2.4, 0.03, BELL)
    }
  }
}
