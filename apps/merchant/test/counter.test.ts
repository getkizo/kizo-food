/**
 * Counter route tests — focused on the counter_provider toggle.
 *
 * Covers:
 *  - GET /api/merchants/:id returns counterProvider='finix' by default
 *  - PUT /api/merchants/:id accepts counterProvider='clover' and 'finix'
 *  - PUT /api/merchants/:id ignores invalid counterProvider values
 *  - POST /counter/request-payment rejects `amountCents` when counter_provider='clover'
 *    (prevents the first leg of a split from silently paying the whole bill)
 *  - Explicit cloverFull/cloverLeg flags route to Clover regardless of toggle
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

let ownerToken = ''
let merchantId = ''

async function get(path: string, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }))
}

async function put(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

async function post(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@counter.test',
      password:     'SecurePass123!',
      fullName:     'Counter Owner',
      businessName: 'Counter Cafe',
      slug:         'counter-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id
})

// ── counterProvider on the merchant record ────────────────────────────────────

describe('counterProvider field on merchant', () => {
  test("defaults to 'finix' on a freshly registered merchant", async () => {
    const res  = await get(`/api/merchants/${merchantId}`)
    const body = await res.json() as { counterProvider?: string }
    expect(res.status).toBe(200)
    expect(body.counterProvider).toBe('finix')
  })

  test("accepts counterProvider='clover' via PUT", async () => {
    const res  = await put(`/api/merchants/${merchantId}`, { counterProvider: 'clover' })
    const body = await res.json() as { counterProvider: string }
    expect(res.status).toBe(200)
    expect(body.counterProvider).toBe('clover')
  })

  test("accepts counterProvider='finix' via PUT (toggle back)", async () => {
    const res  = await put(`/api/merchants/${merchantId}`, { counterProvider: 'finix' })
    const body = await res.json() as { counterProvider: string }
    expect(res.status).toBe(200)
    expect(body.counterProvider).toBe('finix')
  })

  test('ignores unknown counterProvider values while applying other valid fields', async () => {
    // Seed counter_provider='clover' so we can verify it survives the invalid PUT
    await put(`/api/merchants/${merchantId}`, { counterProvider: 'clover' })

    const res  = await put(`/api/merchants/${merchantId}`, {
      counterProvider: 'bogus',
      phoneNumber:     '555-0199',  // valid field keeps updates.length > 0
    })
    const body = await res.json() as { counterProvider: string; phoneNumber: string }
    expect(res.status).toBe(200)
    expect(body.counterProvider).toBe('clover')  // unchanged — invalid value ignored
    expect(body.phoneNumber).toBe('555-0199')
  })
})

// ── request-payment routing ────────────────────────────────────────────────────

describe("POST /counter/request-payment with counter_provider='clover'", () => {
  test('rejects amountCents-style request to prevent split-leg overcharge', async () => {
    await put(`/api/merchants/${merchantId}`, { counterProvider: 'clover' })

    const res  = await post(`/api/merchants/${merchantId}/counter/request-payment`, {
      orderId:     'order_test_split',
      amountCents: 2500,  // legacy D135 leg amount — must be refused under Clover
    })
    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toContain('cloverFull')
    expect(body.error).toContain('cloverLeg')
  })

  test("requires orderId regardless of counter_provider", async () => {
    await put(`/api/merchants/${merchantId}`, { counterProvider: 'clover' })

    const res  = await post(`/api/merchants/${merchantId}/counter/request-payment`, {
      amountCents: 1500,
    })
    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toBe('orderId is required')
  })
})

describe('POST /counter/request-payment with explicit Clover flags', () => {
  test("cloverFull:true is honoured even when counter_provider='finix'", async () => {
    await put(`/api/merchants/${merchantId}`, { counterProvider: 'finix' })

    const res  = await post(`/api/merchants/${merchantId}/counter/request-payment`, {
      orderId:    'order_test_full',
      cloverFull: true,
    })
    const body = await res.json() as { error?: string; success?: boolean }

    // In the test env Clover env vars are absent → 503 "not configured".
    // What matters is that it did NOT fall through to the D135 path
    // (which would have returned 400 "amountCents must be a positive number").
    expect(res.status).toBe(503)
    expect(body.error).toContain('Clover')
  })

  test("cloverLeg is honoured even when counter_provider='finix'", async () => {
    await put(`/api/merchants/${merchantId}`, { counterProvider: 'finix' })

    const res  = await post(`/api/merchants/${merchantId}/counter/request-payment`, {
      orderId:   'order_test_leg',
      cloverLeg: {
        legSubtotalCents:   1000,
        legTaxCents:         100,
        serviceChargeCents:    0,
        legNumber:             1,
        totalLegs:             2,
        splitMode:        'equal',
      },
    })
    const body = await res.json() as { error?: string }

    expect(res.status).toBe(503)
    expect(body.error).toContain('Clover')
  })
})
