/**
 * CloverOrderClient unit tests
 *
 * All Clover HTTP calls are mocked via global `fetch` replacement so no real
 * network or database is touched.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { CloverOrderClient } from '../src/services/clover-order-client'
import type { KizoOrder } from '../src/services/clover-order-client'

// ---------------------------------------------------------------------------
// Minimal DB stub
// ---------------------------------------------------------------------------

function makeDb() {
  const runs: Array<[string, unknown[]]> = []
  const rows: Array<Record<string, unknown>> = []
  let queryGetRow: Record<string, unknown> | null = null

  return {
    _runs: runs,
    _rows: rows,
    run(_sql: string, params: unknown[] = []) {
      runs.push([_sql, params])
      return { changes: 1 }
    },
    query<T>(_sql: string) {
      return {
        all() {
          return rows as T[]
        },
        get() {
          return (queryGetRow ?? rows[0] ?? null) as T | null
        },
      }
    },
    /** Seed rows returned by query().all() */
    seedRows(data: Record<string, unknown>[]) {
      rows.splice(0, rows.length, ...data)
    },
    /** Override what query().get() returns (for merchant lookup in reconcile) */
    setGetRow(row: Record<string, unknown> | null) {
      queryGetRow = row
    },
  }
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type MockResponse = { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string>; headers?: Headers }

function mockFetch(responses: MockResponse[]) {
  let call = 0
  return mock((_url: string, _opts?: RequestInit) => {
    if (call >= responses.length) {
      throw new Error(
        `mockFetch: unexpected call #${call + 1} — only ${responses.length} response(s) registered`
      )
    }
    const res = responses[call++]
    return Promise.resolve({
      ok: res.ok,
      status: res.status,
      headers: res.headers ?? new Headers(),
      json: res.json ?? (() => Promise.resolve({})),
      text: res.text ?? (() => Promise.resolve('')),
    } as Response)
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORDER: KizoOrder = {
  id: 'ord_test_001',
  merchant_id: 'mer_test',
  customer_name: 'Test Customer',
  order_type: 'dine_in',
  notes: null,
  clover_order_id: null,
  items: [
    {
      dishName: 'Pad Thai',
      priceCents: 1400,
      quantity: 1,
      modifiers: [
        { name: 'Extra Spicy', priceCents: 0 },
        { name: 'Brown Rice', priceCents: 100 },
      ],
    },
    {
      dishName: 'Spring Roll',
      priceCents: 600,
      quantity: 2,
      modifiers: [],
    },
  ],
}

const CLOVER_ORDER_RESPONSE = { id: 'clv_ord_abc123' }

const PAID_ORDER_RESPONSE = {
  id: 'clv_ord_abc123',
  state: 'paid',
  total: 2100,
  payments: {
    elements: [
      {
        id: 'clv_pay_xyz',
        amount: 2100,
        result: 'SUCCESS',
        cardTransaction: { cardType: 'VISA', type: 'CREDIT' },
      },
    ],
  },
}

const DELETED_ORDER_RESPONSE = {
  id: 'clv_ord_abc123',
  state: 'deleted',
  total: 0,
  payments: { elements: [] },
}

const OPEN_ORDER_RESPONSE = {
  id: 'clv_ord_abc123',
  state: 'open',
  total: 0,
  payments: { elements: [] },
}

// ---------------------------------------------------------------------------
// Shared client + env setup
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch
let originalEnv: NodeJS.ProcessEnv

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalEnv = { ...process.env }
  process.env.CLOVER_MERCHANT_ID = 'mer_clover_test'
  process.env.CLOVER_API_TOKEN   = 'tok_test'
  process.env.CLOVER_SANDBOX     = 'true'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = originalEnv
})

// ---------------------------------------------------------------------------
// isEnabled
// ---------------------------------------------------------------------------

describe('isEnabled()', () => {
  it('returns true when env vars are set', () => {
    const client = new CloverOrderClient()
    expect(client.isEnabled()).toBe(true)
  })

  it('returns false when CLOVER_MERCHANT_ID is missing', () => {
    delete process.env.CLOVER_MERCHANT_ID
    const client = new CloverOrderClient()
    expect(client.isEnabled()).toBe(false)
  })

  it('returns false when CLOVER_API_TOKEN is missing', () => {
    delete process.env.CLOVER_API_TOKEN
    const client = new CloverOrderClient()
    expect(client.isEnabled()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 1: pushOrder — creates order + posts line items + persists clover_order_id
// ---------------------------------------------------------------------------

describe('pushOrder()', () => {
  it('Test 1: creates Clover order, posts line items, persists clover_order_id', async () => {
    // 1 POST for order create + 3 POST for line items (Pad Thai×1, Spring Roll×2)
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, json: () => Promise.resolve(CLOVER_ORDER_RESPONSE) },
      { ok: true, status: 200, json: () => Promise.resolve({ id: 'li_1' }) },
      { ok: true, status: 200, json: () => Promise.resolve({ id: 'li_2' }) },
      { ok: true, status: 200, json: () => Promise.resolve({ id: 'li_3' }) },
    ]) as unknown as typeof globalThis.fetch

    const db = makeDb()
    const client = new CloverOrderClient()
    const result = await client.pushOrder(ORDER, db as never)

    expect(result.cloverOrderId).toBe('clv_ord_abc123')

    // DB should have been updated with the Clover order ID
    expect(db._runs.length).toBe(1)
    expect(db._runs[0][0]).toContain('UPDATE orders SET clover_order_id')
    expect(db._runs[0][1]).toEqual(['clv_ord_abc123', 'ord_test_001'])
  })

  // Test 2: idempotency
  it('Test 2: idempotency — skips Clover call if clover_order_id already set', async () => {
    const fetchMock = mockFetch([]) as unknown as typeof globalThis.fetch
    globalThis.fetch = fetchMock

    const db = makeDb()
    const client = new CloverOrderClient()
    const orderWithId = { ...ORDER, clover_order_id: 'clv_ord_existing' }
    const result = await client.pushOrder(orderWithId, db as never)

    expect(result.cloverOrderId).toBe('clv_ord_existing')
    // fetch must never have been called
    expect((fetchMock as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })

  // Test 3: modifier flattening
  it('Test 3: modifier flattening — name and price correctly merged', async () => {
    const capturedBodies: unknown[] = []

    globalThis.fetch = mock((_url: string, opts?: RequestInit) => {
      if (opts?.body) capturedBodies.push(JSON.parse(opts.body as string))
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ id: `mock_${capturedBodies.length}` }),
        text: () => Promise.resolve(''),
      } as Response)
    }) as unknown as typeof globalThis.fetch

    const db = makeDb()
    const client = new CloverOrderClient()
    const singleItemOrder: KizoOrder = {
      ...ORDER,
      items: [
        {
          dishName: 'Pad Thai',
          priceCents: 1400,
          quantity: 1,
          modifiers: [
            { name: 'Extra Spicy', priceCents: 0 },
            { name: 'Brown Rice', priceCents: 100 },
          ],
        },
      ],
    }

    await client.pushOrder(singleItemOrder, db as never)

    // capturedBodies[0] = order create, capturedBodies[1] = line item
    expect(capturedBodies[1]).toMatchObject({
      name: 'Pad Thai – Extra Spicy, Brown Rice',
      price: 1500, // 1400 + 100
    })
  })

  // Test 4: 429 retry
  it('Test 4: 429 retry — backs off and retries up to 3 times', async () => {
    let attempts = 0
    globalThis.fetch = mock(() => {
      attempts++
      if (attempts <= 2) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '0' }),
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('Rate limited'),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ id: 'clv_ord_retry' }),
        text: () => Promise.resolve(''),
      } as Response)
    }) as unknown as typeof globalThis.fetch

    const db = makeDb()
    const client = new CloverOrderClient()
    // pushOrder only — single item, no modifiers to avoid extra line item calls
    const simpleOrder: KizoOrder = {
      ...ORDER,
      items: [{ dishName: 'Fried Rice', priceCents: 1000, quantity: 1, modifiers: [] }],
    }

    const result = await client.pushOrder(simpleOrder, db as never)

    expect(result.cloverOrderId).toBe('clv_ord_retry')
    expect(attempts).toBeGreaterThanOrEqual(3)
  }, 15_000)

  // Test 5: fire-and-forget — Clover unreachable does not throw to caller
  it('Test 5: Clover unreachable — pushOrder rejects (caller uses .catch to handle)', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch

    const db = makeDb()
    const client = new CloverOrderClient()

    // pushOrder itself will throw — fire-and-forget is enforced at the call site
    // (route handler wraps in .catch). Here we verify the rejection propagates cleanly.
    await expect(client.pushOrder(ORDER, db as never)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test 6–8: waitForPayment
// ---------------------------------------------------------------------------

describe('waitForPayment()', () => {
  it('Test 6: polls until state === paid, returns payment fields', async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, json: () => Promise.resolve(OPEN_ORDER_RESPONSE) },
      { ok: true, status: 200, json: () => Promise.resolve(PAID_ORDER_RESPONSE) },
    ]) as unknown as typeof globalThis.fetch

    const client = new CloverOrderClient()
    const result = await client.waitForPayment('clv_ord_abc123', { intervalMs: 1, timeoutMs: 5_000 })

    expect(result).toMatchObject({
      status: 'paid',
      paymentId: 'clv_pay_xyz',
      paymentMethod: 'CREDIT',
      totalCents: 2100,
    })
  })

  it('Test 7: returns { status: cancelled } when state === deleted', async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, json: () => Promise.resolve(DELETED_ORDER_RESPONSE) },
    ]) as unknown as typeof globalThis.fetch

    const client = new CloverOrderClient()
    const result = await client.waitForPayment('clv_ord_abc123', { intervalMs: 1, timeoutMs: 5_000 })

    expect(result).toEqual({ status: 'cancelled' })
  })

  it('Test 8: returns { status: timeout } after timeout', async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, json: () => Promise.resolve(OPEN_ORDER_RESPONSE) },
    ]) as unknown as typeof globalThis.fetch

    const client = new CloverOrderClient()
    // Very short timeout — should expire after one poll
    const result = await client.waitForPayment('clv_ord_abc123', { intervalMs: 50, timeoutMs: 10 })

    expect(result).toEqual({ status: 'timeout' })
  })
})

// ---------------------------------------------------------------------------
// Test 9–10: reconcile
// ---------------------------------------------------------------------------

describe('reconcile()', () => {
  it('Test 9: marks paid Clover orders in DB with payment fields', async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, json: () => Promise.resolve(PAID_ORDER_RESPONSE) },
    ]) as unknown as typeof globalThis.fetch

    const db = makeDb()
    db.setGetRow({ id: 'mer_test' })
    db.seedRows([
      { id: 'ord_001', clover_order_id: 'clv_ord_abc123', status: 'received' },
    ])

    const client = new CloverOrderClient()
    await client.reconcile(db as never)

    // Should have run UPDATE with payment fields + INSERT into payments
    expect(db._runs.length).toBe(2)
    expect(db._runs[0][0]).toContain('SET clover_payment_id')
    expect(db._runs[0][1]).toEqual(['clv_pay_xyz', 'CREDIT', 2100, 0, 0, 'ord_001'])
  })

  it('Test 10: continues after individual item failure (non-fatal)', async () => {
    let call = 0
    globalThis.fetch = mock(() => {
      call++
      if (call === 1) return Promise.reject(new Error('Network error'))
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(PAID_ORDER_RESPONSE),
        text: () => Promise.resolve(''),
      } as Response)
    }) as unknown as typeof globalThis.fetch

    const db = makeDb()
    db.setGetRow({ id: 'mer_test' })
    db.seedRows([
      { id: 'ord_001', clover_order_id: 'clv_ord_fail', status: 'received' },
      { id: 'ord_002', clover_order_id: 'clv_ord_abc123', status: 'received' },
    ])

    const client = new CloverOrderClient()
    // Should not throw even though first order fails
    await expect(client.reconcile(db as never)).resolves.toBeUndefined()

    // Second order should have been reconciled successfully (UPDATE + INSERT = 2 runs)
    expect(db._runs.length).toBe(2)
    expect(db._runs[0][1]).toContain('ord_002')
  })
})
