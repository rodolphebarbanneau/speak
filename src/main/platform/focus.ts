import { app, type BrowserWindow } from 'electron'
import { log } from '../log'
import { delay, isLinux, isMac, isWayland, isWin, run, which } from '../util'

/** The window that had keyboard focus when dictation started (where text gets inserted). */
export interface FocusTarget {
  handle?: unknown // Windows HWND (koffi pointer)
  xid?: string // X11 window id
  title?: string
}

interface Win32 {
  GetForegroundWindow: () => unknown
  SetForegroundWindow: (h: unknown) => boolean
  IsWindow: (h: unknown) => boolean
  IsIconic: (h: unknown) => boolean
  ShowWindow: (h: unknown, cmd: number) => boolean
  GetWindowThreadProcessId: (h: unknown, pid: number[]) => number
  GetWindowTextW: (h: unknown, buf: Buffer, max: number) => number
  address: (h: unknown) => bigint
  GetCurrentThreadId: () => number
  AttachThreadInput: (from: number, to: number, attach: boolean) => boolean
  SetForegroundWindowPtr: (h: bigint) => boolean
  BringWindowToTopPtr: (h: bigint) => boolean
  FindWindowExPtr: (parent: bigint, after: bigint, cls: string, title: string | null) => number | bigint
  IsWindowVisiblePtr: (h: number | bigint) => boolean
  ShowWindowPtr: (h: number | bigint, cmd: number) => boolean
  GetWindowPtr: (h: number | bigint, cmd: number) => number | bigint
  GetWindowLongPtr: (h: number | bigint, index: number) => number | bigint
  SetWindowPosPtr: (h: number | bigint, after: number | bigint, x: number, y: number, cx: number, cy: number, flags: number) => boolean
}

let win32: Win32 | null | undefined

function loadWin32(): Win32 | null {
  if (win32 !== undefined) return win32
  win32 = null
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    win32 = {
      GetForegroundWindow: user32.func('void* __stdcall GetForegroundWindow()'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void* hWnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(void* hWnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void* hWnd)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(void* hWnd, int nCmdShow)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void* hWnd, _Out_ uint8_t* lpString, int nMaxCount)'),
      address: (h: unknown) => koffi.address(h),
      GetCurrentThreadId: koffi.load('kernel32.dll').func('uint32 __stdcall GetCurrentThreadId()'),
      AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
      SetForegroundWindowPtr: user32.func('SetForegroundWindow', 'bool', ['intptr_t']),
      BringWindowToTopPtr: user32.func('BringWindowToTop', 'bool', ['intptr_t']),
      FindWindowExPtr: user32.func('FindWindowExW', 'intptr_t', ['intptr_t', 'intptr_t', 'str16', 'str16']),
      IsWindowVisiblePtr: user32.func('IsWindowVisible', 'bool', ['intptr_t']),
      ShowWindowPtr: user32.func('ShowWindow', 'bool', ['intptr_t', 'int']),
      GetWindowPtr: user32.func('GetWindow', 'intptr_t', ['intptr_t', 'uint32']),
      GetWindowLongPtr: user32.func('GetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int']),
      SetWindowPosPtr: user32.func('SetWindowPos', 'bool', ['intptr_t', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32'])
    } as unknown as Win32
  } catch (err) {
    log.warn('Win32 bindings unavailable:', err)
  }
  return win32
}

export async function captureFocus(): Promise<FocusTarget | null> {
  try {
    if (isWin) {
      const w = loadWin32()
      if (!w) return null
      const handle = w.GetForegroundWindow()
      const pid = [0]
      if (handle) w.GetWindowThreadProcessId(handle, pid)
      const buf = Buffer.alloc(512)
      const len = handle ? w.GetWindowTextW(handle, buf, 256) : 0
      const title = buf.toString('utf16le', 0, len * 2)
      log.info(`Focus target: "${title}" (pid ${pid[0]})`)
      if (!handle || pid[0] === process.pid) return null // nothing, or one of our own windows
      return { handle, title }
    }
    if (isLinux && !isWayland && which('xdotool')) {
      const r = await run('xdotool', ['getactivewindow'], { timeoutMs: 1500 })
      const xid = r.stdout.trim()
      if (!xid) return null
      const name = await run('xdotool', ['getwindowname', xid], { timeoutMs: 1500 }).catch(() => null)
      return { xid, title: name?.stdout.trim() }
    }
  } catch (err) {
    log.warn('captureFocus failed:', err)
  }
  return {}
}

/**
 * Whether another window has come in front since `target` was captured, as far as the system
 * tells (Windows, X11 with xdotool). False when it can't tell, or there was no target.
 */
export async function focusMoved(target: FocusTarget | null): Promise<boolean> {
  try {
    if (isWin && target?.handle) {
      const w = loadWin32()
      if (!w) return false
      const now = w.GetForegroundWindow()
      return !!now && w.address(now) !== w.address(target.handle)
    }
    if (isLinux && !isWayland && target?.xid && which('xdotool')) {
      const r = await run('xdotool', ['getactivewindow'], { timeoutMs: 1500 })
      const xid = r.stdout.trim()
      return !!xid && xid !== target.xid
    }
  } catch (err) {
    log.warn('focusMoved failed:', err)
  }
  return false
}

/**
 * Give keyboard focus back to the target window. `hideOwn` hides our dialog; on macOS
 * hiding the app is what returns focus to the previously active application.
 */
export async function restoreFocus(target: FocusTarget | null, hideOwn: () => void): Promise<void> {
  if (isWin) {
    const w = loadWin32()
    if (w && target?.handle && w.IsWindow(target.handle)) {
      if (w.IsIconic(target.handle)) w.ShowWindow(target.handle, 9) // SW_RESTORE
      // We are the foreground process right now, which allows SetForegroundWindow.
      w.SetForegroundWindow(target.handle)
      hideOwn()
      await delay(60)
      if (w.address(w.GetForegroundWindow()) !== w.address(target.handle)) {
        w.SetForegroundWindow(target.handle)
        await delay(60)
      }
      return
    }
    hideOwn()
    await delay(120)
    return
  }
  if (isMac) {
    hideOwn()
    app.hide()
    await delay(200)
    return
  }
  hideOwn()
  if (target?.xid && which('xdotool')) {
    await run('xdotool', ['windowactivate', '--sync', target.xid], { timeoutMs: 2000 }).catch(() => undefined)
  }
  await delay(150)
}

/**
 * Show one of our windows with keyboard focus. Windows refuses SetForegroundWindow from
 * background processes, so temporarily attach to the foreground thread's input queue.
 */
export function bringToFront(win: BrowserWindow): void {
  if (isWin) {
    const w = loadWin32()
    if (w) {
      try {
        const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
        const fgThread = w.GetWindowThreadProcessId(w.GetForegroundWindow(), [0])
        const self = w.GetCurrentThreadId()
        const attach = fgThread && fgThread !== self
        if (attach) w.AttachThreadInput(self, fgThread, true)
        w.SetForegroundWindowPtr(hwnd)
        w.BringWindowToTopPtr(hwnd)
        if (attach) w.AttachThreadInput(self, fgThread, false)
      } catch (err) {
        log.warn('bringToFront failed:', err)
      }
    }
  }
  if (isMac) app.focus({ steal: true })
  win.show()
  win.focus()
}

/**
 * Windows: Chromium receives a window's mouse input through a child window
 * (Chrome_RenderWidgetHostHWND). Hiding the window hides that child too, and showing the window
 * again doesn't bring it back when the page is never marked hidden (background throttling off).
 * Clicks then land on the top-level window, which, when it can't be focused, swallows the
 * mouse-down: the overlay pill's buttons stopped working after the first recording. Call this
 * after showing such a window again.
 */
export function restoreMouseInput(win: BrowserWindow): void {
  if (!isWin) return
  const w = loadWin32()
  if (!w) return
  try {
    const child = w.FindWindowExPtr(win.getNativeWindowHandle().readBigUInt64LE(0), 0n, 'Chrome_RenderWidgetHostHWND', null)
    if (child && !w.IsWindowVisiblePtr(child)) w.ShowWindowPtr(child, 4) // SW_SHOWNOACTIVATE
  } catch (err) {
    log.warn('restoreMouseInput failed:', err)
  }
}

const WS_EX_TOPMOST = 0x8n

/** Windows: whether an ordinary window is above this always-on-top one (which then shows behind it). */
function sunk(w: Win32, hwnd: bigint): boolean {
  let above = w.GetWindowPtr(hwnd, 3) // GW_HWNDPREV
  for (let i = 0; above && i < 2000; i++) {
    if (w.IsWindowVisiblePtr(above) && !(BigInt(w.GetWindowLongPtr(above, -20)) & WS_EX_TOPMOST)) return true // GWL_EXSTYLE
    above = w.GetWindowPtr(above, 3)
  }
  return false
}

/**
 * Windows: put an always-on-top window back above the others. While such a window is hidden,
 * Windows can move it below the ordinary ones without taking its always-on-top flag away (seen
 * after a day without a dictation: Speak's pill, and the hidden always-on-top windows of other
 * apps with it). Showing a window without activating it leaves it where it is in that order, so
 * the pill opened behind every other window, unseen, until Speak restarted. Call this after
 * showing such a window. Returns whether the window had sunk.
 */
export function raiseOnTop(win: BrowserWindow): boolean {
  if (!isWin) return false
  const w = loadWin32()
  try {
    if (!w) throw new Error('no Win32 bindings')
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
    const was = sunk(w, hwnd)
    w.SetWindowPosPtr(hwnd, -1n, 0, 0, 0, 0, 0x13) // HWND_TOPMOST; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    return was
  } catch (err) {
    log.warn('raiseOnTop failed:', err)
    win.moveTop()
    return false
  }
}
