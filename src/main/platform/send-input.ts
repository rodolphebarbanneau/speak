import { log } from '../log'

/**
 * Windows keystrokes through SendInput with both the virtual key and the scan code, like a
 * physical keyboard. libuiohook sends virtual keys only (scan code 0), which apps that read
 * physical keys ignore (games built on SDL or raw input), and it can't tell when input is
 * blocked (anti-cheats such as FACEIT's block all synthetic input): SendInput reports it.
 */

const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const INPUT_KEYBOARD = 1
const MAPVK_VK_TO_VSC_EX = 4
/** sizeof(INPUT) on 64-bit Windows: type, padding, then a union sized by MOUSEINPUT. */
const INPUT_SIZE = 40

export const VK = { Ctrl: 0x11, Shift: 0x10, C: 0x43, V: 0x56, Insert: 0x2d } as const
/** Keys shared with the numpad: MapVirtualKey returns the numpad scan code, the dedicated key is the extended one. */
const EXTENDED = new Set<number>([VK.Insert])

interface Win32Input {
  SendInput: (count: number, inputs: Buffer, size: number) => number
  MapVirtualKeyW: (code: number, type: number) => number
}

let win32: Win32Input | null | undefined

function load(): Win32Input | null {
  if (win32 !== undefined) return win32
  win32 = null
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    win32 = {
      SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, const uint8_t *pInputs, int cbSize)'),
      MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)')
    } as Win32Input
  } catch (err) {
    log.warn('SendInput unavailable:', err)
  }
  return win32
}

/**
 * Press `modifiers`, tap `key`, release the modifiers, as one uninterruptible sequence.
 * False when Windows didn't take the input; null when SendInput is unavailable.
 */
export function sendKeyCombo(key: number, modifiers: number[]): boolean | null {
  const w = load()
  if (!w) return null
  const events = [
    ...modifiers.map((vk) => [vk, false] as const),
    [key, false] as const,
    [key, true] as const,
    ...[...modifiers].reverse().map((vk) => [vk, true] as const)
  ]
  const buf = Buffer.alloc(INPUT_SIZE * events.length)
  events.forEach(([vk, up], i) => {
    const scan = w.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX)
    // Extended keys have 0xE0xx scan codes (Insert is mapped to its numpad twin, hence EXTENDED).
    const extended = EXTENDED.has(vk) || (scan & 0xff00) === 0xe000
    const flags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0)
    const o = i * INPUT_SIZE
    buf.writeUInt32LE(INPUT_KEYBOARD, o) // type
    buf.writeUInt16LE(vk, o + 8) // ki.wVk
    buf.writeUInt16LE(scan & 0xff, o + 10) // ki.wScan
    buf.writeUInt32LE(flags, o + 12) // ki.dwFlags (time and dwExtraInfo stay 0)
  })
  const sent = w.SendInput(events.length, buf, INPUT_SIZE)
  if (sent !== events.length) log.warn(`SendInput delivered ${sent} of ${events.length} key events (synthetic input blocked?)`)
  return sent === events.length
}
