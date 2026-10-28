import { useEffect, useState } from 'react'
import type { MainSection } from '@shared/types'
import { AppName } from '@themes/components'
import { Action, displayShortcut, HelpProvider, Key, TitleBar, useWindowFocus } from '../components/ui'
import { About } from './about'
import { AiSettings } from './ai-settings'
import { General } from './general'
import { History } from './history'
import { useConfig } from './hooks'
import { Transcription } from './transcription'

const api = window.speak

type SettingsSection = Exclude<MainSection, 'history'>

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

  useEffect(() => api.onNavigate(setSection), [])
  useEffect(() => void api.getInfo().then((i) => setVersion(i.version)), [])
  useEffect(() => {
    setHelp('')
    if (section !== 'history') setLastSettings(section)
  }, [section])

  if (!config) return null
  const page = SETTINGS.find((s) => s.id === section)

  return (
    <HelpProvider value={setHelp}>
      <div className="frame">
        <TitleBar
          right={
            <>
              <Key k="●" onClick={() => api.toggleRecording()}>
                dictate
              </Key>
              {page ? <Action onClick={() => setSection('history')}>history</Action> : <Action onClick={() => setSection(lastSettings)}>settings</Action>}
            </>
          }
        >
          <AppName /> · {page ? `settings · ${page.label}` : 'history'}
        </TitleBar>
        <div className="main">
          {!page ? (
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
