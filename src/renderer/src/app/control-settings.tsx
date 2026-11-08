import { CONTROL_APPROVALS, CONTROL_SCOPES, firstShortcut } from '@shared/constants'
import type { Config, ControlAlwaysAsk, ControlApproval, ControlScope, DeepPartial } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { outputOptions } from '../lib/languages'
import { Action, Check, displayShortcut, Row, Sep } from '../components/ui'

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
        {config.modes.control.on ? (
          <p className="note">
            say what to do with <span className="acc">{displayShortcut(config.modes.control.shortcut) || 'the control shortcut'}</span>: the ai does it on the
            computer, and a panel shows what it does. keep talking to it with{' '}
            <span className="acc">{displayShortcut(firstShortcut(config)) || 'any shortcut'}</span>: while it's on, every shortcut talks to it.
          </p>
        ) : (
          <p className="note">
            <span className="yellow">control is off</span>: no shortcut, and it isn't offered on the pill or the tray. these settings apply once it's on.{' '}
            <Action onClick={() => void update({ modes: { control: { on: true } } })}>turn on</Action>
          </p>
        )}
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
          hint="it acts in the background when it can · what needs your mouse or keyboard waits until your hands have been still this long, then gives them back · touch them meanwhile and it stops, until you say continue"
        >
          <Dropdown
            value={String(c.handsSeconds)}
            onChange={(v) => update({ control: { handsSeconds: Number(v) } })}
            options={[1, 2, 3, 5].map((s) => ({ value: String(s), label: `still for ${s} s` }))}
          />
        </Row>
        <Row
          label="answers in"
          hint="the language it writes in, and reads aloud in · as spoken: the language of your order · you speak in the spoken language of settings → speech"
        >
          <Dropdown value={c.language} onChange={(v) => update({ control: { language: v } })} options={outputOptions} />
        </Row>
        <Row label="read aloud" hint="its answers and questions, with the system voice">
          <Check checked={c.readAloud} onChange={(v) => update({ control: { readAloud: v } })} />
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

      <section>
        <Sep>how it works</Sep>
        <Row label="scope">
          <span className="dim">an app, the screen or everything · speak refuses anything beyond it</span>
        </Row>
        <Row label="approvals">
          <span className="dim">answer by voice or in the panel: yes, always, no, or say what to do instead</span>
        </Row>
        <Row label="undo">
          <span className="dim">files it moves, writes or trashes · its trash is ~/.speak/control</span>
        </Row>
        <Row label="privacy">
          <span className="dim">what it looks at goes to your ai provider: an app scope sends one app</span>
        </Row>
      </section>
    </>
  )
}
