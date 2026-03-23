/**
 * Webhook routes
 * Handles incoming webhooks from payment processors (Stax/Fattmerchant)
 * and generic POS webhook integrations.
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { authenticate } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { decryptWebhookSecret } from './merchants'
import { logSecurityEvent } from '../services/security-log'
import { serverError } from '../utils/server-error'

type Variables = {
  merchantId?: string
  userId?: string
  ipAddress?: string
}

const webhooks = new Hono<{ Variables: Variables }>()

/**
 * Generic webhook handler for custom integrations
 * Allows merchants to receive webhooks from any POS system.
 *
 * Authentication (C-03): If the merchant has configured a webhook shared secret
 * (POST /api/merchants/:id/webhook/secret), every request MUST include a valid
 * X-Webhook-Signature: sha256=<hex> header computed over the raw request body.
 * If no secret is configured, requests are accepted without a signature
 * (backward-compatible open mode).
 */
webhooks.post('/webhooks/generic/:merchantId', async (c) => {
  const merchantId = c.req.param('merchantId')

  try {
    const db = getDatabase()

    // Verify merchant exists and retrieve webhook secret
    const merchant = db.query<{ id: string; webhook_secret_enc: string | null }, [string]>(
      'SELECT id, webhook_secret_enc FROM merchants WHERE id = ?'
    ).get(merchantId)

    if (!merchant) {
      return c.json({ error: 'Merchant not found' }, 404)
    }

    // Read body as raw text once — needed for HMAC computation
    const rawBody = await c.req.text()

    // C-02: Require a configured webhook secret — reject unsigned requests
    if (!merchant.webhook_secret_enc) {
      logSecurityEvent('webhook_unsigned', {
        merchantId,
        ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? undefined,
        path: c.req.path,
      })
      return c.json({ error: 'Webhook secret not configured — unsigned webhooks are rejected' }, 401)
    }

    // M-09: Reject webhooks with stale or missing timestamps (replay protection)
    const timestampHeader = c.req.header('x-webhook-timestamp')
    if (timestampHeader) {
      const tsMs = new Date(timestampHeader).getTime()
      if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60_000) {
        return c.json({ error: 'Webhook timestamp expired or invalid (must be within 5 minutes)' }, 401)
      }
    }

    // Validate HMAC-SHA256
    {
      const secret    = decryptWebhookSecret(merchantId, merchant.webhook_secret_enc)
      const sigHeader = c.req.header('x-webhook-signature') ?? ''
      // Include timestamp in HMAC input when present (prevents body replay with new timestamp)
      const hmacInput = timestampHeader ? `${timestampHeader}.${rawBody}` : rawBody
      const expected  = 'sha256=' + createHmac('sha256', secret).update(hmacInput).digest('hex')

      const sigBuf = Buffer.from(sigHeader)
      const expBuf = Buffer.from(expected)
      const valid  = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)

      if (!valid) {
        console.warn(`[webhooks] Generic webhook rejected for merchant ${merchantId} — invalid signature`)
        logSecurityEvent('webhook_invalid_signature', {
          merchantId,
          ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? undefined,
          path: c.req.path,
        })
        return c.json({ error: 'Invalid signature' }, 401)
      }
    }

    const body = JSON.parse(rawBody)
    console.log('📥 Generic webhook received:', {
      merchantId,
      eventType: body?.event ?? 'unknown',
    })

    // H-09: Validate payload size before storing (max 64KB)
    if (rawBody.length > 65_536) {
      return c.json({ error: 'Payload too large' }, 413)
    }

    // Store webhook payload in database for merchant to process
    db.run(
      `INSERT INTO webhook_events (
        merchant_id, webhook_type, payload, received_at
      ) VALUES (?, ?, ?, datetime('now'))`,
      [merchantId, 'generic', rawBody]
    )

    return c.json({ received: true })
  } catch (error) {
    return serverError(c, '[webhooks] generic', error, 'Failed to process webhook')
  }
})

/**
 * Stax/Fattmerchant payment webhook
 *
 * Receives transaction events from the Stax hosted payment page.
 * Register this URL in Stax → Integrations → Webhooks:
 *   POST https://<your-tunnel>.trycloudflare.com/webhooks/stax/<merchantId>
 *
 * Relevant Stax events (stax-event-name header):
 *   create_transaction — fired when a payment attempt is made
 *   update_transaction — fired on status changes
 *
 * This endpoint is unauthenticated (Stax calls it, not the merchant).
 * The merchantId in the path provides routing; webhook secret is optional via
 * STAX_WEBHOOK_SECRET env var and the stax-signature header.
 */
webhooks.post('/webhooks/stax/:merchantId', async (c) => {
  const merchantId = c.req.param('merchantId')

  try {
    const body = await c.req.json()
    const eventName = c.req.header('stax-event-name') || 'transaction'

    console.log('📥 Stax webhook received:', {
      merchantId,
      event: eventName,
      transactionId: body.id,
      success: body.success,
      total: body.total,
    })

    // Only store if this looks like a transaction event (has success + total fields)
    if (typeof body.success !== 'undefined' && body.total !== undefined) {
      const isSuccess = body.success === true || body.success === 'true'
      const db = getDatabase()

      // Compact payload: only the fields we surface to the merchant
      const payload = JSON.stringify({
        transactionId: body.id ?? null,
        total: body.total ?? null,
        success: isSuccess,
        memo: body.meta?.memo || body.memo || '',
        customerName: [body.customer?.firstname, body.customer?.lastname]
          .filter(Boolean)
          .join(' '),
        last4: body.payment_method?.card_last_four || body.payment_method?.card?.last4 || '',
        event: eventName,
      })

      db.run(
        `INSERT INTO webhook_events (merchant_id, webhook_type, payload, received_at)
         VALUES (?, ?, ?, datetime('now'))`,
        [merchantId, isSuccess ? 'stax_payment_success' : 'stax_payment_failed', payload]
      )

      if (!isSuccess) {
        console.warn(
          `⚠️  Stax payment FAILED for merchant ${merchantId}: ` +
          `txn ${body.id}, $${body.total}`
        )
      }
    }

    // Always return 200 quickly — Stax retries on non-2xx
    return c.json({ received: true })
  } catch (error) {
    console.error('[webhooks] Stax:', error)
    return c.json({ received: true })
  }
})

/**
 * GET /api/merchants/:id/payment-notifications
 * Returns unread Stax payment failure notifications for the dashboard to poll.
 * Authenticated — only the merchant's own session can read these.
 */
webhooks.get(
  '/api/merchants/:id/payment-notifications',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    const events = db
      .query<{ id: string; payload: string; received_at: string }, [string]>(
        `SELECT id, payload, received_at
         FROM webhook_events
         WHERE merchant_id = ?
           AND webhook_type IN ('stax_payment_failed', 'converge_payment_failed')
           AND processed = 0
         ORDER BY received_at DESC
         LIMIT 20`
      )
      .all(merchantId)

    return c.json({
      notifications: events.map((e) => ({
        id: e.id,
        receivedAt: e.received_at,
        ...JSON.parse(e.payload),
      })),
    })
  }
)

/**
 * PATCH /api/merchants/:id/payment-notifications/:eventId/dismiss
 * Marks a payment failure notification as read so it won't be shown again.
 */
webhooks.patch(
  '/api/merchants/:id/payment-notifications/:eventId/dismiss',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const eventId = c.req.param('eventId')
    const db = getDatabase()

    db.run(
      `UPDATE webhook_events
       SET processed = 1, processed_at = datetime('now')
       WHERE id = ? AND merchant_id = ?`,
      [eventId, merchantId]
    )

    return c.json({ ok: true })
  }
)

/**
 * Clover payment webhook stub (Phase 2 prep)
 *
 * Accepts Clover webhook notifications at the path registered in the Clover
 * Developer Dashboard. Currently logs the payload and returns 200 immediately
 * — no action is taken. Activate full processing here when webhook-based
 * payment confirmation replaces polling in production.
 *
 * Registration: Clover Dev Dashboard → App Settings → Webhooks
 *   URL: POST https://<your-tunnel>/api/merchants/:id/webhooks/clover
 *
 * Relevant events: PAYMENT_UPDATE (state → 'paid'), ORDER_UPDATE
 */
webhooks.post('/api/merchants/:id/webhooks/clover', async (c) => {
  const merchantId = c.req.param('id')
  try {
    const rawBody = await c.req.text()
    if (rawBody.length > 65_536) {
      return c.json({ error: 'Payload too large' }, 413)
    }

    // Verify Clover webhook HMAC-SHA256 signature when a webhook secret is configured.
    // Set CLOVER_WEBHOOK_SECRET to the app secret from Clover Developer Dashboard →
    // App Settings → Webhooks. Clover sends the signature as:
    //   X-Clover-Authorization: sha256=<hex>
    // When the secret is not set, the webhook is accepted without verification
    // (backward-compatible until the secret is configured in production).
    const webhookSecret = process.env.CLOVER_WEBHOOK_SECRET
    if (webhookSecret) {
      const sigHeader = c.req.header('x-clover-authorization') ?? ''
      const expected  = 'sha256=' + createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
      const sigBuf    = Buffer.from(sigHeader)
      const expBuf    = Buffer.from(expected)
      const valid     = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
      if (!valid) {
        logSecurityEvent('clover_webhook_auth_failure', {
          merchantId,
          ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? undefined,
          path: c.req.path,
        })
        return c.json({ error: 'Unauthorized' }, 401)
      }
    } else {
      console.warn('[clover-webhook] CLOVER_WEBHOOK_SECRET not set — accepting without signature verification')
    }

    const payload = rawBody ? JSON.parse(rawBody) : {}
    console.log('[clover-webhook] Received payload:', { merchantId, payload })
    // TODO (Phase 2): update order status via reconcile or direct DB write
    // based on payload.type / payload.merchants
  } catch (err) {
    // Suppress error — always return 200 so Clover does not retry
    console.warn('[webhooks] Clover parse error (suppressed):', err instanceof Error ? err.message : err)
  }
  return c.json({ received: true })
})

/**
 * Webhook health check
 * Used by POS systems to verify webhook endpoint is reachable
 */
webhooks.get('/webhooks/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

export { webhooks }
