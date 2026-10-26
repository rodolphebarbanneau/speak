import type { SpeakApi } from '../shared/api'

declare global {
  interface Window {
    speak: SpeakApi
  }
}

export {}
