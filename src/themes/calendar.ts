/**
 * Which theme the schedule (schedule.ts) gives for a date. Nothing else in here, so it can be
 * tested on its own.
 */
import { SCHEDULE, type ScheduleEntry } from './schedule'

/** The theme in season. */
export interface Season {
  /** The theme: a folder name. */
  id: string
  /**
   * This season of it ("christmas-2026", which runs into January 2027): turning the theme off
   * holds until its next season, or another theme's.
   */
  key: string
}

const monthDay = (date: string) => {
  const [month, day] = date.split('-').map(Number)
  return month * 100 + day
}

/** The year this entry's season started, if `today` (month × 100 + day) falls in it. */
function seasonStart(entry: ScheduleEntry, today: number, year: number): number | null {
  const from = monthDay(entry.from)
  const to = monthDay(entry.to)
  if (from <= to) return from <= today && today <= to ? year : null
  // Over the new year: its December days start this year's season, its January days end last year's.
  if (today >= from) return year
  return today <= to ? year - 1 : null
}

/** The theme the schedule gives for a date, if any. */
export function seasonAt(date: Date): Season | null {
  const today = (date.getMonth() + 1) * 100 + date.getDate()
  for (const entry of SCHEDULE) {
    const start = seasonStart(entry, today, date.getFullYear())
    if (start !== null) return { id: entry.theme, key: `${entry.theme}-${start}` }
  }
  return null
}
