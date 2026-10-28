import { noise, organ, tune } from '../audio'
import { Canvas, cellSize, Pixels, useNudge } from '../pixels'
import type { PillBox, Theme } from '../types'
import { BAT_COLORS, BAT_DOWN, BAT_UP, PUMPKIN, PUMPKIN_BODY, PUMPKIN_COLORS, PUMPKIN_LID } from './sprites'
import './halloween.css'

/** The lit jack-o'-lantern: its candle flickers, and it winks now and then. */
function Pumpkin() {
  const [wink, nudge] = useNudge(260)
  return (
    <span className={`halloween-pumpkin ${wink ? 'wink' : ''}`} onMouseEnter={nudge}>
      <Canvas cols={13} rows={11} cell={cellSize(1.5)}>
        <Pixels rows={PUMPKIN_BODY} colors={PUMPKIN_COLORS} />
        <g className="face">
          <Pixels rows={PUMPKIN} only="e" />
        </g>
        <g className="eye">
          <Pixels rows={PUMPKIN} only="E" />
        </g>
        <g className="lid">
          <Pixels rows={PUMPKIN_LID} />
        </g>
      </Canvas>
    </span>
  )
}

const BATS = 3
/** Seconds for one turn around the pill. */
const ORBIT_S = 8

/**
 * Bats circling the recording pill: over its top edge, then behind it. The orbit is an ellipse
 * whose top arc clears the pill and whose bottom arc stays hidden behind it.
 */
function Bats({ box }: { box: PillBox }) {
  const cell = cellSize(1.5)
  const top = box.y - 10 // top arc: the bats' centers, above the pill
  const bottom = box.y + box.h - 10 // bottom arc: behind the pill
  const cx = box.x + box.w / 2
  const cy = (top + bottom) / 2
  const rx = box.w / 2 + 16
  const ry = (bottom - top) / 2
  const path = `path('M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy}')`
  return (
    <>
      {Array.from({ length: BATS }, (_, i) => (
        <div key={i} className="halloween-bat" style={{ offsetPath: path, animationDelay: `${(-i * ORBIT_S) / BATS}s` }}>
          <Canvas cols={11} rows={6} cell={cell} className="up">
            <Pixels rows={BAT_UP} colors={BAT_COLORS} />
          </Canvas>
          <Canvas cols={11} rows={6} cell={cell} className="down">
            <Pixels rows={BAT_DOWN} colors={BAT_COLORS} />
          </Canvas>
        </div>
      ))}
    </>
  )
}

/** Bach's Toccata in D minor, the haunted-house organ: each click plays its next note. */
const A4 = 440
const G4 = 392
const toccata = tune([A4, G4, A4, G4, 349.23, 329.63, 293.66, 277.18, 293.66], [2, 8])

export const theme: Theme = {
  Logo: Pumpkin,
  offTitle: 'blow out the pumpkin',
  onTitle: 'light the pumpkin',
  PillDecor: Bats,
  sounds: {
    click() {
      // The figure, then again an octave down.
      const octave = Math.floor(toccata.played / 9) % 2 ? 0.5 : 1
      const note = toccata.next()
      organ(note.freq * octave, 0, note.held ? 0.3 : 0.11)
    },
    danger() {
      // The rolled diminished chord over a low D.
      organ(73.42, 0, 0.75, 0.025)
      ;[138.59, 164.81, 196, 233.08].forEach((f, i) => organ(f, 0.04 * (i + 1), 0.7 - 0.04 * i, 0.022))
    },
    on() {
      // The opening mordent, A–G–A; clicks carry on from there.
      organ(A4, 0, 0.07)
      organ(G4, 0.09, 0.07)
      organ(A4, 0.18, 0.45)
      toccata.from(3)
    },
    off() {
      // Blowing the candle out.
      noise(0, 0.35, 1100, 0.8, 0.09)
    }
  }
}
