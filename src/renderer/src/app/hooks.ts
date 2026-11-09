import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentId, AgentStatus, Config, DeepPartial, DownloadProgress, EngineStatus } from '@shared/types'
import { ipcError } from '../lib/format'

const api = window.speak

export function useConfig(): [Config | null, (patch: DeepPartial<Config>) => Promise<void>] {
  const [config, setConfig] = useState<Config | null>(null)
  useEffect(() => {
    void api.getConfig().then(setConfig)
    return api.onConfig(setConfig)
  }, [])
  const update = useCallback(async (patch: DeepPartial<Config>) => {
    setConfig(await api.setConfig(patch))
  }, [])
  return [config, update]
}

export function useDownloads(): Record<string, DownloadProgress> {
  const [map, setMap] = useState<Record<string, DownloadProgress>>({})
  useEffect(
    () =>
      api.onDownload((p) =>
        setMap((m) => {
          const next = { ...m, [p.id]: p }
          if (p.state === 'done' || p.state === 'cancelled') delete next[p.id]
          return next
        })
      ),
    []
  )
  return map
}

export function useEngineStatus(): [EngineStatus | null, () => void] {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const refresh = useCallback(() => void api.getEngineStatus().then(setStatus), [])
  useEffect(() => {
    refresh()
    return api.onDownload((p) => {
      if (p.state === 'done' || p.state === 'error') refresh()
    })
  }, [refresh])
  return [status, refresh]
}

/**
 * Speech recognition as setup shows it: whisper.cpp and the selected model, one step, downloaded
 * together (installModel fetches the engine too when it's missing).
 */
export function useSpeechSetup(config: Config) {
  const [engine, refresh] = useEngineStatus()
  const downloads = useDownloads()
  const [error, setError] = useState<string | null>(null)
  const modelId = config.speech.models[config.speech.engine]
  const model = engine?.models.find((m) => m.id === modelId)
  const engineOk = !!engine?.binary.found
  const build = engine?.binaryOptions.find((o) => o.variant === engine.recommendedVariant)
  const ids = ['binary', 'model:vad', `model:${modelId}`]
  const pending = ids.map((id) => downloads[id]).filter((d) => d && d.state !== 'error')
  const install = () => {
    setError(null)
    api
      .installModel(modelId)
      .catch((e: Error) => !/cancel/i.test(e.message) && setError(ipcError(e)))
      .finally(refresh)
  }
  return {
    engine,
    model,
    build,
    engineOk,
    ready: engineOk && !!model?.installed,
    /** Without a downloadable engine build (e.g. macOS dev runs), settings → speech explains the options. */
    canInstall: engineOk || !!build,
    downloading: pending.length > 0,
    received: pending.reduce((n, d) => n + d.received, 0),
    total: pending.reduce((n, d) => n + d.total, 0),
    extracting: pending.some((d) => d.state === 'extracting'),
    /** What's left to download, in MB. */
    installSize: (engineOk ? 0 : (build?.sizeMB ?? 0)) + (model?.installed ? 0 : (model?.sizeMB ?? 0)),
    install,
    cancel: () => pending.forEach((d) => api.cancelDownload(d.id)),
    error
  }
}

/** Found and signed in: ready to clean up dictations. */
export const agentReady = (s: AgentStatus | null | undefined): boolean => !!s?.found && !!s.loggedIn

/** How often to look again while waiting for an install or a sign-in, and for how long after one starts. */
const WATCH_EVERY_MS = 3000
const WATCH_FOR_MS = 5 * 60_000

/**
 * A coding-agent CLI's status (`key`: its configured paths, to check again when they change).
 * Installing and signing in happen outside Speak, in a browser or a terminal: for a few minutes
 * after `poll` turns on or `watch()`, it looks again every few seconds (while the window shows)
 * and whenever the window gets the focus back, until the CLI is found and signed in. Each look
 * runs the CLI twice: it stops after those minutes, and `refresh()` looks once more.
 */
export function useAgentStatus(id: AgentId, { key = '', poll = false }: { key?: string; poll?: boolean } = {}) {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  /** The last look failed (not the CLI: asking Speak for its status). */
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [watchUntil, setWatchUntil] = useState(0)
  /** The latest check: only its answer counts. */
  const latest = useRef(0)
  const inFlight = useRef(0)

  /** `tick`: a repeat look, skipped while another check is still running (a status can take seconds). */
  const check = useCallback(
    async (force: boolean, tick = false) => {
      if (tick && inFlight.current) return
      const n = ++latest.current
      inFlight.current++
      setChecking(true)
      try {
        const s = await api.getAgentStatus(id, force)
        if (n === latest.current) {
          setStatus(s)
          setError(null)
        }
      } catch (e) {
        // The last status stays, if there's one: the next look may get another.
        if (n === latest.current) setError(`couldn't check: ${ipcError(e as Error)}`)
      } finally {
        if (--inFlight.current === 0) setChecking(false)
      }
    },
    [id]
  )

  useEffect(() => void check(false), [check, key])

  // Turned off, the look goes on to its end: an install or a sign-in may be under way.
  useEffect(() => {
    if (poll) setWatchUntil(Date.now() + WATCH_FOR_MS)
  }, [poll])

  const watching = watchUntil > 0 && !agentReady(status)
  useEffect(() => {
    if (!watching) return
    const tick = () => {
      if (Date.now() > watchUntil) setWatchUntil(0)
      else if (!document.hidden) void check(true, true)
    }
    const timer = setInterval(tick, WATCH_EVERY_MS)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', tick)
    }
  }, [watching, watchUntil, check])

  return {
    status,
    error,
    checking,
    /** Looking again every few seconds, for the install or the sign-in. */
    watching,
    refresh: () => void check(true),
    watch: () => setWatchUntil(Date.now() + WATCH_FOR_MS)
  }
}
