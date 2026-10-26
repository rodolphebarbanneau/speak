import { useEffect, useState } from 'react'
import type { MainSection } from '@shared/types'
import { displayShortcut, HelpProvider, Key, TitleBar, useWindowFocus } from '../components/ui'
import { About } from './about'
import { AiSettings } from './ai-settings'
import { General } from './general'
import { History } from './history'
import { useConfig } from './hooks'
import { Transcription } from './transcription'

const api = window.speak

const SECTIONS: Array<{ id: MainSection; label: string }> = [
  { id: 'history', label: 'history' },
  { id: 'general', label: 'general' },
  { id: 'transcription', label: 'speech' },
  { id: 'ai', label: 'ai' },
  { id: 'about', label: 'about' }
]

export function App() {
  useWindowFocus()
  const [section, setSection] = useState<MainSection>('history')
  const [config, update] = useConfig()
  const [help, setHelp] = useState('')
  const [version, setVersion] = useState('')

  useEffect(() => api.onNavigate(setSection), [])
  useEffect(() => void api.getInfo().then((i) => setVersion(i.version)), [])
  useEffect(() => setHelp(''), [section])

  if (!config) return null
  const label = SECTIONS.find((s) => s.id === section)?.label

  return (
    <HelpProvider value={setHelp}>
      <div className="frame">
        <TitleBar>
          <b>speak</b> · {label}
        </TitleBar>
        <div className="main">
          <nav className="nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>
                {s.label}
              </button>
            ))}
            <div className="spacer" />
            <div className="dictate">
              <Key k="●" onClick={() => api.toggleRecording()}>
                dictate
              </Key>
              <span className="dim">{displayShortcut(config.shortcuts.record)}</span>
            </div>
          </nav>
          {section === 'history' ? (
            <History config={config} />
          ) : (
            <div className="page">
              <div className="page-inner">
                {section === 'general' && <General config={config} update={update} onNavigate={setSection} />}
                {section === 'transcription' && <Transcription config={config} update={update} />}
                {section === 'ai' && <AiSettings config={config} update={update} />}
                {section === 'about' && <About config={config} update={update} />}
              </div>
            </div>
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
