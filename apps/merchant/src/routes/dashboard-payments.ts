/**
 * Dashboard payment routes — in-person and online payment processing.
 *
 * ── SINGLE-MERCHANT APPLIANCE ──────────────────────────────────────────────
 * The `:id` param is the merchant's stable UUID used for JWT validation only.
 * There is one merchant per appliance. No multi-tenant isolation is needed or
 * expected. Code reviews should NOT flag missing tenant-filter patterns.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── Provider configuration ────────────────────────────────────────────────────
 *   GET  /api/merchants/:id/payments/config               — which providers are configured
 *   GET  /api/payments/server-ip                          — appliance public IP for Converge whitelist
 *
 * ── Converge (Elavon) hosted checkout ─────────────────────────────────────────
 *   POST /api/merchants/:id/payments/converge/session     — generate hosted-payment URL
 *   GET  /payment/converge/return                         — return page (GET redirect)
 *   POST /payment/converge/return                         — return page (POST form)
 *
 * ── Finix hosted checkout ─────────────────────────────────────────────────────
 *   GET  /payment/finix/return                            — return page after Finix redirect
 *
 * ── In-person payment recording ───────────────────────────────────────────────
 *   POST /api/merchants/:id/orders/:orderId/record-payment — record cash/card/gift-card leg
 *   POST /api/merchants/:id/payments/:paymentId/receipt   — print/email receipt after payment
 *   GET  /api/merchants/:id/orders/:orderId/detail        — order with full payments breakdown
 *
 * ── Split-payment session (Phase 2: pause/resume) ─────────────────────────────
 *   GET   /api/merchants/:id/orders/:orderId/split-session       — fetch active session for resume
 *   PATCH /api/merchants/:id/orders/:orderId/split-session/pause — PIN-gated pause
 *
 * ── Partial-pay write-off (Phase 5: EOD reconciliation) ──────────────────────
 *   GET  /api/merchants/:id/split-sessions?status=paused          — list paused sessions
 *   POST /api/merchants/:id/orders/:orderId/writeoff-unpaid       — convert unpaid balance to discount, mark paid (manager PIN, paused only)
 *   POST /api/merchants/:id/orders/:orderId/finalize-partial      — same math, in-modal "customer left" path (staff JWT, in_progress OK)
 *
 * ── Reconciliation ────────────────────────────────────────────────────────────
 *   GET  /api/merchants/:id/payments/reconciliation       — list payments with Finix status
 *   POST /api/merchants/:id/payments/reconcile-pending    — re-run reconciliation for gaps
 *
 * ── Terminal (PAX) card-present payments ──────────────────────────────────────
 *   GET  /api/merchants/:id/terminals/devices             — list terminals with Finix device IDs
 *   POST /api/merchants/:id/orders/:orderId/terminal-sale — initiate PAX terminal charge
 *   GET  /api/merchants/:id/terminal-sale/:transferId     — poll terminal sale status
 *   POST /api/merchants/:id/terminal-sale/cancel          — cancel in-progress terminal sale
 *
 * ── Card-not-present (phone-order) ────────────────────────────────────────────
 *   POST /api/merchants/:id/orders/:orderId/phone-charge  — CNP charge via Finix.js token
 *   POST /api/merchants/:id/orders/:orderId/link-transfer — manually link Finix transfer to order
 */

import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import { getAPIKey } from '../crypto/api-keys'
import { getConvergePaymentUrl } from '../adapters/converge'
import { createCheckoutForm, getTerminalTransferStatus, cancelTerminalSale, checkDeviceConnection, listDevices, createPaymentInstrumentFromToken, createCNPTransfer, updateDeviceTippingConfig } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { broadcastToMerchant } from '../services/sse'
import { printCustomerReceipt } from '../services/printer'
import { sendReceiptEmail } from '../services/email'
import { serverError } from '../utils/server-error'
import { scheduleReconciliation, runReconciliation } from '../services/reconcile'
import { logPaymentEvent } from '../services/payment-log'
import { verifyEmployeePin, getRequestIp } from '../services/pin-auth'
import { acquirePaymentLock, releasePaymentLock } from '../services/order-locks'
import type { AuthContext } from '../middleware/auth'
import {
  startTerminalPaymentForDashboard,
  cancelTerminalPaymentByOrder,
  getTerminalTxStatus,
} from '../workflows/terminal-payment'

const dashboardPayments = new Hono()

/**
 * GET /api/merchants/:id/payments/config
 *
 * Returns which payment providers are configured for this merchant.
 * No secrets are exposed — only boolean flags and non-sensitive IDs.
 * Used by the dashboard on load to show/hide payment provider UI.
 *
 * @returns `{ stax, converge, finix }` provider configuration flags
 */
dashboardPayments.get(
  '/api/merchants/:id/payments/config',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const db = getDatabase()

    // Converge credentials
    const convergeRow = db
      .query<{ pos_merchant_id: string | null }, [string]>(
        `SELECT pos_merchant_id FROM api_keys
         WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'converge'
         LIMIT 1`
      )
      .get(merchantId)

    // Finix credentials
    const finixRow = db
      .query<{ pos_merchant_id: string | null }, [string]>(
        `SELECT pos_merchant_id FROM api_keys
         WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'
         LIMIT 1`
      )
      .get(merchantId)

    const merchantRow = db
      .query<{
        stax_token: string | null
        converge_sandbox: number
        finix_sandbox: number
        finix_refund_mode: string
        dine_in_provider: string
        counter_provider: string
      }, [string]>(
        `SELECT stax_token, converge_sandbox, finix_sandbox,
                COALESCE(finix_refund_mode, 'local') AS finix_refund_mode,
                COALESCE(dine_in_provider, 'clover') AS dine_in_provider,
                COALESCE(counter_provider, 'finix')  AS counter_provider
         FROM merchants WHERE id = ?`
      )
      .get(merchantId)

    // Parse Converge pos_merchant_id: "accountId:userId"
    const convergePosId = convergeRow?.pos_merchant_id ?? ''
    const [convergeAccountId, convergeUserId] = convergePosId.includes(':')
      ? convergePosId.split(':')
      : [convergePosId, '']

    // Parse Finix pos_merchant_id: "apiUsername:applicationId:merchantId"
    const finixPosId = finixRow?.pos_merchant_id ?? ''
    const finixParts = finixPosId.split(':')
    const [finixUsername, finixAppId, finixMerchantId] =
      finixParts.length === 3 ? finixParts : ['', '', '']

    return c.json({
      clover: {
        enabled:         !!(process.env.CLOVER_MERCHANT_ID && process.env.CLOVER_API_TOKEN),
        dineInProvider:  merchantRow?.dine_in_provider ?? 'clover',
        counterProvider: merchantRow?.counter_provider ?? 'finix',
      },
      stax: {
        enabled: !!merchantRow?.stax_token,
        token:   merchantRow?.stax_token ?? null,
      },
      converge: {
        enabled:   !!convergeRow,
        sandbox:   (merchantRow?.converge_sandbox ?? 1) !== 0,
        accountId: convergeRow ? convergeAccountId : null,
        userId:    convergeRow ? convergeUserId    : null,
      },
      finix: {
        enabled:       !!finixRow,
        sandbox:       (merchantRow?.finix_sandbox ?? 1) !== 0,
        refundMode:    merchantRow?.finix_refund_mode ?? 'local',
        username:      finixRow ? finixUsername  : null,
        applicationId: finixRow ? finixAppId     : null,
        merchantId:    finixRow ? finixMerchantId : null,
      },
    })
  }
)

/**
 * GET /api/payments/server-ip
 *
 * Returns the appliance's outbound public IP by calling Converge's `/myip`
 * endpoint. Used in the dashboard so staff can whitelist the correct IP in
 * the Converge Merchant Administration portal.
 *
 * @param query.sandbox - `'0'` for production Converge URL; any other value for demo
 * @returns `{ ip: string, whitelistUrl: string }`
 */
dashboardPayments.get('/api/payments/server-ip', async (c) => {
  const sandbox = c.req.query('sandbox') !== '0'
  const myipUrl = sandbox
    ? 'https://api.demo.convergepay.com/hosted-payments/myip'
    : 'https://www.convergepay.com/hosted-payments/myip'
  const whitelistUrl = sandbox
    ? 'https://demo.convergepay.com/hosted-payments/myip'
    : 'https://www.convergepay.com/hosted-payments/myip'
  try {
    const response = await fetch(myipUrl, { headers: { 'Accept': 'text/plain' } })
    const ip = (await response.text()).trim()
    return c.json({ ip, whitelistUrl })
  } catch (error) {
    return c.json(
      { error: 'Could not determine server IP' },
      502
    )
  }
})

/**
 * POST /api/merchants/:id/payments/converge/session
 *
 * Generates a Converge hosted-payment URL for the given amount.
 * Converge credentials are fetched from encrypted storage; the PIN never
 * leaves the server — only the resulting one-time URL is returned.
 *
 * @param body.amountCents - Charge amount in cents (must be > 0)
 * @param body.memo - Optional order memo (sanitized before being sent to Converge)
 * @param body.returnUrl - URL Converge redirects to after payment
 * @returns `{ url: string }` — Converge hosted-payments URL
 */
dashboardPayments.post(
  '/api/merchants/:id/payments/converge/session',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    try {
      const body = await c.req.json()
      const { amountCents, memo, returnUrl } = body

      if (typeof amountCents !== 'number' || amountCents <= 0) {
        return c.json({ error: 'amountCents must be a positive integer' }, 400)
      }
      if (!returnUrl || typeof returnUrl !== 'string') {
        return c.json({ error: 'returnUrl is required' }, 400)
      }

      const pin = await getAPIKey(merchantId, 'payment', 'converge')
      if (!pin) {
        return c.json({ error: 'Converge credentials not configured' }, 400)
      }

      const db = getDatabase()
      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'converge'
           LIMIT 1`
        )
        .get(merchantId)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      if (!posMerchantId.includes(':')) {
        return c.json(
          { error: 'Converge configuration incomplete (missing accountId:userId in pos_merchant_id)' },
          400
        )
      }
      const [sslMerchantId, sslUserId] = posMerchantId.split(':')

      const merchantRow = db
        .query<{ converge_sandbox: number }, [string]>(
          `SELECT converge_sandbox FROM merchants WHERE id = ?`
        )
        .get(merchantId)
      const sandbox = (merchantRow?.converge_sandbox ?? 1) !== 0

      const amountDollars = (amountCents / 100).toFixed(2)

      // L-07: Sanitize memo to prevent PII (customer names, phone numbers) from
      // appearing in Converge processor logs. Keep only safe alphanumeric chars,
      // spaces, hashes, and hyphens (e.g. "Order #ord_abc123" is fine).
      const safeMemo = typeof memo === 'string'
        ? memo.replace(/[^A-Za-z0-9 #\-_]/g, '').slice(0, 64).trim() || undefined
        : undefined

      const paymentUrl = await getConvergePaymentUrl(
        { sslMerchantId, sslUserId, sslPin: pin, sandbox },
        amountDollars,
        returnUrl,
        safeMemo
      )

      return c.json({ url: paymentUrl })
    } catch (error) {
      console.error('Converge session error:', error)
      return c.json(
        { error: 'Failed to create Converge payment session' },
        500
      )
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/payments/finix/checkout
//
// Creates a Finix Checkout Form (hosted payment page) and returns the URL.
// The API password never leaves the server.
//
// Body: { amountCents: number, customerName?: string, memo?: string, returnUrl: string }
// Response: { url: string, checkoutFormId: string }
// ---------------------------------------------------------------------------
dashboardPayments.post(
  '/api/merchants/:id/payments/finix/checkout',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    try {
      const body = await c.req.json()
      const { amountCents, customerName, memo, returnUrl } = body

      if (typeof amountCents !== 'number' || amountCents <= 0) {
        return c.json({ error: 'amountCents must be a positive integer' }, 400)
      }
      if (!returnUrl || typeof returnUrl !== 'string') {
        return c.json({ error: 'returnUrl is required' }, 400)
      }

      // Retrieve encrypted API password
      const apiPassword = await getAPIKey(merchantId, 'payment', 'finix')
      if (!apiPassword) {
        return c.json({ error: 'Finix credentials not configured' }, 400)
      }

      // Retrieve apiUsername:applicationId:merchantId from pos_merchant_id
      const db = getDatabase()
      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'
           LIMIT 1`
        )
        .get(merchantId)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      const parts = posMerchantId.split(':')
      if (parts.length !== 3) {
        return c.json(
          { error: 'Finix configuration incomplete (expected apiUsername:applicationId:merchantId)' },
          400
        )
      }
      const [apiUsername, , finixMerchantId] = parts

      // Get sandbox mode
      const merchantRow = db
        .query<{ finix_sandbox: number }, [string]>(
          `SELECT finix_sandbox FROM merchants WHERE id = ?`
        )
        .get(merchantId)
      const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

      // Split customer name into first/last for Finix buyer_details
      const nameParts    = (customerName ?? '').trim().split(/\s+/)
      const firstName    = nameParts[0] || undefined
      const lastName     = nameParts.slice(1).join(' ') || undefined

      const origin       = new URL(returnUrl).origin

      console.log(`[finix] checkout: user=${apiUsername} merchant=${finixMerchantId} sandbox=${sandbox} amount=${amountCents}`)

      const amountStr = `$${(amountCents / 100).toFixed(2)}`

      const result = await createCheckoutForm(
        { apiUsername, applicationId: parts[1], merchantId: finixMerchantId, apiPassword, sandbox },
        {
          amountCents,
          customerFirstName:  firstName,
          customerLastName:   lastName,
          nickname:           `Payment ${amountStr} — ${customerName ?? 'Guest'}`,
          description:        memo || `Order for ${customerName ?? 'Guest'}`,
          returnUrl,
          cartReturnUrl:      `${origin}/merchant`,
          termsOfServiceUrl:  `${origin}/payments-terms-of-service`,
          idempotencyId:      crypto.randomUUID(),
        }
      )

      return c.json({ url: result.linkUrl, checkoutFormId: result.checkoutFormId })
    } catch (error) {
      console.error('Finix checkout error:', error)
      return c.json(
        { error: 'Failed to create Finix checkout' },
        500
      )
    }
  }
)

/**
 * GET /payment/finix/return
 *
 * Serves a minimal HTML page that Finix redirects to after the hosted
 * checkout is complete. Finix appends `?checkout_form_id=CF…` to the URL.
 * The page sends the result to the opener tab via `postMessage`
 * (popup flow) or stores it in `sessionStorage` and redirects to
 * `/merchant#finix-paid` (same-tab flow).
 */

function buildFinixReturnHtml(params: Record<string, string>): string {
  // Finix Checkout Pages always redirect back — we treat any return as a
  // completed attempt. The frontend uses sessionStorage to reconcile.
  const checkoutFormId = params.checkout_form_id ?? params.checkoutFormId ?? ''

  const result = {
    provider: 'finix',
    success: true,
    checkoutFormId,
  }

  const resultJson = JSON.stringify(result)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Complete</title>
  <style>
    body { font-family: -apple-system, sans-serif; text-align: center; padding: 3rem 1rem; background: #f9fafb; color: #111827; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #6b7280; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="icon">✅</div>
  <h1>Payment complete</h1>
  <p>Returning to dashboard...</p>
  <script>
    const result = ${resultJson};
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'finix-payment-result', ...result }, '*');
      setTimeout(() => window.close(), 1500);
    } else {
      try {
        sessionStorage.setItem('finix_payment_result', JSON.stringify(result));
      } catch (e) {}
      window.location.replace('/merchant#finix-paid');
    }
  </script>
</body>
</html>`
}

dashboardPayments.get('/payment/finix/return', async (c) => {
  const url    = new URL(c.req.url)
  const params = Object.fromEntries(url.searchParams.entries())
  return new Response(buildFinixReturnHtml(params), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

/**
 * GET /payment/converge/return
 * POST /payment/converge/return
 *
 * Serves a minimal HTML page that Converge redirects to after payment.
 * Converge may use GET (query string) or POST (form body) depending on
 * the terminal configuration. The page sends result to the opener via
 * `postMessage` (popup/new-tab flow) or stores it in `sessionStorage`
 * and redirects to `/merchant#converge-paid` (same-tab flow).
 *
 * Only whitelisted Converge result parameters are forwarded (`ssl_result`,
 * `ssl_txn_id`, `ssl_amount`, etc.) to prevent parameter injection.
 */

// H-13: Only extract whitelisted Converge return parameters
const CONVERGE_RETURN_PARAMS = new Set([
  'ssl_result', 'ssl_txn_id', 'ssl_amount', 'ssl_approval_code',
  'ssl_card_short_description', 'ssl_last_4_digits', 'ssl_result_message',
])

function pickConvergeParams(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of CONVERGE_RETURN_PARAMS) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }
  return out
}

function buildReturnHtml(params: Record<string, string>): string {
  const safe = pickConvergeParams(params)
  const success = safe.ssl_result === 'APPROVAL'

  const result = {
    provider:     'converge',
    success,
    txnId:        safe.ssl_txn_id        ?? null,
    amount:       safe.ssl_amount        ?? null,
    approvalCode: safe.ssl_approval_code ?? null,
    cardType:     safe.ssl_card_short_description ?? null,
    last4:        safe.ssl_last_4_digits ?? null,
    errorMessage: success ? null : (safe.ssl_result_message ?? 'Payment declined'),
  }

  const resultJson = JSON.stringify(result)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment ${success ? 'Approved' : 'Declined'}</title>
  <style>
    body { font-family: -apple-system, sans-serif; text-align: center; padding: 3rem 1rem; background: #f9fafb; color: #111827; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #6b7280; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="icon">${success ? '✅' : '❌'}</div>
  <h1>${success ? 'Payment approved' : 'Payment declined'}</h1>
  <p>You may close this tab.</p>
  <script>
    const result = ${resultJson};
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'converge-payment-result', ...result }, '*');
      setTimeout(() => window.close(), 1500);
    } else {
      try {
        sessionStorage.setItem('converge_payment_result', JSON.stringify(result));
      } catch (e) {}
      window.location.replace('/merchant#converge-paid');
    }
  </script>
</body>
</html>`
}

dashboardPayments.get('/payment/converge/return', async (c) => {
  const url    = new URL(c.req.url)
  const params = Object.fromEntries(url.searchParams.entries())
  return new Response(buildReturnHtml(params), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

dashboardPayments.post('/payment/converge/return', async (c) => {
  let params: Record<string, string> = {}
  const contentType = c.req.header('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const json = await c.req.json()
      Object.keys(json).forEach((k) => { params[k] = String(json[k]) })
    } else {
      const formData = await c.req.formData()
      formData.forEach((v, k) => { params[k] = v.toString() })
    }
  } catch {
    const url = new URL(c.req.url)
    params = Object.fromEntries(url.searchParams.entries())
  }
  return new Response(buildReturnHtml(params), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

/**
 * POST /api/merchants/:id/orders/:orderId/record-payment
 *
 * Records an in-person payment (card, cash, or gift card) after staff confirms
 * on the payment modal. Inserts a row into the `payments` table, marks the
 * order `paid` on the final split leg, and fires receipt delivery (print +
 * email) as a fire-and-forget side-effect.
 *
 * Supports split payments: `splitLegNumber` / `splitTotalLegs` track which leg
 * is being recorded. The order is only marked `paid` when `splitLegNumber ===
 * splitTotalLegs`. `isLastLeg: false` is returned for intermediate legs.
 *
 * @param body.paymentType - `'card' | 'cash' | 'gift_card'`
 * @param body.subtotalCents - Pre-tax, pre-tip subtotal
 * @param body.taxCents - Tax portion
 * @param body.tipCents - Tip portion
 * @param body.totalCents - Grand total (subtotal + tax + tip + amexSurcharge)
 * @param body.amexSurchargeCents - Amex surcharge (0.3% of pre-tip base); 0 for non-Amex
 * @param body.cardType - Card brand (e.g. `'AMEX'`, `'VISA'`) for surcharge label
 * @param body.signatureBase64 - Optional captured signature PNG (data URI)
 * @param body.receiptEmail - If set, an email receipt is sent to this address
 * @param body.splitMode - `'equal' | 'by_items' | 'custom' | 'gift_card' | null`
 * @param body.splitLegNumber - 1-based leg index (null for non-split payments)
 * @param body.splitTotalLegs - Total number of legs (null for non-split payments)
 * @param body.splitItemsJson - JSON array of item indices paid in this leg (by_items only)
 * @param body.giftCardId - Gift card ID being redeemed (gift_card leg only)
 * @returns `{ paymentId: string, success: true, isLastLeg: boolean }`
 */
dashboardPayments.post(
  '/api/merchants/:id/orders/:orderId/record-payment',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!
    const db = getDatabase()

    // Validate order belongs to this merchant and is not already paid/cancelled
    const order = db
      .query<{
        id: string
        status: string
        order_type: string
        customer_name: string
        customer_email: string | null
        items: string
        subtotal_cents: number
        tax_cents: number
        total_cents: number
        discount_cents: number
        discount_label: string | null
        service_charge_cents: number
        service_charge_label: string | null
        table_label: string | null
        room_label: string | null
        notes: string | null
      }, [string, string]>(
        `SELECT id, status, order_type, customer_name, customer_email, items,
                subtotal_cents, tax_cents, total_cents,
                COALESCE(discount_cents, 0) AS discount_cents, discount_label,
                COALESCE(service_charge_cents, 0) AS service_charge_cents, service_charge_label,
                table_label, room_label, notes
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)
    if (order.status === 'paid' || order.status === 'cancelled' || order.status === 'refunded') {
      const existing = db
        .query<{ id: string; split_leg_number: number | null; split_total_legs: number | null }, [string]>(
          `SELECT id, split_leg_number, split_total_legs
           FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(orderId)
      // Surface whether the existing payment was a final leg so the frontend
      // can decide between LEG_COMPLETE (continue split) and PIN_EXIT (close).
      const existingIsLastLeg = !existing?.split_total_legs
        || (existing.split_leg_number ?? 1) >= (existing.split_total_legs ?? 1)
      return c.json({
        error: `Order is already ${order.status}`,
        paymentId: existing?.id ?? null,
        isLastLeg: existingIsLastLeg,
      }, 409)
    }

    let body: {
      paymentType: string
      subtotalCents: number
      taxCents: number
      tipCents: number
      totalCents: number
      gratuityPercent?: number
      amexSurchargeCents?: number
      cardType?: string
      cardLastFour?: string
      cardholderName?: string
      transactionId?: string
      processor?: string
      authCode?: string
      signatureBase64?: string
      receiptEmail?: string
      splitMode?: string | null
      splitLegNumber?: number | null
      splitTotalLegs?: number | null
      splitItemsJson?: string | null
      giftCardId?: string
      giftCardTaxOffsetCents?: number
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const {
      paymentType, subtotalCents, taxCents, tipCents, totalCents,
      gratuityPercent, cardType, cardLastFour, cardholderName,
      transactionId, processor, authCode, signatureBase64, receiptEmail,
    } = body

    const amexSurchargeCents = body.amexSurchargeCents ?? 0
    const splitMode          = body.splitMode          ?? null
    const splitLegNumber     = body.splitLegNumber     ?? null
    const splitTotalLegs     = body.splitTotalLegs     ?? null
    const splitItemsJson     = body.splitItemsJson     ?? null

    if (paymentType !== 'card' && paymentType !== 'cash' && paymentType !== 'gift_card') {
      return c.json({ error: "paymentType must be 'card', 'cash', or 'gift_card'" }, 400)
    }

    // Gift card fields
    const giftCardId             = paymentType === 'gift_card' ? (body.giftCardId ?? null) : null
    const giftCardTaxOffsetCents = paymentType === 'gift_card' ? (body.giftCardTaxOffsetCents ?? 0) : 0

    if (paymentType === 'gift_card' && !giftCardId) {
      return c.json({ error: 'giftCardId is required for gift_card payment type' }, 400)
    }
    if (typeof giftCardTaxOffsetCents !== 'number' || giftCardTaxOffsetCents < 0) {
      return c.json({ error: 'giftCardTaxOffsetCents must be a non-negative number' }, 400)
    }
    if (typeof subtotalCents !== 'number' || subtotalCents < 0) {
      return c.json({ error: 'subtotalCents must be a non-negative number' }, 400)
    }
    if (typeof taxCents !== 'number' || taxCents < 0) {
      return c.json({ error: 'taxCents must be a non-negative number' }, 400)
    }
    if (typeof tipCents !== 'number' || tipCents < 0 || tipCents > 100_000) {
      return c.json({ error: 'tipCents must be between 0 and 100000' }, 400)
    }
    if (typeof totalCents !== 'number' || totalCents < 0) {
      return c.json({ error: 'totalCents must be a non-negative number' }, 400)
    }
    if (typeof amexSurchargeCents !== 'number' || amexSurchargeCents < 0) {
      return c.json({ error: 'amexSurchargeCents must be a non-negative number' }, 400)
    }

    // H-06: Validate split payment fields when present
    let byItemsLegIndices: number[] = []
    if (splitMode) {
      const VALID_SPLIT_MODES = ['equal', 'by_items', 'custom', 'gift_card']
      if (!VALID_SPLIT_MODES.includes(splitMode)) {
        return c.json({ error: `splitMode must be one of: ${VALID_SPLIT_MODES.join(', ')}` }, 400)
      }
      if (splitLegNumber == null || !Number.isInteger(splitLegNumber) || splitLegNumber < 1 || splitLegNumber > 10) {
        return c.json({ error: 'splitLegNumber must be an integer between 1 and 10' }, 400)
      }

      if (splitMode === 'by_items') {
        // splitTotalLegs is optional/ignored: completion is derived from
        // unit coverage. Index space is unit-level — a line with quantity N
        // contributes N distinct unit indices so each can be assigned to a
        // different leg (e.g. two customers each ordering Peanut Sauce).
        if (!splitItemsJson) {
          return c.json({ error: 'splitItemsJson is required for by_items split' }, 400)
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(splitItemsJson)
        } catch {
          return c.json({ error: 'splitItemsJson must be valid JSON' }, 400)
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return c.json({ error: 'splitItemsJson must be a non-empty array of item indices' }, 400)
        }
        const totalUnits = (JSON.parse(order.items) as Array<{ quantity?: number }>)
          .reduce((s, it) => s + Math.max(1, it.quantity ?? 1), 0)
        const seen = new Set<number>()
        for (const idx of parsed) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= totalUnits) {
            return c.json({ error: `splitItemsJson contains invalid item index: ${idx}` }, 400)
          }
          if (seen.has(idx as number)) {
            return c.json({ error: `splitItemsJson contains duplicate item index: ${idx}` }, 400)
          }
          seen.add(idx as number)
        }
        byItemsLegIndices = Array.from(seen)
      } else {
        // equal / custom / gift_card still use a fixed leg count
        if (splitTotalLegs == null || !Number.isInteger(splitTotalLegs) || splitTotalLegs < 2 || splitTotalLegs > 10) {
          return c.json({ error: 'splitTotalLegs must be an integer between 2 and 10' }, 400)
        }
        if (splitLegNumber > splitTotalLegs) {
          return c.json({ error: 'splitLegNumber cannot exceed splitTotalLegs' }, 400)
        }
      }
    }

    // isLastLeg: true for unsplit payments, or when this is the final split leg.
    // For by_items, completion depends on prior payments — that read must
    // happen INSIDE the transaction (see "Issue 2 fix" below) to prevent
    // two concurrent legs with non-overlapping items from both passing the
    // overlap check and creating duplicate item coverage. We compute
    // isLastLeg up-front for non-by_items, defer it for by_items.
    let isLastLeg: boolean
    if (!splitMode) {
      isLastLeg = true
    } else if (splitMode === 'by_items') {
      isLastLeg = false  // placeholder; reassigned inside the transaction
    } else {
      isLastLeg = (splitLegNumber ?? 1) >= (splitTotalLegs ?? 1)
    }

    let paymentId = `pay_${randomBytes(16).toString('hex')}`
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
    const signatureCapturedAt = signatureBase64 ? now : null

    logPaymentEvent('record_payment_start', {
      merchantId, orderId, amountCents: totalCents,
      message: `${paymentType} payment of $${(totalCents / 100).toFixed(2)}${splitMode ? ` (split leg ${splitLegNumber}/${splitTotalLegs})` : ''}`,
      extra: { paymentType, processor: processor ?? null, transactionId: transactionId ?? null, splitMode },
    })

    try {
      db.exec('BEGIN')

      // ── Issue 1 fix: re-verify order status inside the transaction ──────
      // Without this, two concurrent record-payment calls for the same order
      // can both pass the status check (done above the transaction), then race
      // to INSERT/COMMIT — the second will either hit a DB lock (500 error) or
      // succeed with a duplicate payment row.  By re-checking inside BEGIN we
      // hold the write lock, so only one request can proceed.
      const currentStatus = db
        .query<{ status: string }, [string, string]>(
          `SELECT status FROM orders WHERE id = ? AND merchant_id = ?`,
        )
        .get(orderId, merchantId)

      if (currentStatus?.status === 'paid' || currentStatus?.status === 'cancelled' || currentStatus?.status === 'refunded') {
        db.exec('ROLLBACK')
        logPaymentEvent('record_payment_duplicate', {
          merchantId, orderId, paymentId, amountCents: totalCents,
          level: 'warn',
          message: `Order is already ${currentStatus.status} — duplicate record-payment ignored`,
        })
        const existing = db
          .query<{ id: string; split_leg_number: number | null; split_total_legs: number | null }, [string]>(
            `SELECT id, split_leg_number, split_total_legs
             FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`
          )
          .get(orderId)
        const existingIsLastLeg = !existing?.split_total_legs
          || (existing.split_leg_number ?? 1) >= (existing.split_total_legs ?? 1)
        return c.json({
          error: `Order is already ${currentStatus.status}`,
          paymentId: existing?.id ?? null,
          isLastLeg: existingIsLastLeg,
        }, 409)
      }

      // ── Issue 2 fix: by_items overlap + isLastLeg derivation inside txn ──
      // Two concurrent record-payment calls with non-overlapping items
      // (e.g. legs `[0,1]` and `[1,2]`) could both pass an overlap check
      // performed before BEGIN, then both insert and create duplicate
      // coverage. By reading priorIndices under the transaction's write
      // lock we serialize the check.
      if (splitMode === 'by_items') {
        const totalUnits = (JSON.parse(order.items) as Array<{ quantity?: number }>)
          .reduce((s, it) => s + Math.max(1, it.quantity ?? 1), 0)
        const priorIndices = new Set<number>()
        const priorLegs = db
          .query<{ split_items_json: string | null }, [string]>(
            `SELECT split_items_json FROM payments
             WHERE order_id = ? AND split_mode = 'by_items' AND split_items_json IS NOT NULL`
          )
          .all(orderId)
        for (const leg of priorLegs) {
          try {
            const arr = JSON.parse(leg.split_items_json ?? '[]') as number[]
            for (const i of arr) priorIndices.add(i)
          } catch { /* malformed legacy row — skip */ }
        }
        for (const idx of byItemsLegIndices) {
          if (priorIndices.has(idx)) {
            db.exec('ROLLBACK')
            return c.json({ error: `Item index ${idx} has already been paid in a prior leg` }, 409)
          }
          priorIndices.add(idx)
        }
        isLastLeg = priorIndices.size === totalUnits
      }

      // ── Gift card: validate and debit balance inside the transaction ──────
      if (paymentType === 'gift_card' && giftCardId) {
        const card = db
          .query<{
            id: string
            face_value_cents: number
            balance_cents: number
            status: string
            expires_at: string
          }, [string, string]>(
            `SELECT id, face_value_cents, balance_cents, status, expires_at
             FROM gift_cards WHERE id = ? AND merchant_id = ?`
          )
          .get(giftCardId, merchantId)

        if (!card) {
          db.exec('ROLLBACK')
          return c.json({ error: 'Gift card not found' }, 404)
        }
        if (card.status !== 'active') {
          db.exec('ROLLBACK')
          return c.json({ error: `Gift card is ${card.status}` }, 409)
        }
        if (card.expires_at && card.expires_at < now) {
          db.exec('ROLLBACK')
          return c.json({ error: 'Gift card has expired' }, 409)
        }

        // Validate tax offset does not exceed the card's actual embedded tax
        const netRevenue = Math.round(card.face_value_cents / 1.104)
        const maxEmbeddedTax = card.face_value_cents - netRevenue
        if (giftCardTaxOffsetCents > maxEmbeddedTax) {
          db.exec('ROLLBACK')
          return c.json({ error: `giftCardTaxOffsetCents (${giftCardTaxOffsetCents}) exceeds card embedded tax (${maxEmbeddedTax})` }, 400)
        }

        // Atomically debit the card — WHERE balance_cents >= ? guards against concurrent use
        const debitAmount = Math.min(totalCents, card.balance_cents)
        const result = db.run(
          `UPDATE gift_cards
           SET balance_cents = balance_cents - ?,
               status = CASE WHEN balance_cents - ? <= 0 THEN 'depleted' ELSE status END,
               redeemed_at = CASE WHEN balance_cents - ? <= 0 THEN datetime('now') ELSE redeemed_at END
           WHERE id = ? AND balance_cents >= ?`,
          [debitAmount, debitAmount, debitAmount, giftCardId, debitAmount]
        )

        if (result.changes === 0) {
          db.exec('ROLLBACK')
          return c.json({ error: 'Gift card balance insufficient (may have been used concurrently)' }, 409)
        }
      }

      // Insert payment record
      // For Finix card-present payments transactionId is the Finix transfer ID (TR_…).
      // Store it in finix_transfer_id so reconciliation can short-circuit immediately.
      // Note: the dashboard modal never sends `processor`, so processor is null for all
      // modal recordings. Always populate finix_transfer_id from transactionId —
      // the `record-payment` endpoint is only called by the modal (never for Clover
      // payments, which are recorded server-side with processor='clover').
      const finixTransferId = (processor !== 'clover') ? (transactionId ?? null) : null
      const insertResult = db.run(
        `INSERT INTO payments (
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name,
          transaction_id, processor, auth_code,
          finix_transfer_id,
          signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          gift_card_id, gift_card_tax_offset_cents,
          receipt_email, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (order_id, finix_transfer_id) DO NOTHING`,
        [
          paymentId, orderId, merchantId, paymentType, totalCents,
          subtotalCents, taxCents, tipCents, amexSurchargeCents, gratuityPercent ?? null,
          cardType ?? null, cardLastFour ?? null, cardholderName ?? null,
          transactionId ?? null, processor ?? null, authCode ?? null,
          finixTransferId,
          signatureBase64 ?? null, signatureCapturedAt,
          splitMode, splitLegNumber, splitTotalLegs, splitItemsJson,
          giftCardId, giftCardTaxOffsetCents,
          receiptEmail ?? null, now, now,
        ]
      )

      // Recovery path (recordTerminalPayment) may have already inserted this
      // payment row. Rebind paymentId to the existing row so all downstream
      // references (scheduleReconciliation, response) are consistent.
      if (insertResult.changes === 0 && finixTransferId) {
        const existing = db
          .query<{ id: string }, [string, string]>(
            `SELECT id FROM payments WHERE order_id = ? AND finix_transfer_id = ? LIMIT 1`
          )
          .get(orderId, finixTransferId)
        if (existing) paymentId = existing.id
      }

      // Only mark order paid on the final leg
      if (isLastLeg) {
        // Accumulate totals across all legs (the row inserted above is included).
        // For unsplit payments the SUM equals this leg's values.
        const totals = db
          .query<{ total_paid: number; total_tips: number; total_surcharge: number }, [string]>(
            `SELECT COALESCE(SUM(amount_cents), 0)         AS total_paid,
                    COALESCE(SUM(tip_cents), 0)            AS total_tips,
                    COALESCE(SUM(amex_surcharge_cents), 0) AS total_surcharge
             FROM payments WHERE order_id = ?`
          )
          .get(orderId)

        // Why: per-leg payments.tax_cents is not authoritative for the order's
        // tax. For splitMode='equal'/'custom' each leg sends 0 (tax embedded in
        // the subtotal); for 'by_items' the per-leg round() can drift ±N¢ vs.
        // round(orderSubtotal × taxRate). The order's tax was correctly rounded
        // at creation — preserve it verbatim regardless of split mode.
        const finalTax       = order.tax_cents
        const finalTips      = totals?.total_tips      ?? tipCents
        const finalPaid      = totals?.total_paid      ?? totalCents
        const finalSurcharge = totals?.total_surcharge ?? amexSurchargeCents
        // Mirror the order-creation/edit formula in dashboard-orders.ts:560-562
        // so total_cents includes discount and service charge alongside the
        // preserved tax — otherwise discounted/serviced orders drift on payment.
        const finalTotal     = order.subtotal_cents - order.discount_cents
                             + order.service_charge_cents + finalTax
                             + finalTips + finalSurcharge

        db.run(
          `UPDATE orders
           SET status = 'paid',
               tip_cents = ?,
               tax_cents = ?,
               total_cents = ?,
               paid_amount_cents = ?,
               payment_method = ?,
               updated_at = ?
           WHERE id = ?`,
          [finalTips, finalTax, finalTotal, finalPaid, paymentType, now, orderId]
        )
      }

      // ── Phase 2: UPSERT order_split_sessions ──────────────────────────────
      // Track multi-leg splits (equal/by_items/custom) so staff can pause
      // and resume from any device. gift_card and unsplit payments are not
      // tracked here.
      if (splitMode === 'equal' || splitMode === 'by_items' || splitMode === 'custom') {
        const legBase = subtotalCents + taxCents
        const sessionStatus = isLastLeg ? 'completed' : 'in_progress'
        const expectedTotal = splitMode === 'by_items' ? null : (splitTotalLegs ?? null)

        const existing = db
          .query<{
            paid_leg_bases_json: string
            paid_indices_json: string
            status: string
          }, [string]>(
            `SELECT paid_leg_bases_json, paid_indices_json, status
             FROM order_split_sessions WHERE order_id = ?`
          )
          .get(orderId)

        if (existing) {
          if (existing.status === 'completed') {
            db.exec('ROLLBACK')
            return c.json({ error: 'Split session is already completed' }, 409)
          }
          const bases: number[] = JSON.parse(existing.paid_leg_bases_json)
          bases.push(legBase)
          const indices: number[] = JSON.parse(existing.paid_indices_json)
          if (splitMode === 'by_items') {
            for (const i of byItemsLegIndices) indices.push(i)
          }
          // current_leg_number = "next leg to pay" = paid count + 1.
          // Derived from data so it stays consistent with paid_leg_bases.length
          // regardless of what splitLegNumber the client sent.
          const nextLegNumber = bases.length + 1
          db.run(
            `UPDATE order_split_sessions
             SET paid_leg_bases_json = ?,
                 paid_indices_json = ?,
                 current_leg_number = ?,
                 status = ?,
                 paused_at = NULL,
                 paused_by_employee_id = NULL,
                 updated_at = ?
             WHERE order_id = ?`,
            [JSON.stringify(bases), JSON.stringify(indices), nextLegNumber, sessionStatus, now, orderId]
          )
        } else {
          // First leg of a new session: paid count is 1, so next leg = 2.
          db.run(
            `INSERT INTO order_split_sessions (
               order_id, merchant_id, split_mode, expected_total_legs,
               current_leg_number, paid_leg_bases_json, paid_indices_json,
               status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              orderId, merchantId, splitMode, expectedTotal,
              2,
              JSON.stringify([legBase]),
              JSON.stringify(splitMode === 'by_items' ? byItemsLegIndices : []),
              sessionStatus, now, now,
            ]
          )
        }
      }

      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      logPaymentEvent('record_payment_error', {
        merchantId, orderId, amountCents: totalCents,
        level: 'error',
        message: (err as Error)?.message ?? 'DB write failed',
        extra: { paymentType, processor: processor ?? null, transactionId: transactionId ?? null },
      })
      return serverError(c, '[record-payment] DB write failed', err, 'Failed to record payment')
    }

    logPaymentEvent('record_payment_success', {
      merchantId, orderId, paymentId, amountCents: totalCents,
      transferId: processor === 'finix' ? (transactionId ?? undefined) : undefined,
      message: `Payment ${paymentId} recorded${isLastLeg ? ' (order marked paid)' : ' (split leg)'}`,
    })

    // Broadcast SSE only when order is fully paid
    if (isLastLeg) {
      broadcastToMerchant(merchantId, 'order_updated', { orderId, status: 'paid' })
      // Send receipt email to customer if they provided an email address.
      // Fire-and-forget — email failure must never block the payment response.
      sendReceiptEmail(merchantId, orderId)
        .catch(err => console.warn('[email] Receipt failed for order', orderId, err?.message ?? err))

      // Mark prior terminal_cancelled rows for this order as "superseded".
      // These are the CANCELLATION_VIA_API rows that accumulate from customer-
      // changed-mind, auto-retry, or device-X cancellations. Now that the order
      // is paid, those cancels were just retry noise — hide them from audit views.
      // Best-effort: a failure here must never block the payment response.
      try {
        db.run(
          `UPDATE payment_errors
           SET superseded_at = datetime('now')
           WHERE order_id = ?
             AND error_type = 'terminal_cancelled'
             AND superseded_at IS NULL`,
          [orderId]
        )
      } catch (err) {
        console.warn('[record-payment] supersede sweep failed for', orderId, (err as Error)?.message ?? err)
      }
    }

    // Schedule Finix reconciliation 60 s after payment is recorded
    scheduleReconciliation(merchantId, paymentId, paymentType as 'card' | 'cash' | 'gift_card')

    // Receipt delivery is handled explicitly by the client via
    // POST /api/merchants/:id/payments/:paymentId/receipt once the staff
    // confirms their choice in the RECEIPT_OPTIONS screen.
    // Auto-printing here would cause a duplicate print.

    // Clear pending terminal sale tracker — payment was successfully recorded
    try {
      db.run(`DELETE FROM pending_terminal_sales WHERE order_id = ? AND merchant_id = ?`, [orderId, merchantId])
    } catch {}

    // Release payment lock so staff can modify the order again if needed
    releasePaymentLock(orderId)

    return c.json({ paymentId, success: true, isLastLeg }, 201)
  }
)

// ─── Phase 2: Split-payment session (pause/resume) ──────────────────────────

type SplitSessionRow = {
  order_id:              string
  merchant_id:           string
  split_mode:            string
  expected_total_legs:   number | null
  current_leg_number:    number
  paid_leg_bases_json:   string
  paid_indices_json:     string
  status:                string
  paused_at:             string | null
  paused_by_employee_id: string | null
  created_at:            string
  updated_at:            string
}

/**
 * GET /api/merchants/:id/orders/:orderId/split-session
 *
 * Returns the active (in_progress or paused) split session for the order.
 * Returns 404 when there is no session, or only a completed one — completed
 * sessions are intentionally hidden so the modal does not offer to "resume"
 * an already-paid order.
 */
dashboardPayments.get(
  '/api/merchants/:id/orders/:orderId/split-session',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!
    const db = getDatabase()

    const session = db
      .query<SplitSessionRow, [string, string]>(
        `SELECT order_id, merchant_id, split_mode, expected_total_legs,
                current_leg_number, paid_leg_bases_json, paid_indices_json,
                status, paused_at, paused_by_employee_id, created_at, updated_at
         FROM order_split_sessions
         WHERE order_id = ? AND merchant_id = ?
           AND status IN ('in_progress','paused')`
      )
      .get(orderId, merchantId)

    if (!session) return c.json({ error: 'No active split session for this order' }, 404)

    return c.json({
      orderId:            session.order_id,
      splitMode:          session.split_mode,
      expectedTotalLegs:  session.expected_total_legs,
      currentLegNumber:   session.current_leg_number,
      paidLegBases:       JSON.parse(session.paid_leg_bases_json) as number[],
      paidIndices:        JSON.parse(session.paid_indices_json) as number[],
      status:             session.status,
      pausedAt:           session.paused_at,
      pausedByEmployeeId: session.paused_by_employee_id,
      createdAt:          session.created_at,
      updatedAt:          session.updated_at,
    })
  }
)

/**
 * PATCH /api/merchants/:id/orders/:orderId/split-session/pause
 *
 * Marks an in-progress split session as `paused`. Requires a valid 4-digit
 * staff PIN; any active employee at the merchant qualifies. The session is
 * automatically resumed (status → in_progress) on the next record-payment.
 *
 * @param body.pin - 4-digit employee PIN
 * @returns 200 `{ success, pausedAt, pausedByEmployeeId }` on success
 *          400 invalid pin · 401 wrong pin · 404 no session · 409 not in_progress
 */
dashboardPayments.patch(
  '/api/merchants/:id/orders/:orderId/split-session/pause',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!

    let body: { pin?: string }
    try { body = await c.req.json() } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const ip = getRequestIp({
      cfConnectingIp: c.req.header('cf-connecting-ip') ?? null,
      xForwardedFor:  c.req.header('x-forwarded-for') ?? null,
    })
    const pinResult = verifyEmployeePin({ merchantId, pin: body.pin ?? '', ip })
    if (!pinResult.ok) {
      return c.json({ error: pinResult.error }, pinResult.status)
    }

    const db = getDatabase()
    const session = db
      .query<{ status: string }, [string, string]>(
        `SELECT status FROM order_split_sessions WHERE order_id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)
    if (!session) return c.json({ error: 'No split session for this order' }, 404)
    if (session.status !== 'in_progress') {
      return c.json({ error: `Cannot pause session in state '${session.status}'` }, 409)
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
    db.run(
      `UPDATE order_split_sessions
       SET status = 'paused',
           paused_at = ?,
           paused_by_employee_id = ?,
           updated_at = ?
       WHERE order_id = ?`,
      [now, pinResult.employee.id, now, orderId]
    )

    return c.json({ success: true, pausedAt: now, pausedByEmployeeId: pinResult.employee.id })
  }
)

// ─── Phase 5: Partial-pay write-off (EOD reconciliation) ────────────────────

/**
 * GET /api/merchants/:id/split-sessions?status=paused
 *
 * Lists open split sessions for the merchant, joined with order summary.
 * Default `status` filter is `paused` (the EOD writeoff use case); pass
 * `status=in_progress` or `status=any` to see other states.
 *
 * Each entry includes: order summary, paid_total / paid_pre_tip totals so
 * the dashboard can display "$X paid of $Y · write off the remaining $Z?"
 * without making N+1 follow-up calls.
 */
dashboardPayments.get(
  '/api/merchants/:id/split-sessions',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const statusParam = c.req.query('status') ?? 'paused'

    const validStatuses = new Set(['in_progress', 'paused', 'any'])
    if (!validStatuses.has(statusParam)) {
      return c.json({ error: `status must be one of: in_progress, paused, any` }, 400)
    }

    const db = getDatabase()
    type Row = {
      order_id:                  string
      split_mode:                string
      expected_total_legs:       number | null
      current_leg_number:        number
      paid_leg_bases_json:       string
      paid_indices_json:         string
      status:                    string
      paused_at:                 string | null
      paused_by_employee_id:     string | null
      created_at:                string
      updated_at:                string
      customer_name:             string
      table_label:               string | null
      order_subtotal_cents:      number
      order_tax_cents:           number
      order_total_cents:         number
      order_discount_cents:      number
      order_service_charge_cents: number
      order_status:              string
      paid_total_cents:          number
      paid_tip_cents:            number
      paid_surcharge_cents:      number
    }

    // LIMIT 100: defense against runaway lists if a busy bar accumulates
    // many paused tabs over a weekend. EOD reconciliation realistically
    // touches <20 sessions; 100 is comfortable headroom.
    const sql = `
      SELECT s.order_id, s.split_mode, s.expected_total_legs, s.current_leg_number,
             s.paid_leg_bases_json, s.paid_indices_json, s.status,
             s.paused_at, s.paused_by_employee_id, s.created_at, s.updated_at,
             o.customer_name, o.table_label,
             o.subtotal_cents       AS order_subtotal_cents,
             o.tax_cents            AS order_tax_cents,
             o.total_cents          AS order_total_cents,
             COALESCE(o.discount_cents, 0)        AS order_discount_cents,
             COALESCE(o.service_charge_cents, 0)  AS order_service_charge_cents,
             o.status                             AS order_status,
             COALESCE((SELECT SUM(amount_cents)         FROM payments WHERE order_id = s.order_id), 0) AS paid_total_cents,
             COALESCE((SELECT SUM(tip_cents)            FROM payments WHERE order_id = s.order_id), 0) AS paid_tip_cents,
             COALESCE((SELECT SUM(amex_surcharge_cents) FROM payments WHERE order_id = s.order_id), 0) AS paid_surcharge_cents
      FROM order_split_sessions s
      JOIN orders o ON o.id = s.order_id
      WHERE s.merchant_id = ?
        ${statusParam === 'any' ? '' : `AND s.status = ?`}
      ORDER BY s.updated_at DESC
      LIMIT 100
    `

    const rows = statusParam === 'any'
      ? db.query<Row, [string]>(sql).all(merchantId)
      : db.query<Row, [string, string]>(sql).all(merchantId, statusParam)

    return c.json({
      sessions: rows.map((r) => {
        const paidPreTip   = r.paid_total_cents - r.paid_tip_cents - r.paid_surcharge_cents
        // Mirror the writeoff endpoint's math so dashboard previews show
        // the actual write-off amount, not an approximation.
        const taxedBase    = r.order_subtotal_cents - r.order_discount_cents + r.order_service_charge_cents
        const unpaidBase   = Math.max(0, taxedBase + r.order_tax_cents - paidPreTip)

        return {
          orderId:            r.order_id,
          splitMode:          r.split_mode,
          expectedTotalLegs:  r.expected_total_legs,
          currentLegNumber:   r.current_leg_number,
          paidLegBases:       JSON.parse(r.paid_leg_bases_json) as number[],
          paidIndices:        JSON.parse(r.paid_indices_json)   as number[],
          status:             r.status,
          pausedAt:           r.paused_at,
          pausedByEmployeeId: r.paused_by_employee_id,
          createdAt:          r.created_at,
          updatedAt:          r.updated_at,
          order: {
            customerName:        r.customer_name,
            tableLabel:          r.table_label,
            subtotalCents:       r.order_subtotal_cents,
            taxCents:            r.order_tax_cents,
            totalCents:          r.order_total_cents,
            discountCents:       r.order_discount_cents,
            serviceChargeCents:  r.order_service_charge_cents,
            status:              r.order_status,
          },
          paidTotalCents:     r.paid_total_cents,
          paidTipCents:       r.paid_tip_cents,
          paidSurchargeCents: r.paid_surcharge_cents,
          paidPreTipCents:    paidPreTip,
          // Pre-computed preview total for the dashboard write-off button.
          // Authoritative amount is still computed server-side at writeoff time.
          unpaidBaseCents:    unpaidBase,
        }
      }),
    })
  }
)

/**
 * POST /api/merchants/:id/orders/:orderId/writeoff-unpaid
 *
 * Reconciles a paused split session as fully paid by writing off the unpaid
 * balance as a discount. After this:
 *   - `orders.discount_cents` is increased by the unpaid amount
 *   - `orders.tax_cents` is recomputed on the new (discounted) base
 *   - `orders.total_cents` matches `paid_amount_cents` (sum of legs)
 *   - `orders.status` becomes `paid`, `tip_cents` reflects sum of leg tips
 *   - `order_split_sessions.status` becomes `completed`
 *
 * The math (preserves sales-tax integrity):
 *   target_pre_tip = SUM(payments.amount_cents - tip_cents - amex_surcharge_cents)
 *   new_taxed_base = round(target_pre_tip / (1 + taxRate))
 *   added_discount = subtotal + service_charge - existing_discount - new_taxed_base
 *   new_tax        = target_pre_tip - new_taxed_base
 *
 * Manager-PIN-gated. Caller must:
 *   1. Have a JWT with `owner` or `manager` role (dashboard session).
 *   2. Provide a 4-digit `pin` belonging to an `owner` or `manager` employee
 *      at this merchant. Rate-limited identically to /employees/authenticate.
 * The PIN gate exists so an unattended manager-logged-in tablet can't be
 * abused by staff to silently zero out unpaid balances.
 *
 * Errors:
 *   400 — bad JSON / bad pin format
 *   401 — wrong PIN / PIN belongs to non-manager employee
 *   404 — order or session missing
 *   409 — session not paused, or order not in a paused-eligible status
 *   422 — paid amount exceeds order total (math invariant violated)
 *   429 — PIN rate-limit lockout
 */
dashboardPayments.post(
  '/api/merchants/:id/orders/:orderId/writeoff-unpaid',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!

    let body: { pin?: string }
    try { body = await c.req.json() } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const ip = getRequestIp({
      cfConnectingIp: c.req.header('cf-connecting-ip') ?? null,
      xForwardedFor:  c.req.header('x-forwarded-for') ?? null,
    })
    const pinResult = verifyEmployeePin({
      merchantId,
      pin: body.pin ?? '',
      ip,
      allowedRoles: ['owner', 'manager'],
    })
    if (!pinResult.ok) {
      return c.json({ error: pinResult.error }, pinResult.status)
    }

    const db = getDatabase()

    // ── Reads + writes inside a single transaction (concurrency fix) ────────
    // Without this, a concurrent record-payment could complete the order
    // between our session-status read and the order UPDATE, leading to a
    // double-paid status and a broken total.
    let result: {
      addedDiscount:   number
      newDiscount:     number
      newDiscountLabel: string
      newTax:          number
      newTotal:        number
      paidTotal:       number
      paidTips:        number
      paidSurcharge:   number
      paidPreTip:      number
    }
    try {
      db.exec('BEGIN')

      const session = db
        .query<{ status: string }, [string, string]>(
          `SELECT status FROM order_split_sessions WHERE order_id = ? AND merchant_id = ?`
        )
        .get(orderId, merchantId)
      if (!session) {
        db.exec('ROLLBACK')
        return c.json({ error: 'No split session for this order' }, 404)
      }
      if (session.status !== 'paused') {
        db.exec('ROLLBACK')
        return c.json({ error: `Cannot write off session in state '${session.status}'` }, 409)
      }

      const order = db
        .query<{
          id:                   string
          status:               string
          subtotal_cents:       number
          tax_cents:            number
          total_cents:          number
          discount_cents:       number
          discount_label:       string | null
          service_charge_cents: number
        }, [string, string]>(
          `SELECT id, status, subtotal_cents, tax_cents, total_cents,
                  COALESCE(discount_cents, 0) AS discount_cents, discount_label,
                  COALESCE(service_charge_cents, 0) AS service_charge_cents
           FROM orders WHERE id = ? AND merchant_id = ?`
        )
        .get(orderId, merchantId)
      if (!order) {
        db.exec('ROLLBACK')
        return c.json({ error: 'Order not found' }, 404)
      }
      if (order.status === 'paid' || order.status === 'cancelled' || order.status === 'refunded') {
        db.exec('ROLLBACK')
        return c.json({ error: `Order is already ${order.status}` }, 409)
      }

      const merchantRow = db
        .query<{ tax_rate: number | null }, [string]>(
          `SELECT tax_rate FROM merchants WHERE id = ?`
        )
        .get(merchantId)
      const taxRate = merchantRow?.tax_rate ?? 0

      const totals = db
        .query<{ paid_total: number; paid_tips: number; paid_surcharge: number }, [string]>(
          `SELECT COALESCE(SUM(amount_cents), 0)         AS paid_total,
                  COALESCE(SUM(tip_cents), 0)            AS paid_tips,
                  COALESCE(SUM(amex_surcharge_cents), 0) AS paid_surcharge
           FROM payments WHERE order_id = ?`
        )
        .get(orderId)

      const paidTotal     = totals?.paid_total     ?? 0
      const paidTips      = totals?.paid_tips      ?? 0
      const paidSurcharge = totals?.paid_surcharge ?? 0
      const paidPreTip    = paidTotal - paidTips - paidSurcharge

      if (paidPreTip < 0) {
        db.exec('ROLLBACK')
        return c.json({ error: 'Internal error: tips/surcharge exceed total paid' }, 422)
      }

      // newTaxedBase = round(paidPreTip / (1 + taxRate)). With taxRate=0
      // the divisor is 1, so newTaxedBase === paidPreTip and newTax === 0.
      const newTaxedBase = Math.round(paidPreTip / (1 + taxRate))
      const newTax       = paidPreTip - newTaxedBase
      const existingTaxedBase = order.subtotal_cents - order.discount_cents + order.service_charge_cents
      const addedDiscount = existingTaxedBase - newTaxedBase

      if (addedDiscount < 0) {
        db.exec('ROLLBACK')
        return c.json({
          error: 'Paid amount already covers the full bill — nothing to write off',
          paidPreTipCents: paidPreTip,
          existingTaxedBaseCents: existingTaxedBase,
        }, 422)
      }

      const newDiscount = order.discount_cents + addedDiscount
      const newDiscountLabel = order.discount_label
        ? `${order.discount_label} + Unpaid balance write-off`
        : 'Unpaid balance write-off'
      const newTotal = newTaxedBase + newTax + paidTips + paidSurcharge   // = paidTotal
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

      db.run(
        `UPDATE orders
         SET status = 'paid',
             discount_cents = ?,
             discount_label = ?,
             tax_cents = ?,
             tip_cents = ?,
             total_cents = ?,
             paid_amount_cents = ?,
             updated_at = ?
         WHERE id = ?`,
        [newDiscount, newDiscountLabel, newTax, paidTips, newTotal, paidTotal, now, orderId]
      )

      db.run(
        `UPDATE order_split_sessions
         SET status = 'completed', updated_at = ?
         WHERE order_id = ?`,
        [now, orderId]
      )

      db.exec('COMMIT')

      result = {
        addedDiscount, newDiscount, newDiscountLabel, newTax, newTotal,
        paidTotal, paidTips, paidSurcharge, paidPreTip,
      }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      return serverError(c, '[writeoff-unpaid] DB write failed', err, 'Failed to apply write-off')
    }

    logPaymentEvent('writeoff_unpaid', {
      merchantId, orderId, amountCents: result.addedDiscount,
      message: `Unpaid balance written off as discount: ${(result.addedDiscount / 100).toFixed(2)}`,
      extra: {
        newDiscountLabel: result.newDiscountLabel,
        paidTotal: result.paidTotal,
        paidPreTip: result.paidPreTip,
        newTax:    result.newTax,
        approvedByEmployeeId: pinResult.employee.id,
      },
    })

    // SSE: include the recomputed fields so other tabs/devices can update
    // without re-fetching the full order.
    broadcastToMerchant(merchantId, 'order_updated', {
      orderId,
      status:           'paid',
      tipCents:         result.paidTips,
      totalCents:       result.newTotal,
      discountCents:    result.newDiscount,
      paidAmountCents:  result.paidTotal,
    })

    return c.json({
      success:                true,
      addedDiscountCents:     result.addedDiscount,
      newDiscountCents:       result.newDiscount,
      newDiscountLabel:       result.newDiscountLabel,
      newTaxCents:            result.newTax,
      newTotalCents:          result.newTotal,
      paidAmountCents:        result.paidTotal,
      paidTipCents:           result.paidTips,
      paidSurchargeCents:     result.paidSurcharge,
      approvedByEmployeeId:   pinResult.employee.id,
    })
  }
)

/**
 * POST /api/merchants/:id/orders/:orderId/finalize-partial
 *
 * In-modal "customer left" path: staff invokes this from the EXIT_CONFIRM_SPLIT
 * screen when the customer is leaving mid-split with no intention of paying
 * the remainder. Applies the unpaid balance as a discount, marks the order
 * paid, marks the session completed — same math as writeoff-unpaid but
 * accepts `in_progress` sessions (the EOD writeoff requires `paused`).
 *
 * Staff JWT only — no PIN gate. The customer is in front of the staff
 * member, the discount is small, and the alternative is the staff getting
 * stuck mid-modal with a freed table they can't actually free.
 *
 * Errors:
 *   404 — order or session missing
 *   409 — order already paid/cancelled/refunded, or session already completed
 *   422 — paid amount exceeds order total (math invariant violated)
 */
dashboardPayments.post(
  '/api/merchants/:id/orders/:orderId/finalize-partial',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!
    const db = getDatabase()

    let result: {
      addedDiscount:    number
      newDiscount:      number
      newDiscountLabel: string
      newTax:           number
      newTotal:         number
      paidTotal:        number
      paidTips:         number
      paidSurcharge:    number
    }

    try {
      db.exec('BEGIN')

      const session = db
        .query<{ status: string }, [string, string]>(
          `SELECT status FROM order_split_sessions WHERE order_id = ? AND merchant_id = ?`
        )
        .get(orderId, merchantId)
      if (!session) {
        db.exec('ROLLBACK')
        return c.json({ error: 'No split session for this order' }, 404)
      }
      if (session.status === 'completed') {
        db.exec('ROLLBACK')
        return c.json({ error: 'Split session is already completed' }, 409)
      }

      const order = db
        .query<{
          id:                   string
          status:               string
          subtotal_cents:       number
          tax_cents:            number
          total_cents:          number
          discount_cents:       number
          discount_label:       string | null
          service_charge_cents: number
        }, [string, string]>(
          `SELECT id, status, subtotal_cents, tax_cents, total_cents,
                  COALESCE(discount_cents, 0) AS discount_cents, discount_label,
                  COALESCE(service_charge_cents, 0) AS service_charge_cents
           FROM orders WHERE id = ? AND merchant_id = ?`
        )
        .get(orderId, merchantId)
      if (!order) {
        db.exec('ROLLBACK')
        return c.json({ error: 'Order not found' }, 404)
      }
      if (order.status === 'paid' || order.status === 'cancelled' || order.status === 'refunded') {
        db.exec('ROLLBACK')
        return c.json({ error: `Order is already ${order.status}` }, 409)
      }

      const merchantRow = db
        .query<{ tax_rate: number | null }, [string]>(
          `SELECT tax_rate FROM merchants WHERE id = ?`
        )
        .get(merchantId)
      const taxRate = merchantRow?.tax_rate ?? 0

      const totals = db
        .query<{ paid_total: number; paid_tips: number; paid_surcharge: number }, [string]>(
          `SELECT COALESCE(SUM(amount_cents), 0)         AS paid_total,
                  COALESCE(SUM(tip_cents), 0)            AS paid_tips,
                  COALESCE(SUM(amex_surcharge_cents), 0) AS paid_surcharge
           FROM payments WHERE order_id = ?`
        )
        .get(orderId)

      const paidTotal     = totals?.paid_total     ?? 0
      const paidTips      = totals?.paid_tips      ?? 0
      const paidSurcharge = totals?.paid_surcharge ?? 0
      const paidPreTip    = paidTotal - paidTips - paidSurcharge

      if (paidPreTip < 0) {
        db.exec('ROLLBACK')
        return c.json({ error: 'Internal error: tips/surcharge exceed total paid' }, 422)
      }

      const newTaxedBase = Math.round(paidPreTip / (1 + taxRate))
      const newTax       = paidPreTip - newTaxedBase
      const existingTaxedBase = order.subtotal_cents - order.discount_cents + order.service_charge_cents
      const addedDiscount = existingTaxedBase - newTaxedBase

      if (addedDiscount < 0) {
        db.exec('ROLLBACK')
        return c.json({
          error: 'Paid amount already covers the full bill — nothing to discount',
          paidPreTipCents: paidPreTip,
          existingTaxedBaseCents: existingTaxedBase,
        }, 422)
      }

      const newDiscount = order.discount_cents + addedDiscount
      const newDiscountLabel = order.discount_label
        ? `${order.discount_label} + Customer left — partial payment closed out`
        : 'Customer left — partial payment closed out'
      const newTotal = newTaxedBase + newTax + paidTips + paidSurcharge   // = paidTotal
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

      db.run(
        `UPDATE orders
         SET status = 'paid',
             discount_cents = ?,
             discount_label = ?,
             tax_cents = ?,
             tip_cents = ?,
             total_cents = ?,
             paid_amount_cents = ?,
             updated_at = ?
         WHERE id = ?`,
        [newDiscount, newDiscountLabel, newTax, paidTips, newTotal, paidTotal, now, orderId]
      )

      db.run(
        `UPDATE order_split_sessions
         SET status = 'completed', updated_at = ?
         WHERE order_id = ?`,
        [now, orderId]
      )

      db.exec('COMMIT')

      result = {
        addedDiscount, newDiscount, newDiscountLabel, newTax, newTotal,
        paidTotal, paidTips, paidSurcharge,
      }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      return serverError(c, '[finalize-partial] DB write failed', err, 'Failed to finalize partial payment')
    }

    logPaymentEvent('finalize_partial', {
      merchantId, orderId, amountCents: result.addedDiscount,
      message: `Customer-left writeoff: discount ${(result.addedDiscount / 100).toFixed(2)} on $${(result.paidTotal / 100).toFixed(2)} paid`,
      extra: { newDiscountLabel: result.newDiscountLabel, paidTotal: result.paidTotal, newTax: result.newTax },
    })

    broadcastToMerchant(merchantId, 'order_updated', {
      orderId,
      status:           'paid',
      tipCents:         result.paidTips,
      totalCents:       result.newTotal,
      discountCents:    result.newDiscount,
      paidAmountCents:  result.paidTotal,
    })

    return c.json({
      success:              true,
      addedDiscountCents:   result.addedDiscount,
      newDiscountCents:     result.newDiscount,
      newDiscountLabel:     result.newDiscountLabel,
      newTaxCents:          result.newTax,
      newTotalCents:        result.newTotal,
      paidAmountCents:      result.paidTotal,
      paidTipCents:         result.paidTips,
      paidSurchargeCents:   result.paidSurcharge,
    })
  }
)

/**
 * POST /api/merchants/:id/payments/:paymentId/receipt
 *
 * Fires receipt delivery (print and/or email) for an already-recorded payment.
 * Idempotent — safe to call again if the first attempt failed.
 *
 * @param body.action - `'print' | 'email' | 'both'`
 * @param body.email - Recipient address (required when action includes `'email'`)
 * @returns `{ printed: boolean, emailed: boolean }`
 */
dashboardPayments.post(
  '/api/merchants/:id/payments/:paymentId/receipt',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const paymentId  = c.req.param('paymentId')!
    const db = getDatabase()

    const payment = db
      .query<{
        order_id: string
        subtotal_cents: number
        tax_cents: number
        tip_cents: number
        amount_cents: number
        receipt_email: string | null
      }, [string, string]>(
        `SELECT order_id, subtotal_cents, tax_cents, tip_cents, amount_cents, receipt_email
         FROM payments WHERE id = ? AND merchant_id = ?`
      )
      .get(paymentId, merchantId)

    if (!payment) return c.json({ error: 'Payment not found' }, 404)

    let body: { action: string; email?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const { action, email } = body
    if (action !== 'print' && action !== 'email' && action !== 'both') {
      return c.json({ error: "action must be 'print', 'email', or 'both'" }, 400)
    }

    const order = db
      .query<{
        order_type: string
        customer_name: string
        customer_email: string | null
        items: string
        table_label: string | null
        room_label: string | null
        notes: string | null
      }, [string]>(
        `SELECT order_type, customer_name, customer_email, items, table_label, room_label, notes
         FROM orders WHERE id = ?`
      )
      .get(payment.order_id)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    let printed = false
    let emailed = false

    if (action === 'print' || action === 'both') {
      try {
        const merchant = db
          .query<{
            business_name: string
            receipt_printer_ip: string | null
            printer_ip: string | null
            receipt_printer_protocol: string | null
            kitchen_printer_protocol: string | null
            receipt_style: string | null
            tax_rate: number
          }, [string]>(
            `SELECT business_name, receipt_printer_ip, printer_ip,
                    receipt_printer_protocol, kitchen_printer_protocol,
                    receipt_style, tax_rate
             FROM merchants WHERE id = ?`
          )
          .get(merchantId)

        const receiptIp = merchant?.receipt_printer_ip || merchant?.printer_ip || null
        if (receiptIp) {
          const protocol = (merchant?.receipt_printer_protocol ||
                            merchant?.kitchen_printer_protocol ||
                            'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
          const receiptStyle = (merchant?.receipt_style ?? 'classic') as 'classic' | 'html'

          let items: Array<{ quantity: number; dishName: string; priceCents: number; modifiers?: Array<{ name: string; priceCents: number }> }> = []
          try { items = JSON.parse(order.items) } catch {}

          await printCustomerReceipt({
            printerIp: receiptIp,
            printerProtocol: protocol,
            receiptStyle,
            orderId: payment.order_id,
            orderType: order.order_type,
            merchantName: merchant?.business_name ?? null,
            customerName: order.customer_name,
            tableLabel: order.table_label,
            roomLabel: order.room_label,
            notes: order.notes,
            items,
            subtotalCents: payment.subtotal_cents,
            taxCents: payment.tax_cents,
            taxRate: merchant?.tax_rate ?? 0,
            paidAmountCents: payment.amount_cents,
            tipCents: payment.tip_cents,
          })
          printed = true
          db.run(`UPDATE payments SET receipt_printed = 1 WHERE id = ?`, [paymentId])
        }
      } catch (err) {
        console.warn('[receipt] Print failed:', err instanceof Error ? err.message : err)
      }
    }

    if (action === 'email' || action === 'both') {
      const emailTo = email || payment.receipt_email || order.customer_email
      if (emailTo) {
        try {
          await sendReceiptEmail(merchantId, payment.order_id)
          emailed = true
          db.run(
            `UPDATE payments SET receipt_emailed = 1, receipt_email = ? WHERE id = ?`,
            [emailTo, paymentId]
          )
        } catch (err) {
          console.warn('[receipt] Email failed:', err instanceof Error ? err.message : err)
        }
      }
    }

    return c.json({ printed, emailed })
  }
)

/**
 * GET /api/merchants/:id/payments/reconciliation
 *
 * Returns ALL payments in the date range — both in-person (from the `payments`
 * table) and online/redirect-paid orders (from `orders` where `payment_method`
 * is set and no `payments` row exists) — each annotated with Finix
 * reconciliation status (`matched`, `unmatched`, or absent for cash).
 *
 * @param query.from - Unix timestamp ms, start of range (default: start of today)
 * @param query.to   - Unix timestamp ms, end of range (default: now)
 * @returns `{ payments: PaymentEntry[], summary: { total, matched, unmatched, pending, totalCents } }`
 */
dashboardPayments.get(
  '/api/merchants/:id/payments/reconciliation',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const db = getDatabase()

    const nowMs        = Date.now()
    const todayStartMs = new Date(new Date().setHours(0, 0, 0, 0)).getTime()

    const fromMs = parseInt(c.req.query('from') ?? String(todayStartMs), 10)
    const toMs   = parseInt(c.req.query('to')   ?? String(nowMs),        10)

    if (isNaN(fromMs) || isNaN(toMs) || fromMs > toMs) {
      return c.json({ error: 'Invalid from/to range' }, 400)
    }

    const fromIso = new Date(fromMs).toISOString().replace('T', ' ').substring(0, 19)
    const toIso   = new Date(toMs).toISOString().replace('T', ' ').substring(0, 19)

    type PaymentRow = {
      id: string
      order_id: string | null
      source_type: 'in_person' | 'online' | 'gift_card_purchase'
      payment_type: string
      amount_cents: number
      subtotal_cents: number
      tax_cents: number
      tip_cents: number
      card_type: string | null
      card_last_four: string | null
      cardholder_name: string | null
      transaction_id: string | null
      processor: string | null
      auth_code: string | null
      finix_transfer_id: string | null
      split_mode: string | null
      split_leg_number: number | null
      split_total_legs: number | null
      created_at: string
      customer_name: string
      order_type: string
      rec_status: string | null
      rec_finix_transfer_id: string | null
      rec_finix_amount_cents: number | null
      rec_checked_at: string | null
    }

    const rows = db
      .query<PaymentRow, [string, string, string, string, string, string, string, string, string]>(
        // Leg 1 — in-person payments recorded via the Review & Pay modal
        `SELECT
           p.id,
           p.order_id,
           'in_person'                 AS source_type,
           p.payment_type,
           p.amount_cents,
           p.subtotal_cents,
           p.tax_cents,
           p.tip_cents,
           p.card_type,
           p.card_last_four,
           p.cardholder_name,
           p.transaction_id,
           p.processor,
           p.auth_code,
           p.finix_transfer_id,
           p.split_mode,
           p.split_leg_number,
           p.split_total_legs,
           p.created_at,
           o.customer_name,
           o.order_type,
           r.status                    AS rec_status,
           r.finix_transfer_id         AS rec_finix_transfer_id,
           r.finix_amount_cents        AS rec_finix_amount_cents,
           r.checked_at               AS rec_checked_at
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         LEFT JOIN payment_reconciliations r ON r.payment_id = p.id
         WHERE p.merchant_id = ?
           AND p.created_at >= ?
           AND p.created_at <= ?

         UNION ALL

         -- Leg 2 — online / redirect-paid orders (Finix/Converge hosted page,
         --         or cash-on-delivery). Only orders that have NO payments-table
         --         row are included to avoid double-counting split dine-in orders.
         SELECT
           o.id                                         AS id,
           o.id                                         AS order_id,
           'online'                                     AS source_type,
           o.payment_method                             AS payment_type,
           COALESCE(o.paid_amount_cents, o.total_cents) AS amount_cents,
           o.subtotal_cents,
           o.tax_cents,
           COALESCE(o.tip_cents, 0)                     AS tip_cents,
           NULL                                         AS card_type,
           NULL                                         AS card_last_four,
           NULL                                         AS cardholder_name,
           o.payment_transfer_id                        AS transaction_id,
           NULL                                         AS processor,
           NULL                                         AS auth_code,
           o.payment_transfer_id                        AS finix_transfer_id,
           NULL                                         AS split_mode,
           NULL                                         AS split_leg_number,
           NULL                                         AS split_total_legs,
           o.created_at,
           o.customer_name,
           o.order_type,
           CASE
             WHEN o.payment_method = 'cash'             THEN 'cash_skipped'
             WHEN o.payment_transfer_id IS NOT NULL      THEN 'matched'
             WHEN o.payment_method = 'card'
              AND o.status NOT IN ('received','cancelled') THEN 'matched'
             ELSE NULL
           END                                          AS rec_status,
           o.payment_transfer_id                        AS rec_finix_transfer_id,
           COALESCE(o.paid_amount_cents, o.total_cents) AS rec_finix_amount_cents,
           o.updated_at                                 AS rec_checked_at
         FROM orders o
         WHERE o.merchant_id = ?
           AND o.payment_method IS NOT NULL
           AND o.created_at >= ?
           AND o.created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id = o.id)

         UNION ALL

         -- Leg 3 — online gift card purchases (customer buys gift card via store)
         SELECT
           gcp.id,
           NULL                             AS order_id,
           'gift_card_purchase'             AS source_type,
           'gift_card_purchase'             AS payment_type,
           gcp.total_cents                  AS amount_cents,
           gcp.net_revenue_cents            AS subtotal_cents,
           gcp.tax_embedded_cents           AS tax_cents,
           0                               AS tip_cents,
           NULL                             AS card_type,
           NULL                             AS card_last_four,
           NULL                             AS cardholder_name,
           gcp.payment_transfer_id          AS transaction_id,
           gcp.payment_provider             AS processor,
           NULL                             AS auth_code,
           gcp.payment_transfer_id          AS finix_transfer_id,
           NULL                             AS split_mode,
           NULL                             AS split_leg_number,
           NULL                             AS split_total_legs,
           gcp.created_at,
           gcp.customer_name,
           'online'                         AS order_type,
           CASE WHEN gcp.payment_transfer_id IS NOT NULL THEN 'matched' ELSE NULL END AS rec_status,
           gcp.payment_transfer_id          AS rec_finix_transfer_id,
           gcp.total_cents                  AS rec_finix_amount_cents,
           gcp.created_at                   AS rec_checked_at
         FROM gift_card_purchases gcp
         WHERE gcp.merchant_id = ?
           AND gcp.status = 'paid'
           AND gcp.created_at >= ?
           AND gcp.created_at <= ?

         ORDER BY created_at DESC`
      )
      .all(merchantId, fromIso, toIso, merchantId, fromIso, toIso, merchantId, fromIso, toIso)

    const payments = rows.map((row) => ({
      id:              row.id,
      orderId:         row.order_id,
      sourceType:      row.source_type,
      createdAt:       row.created_at,
      paymentType:     row.payment_type,
      amountCents:     row.amount_cents,
      subtotalCents:   row.subtotal_cents,
      taxCents:        row.tax_cents,
      tipCents:        row.tip_cents,
      cardType:        row.card_type,
      cardLastFour:    row.card_last_four,
      cardholderName:  row.cardholder_name,
      transactionId:   row.transaction_id,
      processor:       row.processor,
      authCode:        row.auth_code,
      finixTransferId: row.finix_transfer_id,
      splitMode:       row.split_mode,
      splitLegNumber:  row.split_leg_number,
      splitTotalLegs:  row.split_total_legs,
      customerName:    row.customer_name,
      orderType:       row.order_type,
      reconciliation:  row.rec_status
        ? {
            status:           row.rec_status,
            finixTransferId:  row.rec_finix_transfer_id,
            finixAmountCents: row.rec_finix_amount_cents,
            checkedAt:        row.rec_checked_at,
          }
        : null,
    }))

    const summary = {
      total:      payments.length,
      matched:    payments.filter((p) => p.reconciliation?.status === 'matched').length,
      unmatched:  payments.filter((p) => p.reconciliation?.status === 'unmatched').length,
      pending:    payments.filter((p) => !p.reconciliation && p.paymentType === 'card').length,
      totalCents: payments.reduce((sum, p) => sum + p.amountCents, 0),
    }

    return c.json({ payments, summary })
  },
)

/**
 * GET /api/merchants/:id/orders/:orderId/detail
 *
 * Returns a single order with full line-item breakdown, pricing totals,
 * all payment legs (split or single), and Finix reconciliation status
 * for each card leg. Used by the Payments-tab order-detail modal.
 *
 * @returns `{ order: OrderDetail, paymentLegs: PaymentLeg[] }`
 */

dashboardPayments.get(
  '/api/merchants/:id/orders/:orderId/detail',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!

    try {
      const db = getDatabase()

      const order = db
        .query<Record<string, unknown>, [string, string]>(
          `SELECT id, customer_name, customer_phone, customer_email, order_type, table_label,
                  items, subtotal_cents, tax_cents, tip_cents, total_cents,
                  discount_cents, discount_label, payment_method,
                  payment_transfer_id, paid_amount_cents, status, pickup_time,
                  created_at, source
           FROM orders WHERE id = ? AND merchant_id = ?`,
        )
        .get(orderId, merchantId)

      if (!order) return c.json({ error: 'Order not found' }, 404)

      // Parse items JSON
      let items: unknown[] = []
      try {
        const parsed = JSON.parse(order.items as string)
        if (Array.isArray(parsed)) items = parsed
      } catch { /* empty */ }

      // Fetch in-person payment records (split legs)
      const paymentRows = db
        .query<Record<string, unknown>, [string, string]>(
          `SELECT id, payment_type, amount_cents, subtotal_cents, tax_cents,
                  tip_cents, amex_surcharge_cents, card_type, card_last_four,
                  cardholder_name, transaction_id, processor, auth_code,
                  split_mode, split_leg_number, split_total_legs, created_at
           FROM payments WHERE order_id = ? AND merchant_id = ?
           ORDER BY split_leg_number ASC, created_at ASC`,
        )
        .all(orderId, merchantId)

      // Fetch reconciliation for each payment record
      const recon = db
        .query<Record<string, unknown>, [string]>(
          `SELECT payment_id, status, finix_transfer_id, finix_amount_cents, checked_at
           FROM payment_reconciliations WHERE payment_id IN (
             SELECT id FROM payments WHERE order_id = ?
           )`,
        )
        .all(orderId)

      const reconMap = new Map(recon.map((r) => [r.payment_id, r]))

      const paymentLegs = paymentRows.map((p) => {
        const rec = reconMap.get(p.id as string)
        return {
          id:                p.id,
          paymentType:       p.payment_type,
          amountCents:       p.amount_cents,
          subtotalCents:     p.subtotal_cents,
          taxCents:          p.tax_cents,
          tipCents:          p.tip_cents,
          amexSurchargeCents: p.amex_surcharge_cents,
          cardType:          p.card_type,
          cardLastFour:      p.card_last_four,
          cardholderName:    p.cardholder_name,
          transactionId:     p.transaction_id,
          processor:         p.processor,
          authCode:          p.auth_code,
          splitMode:         p.split_mode,
          splitLegNumber:    p.split_leg_number,
          splitTotalLegs:    p.split_total_legs,
          createdAt:         p.created_at,
          reconciliation:    rec
            ? { status: rec.status, finixTransferId: rec.finix_transfer_id, checkedAt: rec.checked_at }
            : null,
        }
      })

      return c.json({
        order: {
          id:               order.id,
          customerName:     order.customer_name,
          customerPhone:    order.customer_phone,
          customerEmail:    order.customer_email ?? null,
          orderType:        order.order_type,
          tableLabel:       order.table_label,
          status:           order.status,
          source:           order.source,
          pickupTime:       order.pickup_time,
          createdAt:        order.created_at,
          items,
          subtotalCents:    order.subtotal_cents  ?? 0,
          taxCents:         order.tax_cents       ?? 0,
          tipCents:         order.tip_cents        ?? 0,
          totalCents:       order.total_cents      ?? 0,
          discountCents:    order.discount_cents   ?? 0,
          discountLabel:    order.discount_label,
          paidAmountCents:  order.paid_amount_cents ?? 0,
          paymentMethod:    order.payment_method,
          paymentTransferId: order.payment_transfer_id,
        },
        paymentLegs,
      })
    } catch (err) {
      return serverError(c, '[payments] order detail', err, 'Failed to fetch order detail')
    }
  },
)

/**
 * POST /api/merchants/:id/payments/reconcile-pending
 *
 * Re-triggers Finix reconciliation for all card payments in the merchant's
 * `payments` table that have no corresponding `payment_reconciliations` row
 * (e.g. missed due to a restart or transient Finix API failure).
 *
 * @returns `{ queued: number }` — count of payments scheduled for reconciliation
 */
dashboardPayments.post(
  '/api/merchants/:id/payments/reconcile-pending',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const db = getDatabase()

    const pending = db
      .query<{ id: string }, [string]>(
        `SELECT p.id FROM payments p
         LEFT JOIN payment_reconciliations r ON r.payment_id = p.id
         WHERE p.merchant_id = ? AND p.payment_type = 'card' AND r.id IS NULL`,
      )
      .all(merchantId)

    for (const p of pending) {
      runReconciliation(merchantId, p.id).catch((err) =>
        console.warn('[reconcile] retry error:', err?.message ?? err),
      )
    }

    return c.json({ queued: pending.length })
  },
)

// ---------------------------------------------------------------------------
// Finix credential + device helpers (shared by terminal-sale endpoints)
// ---------------------------------------------------------------------------

/** Loads Finix credentials for a merchant. Returns null if not configured.
 *  When FINIX_EMULATOR_URL is set, returns synthetic dummy credentials so the
 *  emulator can be used in dev without inserting real DB api_key rows. */
async function loadFinixCreds(merchantId: string): Promise<FinixCredentials | null> {
  // Emulator bypass — credentials are not validated by the local mock server
  if (process.env.FINIX_EMULATOR_URL) {
    return {
      apiUsername:    'emulator',
      applicationId: 'APemulator000000000000000000000',
      merchantId:    'MUemulator000000000000000000000',
      apiPassword:   'emulator-secret',
      sandbox:       true,
    }
  }

  const db = getDatabase()
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return null

  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`
    )
    .get(merchantId)

  const parts = (keyRow?.pos_merchant_id ?? '').split(':')
  if (parts.length !== 3) return null

  const merchantRow = db
    .query<{ finix_sandbox: number }, [string]>(
      `SELECT finix_sandbox FROM merchants WHERE id = ?`
    )
    .get(merchantId)
  const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

  return {
    apiUsername:    parts[0],
    applicationId: parts[1],
    merchantId:    parts[2],
    apiPassword,
    sandbox,
  }
}

/**
 * Resolves the Finix device ID for a specific terminal.
 * If terminalId is given, resolves only that terminal.
 * Otherwise picks the first terminal with a serial number.
 */
async function resolveFinixDeviceId(
  merchantId: string,
  creds: FinixCredentials,
  terminalId?: string,
): Promise<string | null> {
  const db = getDatabase()

  type CachedRow   = { id: string; finix_device_id: string }
  type TerminalRow = { id: string; serial_number: string | null }

  // 1. Check for a cached finix_device_id
  const cached = terminalId
    ? db.query<CachedRow, [string, string]>(
        `SELECT id, finix_device_id FROM terminals
         WHERE id = ? AND merchant_id = ? AND finix_device_id IS NOT NULL`
      ).get(terminalId, merchantId)
    : db.query<CachedRow, [string]>(
        `SELECT id, finix_device_id FROM terminals
         WHERE merchant_id = ? AND finix_device_id IS NOT NULL LIMIT 1`
      ).get(merchantId)
  if (cached) return cached.finix_device_id

  // 2. Look up serial number from local terminals table
  const terminal = terminalId
    ? db.query<TerminalRow, [string, string]>(
        `SELECT id, serial_number FROM terminals
         WHERE id = ? AND merchant_id = ? AND serial_number IS NOT NULL`
      ).get(terminalId, merchantId)
    : db.query<TerminalRow, [string]>(
        `SELECT id, serial_number FROM terminals
         WHERE merchant_id = ? AND serial_number IS NOT NULL LIMIT 1`
      ).get(merchantId)
  if (!terminal?.serial_number) return null

  // 3. Query Finix API for devices matching serial number
  try {
    const devices = await listDevices(creds)
    const match = devices.find(
      d => d.serialNumber === terminal.serial_number && d.enabled
    )
    if (!match) return null

    // Cache for next time
    db.run(
      `UPDATE terminals SET finix_device_id = ? WHERE id = ?`,
      [match.id, terminal.id]
    )
    console.log(`[finix] Cached device ${match.id} for terminal ${terminal.id} (serial ${terminal.serial_number})`)
    return match.id
  } catch (err) {
    console.error('[finix] Failed to list devices:', (err as Error).message)
    return null
  }
}

/**
 * Returns all terminals for a merchant with their resolved Finix device IDs.
 * Used by the payment modal to show per-terminal pay buttons.
 */
async function listMerchantTerminals(
  merchantId: string,
  creds: FinixCredentials,
): Promise<Array<{ id: string; nickname: string; model: string; finixDeviceId: string | null }>> {
  const db = getDatabase()
  const rows = db
    .query<{ id: string; nickname: string; model: string; serial_number: string | null; finix_device_id: string | null }, [string]>(
      // Include terminals that either have a serial number (for auto-resolve) OR
      // already have a finix_device_id (e.g. pax_a920_emu, which has no serial)
      `SELECT id, nickname, model, serial_number, finix_device_id FROM terminals
       WHERE merchant_id = ? AND (serial_number IS NOT NULL OR finix_device_id IS NOT NULL)
       ORDER BY created_at ASC`
    )
    .all(merchantId)

  if (rows.length === 0) return []

  // Resolve any uncached devices in one Finix API call (skip emulator rows — ID is pre-set)
  const needsResolve = rows.filter(r => !r.finix_device_id && r.serial_number)
  if (needsResolve.length > 0) {
    try {
      const devices = await listDevices(creds)
      for (const row of needsResolve) {
        const match = devices.find(d => d.serialNumber === row.serial_number && d.enabled)
        if (match) {
          db.run(`UPDATE terminals SET finix_device_id = ? WHERE id = ?`, [match.id, row.id])
          row.finix_device_id = match.id
          console.log(`[finix] Cached device ${match.id} for terminal ${row.id} (serial ${row.serial_number})`)
        }
      }
    } catch (err) {
      console.error('[finix] Failed to list devices:', (err as Error).message)
    }
  }

  return rows.map(r => ({
    id:            r.id,
    nickname:      r.nickname,
    model:         r.model,
    finixDeviceId: r.finix_device_id,
  }))
}

/**
 * GET /api/merchants/:id/terminals/devices
 *
 * Returns all registered terminals with their resolved Finix device IDs.
 * Lazily resolves device IDs by querying Finix if the cached value is
 * missing. Used by the payment modal to display per-terminal pay buttons.
 *
 * @returns `{ terminals: Array<{ id, nickname, model, finixDeviceId }> }`
 */
dashboardPayments.get(
  '/api/merchants/:id/terminals/devices',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ terminals: [] })
      const terminals = await listMerchantTerminals(merchantId, creds)
      return c.json({ terminals })
    } catch (err) {
      return serverError(c, '[payments] list terminals', err, 'Failed to list terminal devices')
    }
  },
)

/**
 * POST /api/merchants/:id/orders/:orderId/terminal-sale
 *
 * Initiates an in-person card payment on a PAX terminal via Finix. Returns
 * immediately — before Finix responds — with a `ttxId` the client uses to poll
 * `GET /terminal-sale/by-ttx/:ttxId` until the customer taps or the workflow
 * times out (180 s). The heavy lifting lives in the SAM terminal-payment
 * workflow (`v2/src/workflows/terminal-payment.ts`).
 *
 * This route keeps only the concerns that must run synchronously in the request
 * handler: role check, amount validation, device connection check, tipping
 * config sync, payment-lock acquisition. Everything else — Finix create-sale,
 * 422 idempotency recovery, cancel-beat-tap race handling, timeout — lives in
 * the workflow and runs in a detached promise.
 *
 * @param body.totalCents       Charge amount in cents
 * @param body.terminalId       Kizo terminal record ID (first available if omitted)
 * @param body.splitLegNumber   Split-leg number, or null/omitted for non-split
 * @returns `{ ttxId, idempotencyKey, deviceId, tipOnTerminal }`
 */
dashboardPayments.post(
  '/api/merchants/:id/orders/:orderId/terminal-sale',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!

    try {
      const {
        totalCents,
        terminalId,
        splitMode,
        splitLegNumber,
        splitTotalLegs,
        splitItemsJson,
      } = await c.req.json() as {
        totalCents:      number
        terminalId?:     string
        splitMode?:      string | null
        splitLegNumber?: number | null
        splitTotalLegs?: number | null
        splitItemsJson?: string | null
      }
      if (typeof totalCents !== 'number' || totalCents <= 0) {
        return c.json({ error: 'totalCents must be a positive integer' }, 400)
      }

      // by_items: validate splitItemsJson at the route layer (mirrors
      // record-payment). The workflow does its own defense-in-depth check
      // inside the BEGIN transaction; this layer just rejects malformed input.
      if (splitMode === 'by_items') {
        if (!splitItemsJson) {
          return c.json({ error: 'splitItemsJson is required for by_items split' }, 400)
        }
        let parsed: unknown
        try { parsed = JSON.parse(splitItemsJson) } catch {
          return c.json({ error: 'splitItemsJson must be valid JSON' }, 400)
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return c.json({ error: 'splitItemsJson must be a non-empty array of item indices' }, 400)
        }
        const seenInLeg = new Set<number>()
        for (const idx of parsed) {
          if (!Number.isInteger(idx) || (idx as number) < 0) {
            return c.json({ error: `splitItemsJson contains invalid item index: ${idx}` }, 400)
          }
          if (seenInLeg.has(idx as number)) {
            return c.json({ error: `splitItemsJson contains duplicate item index: ${idx}` }, 400)
          }
          seenInLeg.add(idx as number)
        }
      }

      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

      const deviceId = await resolveFinixDeviceId(merchantId, creds, terminalId ?? undefined)
      if (!deviceId) return c.json({ error: 'No terminal found — add a terminal with a serial number in Store Profile' }, 400)

      // Device connection pre-check. "Closed" = terminal asleep; creating a
      // transfer against an offline device silently succeeds on Finix but the
      // terminal never displays the payment prompt.
      try {
        const conn = await checkDeviceConnection(creds, deviceId)
        if (conn.connection !== 'Open') {
          logPaymentEvent('terminal_device_offline', {
            merchantId, orderId, deviceId, amountCents: totalCents,
            level: 'warn',
            message: `Device connection is '${conn.connection}' — terminal not ready`,
          })
          return c.json({
            error: `Terminal is not ready (status: ${conn.connection}). Wake the device and try again.`,
          }, 503)
        }
      } catch (connErr) {
        console.warn(`[finix] terminal-sale: device connection check failed for ${deviceId}:`, (connErr as Error)?.message)
      }

      console.log(`[finix] terminal-sale: order=${orderId} amount=${totalCents} device=${deviceId}`)

      const db = getDatabase()

      // Defensive tipping config sync: push tip-on-terminal settings to the device
      // before the workflow creates a transfer. Fire-and-forget — a Finix error
      // here must not block the sale; the device falls back to its cached config.
      const merchantTipRow = db
        .query<{ tip_on_terminal: number; suggested_tip_percentages: string }, [string]>(
          `SELECT tip_on_terminal, suggested_tip_percentages FROM merchants WHERE id = ? LIMIT 1`,
        )
        .get(merchantId)
      const tipOnTerminal = (merchantTipRow?.tip_on_terminal ?? 0) === 1
      const tipPercentages: number[] = (() => {
        try { return JSON.parse(merchantTipRow?.suggested_tip_percentages ?? '[15,20,25]') } catch { return [15, 20, 25] }
      })()
      updateDeviceTippingConfig(creds, deviceId, tipOnTerminal, tipPercentages).catch((syncErr) => {
        console.warn(`[finix] terminal-sale: tipping config sync failed for device ${deviceId}:`, (syncErr as Error)?.message ?? syncErr)
      })

      // Hand off to the workflow. Returns synchronously once the ttx row is
      // persisted (<100 ms); the Finix POST fires in the background.
      const started = await startTerminalPaymentForDashboard({
        merchantId,
        orderId,
        amountCents:    totalCents,
        terminalId:     terminalId ?? undefined,
        splitMode:      splitMode      ?? null,
        splitLegNumber: splitLegNumber ?? null,
        splitTotalLegs: splitTotalLegs ?? null,
        splitItemsJson: splitItemsJson ?? null,
      })

      if (!started.ok) {
        logPaymentEvent('terminal_error', {
          merchantId, orderId, deviceId, amountCents: totalCents,
          level: 'error',
          message: started.error,
        })
        return c.json(
          { error: started.error, activeTtxId: started.activeTtxId ?? null },
          started.statusCode as 400 | 409 | 500,
        )
      }

      // Lock the order for the duration of the terminal transaction so no one
      // can cancel or edit it while the customer is tapping their card.
      acquirePaymentLock(orderId)

      return c.json({
        ttxId:          started.ttxId,
        idempotencyKey: started.idempotencyKey,
        deviceId:       started.deviceId,
        tipOnTerminal,
      })
    } catch (err) {
      logPaymentEvent('terminal_error', {
        merchantId, orderId, amountCents: undefined,
        level: 'error',
        message: (err as Error)?.message ?? 'Unknown error initiating terminal sale',
      })
      return serverError(c, '[payments] initiate terminal sale', err, 'Failed to initiate terminal sale')
    }
  },
)

/**
 * GET /api/merchants/:id/terminal-sale/by-ttx/:ttxId
 *
 * Polls the status of an in-progress terminal sale by the workflow's ttxId.
 * The payment modal calls this every 2 s until `state` is `SUCCEEDED` or
 * `FAILED`. Response shape is the same as the legacy `/terminal-sale/:transferId`
 * endpoint — card brand, last 4, approval code, tip amount, entry mode —
 * plus `transferId` which becomes available once Finix responds.
 */
dashboardPayments.get(
  '/api/merchants/:id/terminal-sale/by-ttx/:ttxId',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ttxId      = c.req.param('ttxId')!

    try {
      const status = getTerminalTxStatus(merchantId, ttxId)
      if (!status) return c.json({ error: 'Terminal transaction not found' }, 404)
      return c.json(status)
    } catch (err) {
      return serverError(c, '[payments] terminal sale status by ttx', err, 'Failed to check terminal sale status')
    }
  },
)

/**
 * GET /api/merchants/:id/terminal-sale/:transferId
 *
 * Legacy pre-workflow polling endpoint (kept for compatibility until all
 * clients are bumped past the modal cache-buster). Hits Finix directly — does
 * not use the workflow's ttx row. New code should use `/by-ttx/:ttxId`.
 */
dashboardPayments.get(
  '/api/merchants/:id/terminal-sale/:transferId',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const transferId = c.req.param('transferId')!

    try {
      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

      const status = await getTerminalTransferStatus(creds, transferId)

      if (status.state === 'SUCCEEDED') {
        logPaymentEvent('terminal_succeeded', {
          merchantId, transferId,
          amountCents: status.amount,
          message: `Terminal payment approved — card ${status.cardBrand ?? '?'} …${status.cardLastFour ?? '????'} auth ${status.approvalCode ?? '?'}`,
          extra: { cardBrand: status.cardBrand, cardLastFour: status.cardLastFour, approvalCode: status.approvalCode, entryMode: status.entryMode },
        })
      } else if (status.state === 'FAILED') {
        logPaymentEvent('terminal_failed', {
          merchantId, transferId,
          amountCents: status.amount,
          level: 'warn',
          message: `Terminal payment failed — ${status.failureCode ?? 'UNKNOWN'}: ${status.failureMessage ?? ''}`,
          extra: { failureCode: status.failureCode, failureMessage: status.failureMessage },
        })
      }

      return c.json(status)
    } catch (err) {
      return serverError(c, '[payments] terminal sale status', err, 'Failed to check terminal sale status')
    }
  },
)

/**
 * POST /api/merchants/:id/terminal-sale/cancel
 *
 * Cancels an in-progress PAX terminal transaction.
 * Prefers routing through the SAM workflow (orderId) so the FSM's cancel-beat-tap
 * race handling fires; falls back to a raw device cancel for compatibility.
 *
 * @param body.orderId   Workflow-routed cancel (preferred) — cancels by orderId
 * @param body.deviceId  Raw device cancel fallback (legacy clients)
 */
dashboardPayments.post(
  '/api/merchants/:id/terminal-sale/cancel',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    try {
      const body = await c.req.json() as { orderId?: string; deviceId?: string; reason?: string }

      // When staff hits "Customer changed mind — take cash", log a distinct event so
      // reconciliation/audit can tell routine cash switches apart from timeouts and
      // hard cancels. The resulting Finix CANCELLATION_VIA_API row will later be
      // marked superseded by record-payment when the cash leg succeeds.
      if (body.reason === 'switch_to_cash' && body.orderId) {
        logPaymentEvent('terminal_abandoned_switch_to_cash', {
          merchantId,
          orderId:  body.orderId,
          deviceId: body.deviceId,
          message:  'Staff switched from card to cash after customer changed mind',
        })
      }

      if (body.orderId) {
        const routed = cancelTerminalPaymentByOrder(body.orderId)
        if (routed) {
          releasePaymentLock(body.orderId)
          return c.json({ success: true, routed: 'workflow' })
        }
        // No workflow found — fall through to raw cancel if deviceId was also provided.
      }

      if (!body.deviceId) {
        return c.json({ error: 'orderId or deviceId is required' }, 400)
      }

      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

      await cancelTerminalSale(creds, body.deviceId)
      if (body.orderId) releasePaymentLock(body.orderId)

      return c.json({ success: true, routed: 'device' })
    } catch (err) {
      return serverError(c, '[payments] cancel terminal sale', err, 'Failed to cancel terminal sale')
    }
  },
)

/**
 * POST /api/merchants/:id/orders/:orderId/link-transfer
 *
 * Manually links a Finix Transfer to an order that was charged on the terminal
 * but never recorded locally (e.g. client timeout during `record-payment`).
 * Verifies the Transfer on Finix, inserts a `payments` row, and marks the
 * order `paid`. Manager+ only — requires explicit staff action to prevent
 * accidental double-recording.
 *
 * @param body.transferId - Finix Transfer ID to link
 * @returns `{ paymentId: string, success: true }`
 */
dashboardPayments.post(
  '/api/merchants/:id/orders/:orderId/link-transfer',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!

    try {
      const { transferId } = await c.req.json() as { transferId: string }
      if (!transferId || typeof transferId !== 'string') {
        return c.json({ error: 'transferId is required' }, 400)
      }

      const db = getDatabase()

      // Verify the order exists
      const order = db
        .query<{ status: string; total_cents: number }, [string, string]>(
          `SELECT status, total_cents FROM orders WHERE id = ? AND merchant_id = ?`,
        )
        .get(orderId, merchantId)
      if (!order) return c.json({ error: 'Order not found' }, 404)

      // Check if payment already recorded for this order
      const existing = db
        .query<{ id: string }, [string]>(`SELECT id FROM payments WHERE order_id = ? LIMIT 1`)
        .get(orderId)
      if (existing) {
        return c.json({ error: `Payment already recorded (${existing.id})` }, 409)
      }

      // Verify the transfer on Finix
      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

      const status = await getTerminalTransferStatus(creds, transferId)
      if (status.state !== 'SUCCEEDED') {
        return c.json({ error: `Transfer state is ${status.state}, expected SUCCEEDED` }, 400)
      }

      // Create local payment record
      const paymentId = `pay_${randomBytes(16).toString('hex')}`
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      const cardType = status.cardBrand?.toLowerCase() ?? null
      const cardLastFour = status.cardLastFour ?? null

      db.run(
        `INSERT INTO payments (
          id, merchant_id, order_id, payment_type, subtotal_cents, tax_cents,
          tip_cents, amex_surcharge_cents, amount_cents, card_type, card_last_four,
          cardholder_name, transaction_id, processor, auth_code,
          signature_base64, receipt_email, split_mode, split_leg_number, split_total_legs,
          split_items_json, finix_transfer_id,
          created_at, completed_at
        ) VALUES (?, ?, ?, 'card', ?, 0, 0, 0, ?, ?, ?, NULL, ?, 'finix', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [
          paymentId, merchantId, orderId,
          status.amount,  // subtotal = full amount (no tip split available)
          status.amount,
          cardType, cardLastFour,
          transferId, status.approvalCode ?? null,
          transferId,
          now, now,
        ],
      )

      // Mark order as paid
      db.run(
        `UPDATE orders SET status = 'paid', payment_method = 'card',
               paid_amount_cents = ?, updated_at = datetime('now')
         WHERE id = ? AND merchant_id = ?`,
        [status.amount, orderId, merchantId],
      )

      // Clean up any pending terminal sale tracker
      try {
        db.run(`DELETE FROM pending_terminal_sales WHERE order_id = ? AND merchant_id = ?`, [orderId, merchantId])
      } catch {}

      console.log(`[link-transfer] ✓ Linked transfer ${transferId} to order ${orderId} → payment ${paymentId} ($${(status.amount / 100).toFixed(2)})`)

      // Notify dashboard + schedule reconciliation
      broadcastToMerchant(merchantId, 'order_updated', { orderId, status: 'paid' })
      scheduleReconciliation(merchantId, paymentId, 'card')

      return c.json({ paymentId, success: true })
    } catch (err) {
      return serverError(c, '[payments] link transfer', err, 'Failed to link transfer')
    }
  },
)

/**
 * POST /api/merchants/:id/orders/:orderId/phone-charge
 *
 * Charges a card-not-present (phone/mail-order) payment via the Finix.js
 * tokenization form. The browser converts raw card fields into a one-time
 * Finix token; this route exchanges the token for a `PaymentInstrument`,
 * then fires a `Transfer`. Raw PAN never reaches Kizo servers (SAQ A-EP).
 *
 * On decline Finix returns a cancelled Transfer — this route re-raises it
 * as HTTP 402 `{ error: 'Card declined' }`.
 *
 * @param body.token - One-time Finix.js tokenization token
 * @param body.totalCents - Charge amount in cents
 * @param body.postalCode - Optional postal code for AVS
 * @returns `{ transferId, cardBrand, cardLastFour, approvalCode, state }`
 * @throws 402 if the card is declined
 */
dashboardPayments.post(
  '/api/merchants/:id/orders/:orderId/phone-charge',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const orderId    = c.req.param('orderId')!

    let body: { token: string; totalCents: number; postalCode?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const { token, totalCents, postalCode } = body

    if (!token || typeof token !== 'string') {
      return c.json({ error: 'token is required' }, 400)
    }
    if (typeof totalCents !== 'number' || totalCents <= 0) {
      return c.json({ error: 'totalCents must be a positive integer' }, 400)
    }

    // Validate order is chargeable
    const db = getDatabase()
    const order = db
      .query<{ id: string; status: string; customer_name: string | null }, [string, string]>(
        `SELECT id, status, customer_name FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)
    if (['paid', 'cancelled', 'refunded'].includes(order.status)) {
      return c.json({ error: `Order is already ${order.status}` }, 409)
    }

    const creds = await loadFinixCreds(merchantId)
    if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

    try {
      const tokenPrefix = token?.substring(0, 8) ?? 'none'
      console.log(`[finix] phone-charge: order=${orderId} amount=${totalCents} token=${tokenPrefix}…`)

      // Finix V2 PaymentForm.submit() may return either:
      //   - A PaymentInstrument ID (PI_xxx) — already created by the SDK
      //   - A tokenization token (TK_xxx or PT_xxx) — needs PI creation
      let paymentInstrumentId: string
      if (token.startsWith('PI_')) {
        paymentInstrumentId = token
      } else {
        paymentInstrumentId = await createPaymentInstrumentFromToken(creds, token, postalCode, order.customer_name ?? undefined)
      }

      const idempotencyId = `${orderId}-cnp-${paymentInstrumentId}`
      const result = await createCNPTransfer(creds, paymentInstrumentId, totalCents, {
        order_id:    orderId,
        merchant_id: merchantId,
      }, idempotencyId)

      // Log every attempt — both SUCCEEDED and FAILED — so staff can audit CNP
      // payment history in the Terminal Status modal (including declined CVV tests).
      try {
        db.run(
          `INSERT INTO cnp_attempts
             (id, merchant_id, order_id, amount_cents, state,
              card_brand, card_last_four, approval_code, finix_transfer_id, decline_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            merchantId,
            orderId,
            totalCents,
            result.state,
            result.cardBrand,
            result.cardLastFour,
            result.approvalCode,
            result.transferId,
            result.state === 'FAILED' ? 'Card declined' : null,
          ],
        )
      } catch (logErr) {
        console.warn('[cnp_attempts] Failed to log attempt:', logErr)
      }

      if (result.state === 'FAILED') {
        return c.json({ error: 'Card declined' }, 402)
      }

      return c.json(result)
    } catch (err) {
      return serverError(c, '[payments] phone charge', err, 'Phone charge failed')
    }
  },
)

/**
 * GET /api/merchants/:id/terminal-events
 *
 * Returns all terminal_transactions rows for the merchant in reverse
 * chronological order (most recent first). Unlike the payments/reconciliation
 * endpoint, this shows every row — succeeded, declined, cancelled, timed-out —
 * regardless of whether a `payments` row was ever created.
 *
 * Intended for staff troubleshooting (e.g. duplicate charges, false-failure
 * reports from the PAX A920 Pro). Scope: last 200 rows or 7 days, whichever
 * is smaller.
 *
 * @returns `{ events: Array<TerminalEvent> }`
 */
dashboardPayments.get(
  '/api/merchants/:id/terminal-events',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()
      const rows = db.query<{
        id:                  string
        tx_state:            string
        amount_cents:        number | null
        tip_amount_cents:    number | null
        approved_amount_cents: number | null
        card_brand:          string | null
        card_last_four:      string | null
        approval_code:       string | null
        entry_mode:          string | null
        decline_code:        string | null
        decline_message:     string | null
        finix_transfer_id:   string | null
        order_id:            string | null
        payment_id:          string | null
        started_at:          string | null
        completed_at:        string | null
        created_at:          string
        source:              'terminal' | 'cnp'
      }, [string, string]>(
        `SELECT id, tx_state, amount_cents, tip_amount_cents, approved_amount_cents,
                card_brand, card_last_four, approval_code, entry_mode,
                decline_code, decline_message, finix_transfer_id, order_id,
                payment_id, started_at, completed_at, created_at,
                'terminal' AS source
           FROM terminal_transactions
          WHERE merchant_id = ?
            AND created_at >= datetime('now', '-7 days')
        UNION ALL
        SELECT id, state AS tx_state, amount_cents, NULL AS tip_amount_cents,
                NULL AS approved_amount_cents,
                card_brand, card_last_four, approval_code, NULL AS entry_mode,
                NULL AS decline_code, decline_message, finix_transfer_id, order_id,
                NULL AS payment_id, NULL AS started_at, NULL AS completed_at, created_at,
                'cnp' AS source
           FROM cnp_attempts
          WHERE merchant_id = ?
            AND created_at >= datetime('now', '-7 days')
          ORDER BY created_at DESC
          LIMIT 200`,
      ).all(merchantId, merchantId)

      // Derive severity for UI display
      const events = rows.map(r => {
        let severity: 'success' | 'warning' | 'error' | 'pending'
        const s = r.tx_state
        if (s === 'SUCCEEDED' || s === 'COMPLETED') {
          severity = 'success'
        } else if (
          s === 'CANCELLATION_VIA_API' || s === 'CANCELLED' ||
          s === 'CANCELLING' || s === 'REVERSED'
        ) {
          severity = 'warning'
        } else if (
          s === 'DECLINED' || s === 'FAILED' ||
          s === 'POLLING_TIMEOUT' || s === 'REVERSAL_FAILED'
        ) {
          severity = 'error'
        } else {
          severity = 'pending'
        }

        return {
          id:                 r.id,
          txState:            r.tx_state,
          severity,
          amountCents:        r.amount_cents,
          tipAmountCents:     r.tip_amount_cents,
          approvedAmountCents: r.approved_amount_cents,
          cardBrand:          r.card_brand,
          cardLastFour:       r.card_last_four,
          approvalCode:       r.approval_code,
          entryMode:          r.entry_mode,
          declineCode:        r.decline_code,
          declineMessage:     r.decline_message,
          finixTransferId:    r.finix_transfer_id,
          orderId:            r.order_id,
          paymentId:          r.payment_id,
          startedAt:          r.started_at,
          completedAt:        r.completed_at,
          createdAt:          r.created_at,
          source:             r.source,
        }
      })

      return c.json({ events })
    } catch (err) {
      return serverError(c, '[payments] terminal events', err, 'Failed to load terminal events')
    }
  },
)

export { dashboardPayments }
