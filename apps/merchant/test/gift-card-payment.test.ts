/**
 * Gift card payment tests
 *
 * Tests:
 *   GET  /api/merchants/:id/gift-cards/lookup?suffix=XYZ   — card lookup
 *   POST /api/merchants/:id/orders/:orderId/record-payment  — gift_card paymentType
 *
 * Uses app.fetch() with an in-memory DB.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { invalidateGiftCardMerchantCache } from '../src/routes/gift-cards'

// ── fixtures ──────────────────────────────────────────────────────────────────

let ownerToken = ''
let merchantId = ''

// ── helpers ───────────────────────────────────────────────────────────────────

/** Insert a minimal active order in status 'received'. Returns its ID. */
function insertOrder(opts: {
  status?: string
  subtotalCents?: number
  taxCents?: number
  totalCents?: number
} = {}): string {
  const db = getDatabase()
  const orderId = `ord_${Math.random().toString(36).slice(2, 14)}`
  const {
    status        = 'received',
    subtotalCents = 1000,
    taxCents      = 88,
    totalCents    = 1088,
  } = opts

  db.run(
    `INSERT INTO orders
       (id, merchant_id, customer_name, customer_phone, order_type,
        status, subtotal_cents, total_cents, tax_cents,
        items, created_at, updated_at)
     VALUES (?, ?, 'Test Customer', '555-0000', 'dine_in',
             ?, ?, ?, ?,
             '[]', datetime('now'), datetime('now'))`,
    [orderId, merchantId, status, subtotalCents, totalCents, taxCents]
  )
  return orderId
}

/**
 * Insert a gift card directly into the DB. Returns { cardId, code }.
 * Embedded tax at 10.4%: taxEmbedded = faceValue - Math.round(faceValue / 1.104)
 */
function insertGiftCard(opts: {
  faceValueCents?: number
  balanceCents?: number
  status?: string
  expiresAt?: string
} = {}): { cardId: string; code: string } {
  const db = getDatabase()
  const {
    faceValueCents = 5000,
    balanceCents   = 5000,
    status         = 'active',
    expiresAt      = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 19),
  } = opts
  const purchaseId = `gcp_${Math.random().toString(36).slice(2, 14)}`
  const netRevenue = Math.round(faceValueCents / 1.104)
  const taxEmbedded = faceValueCents - netRevenue
  db.run(
    `INSERT INTO gift_card_purchases
       (id, merchant_id, customer_name, customer_email, line_items_json, total_cents,
        net_revenue_cents, tax_embedded_cents, status)
     VALUES (?, ?, 'Test Buyer', 'buyer@test.com', '[]', ?, ?, ?, 'paid')`,
    [purchaseId, merchantId, faceValueCents, netRevenue, taxEmbedded]
  )
  const cardId = `gc_${Math.random().toString(36).slice(2, 14)}`
  const code   = `TST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  db.run(
    `INSERT INTO gift_cards
       (id, merchant_id, purchase_id, code, face_value_cents, balance_cents, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [cardId, merchantId, purchaseId, code, faceValueCents, balanceCents, status, expiresAt]
  )
  return { cardId, code }
}

/** POST record-payment. */
async function recordPayment(orderId: string, body: Record<string, unknown>) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/orders/${orderId}/record-payment`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify(body),
    }
  ))
}

/** GET gift card lookup. */
async function lookupGiftCard(suffix: string) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/gift-cards/lookup?suffix=${encodeURIComponent(suffix)}`,
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  ))
}

/** Fetch the current gift card state from the DB. */
function getCard(cardId: string) {
  return getDatabase()
    .query<{ balance_cents: number; status: string; redeemed_at: string | null }, [string]>(
      'SELECT balance_cents, status, redeemed_at FROM gift_cards WHERE id = ?'
    )
    .get(cardId)
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  invalidateGiftCardMerchantCache()
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
      email:        'owner@gc-payment.test',
      password:     'SecurePass123!',
      fullName:     'GC Owner',
      businessName: 'GC Cafe',
      slug:         'gc-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id
})

// ── Lookup endpoint ───────────────────────────────────────────────────────────

describe('GET /api/merchants/:id/gift-cards/lookup', () => {
  test('returns active card matching suffix', async () => {
    const { code } = insertGiftCard({ faceValueCents: 5000, balanceCents: 5000 })
    const suffix = code.slice(-4)
    const res  = await lookupGiftCard(suffix)
    expect(res.status).toBe(200)
    const body = await res.json() as { cards: Array<{ maskedCode: string; balanceCents: number; taxEmbeddedCents: number }> }
    expect(body.cards.length).toBeGreaterThanOrEqual(1)
    const card = body.cards.find(c => c.maskedCode.endsWith(suffix))
    expect(card).toBeDefined()
    expect(card!.balanceCents).toBe(5000)
    // Embedded tax: 5000 - Math.round(5000 / 1.104) = 5000 - 4529 = 471
    expect(card!.taxEmbeddedCents).toBe(471)
  })

  test('returns empty array when no match', async () => {
    const res  = await lookupGiftCard('ZZZZ')
    expect(res.status).toBe(200)
    const body = await res.json() as { cards: unknown[] }
    expect(body.cards).toEqual([])
  })

  test('excludes expired cards', async () => {
    const { code } = insertGiftCard({ expiresAt: '2020-01-01 00:00:00' })
    const suffix = code.slice(-4)
    const res  = await lookupGiftCard(suffix)
    expect(res.status).toBe(200)
    const body = await res.json() as { cards: unknown[] }
    expect(body.cards.length).toBe(0)
  })

  test('excludes depleted cards', async () => {
    const { code } = insertGiftCard({ balanceCents: 0, status: 'depleted' })
    const suffix = code.slice(-4)
    const res  = await lookupGiftCard(suffix)
    expect(res.status).toBe(200)
    const body = await res.json() as { cards: unknown[] }
    expect(body.cards.length).toBe(0)
  })

  test('returns 400 if suffix is not exactly 4 characters', async () => {
    const res3 = await lookupGiftCard('ABC')
    expect(res3.status).toBe(400)
    const res5 = await lookupGiftCard('ABCDE')
    expect(res5.status).toBe(400)
  })

  test('requires authentication', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/gift-cards/lookup?suffix=ABCD`
    ))
    expect(res.status).toBe(401)
  })
})

// ── Gift card payment — Case B (card covers full order) ───────────────────────

describe('record-payment: gift_card — Case B (card balance >= order total)', () => {
  test('debits card balance by exact order total', async () => {
    const { cardId } = insertGiftCard({ faceValueCents: 5000, balanceCents: 5000 })
    const orderId = insertOrder({ subtotalCents: 1000, taxCents: 88, totalCents: 1088 })
    // taxEmbedded for $50 card = 471 cents; order tax = 88 cents; offset = min(471, 88) = 88
    const res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,    // after offset tax becomes 0 (88 - 88)
      tipCents:               0,
      totalCents:             1088,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 88,
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { paymentId: string; isLastLeg: boolean }
    expect(body.isLastLeg).toBe(true)

    const card = getCard(cardId)
    expect(card!.balance_cents).toBe(5000 - 1088)
    expect(card!.status).toBe('active')  // balance > 0, stays active
  })

  test('sets card to depleted when balance reaches exactly 0', async () => {
    const { cardId } = insertGiftCard({ faceValueCents: 5000, balanceCents: 1088 })
    const orderId = insertOrder({ subtotalCents: 1000, taxCents: 88, totalCents: 1088 })
    const res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,
      tipCents:               0,
      totalCents:             1088,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 88,
    })
    expect(res.status).toBe(201)

    const card = getCard(cardId)
    expect(card!.balance_cents).toBe(0)
    expect(card!.status).toBe('depleted')
    expect(card!.redeemed_at).not.toBeNull()
  })

  test('order is marked paid on completion', async () => {
    const { cardId } = insertGiftCard({ faceValueCents: 5000, balanceCents: 5000 })
    const orderId = insertOrder({ subtotalCents: 1000, taxCents: 88, totalCents: 1088 })
    const res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,
      tipCents:               200,
      totalCents:             1288,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 88,
    })
    expect(res.status).toBe(201)

    const order = getDatabase()
      .query<{ status: string }, [string]>('SELECT status FROM orders WHERE id = ?')
      .get(orderId)
    expect(order!.status).toBe('paid')
  })

  test('gift_card_tax_offset_cents stored in payments row', async () => {
    const { cardId } = insertGiftCard({ faceValueCents: 5000, balanceCents: 5000 })
    const orderId = insertOrder({ subtotalCents: 1000, taxCents: 88, totalCents: 1088 })
    await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,
      tipCents:               0,
      totalCents:             1088,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 88,
    })
    const row = getDatabase()
      .query<{ gift_card_id: string; gift_card_tax_offset_cents: number }, [string]>(
        'SELECT gift_card_id, gift_card_tax_offset_cents FROM payments WHERE order_id = ?'
      )
      .get(orderId)
    expect(row!.gift_card_id).toBe(cardId)
    expect(row!.gift_card_tax_offset_cents).toBe(88)
  })
})

// ── Gift card payment — Case A (split: card leg + cash/card leg) ──────────────

describe('record-payment: gift_card — Case A (split, card balance < order total)', () => {
  test('leg 1 gift_card: card depleted, leg 2 cash: order paid', async () => {
    const { cardId } = insertGiftCard({ faceValueCents: 5000, balanceCents: 5000 })
    // Order total = $58.23; gift card = $50.00; remainder = $8.23
    const orderId = insertOrder({ subtotalCents: 5000, taxCents: 471, totalCents: 5823 })

    // Leg 1: gift card pays its $50.00 balance (split leg 1 of 2)
    const leg1Res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          4529,  // net revenue portion
      taxCents:               471,   // embedded tax
      tipCents:               0,
      totalCents:             5000,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 471,
      splitMode:              'gift_card',
      splitLegNumber:         1,
      splitTotalLegs:         2,
    })
    expect(leg1Res.status).toBe(201)
    const leg1Body = await leg1Res.json() as { isLastLeg: boolean }
    expect(leg1Body.isLastLeg).toBe(false)

    const cardAfterLeg1 = getCard(cardId)
    expect(cardAfterLeg1!.balance_cents).toBe(0)
    expect(cardAfterLeg1!.status).toBe('depleted')

    // Leg 2: cash pays the $8.23 remainder
    const leg2Res = await recordPayment(orderId, {
      paymentType:    'cash',
      subtotalCents:  823,
      taxCents:       0,
      tipCents:       0,
      totalCents:     823,
      splitMode:      'gift_card',
      splitLegNumber: 2,
      splitTotalLegs: 2,
    })
    expect(leg2Res.status).toBe(201)
    const leg2Body = await leg2Res.json() as { isLastLeg: boolean }
    expect(leg2Body.isLastLeg).toBe(true)

    const order = getDatabase()
      .query<{ status: string }, [string]>('SELECT status FROM orders WHERE id = ?')
      .get(orderId)
    expect(order!.status).toBe('paid')
  })
})

// ── Validation ────────────────────────────────────────────────────────────────

describe('record-payment: gift_card — validation', () => {
  test('returns 400 when giftCardId is missing', async () => {
    const orderId = insertOrder()
    const res = await recordPayment(orderId, {
      paymentType:   'gift_card',
      subtotalCents: 1000,
      taxCents:      88,
      tipCents:      0,
      totalCents:    1088,
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid paymentType', async () => {
    const orderId = insertOrder()
    const res = await recordPayment(orderId, {
      paymentType:   'crypto',
      subtotalCents: 1000,
      taxCents:      88,
      tipCents:      0,
      totalCents:    1088,
    })
    expect(res.status).toBe(400)
  })

  test('returns 404 when gift card does not exist', async () => {
    const orderId = insertOrder()
    const res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,
      tipCents:               0,
      totalCents:             1088,
      giftCardId:             'gc_nonexistent',
      giftCardTaxOffsetCents: 0,
    })
    expect(res.status).toBe(404)
  })

  test('returns 409 when gift card is expired', async () => {
    const { cardId } = insertGiftCard({ expiresAt: '2020-01-01 00:00:00' })
    const orderId = insertOrder()
    const res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,
      tipCents:               0,
      totalCents:             1088,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 0,
    })
    expect(res.status).toBe(409)
  })

  test('returns 409 when gift card is depleted', async () => {
    const { cardId } = insertGiftCard({ balanceCents: 0, status: 'depleted' })
    const orderId = insertOrder()
    const res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,
      tipCents:               0,
      totalCents:             1088,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 0,
    })
    expect(res.status).toBe(409)
  })

  test('returns 400 when giftCardTaxOffsetCents exceeds embedded tax', async () => {
    const { cardId } = insertGiftCard({ faceValueCents: 5000, balanceCents: 5000 })
    // $50 card has embedded tax of 471 cents; claiming 999 is invalid
    const orderId = insertOrder()
    const res = await recordPayment(orderId, {
      paymentType:            'gift_card',
      subtotalCents:          1000,
      taxCents:               0,
      tipCents:               0,
      totalCents:             1088,
      giftCardId:             cardId,
      giftCardTaxOffsetCents: 999,
    })
    expect(res.status).toBe(400)
  })
})
