import { useState } from 'react'
import type { Config } from '@shared/types'
import { Dropdown } from '../components/dropdown'
import { Action, List, ListRow, Radio, Row, Sep, Spinner } from '../components/ui'
import { CONTEXT_KINDS, ipcError, shorten } from '../lib/format'

const api = window.speak

/**
 * The context: a folder, a git repository or a web page the AI reads, read-only, along with what
 * the user says. The chosen one stays until changed; the ones used before are listed, most recent
 * first, here and on the pill.
 */
export function ContextSettings({ config }: { config: Config }) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { current, recent } = config.context

  const run = (work: Promise<unknown>, then?: () => void) => {
    setBusy(true)
    setError(null)
    work
      .then(then)
      .catch((e: Error) => setError(ipcError(e)))
      .finally(() => setBusy(false))
  }
  const add = () => input.trim() && run(api.addContext(input.trim(), true), () => setInput(''))

  return (
    <>
      <section>
        <Sep>context</Sep>
        <p className="note">a folder, a git repository or a web page the ai reads along with what you say.</p>
        <Row label="current" hint="used by every dictation until you change it · also on the pill, while recording">
          <Dropdown
            value={current}
            onChange={(v) => api.chooseContext(v)}
            options={[{ value: '', label: 'none' }, ...recent.map((s) => ({ value: s.location, label: shorten(s.label, 48) }))]}
          />
        </Row>
        <Row
          label="add"
          hint="a folder path, a git repository (https://github.com/owner/name, git@…) or a web page address · enter to add"
          actions={
            busy ? (
              <Spinner />
            ) : (
              <>
                <Action onClick={add} disabled={!input.trim()}>
                  add
                </Action>
                <Action onClick={() => run(api.browseContextFolder())}>folder…</Action>
              </>
            )
          }
        >
          <input
            value={input}
            placeholder="folder path, git or web url"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        </Row>
        {busy && <p className="under dim">reading it… a git repository is cloned first</p>}
        {error && <p className="under error">✗ {error}</p>}
      </section>

      <section>
        <Sep>recent</Sep>
        {recent.length === 0 ? (
          <p className="note">none yet · add one above, or on the pill while recording</p>
        ) : (
          <List>
            {recent.map((s) => {
              const on = s.location === current
              return (
                <ListRow
                  key={s.location}
                  selected={on}
                  hint={s.location}
                  meta={
                    <span title={s.location}>
                      {CONTEXT_KINDS[s.kind]} · {shorten(s.location, 56)}
                    </span>
                  }
                  actions={
                    <Action danger onClick={() => run(api.removeContext(s.location))}>
                      remove
                    </Action>
                  }
                >
                  <button className="choice" role="radio" aria-checked={on} onClick={() => api.chooseContext(on ? '' : s.location)}>
                    <Radio on={on} /> {shorten(s.label, 32)}
                  </button>
                </ListRow>
              )
            })}
          </List>
        )}
      </section>
    </>
  )
}
