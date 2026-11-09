/**
 * Small sounds for themes (Web Audio, no files): organ pipes, chimes and bells, horns, noise
 * bursts and fire, synthesized, and short clips kept in the code, through a little hall reverb. A press (`hold`) keeps its notes ringing until it's
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
/** A handbell: its strong twelfth (an octave and a fifth over the note), and little else. */
export const HANDBELL: Partials = [
  [1, 1],
  [3, 0.42],
  [2, 0.08],
  [5.4, 0.1]
]
/** A crystal glass, rung: a pure note with faint overtones above it (a glass's, not harmonic). */
export const GLASS: Partials = [
  [1, 1],
  [2.32, 0.22],
  [4.25, 0.07],
  [6.63, 0.025]
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
 * A warbling voice, a turkey's gobble: a reedy tone shaken fast in pitch and loudness (`rate`
 * times a second), its pitch falling by `fall` (0.7: to 70%) as it goes.
 */
export function warble(freq: number, delay: number, length: number, level = 0.05, rate = 17, fall = 0.7): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const end = at + length
  const voice = c.createOscillator()
  voice.type = 'sawtooth'
  voice.frequency.setValueAtTime(freq, at)
  voice.frequency.exponentialRampToValueAtTime(freq * fall, end)
  const shake = c.createOscillator()
  shake.frequency.value = rate
  const pitch = c.createGain()
  pitch.gain.value = freq * 0.16
  shake.connect(pitch).connect(voice.frequency)
  // Loudness pulses with the shake: "gobble-obble-obble".
  const pulse = c.createGain()
  pulse.gain.value = 0.55
  const depth = c.createGain()
  depth.gain.value = 0.45
  shake.connect(depth).connect(pulse.gain)
  const throat = c.createBiquadFilter()
  throat.type = 'bandpass'
  throat.frequency.value = freq * 2.4
  throat.Q.value = 1.4
  const env = c.createGain()
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(level, at + 0.02)
  env.gain.setValueAtTime(level, at + length * 0.6)
  env.gain.exponentialRampToValueAtTime(0.0001, end)
  voice.connect(throat).connect(pulse).connect(env).connect(out)
  voice.start(at)
  shake.start(at)
  voice.stop(end + 0.05)
  shake.stop(end + 0.05)
}

/** A note's frequency, `shift` semitones up: "A4" is 440 Hz; "Bb3", "F#5". */
export function hz(note: string, shift = 0): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(note)
  if (!m) throw new Error(`Not a note: ${note}`)
  const semitone = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1] as 'A'] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
  return 440 * 2 ** ((semitone + (Number(m[3]) - 4) * 12 + shift) / 12)
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

/**
 * A horn from below: three sawtooths a little out of tune, through a filter that opens as it's
 * blown, held for `length` seconds (longer if a press holds it), then released.
 */
export function horn(freq: number, delay: number, length: number, level = 0.03): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const env = c.createGain()
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(level, at + 0.04)
  const tone = c.createBiquadFilter()
  tone.type = 'lowpass'
  tone.Q.value = 3
  tone.frequency.setValueAtTime(freq * 1.5, at)
  tone.frequency.exponentialRampToValueAtTime(freq * 7, at + 0.07)
  tone.frequency.exponentialRampToValueAtTime(freq * 3, at + 0.5)
  env.connect(tone).connect(out)
  const reeds = [-11, 0, 8].map((cents) => {
    const osc = c.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = freq
    osc.detune.value = cents
    osc.connect(env)
    osc.start(at)
    return osc
  })
  ending(c, at + length, (end) => {
    env.gain.setValueAtTime(level, end)
    env.gain.exponentialRampToValueAtTime(0.0001, end + 0.3)
    for (const reed of reeds) reed.stop(end + 0.32)
  })
}

/**
 * The ground shaking: a low roar over `length` seconds, loudest `peak` of the way through (0 to 1),
 * with a boom under it, falling.
 */
export function rumble(delay: number, length: number, level = 0.2, peak = 0.3): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  const top = at + length * peak
  const end = at + length
  const src = c.createBufferSource()
  src.buffer = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * length)), c.sampleRate)
  const data = src.buffer.getChannelData(0)
  // Brown noise: white noise, summed and leaking, all rumble and no hiss.
  let last = 0
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
    data[i] = last * 3.5
  }
  const low = c.createBiquadFilter()
  low.type = 'lowpass'
  low.frequency.value = 150
  const roar = c.createGain()
  roar.gain.setValueAtTime(0.0001, at)
  roar.gain.exponentialRampToValueAtTime(level, top)
  roar.gain.exponentialRampToValueAtTime(0.0001, end)
  src.connect(low).connect(roar).connect(out)
  src.start(at)
  const boom = c.createOscillator()
  boom.frequency.setValueAtTime(72, at)
  boom.frequency.exponentialRampToValueAtTime(30, top + 0.4)
  const thud = c.createGain()
  thud.gain.setValueAtTime(0.0001, at)
  thud.gain.exponentialRampToValueAtTime(level * 0.9, at + 0.05)
  thud.gain.exponentialRampToValueAtTime(0.0001, Math.min(end, top + 1.2))
  boom.connect(thud).connect(out)
  boom.start(at)
  boom.stop(end)
}

/** A gust of fire: noise roaring up through a rising band, from `from` to `to` Hz, and dying down. */
export function whoosh(delay: number, length: number, level = 0.08, from = 220, to = 2400): void {
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
  band.Q.value = 0.9
  band.frequency.setValueAtTime(from, at)
  band.frequency.exponentialRampToValueAtTime(to, at + length * 0.35)
  band.frequency.exponentialRampToValueAtTime(from * 1.5, at + length)
  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, at)
  env.gain.exponentialRampToValueAtTime(level, at + length * 0.3)
  env.gain.exponentialRampToValueAtTime(0.0001, at + length)
  src.connect(band).connect(env).connect(out)
  src.start(at)
}

/** Fire crackling: `count` tiny snaps scattered over `length` seconds. */
export function crackle(delay: number, length: number, count = 14, level = 0.06): void {
  for (let i = 0; i < count; i++)
    noise(delay + Math.random() * length, 0.008 + Math.random() * 0.02, 2500 + Math.random() * 4000, 1.2, level * (0.4 + Math.random() * 0.6))
}

/** Clips (base64), decoded once. */
const clips = new Map<string, Promise<AudioBuffer>>()

/**
 * A recorded clip (base64: Ogg Opus, WAV…), played `delay` seconds from now. `cavern` sends it
 * into a long, deep echo as well (0: none, 1: as loud as the sound).
 */
export function clip(data: string, delay = 0, level = 1, cavern = 0): void {
  const g = graph()
  if (!g) return
  const { c, out } = g
  const at = c.currentTime + delay
  let decoded = clips.get(data)
  if (!decoded) {
    decoded = c.decodeAudioData(Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)).buffer)
    decoded.catch(() => clips.delete(data))
    clips.set(data, decoded)
  }
  void decoded.then(
    (buffer) => {
      if (!allowed || recording) return
      const src = c.createBufferSource()
      src.buffer = buffer
      const gain = c.createGain()
      gain.gain.value = level
      src.connect(gain).connect(out)
      if (cavern) {
        const echo = c.createConvolver()
        echo.buffer = hall(c, 3.4)
        const wet = c.createGain()
        wet.gain.value = cavern
        gain.connect(echo).connect(wet).connect(out)
      }
      src.start(Math.max(at, c.currentTime))
    },
    () => undefined
  )
}
