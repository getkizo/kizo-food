/**
 * Menu CRUD integration tests
 *
 * Covers categories, items, modifier-groups, and modifier options.
 * All operations go through app.fetch() against a fresh :memory: SQLite DB.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

let token      = ''
let merchantId = ''

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  const res  = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'owner@menu.test',
      password:     'SecurePass123!',
      fullName:     'Menu Owner',
      businessName: 'Menu Test Cafe',
      slug:         'menu-test-cafe',
    }),
  }))
  const body = await res.json()
  token      = body.tokens.accessToken
  merchantId = body.merchant.id
})

// ---------------------------------------------------------------------------
// GET menu hierarchy
// ---------------------------------------------------------------------------

describe('GET /api/merchants/:id/menu', () => {
  test('returns { categories, uncategorizedItems, allModifierGroups } for empty menu', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu`, {
      headers: { Authorization: `Bearer ${token}` },
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.categories)).toBe(true)
    expect(Array.isArray(body.uncategorizedItems)).toBe(true)
    expect(Array.isArray(body.allModifierGroups)).toBe(true)
  })

  test('returns categories with items after seeding', async () => {
    // Create a category + item first
    const catRes  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: 'Mains' }),
    }))
    const { id: catId } = await catRes.json()

    await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ categoryId: catId, name: 'Pad Thai', priceCents: 1400 }),
    }))

    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu`, {
      headers: { Authorization: `Bearer ${token}` },
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    const cat  = body.categories.find((c: { name: string }) => c.name === 'Mains')
    expect(cat).toBeTruthy()
    expect(cat.items.some((i: { name: string }) => i.name === 'Pad Thai')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Categories CRUD
// ---------------------------------------------------------------------------

describe('POST /api/merchants/:id/menu/categories', () => {
  test('creates category → 201 with { success, id, name }', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: 'Appetizers' }),
    }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(typeof body.id).toBe('string')
    expect(body.name).toBe('Appetizers')
  })

  test('empty name → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: '   ' }),
    }))
    expect(res.status).toBe(400)
  })

  test('missing name → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({}),
    }))
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/merchants/:id/menu/categories/:catId', () => {
  test('deletes existing category → 200 with { success, catId, itemsMoved }', async () => {
    const catRes = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: 'To Delete' }),
    }))
    const { id: catId } = await catRes.json()

    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/categories/${catId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.catId).toBe(catId)
    expect(typeof body.itemsMoved).toBe('number')
  })

  test('non-existent category → 404', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/categories/cat_nonexistent`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ))
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Items CRUD
// ---------------------------------------------------------------------------

describe('POST /api/merchants/:id/menu/items', () => {
  let catId = ''

  beforeAll(async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: 'Items Test Category' }),
    }))
    const body = await res.json()
    catId = body.id
  })

  test('creates item → 201 with { success, itemId }', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ categoryId: catId, name: 'Spring Roll', priceCents: 800 }),
    }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(typeof body.itemId).toBe('string')
  })

  test('missing name → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ categoryId: catId, priceCents: 800 }),
    }))
    expect(res.status).toBe(400)
  })

  test('negative priceCents → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ categoryId: catId, name: 'Bad Price', priceCents: -1 }),
    }))
    expect(res.status).toBe(400)
  })

  test('missing categoryId → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: 'No Cat', priceCents: 500 }),
    }))
    expect(res.status).toBe(400)
  })

  test('non-existent categoryId → 404', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ categoryId: 'cat_ghost', name: 'Ghost Item', priceCents: 500 }),
    }))
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/merchants/:id/menu/items/:itemId', () => {
  let catId  = ''
  let itemId = ''

  beforeAll(async () => {
    const catRes = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: 'Put Items Category' }),
    }))
    catId = (await catRes.json()).id

    const itemRes = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ categoryId: catId, name: 'Original Name', priceCents: 1000 }),
    }))
    itemId = (await itemRes.json()).itemId
  })

  test('updates name → 200 with { success, itemId }', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/items/${itemId}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ name: 'Updated Name' }),
      },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.itemId).toBe(itemId)
  })

  test('toggles stock_status to out_indefinitely → 200', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/items/${itemId}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ stockStatus: 'out_indefinitely' }),
      },
    ))
    expect(res.status).toBe(200)

    const db  = getDatabase()
    const row = db.query<{ stock_status: string }, [string]>(
      'SELECT stock_status FROM menu_items WHERE id = ?',
    ).get(itemId)
    expect(row?.stock_status).toBe('out_indefinitely')
  })

  test('non-existent item → 404', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/items/item_ghost`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ name: 'Ghost' }),
      },
    ))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/merchants/:id/menu/items/:itemId', () => {
  let catId  = ''
  let itemId = ''

  beforeAll(async () => {
    const catRes = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/categories`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ name: 'Delete Items Category' }),
    }))
    catId = (await catRes.json()).id

    const itemRes = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}/menu/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ categoryId: catId, name: 'To Delete Item', priceCents: 600 }),
    }))
    itemId = (await itemRes.json()).itemId
  })

  test('deletes item → 200 with { success, itemId }', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/items/${itemId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.itemId).toBe(itemId)
  })

  test('non-existent item → 404', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/items/item_ghost`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ))
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Modifier groups
// ---------------------------------------------------------------------------

describe('POST /api/merchants/:id/menu/modifier-groups', () => {
  test('creates group → 201 with { success, id }', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/modifier-groups`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ name: 'Spice Level' }),
      },
    ))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(typeof body.id).toBe('string')
  })

  test('missing name → 400', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/modifier-groups`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({}),
      },
    ))
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/merchants/:id/menu/modifier-groups/:groupId/options', () => {
  let groupId = ''

  beforeAll(async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/modifier-groups`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ name: 'Protein' }),
      },
    ))
    groupId = (await res.json()).id
  })

  test('sets options → 200 with { success, groupId, count }', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/modifier-groups/${groupId}/options`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          options: [
            { name: 'Chicken', priceCents: 0 },
            { name: 'Shrimp',  priceCents: 200 },
          ],
        }),
      },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.groupId).toBe(groupId)
    expect(body.count).toBe(2)
  })

  test('negative priceCents on option → 400', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/modifier-groups/${groupId}/options`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          options: [{ name: 'Bad', priceCents: -100 }],
        }),
      },
    ))
    expect(res.status).toBe(400)
  })

  test('non-existent group → 404', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/menu/modifier-groups/mg_ghost/options`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ options: [] }),
      },
    ))
    expect(res.status).toBe(404)
  })
})
