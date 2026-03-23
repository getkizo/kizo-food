/**
 * Auto clock-out service
 *
 * When an employee forgets to clock out, this service automatically closes
 * their shift at the scheduled end time defined in their weekly schedule.
 *
 * Rules:
 *  - Only runs 1 hour after the employee's scheduled end time, so employees
 *    who legitimately stay late are not cut off prematurely.
 *  - Sets clock_out to the scheduled end time (not the time the check runs).
 *  - Marks auto_clocked_out = 1 and records scheduled_end for audit trail.
 *  - Skips employees with no schedule, or no end time for that day.
 *  - Check runs every 15 minutes via setInterval.
 */

import { getDatabase } from '../db/connection'

/** Day-of-week keys matching the schedule JSON stored on employees */
const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
type DowKey = (typeof DOW_KEYS)[number]

interface ScheduleDay {
  start: string // HH:MM
  end: string   // HH:MM
}

type WeeklySchedule = Partial<Record<DowKey, ScheduleDay | null>>

interface OpenShift {
  id: string
  employee_id: string
  date: string          // YYYY-MM-DD (local)
  schedule: string | null
}

/**
 * Parse "HH:MM" into { hours, minutes }.
 */
function parseTime(hhmm: string): { hours: number; minutes: number } | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return { hours: parseInt(m[1], 10), minutes: parseInt(m[2], 10) }
}

/**
 * Build a local Date for a given date string and HH:MM time.
 * e.g. date='2026-02-22', time='21:30' → new Date(2026, 1, 22, 21, 30)
 */
function localDatetime(date: string, hhmm: string): Date | null {
  const parsed = parseTime(hhmm)
  if (!parsed) return null
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, parsed.hours, parsed.minutes, 0, 0)
}

/**
 * Run one pass: find all open shifts whose scheduled end was more than 1 hour
 * ago and close them at the scheduled end time.
 *
 * @returns number of shifts that were auto-closed
 */
export function runAutoClockOut(): number {
  const db = getDatabase()
  const now = new Date()

  const openShifts = db
    .query<OpenShift, []>(
      `SELECT ts.id, ts.employee_id, ts.date, e.schedule
       FROM timesheets ts
       JOIN employees e ON e.id = ts.employee_id
       WHERE ts.clock_out IS NULL`
    )
    .all()

  let closed = 0

  for (const shift of openShifts) {
    if (!shift.schedule) continue

    let weekly: WeeklySchedule
    try {
      weekly = JSON.parse(shift.schedule)
    } catch {
      continue
    }

    // Determine day-of-week from the local clock-in date
    const [year, month, day] = shift.date.split('-').map(Number)
    const clockInDate = new Date(year, month - 1, day)
    const dowKey = DOW_KEYS[clockInDate.getDay()]

    const daySchedule = weekly[dowKey]
    if (!daySchedule?.end) continue

    const scheduledEnd = localDatetime(shift.date, daySchedule.end)
    if (!scheduledEnd) continue

    // Only apply auto clock-out if now is >= scheduledEnd + 1 hour
    const cutoff = new Date(scheduledEnd.getTime() + 60 * 60 * 1000)
    if (now < cutoff) continue

    // Store clock_out as ISO UTC (consistent with manual clock-out) but
    // the time value it represents is the local scheduled end.
    const clockOutISO = scheduledEnd.toISOString()

    db.run(
      `UPDATE timesheets
       SET clock_out = ?, auto_clocked_out = 1, scheduled_end = ?
       WHERE id = ?`,
      [clockOutISO, daySchedule.end, shift.id]
    )

    console.log(
      `[auto-clockout] Closed shift ${shift.id} for employee ${shift.employee_id}` +
      ` on ${shift.date} at scheduled end ${daySchedule.end}`
    )
    closed++
  }

  return closed
}

/**
 * Start the auto clock-out background check.
 * Runs once immediately on startup, then every 15 minutes.
 *
 * @returns the interval handle (so callers can clearInterval on shutdown)
 */
export function startAutoClockOut(): ReturnType<typeof setInterval> {
  const INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

  // Immediate first run to catch anything that was missed before restart
  runAutoClockOut()

  return setInterval(() => {
    runAutoClockOut()
  }, INTERVAL_MS)
}
