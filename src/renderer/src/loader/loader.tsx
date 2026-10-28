import { useEffect, useState } from 'react'
import type { LoadingState } from '@shared/types'
import { Blocks, percent } from '../components/ui'

const api = window.speak
const CELLS = 36

/**
 * The loading dialog: what is happening, a progress bar, the step in progress under it, and the
 * overall status (step 2 of 4, and what happens next).
 */
export function Loader() {
  const [state, setState] = useState<LoadingState | null>(null)
  useEffect(() => {
    const off = api.onLoading(setState)
    api.loaderReady()
    return off
  }, [])
  if (!state) return null
  const finished = state.done >= state.total
  const ratio = state.total ? state.done / state.total : 0
  return (
    <div className="loader">
      <div className="title">
        <b>speak</b> · {state.title}
      </div>
      <div className="progress">
        <Blocks cells={CELLS} filled={ratio * CELLS} />
        <span className="dim">{percent(ratio)}</span>
      </div>
      <div className="step">{finished ? state.item : `${state.item}…`}</div>
      <div className="status">
        {finished ? 'done' : `${state.done + 1} of ${state.total}`}
        {state.note && ` · ${state.note}`}
      </div>
    </div>
  )
}
