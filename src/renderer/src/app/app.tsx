import { useEffect, useRef, useState } from 'react'
import { modesOn } from '@shared/constants'
import type { MainSection } from '@shared/types'
import { AppName } from '@themes/components'
import { Canvas, cellSize, Pixels } from '@themes/pixels'
import { displayShortcut, HelpProvider, Key, TitleBar, useWindowFocus } from '../components/ui'
import { BugReportDialog } from './bug-report'
import { History } from './history'
import { useConfig } from './hooks'
import { isSettings, SETTINGS, SettingsDialog, type SettingsSection } from './settings'
import { SetupDialog } from './setup'

const api = window.speak

/** A beetle in the font's pixels, for "report a bug". */
const BUG = ['.x.....x.', '..x...x..', '...xxx...', 'x.xxxxx.x', '.xxx.xxx.', 'x.xxxxx.x', '.xxx.xxx.', 'x..xxx..x']
/** A cog, for settings: finer pixels, drawn as tall as the beetle. */
const GEAR = ['....xx....', '.xx.xx.xx.', '.xxxxxxxx.', '..xx..xx..', 'xxx....xxx', 'xxx....xxx', '..xx..xx..', '.xxxxxxxx.', '.xx.xx.xx.', '....xx....']

/** A title-row icon, as tall as the beetle (whose pixels stay whole device pixels), colored by the button. */
function PixelIcon({ rows }: { rows: string[] }) {
  return (
    <Canvas cols={rows[0].length} rows={rows.length} cell={(cellSize(1.5) * BUG.length) / rows.length} className="pixel-icon">
      <Pixels rows={rows} />
    </Canvas>
  )
}

/**
 * The window shows history; settings and the bug report open over it, in dialogs, from the title
 * bar's gear and bug (or the tray), and close back to it. Settings can open over the bug report, to
 * check something while writing it. The guided setup opens over history by itself on the first
 * launch (until it's finished or skipped, and while nothing was dictated yet); settings and the bug
 * report open over it. The title row names what's in front.
 */
export function App() {
  useWindowFocus()
  const [bug, setBug] = useState(false)
  const [setup, setSetup] = useState(false)
  /** Both open: the one opened last is in front (the other waits behind, as it was). */
  const [setupInFront, setSetupInFront] = useState(true)
  const [settings, setSettings] = useState<SettingsSection | null>(null)
  const [lastSettings, setLastSettings] = useState<SettingsSection>('general')
  /** What was on screen when "report a bug" opened: the report says which screen. */
  const [bugScreen, setBugScreen] = useState('history')
  const [config, update] = useConfig()
  const [help, setHelp] = useState('')
  const [version, setVersion] = useState('')

  const screenName = () => (settings ? `settings · ${SETTINGS.find((p) => p.id === settings)?.label ?? settings}` : setup ? 'setup' : 'history')
  const openBug = () => {
    if (!bug) setBugScreen(screenName())
    setSettings(null)
    setBug(true)
    setSetupInFront(false)
  }
  const openSetup = () => {
    setSettings(null)
    setSetup(true)
    setSetupInFront(true)
  }
  // History closes the other dialogs, not the setup: the first launch's navigation to history
  // may come after the setup opened.
  const navigate = (s: MainSection) => {
    if (isSettings(s)) setSettings(s)
    else if (s === 'bug') openBug()
    else if (s === 'setup') openSetup()
    else {
      setSettings(null)
      setBug(false)
    }
  }

  useEffect(() => api.onNavigate(navigate))
  useEffect(() => void api.getInfo().then((i) => setVersion(i.version)), [])
  useEffect(() => {
    setHelp('')
    if (settings) setLastSettings(settings)
  }, [settings, bug, setup])

  // The first launch: the setup, once the window opens. Not for those who already dictate (an
  // update from before the setup existed): they have dictations, or at least speech recognition
  // installed (with the history off). Closed with "later" before the download ended, it opens
  // again; after, history's "set up speak" does.
  const looked = useRef(false)
  useEffect(() => {
    if (!config || looked.current) return
    looked.current = true
    if (config.state.onboarded) return
    void Promise.all([api.historyStats(), api.getEngineStatus()]).then(([{ count }, engine]) => {
      const model = config.speech.models[config.speech.engine]
      const speech = engine.binary.found && engine.models.some((m) => m.id === model && m.installed)
      if (!count && !speech) setSetup(true)
    })
  }, [config])

  if (!config) return null
  const setupDialog = setup && <SetupDialog key="setup" config={config} update={update} onClose={() => setSetup(false)} onSettings={setSettings} />
  const bugDialog = bug && <BugReportDialog key="bug" config={config} screen={bugScreen} onClose={() => setBug(false)} />
  /** The bug report is open, and not waiting behind the setup. */
  const bugInFront = bug && !(setup && setupInFront)
  // The first mode that's on: the button starts it, the status line says how.
  const mode = modesOn(config)[0] ?? 'dictate'
  const key = displayShortcut(config.modes[mode].shortcut)

  return (
    <HelpProvider value={setHelp}>
      <div className="frame">
        <TitleBar
          right={
            <>
              <Key k="●" onClick={() => api.toggleRecording(mode)}>
                {mode}
              </Key>
              <button
                className={`icon-button ${settings ? 'on' : ''}`}
                title="settings"
                aria-label="settings"
                onClick={() => setSettings(settings ? null : lastSettings)}
              >
                <PixelIcon rows={GEAR} />
              </button>
              <button
                className={`icon-button ${bugInFront ? 'on' : ''}`}
                title="report a bug"
                aria-label="report a bug"
                onClick={() => (bugInFront && !settings ? setBug(false) : openBug())}
              >
                <PixelIcon rows={BUG} />
              </button>
            </>
          }
        >
          <AppName /> · {settings ? 'settings' : bugInFront ? 'bug' : setup ? 'setup' : 'history'}
        </TitleBar>
        <div className="main">
          <History config={config} onSetup={openSetup} />
          {/* Keyed: changing which is in front moves them, without starting them over. */}
          {(setupInFront ? [bugDialog, setupDialog] : [setupDialog, bugDialog]).filter(Boolean)}
          {settings && (
            <SettingsDialog
              section={settings}
              onSection={setSettings}
              onNavigate={navigate}
              onClose={() => setSettings(null)}
              config={config}
              update={update}
            />
          )}
        </div>
        <div className="statusline">
          <span>{help || (key ? `${key} to ${mode} anywhere` : '')}</span>
          <span>v{version}</span>
        </div>
      </div>
    </HelpProvider>
  )
}
