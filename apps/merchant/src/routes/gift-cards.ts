/**
 * Gift Card Store API
 *
 * Public endpoints (customer-facing, no auth):
 *   POST /api/store/gift-cards/purchase                      — create purchase record
 *   POST /api/store/gift-cards/purchases/:id/pay             — get payment URL (Converge or Finix)
 *   POST /api/store/gift-cards/purchases/:id/payment-result  — confirm payment + issue cards + send email
 *   GET  /api/store/gift-cards/purchases/:id                 — get purchase status and issued card codes
 *
 * Dashboard endpoints (authenticated staff):
 *   GET  /api/merchants/:id/gift-cards                       — list cards with status/search/pagination
 *   GET  /api/merchants/:id/gift-cards/lookup                — look up active card by code suffix (for payment)
 *   POST /api/merchants/:id/gift-cards/:cardId/print-receipt — manually trigger receipt reprint
 *
 * ## Gift card lifecycle
 *
 * ```
 * PURCHASE          → ACTIVATION         → REDEMPTION              → VOID
 * ─────────────────────────────────────────────────────────────────────────
 * Customer selects    Payment confirmed     Staff looks up code        Card expires or
 * denominations and   → gift_cards rows     via lookup endpoint.       balance hits 0.
 * pays via Converge   issued (status=       Payment modal deducts      status → 'expired'
 * or Finix.           'active').            balance_cents.             or 'depleted'.
 * gift_card_purchases Email + PDF sent      If balance reaches 0,
 * row created with    to customer.          status → 'depleted'.
 * status='pending'.   purchase status       Partial redemption keeps
 *                     → 'paid'.             card active with reduced
 *                                           balance_cents.
 * ```
 *
 * There is no explicit "void" API endpoint — cards expire automatically via
 * `expires_at` (1 year from purchase).  Staff can view expired cards in the
 * dashboard but cannot re-activate them.  Refunds for gift card purchases are
 * handled outside the system (manual, via the payment processor).
 *
 * Cart model:
 *   A purchase accepts lineItems: [{denominationCents, qty}, ...].
 *   Each line item must use a valid denomination; total must not exceed $2,000.
 *   One `gift_cards` row is issued per card after payment is confirmed.
 *
 * Tax model:
 *   10.4% embedded in face value. `net_revenue = Math.round(total / 1.104)`.
 *   Card balance equals the full face value — customer redeems $100 for a $100 card.
 *
 * Expiry: 1 year from purchase date.
 * Code format: `XXX-YYYY` (ambiguity-free charset — no 0/1/I/O).
 */

import { Hono } from 'hono'
import { serverError } from '../utils/server-error'
import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { getConvergePaymentUrl, verifyConvergeTransaction } from '../adapters/converge'
import { createCheckoutForm, getTransferIdFromCheckoutForm } from '../adapters/finix'
import { acquireWebhookLock, releaseLock } from '../services/order-locks'
import { generateGiftCardPdf } from '../services/gift-card-pdf'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { broadcastToMerchant } from '../services/sse'
import { printGiftCardReceipt } from '../services/printer'
import nodemailer from 'nodemailer'
import { buildSmtpTransport } from '../services/smtp'
import { randomInt } from 'node:crypto'
import { generateId } from '../utils/id'

const giftCards = new Hono()

// ---------------------------------------------------------------------------
// Merchant resolution (same pattern as store.ts)
// ---------------------------------------------------------------------------

interface ApplianceMerchant {
  id: string
  business_name: string
  payment_provider: string | null
  converge_sandbox: number
  finix_sandbox: number
  receipt_email_from: string | null
  smtp_provider: string | null
  phone_number: string | null
  website: string | null
  address: string | null
  logo_url: string | null
}

let _merchantCache: ApplianceMerchant | null = null
let _merchantCacheAt = 0
const MERCHANT_CACHE_TTL_MS = 60_000

function getApplianceMerchant(): ApplianceMerchant | null {
  if (_merchantCache && Date.now() - _merchantCacheAt < MERCHANT_CACHE_TTL_MS) return _merchantCache
  const db = getDatabase()
  _merchantCache = db
    .query<ApplianceMerchant, []>(
      `SELECT id, business_name, payment_provider,
              converge_sandbox, finix_sandbox,
              receipt_email_from, smtp_provider, phone_number, website, address, logo_url
       FROM merchants WHERE status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get()
  _merchantCacheAt = Date.now()
  return _merchantCache
}

/** Invalidate the appliance merchant cache — call in tests after resetting the DB. */
export function invalidateGiftCardMerchantCache(): void {
  _merchantCache = null
  _merchantCacheAt = 0
}

// ---------------------------------------------------------------------------
// Rate limiting (5 purchases per IP per 15 min)
// ---------------------------------------------------------------------------

const _rateLimiter = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = _rateLimiter.get(ip)
  if (!entry || now >= entry.resetAt) {
    _rateLimiter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  if (entry.count >= RATE_LIMIT_MAX) return false
  entry.count++
  return true
}

setInterval(() => {
  // Safety valve: if many distinct IPs have accumulated (e.g. a bot flood),
  // wipe the map entirely rather than letting it grow unbounded between sweeps.
  if (_rateLimiter.size > 5000) {
    _rateLimiter.clear()
    return
  }
  const now = Date.now()
  for (const [k, v] of _rateLimiter) {
    if (now >= v.resetAt) _rateLimiter.delete(k)
  }
}, 10 * 60 * 1000)

// ---------------------------------------------------------------------------
// Gift card code generation
// ---------------------------------------------------------------------------

const GC_PREFIX_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'           // 24 chars — no I, O
const GC_SUFFIX_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // 32 chars — no 0, 1, I, O

function generateGcCode(): string {
  let prefix = ''
  for (let i = 0; i < 3; i++) prefix += GC_PREFIX_CHARS[randomInt(GC_PREFIX_CHARS.length)]
  let suffix = ''
  for (let i = 0; i < 4; i++) suffix += GC_SUFFIX_CHARS[randomInt(GC_SUFFIX_CHARS.length)]
  return `${prefix}-${suffix}`
}

function generateUniqueCode(db: ReturnType<typeof getDatabase>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateGcCode()
    const existing = db.query<{ id: string }, [string]>(
      `SELECT id FROM gift_cards WHERE code = ?`
    ).get(code)
    if (!existing) return code
  }
  throw new Error('Failed to generate unique gift card code after 10 attempts')
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface LineItem { denominationCents: number; qty: number }

const VALID_DENOMINATIONS_CENTS = new Set([2500, 5000, 7500, 10000, 15000])
const MAX_QTY_PER_LINE = 20
const MAX_TOTAL_CENTS  = 200000  // $2,000

function esc(str: string | null | undefined): string {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function validateLineItems(rawItems: unknown): { items: LineItem[]; totalCents: number } | { error: string } {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: 'lineItems must be a non-empty array' }
  }
  if (rawItems.length > 10) {
    return { error: 'Maximum 10 line items per purchase' }
  }

  const items: LineItem[] = []
  let totalCents = 0

  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) return { error: 'Each line item must be an object' }
    const { denominationCents, qty } = raw as Record<string, unknown>

    if (typeof denominationCents !== 'number' || !VALID_DENOMINATIONS_CENTS.has(denominationCents)) {
      return { error: `Invalid denomination ${denominationCents}. Choose from $25, $50, $75, $100, or $150.` }
    }
    const qtyInt = typeof qty === 'number' ? Math.floor(qty) : 0
    if (qtyInt < 1 || qtyInt > MAX_QTY_PER_LINE) {
      return { error: `Quantity must be between 1 and ${MAX_QTY_PER_LINE} per line item` }
    }
    items.push({ denominationCents, qty: qtyInt })
    totalCents += denominationCents * qtyInt
  }

  if (totalCents > MAX_TOTAL_CENTS) {
    return { error: `Total cannot exceed $${MAX_TOTAL_CENTS / 100}` }
  }

  return { items, totalCents }
}

/**
 * POST /api/store/gift-cards/purchase
 *
 * Creates a pending gift card purchase record from the customer's cart.
 * Validates denominations, quantity limits, and the $2,000 cart cap.
 * Does not issue cards — payment must be confirmed first.
 *
 * @param body.lineItems - `[{ denominationCents, qty }]`
 * @param body.customerName - Optional recipient name
 * @param body.customerEmail - Email address for delivery (required)
 * @param body.message - Optional personal message
 * @returns `{ purchaseId: string }`
 */
giftCards.post('/api/store/gift-cards/purchase', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const ip = c.get('ipAddress') as string ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return c.json({ error: 'Too many requests. Please wait a moment and try again.' }, 429)
  }

  let body: { customerName?: unknown; customerEmail?: unknown; lineItems?: unknown; recipientName?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { customerName, customerEmail, lineItems, recipientName } = body

  if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
    return c.json({ error: 'customerName is required' }, 400)
  }
  if (!customerEmail || typeof customerEmail !== 'string' || !customerEmail.trim() || !customerEmail.includes('@')) {
    return c.json({ error: 'A valid customerEmail is required' }, 400)
  }

  const validated = validateLineItems(lineItems)
  if ('error' in validated) return c.json({ error: validated.error }, 400)
  const { items, totalCents } = validated

  const netRevenueCents   = Math.round(totalCents / 1.104)
  const taxEmbeddedCents  = totalCents - netRevenueCents

  const id = generateId('gcp')
  const db = getDatabase()
  const recipientNameClean = (typeof recipientName === 'string' && recipientName.trim())
    ? recipientName.trim().slice(0, 128)
    : null

  db.run(
    `INSERT INTO gift_card_purchases
      (id, merchant_id, customer_name, customer_email, recipient_name,
       line_items_json, total_cents, net_revenue_cents, tax_embedded_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, merchant.id,
     customerName.trim().slice(0, 128),
     customerEmail.trim().toLowerCase().slice(0, 256),
     recipientNameClean,
     JSON.stringify(items),
     totalCents, netRevenueCents, taxEmbeddedCents]
  )

  return c.json({ purchaseId: id, totalCents }, 201)
})

/**
 * POST /api/store/gift-cards/purchases/:id/pay
 *
 * Returns a payment URL for the given purchase. Chooses Converge or Finix
 * based on which provider is configured. The URL redirects to
 * `/gift-cards/pay-return` after payment.
 *
 * @param param.id - Purchase ID from `POST /purchase`
 * @returns `{ url: string }` — hosted payment page URL
 */
giftCards.post('/api/store/gift-cards/purchases/:id/pay', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const purchaseId = c.req.param('id')
  const db = getDatabase()

  const purchase = db
    .query<{
      id: string
      total_cents: number
      customer_name: string
      status: string
    }, [string, string]>(
      `SELECT id, total_cents, customer_name, status
       FROM gift_card_purchases WHERE id = ? AND merchant_id = ?`
    )
    .get(purchaseId, merchant.id)

  if (!purchase) return c.json({ error: 'Purchase not found' }, 404)
  if (purchase.status !== 'pending_payment') {
    return c.json({ error: 'Purchase is not awaiting payment' }, 409)
  }

  let body: { returnUrl: string; fraudSessionId?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { returnUrl, fraudSessionId } = body
  if (!returnUrl || typeof returnUrl !== 'string') {
    return c.json({ error: 'returnUrl is required' }, 400)
  }
  if (!returnUrl.startsWith('/') || returnUrl.startsWith('//')) {
    return c.json({ error: 'Invalid return URL' }, 400)
  }

  const requestOrigin    = new URL(c.req.url).origin
  const absoluteReturnUrl = `${requestOrigin}${returnUrl}`
  const provider         = merchant.payment_provider

  if (!provider || !['converge', 'finix'].includes(provider)) {
    return c.json({ error: 'Payment provider not configured for this merchant' }, 400)
  }

  const amountCents = purchase.total_cents
  const memo        = `Gift Card Purchase — ${purchase.customer_name}`

  try {
    let paymentUrl: string

    if (provider === 'converge') {
      const pin = await getAPIKey(merchant.id, 'payment', 'converge')
      if (!pin) return c.json({ error: 'Converge credentials not configured' }, 400)

      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'converge'`
        )
        .get(merchant.id)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      if (!posMerchantId.includes(':')) {
        return c.json({ error: 'Converge configuration incomplete' }, 400)
      }
      const convergeParts = posMerchantId.split(':')
      if (convergeParts.length !== 2 || convergeParts.some(p => !p.trim())) {
        return c.json({ error: 'Converge credentials misconfigured' }, 502)
      }
      const [sslMerchantId, sslUserId] = convergeParts
      const sandbox   = (merchant.converge_sandbox ?? 1) !== 0
      const amountStr = (amountCents / 100).toFixed(2)

      db.run(
        `UPDATE gift_card_purchases SET payment_provider = ? WHERE id = ?`,
        ['converge', purchaseId]
      )

      paymentUrl = await getConvergePaymentUrl(
        { sslMerchantId, sslUserId, sslPin: pin, sandbox },
        amountStr,
        absoluteReturnUrl,
        memo
      )
    } else {
      // Finix
      const apiPassword = await getAPIKey(merchant.id, 'payment', 'finix')
      if (!apiPassword) return c.json({ error: 'Finix credentials not configured' }, 400)

      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`
        )
        .get(merchant.id)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      const parts = posMerchantId.split(':')
      if (parts.length !== 3 || parts.some(p => !p.trim())) {
        return c.json({ error: 'Finix configuration incomplete' }, 400)
      }
      const [apiUsername, applicationId, finixMerchantId] = parts
      const sandbox = (merchant.finix_sandbox ?? 1) !== 0

      const nameParts  = (purchase.customer_name ?? '').trim().split(/\s+/)
      const firstName  = nameParts[0] || undefined
      const lastName   = nameParts.slice(1).join(' ') || undefined

      const finixReturnUrl =
        absoluteReturnUrl +
        (absoluteReturnUrl.includes('?') ? '&' : '?') +
        'provider=finix'

      const result = await createCheckoutForm(
        { apiUsername, applicationId, merchantId: finixMerchantId, apiPassword, sandbox },
        {
          amountCents,
          customerFirstName: firstName,
          customerLastName:  lastName,
          nickname:          `Gift Card — ${purchase.customer_name} · $${(amountCents / 100).toFixed(2)}`,
          returnUrl:         finixReturnUrl,
          cartReturnUrl:     requestOrigin,
          termsOfServiceUrl: `${requestOrigin}/payments-terms-of-service`,
          logoUrl:           merchant.logo_url ? `${requestOrigin.replace(/^http:/, 'https:')}${merchant.logo_url}` : undefined,
          idempotencyId:     `${purchaseId}-${Math.floor(Date.now() / (25 * 60 * 1000))}`,
          tags:              { purchase_id: purchaseId, merchant_id: merchant.id },
          fraudSessionId:    fraudSessionId || undefined,
        }
      )
      paymentUrl = result.linkUrl

      db.run(
        `UPDATE gift_card_purchases
         SET payment_provider = 'finix', payment_checkout_form_id = ?
         WHERE id = ?`,
        [result.checkoutFormId, purchaseId]
      )
    }

    return c.json({ paymentUrl })
  } catch (error) {
    return serverError(c, `[gift-cards] ${provider} payment session`, error, 'Failed to create payment session', 502)
  }
})

/**
 * POST /api/store/gift-cards/purchases/:id/payment-result
 *
 * Called after the payment provider redirect. Verifies the transaction,
 * issues one `gift_cards` row per card, generates the PDF, and emails
 * the card codes to the customer. Idempotent — uses a webhook lock to
 * prevent double-issuance on duplicate POST requests.
 *
 * @param body - Provider-specific result params (`ssl_result` for Converge,
 *   `checkout_form_id` for Finix)
 * @returns `{ success: true, cards: Array<{ code, balanceCents }> }`
 */
giftCards.post('/api/store/gift-cards/purchases/:id/payment-result', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const purchaseId = c.req.param('id')
  const db = getDatabase()

  const purchase = db
    .query<{
      id: string
      total_cents: number
      line_items_json: string
      customer_name: string
      customer_email: string
      recipient_name: string | null
      status: string
      payment_provider: string | null
      payment_checkout_form_id: string | null
    }, [string, string]>(
      `SELECT id, total_cents, line_items_json,
              customer_name, customer_email, recipient_name, status,
              payment_provider, payment_checkout_form_id
       FROM gift_card_purchases WHERE id = ? AND merchant_id = ?`
    )
    .get(purchaseId, merchant.id)

  if (!purchase) return c.json({ error: 'Purchase not found' }, 404)

  if (purchase.status === 'paid') {
    const cards = db
      .query<{ code: string; face_value_cents: number; expires_at: string }, [string]>(
        `SELECT code, face_value_cents, expires_at FROM gift_cards WHERE purchase_id = ?`
      )
      .all(purchaseId)
    return c.json({ status: 'paid', cards, customerEmail: purchase.customer_email })
  }

  if (purchase.status !== 'pending_payment') {
    return c.json({ error: 'Purchase is not awaiting payment' }, 409)
  }

  if (!acquireWebhookLock(purchaseId)) {
    return c.json({ error: 'Payment is already being processed' }, 409)
  }

  try {
    let body: {
      provider?: string
      ssl_result?: string
      ssl_approval_code?: string
      ssl_txn_id?: string
      ssl_amount?: string
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    // ── Finix verification ───────────────────────────────────────────────────
    if (body.provider === 'finix') {
      if (!purchase.payment_checkout_form_id) {
        return c.json({ error: 'No payment session — call /pay first' }, 400)
      }

      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`
        )
        .get(merchant.id)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      const parts = posMerchantId.split(':')
      if (parts.length !== 3) {
        return serverError(c, '[gift-cards] finix-config', new Error('pos_merchant_id format invalid'), 'Finix configuration incomplete')
      }
      const [apiUsername, applicationId, finixMerchantId] = parts
      const sandbox     = (merchant.finix_sandbox ?? 1) !== 0
      const apiPassword = await getAPIKey(merchant.id, 'payment', 'finix')
      if (!apiPassword) return serverError(c, '[gift-cards] finix-config', new Error('apiPassword not found'), 'Finix credentials not configured')

      const creds = { apiUsername, applicationId, merchantId: finixMerchantId, apiPassword, sandbox }

      let transferId: string | null = null
      let formState = 'UNKNOWN'
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await getTransferIdFromCheckoutForm(creds, purchase.payment_checkout_form_id)
          transferId = result.transferId
          formState  = result.state
        } catch (err) {
          return serverError(c, '[gift-cards] Finix verification', err, 'Payment verification failed — please retry', 502)
        }
        if (transferId) break
        if (formState === 'COMPLETED') break
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500))
      }

      if (!transferId && formState !== 'COMPLETED') {
        return c.json({ error: 'Payment not confirmed by processor' }, 402)
      }

      const confirmed = db.query<{ id: string }, [string | null, string]>(
        `UPDATE gift_card_purchases
         SET status = 'paid', payment_transfer_id = ?
         WHERE id = ? AND status = 'pending_payment'
         RETURNING id`
      ).get(transferId, purchaseId)

      if (!confirmed) {
        const cards = db
          .query<{ code: string; face_value_cents: number; expires_at: string }, [string]>(
            `SELECT code, face_value_cents, expires_at FROM gift_cards WHERE purchase_id = ?`
          )
          .all(purchaseId)
        return c.json({ status: 'paid', cards })
      }

    } else {
      // ── Converge verification ──────────────────────────────────────────────
      const sslResult = body.ssl_result
      const sslTxnId  = body.ssl_txn_id

      if (sslResult !== '0') {
        db.run(`UPDATE gift_card_purchases SET status = 'failed' WHERE id = ?`, [purchaseId])
        return c.json({ error: 'Payment was declined' }, 402)
      }

      // SEC: ssl_txn_id is mandatory — without it the transaction cannot be
      // verified or traced, and gift cards must not be issued.
      if (!sslTxnId) {
        return c.json({ error: 'ssl_txn_id is required' }, 400)
      }

      try {
        const pin = await getAPIKey(merchant.id, 'payment', 'converge')
        if (pin) {
          const keyRow = db
            .query<{ pos_merchant_id: string | null }, [string]>(
              `SELECT pos_merchant_id FROM api_keys
               WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'converge'`
            )
            .get(merchant.id)

          const posMerchantId = keyRow?.pos_merchant_id ?? ''
          const convergeParts = posMerchantId.split(':')
          if (convergeParts.length === 2) {
            const [sslMerchantId, sslUserId] = convergeParts
            const sandbox = (merchant.converge_sandbox ?? 1) !== 0
            const expectedAmount = (purchase.total_cents / 100).toFixed(2)
            await verifyConvergeTransaction(
              { sslMerchantId, sslUserId, sslPin: pin, sandbox },
              sslTxnId,
              expectedAmount
            )
          }
        }
      } catch (err) {
        console.error('[gift-cards] Converge re-verify failed:', err)
        return c.json({ error: 'Payment verification failed' }, 402)
      }

      const confirmed = db.query<{ id: string }, [string | null, string]>(
        `UPDATE gift_card_purchases
         SET status = 'paid', payment_transfer_id = ?
         WHERE id = ? AND status = 'pending_payment'
         RETURNING id`
      ).get(sslTxnId ?? null, purchaseId)

      if (!confirmed) {
        const cards = db
          .query<{ code: string; face_value_cents: number; expires_at: string }, [string]>(
            `SELECT code, face_value_cents, expires_at FROM gift_cards WHERE purchase_id = ?`
          )
          .all(purchaseId)
        return c.json({ status: 'paid', cards })
      }
    }

    // ── Issue cards ──────────────────────────────────────────────────────────
    // Expiry: 1 year from now
    const expiresAt = new Date()
    expiresAt.setFullYear(expiresAt.getFullYear() + 1)
    const expiresIso = expiresAt.toISOString()

    let lineItems: LineItem[] = []
    try {
      lineItems = JSON.parse(purchase.line_items_json)
    } catch {
      lineItems = []
    }

    const issuedCards: { code: string; face_value_cents: number; expires_at: string }[] = []

    for (const item of lineItems) {
      for (let i = 0; i < item.qty; i++) {
        const cardId = generateId('gc')
        const code   = generateUniqueCode(db)
        db.run(
          `INSERT INTO gift_cards
            (id, merchant_id, purchase_id, code, face_value_cents, balance_cents, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [cardId, merchant.id, purchaseId, code,
           item.denominationCents, item.denominationCents, expiresIso]
        )
        issuedCards.push({ code, face_value_cents: item.denominationCents, expires_at: expiresIso })
      }
    }

    // fire-and-forget: purchase already committed; email/print errors logged only
    sendGiftCardEmail(merchant, purchase, issuedCards).catch((err) => {
      console.error('[gift-cards] Email delivery failed:', err)
    })

    // fire-and-forget: purchase already committed; email/print errors logged only
    printGiftCardReceiptForPurchase(merchant.id, purchase, issuedCards).catch((err) => {
      console.error('[gift-cards] Receipt print failed:', err)
    })

    // ── Notify dashboard ──────────────────────────────────────────────────────
    broadcastToMerchant(merchant.id, 'gift_card_purchased', {
      purchaseId,
      customerName: purchase.customer_name,
      customerEmail: purchase.customer_email,
      totalCents: purchase.total_cents,
      cardCount: issuedCards.length,
    })

    return c.json({ status: 'paid', cards: issuedCards, customerEmail: purchase.customer_email })

  } finally {
    releaseLock(purchaseId)
  }
})

/**
 * GET /api/store/gift-cards/purchases/:id
 *
 * Returns the purchase status and, once confirmed, the list of issued card
 * codes with balances. Used by the gift card store to show the confirmation page.
 *
 * @param param.id - Purchase ID
 * @returns `{ status: 'pending'|'paid'|'failed', cards?: Array<{ code, balanceCents }> }`
 */
giftCards.get('/api/store/gift-cards/purchases/:id', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const purchaseId = c.req.param('id')
  const db = getDatabase()

  const purchase = db
    .query<{ id: string; total_cents: number; status: string }, [string, string]>(
      `SELECT id, total_cents, status
       FROM gift_card_purchases WHERE id = ? AND merchant_id = ?`
    )
    .get(purchaseId, merchant.id)

  if (!purchase) return c.json({ error: 'Purchase not found' }, 404)

  const cards =
    purchase.status === 'paid'
      ? db
          .query<{ code: string; face_value_cents: number; expires_at: string }, [string]>(
            `SELECT code, face_value_cents, expires_at FROM gift_cards WHERE purchase_id = ?`
          )
          .all(purchaseId)
      : []

  return c.json({ status: purchase.status, cards })
})

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------

async function sendGiftCardEmail(
  merchant: ApplianceMerchant,
  purchase: {
    customer_name: string
    customer_email: string
    recipient_name: string | null
    total_cents: number
    line_items_json: string
  },
  cards: Array<{ code: string; face_value_cents: number; expires_at: string }>
): Promise<void> {
  if (!merchant.receipt_email_from) {
    console.warn('[gift-cards] receipt_email_from not set — skipping email')
    return
  }

  const smtpProvider = merchant.smtp_provider ?? 'gmail'
  const appPassword = await getAPIKey(merchant.id, 'email', smtpProvider)
  if (!appPassword) {
    console.warn('[gift-cards] SMTP app password not set — skipping email')
    return
  }

  const smtpName = merchant.business_name.replace(/[\r\n]+/g, ' ').replace(/[\\"]/g, '\\$&')
  const totalStr = '$' + (purchase.total_cents / 100).toFixed(2)

  // Generate one PDF per card (individual attachments).
  // Map snake_case DB fields → camelCase expected by the PDF generator.
  const attachments: { filename: string; content: Buffer; contentType: string }[] = []
  for (const card of cards) {
    try {
      const pdfBuffer = await generateGiftCardPdf({
        cards: [{ code: card.code, faceValueCents: card.face_value_cents, expiresAt: card.expires_at }],
        purchaserName: purchase.customer_name,
        recipientName: purchase.recipient_name ?? null,
        businessName:  merchant.business_name,
        address:       merchant.address ?? null,
        phone:         merchant.phone_number ?? null,
        website:       merchant.website ?? null,
      })
      attachments.push({
        filename: `gift-card-${card.code}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      })
    } catch (err) {
      console.error(`[gift-cards] PDF generation failed for card ${card.code}:`, err)
    }
  }

  const transporter = buildSmtpTransport(smtpProvider, merchant.receipt_email_from, appPassword)

  await transporter.sendMail({
    from: `"${smtpName}" <${merchant.receipt_email_from}>`,
    to: purchase.customer_email,
    bcc: merchant.receipt_email_from,
    subject: `Your gift ${cards.length > 1 ? 'cards' : 'card'} from ${merchant.business_name}`,
    html: buildGiftCardEmailHtml({
      businessName: merchant.business_name,
      customerName: purchase.customer_name,
      recipientName: purchase.recipient_name ?? null,
      totalStr,
      cards,
    }),
    attachments,
  })

  console.log(`[gift-cards] Email sent to ${purchase.customer_email}, BCC ${merchant.receipt_email_from} — ${cards.length} card(s), ${attachments.length} PDF(s)`)
}

function buildGiftCardEmailHtml(opts: {
  businessName: string
  customerName: string
  recipientName: string | null
  totalStr: string
  cards: Array<{ code: string; face_value_cents: number; expires_at: string }>
}): string {
  const { businessName, customerName, recipientName, totalStr, cards } = opts

  const formatExpiry = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const formatCents = (c: number) => '$' + (c / 100).toFixed(2)

  const cardRows = cards.map((card) => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;">
        <span style="font-family:'Courier New',monospace;font-size:18px;font-weight:700;letter-spacing:0.15em;color:#111;">${esc(card.code)}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${esc(formatCents(card.face_value_cents))}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;text-align:right;color:#888;font-size:13px;">${esc(formatExpiry(card.expires_at))}</td>
    </tr>
  `).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Gift Card from ${esc(businessName)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
    <tr><td align="center" style="padding:24px 16px;">
      <table width="100%" style="max-width:520px;background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#111;padding:28px;text-align:center;">
          <p style="margin:0;font-size:22px;font-weight:bold;color:#fff;">${esc(businessName)}</p>
          <p style="margin:8px 0 0;font-size:14px;color:#aaa;">Gift Card Purchase Confirmed</p>
        </td></tr>
        <tr><td style="padding:24px 28px 16px;">
          <p style="margin:0 0 8px;">Hi <strong>${esc(customerName)}</strong>,</p>
          <p style="margin:0;color:#555;">Thank you for your gift card purchase from ${esc(businessName)}!${recipientName ? ` Your card${cards.length > 1 ? 's are' : ' is'} made out to <strong>${esc(recipientName)}</strong> and` : ` Your card${cards.length > 1 ? 's are' : ' is'}`} attached as a PDF and listed below.</p>
        </td></tr>
        <tr><td style="padding:0 28px 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;">
            <thead><tr style="background:#f9f9f9;">
              <th style="padding:10px 16px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Code</th>
              <th style="padding:10px 16px;text-align:right;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Value</th>
              <th style="padding:10px 16px;text-align:right;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Expires</th>
            </tr></thead>
            <tbody>${cardRows}</tbody>
          </table>
        </td></tr>
        <tr><td style="padding:0 28px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:8px 0;font-weight:bold;border-top:2px solid #111;">Total Paid</td>
              <td style="padding:8px 0;text-align:right;font-weight:bold;border-top:2px solid #111;">${esc(totalStr)}</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;background:#f9f9f9;border-top:1px solid #eee;">
          <p style="margin:0 0 8px;font-weight:600;font-size:13px;color:#333;">How to redeem</p>
          <p style="margin:0;font-size:13px;color:#666;">Present your card code when placing an order at ${esc(businessName)}. The full card value will be applied to your bill.</p>
        </td></tr>
        <tr><td style="padding:14px 28px;text-align:center;border-top:1px solid #eee;">
          <p style="margin:0;font-size:12px;color:#999;">Thank you for your support!</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

// ---------------------------------------------------------------------------
// Dashboard — list gift cards (authenticated staff)
// GET /api/merchants/:id/gift-cards
//   ?status=active|depleted|expired  (optional filter)
//   ?search=XXX-YYYY|email           (optional code or email substring)
//   ?limit=50&offset=0
// ---------------------------------------------------------------------------

interface GiftCardRow {
  id: string
  code: string
  face_value_cents: number
  balance_cents: number
  customer_name: string | null
  customer_email: string | null
  recipient_name: string | null
  status: string
  expires_at: string | null
  created_at: string
}

interface StatsRow {
  active: number
  depleted: number
  expired: number
  outstanding_cents: number
}

/**
 * GET /api/merchants/:id/gift-cards
 *
 * Lists the merchant's issued gift cards with optional filtering and pagination.
 * Also returns aggregate stats (active/depleted/expired counts, outstanding balance).
 *
 * @param query.status - Filter: `'active' | 'depleted' | 'expired'` (optional)
 * @param query.search - Partial code or email substring match (optional)
 * @param query.limit - Page size (default 50)
 * @param query.offset - Page offset (default 0)
 * @returns `{ cards: GiftCard[], stats: Stats, total: number }`
 */
giftCards.get(
  '/api/merchants/:id/gift-cards',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const db = getDatabase()

      const status = c.req.query('status') ?? ''
      const search = (c.req.query('search') ?? '').trim()
      const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200)
      const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)

      // Build WHERE clauses
      const conditions: string[] = ['gc.merchant_id = ?']
      const params: (string | number)[] = [merchantId]

      if (status && ['active', 'depleted', 'expired'].includes(status)) {
        conditions.push('gc.status = ?')
        params.push(status)
      }

      if (search) {
        conditions.push('(gc.code LIKE ? OR gcp.customer_email LIKE ?)')
        params.push(`%${search}%`, `%${search}%`)
      }

      const where = conditions.join(' AND ')

      const rows = db
        .query<GiftCardRow, (string | number)[]>(
          `SELECT gc.id, gc.code, gc.face_value_cents, gc.balance_cents,
                  gcp.customer_name, gcp.customer_email, gcp.recipient_name,
                  gc.status, gc.expires_at, gc.created_at
           FROM gift_cards gc
           LEFT JOIN gift_card_purchases gcp ON gc.purchase_id = gcp.id
           WHERE ${where}
           ORDER BY gc.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(...params, limit + 1, offset)

      const hasMore = rows.length > limit
      const slice = hasMore ? rows.slice(0, limit) : rows

      const giftCardsList = slice.map((r) => ({
        id: r.id,
        code: r.code,
        faceValueCents: r.face_value_cents,
        balanceCents: r.balance_cents,
        customerName: r.customer_name ?? '',
        customerEmail: r.customer_email ?? '',
        recipientName: r.recipient_name ?? '',
        status: r.status,
        expiresAt: r.expires_at ?? null,
        issuedAt: r.created_at,
      }))

      // Stats (only on first page load / reset)
      let stats: { active: number; depleted: number; expired: number; outstandingCents: number } | undefined
      if (offset === 0) {
        const statsRow = db
          .query<StatsRow, [string]>(
            `SELECT
               SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status = 'depleted' THEN 1 ELSE 0 END) AS depleted,
               SUM(CASE WHEN status = 'expired'  THEN 1 ELSE 0 END) AS expired,
               SUM(CASE WHEN status = 'active'   THEN balance_cents ELSE 0 END) AS outstanding_cents
             FROM gift_cards
             WHERE merchant_id = ?`
          )
          .get(merchantId)

        if (statsRow) {
          stats = {
            active: statsRow.active ?? 0,
            depleted: statsRow.depleted ?? 0,
            expired: statsRow.expired ?? 0,
            outstandingCents: statsRow.outstanding_cents ?? 0,
          }
        }
      }

      return c.json({ giftCards: giftCardsList, stats, hasMore })
    } catch (err) {
      return serverError(c, '[dashboard:gift-cards] list failed', err, 'Failed to load gift cards')
    }
  }
)

// ---------------------------------------------------------------------------
// Gift card receipt printing helpers
// ---------------------------------------------------------------------------

interface PrinterConfig {
  receipt_printer_ip: string | null
  printer_ip: string | null
  receipt_printer_protocol: string | null
  kitchen_printer_protocol: string | null
  receipt_style: string | null
  business_name: string
}

/**
 * Fetch the merchant's receipt printer config and print a gift card receipt.
 * Fire-and-forget — errors are logged, never thrown to callers.
 */
async function printGiftCardReceiptForPurchase(
  merchantId: string,
  purchase: { customer_name: string; recipient_name: string | null },
  cards: Array<{ code: string; face_value_cents: number; expires_at: string }>,
): Promise<void> {
  const db = getDatabase()
  const cfg = db
    .query<PrinterConfig, [string]>(
      `SELECT business_name, receipt_printer_ip, printer_ip,
              receipt_printer_protocol, kitchen_printer_protocol, receipt_style
       FROM merchants WHERE id = ?`
    )
    .get(merchantId)

  const receiptIp = cfg?.receipt_printer_ip || cfg?.printer_ip || null
  if (!receiptIp) {
    console.log('[gift-cards] No receipt printer configured — skipping auto-print')
    return
  }

  const protocol = (cfg?.receipt_printer_protocol ||
                    cfg?.kitchen_printer_protocol ||
                    'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'

  await printGiftCardReceipt({
    printerIp:    receiptIp,
    printerProtocol: protocol,
    merchantName: cfg!.business_name,
    cards: cards.map((c) => ({
      code:           c.code,
      faceValueCents: c.face_value_cents,
      balanceCents:   c.face_value_cents,  // balance equals face value at issuance
      expiresAt:      c.expires_at,
    })),
    purchaserName: purchase.customer_name,
    recipientName: purchase.recipient_name ?? null,
  })
  console.log(`[gift-cards] Gift card receipt printed to ${receiptIp}`)
}

// ---------------------------------------------------------------------------
// Dashboard — lookup gift card by code suffix (for payment flow)
// GET /api/merchants/:id/gift-cards/lookup?suffix=XYZ
// ---------------------------------------------------------------------------

interface LookupRow {
  id: string
  code: string
  face_value_cents: number
  balance_cents: number
  customer_name: string | null
}

/**
 * GET /api/merchants/:id/gift-cards/lookup
 *
 * Looks up an active gift card by its last-4 code suffix for use in the
 * payment modal split flow. Returns balance and card ID for redemption.
 *
 * @param query.suffix - Last 4 alphanumeric characters of the card code (the YYYY part)
 * @returns `{ cards: [{ id, maskedCode, faceValueCents, balanceCents, customerName, taxEmbeddedCents }] }` — empty array when no match (never 404)
 */
giftCards.get(
  '/api/merchants/:id/gift-cards/lookup',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const suffix = (c.req.query('suffix') ?? '').trim().toUpperCase()

      if (suffix.length !== 4 || !/^[A-Z0-9]+$/.test(suffix)) {
        return c.json({ error: 'Suffix must be exactly 4 alphanumeric characters' }, 400)
      }

      const db = getDatabase()
      const pattern = `%${suffix}`

      const rows = db
        .query<LookupRow, [string, string]>(
          `SELECT gc.id, gc.code, gc.face_value_cents, gc.balance_cents,
                  gcp.customer_name
           FROM gift_cards gc
           LEFT JOIN gift_card_purchases gcp ON gc.purchase_id = gcp.id
           WHERE gc.merchant_id = ?
             AND UPPER(gc.code) LIKE ?
             AND gc.status = 'active'
             AND gc.balance_cents > 0
             AND gc.expires_at > datetime('now')`
        )
        .all(merchantId, pattern)

      const cards = rows.map((r) => {
        const lastFour = r.code.slice(-4)
        const embeddedTax = r.face_value_cents - Math.round(r.face_value_cents / 1.104)
        return {
          id:                r.id,
          maskedCode:        `***-${lastFour}`,
          faceValueCents:    r.face_value_cents,
          balanceCents:      r.balance_cents,
          customerName:      r.customer_name ?? 'Unknown',
          taxEmbeddedCents:  embeddedTax,
        }
      })

      return c.json({ cards })
    } catch (err) {
      return serverError(c, '[dashboard:gift-cards] lookup failed', err, 'Lookup failed')
    }
  }
)

/**
 * POST /api/merchants/:id/gift-cards/:cardId/print-receipt
 *
 * Manually triggers a gift card receipt reprint to the configured printer.
 * Used from the dashboard gift-cards tab when a customer needs a reprint
 * (e.g. lost the email).
 *
 * @param param.cardId - Gift card ID to reprint
 * @returns `{ ok: true }` or error if no printer is configured
 */
giftCards.post(
  '/api/merchants/:id/gift-cards/:cardId/print-receipt',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const cardId     = c.req.param('cardId')
      const db         = getDatabase()

      const row = db
        .query<{
          code: string
          face_value_cents: number
          balance_cents: number
          expires_at: string
          customer_name: string | null
          recipient_name: string | null
          business_name: string
          receipt_printer_ip: string | null
          printer_ip: string | null
          receipt_printer_protocol: string | null
          kitchen_printer_protocol: string | null
        }, [string, string]>(
          `SELECT gc.code, gc.face_value_cents, gc.balance_cents, gc.expires_at,
                  gcp.customer_name, gcp.recipient_name,
                  m.business_name, m.receipt_printer_ip, m.printer_ip,
                  m.receipt_printer_protocol, m.kitchen_printer_protocol
           FROM gift_cards gc
           LEFT JOIN gift_card_purchases gcp ON gc.purchase_id = gcp.id
           JOIN merchants m ON m.id = gc.merchant_id
           WHERE gc.id = ? AND gc.merchant_id = ?`
        )
        .get(cardId, merchantId)

      if (!row) return c.json({ error: 'Gift card not found' }, 404)

      const receiptIp = row.receipt_printer_ip || row.printer_ip || null
      if (!receiptIp) return c.json({ error: 'No receipt printer configured' }, 422)

      const protocol = (row.receipt_printer_protocol ||
                        row.kitchen_printer_protocol ||
                        'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'

      await printGiftCardReceipt({
        printerIp:       receiptIp,
        printerProtocol: protocol,
        merchantName:    row.business_name,
        cards: [{
          code:           row.code,
          faceValueCents: row.face_value_cents,
          balanceCents:   row.balance_cents,
          expiresAt:      row.expires_at,
        }],
        purchaserName: row.customer_name ?? 'Unknown',
        recipientName: row.recipient_name ?? null,
      })

      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, '[dashboard:gift-cards] print-receipt failed', err, 'Print failed')
    }
  }
)

// ---------------------------------------------------------------------------
// Dashboard — list gift card purchases (for Online Orders tab)
// GET /api/merchants/:id/gift-card-purchases
// ---------------------------------------------------------------------------

/**
 * GET /api/merchants/:id/gift-card-purchases
 *
 * Returns paid gift card purchases in the given date range for the Online Orders tab.
 *
 * @param query.from - Unix timestamp ms (default: start of today)
 * @param query.to   - Unix timestamp ms (default: now)
 * @returns `{ purchases: GiftCardPurchaseSummary[] }`
 */
giftCards.get(
  '/api/merchants/:id/gift-card-purchases',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
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

      type PurchaseRow = {
        id: string
        customer_name: string
        customer_email: string
        recipient_name: string | null
        line_items_json: string
        total_cents: number
        net_revenue_cents: number
        tax_embedded_cents: number
        payment_provider: string | null
        payment_transfer_id: string | null
        status: string
        created_at: string
      }

      const rows = db
        .query<PurchaseRow, [string, string, string]>(
          `SELECT id, customer_name, customer_email, recipient_name,
                  line_items_json, total_cents, net_revenue_cents, tax_embedded_cents,
                  payment_provider, payment_transfer_id, status, created_at
           FROM gift_card_purchases
           WHERE merchant_id = ?
             AND status = 'paid'
             AND created_at >= ?
             AND created_at <= ?
           ORDER BY created_at DESC`
        )
        .all(merchantId, fromIso, toIso)

      const purchases = rows.map((r) => {
        let lineItems: { denominationCents: number; qty: number }[] = []
        try { lineItems = JSON.parse(r.line_items_json) } catch { /* ignore */ }
        return {
          id:                 r.id,
          customerName:       r.customer_name,
          customerEmail:      r.customer_email,
          recipientName:      r.recipient_name ?? null,
          lineItems,
          totalCents:         r.total_cents,
          netRevenueCents:    r.net_revenue_cents,
          taxEmbeddedCents:   r.tax_embedded_cents,
          paymentProvider:    r.payment_provider ?? null,
          paymentTransferId:  r.payment_transfer_id ?? null,
          status:             r.status,
          createdAt:          r.created_at,
        }
      })

      return c.json({ purchases })
    } catch (err) {
      return serverError(c, '[dashboard:gift-card-purchases] list failed', err, 'Failed to load gift card purchases')
    }
  }
)

/**
 * GET /api/merchants/:id/gift-card-purchases/:purchaseId
 *
 * Returns detail for a single gift card purchase. Used by the Payments tab detail modal.
 *
 * @returns `{ purchase: GiftCardPurchaseDetail, cards: { code, faceValueCents, balanceCents, status }[] }`
 */
giftCards.get(
  '/api/merchants/:id/gift-card-purchases/:purchaseId',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId  = c.req.param('id')
      const purchaseId  = c.req.param('purchaseId')
      const db = getDatabase()

      const row = db
        .query<{
          id: string; customer_name: string; customer_email: string; recipient_name: string | null
          line_items_json: string; total_cents: number; net_revenue_cents: number
          tax_embedded_cents: number; payment_provider: string | null
          payment_transfer_id: string | null; status: string; created_at: string
        }, [string, string]>(
          `SELECT id, customer_name, customer_email, recipient_name,
                  line_items_json, total_cents, net_revenue_cents, tax_embedded_cents,
                  payment_provider, payment_transfer_id, status, created_at
           FROM gift_card_purchases
           WHERE id = ? AND merchant_id = ?`
        )
        .get(purchaseId, merchantId)

      if (!row) return c.json({ error: 'Not found' }, 404)

      let lineItems: { denominationCents: number; qty: number }[] = []
      try { lineItems = JSON.parse(row.line_items_json) } catch { /* ignore */ }

      const cards = db
        .query<{ code: string; face_value_cents: number; balance_cents: number; status: string }, [string]>(
          `SELECT code, face_value_cents, balance_cents, status
           FROM gift_cards WHERE purchase_id = ?`
        )
        .all(purchaseId)

      return c.json({
        purchase: {
          id:                row.id,
          customerName:      row.customer_name,
          customerEmail:     row.customer_email,
          recipientName:     row.recipient_name ?? null,
          lineItems,
          totalCents:        row.total_cents,
          netRevenueCents:   row.net_revenue_cents,
          taxEmbeddedCents:  row.tax_embedded_cents,
          paymentProvider:   row.payment_provider ?? null,
          paymentTransferId: row.payment_transfer_id ?? null,
          status:            row.status,
          createdAt:         row.created_at,
        },
        cards: cards.map((gc) => ({
          code:           gc.code,
          faceValueCents: gc.face_value_cents,
          balanceCents:   gc.balance_cents,
          status:         gc.status,
        })),
      })
    } catch (err) {
      return serverError(c, '[dashboard:gift-card-purchases] detail failed', err, 'Failed to load purchase')
    }
  }
)

export { giftCards }
