/**
 * A Christmas tree, 13×14. S star · G branches · g their shaded side · T trunk · r, y, b
 * baubles (red, gold, blue), lit and twinkling by CSS.
 */
export const TREE = [
  '......S......',
  '.....SSS.....',
  '......S......',
  '.....gGG.....',
  '....grGGG....',
  '...gGGGyGG...',
  '....gGGGG....',
  '...gbGGGGrG..',
  '..gGGGGGGGGG.',
  '...gGyGGGbG..',
  '..gGGGGGGGGG.',
  '.grGGGGyGGGbG',
  '......TT.....',
  '......TT.....'
]
export const TREE_COLORS: Record<string, string> = {
  S: '#ffd75e',
  G: '#4abe68',
  g: '#2e8c4e',
  T: '#8a5a3b',
  r: '#4abe68',
  y: '#4abe68',
  b: '#4abe68'
}
/** The star's sparkle: rays that flash out around it now and then. */
export const TREE_SPARKLE = ['.....s.s.....', '....s...s....', '.....s.s.....']

/** Snowflakes. */
export const FLAKE_BIG = ['..x..', 'x.x.x', '.xxx.', 'x.x.x', '..x..']
export const FLAKE_SMALL = ['.x.', 'xxx', '.x.']
export const FLAKE_DOT = ['x']
export const FLAKE_COLORS: Record<string, string> = { x: '#eef3f0' }
