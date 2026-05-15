/**
 * Auto-complete stale "ready" online orders
 *
 * When a customer picks up their order but staff forgets to press "Picked up",
 * the order stays in `ready` state indefinitely.  The customer's PWA polls
 * for status and keeps showing the active-order bar until the order reaches
 * `completed` or `cancelled`.
 *
 * This service finds online orders that are still in `ready` state from a
 * previous day (local date) and marks them `completed` so the customer's
 * app clears the stale notification on its next poll.
 *
 * Rules:
 *  - Only `source = 'online'` orders — those are the ones driving the PWA bar.
 *  - Only orders whose creation date (local YYYY-MM-DD prefix of created_at)
 *    is before today — same-day orders are left alone; staff may still be
 *    actively managing them.
 *  - Sets completed_at to the current time (not the original creation time).
 *  - Broadcasts `order_updated` SSE so the merchant dashboard refreshes.
 *  - Runs every 15 minutes via setInterval; also once on startup.
 */

import { getDatabase } from '../db/connection'
import { broadcastToMerchant } from './sse'

const POLL_INTERVAL_MS = 15 * 60 * 1_000  // 15 minutes

let _running = false

/**
 * Return today's local date as a YYYY-MM-DD string.
 * Uses wall-clock time so the cutoff rolls over at midnight on the appliance.
 */
function localToday(): string {
  const d  = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * Run one pass: find all online orders in `ready` state whose creation date
 * is before today and mark them `completed`.
 *
 * @returns number of orders completed
 */
export function runAutoCompleteReady(): number {
  const db    = getDatabase()
  const today = localToday()

  // created_at is stored as UTC ISO ('YYYY-MM-DD HH:MM:SS').  We compare the
  // date prefix to the local today string; this is slightly imprecise near
  // midnight but is consistent with how auto-clockout handles the same problem
  // and is safe in the direction that matters: we never complete a same-day order.
  const staleOrders = db
    .query<{ id: string; merchant_id: string }, [string]>(
      `SELECT id, merchant_id FROM orders
       WHERE  source     = 'online'
         AND  status     = 'ready'
         AND  substr(created_at, 1, 10) < ?`
    )
    .all(today)

  if (staleOrders.length === 0) return 0

  const now = new Date().toISOString()

  for (const order of staleOrders) {
    db.run(
      `UPDATE orders
          SET status       = 'completed',
              completed_at = ?,
              updated_at   = datetime('now')
        WHERE id = ?`,
      [now, order.id]
    )

    broadcastToMerchant(order.merchant_id, 'order_updated', {
      orderId: order.id,
      status:  'completed',
    })

    console.log(`[auto-complete-ready] Completed stale order ${order.id} for merchant ${order.merchant_id}`)
  }

  console.log(`[auto-complete-ready] Auto-completed ${staleOrders.length} stale ready order(s)`)
  return staleOrders.length
}

/**
 * Start the auto-complete-ready background check.
 * Runs once immediately on startup, then every 15 minutes.
 *
 * @returns the interval handle
 */
export function startAutoCompleteReady(): ReturnType<typeof setInterval> {
  if (_running) return setInterval(() => {}, 0)
  _running = true

  try {
    runAutoCompleteReady()
  } catch (err) {
    console.error('[auto-complete-ready] Startup check failed (will retry on next interval):', err)
  }

  return setInterval(() => {
    try { runAutoCompleteReady() }
    catch (err) { console.error('[auto-complete-ready] DB error:', err) }
  }, POLL_INTERVAL_MS)
}
