import { useEffect, useState } from 'react'
import { MODE_SHORTCUT, modesOn } from '@shared/constants'
import type { MainSection } from '@shared/types'
import { AppName } from '@themes/components'
import { Action, displayShortcut, HelpProvider, Key, TitleBar, useWindowFocus } from '../components/ui'
import { BugReportPage } from './bug-report'
import { History } from './history'
import { useConfig } from './hooks'
import { isSettings, SETTINGS, SettingsDialog, type SettingsSection } from './settings'

const api = window.speak

/** A beetle in the font's pixels, for "report a bug". */
const BUG = ['.x.....x.', '..x...x..', '...xxx...', 'x.xxxxx.x', '.xxx.xxx.', 'x.xxxxx.x', '.xxx.xxx.', 'x..xxx..x']

function BugIcon() {
  return (
    <svg className="bug-icon" viewBox="0 0 9 8" aria-hidden="true" shapeRendering="crispEdges">
      {BUG.flatMap((row, y) => [...row].map((c, x) => (c === 'x' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null)))}
    </svg>
  )
}

/**
 * The window shows history, or the bug report; settings open over either, in a dialog, from the
 * title bar's [ settings ] (or the tray), and close back to what was there.
 */
export function App() {
  useWindowFocus()
  const [view, setView] = useState<'history' | 'bug'>('history')
  const [settings, setSettings] = useState<SettingsSection | null>(null)
  const [lastSettings, setLastSettings] = useState<SettingsSection>('general')
  /** What was on screen when "report a bug" opened: the report says which screen. */
  const [bugScreen, setBugScreen] = useState('history')
  const [config, update] = useConfig()
  const [help, setHelp] = useState('')
  const [version, setVersion] = useState('')

  const screenName = () => (settings ? `settings · ${SETTINGS.find((p) => p.id === settings)?.label ?? settings}` : 'history')
  const openBug = () => {
    setBugScreen(screenName())
    setSettings(null)
    setView('bug')
  }
  const navigate = (s: MainSection) => {
    if (isSettings(s)) setSettings(s)
    else if (s === 'bug') openBug()
    else {
      setSettings(null)
      setView('history')
    }
  }

  useEffect(() => api.onNavigate(navigate))
  useEffect(() => void api.getInfo().then((i) => setVersion(i.version)), [])
  useEffect(() => {
    setHelp('')
    if (settings) setLastSettings(settings)
  }, [settings, view])

  if (!config) return null
  // The first mode that's on: the button starts it, the status line says how.
  const mode = modesOn(config)[0] ?? 'dictate'
  const key = displayShortcut(config.shortcuts[MODE_SHORTCUT[mode]])

  return (
    <HelpProvider value={setHelp}>
      <div className="frame">
        <TitleBar
          right={
            <>
              <Key k="●" onClick={() => api.toggleRecording(mode)}>
                {mode}
              </Key>
              <Action onClick={() => setSettings(settings ? null : lastSettings)}>settings</Action>
              <button
                className={`icon-button ${view === 'bug' ? 'on' : ''}`}
                title="report a bug"
                aria-label="report a bug"
                onClick={() => (view === 'bug' && !settings ? setView('history') : openBug())}
              >
                <BugIcon />
              </button>
            </>
          }
        >
          <AppName /> · {view === 'bug' ? 'report a bug' : 'history'}
        </TitleBar>
        <div className="main">
          {view === 'bug' ? (
            <BugReportPage config={config} screen={bugScreen} onClose={() => setView('history')} />
          ) : (
            <History config={config} onSetup={() => setSettings('general')} />
          )}
          {settings && <SettingsDialog section={settings} onSection={setSettings} onClose={() => setSettings(null)} config={config} update={update} />}
        </div>
        <div className="statusline">
          <span>{help || (key ? `${key} to ${mode} anywhere` : '')}</span>
          <span>v{version}</span>
        </div>
      </div>
    </HelpProvider>
  )
}
