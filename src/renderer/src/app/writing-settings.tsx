import { useEffect, useState } from 'react'
import { FORMATS } from '@shared/constants'
import type { Config, DeepPartial, Format, PasteKeys, PermissionStatus } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, Check, Row, Sep } from '../components/ui'
import { outputOptions } from '../lib/languages'

const api = window.speak
const isMac = api.platform === 'darwin'

const formatOptions = FORMATS.map((s) => ({ value: s.id, label: s.label.toLowerCase() }))

/** The modes that write, dictate and compose: what the text is like, and how it gets where the cursor is. */
export function WritingSettings({ config, update }: { config: Config; update: (patch: DeepPartial<Config>) => Promise<void> }) {
  const [perm, setPerm] = useState<PermissionStatus | null>(null)
  useEffect(() => void api.getPermissions().then(setPerm), [])

  return (
    <>
      <section>
        <p className="note">dictate writes what you say · compose writes what you ask for · both put the text where your cursor is</p>
        <Sep>text</Sep>
        <Row label="format" hint={`dictate: ${FORMATS.find((s) => s.id === config.writing.format)?.description.toLowerCase()}`}>
          <Dropdown<Format> value={config.writing.format} onChange={(v) => update({ writing: { format: v } })} options={formatOptions} />
        </Row>
        <Row label="write in" hint="as spoken, or translate what you say into another language">
          <Dropdown value={config.writing.language} onChange={(v) => update({ writing: { language: v } })} options={outputOptions} />
        </Row>
      </section>

      <section>
        <Sep>inserting</Sep>
        <Row label="then" hint="preview: check, edit by voice, copy or insert · paste: insert immediately">
          <Dropdown
            value={config.writing.then}
            onChange={(v) => update({ writing: { then: v } })}
            options={[
              { value: 'preview', label: 'preview' },
              { value: 'paste', label: 'paste' }
            ]}
          />
        </Row>
        <Row label="paste with" hint="keystroke sent to the target app · terminals on linux often need ctrl+shift+v">
          <Dropdown<PasteKeys>
            value={config.writing.pasteKeys}
            onChange={(v) => update({ writing: { pasteKeys: v } })}
            options={[
              { value: 'auto', label: isMac ? 'auto (cmd+v)' : 'auto (ctrl+v)' },
              { value: 'ctrl+v', label: 'ctrl+v' },
              { value: 'ctrl+shift+v', label: 'ctrl+shift+v' },
              { value: 'shift+insert', label: 'shift+insert' }
            ]}
          />
        </Row>
        <Row label="restore clipboard" hint="put back what was on the clipboard after pasting · off: the text stays on it, so ctrl+v pastes it again if needed">
          <Check checked={config.writing.restoreClipboard} onChange={(v) => update({ writing: { restoreClipboard: v } })} />
        </Row>
        {isMac && perm && (
          <Row
            label="accessibility"
            hint="needed to paste into other apps and for hold-to-talk"
            actions={!perm.accessibility && <Action onClick={() => void api.requestPermission('accessibility').then(setPerm)}>grant</Action>}
          >
            {perm.accessibility ? <span className="green">granted</span> : <span className="yellow">not granted</span>}
          </Row>
        )}
        {perm?.wayland && <p className="note">wayland: install wtype or ydotool for auto-paste, and bind a desktop shortcut to `speak --toggle`.</p>}
      </section>
    </>
  )
}
