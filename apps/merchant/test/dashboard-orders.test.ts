/**
 * Dashboard orders route tests
 *
 * Covers:
 *   PATCH /api/merchants/:id/orders/:orderId/status
 *   PATCH /api/merchants/:id/orders/:orderId/discount
 *   PATCH /api/merchants/:id/orders/:orderId/service-charge
 *
 * Uses app.fetch() with an in-memory DB. Orders are inserted directly to
 * avoid store-API merchant-resolution complexity.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

// ── shared fixtures ───────────────────────────────────────────────────────────

let ownerToken = ''
let merchantId = ''

// ── helpers ───────────────────────────────────────────────────────────────────

/** Insert a minimal order into the DB. Returns its ID. */
function insertOrder(opts: {
  status?:         string
  orderType?:      string
  subtotalCents?:  number
  totalCents?:     number
  taxCents?:       number
  discountCents?:  number
  source?:         string
} = {}): string {
  const db = getDatabase()
  const orderId = `ord_${Math.random().toString(36).slice(2, 14)}`
  const {
    status        = 'received',
    orderType     = 'pickup',
    subtotalCents = 1000,
    totalCents    = 1080,
    taxCents      = 80,
    discountCents = 0,
    source        = 'dashboard',
  } = opts

  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, order_type, status, source,
        subtotal_cents, total_cents, tax_cents, discount_cents,
        items, created_at, updated_at)
     VALUES (?, ?, 'Test Customer', ?, ?, ?,
             ?, ?, ?, ?,
             '[]', datetime('now'), datetime('now'))`,
    [orderId, merchantId, orderType, status, source,
     subtotalCents, totalCents, taxCents, discountCents]
  )
  return orderId
}

/** PATCH the order status endpoint. */
async function patchStatus(
  orderId: string,
  body:    Record<string, unknown>,
  token =  ownerToken,
): Promise<Response> {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/status`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
}

/** PATCH the discount endpoint. */
async function patchDiscount(
  orderId: string,
  body:    Record<string, unknown>,
  token =  ownerToken,
): Promise<Response> {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/discount`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
}

/** PATCH the service-charge endpoint. */
async function patchServiceCharge(
  orderId: string,
  body:    Record<string, unknown>,
  token =  ownerToken,
): Promise<Response> {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/service-charge`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
}

// ── setup ─────────────────────────────────────────────────────────────────────

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
      email:        'owner@orders.test',
      password:     'SecurePass123!',
      fullName:     'Orders Owner',
      businessName: 'Orders Cafe',
      slug:         'orders-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  // Set a known tax rate so discount/service-charge tax recalculation is deterministic
  const db = getDatabase()
  db.run(`UPDATE merchants SET tax_rate = 0.10 WHERE id = ?`, [merchantId])
})

// ── PATCH /status ─────────────────────────────────────────────────────────────

describe('PATCH /api/merchants/:id/orders/:orderId/status', () => {

  test('submitted → confirmed succeeds', async () => {
    const orderId = insertOrder({ status: 'submitted' })
    const res = await patchStatus(orderId, { status: 'confirmed' })
    expect(res.status).toBe(200)
    const body = await res.json() as { orderId: string; status: string }
    expect(body.status).toBe('confirmed')
    expect(body.orderId).toBe(orderId)
  })

  test('confirmed → preparing stores estimated_ready_at when estimatedMinutes provided', async () => {
    const orderId = insertOrder({ status: 'confirmed' })
    const res = await patchStatus(orderId, { status: 'preparing', estimatedMinutes: 20 })
    expect(res.status).toBe(200)

    const db = getDatabase()
    const row = db
      .query<{ estimated_ready_at: string | null }, [string]>(
        `SELECT estimated_ready_at FROM orders WHERE id = ?`
      )
      .get(orderId)
    expect(row?.estimated_ready_at).not.toBeNull()
  })

  test('confirmed → ready succeeds', async () => {
    const orderId = insertOrder({ status: 'confirmed' })
    const res = await patchStatus(orderId, { status: 'ready' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('ready')
  })

  test('confirmed → cancelled succeeds', async () => {
    const orderId = insertOrder({ status: 'confirmed' })
    const res = await patchStatus(orderId, { status: 'cancelled' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('cancelled')
  })

  test('preparing → ready succeeds', async () => {
    const orderId = insertOrder({ status: 'preparing' })
    const res = await patchStatus(orderId, { status: 'ready' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('ready')
  })

  test('ready → picked_up succeeds (online order collected)', async () => {
    const orderId = insertOrder({ status: 'ready' })
    const res = await patchStatus(orderId, { status: 'picked_up' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('picked_up')
  })

  test('ready → completed is rejected (no longer a valid transition)', async () => {
    const orderId = insertOrder({ status: 'ready' })
    const res = await patchStatus(orderId, { status: 'completed' })
    expect(res.status).toBe(400)
  })

  test('received → paid stores payment fields', async () => {
    const orderId = insertOrder({ status: 'received' })
    const res = await patchStatus(orderId, {
      status:          'paid',
      paidAmountCents: 1080,
      tipCents:        150,
      paymentMethod:   'cash',
    })
    expect(res.status).toBe(200)

    const db = getDatabase()
    const row = db
      .query<{ paid_amount_cents: number; tip_cents: number; payment_method: string }, [string]>(
        `SELECT paid_amount_cents, tip_cents, payment_method FROM orders WHERE id = ?`
      )
      .get(orderId)
    expect(row?.paid_amount_cents).toBe(1080)
    expect(row?.tip_cents).toBe(150)
    expect(row?.payment_method).toBe('cash')
  })

  test('confirmed → submitted returns 422 (invalid transition)', async () => {
    const orderId = insertOrder({ status: 'confirmed' })
    const res = await patchStatus(orderId, { status: 'submitted' })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Cannot transition')
  })

  test('paid → cancelled returns 422 (terminal status)', async () => {
    const orderId = insertOrder({ status: 'paid' })
    const res = await patchStatus(orderId, { status: 'cancelled' })
    expect(res.status).toBe(422)
  })

  test('cancelled → any returns 422 (terminal status)', async () => {
    const orderId = insertOrder({ status: 'cancelled' })
    const res = await patchStatus(orderId, { status: 'confirmed' })
    expect(res.status).toBe(422)
  })

  test('unknown status returns 400', async () => {
    const orderId = insertOrder({ status: 'received' })
    const res = await patchStatus(orderId, { status: 'foobar' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Invalid status')
  })

  test('non-existent order returns 404', async () => {
    const res = await patchStatus('ord_doesnotexist', { status: 'confirmed' })
    expect(res.status).toBe(404)
  })

  test('returns 401 when unauthenticated', async () => {
    const orderId = insertOrder({ status: 'received' })
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/status`,
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'confirmed' }),
      }
    ))
    expect(res.status).toBe(401)
  })

  test('pending_payment → cancelled succeeds', async () => {
    const orderId = insertOrder({ status: 'pending_payment' })
    const res = await patchStatus(orderId, { status: 'cancelled' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('cancelled')
  })
})

// ── PATCH /discount ───────────────────────────────────────────────────────────

describe('PATCH /api/merchants/:id/orders/:orderId/discount', () => {

  test('applies discount and recalculates tax and total', async () => {
    // subtotal=1000, tax_rate=10% → no discount: tax=100, total=1100
    // with discount=200: taxable=800, tax=80, total=880
    const orderId = insertOrder({ status: 'received', subtotalCents: 1000 })
    const res = await patchDiscount(orderId, { discountCents: 200, discountLabel: 'Staff' })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      ok: boolean; discountCents: number; discountLabel: string; taxCents: number; totalCents: number
    }
    expect(body.ok).toBe(true)
    expect(body.discountCents).toBe(200)
    expect(body.discountLabel).toBe('Staff')
    expect(body.taxCents).toBe(80)       // (1000-200) * 0.10
    expect(body.totalCents).toBe(880)    // 1000-200+80
  })

  test('removes discount when discountCents=0', async () => {
    const orderId = insertOrder({ status: 'confirmed', subtotalCents: 1000, discountCents: 200 })
    const res = await patchDiscount(orderId, { discountCents: 0 })
    expect(res.status).toBe(200)
    const body = await res.json() as { discountCents: number; taxCents: number; totalCents: number }
    expect(body.discountCents).toBe(0)
    expect(body.taxCents).toBe(100)   // 1000 * 0.10
    expect(body.totalCents).toBe(1100)
  })

  test('discount exceeding subtotal returns 400', async () => {
    const orderId = insertOrder({ status: 'received', subtotalCents: 500 })
    const res = await patchDiscount(orderId, { discountCents: 600 })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('exceed')
  })

  test('negative discountCents returns 400', async () => {
    const orderId = insertOrder({ status: 'received' })
    const res = await patchDiscount(orderId, { discountCents: -50 })
    expect(res.status).toBe(400)
  })

  test('discount on paid order returns 409', async () => {
    const orderId = insertOrder({ status: 'paid' })
    const res = await patchDiscount(orderId, { discountCents: 100 })
    expect(res.status).toBe(409)
  })

  test('discount on cancelled order returns 409', async () => {
    const orderId = insertOrder({ status: 'cancelled' })
    const res = await patchDiscount(orderId, { discountCents: 100 })
    expect(res.status).toBe(409)
  })

  test('discount on submitted order returns 409', async () => {
    const orderId = insertOrder({ status: 'submitted' })
    const res = await patchDiscount(orderId, { discountCents: 100 })
    expect(res.status).toBe(409)
  })

  test('non-existent order returns 404', async () => {
    const res = await patchDiscount('ord_doesnotexist', { discountCents: 100 })
    expect(res.status).toBe(404)
  })
})

// ── PATCH /service-charge ─────────────────────────────────────────────────────

describe('PATCH /api/merchants/:id/orders/:orderId/service-charge', () => {

  test('applies service charge on dine_in order and recalculates tax and total', async () => {
    // subtotal=2000, tax_rate=10%
    // with service_charge=300: taxable=2000+300=2300, tax=230, total=2530
    const orderId = insertOrder({ status: 'received', orderType: 'dine_in', subtotalCents: 2000 })
    const res = await patchServiceCharge(orderId, {
      serviceChargeCents: 300,
      serviceChargeLabel: 'Gratuity 18%',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      ok: boolean; serviceChargeCents: number; serviceChargeLabel: string; taxCents: number; totalCents: number
    }
    expect(body.ok).toBe(true)
    expect(body.serviceChargeCents).toBe(300)
    expect(body.serviceChargeLabel).toBe('Gratuity 18%')
    expect(body.taxCents).toBe(230)     // (2000+300) * 0.10
    expect(body.totalCents).toBe(2530)  // 2000+300+230
  })

  test('removes service charge when serviceChargeCents=0', async () => {
    const orderId = insertOrder({ status: 'confirmed', orderType: 'dine_in', subtotalCents: 2000 })
    const res = await patchServiceCharge(orderId, { serviceChargeCents: 0 })
    expect(res.status).toBe(200)
    const body = await res.json() as { serviceChargeCents: number; taxCents: number; totalCents: number }
    expect(body.serviceChargeCents).toBe(0)
    expect(body.taxCents).toBe(200)    // 2000 * 0.10
    expect(body.totalCents).toBe(2200)
  })

  test('service charge on pickup order returns 400', async () => {
    const orderId = insertOrder({ status: 'received', orderType: 'pickup' })
    const res = await patchServiceCharge(orderId, { serviceChargeCents: 200 })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('dine-in')
  })

  test('service charge on delivery order returns 400', async () => {
    const orderId = insertOrder({ status: 'received', orderType: 'delivery' })
    const res = await patchServiceCharge(orderId, { serviceChargeCents: 200 })
    expect(res.status).toBe(400)
  })

  test('negative serviceChargeCents returns 400', async () => {
    const orderId = insertOrder({ status: 'received', orderType: 'dine_in' })
    const res = await patchServiceCharge(orderId, { serviceChargeCents: -100 })
    expect(res.status).toBe(400)
  })

  test('service charge on paid order returns 409', async () => {
    const orderId = insertOrder({ status: 'paid', orderType: 'dine_in' })
    const res = await patchServiceCharge(orderId, { serviceChargeCents: 200 })
    expect(res.status).toBe(409)
  })

  test('service charge on cancelled order returns 409', async () => {
    const orderId = insertOrder({ status: 'cancelled', orderType: 'dine_in' })
    const res = await patchServiceCharge(orderId, { serviceChargeCents: 200 })
    expect(res.status).toBe(409)
  })

  test('non-existent order returns 404', async () => {
    const res = await patchServiceCharge('ord_doesnotexist', { serviceChargeCents: 200 })
    expect(res.status).toBe(404)
  })
})

// ── PATCH /api/merchants/:id/orders/:orderId — edit items ────────────────────

/** PATCH the main items-edit endpoint. */
async function patchOrderItems(
  orderId: string,
  body:    Record<string, unknown>,
  token =  ownerToken,
): Promise<Response> {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    },
  ))
}

describe('PATCH /api/merchants/:id/orders/:orderId — edit items on unfinalized orders', () => {

  test('recomputes tax and total from new subtotal (preserves merchant tax_rate)', async () => {
    // Order starts with subtotal $10, tax $1 (10%), total $11.
    const orderId = insertOrder({ status: 'received', subtotalCents: 1000, taxCents: 100, totalCents: 1100 })

    const res = await patchOrderItems(orderId, {
      items: [
        { itemId: 'A', name: 'Thing', priceCents: 1500, quantity: 1 },
        { itemId: 'B', name: 'Side',  priceCents: 300,  quantity: 2 },
      ],
    })
    expect(res.status).toBe(200)

    const row = getDatabase()
      .query<{ subtotal_cents: number; tax_cents: number; total_cents: number; status: string }, [string]>(
        `SELECT subtotal_cents, tax_cents, total_cents, status FROM orders WHERE id = ?`,
      )
      .get(orderId)

    // Subtotal = 1500 + 2*300 = 2100. Tax at 10% = 210. Total = 2310.
    expect(row?.subtotal_cents).toBe(2100)
    expect(row?.tax_cents).toBe(210)
    expect(row?.total_cents).toBe(2310)
    expect(row?.status).toBe('received')   // still received, not demoted
  })

  test('respects discount + service charge in tax base and total', async () => {
    // $10 subtotal - $2 discount + $1 service charge = $9 taxed base.
    const orderId = insertOrder({ status: 'received', subtotalCents: 1000, discountCents: 200, totalCents: 1000 })
    getDatabase().run(`UPDATE orders SET service_charge_cents = 100, tip_cents = 300 WHERE id = ?`, [orderId])

    // Change items to subtotal $20.
    const res = await patchOrderItems(orderId, {
      items: [{ itemId: 'X', name: 'Item', priceCents: 2000, quantity: 1 }],
    })
    expect(res.status).toBe(200)

    const row = getDatabase()
      .query<{ subtotal_cents: number; tax_cents: number; total_cents: number }, [string]>(
        `SELECT subtotal_cents, tax_cents, total_cents FROM orders WHERE id = ?`,
      )
      .get(orderId)
    // taxedBase = 2000 - 200 + 100 = 1900; tax@10% = 190; total = 1900 + 190 + 300(tip) = 2390.
    expect(row?.subtotal_cents).toBe(2000)
    expect(row?.tax_cents).toBe(190)
    expect(row?.total_cents).toBe(2390)
  })
})

describe('PATCH /api/merchants/:id/orders/:orderId — refuses finalized orders', () => {

  for (const finalStatus of ['paid', 'completed', 'cancelled', 'refunded', 'picked_up']) {
    test(`${finalStatus} order returns 409 and does not mutate`, async () => {
      const orderId = insertOrder({ status: finalStatus, subtotalCents: 2500, taxCents: 260, totalCents: 2760 })
      // Seed with items the edit would overwrite.
      getDatabase().run(
        `UPDATE orders SET items = '[{"dishName":"Prik Khing","quantity":1}]' WHERE id = ?`,
        [orderId],
      )
      const beforeSubtotal = 2500
      const beforeTax      = 260
      const beforeTotal    = 2760

      const res = await patchOrderItems(orderId, {
        items: [{ itemId: 'EVIL', name: 'Pineapple Fried Rice', priceCents: 2500, quantity: 1 }],
      })
      expect(res.status).toBe(409)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(new RegExp(finalStatus))
      expect(body.error).toMatch(/new order/i)

      // DB unchanged — status, items, subtotal, tax, total all intact.
      const row = getDatabase()
        .query<{ status: string; subtotal_cents: number; tax_cents: number; total_cents: number; items: string }, [string]>(
          `SELECT status, subtotal_cents, tax_cents, total_cents, items FROM orders WHERE id = ?`,
        )
        .get(orderId)
      expect(row?.status).toBe(finalStatus)
      expect(row?.subtotal_cents).toBe(beforeSubtotal)
      expect(row?.tax_cents).toBe(beforeTax)
      expect(row?.total_cents).toBe(beforeTotal)
      expect(row?.items).toContain('Prik Khing')   // never overwritten
    })
  }

  test('received order is NOT finalized — edit still allowed', async () => {
    const orderId = insertOrder({ status: 'received' })
    const res = await patchOrderItems(orderId, {
      items: [{ itemId: 'X', name: 'OK', priceCents: 500, quantity: 1 }],
    })
    expect(res.status).toBe(200)
  })
})

// ── GET /api/merchants/:id/orders ─────────────────────────────────────────────

describe('GET /api/merchants/:id/orders', () => {
  test('returns { orders, range } with orders array', async () => {
    insertOrder({ status: 'received' })
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { orders: unknown[]; range: { from: string; to: string } }
    expect(Array.isArray(body.orders)).toBe(true)
    expect(typeof body.range.from).toBe('string')
    expect(typeof body.range.to).toBe('string')
  })

  test('date range filter: orders outside range are excluded', async () => {
    // Seed an order and then query with a future-only window that excludes it
    insertOrder({ status: 'received' })
    const futureFrom = Date.now() + 24 * 60 * 60 * 1000   // 24h in the future
    const futureTo   = Date.now() + 48 * 60 * 60 * 1000

    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders?from=${futureFrom}&to=${futureTo}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { orders: unknown[] }
    expect(body.orders.length).toBe(0)
  })

  test('limit param caps result count', async () => {
    // Seed 5 orders
    for (let i = 0; i < 5; i++) insertOrder({ status: 'received' })

    const from = Date.now() - 24 * 60 * 60 * 1000
    const to   = Date.now() + 60_000
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders?from=${from}&to=${to}&limit=2`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { orders: unknown[] }
    expect(body.orders.length).toBeLessThanOrEqual(2)
  })

  test('requires authentication → 401', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders`,
    ))
    expect(res.status).toBe(401)
  })

  test('staff token is allowed → 200', async () => {
    const { signJWT } = await import('../src/utils/jwt')
    const { verifyJWT } = await import('../src/utils/jwt')
    const userId     = verifyJWT(ownerToken).sub
    const staffToken = signJWT({ sub: userId, type: 'access', role: 'staff', merchantId }, 86_400)
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders`,
      { headers: { Authorization: `Bearer ${staffToken}` } },
    ))
    expect(res.status).toBe(200)
  })
})
