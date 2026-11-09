import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { log } from '../../log'
import { paths } from '../../paths'
import { delay } from '../../util'
import { Bridge, BridgeAccessibility } from './bridge'
import { intersect, unavailable } from './common'
import { announce } from './hands'
import type { Button, Point, Rect, ScreenBackend, WindowInfo } from './types'

/**
 * Windows: the windows (what app, where) through Win32, a window's picture with PrintWindow (in
 * the background), its controls through UI Automation (a PowerShell bridge), and the mouse and
 * keyboard through SendInput, like a person's. Coordinates are physical screen pixels, as Windows
 * gives them to this (per-monitor DPI aware) process.
 */

interface Win32 {
  EnumWindows: (cb: bigint, l: number) => boolean
  IsWindowVisible: (h: number) => boolean
  IsWindow: (h: number) => boolean
  IsIconic: (h: number) => boolean
  GetWindowTextW: (h: number, buf: Buffer, max: number) => number
  GetWindowThreadProcessId: (h: number, pid: number[]) => number
  GetWindowLongPtrW: (h: number, idx: number) => number | bigint
  DwmGetWindowAttribute: (h: number, attr: number, buf: Buffer, size: number) => number
  OpenProcess: (access: number, inherit: boolean, pid: number) => number | bigint
  CloseHandle: (h: number | bigint) => boolean
  QueryFullProcessImageNameW: (h: number | bigint, flags: number, buf: Buffer, size: number[]) => boolean
  GetForegroundWindow: () => number | bigint
  SetForegroundWindow: (h: number) => boolean
  BringWindowToTop: (h: number) => boolean
  ShowWindow: (h: number, cmd: number) => boolean
  AttachThreadInput: (a: number, b: number, attach: boolean) => boolean
  GetCurrentThreadId: () => number
  WindowFromPoint: (pt: { x: number; y: number }) => number | bigint
  GetAncestor: (h: number, flags: number) => number | bigint
  GetWindow: (h: number, cmd: number) => number | bigint
  GetAsyncKeyState: (vk: number) => number
  SetWindowPos: (h: number, after: number, x: number, y: number, cx: number, cy: number, flags: number) => boolean
  SetCursorPos: (x: number, y: number) => boolean
  SendInput: (count: number, inputs: Buffer, size: number) => number
  MapVirtualKeyW: (code: number, type: number) => number
  VkKeyScanW: (ch: number) => number
  register: (fn: (h: number) => boolean) => bigint
  unregister: (cb: bigint) => void
  GetWindowRect: (h: number, r: Buffer) => boolean
  GetCursorPos: (pt: Buffer) => boolean
  GetDC: (h: number) => number | bigint
  ReleaseDC: (h: number, dc: number | bigint) => number
  CreateCompatibleDC: (dc: number | bigint) => number | bigint
  CreateCompatibleBitmap: (dc: number | bigint, w: number, h: number) => number | bigint
  SelectObject: (dc: number | bigint, obj: number | bigint) => number | bigint
  DeleteObject: (obj: number | bigint) => boolean
  DeleteDC: (dc: number | bigint) => boolean
  PrintWindow: (h: number, dc: number | bigint, flags: number) => boolean
  GetDIBits: (dc: number | bigint, bmp: number | bigint, start: number, lines: number, bits: Buffer, info: Buffer, usage: number) => number
}

function bind(): Win32 {
  const koffi = require('koffi') as typeof import('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const dwm = koffi.load('dwmapi.dll')
  const gdi32 = koffi.load('gdi32.dll')
  koffi.struct('SPEAK_POINT', { x: 'int32', y: 'int32' })
  const EnumProc = koffi.proto('bool __stdcall SpeakEnumWindowsProc(intptr_t hwnd, intptr_t lParam)')
  return {
    EnumWindows: user32.func('bool __stdcall EnumWindows(SpeakEnumWindowsProc *cb, intptr_t lParam)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t h)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr_t h)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t h)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t h, _Out_ uint8_t *buf, int max)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t h, _Out_ uint32 *pid)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t h, int idx)'),
    DwmGetWindowAttribute: dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr_t h, uint32 attr, _Out_ uint8_t *buf, uint32 size)'),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ uint8_t *buf, _Inout_ uint32 *size)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t h)'),
    BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr_t h)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t h, int cmd)'),
    AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool attach)'),
    GetCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(SPEAK_POINT pt)'),
    GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t h, uint32 flags)'),
    GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t h, uint32 cmd)'),
    GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int vk)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 count, const uint8_t *inputs, int size)'),
    MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 code, uint32 type)'),
    VkKeyScanW: user32.func('int16 __stdcall VkKeyScanW(uint16 ch)'),
    register: (fn) => koffi.register((h: number) => fn(Number(h)), koffi.pointer(EnumProc)),
    unregister: (cb) => koffi.unregister(cb),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t h, _Out_ uint8_t *r)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ uint8_t *pt)'),
    GetDC: user32.func('intptr_t __stdcall GetDC(intptr_t h)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr_t h, intptr_t dc)'),
    CreateCompatibleDC: gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t dc)'),
    CreateCompatibleBitmap: gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t dc, int w, int h)'),
    SelectObject: gdi32.func('intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t obj)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr_t dc)'),
    PrintWindow: user32.func('bool __stdcall PrintWindow(intptr_t h, intptr_t dc, uint32 flags)'),
    GetDIBits: gdi32.func(
      'int __stdcall GetDIBits(intptr_t dc, intptr_t bmp, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ uint8_t *info, uint32 usage)'
    )
  } as Win32
}

// ---------------------------------------------------------------- input

/** sizeof(INPUT) on 64-bit Windows. */
const INPUT_SIZE = 40
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const KEYEVENTF_UNICODE = 0x4
const MOUSE = { leftDown: 0x2, leftUp: 0x4, rightDown: 0x8, rightUp: 0x10, middleDown: 0x20, middleUp: 0x40, wheel: 0x800, hwheel: 0x1000 }

const MODIFIER_KEYS = [0x10, 0x11, 0x12, 0x5b, 0x5c] // Shift, Ctrl, Alt, the Windows keys
const MOUSE_BUTTONS = [0x01, 0x02, 0x04]

const VK: Record<string, number> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Shift: 0x10,
  Ctrl: 0x11,
  Alt: 0x12,
  Pause: 0x13,
  CapsLock: 0x14,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  Win: 0x5b,
  Menu: 0x5d,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b
}
const ALIASES: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  win: 'Win',
  windows: 'Win',
  super: 'Win',
  meta: 'Win',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  menu: 'Menu',
  capslock: 'CapsLock',
  printscreen: 'PrintScreen'
}
/** Keys sharing a scan code with the numpad: the dedicated keys are the extended ones. */
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5d])
/** A virtual key Windows leaves unassigned: no app does anything with it (see focusWindow). */
const MASK_KEY = 0xe8

// ---------------------------------------------------------------- UI Automation

/**
 * Speak's bridge to UI Automation: a PowerShell process kept for the session, answering JSON lines.
 * It keeps the elements it listed per window, so that the AI can act on them by number, in the
 * background: press (invoke, toggle, select, expand), fill (set a field's value), scroll, focus.
 */
const UIA_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SpeakDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][SpeakDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.ControlType]
$keep = @{}
foreach ($n in 'Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem','RadioButton','Slider','Spinner','SplitButton','TabItem','TreeItem','DataItem','Document','Text','Menu','Header','HeaderItem') { $keep[$T::($n).Id] = $n.ToLower() }
$script:snap = @{}

function Elements($hwnd, $max) {
  $root = $A::FromHandle([IntPtr]::new([long]$hwnd))
  $cache = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in $A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty, $A::IsEnabledProperty, $A::IsPasswordProperty, $A::AutomationIdProperty, $A::HasKeyboardFocusProperty) { $cache.Add($p) }
  $cache.Add([System.Windows.Automation.ValuePattern]::Pattern)
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
  $cond = New-Object System.Windows.Automation.PropertyCondition($A::IsOffscreenProperty, $false)
  $act = $cache.Activate()
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) } finally { $act.Dispose() }
  $out = New-Object System.Collections.ArrayList
  $kept = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    if ($out.Count -ge $max) { break }
    $c = $e.Cached
    $type = $keep[$c.ControlType.Id]
    if (-not $type) { continue }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 2 -or $r.Height -lt 2) { continue }
    $name = [string]$c.Name
    if ($type -eq 'text' -and -not $name) { continue }
    $o = [ordered]@{ type = $type; name = $name.Substring(0, [Math]::Min(120, $name.Length)); x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    if (-not $c.IsEnabled) { $o.disabled = $true }
    if ($c.IsPassword) { $o.password = $true }
    if ($c.HasKeyboardFocus) { $o.focused = $true }
    if ($c.AutomationId) { $o.aid = [string]$c.AutomationId }
    if (-not $c.IsPassword) {
      try { $v = $e.GetCachedPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value; if ($v) { $o.value = $v.Substring(0, [Math]::Min(300, $v.Length)) } } catch {}
    }
    [void]$out.Add($o)
    [void]$kept.Add($e)
  }
  $script:snap["$hwnd"] = $kept
  return $out
}

function Get($hwnd, $index) {
  $list = $script:snap["$hwnd"]
  if (-not $list -or $index -lt 1 -or $index -gt $list.Count) { throw "No element e$index for this window: list its elements again." }
  return $list[$index - 1]
}

function Press($e) {
  [object]$p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return 'toggle' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return 'select' }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
    if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $p.Expand() } else { $p.Collapse() }
    return 'expand'
  }
  return $null
}

function Fill($e, $text) {
  [object]$p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly) { $p.SetValue([string]$text); return 'value' }
  return $null
}

function ScrollIn($hwnd, $index, $dy) {
  [object]$p = $null
  if ($index) {
    $cur = Get $hwnd $index
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  } else {
    $root = $A::FromHandle([IntPtr]::new([long]$hwnd))
    $cond = New-Object System.Windows.Automation.PropertyCondition($A::IsScrollPatternAvailableProperty, $true)
    $cur = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $walker = $null
  }
  while ($cur) {
    if ($cur.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p) -and $p.Current.VerticallyScrollable) {
      $amount = if ($dy -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
      for ($i = 0; $i -lt [Math]::Abs([int]$dy) * 3; $i++) { $p.ScrollVertical($amount) }
      return 'scroll'
    }
    if (-not $walker) { break }
    $cur = $walker.GetParent($cur)
  }
  return $null
}

function Focused() {
  $e = $A::FocusedElement
  if (-not $e) { return $null }
  $c = $e.Current
  return [ordered]@{ type = $keep[$c.ControlType.Id]; name = [string]$c.Name; password = [bool]$c.IsPassword; pid = [int]$c.ProcessId }
}

# The text just before the cursor, in the field with the keyboard (to check what was typed). Never a password's.
function BeforeCursor($n) {
  $e = $A::FocusedElement
  if (-not $e) { return $null }
  $c = $e.Current
  $o = [ordered]@{ pid = [int]$c.ProcessId }
  if ($c.IsPassword) { $o.password = $true; return $o }
  [object]$p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) {
    $sel = $p.GetSelection()
    if ($sel.Length -gt 0) {
      $ends = [System.Windows.Automation.Text.TextPatternRangeEndpoint]
      $r = $sel[0].Clone()
      # The cursor is where the selection starts (an app may select what it suggests after it).
      [void]$r.MoveEndpointByRange($ends::End, $r, $ends::Start)
      [void]$r.MoveEndpointByUnit($ends::Start, [System.Windows.Automation.Text.TextUnit]::Character, -[int]$n)
      $o.text = $r.GetText([int]$n)
      return $o
    }
  }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
    $v = [string]$p.Current.Value
    $o.value = $v.Substring([Math]::Max(0, $v.Length - 4000))
  }
  return $o
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$stdin = [Console]::In
Write-Output (ConvertTo-Json -Compress @{ ready = $true })
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  $res = @{}
  try {
    $req = ConvertFrom-Json $line
    $res.id = $req.id
    # Speak stopped waiting: acting now would be too late.
    if ($req.until -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [long]$req.until) { $req = @{ op = 'expired' } }
    switch ($req.op) {
      'expired' { $res.error = 'expired' }
      'elements' { $res.elements = @(Elements $req.hwnd $req.max) }
      'focused' { $res.focused = Focused }
      'before' { $res.before = BeforeCursor $req.n }
      'press' { $res.done = Press (Get $req.hwnd $req.index) }
      'fill' { $res.done = Fill (Get $req.hwnd $req.index) $req.text }
      'scroll' { $res.done = ScrollIn $req.hwnd $req.index $req.dy }
      'focus' { (Get $req.hwnd $req.index).SetFocus(); $res.done = 'focus' }
      default { $res.error = "unknown op $($req.op)" }
    }
  } catch { $res.error = $_.Exception.Message }
  Write-Output (ConvertTo-Json -Compress -Depth 5 $res)
}
`

// ---------------------------------------------------------------- the backend

export function createWin32Backend(): ScreenBackend {
  let w: Win32
  try {
    w = bind()
  } catch (err) {
    log.warn('Control: Win32 bindings unavailable:', err)
    const error = `Speak could not reach Windows to control apps: ${(err as Error).message}`
    return unavailable(error)
  }

  const exeCache = new Map<number, string>()

  function exeOf(pid: number): string {
    const known = exeCache.get(pid)
    if (known !== undefined) return known
    let exe = ''
    const h = w.OpenProcess(0x1000, false, pid) // PROCESS_QUERY_LIMITED_INFORMATION
    if (h) {
      const buf = Buffer.alloc(2080)
      const size = [1040]
      if (w.QueryFullProcessImageNameW(h, 0, buf, size))
        exe =
          buf
            .toString('utf16le', 0, size[0] * 2)
            .split(/[\\/]/)
            .pop() ?? ''
      w.CloseHandle(h)
    }
    exeCache.set(pid, exe)
    return exe
  }

  function info(h: number, fg: number): WindowInfo | null {
    if (!w.IsWindowVisible(h)) return null
    const buf = Buffer.alloc(1024)
    const n = w.GetWindowTextW(h, buf, 512)
    const title = buf.toString('utf16le', 0, n * 2)
    if (!title) return null
    const cloaked = Buffer.alloc(4)
    w.DwmGetWindowAttribute(h, 14, cloaked, 4) // DWMWA_CLOAKED: on another virtual desktop, or a hidden UWP frame
    if (cloaked.readUInt32LE(0)) return null
    if (Number(w.GetWindowLongPtrW(h, -20)) & 0x80) return null // WS_EX_TOOLWINDOW
    const r = Buffer.alloc(16)
    w.DwmGetWindowAttribute(h, 9, r, 16) // DWMWA_EXTENDED_FRAME_BOUNDS: the visible frame, without the invisible resize borders
    const pid = [0]
    w.GetWindowThreadProcessId(h, pid)
    const rect = { x: r.readInt32LE(0), y: r.readInt32LE(4), w: r.readInt32LE(8) - r.readInt32LE(0), h: r.readInt32LE(12) - r.readInt32LE(4) }
    return { id: h, title, pid: pid[0], exe: exeOf(pid[0]), rect, minimized: w.IsIconic(h), focused: h === fg }
  }

  /** What Speak sends, announced to the input hook (see hands.ts). */
  function announceInput(buf: Buffer, count: number): void {
    for (let i = 0; i < count; i++) {
      const o = i * INPUT_SIZE
      if (buf.readUInt32LE(o) === INPUT_KEYBOARD) {
        const flags = buf.readUInt32LE(o + 12)
        if (!(flags & KEYEVENTF_KEYUP)) announce(flags & KEYEVENTF_UNICODE ? 'packet' : 'key')
      } else if (buf.readUInt32LE(o + 20) & (MOUSE.leftDown | MOUSE.rightDown | MOUSE.middleDown | MOUSE.wheel | MOUSE.hwheel)) {
        announce('mouse')
      }
    }
  }

  function send(buf: Buffer, count: number): void {
    const sent = w.SendInput(count, buf, INPUT_SIZE)
    announceInput(buf, sent)
    if (sent !== count) throw new Error('Windows did not take the input (an app running as administrator, or a secure screen, is in front).')
  }

  function mouseEvents(events: Array<{ flags: number; data?: number }>): void {
    const buf = Buffer.alloc(INPUT_SIZE * events.length)
    events.forEach((e, i) => {
      const o = i * INPUT_SIZE
      buf.writeUInt32LE(INPUT_MOUSE, o)
      buf.writeInt32LE(e.data ?? 0, o + 16) // mi.mouseData
      buf.writeUInt32LE(e.flags, o + 20) // mi.dwFlags
    })
    send(buf, events.length)
  }

  function keyEvents(keys: Array<[number, boolean]>): void {
    const buf = Buffer.alloc(INPUT_SIZE * keys.length)
    keys.forEach(([vk, up], i) => {
      const scan = w.MapVirtualKeyW(vk, 4) // MAPVK_VK_TO_VSC_EX
      const extended = EXTENDED.has(vk) || (scan & 0xff00) === 0xe000
      const o = i * INPUT_SIZE
      buf.writeUInt32LE(INPUT_KEYBOARD, o)
      buf.writeUInt16LE(vk, o + 8)
      buf.writeUInt16LE(scan & 0xff, o + 10)
      buf.writeUInt32LE((up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0), o + 12)
    })
    send(buf, keys.length)
  }

  /** "ctrl+shift+s", "enter", "alt+f4" → virtual keys; throws on a key it doesn't know. */
  function parseKeys(combo: string): number[] {
    return combo
      .split('+')
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => {
        const name = ALIASES[k.toLowerCase()] ?? (VK[k] !== undefined ? k : /^f([1-9]|1[0-2])$/i.test(k) ? k.toUpperCase() : '')
        if (name && VK[name] !== undefined) return VK[name]
        if (k.length === 1) {
          const scan = w.VkKeyScanW(k.charCodeAt(0))
          if (scan !== -1) return scan & 0xff
        }
        throw new Error(`Unknown key "${k}"`)
      })
  }

  function foreground(): number {
    return Number(w.GetForegroundWindow())
  }

  const MOUSE_FLAGS: Record<Button, [number, number]> = {
    left: [MOUSE.leftDown, MOUSE.leftUp],
    right: [MOUSE.rightDown, MOUSE.rightUp],
    middle: [MOUSE.middleDown, MOUSE.middleUp]
  }

  const a11y = new BridgeAccessibility(
    new Bridge(() => {
      const file = join(paths.tmp, 'speak-uia.ps1')
      writeFileSync(file, UIA_SCRIPT, 'utf8')
      return { label: 'UI Automation', command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] }
    })
  )

  return {
    unsupported: () => null,
    mod: 'ctrl',
    a11y,
    refresh: async () => undefined,

    /** The windows on screen, front to back: titled, visible, not Speak's own. */
    listWindows(): WindowInfo[] {
      const fg = foreground()
      const out: WindowInfo[] = []
      const cb = w.register((h) => {
        const i = info(h, fg)
        if (i && i.pid !== process.pid) out.push(i)
        return true
      })
      try {
        w.EnumWindows(cb, 0)
      } finally {
        w.unregister(cb)
      }
      return out
    },

    windowInfo(id: number): WindowInfo | null {
      if (!w.IsWindow(id)) return null
      return info(id, foreground())
    },

    foregroundWindow(): WindowInfo | null {
      const fg = foreground()
      return fg ? info(fg, fg) : null
    },

    /** The top-level window under a point. */
    windowAt(x: number, y: number): WindowInfo | null {
      const h = Number(w.WindowFromPoint({ x, y }))
      if (!h) return null
      const root = Number(w.GetAncestor(h, 2)) || h // GA_ROOT
      const fg = foreground()
      const pid = [0]
      w.GetWindowThreadProcessId(root, pid)
      const i = info(root, fg)
      return i ?? { id: root, title: '', pid: pid[0], exe: exeOf(pid[0]), rect: { x, y, w: 0, h: 0 }, minimized: false, focused: root === fg }
    },

    /**
     * Bring a window to the front with the keyboard focus. Windows only lets the foreground process
     * do that: Speak borrows the foreground thread's input queue, and presses Alt (which unlocks it).
     * Never Alt alone: pressed and released by itself, Alt shows an app's access keys (a letter on
     * each button), and the next key Speak types presses one instead (in Notepad, "b" is Bold). A key
     * no app uses, in between, keeps it from being Alt alone.
     */
    async focusWindow(id: number): Promise<boolean> {
      if (!w.IsWindow(id)) return false
      if (w.IsIconic(id)) w.ShowWindow(id, 9) // SW_RESTORE
      if (foreground() === id) return true
      const fgThread = w.GetWindowThreadProcessId(foreground(), [0])
      const self = w.GetCurrentThreadId()
      const attach = fgThread && fgThread !== self
      if (attach) w.AttachThreadInput(self, fgThread, true)
      keyEvents([
        [VK.Alt, false],
        [MASK_KEY, false],
        [MASK_KEY, true],
        [VK.Alt, true]
      ])
      w.SetForegroundWindow(id)
      w.BringWindowToTop(id)
      if (attach) w.AttachThreadInput(self, fgThread, false)
      await delay(120)
      return foreground() === id
    },

    /** A minimized window shown again without taking the focus (to look at it, or read its controls). */
    async unminimize(id: number): Promise<void> {
      if (!w.IsIconic(id)) return
      w.ShowWindow(id, 4) // SW_SHOWNOACTIVATE
      await delay(250)
    },

    hasKeyboard(id: number): boolean {
      const fg = foreground()
      return !!fg && (fg === id || Number(w.GetAncestor(fg, 3)) === id) // GA_ROOTOWNER
    },

    /** Asked of Windows directly, ahead of the hook. */
    held() {
      const down = (vk: number) => (w.GetAsyncKeyState(vk) & 0x8000) !== 0
      return { modifiers: MODIFIER_KEYS.some(down), buttons: MOUSE_BUTTONS.some(down) }
    },

    cursorPos(): Point {
      const buf = Buffer.alloc(8)
      w.GetCursorPos(buf)
      return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) }
    },

    /** SetCursorPos: the hook doesn't see it, nor do apps until the next button (a drag's moves included). */
    movePointer(x: number, y: number): void {
      w.SetCursorPos(Math.round(x), Math.round(y))
    },

    button(button: Button, down: boolean): void {
      mouseEvents([{ flags: MOUSE_FLAGS[button][down ? 0 : 1] }])
    },

    wheel(_at: Point, dy: number, dx: number): void {
      if (dy) mouseEvents([{ flags: MOUSE.wheel, data: -Math.round(dy) * 120 }])
      if (dx) mouseEvents([{ flags: MOUSE.hwheel, data: Math.round(dx) * 120 }])
    },

    pressKeys(combo: string): void {
      const vks = parseKeys(combo)
      if (!vks.length) throw new Error('No key to press')
      keyEvents([...vks.map((vk) => [vk, false] as [number, boolean]), ...[...vks].reverse().map((vk) => [vk, true] as [number, boolean])])
    },

    /**
     * As Unicode packets: any keyboard layout, and no key's meaning (a tab is a tab, not the next
     * field). A character beyond the basic plane goes as its two halves, in one burst.
     */
    typeChar(ch: string): void {
      const buf = Buffer.alloc(INPUT_SIZE * ch.length * 2)
      for (let i = 0; i < ch.length; i++) {
        for (const up of [false, true]) {
          const o = (i * 2 + (up ? 1 : 0)) * INPUT_SIZE
          buf.writeUInt32LE(INPUT_KEYBOARD, o)
          buf.writeUInt16LE(ch.charCodeAt(i), o + 10)
          buf.writeUInt32LE(KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), o + 12)
        }
      }
      send(buf, ch.length * 2)
    },

    /**
     * Keep the frame just above `target` in the z-order, as if part of it: a window that covers the
     * target covers it too, and so do Speak's panel and pill (always on top).
     */
    stackAbove(h: number, target: number): void {
      if (!w.IsWindow(target)) return
      const above = Number(w.GetWindow(target, 3)) // GW_HWNDPREV
      if (above === h) return
      // The target is the first of the ordinary windows: the frame goes first (still under those on top).
      const topmost = above !== 0 && (Number(w.GetWindowLongPtrW(above, -20)) & 0x8) !== 0 // GWL_EXSTYLE, WS_EX_TOPMOST
      // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER
      w.SetWindowPos(h, above === 0 || topmost ? 0 : above, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x200)
    },

    /**
     * A window's picture as it draws itself, even behind other windows or on another screen, without
     * bringing it forward (PrintWindow with PW_RENDERFULLCONTENT). Null when the app doesn't draw that
     * way (an empty, black picture): then it has to come to the front to be seen.
     */
    async captureWindow(win: WindowInfo): Promise<{ image: Electron.NativeImage; area: Rect } | null> {
      const id = win.id
      if (!w.IsWindow(id)) return null
      const wr = Buffer.alloc(16)
      w.GetWindowRect(id, wr)
      const outer = { x: wr.readInt32LE(0), y: wr.readInt32LE(4), w: wr.readInt32LE(8) - wr.readInt32LE(0), h: wr.readInt32LE(12) - wr.readInt32LE(4) }
      const frame = info(id, 0)?.rect ?? outer
      if (outer.w <= 0 || outer.h <= 0 || outer.w > 16384 || outer.h > 16384) return null
      const screenDc = w.GetDC(0)
      const dc = w.CreateCompatibleDC(screenDc)
      const bmp = w.CreateCompatibleBitmap(screenDc, outer.w, outer.h)
      const old = w.SelectObject(dc, bmp)
      try {
        if (!w.PrintWindow(id, dc, 2)) return null // PW_RENDERFULLCONTENT
        const header = Buffer.alloc(44)
        header.writeUInt32LE(40, 0) // biSize
        header.writeInt32LE(outer.w, 4)
        header.writeInt32LE(-outer.h, 8) // top-down
        header.writeUInt16LE(1, 12) // biPlanes
        header.writeUInt16LE(32, 14) // biBitCount
        const pixels = Buffer.alloc(outer.w * outer.h * 4)
        w.SelectObject(dc, old)
        if (!w.GetDIBits(dc, bmp, 0, outer.h, pixels, header, 0)) return null
        // GDI leaves alpha at 0: opaque it. And an all-black picture is an app that didn't draw.
        let lit = 0
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i + 3] = 255
          if (lit < 64 && (pixels[i] > 16 || pixels[i + 1] > 16 || pixels[i + 2] > 16) && i % 4096 === 0) lit++
        }
        if (lit < 4) return null
        const image = nativeImage.createFromBitmap(pixels, { width: outer.w, height: outer.h })
        const part = intersect(frame, outer) ?? outer
        return { image: image.crop({ x: part.x - outer.x, y: part.y - outer.y, width: part.w, height: part.h }), area: part }
      } finally {
        w.SelectObject(dc, old)
        w.DeleteObject(bmp)
        w.DeleteDC(dc)
        w.ReleaseDC(0, screenDc)
      }
    },

    /** Speak's windows are already out of the generic screenshot (excluded from capture). */
    captureArea: async () => null
  }
}
