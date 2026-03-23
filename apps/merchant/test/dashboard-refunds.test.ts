/**
 * Dashboard refund route tests
 *
 * Tests POST /api/merchants/:id/orders/:orderId/refunds and
 *       GET  /api/merchants/:id/orders/:orderId/refunds
 *
 * Uses app.fetch() with an in-memory DB. Orders are inserted directly into the
 * DB to avoid store-API merchant-resolution complexity.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

// ── shared fixtures ───────────────────────────────────────────────────────────

let ownerToken  = ''
let staffToken  = ''
let merchantId  = ''

// ── helpers ───────────────────────────────────────────────────────────────────

/** Insert a minimal order directly into the DB. Returns its ID. */
function insertOrder(opts: {
  status?:          string
  paymentMethod?:   string | null
  paidAmountCents?: number
  taxCents?:        number
  totalCents?:      number
} = {}): string {
  const db = getDatabase()
  const orderId = `ord_${Math.random().toString(36).slice(2, 14)}`
  const {
    status          = 'paid',
    paymentMethod   = 'cash',
    paidAmountCents = 900,
    taxCents        = 75,
    totalCents      = 900,
  } = opts

  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, customer_phone, order_type,
        status, subtotal_cents, total_cents, paid_amount_cents, tax_cents,
        payment_method, items, created_at, updated_at)
     VALUES (?, ?, 'Test Customer', '555-1234', 'pickup',
             ?, 900, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))`,
    [orderId, merchantId, status, totalCents, paidAmountCents, taxCents, paymentMethod]
  )
  return orderId
}

/** POST to the refund endpoint with a given token (defaults to owner). */
async function postRefund(
  orderId: string,
  body: Record<string, unknown>,
  token = ownerToken,
): Promise<Response> {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/refunds`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
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

  // Register merchant + owner
  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@refunds.test',
      password:     'SecurePass123!',
      fullName:     'Refund Owner',
      businessName: 'Refund Cafe',
      slug:         'refund-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  // Create a staff user directly in the DB (avoids creating a second merchant)
  const db = getDatabase()
  const staffPasswordHash = await Bun.password.hash('StaffPass123!', { algorithm: 'bcrypt', cost: 4 })
  db.run(
    `INSERT INTO users (id, email, password_hash, full_name, merchant_id, role)
     VALUES ('usr_staff_test', 'staff@refunds.test', ?, 'Staff Person', ?, 'staff')`,
    [staffPasswordHash, merchantId]
  )

  const staffLoginRes = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: 'staff@refunds.test', password: 'StaffPass123!' }),
  }))
  const staffLoginBody = await staffLoginRes.json() as { tokens?: { accessToken: string } }
  staffToken = staffLoginBody.tokens?.accessToken ?? ''
})

// ── GET refunds ───────────────────────────────────────────────────────────────

describe('GET /api/merchants/:id/orders/:orderId/refunds', () => {
  test('returns empty refunds list for an unrefunded order', async () => {
    const orderId = insertOrder()

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/refunds`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { refunds: unknown[] }
    expect(body.refunds).toEqual([])
  })

  test('returns 401 when not authenticated', async () => {
    const orderId = insertOrder()
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/refunds`
    ))
    expect(res.status).toBe(401)
  })

  test('returns recorded refunds in chronological order', async () => {
    const orderId = insertOrder({ paidAmountCents: 900 })
    // Insert both refunds directly to avoid the 30-second deduplication guard
    const db = getDatabase()
    db.run(
      `INSERT INTO refunds (id, order_id, merchant_id, type, refund_amount_cents, tax_refunded_cents, items_json, refunded_by_name, created_at)
       VALUES (?, ?, ?, 'partial', 200, 18, '[]', 'Owner', datetime('now', '-60 seconds'))`,
      [`ref_test1_${orderId}`, orderId, merchantId]
    )
    db.run(
      `INSERT INTO refunds (id, order_id, merchant_id, type, refund_amount_cents, tax_refunded_cents, items_json, refunded_by_name, created_at)
       VALUES (?, ?, ?, 'partial', 150, 12, '[]', 'Owner', datetime('now', '-30 seconds'))`,
      [`ref_test2_${orderId}`, orderId, merchantId]
    )

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/refunds`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ))
    const body = await res.json() as { refunds: Array<Record<string, unknown>> }
    expect(body.refunds.length).toBe(2)
    expect(body.refunds[0].refundAmountCents).toBe(200)
    expect(body.refunds[1].refundAmountCents).toBe(150)
  })
})

// ── POST refunds — full cash refund ─────────────────────────────────────────

describe('POST /api/merchants/:id/orders/:orderId/refunds — full refund', () => {
  test('processes a full cash refund and marks order as refunded', async () => {
    const orderId = insertOrder({ paidAmountCents: 900, taxCents: 75 })

    const res = await postRefund(orderId, { type: 'full' })
    expect(res.status).toBe(201)

    const body = await res.json() as { refund: Record<string, unknown> }
    expect(body.refund.type).toBe('full')
    expect(body.refund.refundAmountCents).toBe(900)
    expect(body.refund.taxRefundedCents).toBe(75)
    expect(body.refund.processorRefunded).toBe(false)
    expect(typeof body.refund.id).toBe('string')

    // Order status should be updated to 'refunded'
    const db = getDatabase()
    const order = db.query<{ status: string }, [string]>(
      'SELECT status FROM orders WHERE id = ?'
    ).get(orderId)
    expect(order?.status).toBe('refunded')
  })

  test('full refund on pre-migration order falls back to total_cents', async () => {
    // paid_amount_cents = 0 triggers the fallback to total_cents = 900
    const orderId = insertOrder({ paidAmountCents: 0, totalCents: 900 })

    const res = await postRefund(orderId, { type: 'full' })
    expect(res.status).toBe(201)
    const body = await res.json() as { refund: Record<string, unknown> }
    expect(body.refund.refundAmountCents).toBe(900)
  })

  test('second full refund after first is blocked', async () => {
    const orderId = insertOrder()
    await postRefund(orderId, { type: 'full' })

    const res = await postRefund(orderId, { type: 'full' })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('already been fully refunded')
  })

  test('stores notes on refund record', async () => {
    const orderId = insertOrder()
    const res = await postRefund(orderId, { type: 'full', notes: 'Customer complaint' })
    expect(res.status).toBe(201)
    const body = await res.json() as { refund: Record<string, unknown> }
    expect(body.refund.notes).toBe('Customer complaint')
  })
})

// ── POST refunds — partial refund ────────────────────────────────────────────

describe('POST /api/merchants/:id/orders/:orderId/refunds — partial refund', () => {
  test('processes a partial cash refund without changing order status', async () => {
    const orderId = insertOrder({ paidAmountCents: 900 })

    const res = await postRefund(orderId, {
      type:  'partial',
      items: [{ itemIndex: 0, dishName: 'Latte', quantity: 1, amountCents: 450, taxCents: 38 }],
    })
    expect(res.status).toBe(201)

    const body = await res.json() as { refund: Record<string, unknown> }
    expect(body.refund.type).toBe('partial')
    expect(body.refund.refundAmountCents).toBe(450)
    expect(body.refund.taxRefundedCents).toBe(38)

    // Order status remains 'paid' after partial refund
    const db = getDatabase()
    const order = db.query<{ status: string }, [string]>(
      'SELECT status FROM orders WHERE id = ?'
    ).get(orderId)
    expect(order?.status).toBe('paid')
  })

  test('second partial refund respects already-refunded balance', async () => {
    const orderId = insertOrder({ paidAmountCents: 900 })

    // Insert first refund directly to avoid the 30-second deduplication guard
    const db2 = getDatabase()
    db2.run(
      `INSERT INTO refunds (id, order_id, merchant_id, type, refund_amount_cents, tax_refunded_cents, items_json, refunded_by_name, created_at)
       VALUES (?, ?, ?, 'partial', 450, 0, '[]', 'Owner', datetime('now', '-60 seconds'))`,
      [`ref_seed_${orderId}`, orderId, merchantId]
    )

    // 600 exceeds remaining 450 — should fail
    const res2 = await postRefund(orderId, {
      type:  'partial',
      items: [{ itemIndex: 1, dishName: 'Cookie', quantity: 1, amountCents: 600, taxCents: 0 }],
    })
    expect(res2.status).toBe(422)

    // Exactly remaining 450 should succeed
    const res3 = await postRefund(orderId, {
      type:  'partial',
      items: [{ itemIndex: 1, dishName: 'Cookie', quantity: 1, amountCents: 450, taxCents: 0 }],
    })
    expect(res3.status).toBe(201)
  })
})

// ── POST refunds — validation errors ─────────────────────────────────────────

describe('POST /api/merchants/:id/orders/:orderId/refunds — validation', () => {
  test('returns 422 when order has no payment method', async () => {
    const orderId = insertOrder({ paymentMethod: null, paidAmountCents: 0 })

    const res = await postRefund(orderId, { type: 'full' })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('not been paid')
  })

  test('returns 400 for invalid refund type', async () => {
    const orderId = insertOrder()
    const res = await postRefund(orderId, { type: 'invalid' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('"full" or "partial"')
  })

  test('returns 400 for partial refund without items', async () => {
    const orderId = insertOrder()
    const res = await postRefund(orderId, { type: 'partial', items: [] })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('items are required')
  })

  test('returns 422 when partial amount exceeds remaining balance', async () => {
    const orderId = insertOrder({ paidAmountCents: 900 })
    const res = await postRefund(orderId, {
      type:  'partial',
      items: [{ itemIndex: 0, dishName: 'X', quantity: 1, amountCents: 9999, taxCents: 0 }],
    })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('exceeds remaining refundable balance')
  })

  test('returns 404 for unknown order', async () => {
    const res = await postRefund('ord_does_not_exist', { type: 'full' })
    expect(res.status).toBe(404)
  })

  test('returns 401 when not authenticated', async () => {
    const orderId = insertOrder()
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/refunds`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'full' }),
      }
    ))
    expect(res.status).toBe(401)
  })
})

// ── POST refunds — staff role ─────────────────────────────────────────────────

describe('POST /api/merchants/:id/orders/:orderId/refunds — staff role', () => {
  test('blocks staff refund when staff_can_refund = 0 (default)', async () => {
    const orderId = insertOrder()
    const res = await postRefund(orderId, { type: 'full' }, staffToken)
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('managers and owners')
  })

  test('allows staff refund when staff_can_refund = 1', async () => {
    const db = getDatabase()
    db.run(`UPDATE merchants SET staff_can_refund = 1 WHERE id = ?`, [merchantId])

    const orderId = insertOrder()
    const res = await postRefund(orderId, { type: 'full' }, staffToken)
    expect(res.status).toBe(201)

    db.run(`UPDATE merchants SET staff_can_refund = 0 WHERE id = ?`, [merchantId])
  })
})
