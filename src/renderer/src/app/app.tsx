import { useEffect, useRef, useState } from 'react'
import type { MainSection } from '@shared/types'
import { AppName } from '@themes/components'
import { Action, displayShortcut, HelpProvider, Key, TitleBar, useWindowFocus } from '../components/ui'
import { About } from './about'
import { AiSettings } from './ai-settings'
import { BugReportPage } from './bug-report'
import { General } from './general'
import { History } from './history'
import { useConfig } from './hooks'
import { Transcription } from './transcription'

const api = window.speak

type SettingsSection = Exclude<MainSection, 'history' | 'bug'>

/** A beetle in the font's pixels, for "report a bug". */
const BUG = ['.x.....x.', '..x...x..', '...xxx...', 'x.xxxxx.x', '.xxx.xxx.', 'x.xxxxx.x', '.xxx.xxx.', 'x..xxx..x']

function BugIcon() {
  return (
    <svg className="bug-icon" viewBox="0 0 9 8" aria-hidden="true" shapeRendering="crispEdges">
      {BUG.flatMap((row, y) => [...row].map((c, x) => (c === 'x' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null)))}
    </svg>
  )
}

/** Settings pages, behind the title bar's [ settings ]: the window opens on history. */
const SETTINGS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'general' },
  { id: 'transcription', label: 'speech' },
  { id: 'ai', label: 'ai' },
  { id: 'about', label: 'about' }
]

export function App() {
  useWindowFocus()
  const [section, setSection] = useState<MainSection>('history')
  const [lastSettings, setLastSettings] = useState<SettingsSection>('general')
  const [config, update] = useConfig()
  const [help, setHelp] = useState('')
  const [version, setVersion] = useState('')
  /** Where the user was before "report a bug": the report says which screen. */
  const before = useRef<MainSection>('history')

  useEffect(() => api.onNavigate(setSection), [])
  useEffect(() => void api.getInfo().then((i) => setVersion(i.version)), [])
  useEffect(() => {
    setHelp('')
    if (section !== 'bug') before.current = section
    if (section !== 'history' && section !== 'bug') setLastSettings(section)
  }, [section])

  if (!config) return null
  const page = SETTINGS.find((s) => s.id === section)
  const screenName = (s: MainSection) => (s === 'history' ? 'history' : `settings · ${SETTINGS.find((p) => p.id === s)?.label ?? s}`)

  return (
    <HelpProvider value={setHelp}>
      <div className="frame">
        <TitleBar
          right={
            <>
              <Key k="●" onClick={() => api.toggleRecording()}>
                dictate
              </Key>
              {section === 'history' ? (
                <Action onClick={() => setSection(lastSettings)}>settings</Action>
              ) : (
                <Action onClick={() => setSection('history')}>history</Action>
              )}
              <button
                className={`icon-button ${section === 'bug' ? 'on' : ''}`}
                title="report a bug"
                aria-label="report a bug"
                onClick={() => setSection(section === 'bug' ? before.current : 'bug')}
              >
                <BugIcon />
              </button>
            </>
          }
        >
          <AppName /> · {section === 'bug' ? 'report a bug' : page ? `settings · ${page.label}` : 'history'}
        </TitleBar>
        <div className="main">
          {section === 'bug' ? (
            <BugReportPage config={config} screen={screenName(before.current)} onClose={() => setSection(before.current)} />
          ) : !page ? (
            <History config={config} onSetup={() => setSection('general')} />
          ) : (
            <>
              <nav className="nav">
                {SETTINGS.map((s) => (
                  <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>
                    {s.label}
                  </button>
                ))}
              </nav>
              <div className="page">
                <div className="page-inner">
                  {section === 'general' && <General config={config} update={update} onNavigate={setSection} />}
                  {section === 'transcription' && <Transcription config={config} update={update} />}
                  {section === 'ai' && <AiSettings config={config} update={update} />}
                  {section === 'about' && <About config={config} update={update} />}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="statusline">
          <span>{help || `${displayShortcut(config.shortcuts.record)} to dictate anywhere`}</span>
          <span>v{version}</span>
        </div>
      </div>
    </HelpProvider>
  )
}
