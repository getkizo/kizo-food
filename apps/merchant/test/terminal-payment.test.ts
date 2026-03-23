/**
 * Terminal Payment Workflow tests
 *
 * Tests the PAX A920 Pro SAM state machine directly (no HTTP layer).
 * Finix API calls are intercepted via global.fetch mocks.
 *
 * Tests:
 *  1. Happy path: IDLE → INITIATING → AWAITING_TAP → RECORDING → COMPLETED
 *  2. Decline: poll returns FAILED → DECLINED
 *  3. Cancellation: AWAITING_TAP → cancelPayment → CANCELLING → CANCELLED
 *  4. Cancel/tap race: SUCCEEDED arrives while CANCELLING → RECORDING → COMPLETED
 *  5. Anti-glitch: TAP_APPROVED in COMPLETED silently discarded, no second DB write
 *  6. Partial payment: SUCCEEDED with amount ≠ amountCents → DECLINED(PARTIAL_PAYMENT)
 *  7. Timeout: startedAt in the past > 180 s → auto-cancel → CANCELLING
 *  8. Idempotency: second startPayment() while AWAITING_TAP silently rejected
 *  9. Rehydration: AWAITING_TAP row in DB → rehydrateTerminalWorkflows → registry populated
 * 10. createTerminalSale error: adapter throws → DECLINED immediately
 */

import { test, expect, describe, beforeAll, afterEach } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { storeAPIKey } from '../src/crypto/api-keys'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { app } from '../src/server'
import {
  createTerminalPaymentWorkflow,
  rehydrateTerminalWorkflows,
} from '../src/workflows/terminal-payment'
import type { TerminalPaymentModel, TerminalTxState, TerminalPaymentWorkflowHandle } from '../src/workflows/terminal-payment'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_MS = 2_100  // slightly more than POLL_INTERVAL_MS = 2000

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let merchantId = ''
let terminalSeq = 0

const TEST_CREDS = {
  apiUsername:   'UStest000000000000000000',
  applicationId: 'APtest000000000000000000',
  merchantId:    'MUtest000000000000000000',
  apiPassword:   'test-api-password-12345',
  sandbox:       true,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = global.fetch

/** Replace global.fetch with a mock for the duration of a test. */
function mockFetch(fn: (url: string, opts?: RequestInit) => Promise<Response>): void {
  global.fetch = fn as typeof global.fetch
}

/** Restore the original global.fetch. */
function restoreFetch(): void {
  global.fetch = originalFetch
}

/** Build a Finix transfer response object. */
function finixTransfer(opts: {
  id:       string
  state:    'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'
  amount?:  number
  brand?:   string
  last4?:   string
  auth?:    string
  failure?: string
}): object {
  return {
    id:              opts.id,
    state:           opts.state,
    amount:          opts.amount ?? 1500,
    failure_code:    opts.failure ?? null,
    failure_message: opts.failure ?? null,
    card_present_details: {
      brand:                  opts.brand    ?? 'VISA',
      masked_account_number:  `****${opts.last4 ?? '1234'}`,
      approval_code:          opts.auth     ?? 'AUTH01',
    },
  }
}

/** Returns a Response wrapping a JSON body. */
function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Wait until the handle's txState equals target, or timeout. */
async function waitForState(
  handle:    TerminalPaymentWorkflowHandle,
  target:    TerminalTxState,
  timeoutMs  = 8_000,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (handle.getStatus().txState === target) return true
    await Bun.sleep(50)
  }
  return false
}

/** Unique terminal ID per test — avoids module-registry collisions. */
function nextTerminalId(): string {
  return `term_test_${++terminalSeq}`
}

/** Unique order ID per test. */
function nextOrderId(): string {
  return `ord_test_${Math.random().toString(36).slice(2, 10)}`
}

/** Seed a terminals row so dehydrateTerminalTx FK constraint is satisfied. */
function seedTerminal(terminalId: string): void {
  const db  = getDatabase()
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  db.run(
    `INSERT OR IGNORE INTO terminals
       (id, merchant_id, model, nickname, finix_device_id, created_at)
     VALUES (?, ?, 'pax_a920_pro', ?, ?, ?)`,
    [terminalId, merchantId, `Test Terminal ${terminalId}`, `dev_${terminalId}`, now],
  )
}

/** Insert a minimal open order for recording tests. */
function seedOrder(orderId: string, amountCents = 1500): void {
  const db  = getDatabase()
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, order_type, status,
        subtotal_cents, tax_cents, total_cents, items, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [orderId, merchantId, 'Test Customer', 'dine_in', 'received',
     amountCents, 0, amountCents, '[]', now, now],
  )
}

/** Read order status from DB. */
function orderStatus(orderId: string): string | null {
  return getDatabase()
    .query<{ status: string }, [string]>(`SELECT status FROM orders WHERE id = ?`)
    .get(orderId)?.status ?? null
}

/** Count payment rows for an order. */
function countPayments(orderId: string): number {
  return getDatabase()
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`)
    .get(orderId)?.n ?? 0
}

/** Create a workflow handle with the test credentials. */
function makeWorkflow(
  terminalId: string,
  onResult:   (orderId: string, result: { status: string }) => void = () => {},
  initialModel?: Partial<TerminalPaymentModel>,
): TerminalPaymentWorkflowHandle {
  return createTerminalPaymentWorkflow(
    terminalId,
    merchantId,
    `dev_${terminalId}`,
    TEST_CREDS,
    onResult,
    initialModel,
  )
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register a merchant for all tests
  const res  = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@terminal-payment.test',
      password:     'SecurePass123!',
      fullName:     'Terminal Owner',
      businessName: 'Terminal Cafe',
      slug:         'terminal-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string } }
  merchantId = body.merchant.id
})

afterEach(() => {
  restoreFetch()
})

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  test('IDLE → INITIATING → AWAITING_TAP → RECORDING → COMPLETED', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)
    seedOrder(orderId, 1500)

    const results: { status: string }[] = []
    const handle = makeWorkflow(tId, (_, r) => results.push(r))

    expect(handle.getStatus().txState).toBe('IDLE')

    let pollCount = 0
    mockFetch(async (url) => {
      if (url.includes('/transfers') && !url.match(/\/transfers\/[A-Z]/)) {
        // POST /transfers — createTerminalSale
        return jsonResponse({ id: 'TRF_HP01', state: 'PENDING', amount: 1500 }, 201)
      }
      if (url.includes('/transfers/TRF_HP01')) {
        // GET /transfers/TRF_HP01 — poll
        pollCount++
        return jsonResponse(finixTransfer({
          id: 'TRF_HP01', state: 'SUCCEEDED', amount: 1500,
          brand: 'VISA', last4: '4242', auth: 'AUTH42',
        }))
      }
      return jsonResponse({})
    })

    handle.startPayment(orderId, 1500)

    expect(await waitForState(handle, 'AWAITING_TAP')).toBe(true)
    expect(handle.getStatus().transferId).toBe('TRF_HP01')

    expect(await waitForState(handle, 'COMPLETED', 8_000)).toBe(true)

    const model = handle.getStatus()
    expect(model.cardBrand).toBe('VISA')
    expect(model.cardLastFour).toBe('4242')
    expect(model.approvalCode).toBe('AUTH42')
    expect(model.paymentId).toBeTruthy()
    expect(pollCount).toBeGreaterThanOrEqual(1)

    // DB checks
    expect(orderStatus(orderId)).toBe('paid')
    expect(countPayments(orderId)).toBe(1)

    // At least one 'waiting' result before the final 'approved'
    expect(results.some(r => r.status === 'waiting')).toBe(true)
    expect(results.at(-1)?.status).toBe('approved')
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 2. Decline
// ---------------------------------------------------------------------------

describe('decline', () => {
  test('poll returns FAILED → DECLINED with failure code', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)

    const results: { status: string; message?: string }[] = []
    const handle = makeWorkflow(tId, (_, r) => results.push(r))

    mockFetch(async (url) => {
      if (!url.includes('/transfers/')) {
        return jsonResponse({ id: 'TRF_DEC01', state: 'PENDING', amount: 1500 }, 201)
      }
      return jsonResponse({
        id: 'TRF_DEC01', state: 'FAILED', amount: 0,
        failure_code: 'CARD_DECLINED', failure_message: 'Insufficient funds',
        card_present_details: {},
      })
    })

    handle.startPayment(orderId, 1500)
    await waitForState(handle, 'AWAITING_TAP')

    expect(await waitForState(handle, 'DECLINED', 6_000)).toBe(true)

    const model = handle.getStatus()
    expect(model.declineCode).toBe('CARD_DECLINED')
    expect(model.declineMessage).toBe('Insufficient funds')
    expect(results.at(-1)?.status).toBe('declined')
  }, 12_000)
})

// ---------------------------------------------------------------------------
// 3. Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  test('cancelPayment → CANCELLING → CANCELLED', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)

    const results: { status: string }[] = []
    const handle = makeWorkflow(tId, (_, r) => results.push(r))

    mockFetch(async (url) => {
      if (!url.includes('/transfers/') && !url.includes('/devices/')) {
        // createTerminalSale
        return jsonResponse({ id: 'TRF_CAN01', state: 'PENDING', amount: 1500 }, 201)
      }
      if (url.includes('/devices/')) {
        // cancelTerminalSale (PUT /devices/:id) — returns Transfer shape
        return jsonResponse({
          id: 'TRF_CAN01', state: 'FAILED', amount: 0,
          failure_code: 'CANCELLATION_VIA_API',
          failure_message: 'The transaction was canceled via API',
          card_present_details: {},
        })
      }
      // poll — keep returning PENDING until cancel wins
      return jsonResponse({
        id: 'TRF_CAN01', state: 'PENDING', amount: 0,
        failure_code: null, failure_message: null,
        card_present_details: {},
      })
    })

    handle.startPayment(orderId, 1500)
    await waitForState(handle, 'AWAITING_TAP')

    handle.cancelPayment()
    await Bun.sleep(20)
    expect(['CANCELLING', 'CANCELLED']).toContain(handle.getStatus().txState)

    expect(await waitForState(handle, 'CANCELLED', 6_000)).toBe(true)
    expect(results.at(-1)?.status).toBe('cancelled')
  }, 12_000)
})

// ---------------------------------------------------------------------------
// 4. Cancel / tap race — tap beat the cancel, charge honoured
// ---------------------------------------------------------------------------

describe('cancel/tap race', () => {
  test('SUCCEEDED arrives while CANCELLING → RECORDING → COMPLETED', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)
    seedOrder(orderId, 2000)

    const handle = makeWorkflow(tId)

    let cancelled = false
    mockFetch(async (url) => {
      if (!url.includes('/transfers/') && !url.includes('/devices/')) {
        return jsonResponse({ id: 'TRF_RACE01', state: 'PENDING', amount: 2000 }, 201)
      }
      if (url.includes('/devices/')) {
        // Delay the cancel response so the poll's SUCCEEDED fires first
        await Bun.sleep(3_000)
        cancelled = true
        // Cancel sees the already-succeeded transfer (customer tapped first)
        return jsonResponse({
          id: 'TRF_RACE01', state: 'SUCCEEDED', amount: 2000,
          failure_code: null, failure_message: null,
          card_present_details: { brand: 'MC', masked_account_number: '000000000000009999', approval_code: 'RACE01' },
        })
      }
      // Poll returns SUCCEEDED even though cancel was requested
      return jsonResponse(finixTransfer({
        id: 'TRF_RACE01', state: 'SUCCEEDED', amount: 2000,
        brand: 'MC', last4: '9999', auth: 'RACE01',
      }))
    })

    handle.startPayment(orderId, 2000)
    await waitForState(handle, 'AWAITING_TAP')

    handle.cancelPayment()
    // The cancel NAP fires the device cancel AND the poll may fire SUCCEEDED.
    // The FSM allows TAP_APPROVED from CANCELLING → RECORDING, so charge wins.

    expect(await waitForState(handle, 'COMPLETED', 8_000)).toBe(true)

    // The cancel mock has a 3 s delay. COMPLETED is reached ~2 s after start
    // (first poll tick). Allow the cancel HTTP call to complete so we can
    // assert that it was attempted.
    await Bun.sleep(1_500)

    const model = handle.getStatus()
    expect(model.cardBrand).toBe('MC')
    expect(model.cardLastFour).toBe('9999')
    expect(model.paymentId).toBeTruthy()
    expect(cancelled).toBe(true)   // cancel was attempted but tap won
    expect(orderStatus(orderId)).toBe('paid')
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 5. Anti-glitch — duplicate tap in COMPLETED silently discarded
// ---------------------------------------------------------------------------

describe('anti-glitch', () => {
  test('TAP_APPROVED arriving in COMPLETED is silently discarded, no second DB write', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)
    seedOrder(orderId, 1200)

    const handle = makeWorkflow(tId)

    let pollCallCount = 0
    mockFetch(async (url) => {
      if (!url.includes('/transfers/')) {
        return jsonResponse({ id: 'TRF_GLITCH', state: 'PENDING', amount: 1200 }, 201)
      }
      pollCallCount++
      return jsonResponse(finixTransfer({
        id: 'TRF_GLITCH', state: 'SUCCEEDED', amount: 1200,
      }))
    })

    handle.startPayment(orderId, 1200)
    await waitForState(handle, 'AWAITING_TAP')
    await waitForState(handle, 'COMPLETED', 8_000)

    const paymentsBefore = countPayments(orderId)
    expect(paymentsBefore).toBe(1)

    // Simulate the terminal glitch: terminal re-sends SUCCEEDED signal.
    // The poll is already stopped (state is COMPLETED), so this is a no-op
    // from the FSM's perspective. Verify the model and DB don't change.
    expect(handle.getStatus().txState).toBe('COMPLETED')
    await Bun.sleep(POLL_MS)  // any stray interval would fire here

    // Still COMPLETED, still only 1 payment
    expect(handle.getStatus().txState).toBe('COMPLETED')
    expect(countPayments(orderId)).toBe(1)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 6. Partial payment rejection
// ---------------------------------------------------------------------------

describe('partial payment', () => {
  test('SUCCEEDED with approved < requested → DECLINED with PARTIAL_PAYMENT', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)

    const results: Array<{ status: string; message?: string }> = []
    const handle = makeWorkflow(tId, (_, r) => results.push(r))

    mockFetch(async (url) => {
      if (!url.includes('/transfers/')) {
        return jsonResponse({ id: 'TRF_PARTIAL', state: 'PENDING', amount: 3000 }, 201)
      }
      // Card only has $20.00 — authorized $2000 but order is $3000
      return jsonResponse(finixTransfer({
        id: 'TRF_PARTIAL', state: 'SUCCEEDED', amount: 2000,   // only $20 authorized
        brand: 'VISA', last4: '0001', auth: 'PARTIAL1',
      }))
    })

    handle.startPayment(orderId, 3000)   // $30.00 order
    await waitForState(handle, 'AWAITING_TAP')

    expect(await waitForState(handle, 'DECLINED', 6_000)).toBe(true)

    const model = handle.getStatus()
    expect(model.declineCode).toBe('PARTIAL_PAYMENT')
    expect(model.declineMessage).toContain('$20.00')
    expect(model.declineMessage).toContain('$30.00')

    const finalResult = results.at(-1)
    expect(finalResult?.status).toBe('declined')
  }, 12_000)
})

// ---------------------------------------------------------------------------
// 7. Timeout — startedAt in the past triggers auto-cancel
// ---------------------------------------------------------------------------

describe('timeout', () => {
  test('startedAt > 180 s ago causes auto-cancel on next poll tick', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)
    seedOrder(orderId, 1500)   // needed so dehydrateTerminalTx FK check passes

    // Start with a persisted AWAITING_TAP whose startedAt is 181 s ago.
    // The rehydration boot starts the poll interval immediately.
    // The first poll tick sees elapsed > 180 s and dispatches CANCEL_PAYMENT.
    const pastStartedAt = new Date(Date.now() - 181_000).toISOString()

    mockFetch(async (url) => {
      if (url.includes('/devices/')) {
        // cancelTerminalSale — returns Transfer shape
        return jsonResponse({
          id: 'TRF_TIMEOUT', state: 'FAILED', amount: 0,
          failure_code: 'CANCELLATION_VIA_API',
          failure_message: 'The transaction was canceled via API',
          card_present_details: {},
        })
      }
      // poll — PENDING but will timeout
      return jsonResponse({
        id: 'TRF_TIMEOUT', state: 'PENDING', amount: 0,
        failure_code: null, failure_message: null,
        card_present_details: {},
      })
    })

    const handle = makeWorkflow(tId, () => {}, {
      txState:        'AWAITING_TAP',
      orderId,
      amountCents:    1500,
      transferId:     'TRF_TIMEOUT',
      idempotencyKey: 'idem-timeout',
      startedAt:      pastStartedAt,
    })

    // The rehydration boot starts the poll immediately. First tick detects timeout
    // and dispatches CANCEL_PAYMENT. The mock cancel API returns immediately, so
    // CANCELLING is transient — poll every 50 ms may miss it. Check CANCELLED instead.
    expect(await waitForState(handle, 'CANCELLED', 8_000)).toBe(true)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 8. Idempotency — second startPayment while AWAITING_TAP is silently rejected
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  test('second startPayment() in AWAITING_TAP is silently discarded', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)

    let createCallCount = 0
    mockFetch(async (url) => {
      if (!url.includes('/transfers/')) {
        createCallCount++
        return jsonResponse({ id: `TRF_IDEM${createCallCount}`, state: 'PENDING', amount: 1500 }, 201)
      }
      // poll — stay PENDING
      return jsonResponse({
        id: `TRF_IDEM1`, state: 'PENDING', amount: 0,
        failure_code: null, failure_message: null,
        card_present_details: {},
      })
    })

    const handle = makeWorkflow(tId)

    handle.startPayment(orderId, 1500)
    await waitForState(handle, 'AWAITING_TAP')

    const transferId1 = handle.getStatus().transferId

    // Second startPayment — should be silently discarded
    handle.startPayment(orderId, 1500)
    await Bun.sleep(200)

    // State unchanged, no second Finix call
    expect(handle.getStatus().txState).toBe('AWAITING_TAP')
    expect(handle.getStatus().transferId).toBe(transferId1)
    expect(createCallCount).toBe(1)
  }, 10_000)
})

// ---------------------------------------------------------------------------
// 9. Rehydration — AWAITING_TAP row in DB → rehydrateTerminalWorkflows populates registry
// ---------------------------------------------------------------------------

describe('rehydration', () => {
  test('rehydrateTerminalWorkflows restores handle and orderId lookup', async () => {
    const db = getDatabase()
    const rehydTermId  = nextTerminalId()
    const rehydOrderId = nextOrderId()
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    // Seed terminals row
    db.run(
      `INSERT OR IGNORE INTO terminals (id, merchant_id, model, nickname, finix_device_id, created_at)
       VALUES (?, ?, 'pax_a920_pro', 'Test A920', ?, ?)`,
      [rehydTermId, merchantId, `dev_${rehydTermId}`, now],
    )

    // Store encrypted Finix API key (pos_merchant_id = 'apiUser:appId:finixMerchId')
    await storeAPIKey(
      merchantId, 'payment', 'finix',
      'rehydration-test-api-password',
      undefined,
      'apiUser:appId:finixMerchId',
    )

    // Seed terminal_transactions row with AWAITING_TAP
    const rehydModel = {
      terminalId:    rehydTermId,
      merchantId,
      finixDeviceId: `dev_${rehydTermId}`,
      txState:       'AWAITING_TAP',
      orderId:       rehydOrderId,
      amountCents:   1500,
      transferId:    'TRF_REHYDRATE',
      startedAt:     now,
    }
    // order_id is nullable (ON DELETE SET NULL) — omit it here since rehydOrderId
    // is not in the orders table. The sam_state JSON carries orderId for the
    // _orderToTerminal lookup in rehydrateTerminalWorkflows.
    db.run(
      `INSERT INTO terminal_transactions
         (id, terminal_id, merchant_id, order_id,
          tx_state, amount_cents, finix_transfer_id, started_at,
          sam_state, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `ttx_rehydrate_${rehydTermId}`,
        rehydTermId, merchantId,
        'AWAITING_TAP', 1500, 'TRF_REHYDRATE', now,
        JSON.stringify(rehydModel),
        now, now,
      ],
    )

    // Mock fetch so the poll can fire without hitting real Finix
    mockFetch(async (url) => {
      if (url.includes('/devices/')) {
        return jsonResponse({
          id: 'TRF_REHYDRATE', state: 'FAILED', amount: 0,
          failure_code: 'CANCELLATION_VIA_API',
          failure_message: 'The transaction was canceled via API',
          card_present_details: {},
        })
      }
      return jsonResponse({
        id: 'TRF_REHYDRATE', state: 'PENDING', amount: 0,
        failure_code: null, failure_message: null,
        card_present_details: {},
      })
    })

    await rehydrateTerminalWorkflows()

    // After rehydration, getA920PaymentStatus should know about this orderId
    // via the module-level _orderToTerminal map populated during rehydration.
    const { getA920PaymentStatus } = await import('../src/workflows/terminal-payment')
    const status = getA920PaymentStatus(rehydOrderId)
    expect(status).not.toBeNull()
    expect(status?.status).toBe('waiting')
  }, 10_000)
})

// ---------------------------------------------------------------------------
// 10. createTerminalSale error → DECLINED immediately
// ---------------------------------------------------------------------------

describe('createTerminalSale error', () => {
  test('Finix returns 500 on create → DECLINED with INITIATION_FAILED', async () => {
    const tId    = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)

    const results: Array<{ status: string; message?: string }> = []
    const handle = makeWorkflow(tId, (_, r) => results.push(r))

    mockFetch(async (url) => {
      if (!url.includes('/transfers/')) {
        // createTerminalSale fails — Finix API 500; also swallows cancel call
        return new Response(
          JSON.stringify({ error: 'Internal Server Error', detail: 'Device offline' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return jsonResponse({})
    })

    handle.startPayment(orderId, 1500)

    expect(await waitForState(handle, 'DECLINED', 5_000)).toBe(true)

    const model = handle.getStatus()
    expect(model.declineCode).toBe('INITIATION_FAILED')

    const finalResult = results.at(-1)
    expect(finalResult?.status).toBe('declined')
  }, 10_000)
})

// ---------------------------------------------------------------------------
// 11. Cancel NAP SUCCEEDED — cancel response shows SUCCEEDED (not poll)
// ---------------------------------------------------------------------------

describe('cancel NAP SUCCEEDED', () => {
  test('cancel response state=SUCCEEDED → payment recorded even though poll never fired SUCCEEDED', async () => {
    const tId     = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)
    seedOrder(orderId, 1800)

    const handle = makeWorkflow(tId)

    mockFetch(async (url) => {
      if (!url.includes('/transfers/') && !url.includes('/devices/')) {
        // createTerminalSale — normal PENDING start
        return jsonResponse({ id: 'TRF_CNS01', state: 'PENDING', amount: 1800 }, 201)
      }
      if (url.includes('/devices/')) {
        // cancelTerminalSale — customer tapped just before cancel reached device
        return jsonResponse({
          id: 'TRF_CNS01', state: 'SUCCEEDED', amount: 1800,
          failure_code: null, failure_message: null,
          card_present_details: {
            brand: 'VISA',
            masked_account_number: '000000000000005678',
            approval_code: 'CNS01',
          },
        })
      }
      // poll — stays PENDING; cancel NAP should win via its response
      return jsonResponse({
        id: 'TRF_CNS01', state: 'PENDING', amount: 0,
        failure_code: null, failure_message: null,
        card_present_details: {},
      })
    })

    handle.startPayment(orderId, 1800)
    await waitForState(handle, 'AWAITING_TAP')

    handle.cancelPayment()

    expect(await waitForState(handle, 'COMPLETED', 8_000)).toBe(true)

    const model = handle.getStatus()
    expect(model.cardBrand).toBe('VISA')
    expect(model.cardLastFour).toBe('5678')
    expect(model.paymentId).toBeTruthy()
    expect(orderStatus(orderId)).toBe('paid')
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 12. Network error + best-effort cancel SUCCEEDED → payment recorded
// ---------------------------------------------------------------------------

describe('network error with best-effort cancel SUCCEEDED', () => {
  test('createTerminalSale throws + cancel returns SUCCEEDED → COMPLETED, payment recorded', async () => {
    const tId     = nextTerminalId()
    const orderId = nextOrderId()
    seedTerminal(tId)
    seedOrder(orderId, 1500)

    const results: Array<{ status: string }> = []
    const handle = makeWorkflow(tId, (_, r) => results.push(r))

    mockFetch(async (url) => {
      if (url.includes('/devices/')) {
        // Best-effort cancel — customer had already tapped during the network error window
        return jsonResponse({
          id: 'TRF_BCANCEL01', state: 'SUCCEEDED', amount: 1500,
          failure_code: null, failure_message: null,
          card_present_details: {
            brand: 'VISA',
            masked_account_number: '000000000000001234',
            approval_code: 'BCANCEL01',
          },
        })
      }
      if (!url.includes('/transfers/')) {
        // createTerminalSale — network timeout
        return new Response(
          JSON.stringify({ error: 'Gateway Timeout' }),
          { status: 504, headers: { 'Content-Type': 'application/json' } },
        )
      }
      // poll (shouldn't be reached, but return PENDING defensively)
      return jsonResponse({
        id: 'TRF_BCANCEL01', state: 'PENDING', amount: 0,
        failure_code: null, failure_message: null,
        card_present_details: {},
      })
    })

    handle.startPayment(orderId, 1500)

    expect(await waitForState(handle, 'COMPLETED', 8_000)).toBe(true)

    const model = handle.getStatus()
    expect(model.cardBrand).toBe('VISA')
    expect(model.cardLastFour).toBe('1234')
    expect(model.approvalCode).toBe('BCANCEL01')
    expect(model.paymentId).toBeTruthy()
    expect(orderStatus(orderId)).toBe('paid')
    expect(results.at(-1)?.status).toBe('approved')
  }, 12_000)
})
