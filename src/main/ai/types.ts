export interface Completion {
  text: string
  model: string
}

export interface CompleteOptions {
  /** The model: the mode's, as the settings pick it (modelFor). */
  model: string
  timeoutMs: number
  signal?: AbortSignal
  /** A folder the AI may read, read-only, as its working directory (compose with a context). Without it, text only. */
  readDir?: string
}
