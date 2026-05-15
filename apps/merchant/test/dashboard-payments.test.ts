/**
 * Dashboard payments integration tests
 *
 * Covers GET /reconciliation (date filter, invalid range) and split validation
 * edge cases (splitLegNumber/splitTotalLegs out of range).
 *
 * Split happy-path and Amex surcharge are already covered in payment-record.test.ts.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { signJWT, verifyJWT } from '../src/utils/jwt'

let ownerToken  = ''
let merchantId  = ''
let userId      = ''
let orderId     = ''

function makeToken(role: 'owner' | 'manager' | 'staff'): string {
  return signJWT({ sub: userId, type: 'access', role, merchantId }, 86_400)
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
    body:    JSON.stringify({
      email:        'owner@dashpay.test',
      password:     'SecurePass123!',
      fullName:     'DashPay Owner',
      businessName: 'DashPay Cafe',
      slug:         'dashpay-cafe',
    }),
  }))
  const regBody  = await regRes.json()
  ownerToken     = regBody.tokens.accessToken
  merchantId     = regBody.merchant.id
  userId         = verifyJWT(ownerToken).sub

  // Seed a confirmed order directly in the DB for record-payment tests
  const db = getDatabase()
  orderId = `ord_dashpay_${Math.random().toString(36).slice(2, 10)}`
  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, customer_phone, order_type,
        status, subtotal_cents, total_cents, tax_cents,
        source, items, created_at, updated_at)
     VALUES (?, ?, 'Test Customer', '555-1234', 'dine_in',
             'confirmed', 1000, 1080, 80, 'local', '[]', datetime('now'), datetime('now'))`,
    [orderId, merchantId],
  )
})

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/payments/reconciliation
// ---------------------------------------------------------------------------

describe('GET /api/merchants/:id/payments/reconciliation', () => {
  test('no params → 200 with { payments, summary }', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/reconciliation`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.payments)).toBe(true)
    expect(typeof body.summary).toBe('object')
    expect(typeof body.summary.total).toBe('number')
  })

  test('valid from/to range → 200', async () => {
    const from = Date.now() - 24 * 60 * 60 * 1000 // 24h ago
    const to   = Date.now()
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/reconciliation?from=${from}&to=${to}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
  })

  test('from > to → 400 Invalid from/to range', async () => {
    const from = Date.now()
    const to   = Date.now() - 1000
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/reconciliation?from=${from}&to=${to}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid from\/to range/i)
  })

  test('manager token is allowed → 200', async () => {
    const managerToken = makeToken('manager')
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/reconciliation`,
      { headers: { Authorization: `Bearer ${managerToken}` } },
    ))
    expect(res.status).toBe(200)
  })

  test('staff token is allowed → 200', async () => {
    const staffToken = makeToken('staff')
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/reconciliation`,
      { headers: { Authorization: `Bearer ${staffToken}` } },
    ))
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// POST record-payment — split validation edge cases
// ---------------------------------------------------------------------------

describe('POST record-payment — split validation', () => {
  test('splitLegNumber = 0 → 400', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/record-payment`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({
          paymentType:    'cash',
          amountCents:    1080,
          subtotalCents:  1000,
          taxCents:       80,
          tipCents:       0,
          totalCents:     1080,
          splitMode:      'custom',
          splitLegNumber: 0,
          splitTotalLegs: 2,
        }),
      },
    ))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/splitLegNumber/i)
  })

  test('splitTotalLegs = 1 → 400', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/record-payment`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({
          paymentType:    'cash',
          amountCents:    1080,
          subtotalCents:  1000,
          taxCents:       80,
          tipCents:       0,
          totalCents:     1080,
          splitMode:      'custom',
          splitLegNumber: 1,
          splitTotalLegs: 1,
        }),
      },
    ))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/splitTotalLegs/i)
  })

  test('splitLegNumber > splitTotalLegs → 400', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/record-payment`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({
          paymentType:    'cash',
          amountCents:    1080,
          subtotalCents:  1000,
          taxCents:       80,
          tipCents:       0,
          totalCents:     1080,
          splitMode:      'custom',
          splitLegNumber: 3,
          splitTotalLegs: 2,
        }),
      },
    ))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/splitLegNumber/i)
  })
})
