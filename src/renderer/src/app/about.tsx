import { useEffect, useState } from 'react'
import type { AppInfo, Config, DeepPartial, UpdateState } from '@shared/types'
import { Action, Bar, Check, percent, Row, Sep, Spinner } from '../components/ui'

const api = window.speak

const pad = (n: number) => String(n).padStart(2, '0')
const time = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Version status line and the matching action, for the updates section. */
function UpdateStatus({ state }: { state: UpdateState }) {
  switch (state.status) {
    case 'disabled':
      return <span className="dim">updates are off in development builds</span>
    case 'checking':
      return (
        <span>
          <Spinner /> <span className="dim">checking…</span>
        </span>
      )
    case 'latest':
      return (
        <span>
          <span className="green">up to date</span>
          {state.checkedAt && <span className="dim"> · checked {time(state.checkedAt)}</span>}
        </span>
      )
    case 'available':
      return <span className="acc">{state.latest} available</span>
    case 'downloading':
      return <Bar value={state.percent ?? 0} total={100} label={`downloading ${state.latest ?? ''} · ${percent((state.percent ?? 0) / 100)}`} />
    case 'downloaded':
      return <span className="green">{state.latest} ready to install</span>
    case 'error':
      return <span className="red">✗ {state.error}</span>
    default:
      return <span className="dim">not checked yet</span>
  }
}

export function About({ config, update }: { config: Config; update: (patch: DeepPartial<Config>) => Promise<void> }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => void api.getInfo().then(setInfo), [])
  useEffect(() => {
    void api.getUpdateState().then(setState)
    return api.onUpdate(setState)
  }, [])

  const updateAction =
    state?.status === 'available' ? (
      <Action onClick={() => api.downloadUpdate()}>download</Action>
    ) : state?.status === 'downloaded' ? (
      <Action onClick={() => api.installUpdate()}>restart & update</Action>
    ) : state?.status === 'error' ? (
      <Action onClick={() => api.openReleases()}>releases</Action>
    ) : null

  return (
    <>
      <section>
        <Sep>speak</Sep>
        <Row label="version">{info?.version}</Row>
        <Row label="platform">{info?.platform}</Row>
        <Row
          label="data"
          hint="settings, history, models and logs · override with the SPEAK_HOME environment variable"
          actions={<Action onClick={() => api.openDataDir()}>open</Action>}
        >
          <span className="dim">{info?.dataDir}</span>
        </Row>
      </section>

      <section>
        <Sep
          tail={
            state &&
            state.status !== 'disabled' && (
              <Action onClick={() => api.checkForUpdates()} disabled={['checking', 'downloading', 'downloaded'].includes(state.status)}>
                check now
              </Action>
            )
          }
        >
          updates
        </Sep>
        <Row label="status" hint="new versions come from the github releases of speak" actions={updateAction}>
          {state && <UpdateStatus state={state} />}
        </Row>
        <Row label="automatic" hint="download updates in the background and install them when speak quits">
          <Check checked={config.updates.auto} onChange={(v) => update({ updates: { auto: v } })} />
        </Row>
      </section>

      <section>
        <Sep>context</Sep>
        <Row label="dictation">
          <span className="dim">spells names as the project does · adds nothing</span>
        </Row>
        <Row label="compose">
          <span className="dim">reads the folder's files when it needs them</span>
        </Row>
        <Row label="clipboard">
          <span className="dim">one dictation only · pick it on the pill</span>
        </Row>
        <Row label="read-only">
          <span className="dim">dictate and compose never change anything · repositories and pages are copied to ~/.speak/context</span>
        </Row>
      </section>

      <section>
        <Sep>control</Sep>
        <Row label="scope">
          <span className="dim">an app, the screen or everything · speak refuses anything beyond it</span>
        </Row>
        <Row label="approvals">
          <span className="dim">answer by voice or in the panel: yes, always, no, or say what to do instead</span>
        </Row>
        <Row label="your hands">
          <span className="dim">it works in the background when it can · what needs your mouse or keyboard waits until you pause, then gives them back</span>
        </Row>
        <Row label="undo">
          <span className="dim">files it moves, writes or trashes · its trash is ~/.speak/control</span>
        </Row>
        <Row label="privacy">
          <span className="dim">what it looks at goes to your ai provider: an app scope sends one app</span>
        </Row>
      </section>

      <section>
        <Sep>command line</Sep>
        <Row label="--toggle">
          <span className="dim">start / stop dictation · bind it to a desktop shortcut on wayland</span>
        </Row>
        <Row label="--compose">
          <span className="dim">start / stop a compose dictation</span>
        </Row>
        <Row label="--control">
          <span className="dim">start control, or talk to the session under way</span>
        </Row>
        <Row label="--cancel">
          <span className="dim">cancel the current dictation</span>
        </Row>
        <Row label="--show">
          <span className="dim">open this window</span>
        </Row>
        <Row label="--file=x.wav">
          <span className="dim">process an audio file as if dictated</span>
        </Row>
      </section>
    </>
  )
}
