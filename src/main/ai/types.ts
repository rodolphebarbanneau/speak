export interface Completion {
  text: string
  model: string
}

export interface CompleteOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** A folder the AI may read, read-only, as its working directory (compose with a context). Without it, text only. */
  readDir?: string
}
