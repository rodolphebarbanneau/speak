import { useState } from 'react'
import type { BinaryVariant, Config, DeepPartial, EngineId } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, Bar, Check, List, ListRow, Radio, Row, Sep, TextInput } from '../components/ui'
import { ipcError, sizeMB } from '../lib/format'
import { spokenOptions } from '../lib/languages'
import type { TestVerdict } from '../lib/microphone'
import { useDownloads, useEngineStatus } from './hooks'
import { InputSettings } from './input-settings'

const api = window.speak

type Update = (patch: DeepPartial<Config>) => Promise<void>

/** Speech: from your voice to text, for every mode. The microphone, the language you speak, then the engine that recognizes it. */
export function SpeechSettings({ config, update, onVerdict }: { config: Config; update: Update; onVerdict: (verdict: TestVerdict) => void }) {
  return (
    <>
      <section>
        <InputSettings config={config} update={update} onVerdict={onVerdict} />
      </section>

      <section>
        <Sep>language</Sep>
        <Row label="spoken" hint="the language you speak, in every mode · setting it explicitly is more accurate than auto-detect">
          <Dropdown
            value={config.speech.language}
            onChange={(v) => update({ speech: { language: v } })}
            options={spokenOptions(config.speech.engine, config.speech.language)}
          />
        </Row>
        <Row block label="vocabulary" hint="names and technical terms you use, one per line or comma separated · improves recognition and spelling">
          <TextInput
            multiline
            rows={3}
            value={config.speech.vocabulary}
            onCommit={(v) => update({ speech: { vocabulary: v } })}
            placeholder="Claude Code, TypeScript, worktree, T3 Code…"
          />
        </Row>
      </section>

      <Recognition config={config} update={update} />
    </>
  )
}

/** The engine, its model and how it runs: shown once the engine's status is known. */
function Recognition({ config, update }: { config: Config; update: Update }) {
  const [status, refresh] = useEngineStatus()
  const downloads = useDownloads()
  const [variant, setVariant] = useState<BinaryVariant | ''>('')
  const [error, setError] = useState<string | null>(null)
  const t = config.speech

  if (!status) return null

  const chosen = (variant || status.recommendedVariant || status.binaryOptions[0]?.variant) as BinaryVariant | undefined
  const chosenOption = status.binaryOptions.find((o) => o.variant === chosen)
  const binDl = downloads['binary']
  const run = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e: Error) => !/cancel/i.test(e.message) && setError(ipcError(e))).finally(refresh)
  }
  const selectModel = (engine: EngineId, id: string) => update({ speech: { engine, models: { [engine]: id } } })
  const selected = (engine: EngineId) => t.models[engine]

  return (
    <>
      {error && <p className="line error">✗ {error}</p>}

      <section>
        <Sep>engine</Sep>
        <Row label="whisper.cpp" hint={status.binary.dir ?? 'speech recognition runs entirely on this computer, nothing is sent online'}>
          {status.binary.found ? (
            <span>
              <span className="green">installed</span>
              <span className="dim">
                {' '}
                · {status.binary.source}
                {status.binary.variant ? ` · ${status.binary.variant}` : ''}
              </span>
            </span>
          ) : (
            <span className="yellow">not installed</span>
          )}
        </Row>
        <Row label="gpu" hint="used by whisper.cpp when 'use gpu' is on">
          {status.gpu.nvidia ? status.gpu.name : <span className="dim">{status.platform === 'darwin-arm64' ? 'apple metal' : 'none detected'}</span>}
        </Row>
        {status.binaryOptions.length > 0 && (
          <Row
            label="build"
            hint={chosenOption ? `${chosenOption.label.toLowerCase()} · ${sizeMB(chosenOption.sizeMB)} download` : undefined}
            actions={
              binDl ? (
                binDl.state === 'running' && <Action onClick={() => api.cancelDownload('binary')}>cancel</Action>
              ) : (
                <Action onClick={() => chosen && run(api.installBinary(chosen))}>
                  {status.binary.found && status.binary.source === 'managed' ? 'reinstall' : 'install'}
                </Action>
              )
            }
          >
            {binDl ? (
              <Bar value={binDl.received} total={binDl.total} label={binDl.state === 'extracting' ? 'extracting…' : undefined} />
            ) : (
              <Dropdown<BinaryVariant>
                value={chosen!}
                onChange={setVariant}
                options={status.binaryOptions.map((o) => ({
                  value: o.variant,
                  label: `${o.label.toLowerCase()}${o.variant === status.recommendedVariant ? ' · recommended' : ''}`
                }))}
              />
            )}
          </Row>
        )}
        {status.platformNote && <p className="note">{status.platformNote.toLowerCase()}</p>}
        <Row label="custom folder" hint="folder containing whisper-server (and parakeet-cli), e.g. your own build or homebrew's · empty = managed install">
          <TextInput
            value={t.customBinDir}
            onCommit={(v) => run(update({ speech: { customBinDir: v.trim() } }))}
            placeholder={api.platform === 'darwin' ? '/opt/homebrew/bin' : 'managed install'}
          />
        </Row>
      </section>

      <section>
        <Sep>model</Sep>
        <Row label="engine" hint="whisper handles mixed languages and your vocabulary best · parakeet is very fast even without a gpu (25 european languages)">
          <Dropdown<EngineId>
            value={t.engine}
            onChange={(v) => update({ speech: { engine: v } })}
            options={[
              { value: 'whisper', label: 'whisper' },
              ...(status.binary.found && !status.binary.hasParakeet ? [] : [{ value: 'parakeet' as const, label: 'parakeet' }])
            ]}
          />
        </Row>
        <List>
          {status.models
            .filter((m) => m.engine === t.engine)
            .map((m) => {
              const dl = downloads[`model:${m.id}`]
              const on = selected(m.engine) === m.id
              return (
                <ListRow
                  key={m.id}
                  selected={on}
                  hint={m.note?.toLowerCase()}
                  meta={dl ? <Bar value={dl.received} total={dl.total} /> : sizeMB(m.sizeMB)}
                  actions={
                    dl ? (
                      <Action onClick={() => api.cancelDownload(`model:${m.id}`)}>cancel</Action>
                    ) : m.installed ? (
                      <Action danger onClick={() => run(api.deleteModel(m.id))}>
                        delete
                      </Action>
                    ) : (
                      <Action
                        onClick={() => {
                          selectModel(m.engine, m.id)
                          run(api.installModel(m.id))
                        }}
                      >
                        download
                      </Action>
                    )
                  }
                >
                  <button className="choice" role="radio" aria-checked={on} onClick={() => selectModel(m.engine, m.id)}>
                    <Radio on={on} /> {m.label.toLowerCase()}
                    {m.installed && <span className="green"> ✓</span>}
                  </button>
                </ListRow>
              )
            })}
        </List>
      </section>

      <section>
        <Sep>performance</Sep>
        <Row label="use gpu" hint="cuda on nvidia (windows), metal on apple silicon">
          <Check checked={t.useGpu} onChange={(v) => update({ speech: { useGpu: v } })} />
        </Row>
        <Row
          label="voice detection"
          hint={
            status.vadInstalled ? 'skips silences before whisper runs: fewer hallucinations, faster' : 'the vad model downloads with the first whisper model'
          }
        >
          <Check checked={t.vad} onChange={(v) => update({ speech: { vad: v } })} />
        </Row>
        <Row label="keep loaded" hint="keeps whisper in memory between dictations for instant results">
          <Dropdown
            value={String(t.keepLoadedMinutes)}
            onChange={(v) => update({ speech: { keepLoadedMinutes: Number(v) } })}
            options={[
              { value: '5', label: '5 min' },
              { value: '30', label: '30 min' },
              { value: '120', label: '2 hours' },
              { value: '0', label: 'always' }
            ]}
          />
        </Row>
        <Row label="cpu threads" hint="0 = automatic">
          <TextInput
            type="number"
            width="8ch"
            value={String(t.threads)}
            onCommit={(v) => update({ speech: { threads: Math.max(0, Math.min(64, Number(v) || 0)) } })}
          />
        </Row>
      </section>
    </>
  )
}
