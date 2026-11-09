/**
 * The devil, 15×15: h, H horns · o skin, O its highlight, s its shade · b brows · e eyes · m the
 * mouth, lit from inside by CSS · f fangs · g goatee.
 */
export const DEVIL = [
  'h.............h',
  'hh...........hh',
  '.hH.........Hh.',
  '..hH.ooooo.Hh..',
  '...HoOOooooh...',
  '..obboOooobbo..',
  '.oooobbobboooo.',
  '.sooeeoooeeoos.',
  '..ooooosooooo..',
  '..omoooooooomo.',
  '...omfmmmfmo...',
  '....ofmmmfo....',
  '.....sgggs.....',
  '......ggg......',
  '.......g.......'
]
export const DEVIL_COLORS: Record<string, string> = {
  h: '#7d1616',
  H: '#c23a26',
  o: '#e0342a',
  O: '#ff7a52',
  s: '#a3221c',
  b: '#2a0606',
  e: '#ffd23f',
  m: '#3a0806',
  f: '#fff4e0',
  g: '#2a0606'
}

/**
 * A flame, 8×12, in three frames side by side: r its red edge · o orange · y yellow · w the
 * white-hot core. Its bottom rows hide behind the pill.
 */
const FLAME_FRAMES = [
  '...r.... .....r.. .r......',
  '...rr... ....rr.. .r....r.',
  '..ror... ....ror. .rr..rr.',
  '..roor.. ...roor. .ror.ror',
  '.rooor.. ..rooor. .roorror',
  '.roooor. .roooor. rooooor.',
  'rooyyor. .rooyyor rooyyoor',
  'rooyyoor rooyyoor rooyyoor',
  'royywyor royywyor royywyor',
  'roywwyor roywwyor roywwyor',
  'roywwyor roywwyor roywwyor',
  'royywyor royywyor royywyor'
]
export const FLAMES = [0, 1, 2].map((i) => FLAME_FRAMES.map((row) => row.split(' ')[i]))
export const FLAME_COLORS: Record<string, string> = { r: '#c8200e', o: '#ff6a1a', y: '#ffc23a', w: '#fff3c4' }

/**
 * A gargoyle crouched on the pill's corner, facing right, 22×21: k its dark outline and cracks ·
 * G stone, g its shade, L its lit edge · e its eye, glowing (CSS) · c fangs and claws · m its open
 * mouth · w its folded wing, W the wing's bones.
 */
export const GARGOYLE = [
  '..k...................',
  '..kk..................',
  '..kWk.................',
  '..kwWk...........k....',
  '..kwwWk.....kk...kk...',
  '..kwwwWk.....kk.kLk...',
  '..kwwwwWk.....kkLGGk..',
  '...kwwwwWk...kLGGGGGk.',
  '...kwwwwwWk.kLGGkeGGGk',
  '....kwwwwwWkLGGGGGGGGk',
  '....kwwwwwkLGGGgkcmcmk',
  '.....kwwwkLGGGGkmmmmmk',
  '.....kwwkLGGGGGGkmcmck',
  '......kkLGGgGGGGGkkk..',
  '......kLGGGgGGkGGk....',
  '.....kLGGGGGgGkGGk....',
  '....kLGGGGGGgkkGGk....',
  '...kLGGGGGGGgk.kGGk...',
  '..kgGGGkGGGGgk.kGgk...',
  '.kggggkkggggkk.kggk...',
  '.k.kkk.kckckk..kckck..'
]
export const GARGOYLE_COLORS: Record<string, string> = {
  k: '#1c1a20',
  G: '#6e6874',
  g: '#4c4752',
  L: '#a29aa8',
  e: '#ff2a1a',
  c: '#e2dbe6',
  m: '#2a0606',
  w: '#3e3944',
  W: '#5f5966'
}

/** A trident, 7×24: i iron, I its shine · t its tips, red-hot (CSS). */
export const TRIDENT = [
  't..t..t',
  'tt.t.tt',
  'i..i..i',
  'i..i..i',
  'I..I..I',
  'iIiIiIi',
  '.iiIii.',
  '...I...',
  '...i...',
  '...I...',
  '...i...',
  '...I...',
  '...i...',
  '...I...',
  '...i...',
  '...I...',
  '...i...',
  '...I...',
  '...i...',
  '...I...',
  '...i...',
  '...I...',
  '...i...',
  '...I...'
]
export const TRIDENT_COLORS: Record<string, string> = { i: '#4a4350', I: '#8a8090', t: '#ff5a1c' }

/** A pitchfork, 7×24: its three tines curving up from the crosspiece, on a wooden shaft (d, D). */
export const PITCHFORK = [
  't.....t',
  'i..t..i',
  'i..i..i',
  'i..i..i',
  'I..I..I',
  '.i.i.i.',
  '..iIi..',
  '...D...',
  '...d...',
  '...D...',
  '...d...',
  '...D...',
  '...d...',
  '...D...',
  '...d...',
  '...D...',
  '...d...',
  '...D...',
  '...d...',
  '...D...',
  '...d...',
  '...D...',
  '...d...',
  '...D...'
]
export const PITCHFORK_COLORS: Record<string, string> = { ...TRIDENT_COLORS, d: '#5a3420', D: '#7a4a2c' }
