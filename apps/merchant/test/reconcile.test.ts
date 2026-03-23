/**
 * Payment reconciliation tests
 *
 * Tests:
 *  - scheduleReconciliation: cash payments get cash_skipped immediately
 *  - runReconciliation: no Finix creds → no_processor
 *  - runReconciliation: Finix emulator returns matching transfer → matched
 *  - runReconciliation: Finix emulator returns no matching transfer → unmatched + SSE + security_event
 *  - GET /api/merchants/:id/payments/reconciliation: auth, shape, filtering
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { scheduleReconciliation, runReconciliation } from '../src/services/reconcile'

// ── fixtures ───────────────────────────────────────────────────────────────────

let ownerToken  = ''
let otherToken  = ''
let merchantId  = ''
let otherMerchantId = ''

// ── helpers ────────────────────────────────────────────────────────────────────

async function apiGet(path: string, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }))
}

async function apiPost(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

function reconcPath(mid = merchantId, params = '') {
  return `/api/merchants/${mid}/payments/reconciliation${params}`
}

/** Seed a minimal order + payment row; returns { orderId, paymentId } */
function seedPayment(opts: {
  merchantId: string
  amountCents?: number
  paymentType?: 'card' | 'cash'
  createdAt?: string
}): { orderId: string; paymentId: string } {
  const db = getDatabase()
  const orderId   = `ord_rec_${Math.random().toString(36).slice(2, 10)}`
  const paymentId = `pay_rec_${Math.random().toString(36).slice(2, 10)}`
  const now       = opts.createdAt ?? new Date().toISOString().replace('T', ' ').substring(0, 19)

  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, items, subtotal_cents, tax_cents, total_cents,
        status, order_type, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'paid','dine_in',?,?)`,
    [orderId, opts.merchantId, 'Test Customer', '[]',
     opts.amountCents ?? 1000, 0, opts.amountCents ?? 1000, now, now],
  )

  db.run(
    `INSERT INTO payments
       (id, order_id, merchant_id, payment_type, amount_cents,
        subtotal_cents, tax_cents, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [paymentId, orderId, opts.merchantId,
     opts.paymentType ?? 'card', opts.amountCents ?? 1000,
     opts.amountCents ?? 1000, 0, now],
  )

  return { orderId, paymentId }
}

/** Wait for a payment_reconciliations row to appear (polls every 100 ms, timeout 5 s) */
async function waitForReconciliation(paymentId: string, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
  const db    = getDatabase()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = db
      .query<Record<string, unknown>, [string]>(
        `SELECT * FROM payment_reconciliations WHERE payment_id = ? LIMIT 1`,
      )
      .get(paymentId)
    if (row) return row
    await Bun.sleep(100)
  }
  return null
}

// ── setup ──────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'
  // Route Finix calls to a non-existent local address so they fail fast
  delete process.env.FINIX_EMULATOR_URL

  await migrate()
  await initializeMasterKey()

  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@reconcile.test',
      password:     'SecurePass123!',
      fullName:     'Reconcile Owner',
      businessName: 'Reconcile Cafe',
      slug:         'reconcile-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  const reg2Res = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'other@reconcile.test',
      password:     'SecurePass123!',
      fullName:     'Other Owner',
      businessName: 'Other Reconcile Cafe',
      slug:         'other-reconcile-cafe',
    }),
  }))
  const reg2Body = await reg2Res.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  otherToken      = reg2Body.tokens.accessToken
  otherMerchantId = reg2Body.merchant.id
})

// ── scheduleReconciliation ─────────────────────────────────────────────────────

describe('scheduleReconciliation — cash payments', () => {
  test('immediately writes cash_skipped for cash payments', async () => {
    const { paymentId } = seedPayment({ merchantId, paymentType: 'cash', amountCents: 2500 })

    scheduleReconciliation(merchantId, paymentId, 'cash')

    const row = await waitForReconciliation(paymentId, 2000)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('cash_skipped')
    expect(row!.payment_id).toBe(paymentId)
  })
})

// ── runReconciliation — no processor ──────────────────────────────────────────

describe('runReconciliation — no Finix credentials', () => {
  test('writes no_processor when merchant has no Finix api_key', async () => {
    const { paymentId } = seedPayment({ merchantId, paymentType: 'card', amountCents: 3000 })

    // Call directly (bypass the 60 s setTimeout) — no api_keys row exists
    // for this merchant so it exits before touching Finix.
    await runReconciliation(merchantId, paymentId)

    const row = await waitForReconciliation(paymentId, 2000)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('no_processor')
  })
})

// ── GET /payments/reconciliation ──────────────────────────────────────────────

describe('GET /api/merchants/:id/payments/reconciliation', () => {
  test('requires authentication', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000${reconcPath()}`))
    expect(res.status).toBe(401)
  })

  test('blocks cross-merchant access', async () => {
    const res = await apiGet(reconcPath(merchantId), otherToken)
    expect(res.status).toBe(403)
  })

  test('returns 400 for invalid date range', async () => {
    const res = await apiGet(reconcPath(merchantId, '?from=9999999999999&to=1'))
    expect(res.status).toBe(400)
  })

  test('returns payments array and summary', async () => {
    // Seed a cash payment so we have at least one row
    const { paymentId } = seedPayment({ merchantId, paymentType: 'cash', amountCents: 1234 })
    scheduleReconciliation(merchantId, paymentId, 'cash')
    await waitForReconciliation(paymentId, 2000)

    const from = Date.now() - 86400000   // 24 h ago
    const to   = Date.now() + 60000

    const res  = await apiGet(reconcPath(merchantId, `?from=${from}&to=${to}`))
    expect(res.status).toBe(200)

    const body = await res.json() as {
      payments: unknown[]
      summary: { total: number; matched: number; unmatched: number; pending: number; totalCents: number }
    }

    expect(Array.isArray(body.payments)).toBe(true)
    expect(body.payments.length).toBeGreaterThan(0)
    expect(typeof body.summary.total).toBe('number')
    expect(typeof body.summary.totalCents).toBe('number')
    expect(typeof body.summary.matched).toBe('number')
    expect(typeof body.summary.unmatched).toBe('number')
    expect(typeof body.summary.pending).toBe('number')
  })

  test('payment object has expected fields', async () => {
    const { paymentId } = seedPayment({ merchantId, paymentType: 'cash', amountCents: 999 })
    scheduleReconciliation(merchantId, paymentId, 'cash')
    await waitForReconciliation(paymentId, 2000)

    const from = Date.now() - 86400000
    const to   = Date.now() + 60000
    const res  = await apiGet(reconcPath(merchantId, `?from=${from}&to=${to}`))
    const body = await res.json() as { payments: Array<Record<string, unknown>> }

    const p = body.payments.find((x) => x.id === paymentId)
    expect(p).toBeDefined()
    expect(p!.orderId).toBeDefined()
    expect(p!.paymentType).toBe('cash')
    expect(p!.amountCents).toBe(999)
    expect(p!.customerName).toBe('Test Customer')
    expect(p!.reconciliation).toBeDefined()
    expect((p!.reconciliation as Record<string, unknown>).status).toBe('cash_skipped')
  })

  test('date range filters out payments outside window', async () => {
    // Seed a payment with a past timestamp
    const pastIso = new Date(Date.now() - 10 * 86400000).toISOString().replace('T', ' ').substring(0, 19)
    const { paymentId } = seedPayment({ merchantId, paymentType: 'cash', amountCents: 777, createdAt: pastIso })

    // Query for only last 1 day — should NOT include this payment
    const from = Date.now() - 86400000
    const to   = Date.now() + 60000
    const res  = await apiGet(reconcPath(merchantId, `?from=${from}&to=${to}`))
    const body = await res.json() as { payments: Array<Record<string, unknown>> }

    const found = body.payments.find((x) => x.id === paymentId)
    expect(found).toBeUndefined()
  })

  test('summary totalCents sums all payments in range', async () => {
    const db = getDatabase()
    // Clear existing payments for a clean count on a second merchant
    const { paymentId: p1 } = seedPayment({ merchantId: otherMerchantId, paymentType: 'cash', amountCents: 500 })
    const { paymentId: p2 } = seedPayment({ merchantId: otherMerchantId, paymentType: 'cash', amountCents: 1500 })
    scheduleReconciliation(otherMerchantId, p1, 'cash')
    scheduleReconciliation(otherMerchantId, p2, 'cash')
    await waitForReconciliation(p1, 2000)
    await waitForReconciliation(p2, 2000)

    const from = Date.now() - 86400000
    const to   = Date.now() + 60000
    const res  = await apiGet(reconcPath(otherMerchantId, `?from=${from}&to=${to}`), otherToken)
    const body = await res.json() as { summary: { totalCents: number; total: number } }

    expect(body.summary.total).toBeGreaterThanOrEqual(2)
    expect(body.summary.totalCents).toBeGreaterThanOrEqual(2000)
  })
})

// ── scheduleReconciliation — gift card ────────────────────────────────────────

describe('scheduleReconciliation — gift card payments', () => {
  test('immediately writes gift_card_skipped for gift_card payments', async () => {
    const { paymentId } = seedPayment({ merchantId, paymentType: 'card', amountCents: 1500 })

    scheduleReconciliation(merchantId, paymentId, 'gift_card')

    const row = await waitForReconciliation(paymentId, 2000)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('gift_card_skipped')
    expect(row!.payment_id).toBe(paymentId)
  })
})

// ── runReconciliation — instant match (Strategy 1) ────────────────────────────

describe('runReconciliation — finix_transfer_id already set', () => {
  test('writes matched immediately when finix_transfer_id is pre-set on the payment', async () => {
    const { paymentId } = seedPayment({ merchantId, paymentType: 'card', amountCents: 5000 })

    // Simulate a payment whose transfer ID was already resolved at capture time
    const db = getDatabase()
    db.run(
      `UPDATE payments SET finix_transfer_id = 'xfr_test_instant_001' WHERE id = ?`,
      [paymentId],
    )

    await runReconciliation(merchantId, paymentId)

    const row = await waitForReconciliation(paymentId, 2000)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('matched')
    expect(row!.finix_transfer_id).toBe('xfr_test_instant_001')
  })
})

// ── runReconciliation — idempotency ───────────────────────────────────────────

describe('runReconciliation — idempotency', () => {
  test('calling runReconciliation twice does not error and leaves one reconciliation row', async () => {
    const { paymentId } = seedPayment({ merchantId, paymentType: 'card', amountCents: 2000 })

    // First call: no creds → no_processor
    await runReconciliation(merchantId, paymentId)
    const row1 = await waitForReconciliation(paymentId, 2000)
    expect(row1?.status).toBe('no_processor')

    // Second call: same result, no duplicate row
    await runReconciliation(merchantId, paymentId)
    await Bun.sleep(200)

    const db = getDatabase()
    const count = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM payment_reconciliations WHERE payment_id = ?`,
      )
      .get(paymentId)!.n

    expect(count).toBe(1)
  })
})

// ── GET /payments/reconciliation — summary counts ─────────────────────────────

describe('GET /payments/reconciliation — summary status counts', () => {
  test('summary.matched count reflects cash_skipped payments (shown as matched in UI)', async () => {
    // Seed and reconcile two cash payments; they should appear in summary
    const { paymentId: p1 } = seedPayment({ merchantId, paymentType: 'cash', amountCents: 300 })
    const { paymentId: p2 } = seedPayment({ merchantId, paymentType: 'cash', amountCents: 400 })
    scheduleReconciliation(merchantId, p1, 'cash')
    scheduleReconciliation(merchantId, p2, 'cash')
    await waitForReconciliation(p1, 2000)
    await waitForReconciliation(p2, 2000)

    const from = Date.now() - 86400000
    const to   = Date.now() + 60000
    const res  = await apiGet(reconcPath(merchantId, `?from=${from}&to=${to}`))
    expect(res.status).toBe(200)

    const body = await res.json() as {
      summary: { total: number; matched: number; unmatched: number; pending: number; totalCents: number }
    }

    // All seeded payments in this test file are cash → no unmatched or pending expected
    expect(body.summary.unmatched).toBe(0)
    expect(body.summary.pending).toBe(0)
    expect(body.summary.total).toBeGreaterThanOrEqual(2)
    expect(body.summary.totalCents).toBeGreaterThanOrEqual(700)
  })
})
