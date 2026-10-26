// Generates the app and tray icons (no dependencies): node scripts/generate-icons.mjs
// Design: [ ··· ], three square dots inside the [ ] brackets of the app's buttons, on a
// rounded Tokyo Night tile. Each size is laid out on whole pixels (no blur), and the Windows
// .ico / macOS .icns carry one image per size.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- design

/** Glyph proportions in design units: [ ··· ], brackets around three square dots. */
const UNIT = {
  stroke: 7, // bracket stroke
  arm: 9, // arm length beyond the stroke
  height: 56, // bracket height
  side: 9, // gap between a bracket and the dots
  dot: 10, // dot size
  gap: 7 // gap between dots
}
const GLYPH_WIDTH = 2 * (UNIT.stroke + UNIT.side) + 3 * UNIT.dot + 2 * UNIT.gap

/**
 * Hand-tuned pixel sizes where plain rounding looks weak (dots shrinking to the bracket stroke,
 * or spreading apart). Tray 20 and 24 px are the 16 px tray glyph scaled by 1.25 and 1.5
 * (odd 3 px dots are fine there: without a tile, a half-pixel offset is invisible).
 */
const APP_HINTS = { 30: { dot: 4, gap: 1, height: 16 }, 32: { dot: 4, gap: 1 } }
const TRAY_HINTS = { 20: { stroke: 1, side: 3, gap: 1 }, 24: { dot: 3, gap: 1, side: 3, height: 15 } }

/**
 * Glyph rectangles at `scale` px per unit, snapped to whole pixels: within an icon every dot,
 * gap and stroke has the same integer size, and the dots sit exactly on the middle line.
 * Dots have an even size: the glyph's width has the parity of 3 dots, and every canvas is even,
 * so that keeps the glyph exactly centered.
 */
function layout(scale, hint = {}) {
  const px = (v, min = 1) => Math.max(min, Math.round(v * scale))
  const stroke = hint.stroke ?? px(UNIT.stroke)
  const arm = stroke + (hint.arm ?? px(UNIT.arm))
  const side = hint.side ?? px(UNIT.side)
  const dot = hint.dot ?? Math.max(2, 2 * Math.round((UNIT.dot * scale) / 2))
  const gap = hint.gap ?? px(UNIT.gap)
  const width = 2 * (stroke + side) + 3 * dot + 2 * gap
  const height = hint.height ?? dot + 2 * Math.max(stroke + 1, Math.round((UNIT.height * scale - dot) / 2))
  const rects = [
    ['B', 0, 0, stroke, height],
    ['B', 0, 0, arm, stroke],
    ['B', 0, height - stroke, arm, stroke],
    ['B', width - stroke, 0, stroke, height],
    ['B', width - arm, 0, arm, stroke],
    ['B', width - arm, height - stroke, arm, stroke]
  ]
  for (let i = 0; i < 3; i++) rects.push(['A', stroke + side + i * (dot + gap), (height - dot) / 2, dot, dot])
  return { width, height, rects }
}

// ---------------------------------------------------------------- rendering

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const TILE = hex('#1a1b26')
const TOKYO = { B: hex('#c0caf5'), A: hex('#7aa2f7') }
const mono = (rgb) => ({ B: rgb, A: rgb })
const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]
const RED = hex('#f7768e')

/** Coverage of a rounded square tile (4×4 supersampled; the glyph itself is pixel-exact). */
function tileCoverage(size, x, y) {
  const m = size * 0.04
  const r = size * 0.2
  let hits = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4
      const py = y + (sy + 0.5) / 4
      const qx = Math.abs(px - size / 2) - (size / 2 - m - r)
      const qy = Math.abs(py - size / 2) - (size / 2 - m - r)
      if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0) hits++
    }
  }
  return hits / 16
}

/** Render the glyph centered on a `size` canvas, `ratio` of its width, optionally on the tile. */
function render(size, palette, { tile = false, ratio, hint }) {
  const g = layout((ratio * size) / GLYPH_WIDTH, hint)
  const rgba = Buffer.alloc(size * size * 4)
  if (tile) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = tileCoverage(size, x, y)
        if (a) rgba.set([...TILE, Math.round(a * 255)], (y * size + x) * 4)
      }
    }
  }
  const ox = Math.floor((size - g.width) / 2)
  const oy = Math.floor((size - g.height) / 2)
  for (const [part, x, y, w, h] of g.rects) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) rgba.set([...palette[part], 255], ((oy + yy) * size + ox + xx) * 4)
  }
  return png(size, rgba)
}

/** App icon: the design at its native proportions on the tile. Tray: no tile, so the glyph is larger. */
const app = (size) => render(size, TOKYO, { tile: true, ratio: 0.65, hint: APP_HINTS[size] })
const tray = (size, rgb, ratio = 0.84) => render(size, mono(rgb), { ratio, hint: TRAY_HINTS[size] })
/** macOS menu-bar icons keep ~2 pt of margin around the glyph. */
const MAC_RATIO = 0.76

// ---------------------------------------------------------------- file formats

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Windows .ico with PNG-compressed entries. */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

/** macOS .icns with PNG entries (one per size and Retina variant). */
function icns(entries) {
  const blocks = entries.map(([type, data]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + blocks.reduce((n, b) => n + b.length, 0), 4)
  return Buffer.concat([head, ...blocks])
}

// ---------------------------------------------------------------- outputs

const out = (rel, data) => {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log('wrote', rel)
}

// Every size Windows requests at 100–200 % scaling (shell, taskbar, alt-tab).
const appIco = ico([16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256].map((size) => ({ size, data: app(size) })))

out('build/icon.png', app(1024)) // Linux + fallback
out('build/icon.ico', appIco)
out(
  'build/icon.icns',
  icns([
    ['icp4', app(16)],
    ['icp5', app(32)],
    ['icp6', app(64)],
    ['ic07', app(128)],
    ['ic08', app(256)],
    ['ic09', app(512)],
    ['ic10', app(1024)],
    ['ic11', app(32)],
    ['ic12', app(64)],
    ['ic13', app(256)],
    ['ic14', app(512)]
  ])
)
out('resources/icon.png', app(256))
out('resources/icon.ico', appIco)

// Windows/Linux tray: 16 px + HiDPI variants. "dark" = white glyph for dark taskbars.
for (const [size, suffix] of [
  [16, ''],
  [20, '@1.25x'],
  [24, '@1.5x'],
  [32, '@2x']
]) {
  out(`resources/tray-dark${suffix}.png`, tray(size, WHITE))
  out(`resources/tray-light${suffix}.png`, tray(size, BLACK))
  out(`resources/tray-recording${suffix}.png`, tray(size, RED))
}
// macOS menu bar: 18 pt; template = black, recolored by the system.
for (const [size, suffix] of [
  [18, ''],
  [36, '@2x']
]) {
  out(`resources/tray-mac-template${suffix}.png`, tray(size, BLACK, MAC_RATIO))
  out(`resources/tray-mac-recording${suffix}.png`, tray(size, RED, MAC_RATIO))
}
