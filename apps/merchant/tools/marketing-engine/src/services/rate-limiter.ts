/**
 * Per-IP rate limiting using the rate_limits table.
 * Buckets: 1-minute windows (10 scans/min), 1-hour windows (50 scans/hr).
 */

import { getDatabase } from '../db/connection'

const PER_MINUTE_LIMIT = 10
const PER_HOUR_LIMIT   = 50

/** Floor a unix-ms timestamp to the current 1-minute bucket. */
function minuteBucket(now: number): number {
  return Math.floor(now / 60_000) * 60_000
}

/** Floor a unix-ms timestamp to the current 1-hour bucket. */
function hourBucket(now: number): number {
  return Math.floor(now / 3_600_000) * 3_600_000
}

export interface RateCheckResult {
  allowed:   boolean
  perMinute: number
  perHour:   number
}

/**
 * Check rate limit and increment counters.
 * Returns whether the request is allowed and current counts.
 * Always increments — call before deciding to log the scan.
 */
export function checkAndIncrement(ipHash: string): RateCheckResult {
  const db  = getDatabase()
  const now = Date.now()
  const min = minuteBucket(now)
  const hr  = hourBucket(now)

  // Upsert minute bucket
  db.run(`
    INSERT INTO rate_limits (ip_hash, window_start, count)
    VALUES (?, ?, 1)
    ON CONFLICT(ip_hash, window_start) DO UPDATE SET count = count + 1
  `, [ipHash, min])

  // Upsert hour bucket
  db.run(`
    INSERT INTO rate_limits (ip_hash, window_start, count)
    VALUES (?, ?, 1)
    ON CONFLICT(ip_hash, window_start) DO UPDATE SET count = count + 1
  `, [ipHash, hr])

  const minRow = db.query<{ count: number }, [string, number]>(
    `SELECT count FROM rate_limits WHERE ip_hash = ? AND window_start = ?`
  ).get(ipHash, min)

  const hrRow = db.query<{ count: number }, [string, number]>(
    `SELECT count FROM rate_limits WHERE ip_hash = ? AND window_start = ?`
  ).get(ipHash, hr)

  const perMinute = minRow?.count ?? 1
  const perHour   = hrRow?.count  ?? 1
  const allowed   = perMinute <= PER_MINUTE_LIMIT && perHour <= PER_HOUR_LIMIT

  // Prune old buckets periodically (keep last 2 hours)
  if (Math.random() < 0.01) {
    db.run(`DELETE FROM rate_limits WHERE window_start < ?`, [now - 7_200_000])
  }

  return { allowed, perMinute, perHour }
}
