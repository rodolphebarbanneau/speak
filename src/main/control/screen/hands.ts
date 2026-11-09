import { onUserInput, type UserInput } from '../../platform/keyboard'

/*
 * Speak's input, told from the user's. The input hook sees both, and doesn't pass on the system's
 * mark for injected input: Speak announces each key press, click and wheel turn it sends, and an
 * event it didn't announce is the user's. On Windows its characters go as Unicode packets, which
 * no key on a keyboard gives (key code 0). Where Speak puts the pointer is its anchor: a move
 * there is Speak's, a move away from it the user's. (Not a time window: typing would hide the user
 * for as long as it lasts.)
 */

export type Announced = 'packet' | 'key' | 'mouse'

const announced: Array<{ kind: Announced; at: number }> = []
/** An announced event not seen by then never will be (input the system refused, or the hook missed). */
const ANNOUNCED_MS = 1000
/** A move smaller than this, from where the pointer was put or last moved, is a nudge of the desk, not a hand. */
const NUDGE = 3
let anchor: { x: number; y: number } | null = null

/** Speak is about to send this (a key down, a button down, a wheel turn): the hook will see it. */
export function announce(kind: Announced, count = 1): void {
  const at = Date.now()
  for (let i = 0; i < count; i++) announced.push({ kind, at })
}

/** Speak put the pointer there: where the user's next move starts. */
export function setAnchor(x: number, y: number): void {
  anchor = { x: Math.round(x), y: Math.round(y) }
}

/** Whether a key press, click, wheel turn or move is the user's: Speak's own are taken off as they come. */
function fromUser(e: UserInput): boolean {
  const now = Date.now()
  while (announced.length && now - announced[0].at > ANNOUNCED_MS) announced.shift()
  if (e.kind === 'move') {
    if (anchor && Math.abs(e.x - anchor.x) < NUDGE && Math.abs(e.y - anchor.y) < NUDGE) return false
    anchor = { x: e.x, y: e.y }
    return true
  }
  const kinds: Announced[] = e.kind === 'mouse' ? ['mouse'] : e.keycode === 0 ? ['packet', 'key'] : ['key']
  for (const kind of kinds) {
    const i = announced.findIndex((a) => a.kind === kind)
    if (i >= 0) {
      announced.splice(i, 1)
      return false
    }
  }
  return true
}

const usersListeners = new Set<(e: UserInput) => void>()
let classifying = false

/** The user's own key presses, clicks, wheel turns and moves: never Speak's. */
export function onUsersInput(cb: (e: UserInput) => void): () => void {
  if (!classifying) {
    // Once, for good: every event is told once, and Speak's announced ones are taken off.
    classifying = true
    onUserInput((e) => {
      if (fromUser(e)) for (const l of usersListeners) l(e)
    })
  }
  usersListeners.add(cb)
  return () => usersListeners.delete(cb)
}
