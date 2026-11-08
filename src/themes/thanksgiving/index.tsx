import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { chime, HANDBELL, hz, tune, warble } from '../audio'
import { Canvas, cellSize, Pixels, useNudge } from '../pixels'
import type { PillBox, Theme } from '../types'
import { HYMN } from './music'
import { KERNEL, KERNEL_COLORS, SHEAF, SHEAF_COLORS, TURKEY, TURKEY_COLORS, TURKEY_PECK, TURKEY_PROUD, TURKEY_STEP, TURKEY_STRIDE } from './sprites'
import './thanksgiving.css'

const COLS = TURKEY[0].length
const ROWS = TURKEY.length
/** Every color but the snood and wattle's, which wobble on their own. */
const BODY = Object.keys(TURKEY_COLORS)
  .filter((c) => c !== 'R' && c !== 'r')
  .join('')

/** The turkey, at rest: it blinks. Hovered, after a dictation, or now and then, it shows off: tail fanned, head flushed. */
function Turkey() {
  const [proud, nudge] = useNudge(1400)
  return (
    <span className={`thanksgiving-turkey ${proud ? 'proud' : ''}`} onMouseEnter={nudge}>
      <Canvas cols={COLS} rows={ROWS} cell={cellSize(1.5)}>
        <g className="calm">
          <Pixels rows={TURKEY} colors={TURKEY_COLORS} />
          <g className="lid">
            <Pixels rows={TURKEY.map((row) => row.replace(/[^E]/g, '.').replace('E', 'H'))} colors={TURKEY_COLORS} />
          </g>
        </g>
        <g className="showing">
          <Pixels rows={TURKEY_PROUD} only={BODY} colors={TURKEY_COLORS} />
          <g className="wattle">
            <Pixels rows={TURKEY_PROUD} only="Rr" colors={TURKEY_COLORS} />
          </g>
        </g>
      </Canvas>
    </span>
  )
}

type Frame = 'step' | 'stride' | 'peck' | 'proud'
const FRAMES: Record<Frame, string[]> = { step: TURKEY_STEP, stride: TURKEY_STRIDE, peck: TURKEY_PECK, proud: TURKEY_PROUD }
/** Pixels a second, walking. */
const SPEED = 30
/** How many kernels are on the table at once. */
const KERNELS = 5

/** Where kernels fall along the stretch of table the turkey reaches (0 to 1), spread apart. */
const scatter = () => Array.from({ length: KERNELS }, (_, i) => (i + 0.15 + Math.random() * 0.7) / KERNELS)

/**
 * The recording pill as a harvest table: a sheaf of wheat at each end, kernels of corn on top, and
 * a turkey walking along it. It stops to peck each kernel it reaches (and eats it), shows off at
 * the ends of the table, and turns round; once every kernel is eaten, more fall.
 */
function HarvestTable({ box }: { box: PillBox }) {
  // A little bigger than the logo: it's on its own over another app.
  const cell = cellSize(2)
  const width = COLS * cell
  const height = ROWS * cell
  const sheafWidth = SHEAF[0].length * cell
  const left = box.x + sheafWidth + 6
  const right = box.x + box.w - sheafWidth - 6 - width
  // Where its beak reaches: facing left at the left end, facing right at the right end.
  const reach = { from: left + 1.5 * cell, to: right + (COLS - 1.5) * cell }
  const kernelAt = (at: number) => reach.from + at * (reach.to - reach.from)
  const walker = useRef<HTMLDivElement>(null)
  const [kernels, setKernels] = useState(() => scatter().map((at) => ({ at, eaten: false })))
  const eaten = useRef(kernels)
  eaten.current = kernels

  useEffect(() => {
    let x = left
    let dir = 1
    let mode: 'walk' | 'peck' | 'proud' = 'walk'
    let until = 0
    let last = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const el = walker.current
      // The beak's place on the table: the sprite faces right, and is mirrored going left.
      const beak = () => x + (dir > 0 ? (COLS - 1.5) * cell : 1.5 * cell)
      let frame: Frame = 'step'
      if (mode === 'walk') {
        x += dir * SPEED * dt
        frame = Math.floor(now / 230) % 2 ? 'stride' : 'step'
        const ahead = eaten.current.findIndex((k) => !k.eaten && Math.abs(kernelAt(k.at) - beak()) < 2)
        if (ahead >= 0) {
          mode = 'peck'
          until = now + 900
          window.setTimeout(() => setKernels((ks) => ks.map((k, i) => (i === ahead ? { ...k, eaten: true } : k))), 700)
        } else if ((dir > 0 && x >= right) || (dir < 0 && x <= left)) {
          x = dir > 0 ? right : left
          mode = 'proud'
          until = now + 1800
        }
      } else if (mode === 'peck') {
        frame = Math.floor(now / 220) % 2 ? 'peck' : 'step'
        if (now >= until) mode = 'walk'
      } else {
        frame = 'proud'
        if (now >= until) {
          mode = 'walk'
          dir = -dir
          // All eaten: more fall on the table.
          if (eaten.current.every((k) => k.eaten)) setKernels(scatter().map((at) => ({ at, eaten: false })))
        }
      }
      if (el) {
        el.style.transform = `translate(${x}px, ${box.y - height}px)`
        el.dataset.frame = frame
        el.classList.toggle('left', dir < 0)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [box.x, box.y, box.w, left, right, height, cell])

  return (
    <>
      {[box.x + 2, box.x + box.w - 2 - sheafWidth].map((at, i) => (
        <div key={i} className={`thanksgiving-sheaf ${i ? 'right' : ''}`} style={{ left: at, top: box.y - SHEAF.length * cell }}>
          <Canvas cols={SHEAF[0].length} rows={SHEAF.length} cell={cell}>
            <Pixels rows={SHEAF} colors={SHEAF_COLORS} />
          </Canvas>
        </div>
      ))}
      {kernels.map((k, i) => (
        <div
          key={i}
          className={`thanksgiving-kernel ${k.eaten ? 'eaten' : ''}`}
          style={{ left: kernelAt(k.at) - cell, top: box.y - 2 * cell } as CSSProperties}
        >
          <Canvas cols={2} rows={2} cell={cell}>
            <Pixels rows={KERNEL} colors={KERNEL_COLORS} />
          </Canvas>
        </div>
      ))}
      <div ref={walker} className="thanksgiving-walker" data-frame="step">
        <Canvas cols={COLS} rows={ROWS} cell={cell}>
          {(Object.keys(FRAMES) as Frame[]).map((f) => (
            <g key={f} className={`frame ${f}`}>
              <Pixels rows={FRAMES[f]} only={f === 'proud' ? BODY : undefined} colors={TURKEY_COLORS} />
              {f === 'proud' && (
                <g className="wattle">
                  <Pixels rows={TURKEY_PROUD} only="Rr" colors={TURKEY_COLORS} />
                </g>
              )}
            </g>
          ))}
        </Canvas>
      </div>
    </>
  )
}

/** The hymn, one chord a click: its melody note held longer at the end of a line. */
const hymn = tune(
  HYMN.map(([soprano]) => hz(soprano)),
  HYMN.flatMap(([, , , , beats], i) => (beats >= 2 ? [i] : []))
)

/** A chord of the hymn on handbells, an octave up as a handbell choir plays it: the melody over the other three parts. */
function ring(index: number, at: number, long: boolean): void {
  const [soprano, alto, tenor, bass] = HYMN[index]
  const length = long ? 2.2 : 1.1
  chime(hz(soprano, 12), at, length, 0.036, HANDBELL)
  chime(hz(alto, 12), at, length, 0.013, HANDBELL)
  chime(hz(tenor, 12), at, length, 0.013, HANDBELL)
  chime(hz(bass, 12), at, length * 1.2, 0.02, HANDBELL)
}

export const theme: Theme = {
  Logo: Turkey,
  offTitle: 'pardon the turkey',
  onTitle: 'set the table',
  PillDecor: HarvestTable,
  sounds: {
    click() {
      const note = hymn.next()
      ring(note.index, 0, note.held)
    },
    danger() {
      // The turkey, alarmed.
      warble(520, 0, 0.45, 0.11, 23, 0.75)
    },
    on() {
      // A gobble, then "Come, ye…"; clicks carry on from there.
      warble(380, 0, 0.7, 0.11)
      ring(0, 0.75, false)
      ring(1, 1.05, false)
      hymn.from(2)
    },
    off() {
      // Pardoned: a fanfare on the bells, and a relieved gobble.
      ;['F5', 'A5', 'C6', 'F6'].forEach((n, i) => chime(hz(n), i * 0.09, i === 3 ? 1.2 : 0.5, 0.03, HANDBELL))
      warble(300, 0.55, 0.6, 0.08, 14, 0.8)
    }
  }
}
