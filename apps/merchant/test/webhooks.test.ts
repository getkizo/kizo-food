/**
 * Webhook routes integration tests
 *
 * Covers:
 *   GET  /webhooks/health
 *   POST /webhooks/generic/:merchantId  — HMAC verification, 401 when no secret
 *   POST /webhooks/stax/:merchantId     — success/failure event storage
 *   GET  /api/merchants/:id/payment-notifications
 *   PATCH /api/merchants/:id/payment-notifications/:eventId/dismiss
 *   POST /api/merchants/:id/webhooks/clover — HMAC verify / no-secret pass-through
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { createHmac } from 'node:crypto'

let ownerToken  = ''
let merchantId  = ''

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  const res  = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'owner@webhooks.test',
      password:     'SecurePass123!',
      fullName:     'Webhook Owner',
      businessName: 'Webhook Cafe',
      slug:         'webhook-cafe',
    }),
  }))
  const body  = await res.json()
  ownerToken  = body.tokens.accessToken
  merchantId  = body.merchant.id
})

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe('GET /webhooks/health', () => {
  test('returns 200 { status: "ok" }', async () => {
    const res  = await app.fetch(new Request('http://localhost:3000/webhooks/health'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Generic webhook — no secret configured
// ---------------------------------------------------------------------------

describe('POST /webhooks/generic/:merchantId — no secret', () => {
  test('returns 401 when merchant has no webhook secret configured', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/webhooks/generic/${merchantId}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ event: 'test', data: {} }),
      },
    ))
    expect(res.status).toBe(401)
  })

  test('returns 404 for unknown merchantId', async () => {
    const res = await app.fetch(new Request(
      'http://localhost:3000/webhooks/generic/merch_does_not_exist',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ event: 'test' }),
      },
    ))
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Generic webhook — with secret configured
// ---------------------------------------------------------------------------

describe('POST /webhooks/generic/:merchantId — HMAC verification', () => {
  let webhookSecret = ''

  beforeAll(async () => {
    // Configure a webhook secret via the API
    const secretRes = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/webhook/secret`,
      { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    const secretBody = await secretRes.json()
    webhookSecret = secretBody.secret
  })

  function sign(secret: string, body: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  }

  test('valid HMAC → 200 received: true', async () => {
    const payload = JSON.stringify({ event: 'order_created', orderId: 'ord_123' })
    const sig     = sign(webhookSecret, payload)

    const res  = await app.fetch(new Request(
      `http://localhost:3000/webhooks/generic/${merchantId}`,
      {
        method:  'POST',
        headers: {
          'Content-Type':        'application/json',
          'x-webhook-signature': sig,
        },
        body: payload,
      },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.received).toBe(true)
  })

  test('invalid HMAC → 401', async () => {
    const payload = JSON.stringify({ event: 'order_created' })

    const res = await app.fetch(new Request(
      `http://localhost:3000/webhooks/generic/${merchantId}`,
      {
        method:  'POST',
        headers: {
          'Content-Type':        'application/json',
          'x-webhook-signature': 'sha256=deadbeef',
        },
        body: payload,
      },
    ))
    expect(res.status).toBe(401)
  })

  test('missing HMAC header → 401 (invalid signature)', async () => {
    const payload = JSON.stringify({ event: 'test' })

    const res = await app.fetch(new Request(
      `http://localhost:3000/webhooks/generic/${merchantId}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    payload,
      },
    ))
    expect(res.status).toBe(401)
  })

  test('stale timestamp header → 401', async () => {
    const payload   = JSON.stringify({ event: 'test' })
    const staleTime = new Date(Date.now() - 10 * 60_000).toISOString() // 10 min ago
    // Sign with timestamp included in HMAC input
    const hmacInput = `${staleTime}.${payload}`
    const sig       = sign(webhookSecret, hmacInput)

    const res = await app.fetch(new Request(
      `http://localhost:3000/webhooks/generic/${merchantId}`,
      {
        method:  'POST',
        headers: {
          'Content-Type':        'application/json',
          'x-webhook-signature': sig,
          'x-webhook-timestamp': staleTime,
        },
        body: payload,
      },
    ))
    expect(res.status).toBe(401)
  })

  test('payload stored in webhook_events after valid request', async () => {
    const payload = JSON.stringify({ event: 'pos_sync', items: 5 })
    const sig     = sign(webhookSecret, payload)

    await app.fetch(new Request(
      `http://localhost:3000/webhooks/generic/${merchantId}`,
      {
        method:  'POST',
        headers: {
          'Content-Type':        'application/json',
          'x-webhook-signature': sig,
        },
        body: payload,
      },
    ))

    const db  = getDatabase()
    const row = db.query<{ webhook_type: string }, [string]>(
      `SELECT webhook_type FROM webhook_events
       WHERE merchant_id = ? AND webhook_type = 'generic' ORDER BY rowid DESC LIMIT 1`,
    ).get(merchantId)
    expect(row?.webhook_type).toBe('generic')
  })
})

// ---------------------------------------------------------------------------
// Stax webhook
// ---------------------------------------------------------------------------

describe('POST /webhooks/stax/:merchantId', () => {
  test('success event → stax_payment_success row stored', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/webhooks/stax/${merchantId}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'stax-event-name': 'create_transaction' },
        body:    JSON.stringify({ id: 'txn_001', total: 25.00, success: true }),
      },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.received).toBe(true)

    const db  = getDatabase()
    const row = db.query<{ webhook_type: string }, [string]>(
      `SELECT webhook_type FROM webhook_events
       WHERE merchant_id = ? AND webhook_type = 'stax_payment_success' ORDER BY rowid DESC LIMIT 1`,
    ).get(merchantId)
    expect(row?.webhook_type).toBe('stax_payment_success')
  })

  test('failure event → stax_payment_failed row stored', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/webhooks/stax/${merchantId}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'stax-event-name': 'create_transaction' },
        body:    JSON.stringify({ id: 'txn_002', total: 18.50, success: false }),
      },
    ))
    expect(res.status).toBe(200)

    const db  = getDatabase()
    const row = db.query<{ webhook_type: string }, [string]>(
      `SELECT webhook_type FROM webhook_events
       WHERE merchant_id = ? AND webhook_type = 'stax_payment_failed' ORDER BY rowid DESC LIMIT 1`,
    ).get(merchantId)
    expect(row?.webhook_type).toBe('stax_payment_failed')
  })
})

// ---------------------------------------------------------------------------
// Payment notifications
// ---------------------------------------------------------------------------

describe('GET /api/merchants/:id/payment-notifications', () => {
  test('returns notifications array', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payment-notifications`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.notifications)).toBe(true)
  })

  test('requires authentication → 401', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payment-notifications`,
    ))
    expect(res.status).toBe(401)
  })
})

describe('PATCH /api/merchants/:id/payment-notifications/:eventId/dismiss', () => {
  test('marks notification as dismissed → { ok: true }', async () => {
    // Seed a failure notification directly
    const db = getDatabase()
    const id = `we_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO webhook_events (id, merchant_id, webhook_type, payload, processed, received_at)
       VALUES (?, ?, 'stax_payment_failed', '{"total":10.00}', 0, datetime('now'))`,
      [id, merchantId],
    )

    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payment-notifications/${id}/dismiss`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    const row = db.query<{ processed: number }, [string]>(
      `SELECT processed FROM webhook_events WHERE id = ?`,
    ).get(id)
    expect(row?.processed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Clover webhook
// ---------------------------------------------------------------------------

describe('POST /api/merchants/:id/webhooks/clover', () => {
  test('no CLOVER_WEBHOOK_SECRET set → 200 received: true', async () => {
    const saved = process.env.CLOVER_WEBHOOK_SECRET
    delete process.env.CLOVER_WEBHOOK_SECRET

    try {
      const res  = await app.fetch(new Request(
        `http://localhost:3000/api/merchants/${merchantId}/webhooks/clover`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type: 'PAYMENT_UPDATE', merchantId }),
        },
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.received).toBe(true)
    } finally {
      if (saved !== undefined) process.env.CLOVER_WEBHOOK_SECRET = saved
    }
  })

  test('CLOVER_WEBHOOK_SECRET set + valid HMAC → 200', async () => {
    process.env.CLOVER_WEBHOOK_SECRET = 'test-clover-secret-key'
    const payload = JSON.stringify({ type: 'PAYMENT_UPDATE' })
    const sig     = 'sha256=' + createHmac('sha256', 'test-clover-secret-key').update(payload).digest('hex')

    try {
      const res  = await app.fetch(new Request(
        `http://localhost:3000/api/merchants/${merchantId}/webhooks/clover`,
        {
          method:  'POST',
          headers: {
            'Content-Type':          'application/json',
            'x-clover-authorization': sig,
          },
          body: payload,
        },
      ))
      expect(res.status).toBe(200)
    } finally {
      delete process.env.CLOVER_WEBHOOK_SECRET
    }
  })

  test('CLOVER_WEBHOOK_SECRET set + invalid HMAC → 401', async () => {
    process.env.CLOVER_WEBHOOK_SECRET = 'test-clover-secret-key'

    try {
      const res = await app.fetch(new Request(
        `http://localhost:3000/api/merchants/${merchantId}/webhooks/clover`,
        {
          method:  'POST',
          headers: {
            'Content-Type':          'application/json',
            'x-clover-authorization': 'sha256=badhash',
          },
          body: JSON.stringify({ type: 'PAYMENT_UPDATE' }),
        },
      ))
      expect(res.status).toBe(401)
    } finally {
      delete process.env.CLOVER_WEBHOOK_SECRET
    }
  })
})
