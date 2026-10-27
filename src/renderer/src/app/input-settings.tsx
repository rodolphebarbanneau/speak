import { useCallback, useEffect, useRef, useState } from 'react'
import type { Config, DeepPartial } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, Blocks, Row, Sep } from '../components/ui'
import {
  listMicrophones,
  meterLevel,
  microphoneError,
  resolveDeviceId,
  startMicrophoneTest,
  type Microphone,
  type MicrophoneTest,
  type TestVerdict
} from '../lib/microphone'

const api = window.speak
const TEST_SECONDS = 10
const METER_CELLS = 28

interface Props {
  config: Config
  update: (patch: DeepPartial<Config>) => Promise<void>
  onVerdict: (verdict: TestVerdict) => void
}

/** Live input meter: ██████████░░░░░░ with the loudest point marked. */
function Meter({ level, peak }: { level: number; peak: number }) {
  const filled = Math.round(level * METER_CELLS)
  const mark = Math.min(METER_CELLS - 1, Math.round(peak * METER_CELLS))
  return <Blocks cells={METER_CELLS} filled={filled} mark={mark} alert={level > 0.9} />
}

/** Input device picker with a Discord-style test: live meter, verdict, playback. */
export function InputSettings({ config, update, onVerdict }: Props) {
  const [mics, setMics] = useState<{ defaultLabel: string; devices: Microphone[] } | null>(null)
  const [selected, setSelected] = useState('default')
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [peak, setPeak] = useState(0)
  const [result, setResult] = useState<{ verdict: TestVerdict; device: string; url: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const test = useRef<MicrophoneTest | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playback = useRef<HTMLAudioElement | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await listMicrophones()
      setMics(list)
      setSelected((await resolveDeviceId(config.audio.deviceId, config.audio.deviceLabel)) ?? 'default')
    } catch (err) {
      setError(microphoneError(err))
    }
  }, [config.audio.deviceId, config.audio.deviceLabel])

  useEffect(() => {
    void load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [load])

  const labelOf = (id: string) =>
    id === 'default' ? `default · ${mics?.defaultLabel ?? ''}` : (mics?.devices.find((d) => d.id === id)?.label ?? config.audio.deviceLabel)

  const stop = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    const t = test.current
    test.current = null
    setTesting(false)
    setLevel(0)
    if (!t) return
    const r = await t.stop()
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url)
      return {
        verdict: r.verdict,
        device: selected === 'default' ? (mics?.defaultLabel ?? 'default') : labelOf(selected),
        url: r.recording && r.verdict !== 'silent' ? URL.createObjectURL(r.recording) : null
      }
    })
    onVerdict(r.verdict)
  }, [selected, mics]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setError(null)
    setResult(null)
    setPeak(0)
    playback.current?.pause()
    try {
      test.current = await startMicrophoneTest(selected === 'default' ? undefined : selected, (l, p) => {
        setLevel(l)
        setPeak(p)
      })
      setTesting(true)
      timer.current = setTimeout(() => void stop(), TEST_SECONDS * 1000)
    } catch (err) {
      setError(microphoneError(err))
    }
  }

  // Never leave the microphone open when leaving the page.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      void test.current?.stop()
    },
    []
  )

  const choose = (id: string) => {
    if (testing) void stop()
    setResult(null)
    setSelected(id)
    void update({ audio: { deviceId: id, deviceLabel: id === 'default' ? '' : labelOf(id) } })
  }

  const options = [
    { value: 'default', label: `default · ${(mics?.defaultLabel || 'system').toLowerCase()}` },
    ...(mics?.devices ?? []).map((d) => ({ value: d.id, label: d.label.toLowerCase() }))
  ]

  const play = () => {
    if (!result?.url) return
    playback.current?.pause()
    playback.current = new Audio(result.url)
    void playback.current.play()
  }

  return (
    <>
      <Sep tail={api.platform !== 'linux' && <Action onClick={() => api.openSoundSettings()}>system sound settings</Action>}>input</Sep>
      <Row label="device" hint="the microphone speak records from · 'default' follows your system setting">
        <Dropdown value={selected} onChange={choose} options={options} disabled={!mics} />
      </Row>
      <Row
        label="test"
        hint={`speak for a few seconds: the meter should move · you can play the recording back (stops after ${TEST_SECONDS}s)`}
        actions={
          testing ? (
            <Action onClick={() => void stop()}>stop</Action>
          ) : (
            <>
              {result?.url && <Action onClick={play}>play back</Action>}
              <Action onClick={() => void start()}>{result ? 'test again' : 'test'}</Action>
            </>
          )
        }
      >
        {testing ? (
          <Meter level={level} peak={meterLevel(peak)} />
        ) : result?.verdict === 'ok' ? (
          <span className="green">✓ signal ok</span>
        ) : result?.verdict === 'quiet' ? (
          <span className="yellow">! very quiet</span>
        ) : result?.verdict === 'silent' ? (
          <span className="red">✗ no signal</span>
        ) : (
          <span className="dim">check that speak hears you</span>
        )}
      </Row>
      {error && <p className="under error">✗ {error}</p>}
      {result?.verdict === 'quiet' && <p className="under dim">speak closer, or raise this input's level in your system sound settings.</p>}
      {result?.verdict === 'silent' && (
        <p className="under dim">
          "{result.device.toLowerCase()}" sends silence: it's muted, or a virtual device (voicemod, voicemeeter…) that isn't routing audio. pick another device
          above.
        </p>
      )}
    </>
  )
}
