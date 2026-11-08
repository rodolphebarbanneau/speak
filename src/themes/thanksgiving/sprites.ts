/**
 * The turkey, from the side, facing right, 18×14: c feather tips · k their dark band · T, t tail
 * feathers · B, b body · S its bronze sheen · W, w wing and its bars · H head · h its white crown
 * when it shows off · E eye · K beak · R, r snood and wattle · L legs.
 */
export const TURKEY = [
  '.....ccccc........',
  '...cckkkkkcc......',
  '..ckktTTTTkkc.....',
  '.cktTTTTtTTTkkHH..',
  '.ckTtTttttTtkkHEK.',
  'ckTtTtttttTTTkHHR.',
  'cktTtttttttTTkHRR.',
  'ckttttBBBBBBtHHr..',
  '.....BBBBBBSSB....',
  '.....BWWWWWBSB....',
  '.....BwwwwwBBB....',
  '.....bbbbbbbb.....',
  '.......bbbbb......',
  '.........LL.LL....'
]
/** Showing off: the tail fanned wider, the body puffed up, the wings down, the head flushed red. */
export const TURKEY_PROUD = [
  '....ccccccc.......',
  '..cckkkkkkkcc.....',
  '.cckTTTTTTTkcc....',
  'ccktTtTTtTtTkkhh..',
  'ckTTttttttTtTkhEK.',
  'ckTttttttttTTkRRR.',
  'kTTtttttttttTTRRR.',
  'kTTtttBBBBBBBRRr..',
  '.....BBBBBBSSBr...',
  '....BBWWWWWBSB....',
  '....BwwwwwwBBB....',
  '.....bWWWWWbb.....',
  '......bbbbbb......',
  '.........LL.LL....'
]
/** Walking, the tail half spread: two steps, the head bobbing forward on the second. */
export const TURKEY_STEP = [
  '..................',
  '..................',
  '..................',
  '......cc......HH..',
  '....cckkcc....HEK.',
  '...ckktTkkc...HHR.',
  '..ckTtTTTtkc..HRR.',
  '..ckTTBBBBBBBHHr..',
  '.ckTtBBBBBBSS.....',
  '.ckttBWWWWWBSB....',
  '.....BwwwwwBBB....',
  '.....bbbbbbbb.....',
  '.......bbbbb......',
  '.........LL.LL....'
]
export const TURKEY_STRIDE = [
  '..................',
  '..................',
  '..................',
  '......cc.......HH.',
  '....cckkcc.....HEK',
  '...ckktTkkc....HHR',
  '..ckTtTTTtkc...HRR',
  '..ckTTBBBBBBBBHHr.',
  '.ckTtBBBBBBSS.....',
  '.ckttBWWWWWBSB....',
  '.....BwwwwwBBB....',
  '.....bbbbbbbb.....',
  '.......bbbbb......',
  '........LL...LL...'
]
/** Pecking: the head down at the table. */
export const TURKEY_PECK = [
  '..................',
  '..................',
  '..................',
  '......cc..........',
  '....cckkcc........',
  '...ckktTkkc.......',
  '..ckTtTTTtkc......',
  '..ckTTBBBBBB......',
  '.ckTtBBBBBBSSBH...',
  '.ckttBWWWWWBSBH...',
  '.....BwwwwwBBBHH..',
  '.....bbbbbbbb.HEK.',
  '.......bbbbb..RR..',
  '.........LL.LL....'
]
export const TURKEY_COLORS: Record<string, string> = {
  c: '#f2e2c0',
  k: '#3a271b',
  T: '#b5652c',
  t: '#7d4a25',
  B: '#6f4326',
  b: '#4a2c19',
  S: '#8f5c33',
  W: '#a87445',
  w: '#e8c995',
  H: '#b9d3e3',
  h: '#eef4f8',
  E: '#15100c',
  K: '#f2c14e',
  R: '#e2463a',
  r: '#a92f2b',
  L: '#e5a35a'
}

/** A sheaf of wheat, tied with a cranberry ribbon, 11×14. Y, y grain · s straw · r ribbon. */
export const SHEAF = [
  '.....Y.....',
  '....yYy....',
  '.Y..yYy..Y.',
  'yYy.yYy.yYy',
  'yYy.yYy.yYy',
  'yYy..s..yYy',
  '.y.s.s.s.y.',
  '..s..s..s..',
  '...s.s.s...',
  '....sss....',
  '....rrr....',
  '....sss....',
  '...s.s.s...',
  '..s..s..s..'
]
export const SHEAF_COLORS: Record<string, string> = { Y: '#f0cf6a', y: '#d7a645', s: '#c99a4a', r: '#d4486c' }

/** A kernel of corn, 2×2. */
export const KERNEL = ['Yy', 'yo']
export const KERNEL_COLORS: Record<string, string> = { Y: '#f8dc7a', y: '#eab446', o: '#c98a2a' }
