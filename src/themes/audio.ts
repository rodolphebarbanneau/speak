/**
 * Small synthesized sounds for themes (Web Audio, no files): organ pipes, chimes and bells,
 * noise bursts, through a little hall reverb. Silent while recording (the microphone would hear
 * them) and when the user turned sounds off.
 */

let ctx: AudioContext | null = null
let master: GainNode | null = null
let allowed = true
let recording = false

export function setSoundsAllowed(on: boolean): void {
  allowed = on
}

/** A recording starts: cut whatever is still ringing. */
export function setRecording(on: boolean): void {
  recording = on
  if (on && ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.005)
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

function partials(c: AudioContext, into: AudioNode, freq: number, at: number, until: number, list: Partials): void {
  for (const [mult, level] of list) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.frequency.value = freq * mult
    gain.gain.value = level
    osc.connect(gain).connect(into)
    osc.start(at)
    osc.stop(until)
  }
}

/** An organ note: held for `length` seconds, then released. */
export function organ(freq: number, delay: number, length: number, level = 0.04): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const env = c.createGain()
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(level, at + 0.012)
  env.gain.setValueAtTime(level, at + length)
  env.gain.exponentialRampToValueAtTime(0.0001, at + length + 0.18)
  const tone = c.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 3200
  env.connect(tone).connect(out)
  partials(c, env, freq, at, at + length + 0.2, ORGAN)
}

/** A struck note (music box, bell) ringing out over `length` seconds. */
export function chime(freq: number, delay: number, length: number, level = 0.05, list = TINE): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const env = c.createGain()
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(level, at + 0.003)
  env.gain.exponentialRampToValueAtTime(0.0001, at + length)
  env.connect(out)
  partials(c, env, freq, at, at + length + 0.02, list)
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
 * (to ring longer). After a pause it starts over.
 */
export function tune(notes: number[], held: number[]) {
  let step = 0
  let last = 0
  return {
    next(): { freq: number; held: boolean; index: number } {
      const now = performance.now()
      if (now - last > 2500) step = 0
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
