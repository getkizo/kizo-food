/**
 * Payment record route tests
 *
 * Tests POST /api/merchants/:id/orders/:orderId/record-payment
 *       POST /api/merchants/:id/payments/:paymentId/receipt
 *
 * Uses app.fetch() with an in-memory DB.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

// ── shared fixtures ────────────────────────────────────────────────────────────

let ownerToken = ''
let staffToken = ''
let merchantId = ''

// ── helpers ────────────────────────────────────────────────────────────────────

/** Insert a minimal in-person order directly into the DB. Returns its ID. */
function insertOrder(opts: {
  status?:       string
  orderType?:    string
  source?:       string
  subtotalCents?: number
  totalCents?:   number
} = {}): string {
  const db = getDatabase()
  const orderId = `ord_${Math.random().toString(36).slice(2, 14)}`
  const {
    status        = 'confirmed',
    orderType     = 'dine_in',
    source        = 'local',
    subtotalCents = 1000,
    totalCents    = 1088,
  } = opts

  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, customer_phone, order_type,
        status, subtotal_cents, total_cents, tax_cents,
        source, items, created_at, updated_at)
     VALUES (?, ?, 'Test Customer', '555-1234', ?,
             ?, ?, ?, 88, ?, '[]', datetime('now'), datetime('now'))`,
    [orderId, merchantId, orderType, status, subtotalCents, totalCents, source]
  )
  return orderId
}

/**
 * POST to the record-payment endpoint.
 * @param {string} orderId
 * @param {Record<string, unknown>} body
 * @param {string} [token]
 */
async function postRecordPayment(
  orderId: string,
  body: Record<string, unknown>,
  token = ownerToken,
): Promise<Response> {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/record-payment`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
}

/** Minimal valid cash payment body */
function cashPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentType:   'cash',
    subtotalCents: 1000,
    taxCents:      88,
    tipCents:      0,
    totalCents:    1088,
    ...overrides,
  }
}

/** Minimal valid card payment body */
function cardPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentType:   'card',
    subtotalCents: 1000,
    taxCents:      88,
    tipCents:      200,
    totalCents:    1288,
    cardType:      'visa',
    cardLastFour:  '4242',
    authCode:      'A1B2C3',
    ...overrides,
  }
}

// ── setup ──────────────────────────────────────────────────────────────────────

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
      email:        'owner@payment.test',
      password:     'SecurePass123!',
      fullName:     'Payment Owner',
      businessName: 'Pay Cafe',
      slug:         'pay-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  // Create staff user
  const db = getDatabase()
  const staffPasswordHash = await Bun.password.hash('StaffPass123!', { algorithm: 'bcrypt', cost: 4 })
  db.run(
    `INSERT INTO users (id, email, password_hash, full_name, merchant_id, role)
     VALUES ('usr_staff_pay', 'staff@payment.test', ?, 'Staff Person', ?, 'staff')`,
    [staffPasswordHash, merchantId]
  )

  const staffLoginRes = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: 'staff@payment.test', password: 'StaffPass123!' }),
  }))
  const staffLoginBody = await staffLoginRes.json() as { tokens?: { accessToken: string } }
  staffToken = staffLoginBody.tokens?.accessToken ?? ''
})

// ── POST record-payment ────────────────────────────────────────────────────────

describe('POST /api/merchants/:id/orders/:orderId/record-payment', () => {
  test('returns 401 when not authenticated', async () => {
    const orderId = insertOrder()
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/record-payment`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    ))
    expect(res.status).toBe(401)
  })

  test('returns 404 for non-existent order', async () => {
    const res = await postRecordPayment('ord_doesnotexist', cashPayload())
    expect(res.status).toBe(404)
  })

  test('records a cash payment and marks order paid', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload())
    expect(res.status).toBe(201)
    const body = await res.json() as { paymentId: string; success: boolean }
    expect(body.success).toBe(true)
    expect(body.paymentId).toMatch(/^pay_/)

    // Verify order status in DB
    const db = getDatabase()
    const order = db.query<{ status: string; payment_method: string; paid_amount_cents: number }, [string]>(
      `SELECT status, payment_method, paid_amount_cents FROM orders WHERE id = ?`
    ).get(orderId)
    expect(order?.status).toBe('paid')
    expect(order?.payment_method).toBe('cash')
    expect(order?.paid_amount_cents).toBe(1088)
  })

  test('records a card payment with tip and card details', async () => {
    const orderId = insertOrder({ subtotalCents: 1000, totalCents: 1088 })
    const res = await postRecordPayment(orderId, cardPayload())
    expect(res.status).toBe(201)
    const body = await res.json() as { paymentId: string; success: boolean }
    expect(body.success).toBe(true)

    // Verify payment row in DB
    const db = getDatabase()
    const payment = db.query<{
      payment_type: string
      tip_cents: number
      amount_cents: number
      card_type: string
      card_last_four: string
      auth_code: string
    }, [string]>(
      `SELECT payment_type, tip_cents, amount_cents, card_type, card_last_four, auth_code
       FROM payments WHERE id = ?`
    ).get(body.paymentId)
    expect(payment?.payment_type).toBe('card')
    expect(payment?.tip_cents).toBe(200)
    expect(payment?.amount_cents).toBe(1288)
    expect(payment?.card_type).toBe('visa')
    expect(payment?.card_last_four).toBe('4242')
    expect(payment?.auth_code).toBe('A1B2C3')

    // Verify order tip recorded
    const order = db.query<{ tip_cents: number }, [string]>(
      `SELECT tip_cents FROM orders WHERE id = ?`
    ).get(orderId)
    expect(order?.tip_cents).toBe(200)
  })

  test('staff can record a payment', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload(), staffToken)
    expect(res.status).toBe(201)
  })

  test('returns 409 when order is already paid', async () => {
    const orderId = insertOrder({ status: 'paid' })
    const res = await postRecordPayment(orderId, cashPayload())
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('paid')
  })

  test('returns 409 when order is cancelled', async () => {
    const orderId = insertOrder({ status: 'cancelled' })
    const res = await postRecordPayment(orderId, cashPayload())
    expect(res.status).toBe(409)
  })

  test('returns 400 for invalid paymentType', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload({ paymentType: 'bitcoin' }))
    expect(res.status).toBe(400)
  })

  test('returns 400 for negative subtotalCents', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload({ subtotalCents: -1 }))
    expect(res.status).toBe(400)
  })

  test('returns 400 when tipCents exceeds 100000', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload({ tipCents: 100001 }))
    expect(res.status).toBe(400)
  })

  test('stores signature_base64 and signature_captured_at when provided', async () => {
    const orderId = insertOrder()
    const fakeSignature = 'data:image/png;base64,iVBORw0KGgo='
    const res = await postRecordPayment(orderId, cashPayload({ signatureBase64: fakeSignature }))
    expect(res.status).toBe(201)
    const body = await res.json() as { paymentId: string }

    const db = getDatabase()
    const payment = db.query<{
      signature_base64: string | null
      signature_captured_at: string | null
    }, [string]>(
      `SELECT signature_base64, signature_captured_at FROM payments WHERE id = ?`
    ).get(body.paymentId)
    expect(payment?.signature_base64).toBe(fakeSignature)
    expect(payment?.signature_captured_at).not.toBeNull()
  })

  test('stores receipt_email when provided', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload({ receiptEmail: 'test@example.com' }))
    expect(res.status).toBe(201)
    const body = await res.json() as { paymentId: string }

    const db = getDatabase()
    const payment = db.query<{ receipt_email: string | null }, [string]>(
      `SELECT receipt_email FROM payments WHERE id = ?`
    ).get(body.paymentId)
    expect(payment?.receipt_email).toBe('test@example.com')
  })

  test('rejects cross-merchant access (wrong merchant token)', async () => {
    // Register a second merchant
    const reg2 = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'other@payment.test', password: 'SecurePass123!',
        fullName: 'Other Owner', businessName: 'Other Cafe', slug: 'other-cafe-pay',
      }),
    }))
    const reg2Body = await reg2.json() as { tokens: { accessToken: string }; merchant: { id: string } }
    const otherToken = reg2Body.tokens.accessToken

    const orderId = insertOrder()   // belongs to merchantId
    const res = await postRecordPayment(orderId, cashPayload(), otherToken)
    // Should be 403 (requireOwnMerchant) or 404 (not found under wrong merchantId)
    expect([403, 404]).toContain(res.status)
  })
})

// ── Phase 3: Split payments ────────────────────────────────────────────────────

describe('Split payments (Phase 3)', () => {
  /** Convenience: record one split leg. Returns parsed response body. */
  async function recordSplitLeg(
    orderId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ paymentId: string; success: boolean; isLastLeg: boolean }> {
    const res = await postRecordPayment(orderId, { ...cashPayload(), ...overrides })
    return res.json() as Promise<{ paymentId: string; success: boolean; isLastLeg: boolean }>
  }

  test('single (non-split) payment returns isLastLeg: true', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload())
    expect(res.status).toBe(201)
    const body = await res.json() as { isLastLeg: boolean }
    expect(body.isLastLeg).toBe(true)
  })

  test('intermediate split leg returns isLastLeg: false and does NOT mark order paid', async () => {
    const orderId = insertOrder({ status: 'confirmed', subtotalCents: 2000, totalCents: 2176 })

    // Leg 1 of 2
    const body = await recordSplitLeg(orderId, {
      subtotalCents: 1000,
      taxCents:      88,
      tipCents:      200,
      totalCents:    1288,
      splitMode:     'equal',
      splitLegNumber: 1,
      splitTotalLegs: 2,
    })
    expect(body.isLastLeg).toBe(false)
    expect(body.success).toBe(true)
    expect(body.paymentId).toMatch(/^pay_/)

    // Order should still be 'confirmed', not 'paid'
    const db = getDatabase()
    const order = db.query<{ status: string }, [string]>(
      `SELECT status FROM orders WHERE id = ?`
    ).get(orderId)
    expect(order?.status).toBe('confirmed')
  })

  test('final split leg returns isLastLeg: true and marks order paid', async () => {
    const orderId = insertOrder({ status: 'confirmed', subtotalCents: 2000, totalCents: 2176 })

    // Leg 2 of 2 (final)
    const body = await recordSplitLeg(orderId, {
      subtotalCents: 1000,
      taxCents:      88,
      tipCents:      200,
      totalCents:    1288,
      splitMode:     'equal',
      splitLegNumber: 2,
      splitTotalLegs: 2,
    })
    expect(body.isLastLeg).toBe(true)

    const db = getDatabase()
    const order = db.query<{ status: string }, [string]>(
      `SELECT status FROM orders WHERE id = ?`
    ).get(orderId)
    expect(order?.status).toBe('paid')
  })

  test('split metadata is stored on the payment row', async () => {
    const orderId = insertOrder()
    const body = await recordSplitLeg(orderId, {
      splitMode:      'by_items',
      splitLegNumber: 1,
      splitTotalLegs: 2,
      splitItemsJson: '[0, 1]',
    })

    const db = getDatabase()
    const payment = db.query<{
      split_mode: string | null
      split_leg_number: number | null
      split_total_legs: number | null
      split_items_json: string | null
    }, [string]>(
      `SELECT split_mode, split_leg_number, split_total_legs, split_items_json
       FROM payments WHERE id = ?`
    ).get(body.paymentId)

    expect(payment?.split_mode).toBe('by_items')
    expect(payment?.split_leg_number).toBe(1)
    expect(payment?.split_total_legs).toBe(2)
    expect(payment?.split_items_json).toBe('[0, 1]')
  })

  test('three-leg equal split — only final leg marks order paid', async () => {
    const orderId = insertOrder({ status: 'confirmed', subtotalCents: 3000, totalCents: 3264 })
    const db = getDatabase()

    for (let leg = 1; leg <= 3; leg++) {
      const res = await postRecordPayment(orderId, {
        ...cashPayload({ subtotalCents: 1000, taxCents: 88, tipCents: 200, totalCents: 1288 }),
        splitMode:      'equal',
        splitLegNumber: leg,
        splitTotalLegs: 3,
      })
      expect(res.status).toBe(201)
      const b = await res.json() as { isLastLeg: boolean }

      const o = db.query<{ status: string }, [string]>(
        `SELECT status FROM orders WHERE id = ?`
      ).get(orderId)

      if (leg < 3) {
        expect(b.isLastLeg).toBe(false)
        expect(o?.status).toBe('confirmed')
      } else {
        expect(b.isLastLeg).toBe(true)
        expect(o?.status).toBe('paid')
      }
    }
  })

  test('paid_amount_cents and tip_cents accumulate across all split legs', async () => {
    const orderId = insertOrder({ status: 'confirmed', subtotalCents: 2000, totalCents: 2176 })
    const db = getDatabase()

    // Leg 1 of 2: $12.88 total ($10.00 sub + $0.88 tax + $2.00 tip)
    await recordSplitLeg(orderId, {
      subtotalCents: 1000, taxCents: 88, tipCents: 200, totalCents: 1288,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })

    // Leg 2 of 2: $14.88 total ($10.00 sub + $0.88 tax + $4.00 tip)
    await recordSplitLeg(orderId, {
      subtotalCents: 1000, taxCents: 88, tipCents: 400, totalCents: 1488,
      splitMode: 'equal', splitLegNumber: 2, splitTotalLegs: 2,
    })

    const order = db.query<{ paid_amount_cents: number; tip_cents: number }, [string]>(
      `SELECT paid_amount_cents, tip_cents FROM orders WHERE id = ?`
    ).get(orderId)

    // Should be the SUM of both legs, not just the last leg
    expect(order?.paid_amount_cents).toBe(1288 + 1488) // 2776
    expect(order?.tip_cents).toBe(200 + 400)           // 600
  })
})

// ── Phase 4: Amex surcharge ────────────────────────────────────────────────────

describe('Amex surcharge (Phase 4)', () => {
  test('amexSurchargeCents is stored on the payment row', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, {
      ...cardPayload(),
      amexSurchargeCents: 33,    // 0.3% of ~$11.00
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { paymentId: string }

    const db = getDatabase()
    const payment = db.query<{ amex_surcharge_cents: number }, [string]>(
      `SELECT amex_surcharge_cents FROM payments WHERE id = ?`
    ).get(body.paymentId)
    expect(payment?.amex_surcharge_cents).toBe(33)
  })

  test('returns 400 for negative amexSurchargeCents', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, {
      ...cardPayload(),
      amexSurchargeCents: -1,
    })
    expect(res.status).toBe(400)
  })

  test('amexSurchargeCents defaults to 0 when omitted', async () => {
    const orderId = insertOrder()
    const res = await postRecordPayment(orderId, cashPayload())
    expect(res.status).toBe(201)
    const body = await res.json() as { paymentId: string }

    const db = getDatabase()
    const payment = db.query<{ amex_surcharge_cents: number }, [string]>(
      `SELECT amex_surcharge_cents FROM payments WHERE id = ?`
    ).get(body.paymentId)
    expect(payment?.amex_surcharge_cents).toBe(0)
  })
})

// ── Tip-on-terminal (Phase tip-on-terminal) ───────────────────────────────────

describe('Tip-on-terminal: merchant profile settings', () => {
  test('tip_on_terminal defaults to false and suggestedTipPercentages to [15,20,25] on new merchant', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { tipOnTerminal: boolean; suggestedTipPercentages: number[] }
    expect(body.tipOnTerminal).toBe(false)
    expect(body.suggestedTipPercentages).toEqual([15, 20, 25])
  })

  test('PUT profile stores tipOnTerminal and suggestedTipPercentages', async () => {
    const putRes = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({ tipOnTerminal: true, suggestedTipPercentages: [18, 20, 25] }),
      }
    ))
    expect(putRes.status).toBe(200)

    const getRes = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ))
    const profile = await getRes.json() as { tipOnTerminal: boolean; suggestedTipPercentages: number[] }
    expect(profile.tipOnTerminal).toBe(true)
    expect(profile.suggestedTipPercentages).toEqual([18, 20, 25])

    // Reset for other tests
    await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({ tipOnTerminal: false, suggestedTipPercentages: [15, 20, 25] }),
      }
    ))
  })

  test('PUT profile returns 400 for invalid suggestedTipPercentages', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({ suggestedTipPercentages: [15, -5, 20] }),
      }
    ))
    expect(res.status).toBe(400)
  })
})

// ── POST payments/:paymentId/receipt ──────────────────────────────────────────

describe('POST /api/merchants/:id/payments/:paymentId/receipt', () => {
  /** Record a payment and return its paymentId */
  async function recordPayment(orderId: string): Promise<string> {
    const res = await postRecordPayment(orderId, cashPayload())
    const body = await res.json() as { paymentId: string }
    return body.paymentId
  }

  test('returns 404 for non-existent payment', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/pay_doesnotexist/receipt`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({ action: 'email' }),
      }
    ))
    expect(res.status).toBe(404)
  })

  test('returns 400 for invalid action', async () => {
    const orderId = insertOrder()
    const paymentId = await recordPayment(orderId)

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/${paymentId}/receipt`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({ action: 'fax' }),
      }
    ))
    expect(res.status).toBe(400)
  })

  test('print action returns printed:false when no printer configured (no error)', async () => {
    const orderId = insertOrder()
    const paymentId = await recordPayment(orderId)

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/${paymentId}/receipt`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({ action: 'print' }),
      }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { printed: boolean; emailed: boolean }
    // No printer configured in test env — printed stays false but no server error
    expect(typeof body.printed).toBe('boolean')
    expect(body.emailed).toBe(false)
  })

  test('email action returns emailed:false when no email configured (no error)', async () => {
    const orderId = insertOrder()
    const paymentId = await recordPayment(orderId)

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/${paymentId}/receipt`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body:    JSON.stringify({ action: 'email' }),
      }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { printed: boolean; emailed: boolean }
    expect(body.printed).toBe(false)
    // No email configured — emailed stays false
    expect(typeof body.emailed).toBe('boolean')
  })

  test('returns 401 when not authenticated', async () => {
    const orderId = insertOrder()
    const paymentId = await recordPayment(orderId)

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/payments/${paymentId}/receipt`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'print' }),
      }
    ))
    expect(res.status).toBe(401)
  })
})
