/**
 * Processor fee sweep tests (TCG-23)
 *
 * Covers:
 *   sweepUnfilledProcessorFees — candidate selection, no-creds path, timing guard
 *   startProcessorFeeSweep — no-op in test environment
 *
 * Note: paths that invoke listFeesByTransfer (settled / not-settled / throws)
 * require mocking the Finix adapter and are covered by integration tests.
 * The unit tests here focus on DB selection logic and the no-credentials branch.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { sweepUnfilledProcessorFees, startProcessorFeeSweep } from '../src/services/processor-fees'
import { storeAPIKey } from '../src/crypto/api-keys'
import { generateId } from '../src/utils/id'
import { app } from '../src/server'

// ── fixtures ──────────────────────────────────────────────────────────────────

let merchantId = ''

// ── helpers ───────────────────────────────────────────────────────────────────

/** Seed a payment row and return its id. Pass `ageHours` to backdate created_at. */
function seedPayment(opts: {
  ageHours?: number
  finixTransferId?: string | null
  processorFeeCents?: number | null
}): string {
  const db         = getDatabase()
  const paymentId  = generateId('pay')
  const orderId    = generateId('ord')
  const ageHours   = opts.ageHours ?? 30
  const createdAt  = `datetime('now', '-${ageHours} hours')`

  // Minimal order row required by FK
  db.run(
    `INSERT INTO orders (id, merchant_id, customer_name, items, subtotal_cents, tax_cents, total_cents, created_at, updated_at)
     VALUES (?, ?, 'Test', '[]', 1000, 0, 1000, ${createdAt}, ${createdAt})`,
    [orderId, merchantId],
  )

  db.run(
    `INSERT INTO payments
       (id, order_id, merchant_id, payment_type, amount_cents, subtotal_cents, tax_cents,
        finix_transfer_id, processor_fee_cents, created_at)
     VALUES (?, ?, ?, 'card', 1000, 1000, 0, ?, ?, ${createdAt})`,
    [
      paymentId,
      orderId,
      merchantId,
      opts.finixTransferId !== undefined ? opts.finixTransferId : `xfr_${generateId('').slice(0, 8)}`,
      opts.processorFeeCents !== undefined ? opts.processorFeeCents : null,
    ],
  )

  return paymentId
}

/** Read processor_fee_cents for a payment directly from the DB. Returns undefined when no row found. */
function getProcessorFee(paymentId: string): number | null | undefined {
  const row = getDatabase()
    .query<{ processor_fee_cents: number | null }, [string]>(
      'SELECT processor_fee_cents FROM payments WHERE id = ?',
    )
    .get(paymentId)
  if (!row) return undefined
  return row.processor_fee_cents
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

  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@fees.test',
      password:     'SecurePass123!',
      fullName:     'Fees Owner',
      businessName: 'Fees Cafe',
      slug:         'fees-cafe',
    }),
  }))
  const regBody = await regRes.json() as { merchant: { id: string } }
  merchantId = regBody.merchant.id
})

// ── startProcessorFeeSweep ────────────────────────────────────────────────────

describe('startProcessorFeeSweep', () => {
  test('returns a no-op cleanup in NODE_ENV=test (no timers registered)', () => {
    // process.env.NODE_ENV is 'test' in beforeAll, so this should return immediately
    const cleanup = startProcessorFeeSweep()
    expect(typeof cleanup).toBe('function')
    // Calling the cleanup should not throw
    expect(() => cleanup()).not.toThrow()
  })
})

// ── sweepUnfilledProcessorFees — candidate selection ─────────────────────────

describe('sweepUnfilledProcessorFees — candidate selection', () => {
  test('does nothing when no payments exist', async () => {
    // Fresh DB — no payments at all
    await expect(sweepUnfilledProcessorFees()).resolves.toBeUndefined()
  })

  test('skips payments with null finix_transfer_id', async () => {
    const paymentId = seedPayment({ ageHours: 48, finixTransferId: null })
    await sweepUnfilledProcessorFees()
    // processor_fee_cents must remain NULL — payment was not a candidate
    expect(getProcessorFee(paymentId)).toBe(null)
  })

  test('skips payments with empty-string finix_transfer_id', async () => {
    const paymentId = seedPayment({ ageHours: 48, finixTransferId: '' })
    await sweepUnfilledProcessorFees()
    expect(getProcessorFee(paymentId)).toBe(null)
  })

  test('skips payments created within the last 24 hours', async () => {
    const paymentId = seedPayment({ ageHours: 12 })
    await sweepUnfilledProcessorFees()
    // Payment is only 12h old — must not be touched
    expect(getProcessorFee(paymentId)).toBe(null)
  })

  test('skips payments that already have processor_fee_cents set', async () => {
    const paymentId = seedPayment({ ageHours: 48, processorFeeCents: 250 })
    await sweepUnfilledProcessorFees()
    // Fee was already filled — value must not change
    expect(getProcessorFee(paymentId)).toBe(250)
  })
})

// ── sweepUnfilledProcessorFees — no Finix credentials ────────────────────────

describe('sweepUnfilledProcessorFees — merchant with no Finix API key', () => {
  test('sets processor_fee_cents = 0 when merchant has no Finix credentials', async () => {
    // Merchant has no api_keys row for 'payment'/'finix' — loadFinixCreds returns null
    const paymentId = seedPayment({ ageHours: 48 })
    await sweepUnfilledProcessorFees()
    // No creds → guard path → fee written as 0
    expect(getProcessorFee(paymentId)).toBe(0)
  })

  test('sets to 0 even with a payment key whose pos_merchant_id is malformed', async () => {
    // Store a key but with an invalid pos_merchant_id (not three colon-separated parts)
    await storeAPIKey(merchantId, 'payment', 'finix', 'test-password')
    const db = getDatabase()
    db.run(
      `UPDATE api_keys SET pos_merchant_id = 'badformat'
        WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`,
      [merchantId],
    )

    const paymentId = seedPayment({ ageHours: 48 })
    await sweepUnfilledProcessorFees()
    // pos_merchant_id has wrong shape → parts.length !== 3 → returns null → fee = 0
    expect(getProcessorFee(paymentId)).toBe(0)

    // Clean up: remove the bad key so later tests start clean
    db.run(
      `DELETE FROM api_keys WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`,
      [merchantId],
    )
  })
})

// ── sweepUnfilledProcessorFees — credentials cached per merchant ──────────────

describe('sweepUnfilledProcessorFees — credentials caching', () => {
  test('processes multiple payments for the same merchant without error', async () => {
    // Both payments are > 24h old, no Finix creds → both get fee = 0
    const p1 = seedPayment({ ageHours: 30 })
    const p2 = seedPayment({ ageHours: 36 })

    await sweepUnfilledProcessorFees()

    // Both should be resolved (to 0 since no creds) — creds are cached after first lookup
    expect(getProcessorFee(p1)).toBe(0)
    expect(getProcessorFee(p2)).toBe(0)
  })
})
