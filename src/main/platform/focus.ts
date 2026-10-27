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
      ShowWindowPtr: user32.func('ShowWindow', 'bool', ['intptr_t', 'int'])
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
