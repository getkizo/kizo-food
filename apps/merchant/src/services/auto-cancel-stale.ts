/**
 * Auto-cancel stale online store orders
 *
 * ⚠️  DISABLED — This service is no longer started in server.ts.
 *
 * SAFETY INVARIANT (temporal logic):
 *   □ ¬(status = 'cancelled' ∧ ¬staff_action ∧ ¬customer_action)
 *   "It is always the case that an order is not cancelled without an explicit
 *    human action (staff cancel or customer self-cancel)."
 *
 * Auto-cancellation violates this invariant.  Orders must remain in their
 * current status indefinitely until a human explicitly acts on them.  The
 * repeating dashboard notification sound (every 15 s) ensures unaccepted
 * orders are never overlooked.
 *
 * This file is kept (not deleted) so the export doesn't break any imports,
 * but startAutoCancelStale() is no longer called.
 *
 * --- Original design notes (retained for context) ---
 *
 * Customer-placed orders that are never acted on by staff leave the customer's
 * PWA stuck in a waiting state indefinitely.  This service finds orders that
 * have been sitting in an unacknowledged status for longer than
 * STALE_THRESHOLD_MINUTES and cancels them automatically so the customer's
 * polling loop receives 'cancelled', triggers clearActiveOrder(), and resets
 * the PWA to the browsing state.
 *
 * Eligible for auto-cancel (staff has NOT acknowledged the order):
 *   submitted | received
 *
 * NOT cancelled (staff has explicitly accepted — do not undo a deliberate action):
 *   confirmed | preparing | ready | completed | cancelled
 *
 * Additionally, scheduled orders whose pickup_time is still in the future are
 * skipped — those are legitimately waiting for their time slot and should not
 * be cancelled even if STALE_THRESHOLD_MINUTES has elapsed since placement.
 *
 * Runs every POLL_INTERVAL_MS on startup.
 */

import { getDatabase } from '../db/connection'
import { broadcastToMerchant } from './sse'

/** Orders stuck in an unacknowledged status for this many minutes will be cancelled. */
const STALE_THRESHOLD_MINUTES = 120  // 2 hours

/** How often to check for stale orders. */
const POLL_INTERVAL_MS = 5 * 60 * 1_000  // 5 minutes

/** Singleton guard — prevents multiple timer chains. */
let _running = false

/**
 * Cancel all online orders that have been in an unacknowledged status
 * (submitted | received) for longer than {@link STALE_THRESHOLD_MINUTES},
 * excluding scheduled orders whose pickup_time is still in the future.
 *
 * Broadcasts an `order_updated` SSE event to the merchant dashboard for each
 * cancelled order so staff see the order disappear immediately.
 *
 * @returns number of orders cancelled
 */
export function runCancelStaleOrders(): number {
  const db = getDatabase()

  // Compute the cutoff in application code so the query remains fully
  // parameterized — avoids any future risk if the threshold is ever sourced
  // from configuration rather than a module-level constant.
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60_000).toISOString()

  // SELECT first so we can broadcast SSE per order after the update.
  // 'confirmed' is intentionally excluded — it means staff has accepted the
  // order.  Auto-cancelling a confirmed order would undo a deliberate staff
  // action and would break scheduled orders that have been accepted early.
  // Scheduled orders (pickup_time in the future) are also excluded — they
  // are legitimately waiting for their slot, not abandoned.
  const staleOrders = db
    .query<{ id: string; merchant_id: string }, [string]>(
      `SELECT id, merchant_id FROM orders
       WHERE  source     = 'online'
         AND  status     IN ('submitted', 'received')
         AND  created_at < ?
         AND  (pickup_time IS NULL OR pickup_time <= datetime('now'))`,
    )
    .all(cutoff)

  if (staleOrders.length === 0) return 0

  for (const order of staleOrders) {
    db.run(
      `UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
      [order.id],
    )
    broadcastToMerchant(order.merchant_id, 'order_updated', {
      orderId: order.id,
      status:  'cancelled',
    })
  }

  console.log(
    `[auto-cancel-stale] Cancelled ${staleOrders.length} stale order(s) ` +
    `(unacknowledged > ${STALE_THRESHOLD_MINUTES} min, past pickup time or ASAP)`,
  )

  return staleOrders.length
}

/**
 * Start the auto-cancel-stale service.
 *
 * Runs once immediately on startup (clears any orders left over from before
 * the server was last restarted), then repeats every {@link POLL_INTERVAL_MS}.
 *
 * @returns cleanup function that cancels the repeating timer
 */
export function startAutoCancelStale(): () => void {
  if (_running) return () => {}
  _running = true

  // Immediate run — clear anything already stale before the interval fires
  try {
    runCancelStaleOrders()
  } catch (err) {
    console.error('[auto-cancel-stale] Startup check failed (will retry on next interval):', err)
  }

  const timer = setInterval(() => {
    try { runCancelStaleOrders() }
    catch (err) { console.error('[auto-cancel-stale] DB error:', err) }
  }, POLL_INTERVAL_MS)

  return () => {
    _running = false
    clearInterval(timer)
  }
}
