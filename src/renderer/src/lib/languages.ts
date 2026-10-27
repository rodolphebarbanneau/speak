import { LANGUAGES, languageName, spokenLanguages } from '@shared/constants'
import type { EngineId } from '@shared/types'

const option = (l: { code: string; name: string }) => ({ value: l.code, label: l.name.toLowerCase() })

/** Output language choices for a dropdown. */
export const outputOptions = [{ value: 'same', label: 'as spoken' }, ...LANGUAGES.map(option)]

/**
 * Spoken language choices for a dropdown: those the engine knows, plus `current` if it isn't one
 * of them. `detected` is what auto-detect heard, shown on its choice.
 */
export function spokenOptions(engine: EngineId, current: string, detected?: string): Array<{ value: string; label: string }> {
  const known = spokenLanguages(engine)
  const kept = known.some((l) => l.code === current) ? [] : LANGUAGES.filter((l) => l.code === current)
  const auto = detected ? `auto (${languageName(detected).toLowerCase()})` : 'auto-detect'
  return [{ value: 'auto', label: auto }, ...[...known, ...kept].map(option)]
}
