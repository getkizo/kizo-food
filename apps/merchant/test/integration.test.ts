/**
 * Integration tests — v2 appliance routes
 *
 * Tests the full stack from HTTP request to DB persistence against
 * the v2 single-tenant appliance architecture. Uses app.fetch() directly
 * (no HTTP binding) with an in-memory SQLite database.
 *
 * Setup: registers a merchant via the auth API, creates a category and
 * item, then tests the public store API and the authenticated orders API.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

// Shared test state populated in beforeAll
let ownerToken = ''
let merchantId = ''
let testItemId = ''
let testCatId  = ''

beforeAll(async () => {
  // Force a fresh :memory: connection — all test files share the same Bun
  // worker, so the DB singleton may have been initialised by an earlier file.
  // Also clear the module-level merchant cache in store.ts.
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH          = ':memory:'
  process.env.NODE_ENV               = 'test'
  process.env.MASTER_KEY_PASSPHRASE  = 'TestPassword123!@#'
  process.env.JWT_SECRET             = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register owner + merchant
  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'owner@integration.test',
      password:     'SecurePass123!',
      fullName:     'Integration Owner',
      businessName: 'Integration Cafe',
      slug:         'integration-cafe',
    }),
  }))
  const regBody = await regRes.json()
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  // Create a menu category
  const catRes = await app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/menu/categories`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ name: 'Mains' }),
    }
  ))
  const catBody = await catRes.json()
  testCatId = catBody.id

  // Create a menu item in that category
  const itemRes = await app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/menu/items`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        categoryId:   testCatId,
        name:         'Test Dish',
        priceCents:   1200,
        availableOnline: true,
      }),
    }
  ))
  const itemBody = await itemRes.json()
  testItemId = itemBody.itemId
})

// ---------------------------------------------------------------------------
// Health & root endpoints
// ---------------------------------------------------------------------------

describe('Integration - Health & Status', () => {
  test('GET /health returns ok', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/health'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.database).toBe('connected')
    expect(body.masterKey).toBe('initialized')
  })

  test('GET / returns customer store HTML', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/'))
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toMatch(/text\/html/)
  })
})

// ---------------------------------------------------------------------------
// Customer-facing store API
// ---------------------------------------------------------------------------

describe('Integration - Store API', () => {
  test('GET /api/store/profile returns merchant profile', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/profile'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('Integration Cafe')
    expect(Array.isArray(body.businessHours)).toBe(true)
  })

  test('GET /api/store/menu returns menu with the seeded item', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/menu'))
    expect(res.status).toBe(200)
    const body = await res.json()
    // menu is an array of category objects, each with an items array
    expect(Array.isArray(body.menu)).toBe(true)
    const allItems = body.menu.flatMap((c: any) => c.items ?? [])
    const found = allItems.some((i: any) => i.id === testItemId)
    expect(found).toBe(true)
  })

  test('POST /api/store/orders places a valid order', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Jane Doe',
        items: [{ itemId: testItemId }],
      }),
    }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.orderId).toMatch(/^ord_/)
    expect(body.totalCents).toBeGreaterThan(0)
  })

  test('POST /api/store/orders with nonexistent item returns 400', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Jane Doe',
        items: [{ itemId: 'item_nonexistent' }],
      }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/not found/i)
  })
})

// ---------------------------------------------------------------------------
// Authenticated orders API (TD-2.5 / TC-N20 coverage)
// ---------------------------------------------------------------------------

describe('Integration - Orders API', () => {
  let placedOrderId = ''

  test('POST /api/store/orders stores an order we can later retrieve', async () => {
    const res = await app.fetch(new Request('http://localhost:3000/api/store/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerName: 'Auth Test Customer',
        items: [{ itemId: testItemId }],
      }),
    }))
    expect(res.status).toBe(201)
    placedOrderId = (await res.json()).orderId
    expect(placedOrderId).toMatch(/^ord_/)
  })

  test('TC-N20: GET /api/orders/:id without auth returns 401', async () => {
    const res = await app.fetch(
      new Request(`http://localhost:3000/api/orders/${placedOrderId}`)
    )
    expect(res.status).toBe(401)
  })

  test('GET /api/orders/:id with valid token returns order', async () => {
    const res = await app.fetch(
      new Request(`http://localhost:3000/api/orders/${placedOrderId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(placedOrderId)
    expect(body.customer.name).toBe('Auth Test Customer')
  })
})
