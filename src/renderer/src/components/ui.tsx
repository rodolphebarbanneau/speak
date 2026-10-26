import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

const api = window.speak
const isMac = api.platform === 'darwin'
export const MOD = isMac ? 'cmd' : 'ctrl'

/** Track window focus so the title row dims when inactive, like native title bars. */
export function useWindowFocus(): void {
  useEffect(() => {
    const set = () => document.documentElement.classList.toggle('focused', document.hasFocus())
    set()
    window.addEventListener('focus', set)
    window.addEventListener('blur', set)
    return () => {
      window.removeEventListener('focus', set)
      window.removeEventListener('blur', set)
    }
  }, [])
}

/**
 * Draggable title row. The OS draws the window controls; the row is positioned around them
 * with the Window Controls Overlay env() variables (titlebar-area-x/width/height).
 */
export function TitleBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <header className="titlebar">
      <div className="titlebar-area">
        <span className="title">{children}</span>
        {right && <span className="right">{right}</span>}
      </div>
    </header>
  )
}

/** Key hint that is also a button: `enter insert`. */
export function Key({
  k,
  children,
  onClick,
  primary,
  danger,
  disabled,
  title
}: {
  k: string
  children: ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button className={`key ${primary ? 'primary' : ''} ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled} title={title}>
      <kbd>{k}</kbd>
      {children}
    </button>
  )
}

/** `[ action ]` */
export function Action({ children, onClick, disabled, danger }: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={`action ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

/** `[x]` / `[ ]` */
export function Check({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="checkbox" aria-checked={checked} className="check" onClick={() => onChange(!checked)} disabled={disabled}>
      [<b>{checked ? 'x' : ' '}</b>]
    </button>
  )
}

/** `(•)` / `( )` */
export function Radio({ on }: { on: boolean }) {
  return <span className={`radio ${on ? 'on' : ''}`}>{on ? '(•)' : '( )'}</span>
}

/** Section separator: ── title ──────── */
export function Sep({ children, tail }: { children: ReactNode; tail?: ReactNode }) {
  return (
    <div className="sep">
      <span>{children}</span>
      {tail && <span className="tail">{tail}</span>}
    </div>
  )
}

// Help line: rows publish their description to the window's status line on hover/focus.
const HelpContext = createContext<(text: string) => void>(() => undefined)
export const HelpProvider = HelpContext.Provider

function useHelp(hint?: string) {
  const setHelp = useContext(HelpContext)
  return () => setHelp(hint ?? '')
}

/**
 * Setting row on a shared 3-column grid: fixed label column, left-aligned value, trailing
 * actions. `block` rows (text areas) let the value span the value and actions columns.
 */
export function Row({
  label,
  hint,
  children,
  actions,
  block
}: {
  label: ReactNode
  hint?: string
  children?: ReactNode
  actions?: ReactNode
  block?: boolean
}) {
  const show = useHelp(hint)
  return (
    <div className={`row ${block ? 'block' : ''}`} onMouseEnter={show} onFocus={show}>
      <span className="label">{label}</span>
      <span className="value">{children}</span>
      {actions && <span className="actions">{actions}</span>}
    </div>
  )
}

/** Container for ListRows: columns (main · meta · actions) line up across rows via subgrid. */
export function List({ children }: { children: ReactNode }) {
  return <div className="list">{children}</div>
}

/** Selectable list item: main content (often a radio/check + name), dim meta, trailing actions. */
export function ListRow({
  children,
  meta,
  actions,
  hint,
  selected
}: {
  children: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  hint?: string
  selected?: boolean
}) {
  const show = useHelp(hint)
  return (
    <div className={`list-row ${selected ? 'selected' : ''}`} onMouseEnter={show} onFocus={show}>
      <span className="list-main">{children}</span>
      <span className="list-meta">{meta}</span>
      <span className="list-actions">{actions}</span>
    </div>
  )
}

/** Text input that commits on blur/Enter (avoids saving config on every keystroke). */
export function TextInput({
  value,
  onCommit,
  placeholder,
  type = 'text',
  multiline,
  rows = 3,
  width
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  type?: string
  multiline?: boolean
  rows?: number
  width?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => draft !== value && onCommit(draft)
  if (multiline)
    return <textarea rows={rows} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} spellCheck={false} />
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      style={width ? { width, minWidth: 0 } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

/** Block progress bar: ████████░░░░ 45%  312 / 685 MB */
export function Bar({ value, total, label }: { value: number; total: number; label?: string }) {
  const width = 20
  const filled = total > 0 ? Math.round((value / total) * width) : 0
  return (
    <span className="bar">
      {total > 0 ? '█'.repeat(filled) : <Spinner />}
      <i>{total > 0 ? '░'.repeat(width - filled) : ''}</i>
      <span className="dim">
        {' '}
        {label ?? (total > 0 ? `${Math.round((value / total) * 100)}%  ${formatSize(value)} / ${formatSize(total)}` : formatSize(value))}
      </span>
    </span>
  )
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`
}

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export function Spinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])
  return <span className="spin">{FRAMES[i]}</span>
}

const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  return CODE_TO_KEY[code] ?? null
}

/** Electron accelerator → lowercase terminal-style label: ctrl+shift+space */
export function displayShortcut(accel: string): string {
  return accel
    .replace('CommandOrControl', isMac ? 'cmd' : 'ctrl')
    .replace('Command', 'cmd')
    .replace('Control', 'ctrl')
    .replace('Option', 'alt')
    .toLowerCase()
}

/** Click (or Enter), then press the desired key combination. Global shortcuts are suspended meanwhile. */
export function ShortcutInput({ value, onChange, allowBare }: { value: string; onChange: (v: string) => void; allowBare?: boolean }) {
  const [capturing, setCapturing] = useState(false)
  // Latest callback without re-subscribing (and re-suspending shortcuts) on every render.
  const changed = useRef(onChange)
  changed.current = onChange

  useEffect(() => {
    if (!capturing) return
    api.suspendShortcuts(true)
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !allowBare) {
        setCapturing(false)
        return
      }
      const key = keyFromCode(e.code)
      if (!key) return // only modifiers so far
      const mods: string[] = []
      if (e.ctrlKey) mods.push(isMac ? 'Control' : 'CommandOrControl')
      if (e.metaKey) mods.push(isMac ? 'CommandOrControl' : 'Super')
      if (e.altKey) mods.push('Alt')
      if (e.shiftKey) mods.push('Shift')
      if (!mods.length && !(allowBare || /^F\d+$/.test(key))) return
      changed.current([...mods, key].join('+'))
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      api.suspendShortcuts(false)
    }
  }, [capturing, allowBare])

  return (
    <button className={`shortcut ${capturing ? 'capturing' : ''}`} onClick={() => setCapturing((c) => !c)} onBlur={() => setCapturing(false)}>
      {capturing ? 'press keys… (esc to cancel)' : displayShortcut(value)}
    </button>
  )
}
