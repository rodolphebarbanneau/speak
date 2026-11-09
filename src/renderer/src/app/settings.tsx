import { useEffect, useRef, useState } from 'react'
import type { Config, DeepPartial, MainSection } from '@shared/types'
import { Boundary, Key } from '../components/ui'
import type { TestVerdict } from '../lib/microphone'
import { About } from './about'
import { AiSettings } from './ai-settings'
import { ContextSettings } from './context-settings'
import { ControlSettings } from './control-settings'
import { General } from './general'
import { SpeechSettings } from './speech-settings'
import { WritingSettings } from './writing-settings'

export type SettingsSection = Exclude<MainSection, 'history' | 'bug' | 'setup'>

/**
 * The tabs: the app and its modes, then what turns speech into text (speech, ai), then the modes'
 * own settings (writing: dictate and compose; context; control), then about.
 */
export const SETTINGS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'general' },
  { id: 'speech', label: 'speech' },
  { id: 'ai', label: 'ai' },
  { id: 'writing', label: 'writing' },
  { id: 'context', label: 'context' },
  { id: 'control', label: 'control' },
  { id: 'about', label: 'about' }
]

export const isSettings = (s: MainSection): s is SettingsSection => SETTINGS.some((p) => p.id === s)

/**
 * Settings, a dialog over the window: history (or the bug report) stays where it was behind it.
 * The title row names it. Esc, the close key or a click beside it closes it, and the focus goes
 * back where it was.
 */
export function SettingsDialog({
  section,
  onSection,
  onNavigate,
  onClose,
  config,
  update
}: {
  section: SettingsSection
  onSection: (s: SettingsSection) => void
  /** Elsewhere in the window: the guided setup. */
  onNavigate: (s: MainSection) => void
  onClose: () => void
  config: Config
  update: (patch: DeepPartial<Config>) => Promise<void>
}) {
  const box = useRef<HTMLDivElement>(null)
  // The microphone test is on speech; general's setup shows its outcome.
  const [micVerdict, setMicVerdict] = useState<TestVerdict | null>(null)
  // The keys are the dialog's, not those of a field behind it.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    box.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  const page = SETTINGS.find((p) => p.id === section)!
  // General's setup list sends to speech or ai, here in the same dialog, or to the guided setup.
  const go = (s: MainSection) => (isSettings(s) ? onSection(s) : onNavigate(s))
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        aria-label="settings"
        tabIndex={-1}
        onKeyDown={(e) => {
          // A shortcut being recorded takes Esc before it gets here, and so does an open list.
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <nav className="nav">
          {SETTINGS.map((s) => (
            <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => onSection(s.id)}>
              {s.label}
            </button>
          ))}
          <span className="nav-close">
            <Key k="esc" onClick={onClose}>
              close
            </Key>
          </span>
        </nav>
        {/* A page of its own each time: it opens at the top. */}
        <div className="page" key={section}>
          <div className="page-inner">
            <Boundary label={`settings · ${page.label}`}>
              {section === 'general' && <General config={config} update={update} onNavigate={go} micVerdict={micVerdict} />}
              {section === 'speech' && <SpeechSettings config={config} update={update} onVerdict={setMicVerdict} />}
              {section === 'ai' && <AiSettings config={config} update={update} />}
              {section === 'writing' && <WritingSettings config={config} update={update} />}
              {section === 'context' && <ContextSettings config={config} />}
              {section === 'control' && <ControlSettings config={config} update={update} />}
              {section === 'about' && <About config={config} update={update} />}
            </Boundary>
          </div>
        </div>
      </div>
    </div>
  )
}
