/**
 * PII purge service — SEC-005 remediation
 *
 * Nulls out customer_name, customer_phone, and customer_email on orders and
 * advance_orders older than 24 hours. Runs once at startup then daily at
 * PII_PURGE_HOUR (default 02:00 local time) — after business hours, before
 * backup at 02:00.
 *
 * Why 24 hours: receipt email is sent immediately at order creation; name +
 * phone are only needed while the order is being prepared / until pickup. If
 * a customer wants a receipt copy later they can provide their email again.
 *
 * customer_name cannot be NULLed directly because it has a NOT NULL constraint.
 * We replace it with '[redacted]' so the dashboard still renders a coherent row.
 *
 * coupon_hash_redemptions already stores only SHA-256 hashes — no action needed.
 * campaign_redemptions stores a plaintext customer_phone legacy column; we NULL
 * that out on the same 24-hour schedule.
 *
 * The pii_purged_at column (added via columnMigration) lets the WHERE clause skip
 * already-purged rows, making repeat runs cheap even on large tables.
 */

import { getDatabase } from '../db/connection'

/** Hour (local time, 0-23) at which the nightly purge fires. */
const PII_PURGE_HOUR = parseInt(process.env.PII_PURGE_HOUR ?? '2', 10)

/**
 * Return the number of ms until the next occurrence of PII_PURGE_HOUR:00 local time.
 */
function msUntilNextPurgeWindow(): number {
  const now = new Date()
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    PII_PURGE_HOUR,
    0,
    0,
    0,
  )
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime() - now.getTime()
}

/**
 * Purge one pass: null out PII fields on orders, advance_orders, and
 * campaign_redemptions older than 24 hours that have not yet been purged.
 *
 * @returns counts of rows affected per table
 */
export function runPurgePii(): { orders: number; advanceOrders: number; redemptions: number } {
  const db = getDatabase()

  // orders ──────────────────────────────────────────────────────────────────
  // customer_name has NOT NULL constraint; replace with '[redacted]' placeholder
  // so dashboard rows remain coherent.
  const ordersResult = db.run(`
    UPDATE orders
    SET customer_name  = '[redacted]',
        customer_phone = NULL,
        customer_email = NULL,
        pii_purged_at  = datetime('now')
    WHERE pii_purged_at IS NULL
      AND created_at <= datetime('now', '-24 hours')
  `)

  // advance_orders ──────────────────────────────────────────────────────────
  const advanceResult = db.run(`
    UPDATE advance_orders
    SET customer_name  = '[redacted]',
        customer_phone = NULL,
        pii_purged_at  = datetime('now')
    WHERE pii_purged_at IS NULL
      AND created_at <= datetime('now', '-24 hours')
  `)

  // campaign_redemptions (legacy table — plaintext customer_phone) ───────────
  // NULL out the phone column; the row's campaign_id + order_id are retained
  // for analytics. coupon_hash_redemptions already uses hashes; untouched.
  const redemptionsResult = db.run(`
    UPDATE campaign_redemptions
    SET customer_phone = NULL
    WHERE customer_phone IS NOT NULL
      AND ts <= (unixepoch() - 86400) * 1000
  `)

  const counts = {
    orders:        ordersResult.changes,
    advanceOrders: advanceResult.changes,
    redemptions:   redemptionsResult.changes,
  }

  if (counts.orders + counts.advanceOrders + counts.redemptions > 0) {
    console.log(
      `[pii-purge] Purged PII — orders: ${counts.orders}, ` +
      `advance_orders: ${counts.advanceOrders}, ` +
      `campaign_redemptions: ${counts.redemptions}`,
    )
  }

  return counts
}

/**
 * Start the nightly PII purge scheduler.
 *
 * - Runs once immediately on startup to catch any records that accumulated
 *   during a downtime window.
 * - Then fires every day at PII_PURGE_HOUR:00 local time.
 *
 * @returns a teardown function that cancels the pending timer
 */
export function startAutoPurgePii(): () => void {
  // Immediate startup run (catches any backlog)
  try {
    runPurgePii()
  } catch (err) {
    console.error('[pii-purge] Startup run failed:', err)
  }

  let timer: ReturnType<typeof setTimeout>

  function scheduleNext() {
    const delay = msUntilNextPurgeWindow()
    timer = setTimeout(() => {
      try {
        runPurgePii()
      } catch (err) {
        console.error('[pii-purge] Nightly run failed:', err)
      }
      scheduleNext()
    }, delay)
  }

  scheduleNext()

  return () => clearTimeout(timer)
}
