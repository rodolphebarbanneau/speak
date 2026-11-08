/**
 * A bottle of champagne, tilted (14 rows: its cork at the top, its base at the bottom): g glass,
 * G its gleam, d its shade · L label · f foil, F its shine · c cork, q its shaded side.
 */
export const BOTTLE = [
  '............cc..',
  '...........ccq..',
  '..........Fff...',
  '.........Fff....',
  '........Fff.....',
  '.....Gggff......',
  '....Lgggg.......',
  '...LLLggg.......',
  '..LLLLLgd.......',
  '.GgLLLLL........',
  'GgggLLL.........',
  'gggggL..........',
  '.gggd...........',
  '..gd............'
]
export const BOTTLE_COLORS: Record<string, string> = {
  g: '#1f6a43',
  G: '#7fd1a0',
  d: '#123f28',
  L: '#f4ecd6',
  f: '#e6b43e',
  F: '#fff2b5',
  c: '#d9b382',
  q: '#a9804f'
}
/** The foam spraying out of the neck when the cork pops: over the cork, above the drawing. */
export const SPRAY = ['.............w.w', '............w.w.', '..............ww', '...............w']
export const SPRAY_COLOR = '#fff8e6'

/** A flute of champagne beside the bottle, 5×12: o glass, O its shine · w the foam on top · a champagne. */
export const FLUTE = ['O...o', 'Owwwo', 'Oaaao', 'oaaao', 'oaaao', 'oaaao', 'oaaao', '.oao.', '..o..', '..o..', '..o..', '.ooo.']
export const FLUTE_COLORS: Record<string, string> = { o: '#9fb7c9', O: '#e4f1fa', w: '#fff8e6', a: '#f2c14e' }
/** Bubbles rising in the flute (its columns, and when each sets off, in seconds). */
export const BUBBLES = [
  { x: 1, delay: 0 },
  { x: 3, delay: -0.55 },
  { x: 2, delay: -1.1 }
]

/** Fireworks' and confetti's colors: champagne gold, rose, ice blue, lime, silver. */
export const SPARKS = ['#f5c451', '#ff7eb6', '#6fd8f2', '#b9f27c', '#e8ecf8']
