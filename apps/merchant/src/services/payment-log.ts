/**
 * Payment event logger
 *
 * Writes structured payment lifecycle events to the `payment_events` table.
 * 7-day retention window; auto-pruned by the reconciliation sweep.
 *
 * Design goals:
 *   - Never throw — logging must never interrupt the payment flow
 *   - Structured fields for easy querying (by order, transfer, device)
 *   - JSON side-car for arbitrary extra context
 */

import { getDatabase } from '../db/connection'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentEventType =
  // Terminal (card-present) events
  | 'terminal_initiated'        // POST /terminal-sale succeeded — transfer created
  | 'terminal_succeeded'        // Poll detected SUCCEEDED state
  | 'terminal_failed'           // Poll detected FAILED state
  | 'terminal_cancelled'        // Staff cancelled in-progress sale
  | 'terminal_timeout'          // MAX_TERMINAL_POLLS reached in client
  | 'terminal_device_offline'   // Device connection !== 'Open' at initiation time
  | 'terminal_retry'            // Previous pending sale cancelled, fresh transfer initiated
  | 'terminal_error'            // Unexpected error initiating or polling terminal sale
  // Record-payment events
  | 'record_payment_start'      // POST /record-payment received
  | 'record_payment_success'    // Payment inserted and order updated successfully
  | 'record_payment_error'      // DB or validation error in record-payment
  | 'record_payment_duplicate'  // Order already paid when record-payment was called
  // CNP (phone/MOTO) events
  | 'cnp_initiated'             // POST /cnp-payment — tokenization started
  | 'cnp_succeeded'             // Transfer created and SUCCEEDED immediately
  | 'cnp_failed'                // Transfer FAILED or API error
  // Online (Finix checkout form) events
  | 'online_payment_initiated'  // Checkout form created
  | 'online_payment_succeeded'  // Transfer confirmed as SUCCEEDED
  | 'online_payment_failed'     // Checkout form state != COMPLETED
  // Reconciliation events
  | 'reconciliation_matched'    // Payment matched to Finix transfer
  | 'reconciliation_unmatched'  // No matching transfer found
  | 'reconciliation_error'      // Exception during reconciliation
  | 'orphan_detected'           // Pending terminal sale found by sweep
  | 'orphan_recovered'          // Orphaned payment auto-created from Finix transfer
  | 'orphan_failed'             // Orphan sweep encountered an error

export type PaymentEventLevel = 'info' | 'warn' | 'error'

export interface PaymentEventData {
  /** Merchant ID (required) */
  merchantId: string
  /** Order ID this event relates to */
  orderId?: string
  /** Local payment ID (pay_…) */
  paymentId?: string
  /** Finix transfer ID (TR_…) */
  transferId?: string
  /** Finix device ID (DE_…) */
  deviceId?: string
  /** Amount in cents */
  amountCents?: number
  /** Log severity — defaults to 'info' */
  level?: PaymentEventLevel
  /** Short human-readable message */
  message?: string
  /** Arbitrary extra context (card brand, error message, state, etc.) */
  extra?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Logs a payment lifecycle event to the `payment_events` table.
 * Never throws — logging failures are swallowed with a console.warn.
 *
 * @param eventType - Structured event identifier
 * @param data      - Event context fields
 */
export function logPaymentEvent(
  eventType: PaymentEventType,
  data: PaymentEventData,
): void {
  try {
    const db = getDatabase()
    const {
      merchantId, orderId, paymentId, transferId, deviceId,
      amountCents, level, message, extra,
    } = data

    db.run(
      `INSERT INTO payment_events
         (merchant_id, order_id, payment_id, transfer_id, device_id,
          amount_cents, event_type, level, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        merchantId,
        orderId      ?? null,
        paymentId    ?? null,
        transferId   ?? null,
        deviceId     ?? null,
        amountCents  ?? null,
        eventType,
        level        ?? 'info',
        message      ?? null,
        (() => { if (!extra) return null; const j = JSON.stringify(extra); return j.length <= 4096 ? j : JSON.stringify({ _truncated: true, size: j.length }) })(),
      ],
    )
  } catch (err) {
    // Never let logging break the payment flow
    console.warn('[payment-log] failed to log event:', (err as Error)?.message ?? err)
  }
}

/**
 * Deletes payment_events older than 7 days.
 * Never throws.
 *
 * Call sites (both run independently so the table stays bounded even when one
 * is disabled):
 *   - reconcile.ts → startAutoReconcile() sweep interval
 *   - daily-closeout.ts → checkCloseouts() (every 30 min via startDailyCloseout)
 */
export function prunePaymentEvents(): void {
  try {
    const db = getDatabase()
    const result = db.run(
      `DELETE FROM payment_events WHERE created_at < datetime('now', '-7 days')`,
    )
    if (result.changes > 0) {
      console.log(`[payment-log] pruned ${result.changes} event(s) older than 7 days`)
    }
  } catch (err) {
    console.warn('[payment-log] prune failed:', (err as Error)?.message ?? err)
  }
}
