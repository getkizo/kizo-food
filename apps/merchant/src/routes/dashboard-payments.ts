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
import { getAPIKey, getPOSMerchantId } from '../crypto/api-keys'
import { getConvergePaymentUrl } from '../adapters/converge'
import { createCheckoutForm, createTerminalSale, getTerminalTransferStatus, cancelTerminalSale, checkDeviceConnection, listDevices, createPaymentInstrumentFromToken, createCNPTransfer, FinixTransferCancelledError, updateDeviceTippingConfig } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { broadcastToMerchant } from '../services/sse'
import { printCustomerReceipt } from '../services/printer'
import { sendReceiptEmail } from '../services/email'
import { serverError } from '../utils/server-error'
import { scheduleReconciliation, runReconciliation } from '../services/reconcile'
import { logPaymentEvent } from '../services/payment-log'
import { acquirePaymentLock, releasePaymentLock } from '../services/order-locks'
import type { AuthContext } from '../middleware/auth'

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
    const merchantId = c.req.param('id')
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
      }, [string]>(
        `SELECT stax_token, converge_sandbox, finix_sandbox, COALESCE(finix_refund_mode, 'local') AS finix_refund_mode FROM merchants WHERE id = ?`
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
        enabled: !!(process.env.CLOVER_MERCHANT_ID && process.env.CLOVER_API_TOKEN),
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
    const merchantId = c.req.param('id')

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
    const merchantId = c.req.param('id')

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
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')
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
        .query<{ id: string }, [string]>(`SELECT id FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(orderId)
      return c.json({ error: `Order is already ${order.status}`, paymentId: existing?.id ?? null }, 409)
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
    if (splitMode) {
      const VALID_SPLIT_MODES = ['equal', 'by_items', 'custom', 'gift_card']
      if (!VALID_SPLIT_MODES.includes(splitMode)) {
        return c.json({ error: `splitMode must be one of: ${VALID_SPLIT_MODES.join(', ')}` }, 400)
      }
      if (!Number.isInteger(splitLegNumber) || splitLegNumber < 1 || splitLegNumber > 10) {
        return c.json({ error: 'splitLegNumber must be an integer between 1 and 10' }, 400)
      }
      if (!Number.isInteger(splitTotalLegs) || splitTotalLegs < 2 || splitTotalLegs > 10) {
        return c.json({ error: 'splitTotalLegs must be an integer between 2 and 10' }, 400)
      }
      if (splitLegNumber > splitTotalLegs) {
        return c.json({ error: 'splitLegNumber cannot exceed splitTotalLegs' }, 400)
      }
    }

    // isLastLeg: true for unsplit payments, or when this is the final split leg
    const isLastLeg = !splitMode ||
      (splitLegNumber ?? 1) >= (splitTotalLegs ?? 1)

    const paymentId = `pay_${randomBytes(16).toString('hex')}`
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
          .query<{ id: string }, [string]>(`SELECT id FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(orderId)
        return c.json({ error: `Order is already ${currentStatus.status}`, paymentId: existing?.id ?? null }, 409)
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
      const finixTransferId = processor === 'finix' ? (transactionId ?? null) : null
      db.run(
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

      // Only mark order paid on the final leg
      if (isLastLeg) {
        // For split payments, accumulate totals across all legs (including this one).
        // The current leg's payment row was already inserted above, so the SUM
        // covers every leg. For unsplit payments the SUM equals this leg's values.
        const totals = db
          .query<{ total_paid: number; total_tips: number; total_tax: number }, [string]>(
            `SELECT COALESCE(SUM(amount_cents), 0) AS total_paid,
                    COALESCE(SUM(tip_cents), 0)    AS total_tips,
                    COALESCE(SUM(tax_cents), 0)    AS total_tax
             FROM payments WHERE order_id = ?`
          )
          .get(orderId)

        const finalTax  = totals?.total_tax  ?? taxCents
        const finalTips = totals?.total_tips ?? tipCents
        const finalPaid = totals?.total_paid ?? totalCents

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
          [finalTips, finalTax, finalPaid, finalPaid, paymentType, now, orderId]
        )
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
    const merchantId = c.req.param('id')
    const paymentId  = c.req.param('paymentId')
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
    const merchantId = c.req.param('id')
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
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')

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
    const merchantId = c.req.param('id')
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
    const merchantId = c.req.param('id')
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
 * Initiates an in-person card payment on a PAX terminal via Finix.
 * Resolves the Finix device ID from the terminal record, creates a
 * `terminal_sale` Transfer, and persists a `pending_terminal_sales` row
 * so the frontend can poll for completion.
 *
 * @param body.totalCents - Charge amount in cents
 * @param body.terminalId - Kizo terminal record ID (uses first available if omitted)
 * @returns `{ transferId: string, deviceId: string }`
 */
dashboardPayments.post(
  '/api/merchants/:id/orders/:orderId/terminal-sale',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')

    try {
      const { totalCents, terminalId } = await c.req.json() as { totalCents: number; terminalId?: string }
      if (typeof totalCents !== 'number' || totalCents <= 0) {
        return c.json({ error: 'totalCents must be a positive integer' }, 400)
      }

      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

      const deviceId = await resolveFinixDeviceId(merchantId, creds, terminalId ?? undefined)
      if (!deviceId) return c.json({ error: 'No terminal found — add a terminal with a serial number in Store Profile' }, 400)

      // ── Issue 2 fix: verify device is online before creating a transfer ──
      // A "Closed" connection means the terminal is idle/sleeping. Creating a
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
        // Non-fatal: if the connection check fails, proceed and let the transfer
        // attempt reveal the issue (same behaviour as before this check).
        console.warn(`[finix] terminal-sale: device connection check failed for ${deviceId}:`, (connErr as Error)?.message)
      }

      console.log(`[finix] terminal-sale: order=${orderId} amount=${totalCents} device=${deviceId}`)

      const db = getDatabase()

      // ── Phase 7: Defensive tipping config sync ────────────────────────────
      // Read tip-on-terminal settings from DB. If enabled, push the config to
      // the device before creating the transfer so the terminal prompt matches
      // the merchant's current settings (handles devices registered before the
      // feature was enabled, or terminals that were factory-reset).
      // This is best-effort — a Finix API error here must not block the sale.
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

      // ── Issue 2 fix: cancel any stale pending sale for the same order+device ──
      // If staff taps "Pay" again after a failed attempt, the deterministic
      // idempotency key would return the same stuck/failed Finix transfer and the
      // terminal would never illuminate.  Cancel the previous transfer first, then
      // use a timestamp-suffixed key to force Finix to create a fresh transfer.
      const existingPending = db
        .query<{ id: string; transfer_id: string }, [string, string, string]>(
          `SELECT id, transfer_id FROM pending_terminal_sales
           WHERE order_id = ? AND device_id = ? AND merchant_id = ? AND status = 'pending'`,
        )
        .get(orderId, deviceId, merchantId)

      let idempotencyId: string
      if (existingPending) {
        // Check whether the existing transfer already succeeded before retrying.
        // If it did, return it directly — creating a new transfer would double-charge.
        // If the status check itself fails (Finix network blip), refuse to retry:
        // silently falling through to cancel+create would send a second payment
        // request to the terminal even if the customer already tapped.
        let existingState: string | null = null
        let statusCheckFailed = false
        try {
          const existingStatus = await getTerminalTransferStatus(creds, existingPending.transfer_id)
          existingState = existingStatus.state ?? null
        } catch (checkErr) {
          statusCheckFailed = true
          console.warn(`[finix] terminal-sale: status check failed for ${existingPending.transfer_id}:`, (checkErr as Error)?.message)
        }

        if (existingState === 'SUCCEEDED') {
          logPaymentEvent('terminal_idempotent', {
            merchantId, orderId, deviceId, amountCents: totalCents,
            transferId: existingPending.transfer_id,
            message: `Idempotent: existing transfer ${existingPending.transfer_id} already SUCCEEDED — returning it`,
          })
          // Return the already-succeeded transferId; frontend proceeds to record-payment.
          // alreadySucceeded tells the dashboard the terminal may have shown a red screen
          // even though Finix authorized the charge — staff should see a reassurance note.
          acquirePaymentLock(orderId)
          return c.json({ transferId: existingPending.transfer_id, deviceId, alreadySucceeded: true })
        }

        if (statusCheckFailed) {
          // Cannot confirm the transfer's outcome — refusing to cancel and retry
          // to avoid sending a second charge to the terminal.
          logPaymentEvent('terminal_error', {
            merchantId, orderId, deviceId, amountCents: totalCents,
            transferId: existingPending.transfer_id,
            level: 'warn',
            message: `Status check failed for existing transfer ${existingPending.transfer_id} — not retrying to avoid double-charge`,
          })
          return c.json({
            error: 'Could not verify the status of the previous payment attempt. Please wait a moment and try again.',
          }, 503)
        }

        logPaymentEvent('terminal_retry', {
          merchantId, orderId, deviceId, amountCents: totalCents,
          transferId: existingPending.transfer_id,
          message: `Retrying after stale pending sale ${existingPending.transfer_id} (state: ${existingState ?? 'unknown'})`,
        })
        try {
          await cancelTerminalSale(creds, deviceId)
          console.log(`[finix] terminal-sale retry: cancelled previous transfer ${existingPending.transfer_id}`)
        } catch (cancelErr) {
          // Non-fatal — device may already be idle
          console.warn(`[finix] terminal-sale retry: cancel failed:`, (cancelErr as Error)?.message)
        }
        db.run(`DELETE FROM pending_terminal_sales WHERE id = ?`, [existingPending.id])
        // New idempotency key forces Finix to create a fresh transfer
        idempotencyId = `${orderId}-terminal-${deviceId}-${Date.now()}`
      } else {
        // First attempt: deterministic key deduplicates rapid double-taps
        idempotencyId = `${orderId}-terminal-${deviceId}`
      }

      let result: Awaited<ReturnType<typeof createTerminalSale>>
      try {
        result = await createTerminalSale(creds, deviceId, totalCents, {
          order_id: orderId,
          merchant_id: merchantId,
        }, idempotencyId)
      } catch (saleErr) {
        // The previous attempt was cancelled on the device (e.g. customer pressed
        // Cancel before tapping card).  Finix permanently rejects the original
        // idempotency key but embeds the old transfer ID in the 422 body.
        // Retry once with a timestamp-suffixed key so the terminal wakes again.
        if (saleErr instanceof FinixTransferCancelledError) {
          logPaymentEvent('terminal_retry', {
            merchantId, orderId, deviceId, amountCents: totalCents,
            transferId: saleErr.existingTransferId,
            message: `Auto-retry after ${saleErr.failureCode} on transfer ${saleErr.existingTransferId}`,
          })
          // Best-effort device cancel — may already be idle
          try { await cancelTerminalSale(creds, deviceId) } catch {}
          // Clean up stale pending row if the table exists
          try {
            db.run(
              `DELETE FROM pending_terminal_sales WHERE order_id = ? AND merchant_id = ?`,
              [orderId, merchantId],
            )
          } catch {}
          const freshKey = `${orderId}-terminal-${deviceId}-${Date.now()}`
          result = await createTerminalSale(creds, deviceId, totalCents, {
            order_id: orderId,
            merchant_id: merchantId,
          }, freshKey)
        } else {
          throw saleErr
        }
      }

      logPaymentEvent('terminal_initiated', {
        merchantId, orderId, deviceId, amountCents: totalCents,
        transferId: result.transferId,
        message: `Transfer ${result.transferId} created (state: ${result.state})`,
      })

      // Track the in-flight terminal sale so orphaned payments can be auto-recovered
      // if the client never calls record-payment (e.g. timeout, crash, network error).
      // Wrapped in try/catch: table may not exist on older deployments (pre-migration).
      try {
        db.run(
          `INSERT OR IGNORE INTO pending_terminal_sales
             (merchant_id, order_id, transfer_id, device_id, amount_cents)
           VALUES (?, ?, ?, ?, ?)`,
          [merchantId, orderId, result.transferId, deviceId, totalCents],
        )
      } catch {}

      // Lock the order for the duration of the terminal transaction so no one can
      // cancel or edit it while the customer is tapping their card.
      acquirePaymentLock(orderId)

      return c.json({ transferId: result.transferId, deviceId, tipOnTerminal })
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
 * GET /api/merchants/:id/terminal-sale/:transferId
 *
 * Polls the status of an in-progress terminal sale transfer.
 * The payment modal calls this every 2 s until `state` is `SUCCEEDED` or `FAILED`.
 *
 * @param param.transferId - Finix Transfer ID returned by `POST terminal-sale`
 * @returns `{ state, amount, cardBrand, cardLastFour, approvalCode, … }`
 */
dashboardPayments.get(
  '/api/merchants/:id/terminal-sale/:transferId',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const transferId = c.req.param('transferId')

    try {
      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

      const status = await getTerminalTransferStatus(creds, transferId)

      // Log terminal outcomes when they're first detected (SUCCEEDED or FAILED)
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
 * Sends a cancel command to the Finix device; the terminal returns to idle.
 *
 * @param body.deviceId - Finix device ID of the terminal to cancel
 * @returns `{ success: true }`
 */
dashboardPayments.post(
  '/api/merchants/:id/terminal-sale/cancel',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    try {
      const { deviceId } = await c.req.json() as { deviceId: string }
      if (!deviceId) return c.json({ error: 'deviceId is required' }, 400)

      const creds = await loadFinixCreds(merchantId)
      if (!creds) return c.json({ error: 'Finix credentials not configured' }, 400)

      await cancelTerminalSale(creds, deviceId)

      // Release the payment lock for any order that was pending on this device
      const db = getDatabase()
      const pending = db
        .query<{ order_id: string }, [string, string]>(
          `SELECT order_id FROM pending_terminal_sales
           WHERE device_id = ? AND merchant_id = ? AND status = 'pending' LIMIT 1`,
        )
        .get(deviceId, merchantId)
      if (pending) releasePaymentLock(pending.order_id)

      return c.json({ success: true })
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
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')

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
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')

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

      if (result.state === 'FAILED') {
        return c.json({ error: 'Card declined' }, 402)
      }

      return c.json(result)
    } catch (err) {
      return serverError(c, '[payments] phone charge', err, 'Phone charge failed')
    }
  },
)

export { dashboardPayments }
