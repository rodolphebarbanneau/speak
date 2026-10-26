/** Microphone capture in the overlay renderer: Web Audio → Float32 PCM → 16 kHz mono. */
import { cleanLabel, meterLevel, openMicrophone, resolveDeviceId, SILENT_PEAK } from '../lib/microphone'

const WORKLET = `
class SpeakCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(2048)
    this.n = 0
    this.port.onmessage = () => {
      this.port.postMessage({ flush: true, data: this.buf.slice(0, this.n) })
      this.n = 0
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) {
          this.port.postMessage({ data: this.buf })
          this.buf = new Float32Array(2048)
          this.n = 0
        }
      }
    }
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

export function setLevelListener(cb: ((level: number) => void) | null): void {
  onLevel = cb
}

/** How long to listen before concluding the input is digital silence. */
const NO_SIGNAL_AFTER_MS = 1500

/**
 * Start recording. Returns the label of the microphone actually opened; `onNoSignal` fires
 * once if that microphone delivers only digital silence (muted, or an idle virtual device).
 */
export async function startCapture(deviceId: string, deviceLabel: string, onNoSignal: (device: string) => void): Promise<string> {
  await stopTracks()
  chunks = []
  stream = await openMicrophone(await resolveDeviceId(deviceId, deviceLabel))
  const device = cleanLabel(stream.getAudioTracks()[0]?.label || 'microphone')
  ctx = new AudioContext()
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  const source = ctx.createMediaStreamSource(stream)
  node = new AudioWorkletNode(ctx, 'speak-capture')
  const startedAt = performance.now()
  let peak = 0
  let checked = false
  node.port.onmessage = (e: MessageEvent<{ data: Float32Array; flush?: boolean }>) => {
    const data = e.data.data
    if (data.length) {
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
  if (!ctx || !node) throw new Error('Not recording')
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

/** Short UI cues synthesized with Web Audio. */
export function playSound(name: 'start' | 'stop' | 'error' | 'done'): void {
  soundCtx ??= new AudioContext()
  const c = soundCtx
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
}
