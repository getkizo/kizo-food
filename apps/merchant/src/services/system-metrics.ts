/**
 * system-metrics.ts — Hourly req_per_min sampler for COSA Phase D
 *
 * Persists one `req_per_min` sample per UTC hour to the `system_metrics` table
 * so that `GET /api/status` can compute a 24-hour baseline and set
 * `security.anomalous_req_rate` when the current rate is 10× above normal.
 *
 * ── Design ────────────────────────────────────────────────────────────────
 *   • `sampled_at` is a UTC hour string ('YYYY-MM-DD HH:00:00').
 *     `INSERT OR REPLACE` makes it idempotent — server restarts within the
 *     same hour just overwrite the row rather than creating a duplicate.
 *   • Rows older than 25 hours are pruned on each insert (rolling window).
 *   • The first sample fires 5 s after startup so the DB is ready.
 *     Subsequent samples align to the next UTC hour boundary, then repeat
 *     on the hour.
 *   • `getBaselineReqPerMin()` returns the median of the last 24 samples,
 *     or `null` when fewer than 3 samples exist (avoids false alerts on a
 *     freshly deployed appliance).
 */

import { getDatabase } from '../db/connection'
import { getReqPerMin } from '../utils/req-counter'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many hourly samples to keep (one full day + 1 hour buffer). */
const RETENTION_HOURS = 25

/** Minimum samples before baseline is considered reliable. */
const MIN_SAMPLES_FOR_BASELINE = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the current UTC hour as a 'YYYY-MM-DD HH:00:00' string. */
function utcHourKey(): string {
  const now = new Date()
  const y  = now.getUTCFullYear()
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d  = String(now.getUTCDate()).padStart(2, '0')
  const h  = String(now.getUTCHours()).padStart(2, '0')
  return `${y}-${mo}-${d} ${h}:00:00`
}

/** Milliseconds until the next UTC hour boundary. */
function msUntilNextHour(): number {
  const now = Date.now()
  return 3_600_000 - (now % 3_600_000)
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Record the current `req_per_min` value in `system_metrics` for the current
 * UTC hour.  Idempotent — safe to call multiple times within the same hour.
 * Never throws.
 */
export function recordHourlySample(): void {
  try {
    const db       = getDatabase()
    const key      = utcHourKey()
    const value    = getReqPerMin()

    db.run(
      `INSERT OR REPLACE INTO system_metrics (sampled_at, metric, value) VALUES (?, 'req_per_min', ?)`,
      [key, value],
    )

    // Prune rows outside the retention window
    db.run(
      `DELETE FROM system_metrics WHERE metric = 'req_per_min' AND sampled_at < datetime('now', ?)`,
      [`-${RETENTION_HOURS} hours`],
    )
  } catch (err) {
    console.warn('[system-metrics] failed to record hourly sample:', (err as Error)?.message ?? err)
  }
}

/**
 * Return the **median** `req_per_min` across the last 24 hourly samples.
 *
 * Returns `null` when fewer than `MIN_SAMPLES_FOR_BASELINE` (3) samples exist,
 * so callers can skip anomaly detection rather than trigger false alerts on a
 * freshly deployed appliance.
 */
export function getBaselineReqPerMin(): number | null {
  try {
    const db   = getDatabase()
    const rows = db.query<{ value: number }, []>(
      `SELECT value FROM system_metrics WHERE metric = 'req_per_min' ORDER BY sampled_at DESC LIMIT 24`,
    ).all()

    if (rows.length < MIN_SAMPLES_FOR_BASELINE) return null

    const sorted = rows.map(r => r.value).sort((a, b) => a - b)
    const mid    = Math.floor(sorted.length / 2)
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the hourly metrics sampler.
 *
 * - Fires a first sample 5 s after startup (DB is guaranteed ready by then).
 * - Schedules the next sample at the next UTC hour boundary, then repeats
 *   on the hour.
 *
 * @returns A stop function — call it on SIGTERM to cancel pending timers.
 */
export function startHourlyMetricsSample(): () => void {
  let hourlyTimer: ReturnType<typeof setTimeout> | null = null
  let hourlyInterval: ReturnType<typeof setInterval> | null = null

  // Initial sample shortly after startup
  const initialTimer = setTimeout(() => {
    recordHourlySample()

    // Align subsequent samples to UTC hour boundaries
    hourlyTimer = setTimeout(() => {
      recordHourlySample()
      hourlyInterval = setInterval(recordHourlySample, 3_600_000)
    }, msUntilNextHour())
  }, 5_000)

  console.log('✅ System metrics sampler started (hourly req_per_min baseline)')

  return () => {
    clearTimeout(initialTimer)
    if (hourlyTimer)    clearTimeout(hourlyTimer)
    if (hourlyInterval) clearInterval(hourlyInterval)
    console.log('🛑 System metrics sampler stopped')
  }
}
