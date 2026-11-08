/**
 * "Auld Lang Syne" (traditional, public domain), verse and chorus, as Wikipedia prints it: each
 * note, the beats it lasts, and the chord that starts with it, if one does (a plain harmony, F, B♭
 * and C7, at the start of each bar, and where a bar turns to its cadence).
 */
export type Chord = 'F' | 'Bb' | 'C7'

export const AULD: Array<[string, number, Chord?]> = [
  ['C4', 1],
  ['F4', 1.5, 'F'],
  ['F4', 0.5],
  ['F4', 1],
  ['A4', 1],
  ['G4', 1.5, 'C7'],
  ['F4', 0.5],
  ['G4', 1],
  ['A4', 1],
  ['F4', 1.5, 'F'],
  ['F4', 0.5],
  ['A4', 1],
  ['C5', 1],
  ['D5', 3, 'Bb'],
  ['D5', 1],
  ['C5', 1.5, 'F'],
  ['A4', 0.5],
  ['A4', 1],
  ['F4', 1],
  ['G4', 1.5, 'C7'],
  ['F4', 0.5],
  ['G4', 1],
  ['A4', 1],
  ['F4', 1.5, 'Bb'],
  ['D4', 0.5],
  ['D4', 1, 'C7'],
  ['C4', 1],
  ['F4', 3, 'F'],
  ['D5', 1],
  ['C5', 1.5, 'F'],
  ['A4', 0.5],
  ['A4', 1],
  ['F4', 1],
  ['G4', 1.5, 'C7'],
  ['F4', 0.5],
  ['G4', 1],
  ['D5', 1],
  ['C5', 1.5, 'F'],
  ['A4', 0.5],
  ['A4', 1],
  ['C5', 1],
  ['D5', 3, 'Bb'],
  ['D5', 1],
  ['C5', 1.5, 'F'],
  ['A4', 0.5],
  ['A4', 1],
  ['F4', 1],
  ['G4', 1.5, 'C7'],
  ['F4', 0.5],
  ['G4', 1],
  ['A4', 1],
  ['F4', 1.5, 'Bb'],
  ['D4', 0.5],
  ['D4', 1, 'C7'],
  ['C4', 1],
  ['F4', 3, 'F']
]

/** The chords' notes, under the melody. */
export const CHORDS: Record<Chord, string[]> = {
  F: ['F3', 'A3', 'C4'],
  Bb: ['F3', 'Bb3', 'D4'],
  C7: ['E3', 'Bb3', 'C4']
}
