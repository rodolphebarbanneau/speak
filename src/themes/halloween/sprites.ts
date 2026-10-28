/**
 * Jack-o'-lantern, 13×11. o body · r rib · h shine · s stem · l leaf · e face (eyes, nose,
 * mouth) · E right eye, which closes for the wink. The face is drawn over the body, lit by CSS.
 */
export const PUMPKIN = [
  '.......sl....',
  '......ss.....',
  '..ooooooooo..',
  '.ohorooorooo.',
  'oooeoooooEooo',
  'ooeeeoooEEEoo',
  'ooooooeoooooo',
  'ooeeoeeeoeeoo',
  'oooeeeoeeeooo',
  '.ooorooorooo.',
  '..ooooooooo..'
]
export const PUMPKIN_COLORS: Record<string, string> = {
  o: '#ff9e64',
  e: '#ff9e64',
  E: '#ff9e64',
  r: '#e07b45',
  h: '#ffc49a',
  s: '#6e8f3e',
  l: '#9ece6a'
}
/** The body under the face. */
export const PUMPKIN_BODY = PUMPKIN.map((row) => row.replace(/[eE]/g, 'o'))
/** The closed right eye: a dark line where the eye's bottom row was. */
export const PUMPKIN_LID = ['', '', '', '', '', '........xxx..']

/** A bat, wings up and down, 11×6. e eyes. */
export const BAT_UP = ['x.........x', 'xx..x.x..xx', 'xxx.exe.xxx', '.xxxxxxxxx.', '..x.xxx.x..', '.....x.....']
export const BAT_DOWN = ['...........', '....x.x....', '....exe....', '.xxxxxxxxx.', 'xxx.xxx.xxx', 'x....x....x']
export const BAT_COLORS: Record<string, string> = { x: '#6a5a8a', e: '#ff9e64' }
