export const SAMPLE_RATE = 16000

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2)
  }
  return buf
}

/** Decode a PCM16/float32 WAV file to mono float samples at 16 kHz. */
export function decodeWav(buf: Buffer): Float32Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file')
  let offset = 12
  let format = 1
  let channels = 1
  let rate = SAMPLE_RATE
  let bits = 16
  let data: Buffer | null = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size))
    }
    offset = body + size + (size % 2)
  }
  if (!data) throw new Error('WAV file has no data chunk')
  const bytes = bits / 8
  const frames = Math.floor(data.length / (bytes * channels))
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes
      if (format === 3 && bits === 32) sum += data.readFloatLE(p)
      else if (bits === 16) sum += data.readInt16LE(p) / 0x8000
      else if (bits === 24) sum += data.readIntLE(p, 3) / 0x800000
      else if (bits === 32) sum += data.readInt32LE(p) / 0x80000000
      else if (bits === 8) sum += (data.readUInt8(p) - 128) / 128
    }
    mono[i] = sum / channels
  }
  return rate === SAMPLE_RATE ? mono : resample(mono, rate, SAMPLE_RATE)
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    // Box-filter average over the source window (cheap anti-aliasing for downsampling).
    const start = i * ratio
    const end = Math.min(input.length, start + Math.max(1, ratio))
    let sum = 0
    let n = 0
    for (let j = Math.floor(start); j < end; j++) {
      sum += input[j]
      n++
    }
    out[i] = n ? sum / n : 0
  }
  return out
}

export interface PreparedAudio {
  samples: Float32Array
  /** Milliseconds of detected speech. */
  speechMs: number
  durationMs: number
  /** Peak absolute amplitude of the input (0 = digital silence). */
  peak: number
}

const FRAME = 320 // 20 ms

/**
 * Energy-based speech detection: trims leading/trailing silence, shortens very long pauses
 * (which make Whisper hallucinate) and boosts quiet recordings. Deliberately conservative:
 * losing a soft-spoken word is worse than keeping some silence.
 */
export function prepareAudio(input: Float32Array): PreparedAudio {
  const durationMs = (input.length / SAMPLE_RATE) * 1000
  let peak = 0
  for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]))
  const frames = Math.floor(input.length / FRAME)
  if (frames < 5) return { samples: input, speechMs: 0, durationMs, peak }

  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += input[i] * input[i]
    rms[f] = Math.sqrt(sum / FRAME)
  }
  const sorted = Array.from(rms).sort((a, b) => a - b)
  const floor = sorted[Math.floor(frames * 0.1)]
  const loud = sorted[Math.floor(frames * 0.98)]
  // Just above the noise floor, so soft speech in a continuous recording is never dropped.
  const threshold = Math.max(0.002, floor + (loud - floor) * 0.05)

  const speech = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) if (rms[f] > threshold) speech[f] = 1
  // Ignore isolated blips shorter than 60 ms.
  let speechFrames = 0
  for (let f = 0; f < frames;) {
    if (!speech[f]) {
      f++
      continue
    }
    let e = f
    while (e < frames && speech[e]) e++
    if (e - f < 3) speech.fill(0, f, e)
    else speechFrames += e - f
    f = e
  }
  const speechMs = speechFrames * 20
  if (speechFrames === 0) return { samples: new Float32Array(0), speechMs: 0, durationMs, peak }

  const first = speech.indexOf(1)
  const last = speech.lastIndexOf(1)
  const PAD = 20 // keep 400 ms before the first and after the last speech
  const KEEP_PAUSE = 50 // pauses longer than 3 s are shortened to 2 s (1 s on each side)
  const keep: Array<[number, number]> = []
  let f = Math.max(0, first - PAD)
  const end = Math.min(frames, last + PAD + 1)
  while (f < end) {
    if (speech[f]) {
      const s = f
      while (f < end && speech[f]) f++
      keep.push([s, f])
    } else {
      const s = f
      while (f < end && !speech[f]) f++
      const len = f - s
      if (len <= KEEP_PAUSE * 3) keep.push([s, f])
      else {
        keep.push([s, s + KEEP_PAUSE])
        keep.push([f - KEEP_PAUSE, f])
      }
    }
  }
  const total = keep.reduce((n, [a, b]) => n + (b - a) * FRAME, 0)
  const out = new Float32Array(total)
  let o = 0
  for (const [a, b] of keep) {
    out.set(input.subarray(a * FRAME, b * FRAME), o)
    o += (b - a) * FRAME
  }
  // Normalize quiet recordings (cap gain to avoid amplifying noise).
  let max = 0
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]))
  const gain = max > 0 ? Math.min(8, 0.9 / max) : 1
  if (gain > 1.2) for (let i = 0; i < out.length; i++) out[i] *= gain
  return { samples: out, speechMs, durationMs, peak }
}

/** Phrases Whisper is known to hallucinate on silence/noise (mostly from subtitle training data). */
const HALLUCINATIONS = [
  // Exact credit phrasings only ("Sous-titres réalisés par la communauté d'Amara.org", "Sous-titrage ST' 501"…)
  /sous-titr(es|age)( réalisés)?( (par|de))?( la communauté d'| la| l'| :)?\s*(amara\.org|société radio-canada|radio-canada|st'? ?501|soustitreur\.com)\s*[.!?]?/gi,
  /subtitles? by the amara\.org community[.!]?/gi,
  // Only at the very end, where they appear after trailing silence.
  /\b(merci d'avoir regardé( cette vidéo)?|thanks? (you )?for watching|please subscribe[^.!?]*)\s*[.!]?\s*$/gi,
  /\[(musique|music|applaudissements|applause|rires|laughter|silence|blank_audio)\]/gi,
  /\((musique|music|applaudissements|applause|rires|laughter)\)/gi
]

export function cleanTranscript(text: string): string {
  let out = text
  for (const re of HALLUCINATIONS) out = out.replace(re, ' ')
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}
