/** Microphone capture in the overlay renderer: Web Audio → Float32 PCM → 16 kHz mono. */
import { cleanLabel, meterLevel, openMicrophone, resolveDeviceId, SILENT_PEAK } from '../lib/microphone'

/** Silence put where a recording was paused, in seconds. */
const PAUSE_GAP_S = 0.3

/**
 * Collects the microphone's samples. Messages: 'flush' hands over what's buffered, 'pause' drops
 * the input until 'resume', which first adds a short silence so the words on either side stay apart.
 */
const WORKLET = `
class SpeakCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(2048)
    this.n = 0
    this.paused = false
    this.port.onmessage = (e) => {
      if (e.data === 'pause') this.paused = true
      else if (e.data === 'resume') {
        if (this.paused) for (let i = 0; i < sampleRate * ${PAUSE_GAP_S}; i++) this.push(0)
        this.paused = false
      } else {
        this.port.postMessage({ flush: true, data: this.buf.slice(0, this.n) })
        this.n = 0
      }
    }
  }
  push(sample) {
    this.buf[this.n++] = sample
    if (this.n === this.buf.length) {
      this.port.postMessage({ data: this.buf })
      this.buf = new Float32Array(2048)
      this.n = 0
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && !this.paused) for (let i = 0; i < ch.length; i++) this.push(ch[i])
    return true
  }
}
registerProcessor('speak-capture', SpeakCapture)
`

const TARGET_RATE = 16000

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let node: AudioWorkletNode | null = null
let chunks: Float32Array[] = []
let onLevel: ((level: number) => void) | null = null
let flushResolve: (() => void) | null = null
/** Counts the starts, stops and cancels: a start that finishes after a later order closes what it opened. */
let generation = 0
/** Until then, what the microphone hears is the start cue, not the user's words: dropped. */
let skipUntil = 0

/** A start overtaken by a stop or a cancel while the microphone opened: nothing to report. */
export class Superseded extends Error {
  constructor() {
    super('Superseded by a later order')
  }
}

export function setLevelListener(cb: ((level: number) => void) | null): void {
  onLevel = cb
}

/** How long to listen before concluding the input is digital silence. */
const NO_SIGNAL_AFTER_MS = 1500

/**
 * Start recording. Returns the label of the microphone actually opened; `onNoSignal` fires
 * once if that microphone delivers only digital silence (muted, or an idle virtual device), and
 * `onLost` if it stops during the recording (unplugged, its Bluetooth link dropped).
 */
export async function startCapture(
  deviceId: string,
  deviceLabel: string,
  onNoSignal: (device: string) => void,
  onLost: (device: string) => void
): Promise<string> {
  const mine = ++generation
  skipUntil = 0
  await stopTracks()
  chunks = []
  const opened = await openMicrophone(await resolveDeviceId(deviceId, deviceLabel))
  if (mine !== generation) {
    opened.getTracks().forEach((t) => t.stop())
    throw new Superseded()
  }
  stream = opened
  const device = cleanLabel(stream.getAudioTracks()[0]?.label || 'microphone')
  // Our own stop ends the track too, but without this event: 'ended' is the device going away.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (mine === generation) onLost(device)
  })
  ctx = new AudioContext()
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  if (mine !== generation) {
    await stopTracks()
    throw new Superseded()
  }
  const source = ctx.createMediaStreamSource(stream)
  node = new AudioWorkletNode(ctx, 'speak-capture')
  const startedAt = performance.now()
  let peak = 0
  let checked = false
  node.port.onmessage = (e: MessageEvent<{ data: Float32Array; flush?: boolean }>) => {
    const data = e.data.data
    if (data.length && performance.now() >= skipUntil) {
      chunks.push(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i]
        peak = Math.max(peak, Math.abs(data[i]))
      }
      onLevel?.(meterLevel(Math.sqrt(sum / data.length)))
    }
    if (!checked && performance.now() - startedAt > NO_SIGNAL_AFTER_MS) {
      checked = true
      if (peak < SILENT_PEAK) onNoSignal(device)
    }
    if (e.data.flush) flushResolve?.()
  }
  // The graph must reach the destination to be processed; keep it silent.
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(node)
  node.connect(mute).connect(ctx.destination)
  return device
}

/** The start cue plays (`ms` long) on an open microphone: what it hears meanwhile is left out. */
export function skipCue(ms: number): void {
  skipUntil = performance.now() + ms
}

/** Pause or resume: the microphone stays open, its audio is dropped meanwhile. */
export function pauseCapture(paused: boolean): void {
  node?.port.postMessage(paused ? 'pause' : 'resume')
}

async function stopTracks(): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  node?.disconnect()
  node = null
  if (ctx && ctx.state !== 'closed') await ctx.close()
  ctx = null
}

/** Stop recording and return 16 kHz mono samples. */
export async function stopCapture(): Promise<Float32Array> {
  generation++
  if (!ctx || !node) throw new Error('The microphone was not open')
  const rate = ctx.sampleRate
  await new Promise<void>((resolve) => {
    flushResolve = resolve
    node!.port.postMessage('flush')
    setTimeout(resolve, 500)
  })
  flushResolve = null
  await stopTracks()
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const pcm = new Float32Array(total)
  let o = 0
  for (const c of chunks) {
    pcm.set(c, o)
    o += c.length
  }
  chunks = []
  return resample(pcm, rate)
}

export async function cancelCapture(): Promise<void> {
  generation++
  chunks = []
  await stopTracks()
}

async function resample(pcm: Float32Array, rate: number): Promise<Float32Array> {
  if (rate === TARGET_RATE || pcm.length === 0) return pcm
  const length = Math.ceil((pcm.length * TARGET_RATE) / rate)
  const offline = new OfflineAudioContext(1, length, TARGET_RATE)
  const buffer = offline.createBuffer(1, pcm.length, rate)
  buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

let soundCtx: AudioContext | null = null
let soundRest = 0

/** Short UI cues synthesized with Web Audio. Returns how long the cue lasts, in ms. */
export function playSound(name: 'start' | 'stop' | 'error' | 'done'): number {
  soundCtx ??= new AudioContext()
  const c = soundCtx
  if (c.state === 'suspended') void c.resume()
  // Asleep once the notes are over: a sound player left running keeps the audio device and a thread busy.
  clearTimeout(soundRest)
  soundRest = window.setTimeout(() => void c.suspend(), 1000)
  const notes: Record<typeof name, number[]> = { start: [660, 880], stop: [880, 660], done: [784, 1046], error: [330, 247] }
  notes[name].forEach((freq, i) => {
    const osc = c.createOscillator()
    const gain = c.createGain()
    const t = c.currentTime + i * 0.09
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.12, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    osc.connect(gain).connect(c.destination)
    osc.start(t)
    osc.stop(t + 0.13)
  })
  return (notes[name].length - 1) * 90 + 130
}
