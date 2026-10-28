import type { CSSProperties } from 'react'
import { BELL, chime, noise, tune } from '../audio'
import { Canvas, cellSize, Pixels, useNudge } from '../pixels'
import type { PillBox, Theme } from '../types'
import { FLAKE_BIG, FLAKE_COLORS, FLAKE_DOT, FLAKE_SMALL, TREE, TREE_COLORS, TREE_SPARKLE } from './sprites'
import './christmas.css'

/** The Christmas tree: its baubles twinkle like fairy lights, and its star sparkles now and then. */
function Tree() {
  const [sparkle, nudge] = useNudge(600)
  return (
    <span className={`christmas-tree ${sparkle ? 'sparkle' : ''}`} onMouseEnter={nudge}>
      <Canvas cols={13} rows={14} cell={cellSize(1.5)}>
        <Pixels rows={TREE} colors={TREE_COLORS} />
        <g className="star">
          <Pixels rows={TREE} only="S" />
        </g>
        <g className="lights red">
          <Pixels rows={TREE} only="r" />
        </g>
        <g className="lights gold">
          <Pixels rows={TREE} only="y" />
        </g>
        <g className="lights blue">
          <Pixels rows={TREE} only="b" />
        </g>
        <g className="rays">
          <Pixels rows={TREE_SPARKLE} />
        </g>
      </Canvas>
    </span>
  )
}

const KINDS = [FLAKE_BIG, FLAKE_SMALL, FLAKE_DOT, FLAKE_SMALL]
/** Picked once: where each flake falls across the pill, how fast, and how it sways. */
const FLAKES = Array.from({ length: 16 }, (_, i) => ({
  across: (i + 0.2 + Math.random() * 0.6) / 16,
  delay: -Math.random() * 7,
  fall: 4.5 + Math.random() * 3,
  sway: 1.4 + Math.random() * 1.6,
  rows: KINDS[i % KINDS.length]
}))

/** Snow falling around the recording pill, and behind it. */
function Snow({ box }: { box: PillBox }) {
  const cell = cellSize(1.5)
  const left = box.x - 24
  const width = box.w + 48
  const top = box.y - 60
  return (
    <>
      {FLAKES.map((f, i) => (
        <div
          key={i}
          className="christmas-flake"
          style={
            {
              left: left + f.across * width,
              top,
              animationDuration: `${f.fall}s`,
              animationDelay: `${f.delay}s`,
              '--fall': `${60 + box.h - 6}px`, // they melt away behind the pill
              '--sway': `${f.sway}s`
            } as CSSProperties
          }
        >
          <Canvas cols={f.rows[0].length} rows={f.rows.length} cell={cell}>
            <Pixels rows={f.rows} colors={FLAKE_COLORS} />
          </Canvas>
        </div>
      ))}
    </>
  )
}

/** Jingle Bells (public domain), on a music box: each click plays its next note. */
const C5 = 523.25
const D5 = 587.33
const E5 = 659.25
const F5 = 698.46
const G5 = 783.99
const jingle = tune([E5, E5, E5, E5, E5, E5, E5, G5, C5, D5, E5, F5, F5, F5, F5, F5, E5, E5, E5, E5, D5, D5, E5, D5, G5], [2, 5, 10, 23, 24])

export const theme: Theme = {
  Logo: Tree,
  offTitle: 'switch off the tree',
  onTitle: 'light up the tree',
  PillDecor: Snow,
  sounds: {
    click() {
      const note = jingle.next()
      chime(note.freq, 0, note.held ? 0.9 : 0.45, 0.045)
    },
    danger() {
      // A church bell, low.
      chime(196, 0, 1.8, 0.03, BELL)
    },
    on() {
      // Sleigh bells, and the first "jingle bells"; clicks carry on from there.
      ;[0, 0.07, 0.13, 0.2, 0.26, 0.33, 0.41].forEach((t) => {
        noise(t, 0.07, 7000, 3, 0.05)
        chime(2800 + Math.random() * 700, t, 0.18, 0.008)
      })
      chime(E5, 0.05, 0.4, 0.045)
      chime(E5, 0.21, 0.4, 0.045)
      chime(E5, 0.37, 0.9, 0.045)
      jingle.from(3)
    },
    off() {
      chime(G5, 0, 0.5, 0.03)
      chime(C5, 0.14, 0.9, 0.03)
    }
  }
}
