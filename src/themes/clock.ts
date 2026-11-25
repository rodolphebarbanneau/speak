/**
 * One clock for a window's CSS animations: the themes' logos, a secret theme's scene.
 *
 * Left to itself, an animation moves at the screen's rate, and each of the screen's refreshes (144
 * a second on some) has the page drawn and its window presented again. Presenting is what costs,
 * whatever the size of what moved: with some graphics drivers, a logo's glow kept a processor core
 * busy for as long as its window was open. So the animations are held, and all moved along
 * together a fixed number of times a second: the same animations, a fifth of the frames.
 * Transitions (a hover, a fade) are short and left alone. Not for the pill: its decorations are
 * what's looked at while dictating, and stay as smooth as the screen.
 */

/** Frames a second in the window being used. */
const FPS = 30
/** In a window left open on the side. */
const RESTING_FPS = 10
/** After a pause (the page was hidden), the animations go on from where they were. */
const LONGEST_STEP_MS = 250
/**
 * How long before a frame is due the clock asks the browser for it: the browser then gives the
 * screen's next refresh, so the frames stay evenly apart. Asking for every refresh and skipping
 * most of them would wake the page at the screen's rate for nothing.
 */
const AHEAD_MS = 10

/** The animations the clock moves: taken from the browser the first time they're seen running. */
const held = new WeakSet<Animation>()
let resting = (): boolean => false
/** The next frame, waited for (a timer) then asked of the browser: both 0 when the clock is stopped. */
let wait = 0
let request = 0
let last = 0

/** Move the held animations `ms` forward, and take the new ones. Returns whether any is still going. */
function advance(ms: number): boolean {
  let going = false
  for (const animation of document.getAnimations()) {
    if (!(animation instanceof CSSAnimation)) continue
    if (animation.playState === 'running') {
      // New, or set going again by its styles: it has moved by itself until now.
      animation.pause()
      held.add(animation)
      going = true
    } else if (animation.playState === 'paused' && held.has(animation)) {
      const at = Number(animation.currentTime ?? 0) + ms * animation.playbackRate
      const end = Number(animation.effect?.getComputedTiming().endTime)
      // Its end, as the browser would have it: the events, and the look it keeps (or not) after.
      if (Number.isFinite(end) && at >= end) animation.finish()
      else {
        animation.currentTime = at
        going = true
      }
    }
  }
  return going
}

function tick(now: number): void {
  request = 0
  const going = advance(Math.min(now - last, LONGEST_STEP_MS))
  last = now
  // Nothing left to move: the next animation to start sets the clock going again.
  if (!going) return
  wait = window.setTimeout(
    () => {
      wait = 0
      request = requestAnimationFrame(tick)
    },
    Math.max(0, 1000 / (resting() ? RESTING_FPS : FPS) - AHEAD_MS)
  )
}

function run(): void {
  if (!wait && !request) request = requestAnimationFrame(tick)
}

/**
 * Start the page's clock. `atRest` says when the window isn't the one being used: its animations
 * then move a few times a second only.
 */
export function startClock(atRest: () => boolean): void {
  resting = atRest
  document.addEventListener('animationstart', run, true)
  run()
}
