/**
 * Store route negative tests
 *
 * Covers high-value edge cases and security guards:
 *   TC-N1  — SQL injection in customerName (parameterised queries protect the DB)
 *   TC-N6  — Order rejected when item has stock_status = 'out_indefinitely'
 *   TC-N7  — Order rejected when item has stock_status = 'out_today'
 *   TC-N8  — Empty items array returns 400
 *   TC-N16 — Duplicate payment-result returns 409 (idempotency guard)
 *   TC-N18 — Item creation with categoryId from another merchant returns 404
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

// Shared state populated in beforeAll
let ownerToken  = ''
let merchantId  = ''
let testCatId   = ''
let testItemId  = ''
let otherMerchantToken = ''
let otherMerchantId    = ''

beforeAll(async () => {
  // Force a fresh :memory: connection — all test files share the same Bun
  // worker, so the DB singleton may have been initialised by an earlier file.
  // Also clear the module-level merchant cache in store.ts.
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register primary merchant
  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'owner@storeroutes.test',
      password:     'SecurePass123!',
      fullName:     'Store Routes Owner',
      businessName: 'Store Routes Cafe',
      slug:         'store-routes-cafe',
    }),
  }))
  const regBody = await regRes.json()
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  // Create category + item
  const catRes = await app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/menu/categories`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ name: 'Drinks' }),
    }
  ))
  testCatId = (await catRes.json()).id

  const itemRes = await app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/menu/items`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({
        categoryId:      testCatId,
        name:            'Coffee',
        priceCents:      350,
        availableOnline: true,
      }),
    }
  ))
  testItemId = (await itemRes.json()).itemId

  // Register a second (unrelated) merchant for cross-merchant tests
  const otherRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'other@storeroutes.test',
      password:     'SecurePass123!',
      fullName:     'Other Owner',
      businessName: 'Other Cafe',
      slug:         'other-cafe',
    }),
  }))
  const otherBody = await otherRes.json()
  otherMerchantToken = otherBody.tokens.accessToken
  otherMerchantId    = otherBody.merchant.id
})

// ---------------------------------------------------------------------------
// TC-N1 — SQL injection in customerName
// ---------------------------------------------------------------------------

describe('Store Orders - SQL injection guard', () => {
  test('TC-N1: SQL injection string in customerName is stored literally, DB intact', async () => {
    const maliciousName = "'; DROP TABLE orders; --"

    const orderRes = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: maliciousName,
        items: [{ itemId: testItemId }],
      }),
    }))

    // Order should succeed — parameterised queries treat the string as data
    expect(orderRes.status).toBe(201)
    const orderBody = await orderRes.json()
    expect(orderBody.orderId).toMatch(/^ord_/)

    // Verify DB integrity: orders table is still queryable
    const listRes = await app.fetch(new Request(
      `http://localhost:3000/api/orders?merchantId=${merchantId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ))
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json()
    expect(Array.isArray(listBody.orders)).toBe(true)

    // The customer name was stored as the literal injection string
    const placed = listBody.orders.find((o: any) => o.id === orderBody.orderId)
    expect(placed?.customerName ?? placed?.customer_name).toBe(maliciousName)
  })
})

// ---------------------------------------------------------------------------
// TC-N6 / TC-N7 — stock_status enforcement at order creation
// ---------------------------------------------------------------------------

describe('Store Orders - stock_status enforcement', () => {
  test('TC-N6: item with stock_status=out_indefinitely is rejected at order creation', async () => {
    const db = getDatabase()
    db.run(`UPDATE menu_items SET stock_status = 'out_indefinitely' WHERE id = ?`, [testItemId])

    try {
      const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          customerName: 'OOS Customer',
          items: [{ itemId: testItemId }],
        }),
      }))
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/out of stock/i)
    } finally {
      db.run(`UPDATE menu_items SET stock_status = 'in_stock' WHERE id = ?`, [testItemId])
    }
  })

  test('TC-N7: item with stock_status=out_today is rejected at order creation', async () => {
    const db = getDatabase()
    db.run(`UPDATE menu_items SET stock_status = 'out_today' WHERE id = ?`, [testItemId])

    try {
      const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          customerName: 'OOS Today Customer',
          items: [{ itemId: testItemId }],
        }),
      }))
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toMatch(/out of stock/i)
    } finally {
      db.run(`UPDATE menu_items SET stock_status = 'in_stock' WHERE id = ?`, [testItemId])
    }
  })
})

// ---------------------------------------------------------------------------
// TC-N8 — empty items array
// ---------------------------------------------------------------------------

describe('Store Orders - input validation', () => {
  test('TC-N8: empty items array returns 400', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'No Items Customer',
        items: [],
      }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/items/i)
  })

  test('missing customerName returns 400', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        items: [{ itemId: testItemId }],
      }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/customerName/i)
  })
})

// ---------------------------------------------------------------------------
// TC-N16 — payment-result idempotency guard
// ---------------------------------------------------------------------------

describe('Store Orders - payment idempotency', () => {
  test('TC-N16: posting payment-result to an already-confirmed order returns 409', async () => {
    // Place an order (status = 'received')
    const orderRes = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Payment Test',
        items: [{ itemId: testItemId }],
      }),
    }))
    expect(orderRes.status).toBe(201)
    const { orderId } = await orderRes.json()

    // Simulate the order already having been paid — advance status to 'confirmed'
    // (This is what the real payment flow does after Converge/Finix verification.)
    const db = getDatabase()
    db.run(`UPDATE orders SET status = 'confirmed' WHERE id = ?`, [orderId])

    // Now posting payment-result to a 'confirmed' order must return 409
    // (the idempotency guard: status !== 'received' → reject replay)
    const payRes = await app.fetch(
      new Request(`http://localhost:3000/api/store/orders/${orderId}/payment-result`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider: 'converge', ssl_txn_id: 'fake-txn-123' }),
      })
    )
    expect(payRes.status).toBe(409)

    // A second identical call also returns 409 (not 500)
    const pay2Res = await app.fetch(
      new Request(`http://localhost:3000/api/store/orders/${orderId}/payment-result`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider: 'converge', ssl_txn_id: 'fake-txn-123' }),
      })
    )
    expect(pay2Res.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// TC-N18 — cross-merchant categoryId on item creation
// ---------------------------------------------------------------------------

describe('Menu - cross-merchant isolation', () => {
  test('TC-N18: creating item with categoryId from another merchant returns 404', async () => {
    // otherMerchantToken tries to create an item under merchantId's category
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${otherMerchantId}/menu/items`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherMerchantToken}` },
        body:    JSON.stringify({
          categoryId:   testCatId,       // belongs to the primary merchant, not otherMerchantId
          name:         'Stolen Item',
          priceCents:   100,
        }),
      }
    ))
    // The category does not exist under otherMerchantId → 404
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/category not found/i)
  })
})

// ---------------------------------------------------------------------------
// SEC-B01 — tip cap: tipCents is clamped to [0, 100_000]
// ---------------------------------------------------------------------------

describe('Store Orders - tip cap (SEC-B01)', () => {
  test('tipCents above $1,000 cap is clamped to 100,000 cents', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Big Tipper',
        items:        [{ itemId: testItemId }],
        tipCents:     999_999,   // way over the $1,000 cap
      }),
    }))
    // The order is accepted — tipCents is silently clamped, not rejected
    expect(res.status).toBe(201)

    const { orderId } = await res.json()
    const db = getDatabase()
    const row = db
      .query<{ tip_cents: number }, [string]>('SELECT tip_cents FROM orders WHERE id = ?')
      .get(orderId)
    expect(row?.tip_cents).toBe(100_000)
  })

  test('negative tipCents is clamped to 0', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Negative Tipper',
        items:        [{ itemId: testItemId }],
        tipCents:     -500,
      }),
    }))
    expect(res.status).toBe(201)

    const { orderId } = await res.json()
    const db = getDatabase()
    const row = db
      .query<{ tip_cents: number }, [string]>('SELECT tip_cents FROM orders WHERE id = ?')
      .get(orderId)
    expect(row?.tip_cents).toBe(0)
  })

  test('tipCents exactly at cap (100,000) is stored as-is', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Cap Tipper',
        items:        [{ itemId: testItemId }],
        tipCents:     100_000,
      }),
    }))
    expect(res.status).toBe(201)

    const { orderId } = await res.json()
    const db = getDatabase()
    const row = db
      .query<{ tip_cents: number }, [string]>('SELECT tip_cents FROM orders WHERE id = ?')
      .get(orderId)
    expect(row?.tip_cents).toBe(100_000)
  })
})

// ---------------------------------------------------------------------------
// TC-SCHED — scheduledFor handling
// ---------------------------------------------------------------------------

describe('Store Orders - scheduled pickup', () => {
  test('future scheduledFor is stored as pickup_time', async () => {
    const futureTime = new Date(Date.now() + 2 * 3_600_000).toISOString()  // 2 hours from now

    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Scheduled Customer',
        items:        [{ itemId: testItemId }],
        scheduledFor: futureTime,
      }),
    }))
    expect(res.status).toBe(201)

    const { orderId } = await res.json()
    const db = getDatabase()
    const row = db
      .query<{ pickup_time: string | null }, [string]>('SELECT pickup_time FROM orders WHERE id = ?')
      .get(orderId)
    expect(row?.pickup_time).not.toBeNull()
  })

  test('past scheduledFor is ignored and order is placed without pickup_time', async () => {
    const pastTime = new Date(Date.now() - 3_600_000).toISOString()  // 1 hour ago

    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Past Scheduler',
        items:        [{ itemId: testItemId }],
        scheduledFor: pastTime,
      }),
    }))
    expect(res.status).toBe(201)

    const { orderId } = await res.json()
    const db = getDatabase()
    const row = db
      .query<{ pickup_time: string | null }, [string]>('SELECT pickup_time FROM orders WHERE id = ?')
      .get(orderId)
    expect(row?.pickup_time).toBeNull()
  })
})
