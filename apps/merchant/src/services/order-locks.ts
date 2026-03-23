/**
 * In-memory order edit locks.
 *
 * Prevents two devices from editing the same order simultaneously.
 * Locks auto-expire after LOCK_TTL_MS to handle abandoned sessions
 * (browser closed, tablet died, etc.).
 *
 * This is intentionally NOT a database lock — the appliance is a single
 * process, so a Map is sufficient and zero-overhead.
 */

/** How long a lock survives without being refreshed (3 minutes).
 *  M-11: Reduced from 10 min — staff who close browser no longer block others for 10 min.
 *  The dashboard should send periodic heartbeats (re-acquire) to extend active locks. */
const LOCK_TTL_MS = 3 * 60 * 1000

interface LockEntry {
  employeeId: string
  employeeName: string
  lockedAt: number
}

const locks = new Map<string, LockEntry>()

/** Remove stale entry if expired; return true if it was removed. */
function evictIfStale(orderId: string): boolean {
  const entry = locks.get(orderId)
  if (entry && Date.now() - entry.lockedAt > LOCK_TTL_MS) {
    locks.delete(orderId)
    return true
  }
  return false
}

/**
 * Try to acquire an edit lock on an order.
 *
 * - Returns `{ ok: true }` if the lock was granted (or the same employee
 *   is re-locking — idempotent).
 * - Returns `{ ok: false, lockedBy }` if another employee holds the lock.
 */
export function acquireLock(
  orderId: string,
  employeeId: string,
  employeeName: string,
): { ok: boolean; lockedBy?: string } {
  evictIfStale(orderId)

  const existing = locks.get(orderId)
  if (existing && existing.employeeId !== employeeId) {
    return { ok: false, lockedBy: existing.employeeName }
  }

  locks.set(orderId, { employeeId, employeeName, lockedAt: Date.now() })
  return { ok: true }
}

/**
 * Release the edit lock.  Only the employee who holds the lock (or a
 * force-release with no employeeId) can release it.
 */
export function releaseLock(orderId: string, employeeId?: string): void {
  if (employeeId) {
    const existing = locks.get(orderId)
    if (existing && existing.employeeId !== employeeId) return
  }
  locks.delete(orderId)
}

/** Check whether an order is currently locked for editing. */
export function isLocked(orderId: string): { locked: boolean; lockedBy?: string } {
  evictIfStale(orderId)
  const entry = locks.get(orderId)
  if (!entry) return { locked: false }
  return { locked: true, lockedBy: entry.employeeName }
}

/**
 * Try to acquire a short-lived lock for a payment webhook handler.
 *
 * Purpose: prevent two concurrent payment-result requests from both calling
 * the payment processor API (Finix/Converge) for the same order at once.
 * The DB-level `UPDATE … WHERE status='received' RETURNING id` is the final
 * authority — this is an early fast-path guard to avoid duplicate API calls.
 *
 * Uses a 2-minute TTL (shorter than the staff-editing 3-minute TTL) so a
 * stuck/crashed webhook handler doesn't permanently block retries.
 *
 * @returns true if the lock was acquired, false if already in progress.
 */
export function acquireWebhookLock(orderId: string): boolean {
  const WEBHOOK_TTL_MS = 2 * 60 * 1000
  const entry = locks.get(orderId)
  if (entry) {
    // Evict if stale using webhook TTL, otherwise already locked
    if (Date.now() - entry.lockedAt > WEBHOOK_TTL_MS) {
      locks.delete(orderId)
    } else {
      return false
    }
  }
  locks.set(orderId, { employeeId: '__webhook__', employeeName: 'Payment webhook', lockedAt: Date.now() })
  return true
}

/**
 * Acquire a payment-in-progress lock on an order.
 *
 * Held while a PAX terminal sale is active (between `POST terminal-sale` and
 * either a successful `record-payment` or a `terminal-sale/cancel`).
 * Blocks all order mutations (status changes, item edits, discounts,
 * service charges) for the duration so no one can cancel or alter an order
 * while the customer is tapping their card.
 *
 * Uses a 10-minute TTL — generous enough for a slow customer tap but short
 * enough that a crashed client doesn't lock an order indefinitely.
 *
 * @returns true if the lock was acquired; false if a payment is already active.
 */
export function acquirePaymentLock(orderId: string): boolean {
  const PAYMENT_TTL_MS = 10 * 60 * 1000
  const entry = locks.get(orderId)
  if (entry) {
    if (Date.now() - entry.lockedAt > PAYMENT_TTL_MS) {
      locks.delete(orderId)
    } else {
      return false
    }
  }
  locks.set(orderId, { employeeId: '__payment__', employeeName: 'Payment in progress', lockedAt: Date.now() })
  return true
}

/**
 * Release a payment-in-progress lock.
 * No-op if the lock is not held by `__payment__` (e.g. evicted, already released).
 */
export function releasePaymentLock(orderId: string): void {
  const entry = locks.get(orderId)
  if (entry && entry.employeeId === '__payment__') {
    locks.delete(orderId)
  }
}

/**
 * Returns true if a payment is currently in progress for this order.
 * Respects the 10-minute TTL — a stale payment lock is treated as released.
 */
export function isPaymentLocked(orderId: string): boolean {
  const PAYMENT_TTL_MS = 10 * 60 * 1000
  const entry = locks.get(orderId)
  if (!entry || entry.employeeId !== '__payment__') return false
  if (Date.now() - entry.lockedAt > PAYMENT_TTL_MS) {
    locks.delete(orderId)
    return false
  }
  return true
}
