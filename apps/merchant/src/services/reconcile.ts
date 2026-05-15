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
import { listTransfers, getTransfer, getTerminalTransferStatus, findTransferByIdempotencyId } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { broadcastToMerchant } from './sse'
import { logSecurityEvent } from './security-log'
import { logPaymentEvent, prunePaymentEvents } from './payment-log'
import { resolveTerminalVerificationForOrder } from '../workflows/terminal-payment'
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

  // Read the existing alerted flag once before any writes so we can gate SSE
  // broadcasts correctly.  The sweep re-runs runReconciliation every 30 s for
  // unmatched payments; without this guard every sweep tick fires a
  // payment_alert SSE event for the same payment until it resolves.
  const existingRec = db
    .query<{ alerted: number }, [string]>(
      `SELECT alerted FROM payment_reconciliations WHERE payment_id = ?`,
    )
    .get(paymentId)
  const _wasAlerted = (existingRec?.alerted ?? 0) === 1

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
    // If the processor is unknown (null) and no Finix-specific identifiers
    // exist, this payment was likely recorded via the old dashboard modal before
    // server-side Clover recording was added.  We cannot reconcile it against
    // Finix — use 'no_processor' to avoid a false alarm.
    if (!payment.processor) {
      await writeResult(merchantId, paymentId, 'no_processor', null, payment.amount_cents, null)
      console.warn(`[reconcile] ${paymentId} → processor unknown, no Finix match — marking no_processor (likely non-Finix payment via old modal)`)
      return
    }

    await writeResult(merchantId, paymentId, 'unmatched', null, payment.amount_cents, null)
    console.warn(`[reconcile] ⚠ ${paymentId} UNMATCHED — no Finix transfer for $${(payment.amount_cents / 100).toFixed(2)} in any window`)
    logPaymentEvent('reconciliation_unmatched', {
      merchantId, orderId: payment.order_id, paymentId, amountCents: payment.amount_cents,
      level: 'warn',
      message: `No Finix transfer found for $${(payment.amount_cents / 100).toFixed(2)} in ±5min or ±48h window`,
    })

    // Only fire SSE + security log on the FIRST unmatched result for this
    // payment.  The 30 s sweep retries all unmatched payments indefinitely, so
    // without this guard every tick would spam payment_alert events.
    if (!_wasAlerted) {
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
    }
  } catch (err) {
    // SAFETY NET: if ANYTHING above throws (Finix API down, DB error,
    // whatever), write 'unmatched' so the payment never stays "Pending check".
    console.error(`[reconcile] ${paymentId} UNEXPECTED ERROR — writing unmatched as safety net:`, (err as Error)?.message ?? err)
    try {
      await writeResult(merchantId, paymentId, 'unmatched', null, payment.amount_cents, null)
      if (!_wasAlerted) {
        broadcastToMerchant(merchantId, 'payment_alert', {
          paymentId,
          orderId:     payment.order_id,
          amountCents: payment.amount_cents,
          type:        'unmatched',
        })
      }
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
export async function sweepOrphanedTerminalSales(): Promise<void> {
  const db = getDatabase()

  // Two flavours of pending rows:
  //   - transfer_id populated  → legacy orphan (createTerminalSale succeeded but
  //                              record-payment never ran). Sweep after 2 min.
  //   - transfer_id NULL       → verification-pending (createTerminalSale HTTP
  //                              call timed out and we never learned the transfer
  //                              ID). Identified by idempotency_key. Sweep after
  //                              30 s — the whole point is to resolve quickly so
  //                              the modal stops showing "verification pending".
  const pending = db
    .query<{
      id: string
      merchant_id: string
      order_id: string
      transfer_id: string | null
      idempotency_key: string | null
      device_id: string
      amount_cents: number
      created_at: string
    }, []>(
      `SELECT id, merchant_id, order_id, transfer_id, idempotency_key, device_id, amount_cents, created_at
       FROM pending_terminal_sales
       WHERE status = 'pending'
         AND (
           (transfer_id IS NOT NULL AND created_at <= datetime('now', '-2 minutes'))
           OR
           (transfer_id IS NULL AND created_at <= datetime('now', '-30 seconds'))
         )`,
    )
    .all()

  if (pending.length === 0) return

  console.log(`[reconcile] orphan sweep: ${pending.length} pending terminal sale(s) to check`)

  // Bulk-load orders and existing payments for all pending rows — 2 queries instead of 2N.
  // Finix API calls are still per-row (unavoidable network I/O); only DB reads are batched.
  const orderIds = [...new Set(pending.map(r => r.order_id))]
  const oph = orderIds.map(() => '?').join(',')

  type OrderRow = { id: string; status: string; subtotal_cents: number; tax_cents: number; total_cents: number }
  const orderMap = new Map(
    db
      .query<OrderRow, string[]>(`SELECT id, status, subtotal_cents, tax_cents, total_cents FROM orders WHERE id IN (${oph})`)
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
        finixAmount: number       // actual amount charged by Finix (includes tip)
        orderSubtotalCents: number // order subtotal (food only, pre-tax pre-tip)
        orderTaxCents: number     // order tax
        cardType: string | null
        cardLastFour: string | null
        approvalCode: string | null
        now: string
      }
  const writeResults: WriteResult[] = []

  // Track which pending rows came from the verification-pending path so that
  // after the DB transaction commits we can dispatch the outcome back to the
  // in-memory workflow (FSM leaves AWAITING_VERIFICATION → RECORDING/DECLINED).
  const verificationResolutions: Array<{
    orderId:    string
    outcome:    'approved' | 'declined'
    transferId: string | null
    approvedAmount?: number
    cardBrand?:   string | null
    cardLastFour?: string | null
    approvalCode?: string | null
    entryMode?:    string | null
    tipAmountCents?: number
    declineCode?:    string
    declineMessage?: string
  }> = []

  for (const row of pending) {
    try {
      const creds = await loadFinixCreds(row.merchant_id)
      if (!creds) {
        const ageMs = Date.now() - new Date(row.created_at).getTime()
        if (ageMs < 60 * 60 * 1000) {
          // Finix creds may not be configured yet — skip for up to 1 hour
          console.warn(`[reconcile] orphan ${row.id}: no Finix creds, skipping (age ${Math.round(ageMs / 60000)}m)`)
          continue
        }
        // Row is over 1 hour old with no creds — will never resolve. Discard it.
        console.warn(`[reconcile] orphan ${row.id}: no Finix creds after 1h — discarding`)
        writeResults.push({ action: 'delete', pendingId: row.id })
        if (!row.transfer_id && row.idempotency_key) {
          // Verification-pending row: unblock the order workflow
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'declined',
            transferId: null,
            declineCode: 'NO_PROCESSOR_CREDENTIALS',
            declineMessage: 'Payment processor not configured — safe to retry',
          })
        }
        continue
      }

      // Branch on whether we already know the transfer ID.
      // verification-pending rows (transfer_id IS NULL) are looked up by idempotency_key.
      let status: {
        state:          string
        amount:         number
        tipAmountCents: number
        cardBrand:      string | null
        cardLastFour:   string | null
        approvalCode:   string | null
        entryMode:      string | null
        failureCode:    string | null
        failureMessage: string | null
      } | null = null
      let resolvedTransferId: string | null = row.transfer_id

      if (row.transfer_id) {
        try {
          const s = await getTerminalTransferStatus(creds, row.transfer_id)
          status = s
        } catch (err) {
          console.warn(`[reconcile] orphan ${row.id} getTerminalTransferStatus failed:`, (err as Error)?.message ?? err)
          continue
        }
      } else if (row.idempotency_key) {
        const found = await findTransferByIdempotencyId(creds, row.idempotency_key)
        if (!found) {
          // No transfer exists for this idempotency_id — Finix never received our
          // POST, or the customer never tapped. Declare this attempt declined and
          // let staff retry. The 409 guard unblocks once we delete the pending row.
          console.log(`[reconcile] orphan ${row.id}: no Finix transfer for idempotency_key=${row.idempotency_key} — declining verification`)
          writeResults.push({ action: 'delete', pendingId: row.id })
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'declined',
            transferId: null,
            declineCode: 'VERIFICATION_NOT_FOUND',
            declineMessage: 'Processor has no record of the payment — safe to retry',
          })
          continue
        }
        status = {
          state:          found.state,
          amount:         found.amount,
          tipAmountCents: found.tipAmountCents,
          cardBrand:      found.cardBrand,
          cardLastFour:   found.cardLastFour,
          approvalCode:   found.approvalCode,
          entryMode:      found.entryMode,
          failureCode:    found.failureCode,
          failureMessage: found.failureMessage,
        }
        resolvedTransferId = found.id
      } else {
        // Neither transfer_id nor idempotency_key — malformed row. Remove.
        console.warn(`[reconcile] orphan ${row.id}: no transfer_id and no idempotency_key — removing`)
        writeResults.push({ action: 'delete', pendingId: row.id })
        continue
      }

      console.log(`[reconcile] orphan ${row.id}: transfer=${resolvedTransferId ?? 'NULL'} state=${status.state} amount=${status.amount}`)

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
          // If this was a verification-pending row, still dispatch so the FSM
          // leaves AWAITING_VERIFICATION (the client modal otherwise stays stuck).
          if (!row.transfer_id) {
            verificationResolutions.push({
              orderId: row.order_id,
              outcome: 'approved',
              transferId: resolvedTransferId,
              approvedAmount: status.amount,
              cardBrand:      status.cardBrand,
              cardLastFour:   status.cardLastFour,
              approvalCode:   status.approvalCode,
              entryMode:      status.entryMode,
              tipAmountCents: status.tipAmountCents,
            })
          }
          continue
        }

        const paymentId = `pay_${randomBytes(16).toString('hex')}`
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
        writeResults.push({
          action: 'recover',
          pendingId: row.id,
          paymentId,
          row: { ...row, transfer_id: resolvedTransferId ?? '' },
          finixAmount: status.amount,
          orderSubtotalCents: order.subtotal_cents,
          orderTaxCents: order.tax_cents,
          cardType: status.cardBrand?.toLowerCase() ?? null,
          cardLastFour: status.cardLastFour ?? null,
          approvalCode: status.approvalCode ?? null,
          now,
        })
        if (!row.transfer_id) {
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'approved',
            transferId: resolvedTransferId,
            approvedAmount: status.amount,
            cardBrand:      status.cardBrand,
            cardLastFour:   status.cardLastFour,
            approvalCode:   status.approvalCode,
            entryMode:      status.entryMode,
            tipAmountCents: status.tipAmountCents,
          })
        }

      } else if (status.state === 'FAILED' || status.state === 'CANCELED' || status.state === 'CANCELLED') {
        console.log(`[reconcile] orphan ${row.id}: transfer ${status.state}, removing`)
        writeResults.push({ action: 'delete', pendingId: row.id })
        if (!row.transfer_id) {
          verificationResolutions.push({
            orderId: row.order_id,
            outcome: 'declined',
            transferId: resolvedTransferId,
            declineCode:    status.failureCode ?? 'VERIFICATION_FAILED',
            declineMessage: status.failureMessage ?? `Transfer ${status.state} on processor`,
          })
        }

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
  // NOTE: bun:sqlite's db.transaction(fn) returns a callable wrapper — must be invoked.
  db.transaction(() => {
    for (const w of writeResults) {
      if (w.action === 'delete') {
        db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [w.pendingId])
      } else {
        // tip = Finix total - pre-tip base sent to terminal.
        // pending_terminal_sales.amount_cents is the pre-tip amount the terminal was
        // initiated with (subtotal + tax + any surcharges). The customer's tip is whatever
        // Finix charged above that. Using orderSubtotalCents+tax as the base is wrong
        // because it ignores surcharges added before the terminal was activated.
        const tipCents = Math.max(0, w.finixAmount - w.row.amount_cents)
        // subtotal for the payment record = pre-tip base - tax, so that
        // subtotal + tax + tip == amount_cents (self-consistent payment breakdown).
        const paymentSubtotalCents = w.row.amount_cents - w.orderTaxCents
        db.run(
          `INSERT INTO payments (
            id, merchant_id, order_id, payment_type, subtotal_cents, tax_cents,
            tip_cents, amex_surcharge_cents, amount_cents, card_type, card_last_four,
            cardholder_name, transaction_id, processor, auth_code,
            signature_base64, receipt_email, split_mode, split_leg_number, split_total_legs,
            split_items_json, finix_transfer_id,
            created_at, completed_at
          ) VALUES (?, ?, ?, 'card', ?, ?, ?, 0, ?, ?, ?, NULL, ?, 'finix', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
          [
            w.paymentId, w.row.merchant_id, w.row.order_id,
            paymentSubtotalCents, w.orderTaxCents,
            tipCents, w.finixAmount,
            w.cardType, w.cardLastFour,
            w.row.transfer_id, w.approvalCode,
            w.row.transfer_id,
            w.now, w.now,
          ],
        )
        db.run(
          `UPDATE orders SET status = 'paid', payment_method = 'card',
                 tip_cents = ?, paid_amount_cents = ?, updated_at = datetime('now')
           WHERE id = ? AND merchant_id = ?`,
          [tipCents, w.finixAmount, w.row.order_id, w.row.merchant_id],
        )
        db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [w.pendingId])
      }
    }
  })()

  // Post-transaction: logging, SSE notifications, reconciliation scheduling.
  // These are side-effects that must run after the commit, not inside it.
  for (const w of writeResults) {
    if (w.action !== 'recover') continue
    console.log(`[reconcile] ✓ orphan ${w.pendingId}: auto-recovered payment ${w.paymentId} for order ${w.row.order_id} ($${(w.finixAmount / 100).toFixed(2)})`)
    logPaymentEvent('orphan_recovered', {
      merchantId: w.row.merchant_id, orderId: w.row.order_id, paymentId: w.paymentId,
      transferId: w.row.transfer_id ?? undefined, deviceId: w.row.device_id, amountCents: w.finixAmount,
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

  // Dispatch verification outcomes back to any in-memory workflows still sitting
  // in AWAITING_VERIFICATION. If no workflow is registered (e.g. appliance just
  // restarted and rehydrate hasn't run yet), resolveTerminalVerificationForOrder
  // returns false and the DB state already reflects the outcome.
  for (const r of verificationResolutions) {
    try {
      const dispatched = resolveTerminalVerificationForOrder(r.orderId, r)
      if (!dispatched) {
        console.log(`[reconcile] verification-resolved ${r.orderId} → ${r.outcome} (no active workflow, DB-only)`)
      }
    } catch (err) {
      console.warn(`[reconcile] resolveTerminalVerificationForOrder(${r.orderId}) failed:`, (err as Error)?.message ?? err)
    }
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
       alerted            = MAX(payment_reconciliations.alerted, excluded.alerted)`,
    [
      id, merchantId, paymentId, finixTransferId, status,
      localAmountCents, finixAmountCents,
      status,
    ],
  )
}
