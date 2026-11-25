import type { EngineId } from '../../shared/types'
import { PROBE } from './catalog'

/**
 * Which speech model suits a computer that transcribes on its processor (no CUDA, no Metal: an
 * Intel Mac, a PC without an NVIDIA card).
 *
 * The model Speak recommends, large-v3-turbo, is made for a GPU. On a processor it took 41 s for
 * 11 s of speech (an 8-core desktop of 2018, at work on other things, 4 threads, whisper.cpp
 * b5454's CPU build): four times slower than talking. The same clip, there: tiny 1.3 s, base
 * 2.4 s, Parakeet 3.9 s (it loads at each dictation), small 9 s, medium 27 s.
 *
 * Those times keep about the same proportions from one processor to another, so the speed test
 * (engine.fit) times the smallest model only, a 32 MB download, and works out the others from it.
 */

/** How many times longer than the probe each candidate takes. */
const COST = { turbo: 32, small: 7, parakeet: 3, base: 2 }

const MODELS = {
  turbo: { engine: 'whisper', model: 'large-v3-turbo-q8_0' },
  small: { engine: 'whisper', model: 'small' },
  parakeet: { engine: 'parakeet', model: 'parakeet-tdt-0.6b-v3-q8_0' },
  base: { engine: 'whisper', model: 'base-q5_1' }
} satisfies Record<keyof typeof COST, { engine: EngineId; model: string }>

export interface Fit {
  engine: EngineId
  model: string
  /** How long it should take for ten seconds of speech. */
  seconds: number
}

/**
 * The model for a computer that took `probeMs` for the test. The recommended one when it stays
 * comfortably ahead of the voice (half the time spoken): a fast processor may. Else Parakeet, as
 * accurate as it for the 25 languages it knows and far lighter (`parakeetSpeaks`: the user's is
 * one of them), or Whisper small for the other languages. And when even those would take longer
 * than the speech itself: Whisper base.
 */
export function fitModel(probeMs: number, parakeetSpeaks: boolean): Fit {
  const spoken = PROBE.sample.seconds
  const takes = (k: keyof typeof COST) => (COST[k] * probeMs) / 1000
  const kind: keyof typeof COST =
    takes('turbo') <= spoken / 2 ? 'turbo' : parakeetSpeaks ? (takes('parakeet') <= spoken ? 'parakeet' : 'base') : takes('small') <= spoken ? 'small' : 'base'
  return { ...MODELS[kind], seconds: Math.round(((takes(kind) * 10) / spoken) * 10) / 10 }
}
