/**
 * Clover Order Client
 *
 * Pushes Kizo in-store orders to a Clover Flex terminal as custom line
 * items (Order Injection pattern). Clover handles tax, tip, payment, and
 * receipt locally — no menu catalog sync required.
 *
 * Intentionally NOT registered in adapters/registry.ts. This is a standalone
 * service used only for in-store dashboard orders.
 *
 * Usage:
 *   const client = new CloverOrderClient()
 *   if (client.isEnabled()) {
 *     client.pushOrder(order).catch(err => console.error('[clover]', err))
 *   }
 */

import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Clover API response types (internal — not part of POSAdapter contract)
// ---------------------------------------------------------------------------

interface CloverPayment {
  id: string
  /** Total charged in cents (subtotal + tax + tip) */
  amount: number
  /** Tax portion in cents (set by Clover tax config) */
  taxAmount?: number
  /** Tip in cents (entered by customer on device) */
  tipAmount?: number
  result: 'SUCCESS' | 'FAIL'
  cardTransaction?: {
    /** e.g. 'VISA', 'MC', 'AMEX' */
    cardType: string
    type: 'CREDIT' | 'DEBIT' | 'CASH' | 'GIFT_CARD'
  }
}

interface CloverOrderWithPayments {
  id: string
  state: 'open' | 'locked' | 'paid' | 'deleted'
  /** Set to 'PAID' when device collects payment (order state becomes 'locked', not 'paid') */
  paymentState?: 'PAID' | 'OPEN' | 'REFUNDED' | 'CREDITED' | 'PARTIALLY_REFUNDED' | 'PARTIALLY_PAID'
  total: number
  payments?: { elements: CloverPayment[] }
}

// ---------------------------------------------------------------------------
// Input shape expected from Kizo order rows
// ---------------------------------------------------------------------------

export interface KizoOrderItem {
  dishName: string
  priceCents: number
  quantity: number
  modifiers?: Array<{ name: string; priceCents: number }>
}

export interface KizoOrder {
  id: string
  merchant_id: string
  customer_name: string
  order_type: string
  table_label?: string | null
  notes?: string | null
  clover_order_id?: string | null
  items: KizoOrderItem[] | string  // may be JSON string from DB row
  /** Tax rate as a decimal (e.g. 0.104 for 10.4%). When provided, a "Tax" line
   *  item is added to the Clover order so the total reflects the full charge. */
  tax_rate?: number | null
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type WaitForPaymentResult =
  | { status: 'paid'; paymentId: string; paymentMethod: string; totalCents: number }
  | { status: 'cancelled' }
  | { status: 'timeout' }

// ---------------------------------------------------------------------------
// CloverOrderClient
// ---------------------------------------------------------------------------

/** Clover API base URLs */
const CLOVER_API_BASE = {
  production: 'https://api.clover.com',
  sandbox: 'https://sandbox.dev.clover.com',
}

export class CloverOrderClient {
  private readonly merchantId: string | undefined
  private readonly apiToken: string | undefined
  private readonly employeeId: string | undefined
  private readonly orderTypeId: string | undefined
  private readonly baseUrl: string

  constructor(opts?: { merchantId?: string; apiToken?: string; deviceId?: string; employeeId?: string; orderTypeId?: string; sandbox?: boolean }) {
    this.merchantId  = opts?.merchantId  ?? process.env.CLOVER_MERCHANT_ID
    this.apiToken    = opts?.apiToken    ?? process.env.CLOVER_API_TOKEN
    this.employeeId  = opts?.employeeId  ?? process.env.CLOVER_EMPLOYEE_ID
    this.orderTypeId = opts?.orderTypeId ?? process.env.CLOVER_ORDER_TYPE_ID
    const sandbox    = opts?.sandbox     ?? (process.env.CLOVER_SANDBOX === 'true')
    this.baseUrl     = sandbox ? CLOVER_API_BASE.sandbox : CLOVER_API_BASE.production
  }

  /**
   * Returns true when both `CLOVER_MERCHANT_ID` and `CLOVER_API_TOKEN` are
   * present. When false, all methods are no-ops and never make network calls.
   */
  isEnabled(): boolean {
    return Boolean(this.merchantId && this.apiToken)
  }

  // ---------------------------------------------------------------------------
  // Core HTTP helper (with 429 retry + 10 s timeout)
  // ---------------------------------------------------------------------------

  /**
   * Authenticated fetch wrapper for the Clover REST API.
   * Retries up to 3 times on HTTP 429 with exponential backoff + 10s timeout.
   *
   * Note: CloverMenuImporter (adapters/clover.ts) has a parallel implementation
   * intentionally kept separate: it uses linear backoff and no request timeout
   * (menu imports are batch operations that can legitimately run longer).
   * Do not unify without preserving both sets of behavior.
   */
  async makeRequest<T>(method: string, path: string, body?: unknown, attempt = 1): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Accept': 'application/json',
    }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
    }

    const options: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(10_000),
    }

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)

    if (response.status === 429 && attempt <= 3) {
      const retryAfterMs = Number(response.headers.get('Retry-After') ?? 0) * 1000 || Math.pow(2, attempt - 1) * 1000
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
      return this.makeRequest<T>(method, path, body, attempt + 1)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Clover API error (${response.status}): ${errorText || response.statusText}`)
    }

    if (response.status === 204) return {} as T

    return response.json() as Promise<T>
  }

  // ---------------------------------------------------------------------------
  // pushOrder — Story 2
  // ---------------------------------------------------------------------------

  /**
   * Pushes a Kizo order to Clover as custom line items.
   *
   * - Idempotent: returns immediately if `clover_order_id` is already set.
   * - Persists `clover_order_id` to `orders` table after order creation.
   * - If a line item POST fails mid-loop, the partial state is logged and
   *   kept (acceptable for MVP; reconcile() handles gaps).
   *
   * @param order  Kizo order row (or subset with required fields)
   * @param db     bun:sqlite Database instance
   * @returns      The Clover order ID created
   */
  async pushOrder(order: KizoOrder, db: Database): Promise<{ cloverOrderId: string }> {
    if (!this.isEnabled()) return { cloverOrderId: '' }

    // Idempotency guard — do not double-push
    if (order.clover_order_id) {
      return { cloverOrderId: order.clover_order_id }
    }

    const mid = this.merchantId!

    // 1. Build a human-readable title the server can spot on the Clover device.
    //    • Bare number (e.g. "3")  → "Table 3"
    //    • Already prefixed        → use as-is (e.g. "Table 3", "Bar", "Patio")
    //    • No table, pickup order  → "Takeout"
    //    • No table, dine-in       → customer name
    const rawLabel = order.table_label?.trim() ?? ''
    const title = rawLabel
      ? (/^\d+$/.test(rawLabel) ? `Table ${rawLabel}` : rawLabel)
      : order.order_type === 'pickup'
        ? 'Takeout'
        : order.customer_name || 'Order'

    // state:"open" + employee + orderType are required for the order to appear
    // in the Clover Flex POS order list. The device field is set by the physical
    // device when it opens the order — Clover ignores it when set via REST API.
    const orderPayload: Record<string, unknown> = {
      title,
      note: order.customer_name,
      state: 'open',
    }
    if (this.employeeId) {
      orderPayload.employee = { id: this.employeeId }
    }
    if (this.orderTypeId) {
      orderPayload.orderType = { id: this.orderTypeId }
    }

    const cloverOrder = await this.makeRequest<{ id: string }>(
      'POST',
      `/v3/merchants/${mid}/orders`,
      orderPayload
    )

    const cloverOrderId = cloverOrder.id

    // 2. Push each item as a custom line item (no catalog reference)
    let items: KizoOrderItem[]
    if (typeof order.items === 'string') {
      try {
        const parsed = JSON.parse(order.items)
        if (!Array.isArray(parsed)) {
          console.error(`[clover] Invalid items JSON for order ${order.id} — skipping push`)
          return { cloverOrderId: '' }
        }
        items = parsed
      } catch {
        console.error(`[clover] Malformed items JSON for order ${order.id} — skipping push`)
        return { cloverOrderId: '' }
      }
    } else {
      items = Array.isArray(order.items) ? order.items : []
    }

    let computedTotalCents = 0

    for (const item of items) {
      const modifiers = item.modifiers ?? []

      // Flatten modifier names into the dish name
      const modifierNames = modifiers.map((m) => m.name).filter(Boolean)
      const name = modifierNames.length > 0
        ? `${item.dishName} – ${modifierNames.join(', ')}`
        : item.dishName

      // Flatten modifier prices into the unit price
      const modifierPriceCents = modifiers.reduce((sum, m) => sum + (m.priceCents ?? 0), 0)
      const price = item.priceCents + modifierPriceCents

      // Post one Clover line item per Kizo item (respecting quantity)
      for (let q = 0; q < item.quantity; q++) {
        try {
          await this.makeRequest(
            'POST',
            `/v3/merchants/${mid}/orders/${cloverOrderId}/line_items`,
            { name, price }
          )
          computedTotalCents += price
        } catch (lineErr) {
          // Partial push — log and continue. Reconcile will handle the gap.
          console.error(
            `[clover] Failed to push line item "${name}" to order ${cloverOrderId}:`,
            lineErr instanceof Error ? lineErr.message : lineErr
          )
        }
      }
    }

    // 3. Add a "Tax" line item when the Kizo order carries a tax rate.
    //    Clover does not auto-apply taxes to custom (non-catalog) line items, so
    //    we compute tax on our side and post it as an explicit line item. This
    //    keeps the order total correct without requiring MERCHANT_TAX_RATES_R.
    const taxRate = order.tax_rate ?? 0
    const taxCentsComputed = taxRate > 0 ? Math.round(computedTotalCents * taxRate) : 0
    if (taxCentsComputed > 0) {
      try {
        await this.makeRequest(
          'POST',
          `/v3/merchants/${mid}/orders/${cloverOrderId}/line_items`,
          { name: 'Tax', price: taxCentsComputed }
        )
        computedTotalCents += taxCentsComputed
      } catch (taxErr) {
        console.error(
          `[clover] Failed to push tax line item to order ${cloverOrderId}:`,
          taxErr instanceof Error ? taxErr.message : taxErr
        )
      }
    }

    // 4. Set the order total explicitly — Clover does not auto-sum line items
    //    via the REST API; without this the order shows $0 in the POS.
    try {
      await this.makeRequest(
        'POST',
        `/v3/merchants/${mid}/orders/${cloverOrderId}`,
        { total: computedTotalCents }
      )
    } catch (totalErr) {
      console.error(
        `[clover] Failed to set total on order ${cloverOrderId}:`,
        totalErr instanceof Error ? totalErr.message : totalErr
      )
    }

    // 4. Persist the Clover order ID
    db.run(
      `UPDATE orders SET clover_order_id = ? WHERE id = ?`,
      [cloverOrderId, order.id]
    )

    console.log(`[clover] Order ${order.id} → Clover order ${cloverOrderId} (total: ${computedTotalCents}¢)`)
    return { cloverOrderId }
  }

  // ---------------------------------------------------------------------------
  // waitForPayment — Story 3
  // ---------------------------------------------------------------------------

  /**
   * Polls Clover until the order is `paid`, `deleted`, or timeout is reached.
   *
   * @param cloverOrderId  Clover order ID to poll
   * @param options        `timeoutMs` (default 5 min), `intervalMs` (default 5 s)
   */
  async waitForPayment(
    cloverOrderId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<WaitForPaymentResult> {
    if (!this.isEnabled()) return { status: 'timeout' }

    const mid         = this.merchantId!
    const intervalMs  = options.intervalMs ?? 5_000
    const timeoutMs   = options.timeoutMs  ?? 5 * 60_000
    const deadline    = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      try {
        const order = await this.makeRequest<CloverOrderWithPayments>(
          'GET',
          `/v3/merchants/${mid}/orders/${cloverOrderId}?expand=payments`
        )

        const payment = order.payments?.elements?.find(p => p.result === 'SUCCESS')
        const isPaid = order.state === 'paid' ||
          (order.state === 'locked' && order.paymentState === 'PAID') ||
          payment != null

        if (isPaid) {
          return {
            status: 'paid',
            paymentId: payment?.id ?? '',
            paymentMethod: payment?.cardTransaction?.type ?? 'UNKNOWN',
            totalCents: payment?.amount ?? order.total,
          }
        }

        if (order.state === 'deleted') {
          return { status: 'cancelled' }
        }
      } catch (err) {
        console.warn(`[clover] waitForPayment poll error (will retry):`, err)
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    return { status: 'timeout' }
  }

  // ---------------------------------------------------------------------------
  // pushLegOrder — Split payment leg
  // ---------------------------------------------------------------------------

  /**
   * Creates a mini Clover order for one split-payment leg.
   *
   * Used by the split payment flow (payment modal → counter/request-payment →
   * startCloverLegPayment) to charge a specific leg amount on the Clover Flex.
   * Does NOT write to the `orders` table; the caller polls and records the result.
   *
   * @param opts.legLabel          Human-readable title shown on the Clover device
   * @param opts.subtotalCents     Pre-tax, pre-service-charge leg subtotal
   * @param opts.taxCents          Tax for this leg
   * @param opts.serviceChargeCents 20% service charge (replaces tip for split payments)
   * @returns cloverLegOrderId or '' when Clover is not enabled
   */
  async pushLegOrder(opts: {
    legLabel: string
    subtotalCents: number
    taxCents: number
    serviceChargeCents: number
  }): Promise<{ cloverLegOrderId: string }> {
    if (!this.isEnabled()) return { cloverLegOrderId: '' }
    const mid = this.merchantId!

    const orderPayload: Record<string, unknown> = { title: opts.legLabel, state: 'open' }
    if (this.employeeId)  orderPayload.employee  = { id: this.employeeId }
    if (this.orderTypeId) orderPayload.orderType = { id: this.orderTypeId }

    const cloverOrder = await this.makeRequest<{ id: string }>(
      'POST', `/v3/merchants/${mid}/orders`, orderPayload
    )
    const cloverLegOrderId = cloverOrder.id

    // Subtotal line item
    await this.makeRequest('POST', `/v3/merchants/${mid}/orders/${cloverLegOrderId}/line_items`, {
      name: opts.legLabel, price: opts.subtotalCents,
    }).catch(err => console.error('[clover] pushLegOrder: subtotal line item failed:', err instanceof Error ? err.message : err))

    // Service charge line item (replaces tip for split payments)
    if (opts.serviceChargeCents > 0) {
      await this.makeRequest('POST', `/v3/merchants/${mid}/orders/${cloverLegOrderId}/line_items`, {
        name: 'Service Charge (20%)', price: opts.serviceChargeCents,
      }).catch(err => console.error('[clover] pushLegOrder: service charge line item failed:', err instanceof Error ? err.message : err))
    }

    // Tax line item
    if (opts.taxCents > 0) {
      await this.makeRequest('POST', `/v3/merchants/${mid}/orders/${cloverLegOrderId}/line_items`, {
        name: 'Tax', price: opts.taxCents,
      }).catch(err => console.error('[clover] pushLegOrder: tax line item failed:', err instanceof Error ? err.message : err))
    }

    // Set total (Clover does not auto-sum line items via REST)
    const total = opts.subtotalCents + opts.serviceChargeCents + opts.taxCents
    await this.makeRequest('POST', `/v3/merchants/${mid}/orders/${cloverLegOrderId}`, { total })
      .catch(err => console.error('[clover] pushLegOrder: set total failed:', err instanceof Error ? err.message : err))

    console.log(`[clover] Leg order created: ${cloverLegOrderId} — "${opts.legLabel}" total ${total}¢`)
    return { cloverLegOrderId }
  }

  // ---------------------------------------------------------------------------
  // reconcile — Story 5
  // ---------------------------------------------------------------------------

  /**
   * Reconciles open Kizo orders against Clover payment state.
   *
   * - Runs at startup and periodically (every 30 s via server.ts interval).
   * - Only processes orders where `clover_payment_id IS NULL` to avoid
   *   re-processing already-reconciled orders.
   * - Creates a `payments` table record so reports include the full breakdown.
   * - Non-fatal: logs errors per order and continues.
   *
   * @param db        bun:sqlite Database instance
   * @param onPaid    Optional callback fired when an order is marked paid
   *                  (use to broadcast SSE updates from the caller)
   */
  async reconcile(
    db: Database,
    onPaid?: (orderId: string, merchantId: string) => void,
  ): Promise<void> {
    if (!this.isEnabled()) return

    const mid = this.merchantId!

    // Scope to the single active merchant — prevents cross-merchant reconciliation
    // in future multi-merchant deployments and avoids spurious matches in test DBs.
    const merchantRow = db
      .query<{ id: string }, []>(
        `SELECT id FROM merchants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`
      )
      .get()
    if (!merchantRow) return   // No merchant configured yet; nothing to reconcile

    const openOrders = db
      .query<{ id: string; merchant_id: string; clover_order_id: string; subtotal_cents: number }, [string]>(
        `SELECT id, merchant_id, clover_order_id, subtotal_cents
         FROM orders
         WHERE merchant_id = ?
           AND clover_order_id IS NOT NULL
           AND clover_payment_id IS NULL
           AND status NOT IN ('completed', 'cancelled', 'pos_error', 'paid')`
      )
      .all(merchantRow.id)

    if (openOrders.length === 0) return

    console.log(`[clover] Reconciling ${openOrders.length} open order(s) with Clover…`)

    for (const row of openOrders) {
      try {
        const cloverOrder = await this.makeRequest<CloverOrderWithPayments>(
          'GET',
          `/v3/merchants/${mid}/orders/${row.clover_order_id}?expand=payments`
        )

        // Clover uses state:'locked' + paymentState:'PAID' when paid via device;
        // state:'paid' may appear in some API contexts. Handle both.
        const isPaid = cloverOrder.state === 'paid' ||
          (cloverOrder.state === 'locked' && cloverOrder.paymentState === 'PAID') ||
          (cloverOrder.payments?.elements?.some(p => p.result === 'SUCCESS') ?? false)

        if (isPaid) {
          const payment         = cloverOrder.payments?.elements?.[0]
          const cloverPaymentId = payment?.id ?? null
          const paymentMethod   = payment?.cardTransaction?.type ?? null
          const cardType        = payment?.cardTransaction?.cardType?.toLowerCase() ?? null
          // Clover payment.amount = subtotal + tax + tip (all in cents)
          const paidAmountCents = payment?.amount ?? cloverOrder.total ?? 0
          const tipCents        = payment?.tipAmount  ?? 0
          const taxCents        = payment?.taxAmount  ?? 0
          const subtotalCents   = Math.max(0, paidAmountCents - tipCents - taxCents)

          const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

          db.run(
            `UPDATE orders
             SET clover_payment_id = ?, clover_payment_method = ?,
                 paid_amount_cents = ?,
                 tip_cents = ?, tax_cents = ?,
                 payment_method = 'clover',
                 status = 'paid', updated_at = datetime('now')
             WHERE id = ?`,
            [cloverPaymentId, paymentMethod, paidAmountCents, tipCents, taxCents, row.id]
          )

          // Insert a payments record so reports include this transaction
          const paymentId = `pay_${randomBytes(16).toString('hex')}`
          db.run(
            `INSERT OR IGNORE INTO payments (
               id, merchant_id, order_id, payment_type,
               subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents,
               amount_cents, card_type, card_last_four, cardholder_name,
               transaction_id, processor, auth_code,
               signature_base64, receipt_email,
               split_mode, split_leg_number, split_total_legs, split_items_json,
               finix_transfer_id, created_at, completed_at
             ) VALUES (?, ?, ?, 'card', ?, ?, ?, 0, ?, ?, NULL, NULL,
                       ?, 'clover', NULL, NULL, NULL,
                       NULL, NULL, NULL, NULL, NULL, ?, ?)`,
            [
              paymentId, row.merchant_id, row.id,
              subtotalCents, taxCents, tipCents,
              paidAmountCents, cardType,
              cloverPaymentId,
              now, now,
            ]
          )

          console.log(`[clover] Reconciled: order ${row.id} paid — Clover ${cloverPaymentId} $${(paidAmountCents / 100).toFixed(2)} (tip $${(tipCents / 100).toFixed(2)}, tax $${(taxCents / 100).toFixed(2)})`)
          onPaid?.(row.id, row.merchant_id)

        } else if (cloverOrder.state === 'deleted') {
          db.run(
            `UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
            [row.id]
          )
          console.log(`[clover] Reconciled: order ${row.id} cancelled (Clover order deleted)`)
        }
      } catch (err) {
        // Non-fatal — skip this order and continue
        console.error(
          `[clover] Reconcile failed for order ${row.id} (Clover ${row.clover_order_id}):`,
          err instanceof Error ? err.message : err
        )
      }

      // Throttle: avoid rate-limit hits during bulk reconciliation
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
