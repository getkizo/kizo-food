/**
 * Split-payment session tests (Phase 2: pause/resume).
 *
 * Tests:
 *   GET   /api/merchants/:id/orders/:orderId/split-session
 *   PATCH /api/merchants/:id/orders/:orderId/split-session/pause
 *   UPSERT inside POST .../record-payment
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

let ownerToken = ''
let merchantId = ''
const STAFF_PIN   = '1234'
const STAFF_PIN2  = '5678'
const MANAGER_PIN = '9999'

// ── helpers ────────────────────────────────────────────────────────────────────

function insertOrder(opts: {
  status?: string
  subtotalCents?: number
  totalCents?:    number
  taxCents?:      number
  items?:         unknown[]
} = {}): string {
  const db = getDatabase()
  const orderId = `ord_${Math.random().toString(36).slice(2, 14)}`
  const {
    status        = 'confirmed',
    subtotalCents = 9000,
    totalCents    = 9936,
    taxCents      = 936,
    items         = [item('A', 3000), item('B', 3000), item('C', 3000)],
  } = opts
  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, customer_phone, order_type,
        status, subtotal_cents, total_cents, tax_cents,
        source, items, created_at, updated_at)
     VALUES (?, ?, 'Test Customer', '555-1234', 'dine_in',
             ?, ?, ?, ?, 'local', ?, datetime('now'), datetime('now'))`,
    [orderId, merchantId, status, subtotalCents, totalCents, taxCents, JSON.stringify(items)]
  )
  return orderId
}

function item(dishName: string, priceCents: number, quantity = 1) {
  return {
    itemId: `it_${Math.random().toString(36).slice(2, 8)}`,
    dishName, quantity, priceCents,
    modifiers: [],
    lineTotalCents: priceCents * quantity,
  }
}

function hashCode(merchantId: string, code: string): string {
  return createHash('sha256').update(`${merchantId}::${code}`).digest('hex')
}

function insertEmployee(pin: string, nickname = 'Server', role = 'server'): string {
  const db = getDatabase()
  const empId = `emp_${Math.random().toString(36).slice(2, 14)}`
  db.run(
    `INSERT INTO employees
       (id, merchant_id, nickname, access_code_hash, role, language, schedule, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'en', NULL, 1, datetime('now'), datetime('now'))`,
    [empId, merchantId, nickname, hashCode(merchantId, pin), role]
  )
  return empId
}

async function postJSON(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

async function patchJSON(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

async function getJSON(path: string, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'GET',
    headers: { Authorization: `Bearer ${token}` },
  }))
}

function recordLeg(orderId: string, body: Record<string, unknown>) {
  return postJSON(`/api/merchants/${merchantId}/orders/${orderId}/record-payment`, {
    paymentType: 'cash',
    ...body,
  })
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

  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@split.test',
      password:     'SecurePass123!',
      fullName:     'Split Owner',
      businessName: 'Split Cafe',
      slug:         'split-cafe',
    }),
  }))
  const reg = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = reg.tokens.accessToken
  merchantId = reg.merchant.id

  insertEmployee(STAFF_PIN,   'Alice')
  insertEmployee(STAFF_PIN2,  'Bob')
  insertEmployee(MANAGER_PIN, 'Carol', 'manager')
})

// ── UPSERT lifecycle inside record-payment ─────────────────────────────────

describe('record-payment UPSERTs order_split_sessions', () => {
  test('first equal leg INSERTs an in_progress session row', async () => {
    const orderId = insertOrder()

    const r = await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    expect(r.status).toBe(201)

    const db = getDatabase()
    const session = db.query<{
      split_mode: string
      expected_total_legs: number | null
      current_leg_number: number
      paid_leg_bases_json: string
      paid_indices_json: string
      status: string
    }, [string]>(
      `SELECT split_mode, expected_total_legs, current_leg_number,
              paid_leg_bases_json, paid_indices_json, status
       FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)

    expect(session?.split_mode).toBe('equal')
    expect(session?.expected_total_legs).toBe(2)
    expect(session?.current_leg_number).toBe(2)        // next leg to pay
    expect(JSON.parse(session?.paid_leg_bases_json ?? '[]')).toEqual([4500])
    expect(JSON.parse(session?.paid_indices_json ?? '[]')).toEqual([])
    expect(session?.status).toBe('in_progress')
  })

  test('final equal leg marks session completed', async () => {
    const orderId = insertOrder()

    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    const r2 = await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 2, splitTotalLegs: 2,
    })
    expect(r2.status).toBe(201)
    expect((await r2.json() as { isLastLeg: boolean }).isLastLeg).toBe(true)

    const db = getDatabase()
    const session = db.query<{ status: string; current_leg_number: number; paid_leg_bases_json: string }, [string]>(
      `SELECT status, current_leg_number, paid_leg_bases_json
       FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)
    expect(session?.status).toBe('completed')
    expect(session?.current_leg_number).toBe(3)        // 2 legs paid + 1
    expect(JSON.parse(session?.paid_leg_bases_json ?? '[]')).toEqual([4500, 4500])
  })

  test('by_items session accumulates paid_indices_json across legs', async () => {
    const orderId = insertOrder({
      items: [item('A', 1000), item('B', 1500), item('C', 2000)],
      subtotalCents: 4500, totalCents: 4968, taxCents: 468,
    })

    await recordLeg(orderId, {
      subtotalCents: 1000, taxCents: 104, tipCents: 0, totalCents: 1104,
      splitMode: 'by_items', splitLegNumber: 1, splitItemsJson: '[0]',
    })
    await recordLeg(orderId, {
      subtotalCents: 1500, taxCents: 156, tipCents: 0, totalCents: 1656,
      splitMode: 'by_items', splitLegNumber: 2, splitItemsJson: '[1]',
    })

    const db = getDatabase()
    const session = db.query<{
      expected_total_legs: number | null
      paid_indices_json: string
      paid_leg_bases_json: string
      status: string
    }, [string]>(
      `SELECT expected_total_legs, paid_indices_json, paid_leg_bases_json, status
       FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)

    expect(session?.expected_total_legs).toBeNull()    // by_items: derived from coverage
    expect(JSON.parse(session?.paid_indices_json ?? '[]')).toEqual([0, 1])
    expect(JSON.parse(session?.paid_leg_bases_json ?? '[]')).toEqual([1104, 1656])
    expect(session?.status).toBe('in_progress')

    // Final leg covers item 2 → completed
    await recordLeg(orderId, {
      subtotalCents: 2000, taxCents: 208, tipCents: 0, totalCents: 2208,
      splitMode: 'by_items', splitLegNumber: 3, splitItemsJson: '[2]',
    })

    const finished = db.query<{ status: string; paid_indices_json: string }, [string]>(
      `SELECT status, paid_indices_json
       FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)
    expect(finished?.status).toBe('completed')
    expect(JSON.parse(finished?.paid_indices_json ?? '[]')).toEqual([0, 1, 2])
  })

  test('non-split payment does not create a session row', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 9000, taxCents: 936, tipCents: 0, totalCents: 9936,
    })
    const db = getDatabase()
    const session = db.query<{ order_id: string }, [string]>(
      `SELECT order_id FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)
    expect(session).toBeNull()
  })
})

// ── GET /split-session ────────────────────────────────────────────────────

describe('GET split-session', () => {
  test('returns 404 when no session exists', async () => {
    const orderId = insertOrder()
    const r = await getJSON(`/api/merchants/${merchantId}/orders/${orderId}/split-session`)
    expect(r.status).toBe(404)
  })

  test('returns the in_progress session with correct fields', async () => {
    const orderId = insertOrder({
      items: [item('A', 1000), item('B', 1500), item('C', 2000)],
      subtotalCents: 4500, totalCents: 4968, taxCents: 468,
    })
    await recordLeg(orderId, {
      subtotalCents: 1000, taxCents: 104, tipCents: 0, totalCents: 1104,
      splitMode: 'by_items', splitLegNumber: 1, splitItemsJson: '[0]',
    })

    const r = await getJSON(`/api/merchants/${merchantId}/orders/${orderId}/split-session`)
    expect(r.status).toBe(200)
    const s = await r.json() as {
      orderId: string; splitMode: string; expectedTotalLegs: number | null
      currentLegNumber: number; paidLegBases: number[]; paidIndices: number[]
      status: string; pausedAt: string | null; pausedByEmployeeId: string | null
    }
    expect(s.orderId).toBe(orderId)
    expect(s.splitMode).toBe('by_items')
    expect(s.expectedTotalLegs).toBeNull()
    expect(s.currentLegNumber).toBe(2)
    expect(s.paidLegBases).toEqual([1104])
    expect(s.paidIndices).toEqual([0])
    expect(s.status).toBe('in_progress')
    expect(s.pausedAt).toBeNull()
    expect(s.pausedByEmployeeId).toBeNull()
  })

  test('returns 404 when session is completed (no resume offered)', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 2, splitTotalLegs: 2,
    })

    const r = await getJSON(`/api/merchants/${merchantId}/orders/${orderId}/split-session`)
    expect(r.status).toBe(404)
  })

  test('returns 401 without auth', async () => {
    const orderId = insertOrder()
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/split-session`,
      { method: 'GET' }
    ))
    expect(res.status).toBe(401)
  })
})

// ── PATCH /split-session/pause ────────────────────────────────────────────

describe('PATCH split-session/pause', () => {
  test('pauses an in_progress session with valid PIN', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 3,
    })

    const r = await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { success: boolean; pausedAt: string; pausedByEmployeeId: string }
    expect(body.success).toBe(true)
    expect(body.pausedAt).toBeTruthy()
    expect(body.pausedByEmployeeId).toMatch(/^emp_/)

    const db = getDatabase()
    const s = db.query<{ status: string; paused_by_employee_id: string | null }, [string]>(
      `SELECT status, paused_by_employee_id FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)
    expect(s?.status).toBe('paused')
    expect(s?.paused_by_employee_id).toBe(body.pausedByEmployeeId)
  })

  test('rejects invalid PIN with 401', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 3,
    })

    const r = await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: '0001' }   // not a registered PIN (avoids MANAGER_PIN '9999')
    )
    expect(r.status).toBe(401)
  })

  test('rejects malformed PIN with 400', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 3,
    })

    const r = await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: 'abcd' }
    )
    expect(r.status).toBe(400)
  })

  test('returns 404 when no session exists', async () => {
    const orderId = insertOrder()
    const r = await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )
    expect(r.status).toBe(404)
  })

  test('returns 409 when session is already completed', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 2, splitTotalLegs: 2,
    })

    const r = await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )
    expect(r.status).toBe(409)
  })
})

// ── Phase 5: GET /split-sessions list + writeoff-unpaid ─────────────────

describe('GET /split-sessions list', () => {
  test('returns paused sessions by default with order summary + paid totals', async () => {
    const orderId = insertOrder({
      items: [item('A', 1000), item('B', 1500), item('C', 2000)],
      subtotalCents: 4500, totalCents: 4968, taxCents: 468,
    })
    await recordLeg(orderId, {
      subtotalCents: 1000, taxCents: 104, tipCents: 200, totalCents: 1304,
      splitMode: 'by_items', splitLegNumber: 1, splitItemsJson: '[0]',
    })
    await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )

    const res = await getJSON(`/api/merchants/${merchantId}/split-sessions`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      sessions: Array<{
        orderId: string; status: string; splitMode: string
        order: { customerName: string; subtotalCents: number; totalCents: number }
        paidTotalCents: number; paidTipCents: number; paidPreTipCents: number
      }>
    }
    const found = body.sessions.find((s) => s.orderId === orderId)
    expect(found).toBeDefined()
    expect(found?.status).toBe('paused')
    expect(found?.splitMode).toBe('by_items')
    expect(found?.order.subtotalCents).toBe(4500)
    expect(found?.paidTotalCents).toBe(1304)
    expect(found?.paidTipCents).toBe(200)
    expect(found?.paidPreTipCents).toBe(1104)   // 1304 - 200 - 0 surcharge
  })

  test('does NOT include in_progress sessions when status=paused', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    // No pause — session is in_progress

    const res = await getJSON(`/api/merchants/${merchantId}/split-sessions?status=paused`)
    const body = await res.json() as { sessions: Array<{ orderId: string }> }
    expect(body.sessions.find((s) => s.orderId === orderId)).toBeUndefined()
  })

  test('?status=any returns both in_progress and paused', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    const res = await getJSON(`/api/merchants/${merchantId}/split-sessions?status=any`)
    const body = await res.json() as { sessions: Array<{ orderId: string; status: string }> }
    const found = body.sessions.find((s) => s.orderId === orderId)
    expect(found).toBeDefined()
    expect(found?.status).toBe('in_progress')
  })

  test('rejects invalid status', async () => {
    const res = await getJSON(`/api/merchants/${merchantId}/split-sessions?status=garbage`)
    expect(res.status).toBe(400)
  })
})

describe('POST writeoff-unpaid', () => {
  // Helper: set up a paused order at known totals.
  // Order: subtotal $90, tax (computed by merchant.tax_rate), 2 legs paid covering ~$51.89 pre-tip.
  // Mirrors the user's real-world incident.
  async function makePausedOrder(opts: { taxRate: number }) {
    const db = getDatabase()
    db.run(`UPDATE merchants SET tax_rate = ? WHERE id = ?`, [opts.taxRate, merchantId])

    const orderId = insertOrder({
      items: [item('A', 9000)],            // single item placeholder; not used by equal split
      subtotalCents: 9000,
      taxCents:      Math.round(9000 * opts.taxRate),
      totalCents:    9000 + Math.round(9000 * opts.taxRate),
    })

    // Two legs of by_items would require items; equal mode with custom amounts is simpler.
    // Leg 1: pays for $29 pre-tip + tip $5.92  (mirrors VISA ···9624 $35.54 case roughly)
    await recordLeg(orderId, {
      subtotalCents: 2860, taxCents: 297, tipCents: 397, totalCents: 3554,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 4,
    })
    // Leg 2
    await recordLeg(orderId, {
      subtotalCents: 1840, taxCents: 192, tipCents: 253, totalCents: 2285,
      splitMode: 'equal', splitLegNumber: 2, splitTotalLegs: 4,
    })

    await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )
    return orderId
  }

  test('writes off unpaid balance and marks order paid (matches real-world math)', async () => {
    const orderId = await makePausedOrder({ taxRate: 0.104 })

    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      addedDiscountCents: number; newDiscountCents: number
      newTaxCents: number; newTotalCents: number
      paidAmountCents: number; paidTipCents: number
    }

    // paid pre-tip = (3554+2285) - (397+253) - 0 = 5839 - 650 = 5189
    // newTaxedBase = round(5189 / 1.104) = 4700
    // newTax = 5189 - 4700 = 489
    // addedDiscount = (9000 + 0) - 0 - 4700 = 4300
    // newTotal = 4700 + 489 + 650 + 0 = 5839
    expect(body.addedDiscountCents).toBe(4300)
    expect(body.newDiscountCents).toBe(4300)
    expect(body.newTaxCents).toBe(489)
    expect(body.newTotalCents).toBe(5839)
    expect(body.paidAmountCents).toBe(5839)
    expect(body.paidTipCents).toBe(650)

    const db = getDatabase()
    const order = db.query<{
      status: string; discount_cents: number; discount_label: string | null
      tax_cents: number; total_cents: number; paid_amount_cents: number
      tip_cents: number
    }, [string]>(
      `SELECT status, discount_cents, discount_label, tax_cents,
              total_cents, paid_amount_cents, tip_cents
       FROM orders WHERE id = ?`
    ).get(orderId)
    expect(order?.status).toBe('paid')
    expect(order?.discount_cents).toBe(4300)
    expect(order?.discount_label).toBe('Unpaid balance write-off')
    expect(order?.tax_cents).toBe(489)
    expect(order?.total_cents).toBe(5839)
    expect(order?.paid_amount_cents).toBe(5839)
    expect(order?.tip_cents).toBe(650)

    const session = db.query<{ status: string }, [string]>(
      `SELECT status FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)
    expect(session?.status).toBe('completed')
  })

  test('handles zero-tax-rate merchants (newTax=0)', async () => {
    const orderId = await makePausedOrder({ taxRate: 0 })
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { newTaxCents: number; addedDiscountCents: number }
    expect(body.newTaxCents).toBe(0)
    // pre-tip total of payments = 5189; newTaxedBase = 5189; existingBase = 9000; discount = 3811
    expect(body.addedDiscountCents).toBe(3811)
  })

  test('returns 409 when session is in_progress (only paused can be written off)', async () => {
    const orderId = insertOrder()
    await recordLeg(orderId, {
      subtotalCents: 4500, taxCents: 0, tipCents: 0, totalCents: 4500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN }
    )
    expect(res.status).toBe(409)
  })

  test('returns 404 when no session exists', async () => {
    const orderId = insertOrder()
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN }
    )
    expect(res.status).toBe(404)
  })

  test('appends to an existing discount label rather than replacing it', async () => {
    const db = getDatabase()
    db.run(`UPDATE merchants SET tax_rate = 0.104 WHERE id = ?`, [merchantId])

    const orderId = insertOrder({ subtotalCents: 9000, taxCents: 936, totalCents: 9936 })
    db.run(
      `UPDATE orders SET discount_cents = 500, discount_label = '10% loyalty' WHERE id = ?`,
      [orderId]
    )

    await recordLeg(orderId, {
      subtotalCents: 2860, taxCents: 297, tipCents: 397, totalCents: 3554,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 4,
    })
    await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )

    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN }
    )
    expect(res.status).toBe(200)

    const order = db.query<{ discount_label: string | null; discount_cents: number }, [string]>(
      `SELECT discount_label, discount_cents FROM orders WHERE id = ?`
    ).get(orderId)
    expect(order?.discount_label).toBe('10% loyalty + Unpaid balance write-off')
    expect(order?.discount_cents).toBeGreaterThan(500)   // includes original + write-off addition
  })

  test('rejects (422) if pre-tip paid already covers the full pre-discount base', async () => {
    const db = getDatabase()
    db.run(`UPDATE merchants SET tax_rate = 0 WHERE id = ?`, [merchantId])

    const orderId = insertOrder({ subtotalCents: 1000, taxCents: 0, totalCents: 1000 })
    // Pay more pre-tip than the order's base via a single split leg.
    await recordLeg(orderId, {
      subtotalCents: 1500, taxCents: 0, tipCents: 0, totalCents: 1500,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 2,
    })
    await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )

    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN }
    )
    expect(res.status).toBe(422)
  })

  test('forbids staff role (manager-only)', async () => {
    // Use staff JWT — register a staff user
    const db = getDatabase()
    const staffPasswordHash = await Bun.password.hash('StaffPass123!', { algorithm: 'bcrypt', cost: 4 })
    const staffUserId = `usr_staff_writeoff_${Math.random().toString(36).slice(2, 8)}`
    db.run(
      `INSERT INTO users (id, email, password_hash, full_name, merchant_id, role)
       VALUES (?, ?, ?, 'Staff Person', ?, 'staff')`,
      [staffUserId, `${staffUserId}@split.test`, staffPasswordHash, merchantId]
    )
    const loginRes = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: `${staffUserId}@split.test`, password: 'StaffPass123!' }),
    }))
    const staffToken = ((await loginRes.json()) as { tokens?: { accessToken: string } }).tokens?.accessToken ?? ''

    const orderId = insertOrder()
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN },
      staffToken
    )
    expect(res.status).toBe(403)
  })

  test('rejects bad PIN with 401', async () => {
    const orderId = await makePausedOrder({ taxRate: 0.104 })
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: '0000' }   // not a registered PIN
    )
    expect(res.status).toBe(401)
  })

  test('rejects non-manager (server-role) PIN with 401', async () => {
    const orderId = await makePausedOrder({ taxRate: 0.104 })
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: STAFF_PIN }   // valid PIN but role='server'
    )
    expect(res.status).toBe(401)
  })

  test('rejects malformed PIN with 400', async () => {
    const orderId = await makePausedOrder({ taxRate: 0.104 })
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: 'abcd' }
    )
    expect(res.status).toBe(400)
  })

  test('response includes recomputed totals + approver id (SSE payload mirror)', async () => {
    const orderId = await makePausedOrder({ taxRate: 0.104 })
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/writeoff-unpaid`,
      { pin: MANAGER_PIN }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('newTotalCents')
    expect(body).toHaveProperty('newDiscountCents')
    expect(body).toHaveProperty('paidTipCents')
    expect(body).toHaveProperty('approvedByEmployeeId')
    expect(body.approvedByEmployeeId).toMatch(/^emp_/)
  })
})

describe('GET /split-sessions list response shape', () => {
  test('includes discountCents, serviceChargeCents, and unpaidBaseCents', async () => {
    const orderId = insertOrder({
      items: [item('A', 1000), item('B', 1500), item('C', 2000)],
      subtotalCents: 4500, totalCents: 4968, taxCents: 468,
    })
    await recordLeg(orderId, {
      subtotalCents: 1000, taxCents: 104, tipCents: 200, totalCents: 1304,
      splitMode: 'by_items', splitLegNumber: 1, splitItemsJson: '[0]',
    })
    await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )

    const res = await getJSON(`/api/merchants/${merchantId}/split-sessions`)
    const body = await res.json() as {
      sessions: Array<{
        orderId: string
        order: { discountCents: number; serviceChargeCents: number }
        unpaidBaseCents: number
      }>
    }
    const found = body.sessions.find((s) => s.orderId === orderId)
    expect(found).toBeDefined()
    expect(found?.order.discountCents).toBe(0)
    expect(found?.order.serviceChargeCents).toBe(0)
    // unpaidBase = (subtotal − discount + service_charge + tax) − paidPreTip
    //            = (4500 − 0 + 0 + 468) − 1104 = 3864
    expect(found?.unpaidBaseCents).toBe(3864)
  })
})

// ── finalize-partial (in-modal customer-left writeoff) ─────────────────────

describe('POST finalize-partial', () => {
  // Helper: leave an order in_progress (NOT paused) — the in-modal scenario.
  async function makeInProgressOrder(opts: { taxRate: number }) {
    const db = getDatabase()
    db.run(`UPDATE merchants SET tax_rate = ? WHERE id = ?`, [opts.taxRate, merchantId])
    const orderId = insertOrder({
      items: [item('A', 9000)],
      subtotalCents: 9000,
      taxCents:      Math.round(9000 * opts.taxRate),
      totalCents:    9000 + Math.round(9000 * opts.taxRate),
    })
    await recordLeg(orderId, {
      subtotalCents: 2860, taxCents: 297, tipCents: 397, totalCents: 3554,
      splitMode: 'equal', splitLegNumber: 1, splitTotalLegs: 4,
    })
    await recordLeg(orderId, {
      subtotalCents: 1840, taxCents: 192, tipCents: 253, totalCents: 2285,
      splitMode: 'equal', splitLegNumber: 2, splitTotalLegs: 4,
    })
    return orderId  // session is in_progress, not paused
  }

  test('writes off in_progress session — no PIN required', async () => {
    const orderId = await makeInProgressOrder({ taxRate: 0.104 })

    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/finalize-partial`,
      {}   // no pin in body — staff JWT alone
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      addedDiscountCents: number; newTaxCents: number
      newTotalCents: number; paidAmountCents: number
      newDiscountLabel: string
    }

    // Same math as writeoff-unpaid for the real-world incident scenario
    expect(body.addedDiscountCents).toBe(4300)
    expect(body.newTaxCents).toBe(489)
    expect(body.newTotalCents).toBe(5839)
    expect(body.paidAmountCents).toBe(5839)
    expect(body.newDiscountLabel).toMatch(/Customer left/)

    const db = getDatabase()
    expect(db.query<{ status: string }, [string]>(
      `SELECT status FROM orders WHERE id = ?`).get(orderId)?.status).toBe('paid')
    expect(db.query<{ status: string }, [string]>(
      `SELECT status FROM order_split_sessions WHERE order_id = ?`).get(orderId)?.status).toBe('completed')
  })

  test('also works on paused sessions', async () => {
    const orderId = await makeInProgressOrder({ taxRate: 0.104 })
    await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN }
    )

    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/finalize-partial`, {}
    )
    expect(res.status).toBe(200)
  })

  test('returns 409 on already-completed session', async () => {
    const orderId = await makeInProgressOrder({ taxRate: 0.104 })
    await postJSON(`/api/merchants/${merchantId}/orders/${orderId}/finalize-partial`, {})
    // Second call: order is already 'paid' → 409
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/finalize-partial`, {}
    )
    expect(res.status).toBe(409)
  })

  test('returns 404 when no session exists', async () => {
    const orderId = insertOrder()
    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/finalize-partial`, {}
    )
    expect(res.status).toBe(404)
  })

  test('preserves table_label on the order (caller logic decides table re-use)', async () => {
    // The endpoint marks the order paid. The dashboard's table-occupancy
    // view filters out paid orders, so the table becomes "free" without
    // having to mutate table_label.
    const orderId = await makeInProgressOrder({ taxRate: 0.104 })
    const db = getDatabase()
    db.run(`UPDATE orders SET table_label = 'Table 4' WHERE id = ?`, [orderId])

    const res = await postJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/finalize-partial`, {}
    )
    expect(res.status).toBe(200)

    const order = db.query<{ status: string; table_label: string | null }, [string]>(
      `SELECT status, table_label FROM orders WHERE id = ?`).get(orderId)
    expect(order?.status).toBe('paid')
    expect(order?.table_label).toBe('Table 4')   // preserved for audit; not "freed" textually
  })
})

// ── full lifecycle (pause → resume → complete) ────────────────────────────

describe('split session full lifecycle', () => {
  test('paused session is resumed by next record-payment', async () => {
    const orderId = insertOrder({
      items: [item('A', 1000), item('B', 1500), item('C', 2000)],
      subtotalCents: 4500, totalCents: 4968, taxCents: 468,
    })

    // Leg 1 — by_items, item [0]
    await recordLeg(orderId, {
      subtotalCents: 1000, taxCents: 104, tipCents: 0, totalCents: 1104,
      splitMode: 'by_items', splitLegNumber: 1, splitItemsJson: '[0]',
    })

    // Pause
    const pauseRes = await patchJSON(
      `/api/merchants/${merchantId}/orders/${orderId}/split-session/pause`,
      { pin: STAFF_PIN2 }
    )
    expect(pauseRes.status).toBe(200)

    // GET should return paused session
    const getRes = await getJSON(`/api/merchants/${merchantId}/orders/${orderId}/split-session`)
    expect(getRes.status).toBe(200)
    expect((await getRes.json() as { status: string }).status).toBe('paused')

    // Leg 2 — by_items, item [1] — implicitly resumes
    await recordLeg(orderId, {
      subtotalCents: 1500, taxCents: 156, tipCents: 0, totalCents: 1656,
      splitMode: 'by_items', splitLegNumber: 2, splitItemsJson: '[1]',
    })

    const db = getDatabase()
    const resumed = db.query<{ status: string; paused_at: string | null; paused_by_employee_id: string | null }, [string]>(
      `SELECT status, paused_at, paused_by_employee_id
       FROM order_split_sessions WHERE order_id = ?`
    ).get(orderId)
    expect(resumed?.status).toBe('in_progress')
    expect(resumed?.paused_at).toBeNull()
    expect(resumed?.paused_by_employee_id).toBeNull()

    // Leg 3 — by_items, item [2] — completes
    const r3 = await recordLeg(orderId, {
      subtotalCents: 2000, taxCents: 208, tipCents: 0, totalCents: 2208,
      splitMode: 'by_items', splitLegNumber: 3, splitItemsJson: '[2]',
    })
    expect((await r3.json() as { isLastLeg: boolean }).isLastLeg).toBe(true)

    // GET now returns 404 (completed → hidden)
    const finalGet = await getJSON(`/api/merchants/${merchantId}/orders/${orderId}/split-session`)
    expect(finalGet.status).toBe(404)
  })
})
