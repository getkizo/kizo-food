/**
 * Payment reconciliation service
 *
 * Verifies that every card payment recorded locally has a corresponding settled
 * transfer in the Finix ledger.  This catches split-brain scenarios where the
 * terminal charged the customer but the server never received confirmation.
 *
 * ## Matching strategy
 *
 * 1. **Transfer ID fast-path** — if `payments.finix_transfer_id` is already
 *    populated (PAX A920 Pro flow), fetch that specific transfer from Finix and
 *    confirm its state is SUCCEEDED.  On success → `matched`; on failure → fall
 *    through to window scan.
 *
 * 2. **Window scan** — otherwise, list all Finix transfers for a ±5-minute window
 *    around `payments.created_at` and look for an exact `amount_cents` match.
 *    The first match is accepted; duplicates (two identical amounts in the window)
 *    are flagged as matched on the first hit.
 *
 * 3. **Skip rules** — non-card payments are never sent to Finix:
 *    - `payment_type = 'cash'`      → status `cash_skipped`
 *    - `payment_type = 'gift_card'` → status `gift_card_skipped`
 *    - Finix not configured         → status `no_processor`
 *
 * ## Timing
 * Each card payment is scheduled for reconciliation 60 seconds after creation
 * via `scheduleReconciliation(paymentId)`.  A periodic sweep (`startReconciliation`)
 * also re-checks any payments that were missed (e.g. server was down at T+60s).
 *
 * ## Alerts
 * Unmatched card payments trigger two side effects:
 *   - SSE `payment_alert` broadcast to all open dashboard tabs
 *   - `payment_unmatched` row in `security_events` for audit trail
 * Alerts fire only once per payment (`alerted = 1` set after first alert).
 *
 * ## Results table
 * `payment_reconciliations` has a UNIQUE constraint on `payment_id` — INSERT OR
 * REPLACE keeps only the most recent check result per payment.
 */

import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { listTransfers, getTransfer, getTerminalTransferStatus } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { broadcastToMerchant } from './sse'
import { logSecurityEvent } from './security-log'
import { logPaymentEvent, prunePaymentEvents } from './payment-log'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReconciliationStatus = 'matched' | 'unmatched' | 'cash_skipped' | 'gift_card_skipped' | 'no_processor'

interface PaymentRow {
  id: string
  order_id: string
  payment_type: string
  amount_cents: number
  created_at: string
  processor: string | null
  finix_transfer_id: string | null
  transaction_id: string | null
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Prevents overlapping sweep iterations when Finix API responds slowly. */
let _sweepRunning = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Schedules a reconciliation check for one payment, 60 seconds from now.
 * Fire-and-forget — never throws.
 *
 * @param merchantId  - Internal merchant ID
 * @param paymentId   - Local payment ID (pay_xxx)
 * @param paymentType - 'card' | 'cash' — cash payments are skipped immediately
 */
export function scheduleReconciliation(
  merchantId: string,
  paymentId: string,
  paymentType: 'card' | 'cash' | 'gift_card',
): void {
  if (paymentType === 'cash' || paymentType === 'gift_card') {
    // Cash and gift card payments cannot be reconciled against Finix; record immediately.
    const status = paymentType === 'cash' ? 'cash_skipped' : 'gift_card_skipped'
    setImmediate(() =>
      writeResult(merchantId, paymentId, status, null, null, null).catch(
        (err) => console.warn(`[reconcile] ${status} write failed:`, err?.message ?? err),
      ),
    )
    return
  }

  const delayMs = Number(process.env.RECONCILE_DELAY_MS ?? 60_000)
  setTimeout(
    () =>
      runReconciliation(merchantId, paymentId).catch((err) =>
        console.warn('[reconcile] runReconciliation error:', err?.message ?? err),
      ),
    delayMs,
  )
}

// ---------------------------------------------------------------------------
// Internal (exported for direct use in tests and manual-retry endpoint)
// ---------------------------------------------------------------------------

/**
 * Loads Finix creds for the merchant and attempts to match the payment to a
 * Finix transfer.  Strategy (in order):
 *
 *   1. `finix_transfer_id` already set → instant match
 *   2. `transaction_id` set → direct `getTransfer()` lookup
 *   3. `listTransfers` ±5 min window → exact amount match
 *   4. **Last resort**: `listTransfers` ±48 hours → exact amount match
 *
 * GUARANTEED to write a result to `payment_reconciliations` — never leaves
 * a payment in "Pending check" limbo.
 */
export async function runReconciliation(merchantId: string, paymentId: string): Promise<void> {
  const db = getDatabase()

  const payment = db
    .query<PaymentRow, [string, string]>(
      `SELECT id, order_id, payment_type, amount_cents, created_at, processor,
              finix_transfer_id, transaction_id
       FROM payments WHERE id = ? AND merchant_id = ?`,
    )
    .get(paymentId, merchantId)

  if (!payment) {
    console.warn(`[reconcile] payment ${paymentId} not found for merchant ${merchantId}`)
    return
  }

  console.log(`[reconcile] checking ${paymentId}: amount=$${(payment.amount_cents / 100).toFixed(2)} processor=${payment.processor} txn_id=${payment.transaction_id ?? 'NULL'} finix_id=${payment.finix_transfer_id ?? 'NULL'}`)

  // ── Clover payments: confirmed by Clover API — no Finix lookup needed ─
  if (payment.processor === 'clover') {
    console.log(`[reconcile] ${paymentId} → processor=clover, marking matched (Clover-confirmed)`)
    await writeResult(merchantId, paymentId, 'matched', null, payment.amount_cents, payment.amount_cents)
    return
  }

  // ── Strategy 1: finix_transfer_id already set ──────────────────────────
  if (payment.finix_transfer_id) {
    console.log(`[reconcile] ${paymentId} → finix_transfer_id already set, instant match`)
    await writeResult(merchantId, paymentId, 'matched', payment.finix_transfer_id, payment.amount_cents, payment.amount_cents)
    return
  }

  // ── Load Finix credentials (needed for all remaining strategies) ───────
  const creds = await loadFinixCreds(merchantId)
  if (!creds) {
    console.warn(`[reconcile] ${paymentId} → no Finix credentials, writing no_processor`)
    await writeResult(merchantId, paymentId, 'no_processor', null, payment.amount_cents, null)
    return
  }

  // Wrap all Finix API calls in a top-level try/catch so we ALWAYS write
  // a result — even if the API is down, creds are wrong, or anything else
  // goes wrong.  "Pending check" (no record at all) must never persist.
  try {
    // ── Strategy 2: transaction_id set → direct lookup ─────────────────
    if (payment.transaction_id) {
      console.log(`[reconcile] ${paymentId} → trying direct getTransfer(${payment.transaction_id})`)
      try {
        const transfer = await getTransfer(creds, payment.transaction_id)
        console.log(`[reconcile] ${paymentId} → getTransfer returned state=${transfer.state} amount=${transfer.amount}`)

        if (transfer.state === 'SUCCEEDED' && transfer.amount === payment.amount_cents) {
          db.run(`UPDATE payments SET finix_transfer_id = ? WHERE id = ?`, [transfer.id, paymentId])
          await writeResult(merchantId, paymentId, 'matched', transfer.id, payment.amount_cents, transfer.amount)
          console.log(`[reconcile] ✓ ${paymentId} matched via transaction_id → ${transfer.id}`)
          return
        }
        // SUCCEEDED but amount mismatch — log and fall through
        if (transfer.state === 'SUCCEEDED') {
          console.warn(`[reconcile] ${paymentId} → transfer SUCCEEDED but amount mismatch: local=${payment.amount_cents} finix=${transfer.amount}`)
        }
        // PENDING or other state — fall through to search
        if (transfer.state === 'PENDING') {
          console.log(`[reconcile] ${paymentId} → transfer still PENDING, falling through to search`)
        }
      } catch (err) {
        console.warn(`[reconcile] ${paymentId} → getTransfer failed:`, (err as Error)?.message ?? err)
        // Fall through to listTransfers search
      }
    }

    // ── Strategy 3: ±5 min window search ─────────────────────────────────
    const paymentMs = new Date(payment.created_at.replace(' ', 'T') + 'Z').getTime()

    let narrowMatch = await searchTransfersByWindow(creds, payment, paymentMs, 5 * 60_000, 'narrow ±5min')
    if (narrowMatch) {
      db.run(`UPDATE payments SET finix_transfer_id = ? WHERE id = ?`, [narrowMatch.id, paymentId])
      await writeResult(merchantId, paymentId, 'matched', narrowMatch.id, payment.amount_cents, narrowMatch.amount)
      console.log(`[reconcile] ✓ ${paymentId} matched via narrow window → ${narrowMatch.id}`)
      return
    }

    // ── Strategy 4: LAST RESORT — ±48 hour window ───────────────────────
    // For payments where the narrow window missed (e.g. old payments,
    // timing skew).  The user says: "the amount matches, that's all we need."
    console.log(`[reconcile] ${paymentId} → narrow window found nothing, trying ±48h last resort`)
    let wideMatch = await searchTransfersByWindow(creds, payment, paymentMs, 48 * 60 * 60_000, 'wide ±48h')
    if (wideMatch) {
      db.run(`UPDATE payments SET finix_transfer_id = ? WHERE id = ?`, [wideMatch.id, paymentId])
      await writeResult(merchantId, paymentId, 'matched', wideMatch.id, payment.amount_cents, wideMatch.amount)
      console.log(`[reconcile] ✓ ${paymentId} matched via LAST RESORT wide window → ${wideMatch.id}`)
      return
    }

    // ── No match at all ──────────────────────────────────────────────────
    await writeResult(merchantId, paymentId, 'unmatched', null, payment.amount_cents, null)
    console.warn(`[reconcile] ⚠ ${paymentId} UNMATCHED — no Finix transfer for $${(payment.amount_cents / 100).toFixed(2)} in any window`)
    logPaymentEvent('reconciliation_unmatched', {
      merchantId, orderId: payment.order_id, paymentId, amountCents: payment.amount_cents,
      level: 'warn',
      message: `No Finix transfer found for $${(payment.amount_cents / 100).toFixed(2)} in ±5min or ±48h window`,
    })

    broadcastToMerchant(merchantId, 'payment_alert', {
      paymentId,
      orderId:     payment.order_id,
      amountCents: payment.amount_cents,
      type:        'unmatched',
    })

    logSecurityEvent('payment_unmatched', {
      merchantId,
      extra: {
        paymentId,
        orderId:     payment.order_id,
        amountCents: payment.amount_cents,
      },
    })
  } catch (err) {
    // SAFETY NET: if ANYTHING above throws (Finix API down, DB error,
    // whatever), write 'unmatched' so the payment never stays "Pending check".
    console.error(`[reconcile] ${paymentId} UNEXPECTED ERROR — writing unmatched as safety net:`, (err as Error)?.message ?? err)
    try {
      await writeResult(merchantId, paymentId, 'unmatched', null, payment.amount_cents, null)
      broadcastToMerchant(merchantId, 'payment_alert', {
        paymentId,
        orderId:     payment.order_id,
        amountCents: payment.amount_cents,
        type:        'unmatched',
      })
    } catch (writeErr) {
      console.error(`[reconcile] ${paymentId} CRITICAL — even writeResult failed:`, (writeErr as Error)?.message ?? writeErr)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Loads Finix credentials for a merchant.  Returns null if not configured.
 */
async function loadFinixCreds(merchantId: string): Promise<FinixCredentials | null> {
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return null

  const db = getDatabase()
  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'
       LIMIT 1`,
    )
    .get(merchantId)

  const parts = keyRow?.pos_merchant_id?.split(':') ?? []
  if (parts.length !== 3) return null
  const [apiUsername, applicationId, finixMerchantId] = parts

  const merchantRow = db
    .query<{ finix_sandbox: number }, [string]>(`SELECT finix_sandbox FROM merchants WHERE id = ?`)
    .get(merchantId)
  const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

  return { apiUsername, applicationId, merchantId: finixMerchantId, apiPassword, sandbox }
}

/**
 * Searches Finix transfers within a time window for an exact amount match.
 * Returns the best match (closest in time) or null.
 */
async function searchTransfersByWindow(
  creds: FinixCredentials,
  payment: PaymentRow,
  paymentMs: number,
  windowMs: number,
  label: string,
): Promise<{ id: string; amount: number } | null> {
  const fromIso = new Date(paymentMs - windowMs).toISOString()
  const toIso   = new Date(paymentMs + windowMs).toISOString()

  let transfers
  try {
    transfers = await listTransfers(creds, { fromIso, toIso, limit: 200 })
    console.log(`[reconcile] ${payment.id} ${label}: ${transfers.length} transfers found`)
  } catch (err) {
    console.warn(`[reconcile] ${payment.id} ${label} listTransfers failed:`, (err as Error)?.message ?? err)
    return null
  }

  // Find SUCCEEDED transfers with exact amount match
  const succeeded = transfers.filter(
    (t) => t.state === 'SUCCEEDED' && t.amount === payment.amount_cents,
  )

  if (succeeded.length === 0) {
    // Log what we DID find for diagnosis
    const states = transfers.reduce<Record<string, number>>((acc, t) => {
      acc[t.state] = (acc[t.state] ?? 0) + 1
      return acc
    }, {})
    console.log(`[reconcile] ${payment.id} ${label}: 0 amount matches for $${(payment.amount_cents / 100).toFixed(2)}, states: ${JSON.stringify(states)}`)
    return null
  }

  // Pick closest to recorded time
  let best = succeeded[0]
  if (succeeded.length > 1) {
    best = succeeded.reduce((prev, t) => {
      const diffPrev = Math.abs(new Date(prev.createdAt).getTime() - paymentMs)
      const diffT    = Math.abs(new Date(t.createdAt).getTime() - paymentMs)
      return diffT < diffPrev ? t : prev
    })
  }

  return { id: best.id, amount: best.amount }
}

// ---------------------------------------------------------------------------
// Online order reconciliation (Finix redirect flow)
// ---------------------------------------------------------------------------

/**
 * Schedules a reconciliation check for an *online* order 60 seconds after
 * the payment return is processed.
 *
 * Called only when the checkout form state is COMPLETED but no transfer ID
 * could be resolved at the time (rare edge case).  On success, writes the
 * transfer ID back to `orders.payment_transfer_id` and broadcasts SSE.
 *
 * @param merchantId  - Internal merchant ID
 * @param orderId     - The order whose payment could not be verified
 * @param amountCents - Expected charge amount in cents
 */
export function scheduleOrderReconciliation(
  merchantId: string,
  orderId: string,
  amountCents: number,
): void {
  const delayMs = Number(process.env.RECONCILE_DELAY_MS ?? 60_000)
  setTimeout(
    () =>
      runOrderReconciliation(merchantId, orderId, amountCents).catch((err) =>
        console.warn('[reconcile] runOrderReconciliation error:', err?.message ?? err),
      ),
    delayMs,
  )
}

/**
 * Searches Finix for a transfer matching the order amount within ±5 minutes
 * of the order's created_at.  If found, writes the transfer ID back to
 * `orders.payment_transfer_id` and broadcasts `payment_alert` (resolved).
 * If not found, broadcasts `payment_alert` (unmatched) for staff attention.
 */
async function runOrderReconciliation(
  merchantId: string,
  orderId: string,
  amountCents: number,
): Promise<void> {
  const db = getDatabase()

  const order = db
    .query<{ created_at: string; payment_transfer_id: string | null }, [string, string]>(
      `SELECT created_at, payment_transfer_id FROM orders WHERE id = ? AND merchant_id = ?`,
    )
    .get(orderId, merchantId)

  if (!order) return
  if (order.payment_transfer_id) return   // already resolved

  const creds = await loadFinixCreds(merchantId)
  if (!creds) return

  const orderMs     = new Date(order.created_at.replace(' ', 'T') + 'Z').getTime()
  const windowStart = new Date(orderMs - 5 * 60_000).toISOString()
  const windowEnd   = new Date(orderMs + 5 * 60_000).toISOString()

  let transfers
  try {
    transfers = await listTransfers(creds, { fromIso: windowStart, toIso: windowEnd, limit: 50 })
  } catch (err) {
    console.warn('[reconcile] order listTransfers failed:', (err as Error)?.message ?? err)
    return
  }

  const succeeded = transfers.filter(
    (t) => t.state === 'SUCCEEDED' && t.amount === amountCents,
  )

  let bestMatch = succeeded[0] ?? null
  if (succeeded.length > 1) {
    bestMatch = succeeded.reduce((best, t) => {
      const db = Math.abs(new Date(best.createdAt).getTime() - orderMs)
      const dt = Math.abs(new Date(t.createdAt).getTime() - orderMs)
      return dt < db ? t : best
    })
  }

  if (bestMatch) {
    db.run(`UPDATE orders SET payment_transfer_id = ? WHERE id = ?`, [bestMatch.id, orderId])
    console.log(`[reconcile] ✓ order ${orderId} matched transfer ${bestMatch.id}`)
    broadcastToMerchant(merchantId, 'payment_alert', {
      orderId,
      amountCents,
      type:       'resolved',
      transferId: bestMatch.id,
    })
  } else {
    console.warn(`[reconcile] ⚠ order ${orderId} UNMATCHED — no Finix transfer for $${(amountCents / 100).toFixed(2)}`)
    broadcastToMerchant(merchantId, 'payment_alert', {
      orderId,
      amountCents,
      type: 'unmatched',
    })
    logSecurityEvent('payment_unmatched', {
      merchantId,
      extra: { orderId, amountCents, source: 'online' },
    })
  }
}

// ---------------------------------------------------------------------------
// Background sweep — periodic catch-up for unreconciled payments
// ---------------------------------------------------------------------------

/** How often to scan for unreconciled card payments (30 seconds). */
const SWEEP_INTERVAL_MS = 30_000

/**
 * Finds every card payment that has no reconciliation record OR is marked
 * 'unmatched' and re-runs `runReconciliation`.
 *
 * This catches:
 *   - Payments whose 60 s timer was lost to a server crash/restart
 *   - Payments that failed due to Finix API errors (now retried)
 *   - Payments that were PENDING on first check but have since settled
 *
 * The INSERT OR REPLACE in `writeResult` is idempotent, so re-checking
 * an already-reconciled payment is a safe no-op.
 */
async function sweepUnreconciled(): Promise<void> {
  const db = getDatabase()

  // 1. Payments with no reconciliation record at all ("Pending check")
  const noRecord = db
    .query<{ id: string; merchant_id: string }, []>(
      `SELECT p.id, p.merchant_id FROM payments p
       LEFT JOIN payment_reconciliations r ON r.payment_id = p.id
       WHERE p.payment_type = 'card' AND r.id IS NULL`,
    )
    .all()

  // 2. Payments marked 'unmatched' — retry ALL of them, not just those
  //    with transaction_id.  The wide ±48h last-resort search may succeed
  //    even when transaction_id is NULL.
  const unmatched = db
    .query<{ id: string; merchant_id: string }, []>(
      `SELECT p.id, p.merchant_id FROM payments p
       JOIN payment_reconciliations r ON r.payment_id = p.id
       WHERE p.payment_type = 'card'
         AND r.status = 'unmatched'`,
    )
    .all()

  const seen = new Set<string>()
  const all = [...noRecord, ...unmatched].filter(p => {
    if (seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })

  if (all.length === 0) return

  console.log(`[reconcile] sweep: ${all.length} unreconciled payment(s) (${noRecord.length} no-record, ${unmatched.length} unmatched)`)
  for (const p of all) {
    await runReconciliation(p.merchant_id, p.id).catch((err) =>
      console.warn('[reconcile] sweep error:', err?.message ?? err),
    )
  }
}

/**
 * Recovers orphaned terminal sales — payments that succeeded on Finix but
 * were never recorded locally (e.g. client timeout, crash, network error).
 *
 * Scans `pending_terminal_sales` rows older than 2 minutes, checks their
 * status on Finix, and auto-creates a payment record if SUCCEEDED.
 */
async function sweepOrphanedTerminalSales(): Promise<void> {
  const db = getDatabase()

  const pending = db
    .query<{
      id: string
      merchant_id: string
      order_id: string
      transfer_id: string
      device_id: string
      amount_cents: number
      created_at: string
    }, []>(
      `SELECT id, merchant_id, order_id, transfer_id, device_id, amount_cents, created_at
       FROM pending_terminal_sales
       WHERE status = 'pending'
         AND created_at <= datetime('now', '-2 minutes')`,
    )
    .all()

  if (pending.length === 0) return

  console.log(`[reconcile] orphan sweep: ${pending.length} pending terminal sale(s) to check`)

  // Bulk-load orders and existing payments for all pending rows — 2 queries instead of 2N.
  // Finix API calls are still per-row (unavoidable network I/O); only DB reads are batched.
  const orderIds = [...new Set(pending.map(r => r.order_id))]
  const oph = orderIds.map(() => '?').join(',')

  type OrderRow = { id: string; status: string; total_cents: number }
  const orderMap = new Map(
    db
      .query<OrderRow, string[]>(`SELECT id, status, total_cents FROM orders WHERE id IN (${oph})`)
      .all(...orderIds)
      .map(o => [o.id, o]),
  )
  const paidOrderIds = new Set(
    db
      .query<{ order_id: string }, string[]>(
        `SELECT DISTINCT order_id FROM payments WHERE order_id IN (${oph})`,
      )
      .all(...orderIds)
      .map(p => p.order_id),
  )

  // Check Finix status per row; classify into delete-only or full recovery.
  // DB writes are deferred so they can be applied atomically in one transaction below.
  type WriteResult =
    | { action: 'delete'; pendingId: string }
    | {
        action: 'recover'
        pendingId: string
        paymentId: string
        row: (typeof pending)[0]
        cardType: string | null
        cardLastFour: string | null
        approvalCode: string | null
        now: string
      }
  const writeResults: WriteResult[] = []

  for (const row of pending) {
    try {
      const creds = await loadFinixCreds(row.merchant_id)
      if (!creds) {
        console.warn(`[reconcile] orphan ${row.id}: no Finix creds, skipping`)
        continue
      }

      const status = await getTerminalTransferStatus(creds, row.transfer_id)
      console.log(`[reconcile] orphan ${row.id}: transfer=${row.transfer_id} state=${status.state} amount=${status.amount}`)

      if (status.state === 'SUCCEEDED') {
        const order = orderMap.get(row.order_id)
        if (!order) {
          console.warn(`[reconcile] orphan ${row.id}: order ${row.order_id} not found, removing`)
          writeResults.push({ action: 'delete', pendingId: row.id })
          continue
        }

        if (paidOrderIds.has(row.order_id)) {
          console.log(`[reconcile] orphan ${row.id}: payment already exists, cleaning up`)
          writeResults.push({ action: 'delete', pendingId: row.id })
          continue
        }

        const paymentId = `pay_${randomBytes(16).toString('hex')}`
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
        writeResults.push({
          action: 'recover',
          pendingId: row.id,
          paymentId,
          row,
          cardType: status.cardBrand?.toLowerCase() ?? null,
          cardLastFour: status.cardLastFour ?? null,
          approvalCode: status.approvalCode ?? null,
          now,
        })

      } else if (status.state === 'FAILED' || status.state === 'CANCELED' || status.state === 'CANCELLED') {
        console.log(`[reconcile] orphan ${row.id}: transfer ${status.state}, removing`)
        writeResults.push({ action: 'delete', pendingId: row.id })

      } else {
        // Still PENDING — leave for next sweep
        console.log(`[reconcile] orphan ${row.id}: still ${status.state}, will retry`)
      }
    } catch (err) {
      console.warn(`[reconcile] orphan ${row.id} error:`, (err as Error)?.message ?? err)
    }
  }

  if (writeResults.length === 0) return

  // Apply all writes in one transaction: 3N individual round-trips → 1 atomic batch.
  const tipCents = 0  // tip was entered on the terminal — included in amount
  db.transaction(() => {
    for (const w of writeResults) {
      if (w.action === 'delete') {
        db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [w.pendingId])
      } else {
        db.run(
          `INSERT INTO payments (
            id, merchant_id, order_id, payment_type, subtotal_cents, tax_cents,
            tip_cents, amex_surcharge_cents, amount_cents, card_type, card_last_four,
            cardholder_name, transaction_id, processor, auth_code,
            signature_base64, receipt_email, split_mode, split_leg_number, split_total_legs,
            split_items_json, finix_transfer_id,
            created_at, completed_at
          ) VALUES (?, ?, ?, 'card', ?, 0, ?, 0, ?, ?, ?, NULL, ?, 'finix', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
          [
            w.paymentId, w.row.merchant_id, w.row.order_id,
            w.row.amount_cents - tipCents,  // subtotal (best guess — full amount since tip is 0)
            tipCents, w.row.amount_cents,
            w.cardType, w.cardLastFour,
            w.row.transfer_id, w.approvalCode,
            w.row.transfer_id,
            w.now, w.now,
          ],
        )
        db.run(
          `UPDATE orders SET status = 'paid', payment_method = 'card',
                 paid_amount_cents = ?, updated_at = datetime('now')
           WHERE id = ? AND merchant_id = ?`,
          [w.row.amount_cents, w.row.order_id, w.row.merchant_id],
        )
        db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [w.pendingId])
      }
    }
  })

  // Post-transaction: logging, SSE notifications, reconciliation scheduling.
  // These are side-effects that must run after the commit, not inside it.
  for (const w of writeResults) {
    if (w.action !== 'recover') continue
    console.log(`[reconcile] ✓ orphan ${w.pendingId}: auto-recovered payment ${w.paymentId} for order ${w.row.order_id} ($${(w.row.amount_cents / 100).toFixed(2)})`)
    logPaymentEvent('orphan_recovered', {
      merchantId: w.row.merchant_id, orderId: w.row.order_id, paymentId: w.paymentId,
      transferId: w.row.transfer_id, deviceId: w.row.device_id, amountCents: w.row.amount_cents,
      message: `Auto-recovered from orphaned terminal sale ${w.pendingId}`,
      extra: { cardBrand: w.cardType, cardLastFour: w.cardLastFour },
    })
    // Notify dashboard clients
    broadcastToMerchant(w.row.merchant_id, 'order_updated', {
      orderId: w.row.order_id,
      status: 'paid',
    })
    // Schedule reconciliation (will instant-match since finix_transfer_id is set)
    scheduleReconciliation(w.row.merchant_id, w.paymentId, 'card')
  }
}

/**
 * Starts the background reconciliation sweep.
 *
 * - Runs once after `initialDelayMs` (default 5 s) so the DB and network
 *   are ready on startup.
 * - Then repeats every `SWEEP_INTERVAL_MS` (30 s) to catch any payments
 *   that failed reconciliation at any point since the last run.
 *
 * @returns cleanup function that cancels the repeating timer
 */
export function startAutoReconcile(initialDelayMs = 5_000): () => void {
  const runSweeps = async () => {
    if (_sweepRunning) {
      console.warn('[reconcile] sweep already in progress — skipping interval tick')
      return
    }
    _sweepRunning = true
    try {
      await sweepOrphanedTerminalSales().catch((err) =>
        console.warn('[reconcile] orphan sweep failed:', err?.message ?? err),
      )
      await sweepUnreconciled().catch((err) =>
        console.warn('[reconcile] payment sweep failed:', err?.message ?? err),
      )
      // Prune payment_events older than 7 days (fire-and-forget, never throws).
      // NOTE: prunePaymentEvents() has no independent scheduler — this sweep is
      // its only call site. If reconciliation is ever disabled, move pruning elsewhere.
      prunePaymentEvents()
    } finally {
      _sweepRunning = false
    }
  }

  const initial = setTimeout(runSweeps, initialDelayMs)
  const interval = setInterval(runSweeps, SWEEP_INTERVAL_MS)

  return () => {
    clearTimeout(initial)
    clearInterval(interval)
  }
}

/**
 * Inserts a row into `payment_reconciliations`.  Idempotent: if a row already
 * exists for the payment_id it is replaced (e.g. re-check after manual retry).
 */
async function writeResult(
  merchantId: string,
  paymentId: string,
  status: ReconciliationStatus,
  finixTransferId: string | null,
  localAmountCents: number | null,
  finixAmountCents: number | null,
): Promise<void> {
  const db = getDatabase()
  const id = `rec_${randomBytes(8).toString('hex')}`

  db.run(
    `INSERT INTO payment_reconciliations
       (id, merchant_id, payment_id, finix_transfer_id, status,
        local_amount_cents, finix_amount_cents, checked_at, alerted)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'),
       CASE WHEN ? = 'unmatched' THEN 1 ELSE 0 END)
     ON CONFLICT(payment_id) DO UPDATE SET
       finix_transfer_id  = excluded.finix_transfer_id,
       status             = excluded.status,
       local_amount_cents = excluded.local_amount_cents,
       finix_amount_cents = excluded.finix_amount_cents,
       checked_at         = excluded.checked_at,
       alerted            = excluded.alerted`,
    [
      id, merchantId, paymentId, finixTransferId, status,
      localAmountCents, finixAmountCents,
      status,
    ],
  )
}
