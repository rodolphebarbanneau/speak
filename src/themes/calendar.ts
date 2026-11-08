/**
 * Which theme the schedule (schedule.ts) gives for a date, and whether a schedule holds together.
 * Nothing else in here, so it can be tested on its own.
 */
import { SCHEDULE, type Holiday, type ScheduleEntry, type Weekday } from './schedule'

/** The theme in season. */
export interface Season {
  /** The theme: a folder name. */
  id: string
  /**
   * This season of it, by its holiday's year ("christmas-2026"; "new-year-2027", from December
   * 31, 2026): turning the theme off holds until its next season, or another theme's.
   */
  key: string
}

/** In Date.getDay()'s order. */
const WEEKDAYS: Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_MS = 86_400_000

/** A date as a number of days, counted in UTC: a daylight saving change never makes a day longer or shorter. */
const dayNumber = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / DAY_MS

/** The holiday's date in `year`, as a day number. */
export function holidayIn(holiday: Holiday, year: number): number {
  if ('day' in holiday) return dayNumber(year, holiday.month, holiday.day)
  const weekday = WEEKDAYS.indexOf(holiday.weekday)
  if (holiday.nth === 'last') {
    const last = new Date(Date.UTC(year, holiday.month, 0)) // the month's last day
    return dayNumber(year, holiday.month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7))
  }
  const first = new Date(Date.UTC(year, holiday.month - 1, 1)).getUTCDay()
  return dayNumber(year, holiday.month, 1 + ((weekday - first + 7) % 7) + (holiday.nth - 1) * 7)
}

/** The days a theme shows around its holiday of `year`, both included. */
function daysAround(entry: ScheduleEntry, year: number): { from: number; to: number } {
  const day = holidayIn(entry.holiday, year)
  return { from: day - entry.before, to: day + entry.after }
}

/** The theme the schedule gives for a date, if any. */
export function seasonAt(date: Date, schedule: ScheduleEntry[] = SCHEDULE): Season | null {
  const today = dayNumber(date.getFullYear(), date.getMonth() + 1, date.getDate())
  for (const entry of schedule) {
    // Last year's holiday may still show in January, and next year's already in December.
    for (let year = date.getFullYear() - 1; year <= date.getFullYear() + 1; year++) {
      const { from, to } = daysAround(entry, year)
      if (from <= today && today <= to) return { id: entry.theme, key: `${entry.theme}-${year}` }
    }
  }
  return null
}

/** February has 28: a holiday must come every year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
/** Weekdays and leap years fall on the same dates again after 28 years: checking these covers them all. */
const CHECKED_YEARS = Array.from({ length: 28 }, (_, i) => 2001 + i)

/**
 * What's wrong with a schedule, if anything (the build stops on it): a date that isn't one, days
 * around it that aren't whole and positive, or two themes showing on the same day some year.
 */
export function scheduleProblems(schedule: ScheduleEntry[] = SCHEDULE): string[] {
  const problems: string[] = []
  const whole = (n: number) => Number.isInteger(n) && n >= 0
  for (const { theme, holiday, before, after } of schedule) {
    const { month } = holiday
    if (!(Number.isInteger(month) && month >= 1 && month <= 12)) problems.push(`${theme}: month ${month} is not 1 to 12`)
    else if ('day' in holiday && !(Number.isInteger(holiday.day) && holiday.day >= 1 && holiday.day <= DAYS_IN_MONTH[month - 1]))
      problems.push(`${theme}: ${month}-${holiday.day} is not a date every year`)
    if (!whole(before) || !whole(after)) problems.push(`${theme}: days before and after must be whole numbers, 0 or more`)
  }
  if (problems.length) return problems
  schedule.forEach((a, i) =>
    schedule.slice(i + 1).forEach((b) => {
      const clash = CHECKED_YEARS.find((year) =>
        [year - 1, year, year + 1].some((other) => {
          const x = daysAround(a, year)
          const y = daysAround(b, other)
          return x.from <= y.to && y.from <= x.to
        })
      )
      if (clash) problems.push(`${a.theme} and ${b.theme} would show on the same days (in ${clash}, for one)`)
    })
  )
  return problems
}
