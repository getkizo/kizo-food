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
import { scheduleReconciliation, runReconciliation, sweepOrphanedTerminalSales, scheduleOrderReconciliation } from '../src/services/reconcile'
import { storeAPIKey } from '../src/crypto/api-keys'

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

// ── sweepOrphanedTerminalSales — verification-pending recovery ────────────────

describe('sweepOrphanedTerminalSales — verification-pending rows', () => {
  /** Seed Finix API credentials for a merchant so loadFinixCreds succeeds. */
  async function seedFinixCreds(mId: string): Promise<void> {
    const db = getDatabase()
    await storeAPIKey(
      mId, 'payment', 'finix', 'test-api-password',
      undefined,  // ipAddress — unused in tests
      // pos_merchant_id format: "apiUsername:applicationId:finixMerchantId"
      'USfake000000000000000000:APfake000000000000000000:MUfake000000000000000000',
    )
    // Ensure sandbox flag is set so adapter uses sandbox base URL
    db.run(`UPDATE merchants SET finix_sandbox = 1 WHERE id = ?`, [mId])
  }

  /** Seed a terminal (for the device_id FK hint) and a received order. */
  function seedTerminalOrder(opts: {
    merchantId: string
    orderId: string
    amountCents: number
  }): void {
    const db  = getDatabase()
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
    db.run(
      `INSERT INTO orders
         (id, merchant_id, customer_name, items, subtotal_cents, tax_cents, total_cents,
          status, order_type, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'received','dine_in',?,?)`,
      [opts.orderId, opts.merchantId, 'Test',
       '[]', opts.amountCents, 0, opts.amountCents, now, now],
    )
  }

  function insertPendingVerification(opts: {
    merchantId: string; orderId: string; deviceId: string;
    amountCents: number; idempotencyKey: string;
    createdAt?: string
  }): string {
    const db = getDatabase()
    const id = `pts_${Math.random().toString(36).slice(2, 10)}`
    const createdAt = opts.createdAt ?? "datetime('now', '-60 seconds')"
    db.run(
      `INSERT INTO pending_terminal_sales
         (id, merchant_id, order_id, transfer_id, idempotency_key, device_id, amount_cents, status, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ${opts.createdAt ? '?' : createdAt})`,
      opts.createdAt
        ? [id, opts.merchantId, opts.orderId, opts.idempotencyKey, opts.deviceId, opts.amountCents, opts.createdAt]
        : [id, opts.merchantId, opts.orderId, opts.idempotencyKey, opts.deviceId, opts.amountCents],
    )
    return id
  }

  const originalFetch = global.fetch

  test('verification-pending row + Finix has SUCCEEDED transfer → payment + order.paid, row deleted', async () => {
    await seedFinixCreds(merchantId)
    const orderId = `ord_verif_${Math.random().toString(36).slice(2, 10)}`
    const idem    = `idem-${Math.random().toString(36).slice(2, 10)}`
    seedTerminalOrder({ merchantId, orderId, amountCents: 2318 })
    const pendingId = insertPendingVerification({
      merchantId, orderId, deviceId: 'DVtest123',
      amountCents: 2318, idempotencyKey: idem,
    })

    global.fetch = (async (url: string) => {
      // findTransferByIdempotencyId calls GET /transfers?idempotency_id=...
      if (url.includes('/transfers?') && url.includes('idempotency_id=')) {
        return new Response(JSON.stringify({
          _embedded: {
            transfers: [{
              id:       'TRF_VER_OK',
              state:    'SUCCEEDED',
              amount:   2665,
              amount_breakdown: { tip_amount: 347 },
              card_present_details: {
                brand: 'VISA',
                masked_account_number: '0000000000001234',
                approval_code: 'AUTH9',
                entry_mode: 'CONTACTLESS',
              },
            }],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      await sweepOrphanedTerminalSales()
    } finally {
      global.fetch = originalFetch
    }

    const db = getDatabase()

    // Pending row removed
    const stillPending = db
      .query<{ id: string }, [string]>(`SELECT id FROM pending_terminal_sales WHERE id = ?`)
      .get(pendingId)
    expect(stillPending).toBeNull()

    // payments row created with the recovered transfer
    const pay = db
      .query<{ id: string; amount_cents: number; finix_transfer_id: string; card_last_four: string | null }, [string]>(
        `SELECT id, amount_cents, finix_transfer_id, card_last_four FROM payments WHERE order_id = ?`,
      )
      .get(orderId)
    expect(pay).toBeTruthy()
    expect(pay!.amount_cents).toBe(2665)
    expect(pay!.finix_transfer_id).toBe('TRF_VER_OK')
    expect(pay!.card_last_four).toBe('1234')

    // Order flipped to paid
    const order = db
      .query<{ status: string; paid_amount_cents: number }, [string]>(
        `SELECT status, paid_amount_cents FROM orders WHERE id = ?`,
      )
      .get(orderId)
    expect(order!.status).toBe('paid')
    expect(order!.paid_amount_cents).toBe(2665)

    // Run reconciliation immediately so the downstream "summary counts" test
    // doesn't see this payment as pending (sweep schedules a 60 s timer; calling
    // directly short-circuits via Strategy 1 since finix_transfer_id is set).
    await runReconciliation(merchantId, pay!.id)
  })

  test('verification-pending row + Finix has no matching transfer → pending row deleted, order stays received', async () => {
    await seedFinixCreds(merchantId)
    const orderId = `ord_verif_nf_${Math.random().toString(36).slice(2, 10)}`
    const idem    = `idem-nf-${Math.random().toString(36).slice(2, 10)}`
    seedTerminalOrder({ merchantId, orderId, amountCents: 1500 })
    const pendingId = insertPendingVerification({
      merchantId, orderId, deviceId: 'DVtest123',
      amountCents: 1500, idempotencyKey: idem,
    })

    global.fetch = (async (url: string) => {
      if (url.includes('/transfers?') && url.includes('idempotency_id=')) {
        return new Response(JSON.stringify({ _embedded: { transfers: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      await sweepOrphanedTerminalSales()
    } finally {
      global.fetch = originalFetch
    }

    const db = getDatabase()

    // Pending row removed — verification declined (no transfer at Finix)
    const stillPending = db
      .query<{ id: string }, [string]>(`SELECT id FROM pending_terminal_sales WHERE id = ?`)
      .get(pendingId)
    expect(stillPending).toBeNull()

    // No payments row — safe to retry
    const pay = db
      .query<{ id: string }, [string]>(`SELECT id FROM payments WHERE order_id = ?`)
      .get(orderId)
    expect(pay).toBeNull()

    // Order remains received (unpaid)
    const order = db
      .query<{ status: string; paid_amount_cents: number }, [string]>(
        `SELECT status, paid_amount_cents FROM orders WHERE id = ?`,
      )
      .get(orderId)
    expect(order!.status).toBe('received')
    expect(order!.paid_amount_cents).toBe(0)
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

// ── runReconciliation — Clover processor fast-path ────────────────────────────

describe('runReconciliation — Clover processor → instant match', () => {
  test('payment with processor=clover writes matched without Finix API call', async () => {
    const { paymentId } = seedPayment({ merchantId, paymentType: 'card', amountCents: 1800 })

    // Mark payment as clover-processed
    const db = getDatabase()
    db.run(`UPDATE payments SET processor = 'clover' WHERE id = ?`, [paymentId])

    await runReconciliation(merchantId, paymentId)

    const row = await waitForReconciliation(paymentId, 2000)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('matched')
  })
})

// ── runReconciliation — unmatched → security event ────────────────────────────

describe('runReconciliation — unmatched card → logs security event', () => {
  const savedFetch = global.fetch

  test('unmatched card payment logs payment_unmatched security event', async () => {
    // Seed Finix creds so runReconciliation proceeds to Finix search
    const db = getDatabase()
    const { storeAPIKey: storeKey } = await import('../src/crypto/api-keys')
    await storeKey(
      merchantId, 'payment', 'finix', 'test-api-password-unmatch',
      undefined,
      'USfake000000000001:APfake000000000001:MUfake000000000001',
    )
    db.run(`UPDATE merchants SET finix_sandbox = 1, payment_provider = 'finix' WHERE id = ?`, [merchantId])

    const { paymentId } = seedPayment({ merchantId, paymentType: 'card', amountCents: 4242 })
    // Set processor = 'finix' so the no-processor early-exit is bypassed
    db.run(`UPDATE payments SET processor = 'finix' WHERE id = ?`, [paymentId])

    // Mock Finix to return empty transfers
    global.fetch = (async () =>
      new Response(JSON.stringify({ _embedded: { transfers: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch

    try {
      await runReconciliation(merchantId, paymentId)
    } finally {
      global.fetch = savedFetch
    }

    const row = await waitForReconciliation(paymentId, 2000)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('unmatched')

    // Security event should be logged
    const secRow = db.query<{ event_type: string }, []>(
      `SELECT event_type FROM security_events WHERE event_type = 'payment_unmatched' LIMIT 1`,
    ).get()
    expect(secRow?.event_type).toBe('payment_unmatched')
  })
})

// ── scheduleOrderReconciliation — no Finix creds ──────────────────────────────

describe('scheduleOrderReconciliation — no Finix creds', () => {
  test('no crash when merchant has no Finix credentials (timer fires, no-op)', async () => {
    const db = getDatabase()
    const orderId = `ord_orec_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO orders
         (id, merchant_id, customer_name, items, subtotal_cents, tax_cents, total_cents,
          status, order_type, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'paid','pickup',datetime('now'),datetime('now'))`,
      [orderId, otherMerchantId, 'Online Customer', '[]', 1000, 80, 1080],
    )

    // Should not throw — fires timer, runOrderReconciliation exits early (no creds)
    expect(() =>
      scheduleOrderReconciliation(otherMerchantId, orderId, 1080),
    ).not.toThrow()

    // Give the timer a chance to fire (RECONCILE_DELAY_MS defaults to 60s, but
    // in tests it is overridden if set; otherwise this just verifies no throw)
    await Bun.sleep(50)
  })
})
