import { CONTROL_APPROVALS, CONTROL_SCOPES } from '@shared/constants'
import type { Config, ControlAlwaysAsk, ControlApproval, ControlScope, DeepPartial } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Check, displayShortcut, Row, Sep } from '../components/ui'

const ALWAYS: Array<{ id: keyof ControlAlwaysAsk; label: string; hint: string }> = [
  { id: 'money', label: 'money', hint: 'paying, buying, ordering, transferring' },
  { id: 'secrets', label: 'passwords', hint: 'password fields, security and account settings' },
  { id: 'delete', label: 'deleting', hint: "deleting for good (speak's own trash can be undone)" },
  { id: 'send', label: 'sending as you', hint: 'emails, messages, posts, comments' }
]

/** Control mode: what a new session may touch, when it asks first, and what always asks. */
export function ControlSettings({ config, update }: { config: Config; update: (patch: DeepPartial<Config>) => Promise<void> }) {
  const c = config.control
  const scope = CONTROL_SCOPES.find((s) => s.id === c.scope)
  const approval = CONTROL_APPROVALS.find((a) => a.id === c.approval)
  return (
    <>
      <section>
        <p className="note">
          say what to do with <span className="acc">{displayShortcut(config.shortcuts.control) || 'the control shortcut'}</span>: the ai does it on the
          computer, and a panel shows what it does. keep talking to it with the shortcut.
        </p>
        <Sep>new sessions</Sep>
        <Row label="scope" hint={scope?.description}>
          <Dropdown<ControlScope>
            value={c.scope}
            onChange={(v) => update({ control: { scope: v } })}
            options={CONTROL_SCOPES.map((s) => ({ value: s.id, label: s.label }))}
          />
        </Row>
        <Row label="asks first" hint={approval?.description}>
          <Dropdown<ControlApproval>
            value={c.approval}
            onChange={(v) => update({ control: { approval: v } })}
            options={CONTROL_APPROVALS.map((a) => ({ value: a.id, label: a.label }))}
          />
        </Row>
        <Row label="end after" hint="with nothing to do">
          <Dropdown
            value={String(c.idleMinutes)}
            onChange={(v) => update({ control: { idleMinutes: Number(v) } })}
            options={[5, 10, 30, 60, 0].map((m) => ({ value: String(m), label: m ? `${m} min` : 'never' }))}
          />
        </Row>
        <Row
          label="your hands"
          hint="it acts in the background when it can · what needs your mouse or keyboard waits until your hands have been still this long, then gives them back"
        >
          <Dropdown
            value={String(c.handsSeconds)}
            onChange={(v) => update({ control: { handsSeconds: Number(v) } })}
            options={[1, 2, 3, 5].map((s) => ({ value: String(s), label: `still for ${s} s` }))}
          />
        </Row>
        <Row label="read aloud" hint="its answers and questions, with the system voice">
          <Check checked={c.speak} onChange={(v) => update({ control: { speak: v } })} />
        </Row>
      </section>

      <section>
        <Sep>always asks</Sep>
        {ALWAYS.map((a) => (
          <Row key={a.id} label={a.label} hint={a.hint}>
            <Check checked={c.alwaysAsk[a.id]} onChange={(v) => update({ control: { alwaysAsk: { [a.id]: v } } })} />
          </Row>
        ))}
      </section>
    </>
  )
}
