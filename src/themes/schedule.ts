/**
 * When each easter egg theme shows: around its holiday, from `before` days ahead of it to `after`
 * days past it, every year. A holiday is a date (Halloween, October 31) or a weekday of a month
 * (Thanksgiving, the fourth Thursday of November), so a holiday whose date moves needs nothing
 * more. Speak reads the clock of the computer it runs on, so a theme comes and goes by itself; a
 * release is only needed to change the themes or this schedule. `theme` names a folder next to
 * this file. The build checks the schedule (calendar.ts, scheduleProblems): real dates, and no
 * two themes' days overlapping.
 */

export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

/** A holiday's day, every year: a date, or the nth (or last) given weekday of a month. Months count from 1. */
export type Holiday = { month: number; day: number } | { month: number; weekday: Weekday; nth: 1 | 2 | 3 | 4 | 'last' }

export interface ScheduleEntry {
  theme: string
  /** The holiday, as settings name it ("a seasonal look around …"). */
  name: string
  holiday: Holiday
  /** Days it shows before the holiday, and after it (the holiday itself always). */
  before: number
  after: number
}

export const SCHEDULE: ScheduleEntry[] = [
  { theme: 'halloween', name: 'halloween', holiday: { month: 10, day: 31 }, before: 3, after: 1 },
  // Thanksgiving in the United States.
  { theme: 'thanksgiving', name: 'thanksgiving', holiday: { month: 11, weekday: 'thursday', nth: 4 }, before: 3, after: 1 },
  { theme: 'christmas', name: 'christmas', holiday: { month: 12, day: 25 }, before: 7, after: 1 },
  // New Year's Day: from New Year's Eve to January 2.
  { theme: 'new-year', name: 'the new year', holiday: { month: 1, day: 1 }, before: 1, after: 1 }
]
