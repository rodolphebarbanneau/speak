/**
 * Small synthesized sounds for themes (Web Audio, no files): organ pipes, chimes and bells,
 * noise bursts, through a little hall reverb. A press (`hold`) keeps its notes ringing until it's
 * let go. Silent while recording (the microphone would hear them) and when the user turned sounds
 * off.
 */

let ctx: AudioContext | null = null
let master: GainNode | null = null
let allowed = true
let recording = false

/** The notes the press being played has started (see `hold`), each waiting to be let go. */
let pressing: Array<() => void> | null = null
/** Presses still held. */
const held = new Set<() => void>()
/** When a press was last let go: a tune's pause counts from there. */
let letGoAt = 0
/** Longest a press holds its notes: a lost mouse-up mustn't leave one droning. */
const MAX_HOLD_MS = 15_000

export function setSoundsAllowed(on: boolean): void {
  allowed = on
}

/** A recording starts: let go of held notes, and cut whatever is still ringing. */
export function setRecording(on: boolean): void {
  recording = on
  if (!on) return
  for (const letGo of [...held]) letGo()
  if (ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.005)
}

/**
 * Plays `sound` for a press (a mouse button, a finger): its organ notes and chimes ring on until
 * the function returned lets it go, and never stop short of their own length. Noise plays as is.
 */
export function hold(sound: () => void): () => void {
  const notes: Array<() => void> = []
  pressing = notes
  try {
    sound()
  } finally {
    pressing = null
  }
  const letGo = (): void => {
    if (!held.delete(letGo)) return
    clearTimeout(timer)
    letGoAt = performance.now()
    for (const end of notes) end()
  }
  const timer = setTimeout(letGo, MAX_HOLD_MS)
  held.add(letGo)
  return letGo
}

/** Ends a note at `end`; or, if a press holds it, once that's let go (not before `end`). */
function ending(c: AudioContext, end: number, stop: (at: number) => void): void {
  if (pressing) pressing.push(() => stop(Math.max(end, c.currentTime)))
  else stop(end)
}

function graph(): { c: AudioContext; out: GainNode } | null {
  if (!allowed || recording) return null
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    const reverb = ctx.createConvolver()
    reverb.buffer = hall(ctx, 1.6)
    const wet = ctx.createGain()
    wet.gain.value = 0.28
    master.connect(ctx.destination)
    master.connect(reverb).connect(wet).connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  master!.gain.cancelScheduledValues(ctx.currentTime)
  master!.gain.setValueAtTime(1, ctx.currentTime)
  return { c: ctx, out: master! }
}

/** Decaying stereo noise: the impulse response of a small stone hall. */
function hall(c: AudioContext, seconds: number): AudioBuffer {
  const length = Math.round(c.sampleRate * seconds)
  const buffer = c.createBuffer(2, length, c.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3
  }
  return buffer
}

/** Partials: [pitch multiple, level]. */
type Partials = Array<[number, number]>

/** Organ stops: a sub-octave, the fundamental and a few harmonics. */
const ORGAN: Partials = [
  [0.5, 0.3],
  [1, 1],
  [2, 0.5],
  [3, 0.22],
  [4, 0.16],
  [6, 0.06]
]
/** A music box tine. */
export const TINE: Partials = [
  [1, 1],
  [2, 0.3],
  [3, 0.12],
  [4.16, 0.06]
]
/** A church bell: hum, prime, minor third, fifth, octave and above (not harmonic). */
export const BELL: Partials = [
  [0.5, 0.5],
  [1, 1],
  [1.2, 0.45],
  [1.5, 0.3],
  [2, 0.35],
  [2.5, 0.12],
  [3, 0.1]
]

/** The partials' oscillators, started at `at`: the caller stops them. */
function partials(c: AudioContext, into: AudioNode, freq: number, at: number, list: Partials): OscillatorNode[] {
  return list.map(([mult, level]) => {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.frequency.value = freq * mult
    gain.gain.value = level
    osc.connect(gain).connect(into)
    osc.start(at)
    return osc
  })
}

/** An organ note: held for `length` seconds (longer if a press holds it), then released. */
export function organ(freq: number, delay: number, length: number, level = 0.04): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const env = c.createGain()
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(level, at + 0.012)
  const tone = c.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 3200
  env.connect(tone).connect(out)
  const pipes = partials(c, env, freq, at, ORGAN)
  ending(c, at + length, (end) => {
    env.gain.setValueAtTime(level, end)
    env.gain.exponentialRampToValueAtTime(0.0001, end + 0.18)
    for (const pipe of pipes) pipe.stop(end + 0.2)
  })
}

/** How loud a held chime rings on, against its strike. */
const RING = 0.35
/** How fast it swells in (time constant, seconds): slow enough to leave a click's chime as it was. */
const SWELL = 0.25

/**
 * A struck note (music box, bell) ringing out over `length` seconds. While a press holds it, it
 * swells back as the strike dies down and rings on, softer, with a vibraphone's tremolo; let go,
 * it rings out.
 */
export function chime(freq: number, delay: number, length: number, level = 0.05, list = TINE): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const struck = at + 0.003
  const decay = length / Math.log(level / 0.0001) // time constant: down to silence over `length`
  const tone = c.createGain()
  const tines = partials(c, tone, freq, at, list)
  const strike = c.createGain()
  strike.gain.setValueAtTime(0, at)
  strike.gain.linearRampToValueAtTime(level, struck)
  strike.gain.setTargetAtTime(0, struck, decay)
  tone.connect(strike).connect(out)
  let ring: GainNode | null = null
  if (pressing) {
    ring = c.createGain()
    ring.gain.value = 0
    ring.gain.setTargetAtTime(level * RING, struck, SWELL)
    const tremolo = c.createGain()
    const lfo = c.createOscillator()
    const depth = c.createGain()
    lfo.frequency.value = 5.5
    depth.gain.value = 0.35
    lfo.connect(depth).connect(tremolo.gain)
    lfo.start(at)
    tines.push(lfo)
    tone.connect(ring).connect(tremolo).connect(out)
  }
  ending(c, struck, (end) => {
    ring?.gain.setTargetAtTime(0, end, decay)
    for (const tine of tines) tine.stop(end + length)
  })
}

/** A burst of filtered noise: a breath, the shake of a sleigh bell. */
export function noise(delay: number, length: number, freq: number, q: number, level: number): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const src = c.createBufferSource()
  src.buffer = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * length)), c.sampleRate)
  const data = src.buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const band = c.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = freq
  band.Q.value = q
  const env = c.createGain()
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(level, at + Math.min(0.03, length / 4))
  env.gain.exponentialRampToValueAtTime(0.0001, at + length)
  src.connect(band).connect(env).connect(out)
  src.start(at)
}

/**
 * A tune played one note per click: `next()` gives the next note and whether it ends a figure
 * (to ring longer). After a pause (counted from when the last press was let go) it starts over.
 */
export function tune(notes: number[], held: number[]) {
  let step = 0
  let last = 0
  return {
    next(): { freq: number; held: boolean; index: number } {
      const now = performance.now()
      if (now - Math.max(last, letGoAt) > 2500) step = 0
      last = now
      const index = step++ % notes.length
      return { freq: notes[index], held: held.includes(index), index }
    },
    /** Carry on from this note (after a theme's flourish played the first ones). */
    from(index: number): void {
      step = index
      last = performance.now()
    },
    /** How many notes have been played since the tune last started over. */
    get played(): number {
      return step
    }
  }
}
