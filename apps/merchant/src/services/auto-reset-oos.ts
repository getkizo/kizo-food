/**
 * Auto-reset "Out Today" service
 *
 * Menu items and modifiers marked as `out_today` are reset to `in_stock`
 * automatically 60 minutes after each merchant's last closing time for the
 * day, so staff arrive the next morning to a clean slate — no manual toggling
 * required.
 *
 * Falls back to 02:00 AM (merchant local time) for merchants with no business
 * hours configured, or on scheduled closure days.
 *
 * Runs on a 5-minute polling interval. A dedup variable prevents
 * double-resets within the same merchant-local calendar day.
 */

import { getDatabase } from '../db/connection'

// ---------------------------------------------------------------------------
// Timezone helpers (local copies — avoids coupling to daily-closeout.ts)
// ---------------------------------------------------------------------------

/** Today as YYYY-MM-DD in the given IANA timezone. */
function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** Current time as HH:MM in the given IANA timezone. */
function nowTimeLocal(tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).format(new Date())
}

/** Day of week (0=Sunday) in the given IANA timezone. */
function todayDow(tz: string): number {
  const [y, m, d] = todayLocal(tz).split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** Add N minutes to an HH:MM string, returns HH:MM (caps at 23:59). */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + minutes
  const newH = Math.min(Math.floor(total / 60), 23)
  const newM = total >= 24 * 60 ? 59 : total % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Business hours helpers
// ---------------------------------------------------------------------------

/** Latest close_time for 'regular' service on a given day-of-week, or null. */
function getLastCloseTime(merchantId: string, dow: number): string | null {
  const db = getDatabase()
  const row = db
    .query<{ close_time: string }, [string, number]>(
      `SELECT MAX(close_time) AS close_time
       FROM business_hours
       WHERE merchant_id = ? AND service_type = 'regular' AND day_of_week = ? AND is_closed = 0`,
    )
    .get(merchantId, dow)
  return row?.close_time ?? null
}

/** True if today falls within a scheduled closure for the merchant. */
function isScheduledClosure(merchantId: string, todayDate: string): boolean {
  const db = getDatabase()
  const row = db
    .query<{ cnt: number }, [string, string, string]>(
      `SELECT COUNT(*) AS cnt FROM scheduled_closures
       WHERE merchant_id = ? AND start_date <= ? AND end_date >= ?`,
    )
    .get(merchantId, todayDate, todayDate)
  return (row?.cnt ?? 0) > 0
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The merchant-local date (YYYY-MM-DD) of the last successful out_today reset.
 * Prevents double-resets within the same local calendar day.
 */
let _lastResetDate: string | null = null

/** Clear deduplication state — for use in tests only. */
export function resetOosState(): void {
  _lastResetDate = null
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Reset out_today menu items and modifiers back to in_stock for one merchant.
 *
 * @returns counts of rows updated: `{ items, modifiers }`
 */
export function runResetForMerchant(merchantId: string): { items: number; modifiers: number } {
  const db = getDatabase()

  const itemResult = db.run(
    `UPDATE menu_items SET stock_status = 'in_stock', updated_at = datetime('now')
     WHERE merchant_id = ? AND stock_status = 'out_today'`,
    [merchantId],
  )

  const modResult = db.run(
    `UPDATE modifiers SET stock_status = 'in_stock'
     WHERE stock_status = 'out_today'
       AND group_id IN (SELECT id FROM modifier_groups WHERE merchant_id = ?)`,
    [merchantId],
  )

  return { items: itemResult.changes, modifiers: modResult.changes }
}

/**
 * One polling pass: check whether 60 minutes have elapsed since the merchant's
 * last closing time today. If so — and we have not already reset for this
 * merchant-local date — reset their out_today items.
 *
 * This appliance serves a single merchant. No loop over merchants is needed.
 *
 * @returns 1 if items were reset this pass, 0 otherwise
 */
export function checkOosResets(): number {
  const db = getDatabase()

  type MerchantRow = { id: string; timezone: string }
  const merchant = db
    .query<MerchantRow, []>(
      `SELECT id, COALESCE(timezone, 'America/Los_Angeles') AS timezone
       FROM merchants WHERE status = 'active'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get()

  if (!merchant) return 0

  try {
    const tz = merchant.timezone
    const today = todayLocal(tz)

    // Already reset for today?
    if (_lastResetDate === today) return 0

    const nowTime = nowTimeLocal(tz)
    const dow = todayDow(tz)
    const lastClose = isScheduledClosure(merchant.id, today)
      ? null
      : getLastCloseTime(merchant.id, dow)

    // Determine when to trigger the reset:
    //   - Open day:    60 min after the last closing time
    //   - Closed day / no hours:  02:00 AM (safe overnight fallback)
    const resetAfter = lastClose ? addMinutes(lastClose, 60) : '02:00'

    if (nowTime < resetAfter) return 0

    const { items, modifiers } = runResetForMerchant(merchant.id)
    _lastResetDate = today

    if (items > 0 || modifiers > 0) {
      console.log(
        `[auto-reset-oos] reset ${items} item(s) and ${modifiers} modifier(s) ` +
        `to in_stock (trigger: ${resetAfter} local, today: ${today})`,
      )
    } else {
      console.debug(`[auto-reset-oos] reset ran at ${resetAfter} — nothing to restore (${today})`)
    }
    return 1
  } catch (err) {
    console.error('[auto-reset-oos] Error:', err)
    return 0
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Singleton guard — prevents multiple independent timer chains. */
let _running = false

/**
 * Start the auto-reset-oos background service.
 *
 * Runs {@link checkOosResets} once immediately on startup (catches any missed
 * resets if the server was down at the trigger time), then every 5 minutes.
 *
 * @returns a cleanup function that cancels the interval on graceful shutdown
 */
export function startAutoResetOos(): () => void {
  if (_running) return () => {}
  _running = true

  // Don't run in test environment (tests call checkOosResets() / runResetForMerchant() directly)
  if (process.env.NODE_ENV === 'test') {
    _running = false
    return () => {}
  }

  // Immediate startup pass — restore anything left over from a missed trigger
  try {
    checkOosResets()
  } catch (err) {
    console.error('[auto-reset-oos] Startup check failed (will retry on next interval):', err)
  }

  const INTERVAL_MS = 5 * 60_000 // 5 minutes

  const handle = setInterval(() => {
    try {
      checkOosResets()
    } catch (err) {
      console.error('[auto-reset-oos] Interval check failed:', err)
    }
  }, INTERVAL_MS)

  return () => {
    _running = false
    clearInterval(handle)
  }
}
