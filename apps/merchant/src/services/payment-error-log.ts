/**
 * Payment error logger
 *
 * Writes structured payment failure events to the `payment_errors` table.
 * These rows are consumed by `GET /api/status` to populate
 * `payments.recent_errors` and `payments.terminal_errors_24h` for COSA monitoring.
 *
 * Separate from `payment_events` (operational audit log, 7-day retention) —
 * `payment_errors` is a narrower, COSA-facing log of failures only.
 *
 * Design goals:
 *   - Never throw — error logging must never interrupt the payment flow
 *   - Simple flat schema — COSA reads it directly, no joins needed
 *   - Explicit error_type enum aligned with §3.1 of cosa-monitoring-spec.md
 */

import { getDatabase } from '../db/connection'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured error type enum — §3.1 of cosa-monitoring-spec.md.
 *
 * | Value               | Meaning                                                  |
 * |---------------------|----------------------------------------------------------|
 * | terminal_timeout    | Terminal did not respond within the 180 s deadline       |
 * | terminal_declined   | Card declined by the processor                           |
 * | terminal_cancelled  | Customer cancelled at the terminal                       |
 * | terminal_error      | Hardware/communication error (initiation, network, etc.) |
 * | reconcile_gap       | Payment processed at terminal but no matching order      |
 * | auth_failed         | Processor API key / authentication error                 |
 * | network_error       | Could not reach the payment processor API                |
 * | unknown             | Uncategorized — see `detail` field                       |
 */
export type PaymentErrorType =
  | 'terminal_timeout'
  | 'terminal_declined'
  | 'terminal_cancelled'
  | 'terminal_error'
  | 'reconcile_gap'
  | 'auth_failed'
  | 'network_error'
  | 'unknown'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert one row into `payment_errors`.
 *
 * Never throws — logging failures are swallowed with `console.warn` so they
 * never interrupt the payment flow.
 *
 * @param merchantId - The merchant this error belongs to
 * @param errorType  - Structured error category (see PaymentErrorType)
 * @param detail     - Human-readable description (decline message, error text, etc.)
 * @param orderId    - Associated order, if known (null for reconcile_gap etc.)
 */
export function logPaymentError(
  merchantId: string,
  errorType: PaymentErrorType,
  detail: string,
  orderId?: string | null,
): void {
  try {
    const db = getDatabase()
    db.run(
      `INSERT INTO payment_errors (merchant_id, order_id, error_type, detail, occurred_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [merchantId, orderId ?? null, errorType, detail.slice(0, 1000)],
    )
  } catch (err) {
    // Never let error logging break the payment flow
    console.warn('[payment-error-log] failed to log error:', (err as Error)?.message ?? err)
  }
}

/**
 * Delete `payment_errors` rows older than `retentionDays` (default 30).
 * Never throws.
 *
 * Called from `daily-closeout.ts` on every sweep to keep the table bounded.
 */
export function prunePaymentErrors(retentionDays = 30): void {
  try {
    const db = getDatabase()
    const result = db.run(
      `DELETE FROM payment_errors WHERE occurred_at < datetime('now', ? || ' days')`,
      [`-${retentionDays}`],
    )
    if (result.changes > 0) {
      console.log(`[payment-error-log] pruned ${result.changes} error(s) older than ${retentionDays} days`)
    }
  } catch (err) {
    console.warn('[payment-error-log] prune failed:', (err as Error)?.message ?? err)
  }
}
