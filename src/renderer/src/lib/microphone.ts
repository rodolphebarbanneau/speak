/** Microphone helpers shared by the recorder (overlay) and the input test (settings). */

export interface Microphone {
  id: string
  label: string
}

/** Real microphones always have a noise floor; below this the input is digital silence. */
export const SILENT_PEAK = 1e-4
/** Below this peak, speech is too quiet to transcribe reliably. */
export const QUIET_PEAK = 0.02

/** Drop USB vendor/product ids: "Microphone (Yeti Classic) (b58e:9e84)" → "Microphone (Yeti Classic)". */
export function cleanLabel(label: string): string {
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()
}

/**
 * Audio inputs, plus the device "default" currently resolves to. Labels are only exposed
 * once microphone access was granted, so ask for it if they're missing.
 */
export async function listMicrophones(): Promise<{ defaultLabel: string; devices: Microphone[] }> {
  let inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  if (inputs.length && inputs.every((d) => !d.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach((t) => t.stop())
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  }
  const def = inputs.find((d) => d.deviceId === 'default')
  return {
    defaultLabel: cleanLabel((def?.label ?? '').replace(/^Default\s*-\s*/i, '')),
    devices: inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: cleanLabel(d.label) }))
  }
}

/**
 * Device ids are per-origin (dev server vs packaged app), so fall back to the label.
 * Returns undefined for the system default.
 */
export async function resolveDeviceId(id: string, label: string): Promise<string | undefined> {
  if (!id || id === 'default') return undefined
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  return inputs.find((d) => d.deviceId === id)?.deviceId ?? inputs.find((d) => label && cleanLabel(d.label) === label)?.deviceId
}

export function openMicrophone(deviceId: string | undefined): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
}

/** Amplitude (RMS or peak) → 0..1 on a -60..0 dBFS scale, like a mixer meter. */
export function meterLevel(rms: number): number {
  if (rms <= 0) return 0
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60))
}

export function microphoneError(err: unknown): string {
  const e = err as DOMException
  if (e?.name === 'NotAllowedError') return 'Microphone access denied.'
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'Microphone not found.'
  if (e?.name === 'NotReadableError') return 'Microphone is in use or unavailable.'
  return `Microphone error: ${e?.message ?? String(err)}`
}

export type TestVerdict = 'silent' | 'quiet' | 'ok'

export interface MicrophoneTest {
  /** Stop and return the recording (for playback) with a verdict on the signal. */
  stop(): Promise<{ verdict: TestVerdict; peak: number; recording: Blob | null }>
}

/** Live input test: reports levels while recording a clip that can be played back. */
export async function startMicrophoneTest(deviceId: string | undefined, onLevel: (level: number, peak: number) => void): Promise<MicrophoneTest> {
  const stream = await openMicrophone(deviceId)
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  ctx.createMediaStreamSource(stream).connect(analyser)
  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  recorder.start()

  let peak = 0
  const buf = new Float32Array(analyser.fftSize)
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) {
      sum += v * v
      peak = Math.max(peak, Math.abs(v))
    }
    onLevel(meterLevel(Math.sqrt(sum / buf.length)), peak)
  }, 50)

  return {
    async stop() {
      clearInterval(timer)
      const stopped = new Promise<void>((r) => (recorder.onstop = () => r()))
      recorder.stop()
      await stopped
      stream.getTracks().forEach((t) => t.stop())
      await ctx.close()
      const verdict: TestVerdict = peak < SILENT_PEAK ? 'silent' : peak < QUIET_PEAK ? 'quiet' : 'ok'
      return { verdict, peak, recording: chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null }
    }
  }
}
