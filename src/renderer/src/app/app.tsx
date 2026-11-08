import { useEffect, useState } from 'react'
import { modesOn } from '@shared/constants'
import type { MainSection } from '@shared/types'
import { AppName } from '@themes/components'
import { Canvas, cellSize, Pixels } from '@themes/pixels'
import { displayShortcut, HelpProvider, Key, TitleBar, useWindowFocus } from '../components/ui'
import { BugReportDialog } from './bug-report'
import { History } from './history'
import { useConfig } from './hooks'
import { isSettings, SETTINGS, SettingsDialog, type SettingsSection } from './settings'

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
 * check something while writing it. The title row names what's in front.
 */
export function App() {
  useWindowFocus()
  const [bug, setBug] = useState(false)
  const [settings, setSettings] = useState<SettingsSection | null>(null)
  const [lastSettings, setLastSettings] = useState<SettingsSection>('general')
  /** What was on screen when "report a bug" opened: the report says which screen. */
  const [bugScreen, setBugScreen] = useState('history')
  const [config, update] = useConfig()
  const [help, setHelp] = useState('')
  const [version, setVersion] = useState('')

  const screenName = () => (settings ? `settings · ${SETTINGS.find((p) => p.id === settings)?.label ?? settings}` : 'history')
  const openBug = () => {
    if (!bug) setBugScreen(screenName())
    setSettings(null)
    setBug(true)
  }
  const navigate = (s: MainSection) => {
    if (isSettings(s)) setSettings(s)
    else if (s === 'bug') openBug()
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
  }, [settings, bug])

  if (!config) return null
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
                className={`icon-button ${bug ? 'on' : ''}`}
                title="report a bug"
                aria-label="report a bug"
                onClick={() => (bug && !settings ? setBug(false) : openBug())}
              >
                <PixelIcon rows={BUG} />
              </button>
            </>
          }
        >
          <AppName /> · {settings ? 'settings' : bug ? 'bug' : 'history'}
        </TitleBar>
        <div className="main">
          <History config={config} onSetup={() => setSettings('general')} />
          {bug && <BugReportDialog config={config} screen={bugScreen} onClose={() => setBug(false)} />}
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
