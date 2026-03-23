/**
 * Refund routes
 *
 * Routing by payment method:
 *   • Finix online  (payment_checkout_form_id set)           → POST /transfers/:id/reversals
 *   • Finix terminal (payment_provider=finix + card, no form) → POST /transfers/:id/reversals
 *   • Converge (payment_transfer_id set, non-Finix merchant)  → CCRETURN XML API
 *   • Cash / pre-migration (neither set)                      → record-only
 *
 * If the processor API call fails the refund is NOT recorded locally —
 * no partial state where money wasn't moved but the UI shows it was.
 *
 * POST /api/merchants/:id/orders/:orderId/refunds  — process and record a refund
 * GET  /api/merchants/:id/orders/:orderId/refunds  — list refunds for an order
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { authenticate, requireRole } from '../middleware/auth'
import { generateId } from '../utils/id'
import { getAPIKey } from '../crypto/api-keys'
import { getTransferIdFromCheckoutForm, getTransfer as getFinixTransfer, createRefund as createFinixRefund, listTransfers } from '../adapters/finix'
import { createConvergeRefund } from '../adapters/converge'
import type { AuthContext } from '../middleware/auth'

const dashboardRefunds = new Hono()

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders/:orderId/refunds
// Record a refund (full or partial). Requires payment_method to be set on the order.
// Body: {
//   type: 'full' | 'partial'
//   items?: Array<{ itemIndex, dishName, quantity, amountCents, taxCents }>
//   notes?: string
// }
// ---------------------------------------------------------------------------
dashboardRefunds.post(
  '/api/merchants/:id/orders/:orderId/refunds',
  authenticate,
  async (c: AuthContext) => {
    const user = c.get('user')
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const db = getDatabase()

    // Check if staff may record refunds (merchant-level setting)
    const merchant = db
      .query<{ staff_can_refund: number; payment_provider: string | null; finix_refund_mode: string; finix_sandbox: number }, [string]>(
        `SELECT staff_can_refund, payment_provider, COALESCE(finix_refund_mode, 'local') AS finix_refund_mode, finix_sandbox FROM merchants WHERE id = ?`
      )
      .get(merchantId)

    if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

    const canRefund =
      ['owner', 'manager'].includes(user.role) ||
      merchant.staff_can_refund === 1

    if (!canRefund) {
      return c.json({ error: 'Only managers and owners can record refunds' }, 403)
    }

    // Fetch the order
    const order = db
      .query<{
        paid_amount_cents: number
        total_cents: number
        tax_cents: number
        subtotal_cents: number
        payment_method: string | null
        payment_checkout_form_id: string | null
        payment_transfer_id: string | null
        created_at: string
      }, [string, string]>(
        `SELECT paid_amount_cents, total_cents, tax_cents, subtotal_cents,
                payment_method, payment_checkout_form_id, payment_transfer_id,
                created_at
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    if (!order.payment_method) {
      return c.json({ error: 'Order has not been paid — nothing to refund' }, 422)
    }

    // For orders placed before paid_amount_cents was recorded (pre-fix online orders),
    // fall back to total_cents as the paid amount.
    const effectivePaidCents =
      order.paid_amount_cents > 0 ? order.paid_amount_cents : order.total_cents

    // How much has already been refunded (amount + tax)?
    const existingRow = db
      .query<{ total: number; taxTotal: number }, [string]>(
        `SELECT COALESCE(SUM(refund_amount_cents), 0) AS total,
                COALESCE(SUM(tax_refunded_cents), 0)  AS taxTotal
         FROM refunds WHERE order_id = ?`
      )
      .get(orderId)

    const alreadyRefunded    = existingRow?.total    ?? 0
    const alreadyTaxRefunded = existingRow?.taxTotal ?? 0
    const maxRefundable = effectivePaidCents - alreadyRefunded

    if (maxRefundable <= 0) {
      return c.json({ error: 'Order has already been fully refunded' }, 422)
    }

    // Parse body
    type RefundItem = {
      itemIndex: number
      dishName: string
      quantity: number
      amountCents: number
      taxCents: number
    }
    const body = await c.req.json<{
      type: 'full' | 'partial'
      items?: RefundItem[]
      notes?: string
    }>()

    if (!body.type || !['full', 'partial'].includes(body.type)) {
      return c.json({ error: 'type must be "full" or "partial"' }, 400)
    }

    let refundAmountCents: number
    let taxRefundedCents: number
    let itemsJson: string | null = null

    // C-08: Maximum tax that can still be refunded
    const maxTaxRefundable = order.tax_cents - alreadyTaxRefunded

    if (body.type === 'full') {
      refundAmountCents = maxRefundable
      // Refund remaining tax (capped at what's left)
      taxRefundedCents = Math.max(0, maxTaxRefundable)
    } else {
      if (!body.items || body.items.length === 0) {
        return c.json({ error: 'items are required for a partial refund' }, 400)
      }
      refundAmountCents = body.items.reduce((s, it) => s + it.amountCents, 0)
      taxRefundedCents  = body.items.reduce((s, it) => s + it.taxCents, 0)

      if (refundAmountCents <= 0) {
        return c.json({ error: 'Refund amount must be greater than zero' }, 400)
      }
      if (refundAmountCents > maxRefundable) {
        return c.json(
          { error: `Refund amount ($${(refundAmountCents / 100).toFixed(2)}) exceeds remaining refundable balance ($${(maxRefundable / 100).toFixed(2)})` },
          422
        )
      }
      // C-08: Cap cumulative tax refund at the order's original tax
      if (taxRefundedCents > maxTaxRefundable) {
        taxRefundedCents = Math.max(0, maxTaxRefundable)
      }
      itemsJson = JSON.stringify(body.items)
    }

    // -----------------------------------------------------------------------
    // Deduplication: reject if a refund was already recorded in the last 30 s.
    // Prevents double-tap on the dashboard from issuing duplicate reversals.
    // -----------------------------------------------------------------------
    const recentRefund = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM refunds
         WHERE order_id = ? AND merchant_id = ?
           AND created_at > datetime('now', '-30 seconds')
         LIMIT 1`
      )
      .get(orderId, merchantId)
    if (recentRefund) {
      return c.json({ error: 'A refund was already submitted for this order — please wait and refresh' }, 409)
    }

    // -----------------------------------------------------------------------
    // Issue the live financial refund via the payment processor before writing
    // the local record. If the API call fails the refund is NOT recorded.
    //
    // Routing logic:
    //   • finix_refund_mode='local'                             → accounting only (no API call)
    //   • payment_checkout_form_id set + mode='api'             → Finix reversal API
    //   • payment_provider='finix' + card + mode='api'          → Finix reversal API
    //   • payment_transfer_id set + card (non-Finix)            → Converge API
    //   • cash / pre-migration (neither set)                    → record-only
    // -----------------------------------------------------------------------
    const isFinixLocalRefund = merchant.finix_refund_mode === 'local'
    let processorRefundId: string | null = null
    // Generate refundId early so it can serve as the Finix idempotency_id.
    // If the Finix API call succeeds but the local INSERT fails (crash/restart),
    // retrying hits Finix's idempotency guard instead of creating a duplicate reversal.
    const refundId = generateId('ref')

    const isFinixOnline   = !!order.payment_checkout_form_id
    const isFinixTerminal = !isFinixOnline &&
      order.payment_method === 'card' &&
      merchant.payment_provider === 'finix'

    if ((isFinixOnline || isFinixTerminal) && !isFinixLocalRefund) {
      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`
        )
        .get(merchantId)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      const parts = posMerchantId.split(':')

      if (parts.length === 3 && !parts.some(p => !p.trim())) {
        const [apiUsername, applicationId, finixMerchantId] = parts

        const sandbox = (merchant.finix_sandbox ?? 1) !== 0

        const apiPassword = await getAPIKey(merchantId, 'payment', 'finix')
        if (!apiPassword) {
          return c.json({ error: 'Finix credentials not configured — cannot process refund' }, 502)
        }

        const creds = { apiUsername, applicationId, merchantId: finixMerchantId, apiPassword, sandbox }

        // Resolve the Finix transfer ID for this payment.
        //
        // Online:   stored on order (payment_transfer_id) → checkout form API
        // Terminal: stored in payments table (transaction_id) → order fallback
        let transferId: string | null = order.payment_transfer_id

        if (!transferId && isFinixTerminal) {
          // Terminal payments store the Finix transfer ID in the payments table,
          // not on the order. Look up the most recent payment leg.
          const paymentRow = db
            .query<{ transaction_id: string | null }, [string]>(
              `SELECT transaction_id FROM payments
               WHERE order_id = ? AND transaction_id IS NOT NULL
               ORDER BY created_at DESC LIMIT 1`
            )
            .get(orderId)
          transferId = paymentRow?.transaction_id ?? null
        }

        if (!transferId && isFinixOnline && order.payment_checkout_form_id) {
          try {
            const result = await getTransferIdFromCheckoutForm(creds, order.payment_checkout_form_id)
            transferId = result.transferId
          } catch (err) {
            console.error('[refunds] Failed to fetch Finix transfer:', err)
            return c.json({ error: 'Could not retrieve Finix transfer — refund not processed' }, 502)
          }
        }

        // Fallback: search Finix transfers by amount and time window
        if (!transferId) {
          try {
            const orderMs     = new Date(order.created_at.replace(' ', 'T') + 'Z').getTime()
            const windowStart = new Date(orderMs - 10 * 60_000).toISOString()
            const windowEnd   = new Date(orderMs + 10 * 60_000).toISOString()
            const transfers   = await listTransfers(creds, { fromIso: windowStart, toIso: windowEnd, limit: 50 })
            const match       = transfers.find(t => t.amount === order.total_cents && t.state === 'SUCCEEDED')
                             ?? transfers.find(t => t.amount === order.total_cents)
            if (match) {
              transferId = match.id
              db.run(`UPDATE orders SET payment_transfer_id = ? WHERE id = ?`, [transferId, orderId])
              console.log(`[refunds] Resolved transfer via listTransfers: ${transferId}`)
            }
          } catch (err) {
            console.warn('[refunds] listTransfers fallback failed:', (err as Error)?.message ?? err)
          }
        }

        if (!transferId) {
          return c.json({ error: 'Finix transfer not found for this order — refund not processed' }, 502)
        }

        // Preflight: verify the transfer is in a reversible state.
        // Finix only allows reversals on SUCCEEDED transfers.
        // PENDING is common in sandbox (transfers don't auto-settle).
        let transferState: string
        try {
          const transfer = await getFinixTransfer(creds, transferId)
          transferState = transfer.state
        } catch (err) {
          console.error(`[refunds] Could not fetch Finix transfer state — transferId=${transferId}:`, err)
          return c.json(
            { error: err instanceof Error ? err.message : 'Could not verify payment status with Finix' },
            502
          )
        }

        if (transferState !== 'SUCCEEDED') {
          console.warn(`[refunds] Finix transfer ${transferId} is ${transferState} — cannot reverse yet`)
          return c.json(
            { error: `Payment has not settled yet (Finix status: ${transferState}) — please try again in a few minutes` },
            422
          )
        }

        try {
          // For full refunds omit the amount — Finix reverses the entire transfer.
          // Passing an explicit amount equal to the transfer total can be rejected
          // by Finix sandbox if their rounding or state differs by even one cent.
          const finixAmount = body.type === 'full' ? undefined : refundAmountCents
          processorRefundId = await createFinixRefund(creds, transferId, finixAmount, refundId)
        } catch (err) {
          console.error(`[refunds] Finix reversal failed — orderId=${orderId} transferId=${transferId} amountCents=${refundAmountCents}:`, err)
          return c.json(
            { error: err instanceof Error ? err.message : 'Finix refund failed — no money was moved' },
            502
          )
        }
      }
    } else if (order.payment_transfer_id && order.payment_method === 'card') {
      // -----------------------------------------------------------------------
      // Converge CCRETURN — uses ssl_txn_id stored as payment_transfer_id
      // -----------------------------------------------------------------------
      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'converge'`
        )
        .get(merchantId)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      if (posMerchantId.includes(':')) {
        const [sslMerchantId, sslUserId] = posMerchantId.split(':')

        const merchantRow = db
          .query<{ converge_sandbox: number }, [string]>(
            `SELECT converge_sandbox FROM merchants WHERE id = ?`
          )
          .get(merchantId)
        const sandbox = (merchantRow?.converge_sandbox ?? 1) !== 0

        const sslPin = await getAPIKey(merchantId, 'payment', 'converge')
        if (!sslPin) {
          return c.json({ error: 'Converge credentials not configured — cannot process refund' }, 502)
        }

        const amountDollars = (refundAmountCents / 100).toFixed(2)
        try {
          const result = await createConvergeRefund(
            { sslMerchantId, sslUserId, sslPin, sandbox },
            order.payment_transfer_id,
            amountDollars,
          )
          processorRefundId = result.refundTxnId
        } catch (err) {
          console.error('[refunds] Converge CCRETURN error:', err)
          return c.json(
            { error: err instanceof Error ? err.message : 'Converge refund failed — no money was moved' },
            502
          )
        }
      }
    }

    // Resolve the user's display name from the DB (JWT doesn't carry full_name)
    const userRow = db
      .query<{ full_name: string }, [string]>(`SELECT full_name FROM users WHERE id = ?`)
      .get(user.sub)
    const refundedByName = userRow?.full_name ?? user.sub

    // Wrap INSERT + optional status update in a single transaction so a crash
    // between the two writes cannot leave the DB in a partially-updated state.
    db.transaction(() => {
      db.run(
        `INSERT INTO refunds
           (id, order_id, merchant_id, type, refund_amount_cents, tax_refunded_cents,
            items_json, notes, refunded_by_id, refunded_by_name, processor_refund_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          refundId,
          orderId,
          merchantId,
          body.type,
          refundAmountCents,
          taxRefundedCents,
          itemsJson,
          body.notes ?? null,
          user.sub,
          refundedByName,
          processorRefundId,
        ]
      )

      // Mark the order as refunded for full refunds so dashboard reflects the status.
      if (body.type === 'full') {
        db.run(
          `UPDATE orders SET status = 'refunded', updated_at = datetime('now') WHERE id = ?`,
          [orderId]
        )
      }
    })()

    return c.json(
      {
        refund: {
          id: refundId,
          type: body.type,
          refundAmountCents,
          taxRefundedCents,
          notes: body.notes ?? null,
          refundedByName,
          processorRefundId,
          // True when the processor API was called and money was moved.
          // False for cash orders or pre-migration card orders (record-only).
          processorRefunded: processorRefundId !== null,
          createdAt: new Date().toISOString(),
        },
      },
      201
    )
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/orders/:orderId/refunds
// List all refunds recorded for an order.
// ---------------------------------------------------------------------------
dashboardRefunds.get(
  '/api/merchants/:id/orders/:orderId/refunds',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const db = getDatabase()

    type RefundRow = {
      id: string
      type: string
      refund_amount_cents: number
      tax_refunded_cents: number
      items_json: string | null
      notes: string | null
      refunded_by_name: string | null
      created_at: string
    }

    const rows = db
      .query<RefundRow, [string, string]>(
        `SELECT id, type, refund_amount_cents, tax_refunded_cents,
                items_json, notes, refunded_by_name, created_at
         FROM refunds
         WHERE order_id = ? AND merchant_id = ?
         ORDER BY created_at ASC`
      )
      .all(orderId, merchantId)

    return c.json({
      refunds: rows.map((r) => ({
        id: r.id,
        type: r.type,
        refundAmountCents: r.refund_amount_cents,
        taxRefundedCents: r.tax_refunded_cents,
        items: (() => { try { return r.items_json ? JSON.parse(r.items_json) : null } catch { return null } })(),
        notes: r.notes,
        refundedByName: r.refunded_by_name,
        createdAt: r.created_at,
      })),
    })
  }
)

export { dashboardRefunds }
