/**
 * S3 auto-backup scheduler
 *
 * Fires 60 minutes after each merchant's last close time for the day.
 * Falls back to 02:00 server time for merchants with no business hours configured.
 *
 * Backs up the orders for the day that just ended:
 *   s3://{bucket}/{merchantId}/orders/{YYYY-MM-DD}.json
 *
 * Uses a per-minute polling approach — no cron or external scheduler needed.
 * Each merchant is tracked independently so different close times are handled correctly.
 */

import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { s3PutObject, type S3Config } from './s3'
import { generateBackup } from '../routes/backup'

let schedulerTimer: ReturnType<typeof setInterval> | null = null

/** Per-merchant last-run tracking: merchantId → local date ISO (YYYY-MM-DD) */
const lastRunPerMerchant = new Map<string, string>()

let _backupUploading = false  // NF-5.2: backpressure guard against concurrent uploads

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/** Returns the current date in a merchant's local timezone as YYYY-MM-DD. */
function localDateISO(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('sv', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)  // Swedish locale produces YYYY-MM-DD
}

/** Returns current time as minutes from midnight in the merchant's local timezone. */
function localMinutes(now: Date, timezone: string): number {
  const str = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).format(now)  // e.g. "22:30"
  const [h, m] = str.split(':').map(Number)
  return h * 60 + m
}

/** Returns the local day-of-week (0=Sun … 6=Sat) in the merchant's timezone. */
function localDayOfWeek(now: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now)
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[name] ?? now.getDay()
}

// ---------------------------------------------------------------------------
// Backup target computation
// ---------------------------------------------------------------------------

interface BackupTarget {
  /** Minutes from midnight (merchant-local) when the backup should fire. */
  targetMins: number
  /**
   * The date whose orders should be backed up.
   * 'today' = the day that just closed (close+60 still on same calendar day).
   * 'yesterday' = close+60 crossed midnight into the next calendar day.
   */
  dateToBackUp: 'today' | 'yesterday'
}

/**
 * Determine when to run the backup for a merchant on a given day-of-week.
 *
 * Returns null if there are no business hours for that day (merchant is closed),
 * in which case the caller should try the previous day's schedule.
 */
function getBackupTargetForDay(merchantId: string, dayOfWeek: number): BackupTarget | null {
  const db = getDatabase()
  const row = db.query<{ close_time: string }, [string, number]>(
    `SELECT close_time FROM business_hours
     WHERE merchant_id = ? AND service_type = 'regular'
       AND day_of_week = ? AND is_closed = 0
     ORDER BY close_time DESC
     LIMIT 1`
  ).get(merchantId, dayOfWeek)

  if (!row) return null

  const [h, m] = row.close_time.split(':').map(Number)
  const targetMins = h * 60 + m + 60

  if (targetMins < 1440) {
    return { targetMins, dateToBackUp: 'today' }
  }
  // Crossed midnight — fire time wraps into the next calendar day
  return { targetMins: targetMins - 1440, dateToBackUp: 'yesterday' }
}

/**
 * Returns the backup target for a merchant right now, accounting for:
 *  1. Today's close time + 60 (same calendar day)
 *  2. Yesterday's close time + 60 (if it crosses midnight into today)
 *  3. Fallback: null (caller uses 02:00 server-time default)
 *
 * Also returns the ISO date string of the orders to back up.
 */
function resolveBackupTarget(
  merchantId: string,
  timezone: string,
  now: Date
): { targetMins: number; backupDate: string } | null {
  const todayDow = localDayOfWeek(now, timezone)
  const yesterdayDow = (todayDow + 6) % 7

  const todayDateISO = localDateISO(now, timezone)
  const yesterdayDateISO = localDateISO(new Date(now.getTime() - 86_400_000), timezone)

  // Case 1 — today's schedule: close + 60 is still today
  const todayTarget = getBackupTargetForDay(merchantId, todayDow)
  if (todayTarget && todayTarget.dateToBackUp === 'today') {
    return { targetMins: todayTarget.targetMins, backupDate: todayDateISO }
  }

  // Case 2 — yesterday's schedule: close + 60 crossed midnight into today
  const yesterdayTarget = getBackupTargetForDay(merchantId, yesterdayDow)
  if (yesterdayTarget && yesterdayTarget.dateToBackUp === 'yesterday') {
    return { targetMins: yesterdayTarget.targetMins, backupDate: yesterdayDateISO }
  }

  return null
}

// ---------------------------------------------------------------------------
// Core backup runner
// ---------------------------------------------------------------------------

/**
 * Upload a specific day's orders backup to S3 for a single merchant.
 */
async function runBackupForMerchant(merchantId: string, backupDate: string): Promise<void> {
  try {
    const raw = await getAPIKey(merchantId, 'cloud', 's3')
    if (!raw) return

    let s3Config: S3Config
    try {
      s3Config = JSON.parse(raw) as S3Config
    } catch {
      console.warn(`[auto-backup] Bad S3 config JSON for merchant ${merchantId}`)
      return
    }

    const backup = await generateBackup(merchantId, 'orders', backupDate, backupDate)
    const body = JSON.stringify(backup)
    const key = `${merchantId}/orders/${backupDate}.json`

    await s3PutObject(s3Config, key, body, 'application/json')
    console.log(`[auto-backup] Uploaded s3://${s3Config.bucket}/${key}`)
  } catch (error) {
    console.error(`[auto-backup] Failed for merchant ${merchantId}:`, error)
  }
}

// ---------------------------------------------------------------------------
// Per-minute check
// ---------------------------------------------------------------------------

/**
 * Called every minute. For each merchant with S3 configured, checks whether
 * it is time to run their backup (60 min after close) and triggers if so.
 */
async function checkAndRun(): Promise<void> {
  if (_backupUploading) {
    console.warn('[auto-backup] skipping tick — previous upload still running')
    return
  }

  const now = new Date()
  const db  = getDatabase()

  const merchants = db.query<{ merchant_id: string; timezone: string | null }, []>(
    `SELECT DISTINCT ak.merchant_id, m.timezone
     FROM api_keys ak
     JOIN merchants m ON m.id = ak.merchant_id
     WHERE ak.key_type = 'cloud' AND ak.provider = 's3'`
  ).all()

  if (merchants.length === 0) return

  // Server-time fallback values (for merchants with no business hours)
  const serverHour   = now.getHours()
  const serverMin    = now.getMinutes()
  const serverYesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)

  for (const { merchant_id, timezone } of merchants) {
    const tz = timezone ?? 'America/Los_Angeles'
    const localDateKey = localDateISO(now, tz)

    // Already ran for this merchant today (in their local timezone)
    if (lastRunPerMerchant.get(merchant_id) === localDateKey) continue

    const target = resolveBackupTarget(merchant_id, tz, now)

    if (target) {
      const currentMins = localMinutes(now, tz)
      if (currentMins !== target.targetMins) continue

      lastRunPerMerchant.set(merchant_id, localDateKey)
      _backupUploading = true
      try {
        await runBackupForMerchant(merchant_id, target.backupDate)
      } finally {
        _backupUploading = false
      }
    } else {
      // No business hours — fall back to 02:00 server time
      if (serverHour !== 2 || serverMin !== 0) continue

      lastRunPerMerchant.set(merchant_id, localDateKey)
      _backupUploading = true
      try {
        await runBackupForMerchant(merchant_id, serverYesterday)
      } finally {
        _backupUploading = false
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the auto-backup scheduler.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startAutoBackup(): void {
  if (schedulerTimer !== null) return

  schedulerTimer = setInterval(() => {
    checkAndRun().catch((err) =>
      console.error('[auto-backup] Unhandled error during check:', err)
    )
  }, 60_000)
  console.log('[auto-backup] Scheduler started (fires 60 min after close, or 02:00 if no hours set)')
}

/**
 * Stop the scheduler (used in tests / graceful shutdown).
 */
export function stopAutoBackup(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[auto-backup] Scheduler stopped')
  }
}
