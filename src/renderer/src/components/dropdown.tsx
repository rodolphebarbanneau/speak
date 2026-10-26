import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

export interface DropdownOption<T extends string> {
  value: T
  label: string
}

interface Position {
  left: number
  top?: number
  bottom?: number
  minWidth: number
  maxHeight: number
}

const ITEM_HEIGHT = 26
const MAX_HEIGHT = 288
const GAP = 4

/**
 * Themed listbox: `value ▾`, left-aligned, with a popup that flips above when there's no room
 * below. Keyboard: ↑/↓/Enter/Space open, ↑/↓/Home/End move, Enter selects, Esc/Tab close,
 * letters jump to the next match, ←/→ change the value without opening.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: Array<DropdownOption<T>>
  onChange: (v: T) => void
  disabled?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<Position | null>(null)
  const index = options.findIndex((o) => o.value === value)
  const current = options[index]

  const close = useCallback((refocus = false) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }, [])

  const show = () => {
    const r = trigger.current!.getBoundingClientRect()
    const wanted = Math.min(MAX_HEIGHT, options.length * ITEM_HEIGHT + 2)
    const below = window.innerHeight - r.bottom - GAP * 2
    const above = r.top - GAP * 2
    setPos(
      below >= wanted || below >= above
        ? { left: r.left, top: r.bottom + GAP, minWidth: r.width, maxHeight: Math.min(MAX_HEIGHT, below) }
        : { left: r.left, bottom: window.innerHeight - r.top + GAP, minWidth: r.width, maxHeight: Math.min(MAX_HEIGHT, above) }
    )
    setActive(Math.max(0, index))
    setOpen(true)
  }

  const choose = (i: number) => {
    const option = options[i]
    if (option && option.value !== value) onChange(option.value)
    close(true)
  }

  // Keep the popup within the window horizontally once its width is known.
  useLayoutEffect(() => {
    if (!open || !pos || !list.current) return
    const overflow = list.current.getBoundingClientRect().right - (window.innerWidth - GAP * 2)
    if (overflow > 0) setPos({ ...pos, left: Math.max(GAP * 2, pos.left - overflow) })
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node
      if (!trigger.current?.contains(t) && !list.current?.contains(t)) close()
    }
    const onScroll = (e: Event) => {
      if (e.target !== list.current) close()
    }
    const onBlur = () => close()
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('resize', onBlur)
    window.addEventListener('blur', onBlur)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('resize', onBlur)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onKeyDown = (e: KeyboardEvent) => {
    const last = options.length - 1
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        show()
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && options.length > 1) {
        e.preventDefault()
        const next = (Math.max(0, index) + (e.key === 'ArrowLeft' ? -1 : 1) + options.length) % options.length
        onChange(options[next].value)
      }
      return
    }
    if (e.key === 'ArrowDown') setActive((a) => Math.min(last, a + 1))
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(last)
    else if (e.key === 'Enter' || e.key === ' ') choose(active)
    else if (e.key === 'Escape') {
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') close()
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase()
      const order = [...options.keys()].map((k) => (active + 1 + k) % options.length)
      const hit = order.find((i) => options[i].label.toLowerCase().startsWith(ch))
      if (hit !== undefined) setActive(hit)
    } else return
    e.preventDefault()
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`dropdown ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
      >
        <span className="dropdown-value">{current?.label ?? value}</span>
        <span className="caret">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <ul ref={list} id={id} role="listbox" className="dropdown-list" style={{ position: 'fixed', ...pos }}>
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === index}
                className={`${i === active ? 'active' : ''} ${i === index ? 'selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(i)
                }}
              >
                {o.label}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </>
  )
}
