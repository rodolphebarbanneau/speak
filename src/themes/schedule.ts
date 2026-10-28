/**
 * When each easter egg theme shows: from one date to another, as month-day (MM-DD), both days
 * included, every year. Speak reads the clock of the computer it runs on, so a theme comes and
 * goes by itself; a release is only needed to change the themes or this schedule. `theme` names
 * a folder next to this file. A range may run over the new year (December to January).
 */
export interface ScheduleEntry {
  theme: string
  from: string
  to: string
}

export const SCHEDULE: ScheduleEntry[] = [
  // Halloween, October 31, with a week on either side.
  { theme: 'halloween', from: '10-24', to: '11-07' },
  // Christmas, December 25, with a week on either side.
  { theme: 'christmas', from: '12-18', to: '01-01' }
]
