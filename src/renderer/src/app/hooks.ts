import { useCallback, useEffect, useState } from 'react'
import type { Config, DeepPartial, DownloadProgress, EngineStatus } from '@shared/types'

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
