/**
 * OOS (Out-of-Stock) ingredient shortcuts — route tests
 *
 * Covers all 11 endpoints in src/routes/oos.ts:
 *   GET    /oos/ingredients                              — list (all roles)
 *   POST   /oos/ingredients                             — create (owner/manager)
 *   PUT    /oos/ingredients/:ingId                      — rename (owner/manager)
 *   DELETE /oos/ingredients/:ingId                      — delete (owner/manager)
 *   POST   /oos/ingredients/:ingId/toggle               — 86/restore (all roles)
 *   POST   /oos/ingredients/:ingId/items                — link item (owner/manager)
 *   DELETE /oos/ingredients/:ingId/items/:itemId        — unlink item (owner/manager)
 *   POST   /oos/ingredients/:ingId/modifiers            — link modifier (owner/manager)
 *   DELETE /oos/ingredients/:ingId/modifiers/:modId     — unlink modifier (owner/manager)
 *   PATCH  /oos/items/:itemId/stock                     — set item stock (all roles)
 *   PATCH  /oos/modifiers/:modId/stock                  — set modifier stock (all roles)
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { generateId } from '../src/utils/id'

// ── fixtures ──────────────────────────────────────────────────────────────────

let ownerToken = ''
let staffToken = ''
let merchantId = ''
let itemId     = ''
let modGroupId = ''
let modId      = ''
let duckIngId  = ''  // shared between the two toggle cascade tests

// ── helpers ───────────────────────────────────────────────────────────────────

function base(path: string) {
  return `http://localhost:3000/api/merchants/${merchantId}${path}`
}

async function get(path: string, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(base(path), {
    headers: { Authorization: `Bearer ${token}` },
  }))
}

async function post(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(base(path), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

async function put(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(base(path), {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

async function del(path: string, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(base(path), {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }))
}

async function patch(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(base(path), {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

/** Helper: create an ingredient shortcut and return its id */
async function createIngredient(name: string): Promise<string> {
  const res  = await post('/oos/ingredients', { name })
  const body = await res.json() as { id: string }
  return body.id
}

/** Helper: read stock_status for a menu item directly from DB */
function itemStock(id: string): string {
  return getDatabase()
    .query<{ stock_status: string }, [string]>('SELECT stock_status FROM menu_items WHERE id = ?')
    .get(id)?.stock_status ?? 'unknown'
}

/** Helper: read stock_status for a modifier directly from DB */
function modStock(id: string): string {
  return getDatabase()
    .query<{ stock_status: string }, [string]>('SELECT stock_status FROM modifiers WHERE id = ?')
    .get(id)?.stock_status ?? 'unknown'
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

  // Register the merchant owner
  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@oos.test',
      password:     'SecurePass123!',
      fullName:     'OOS Owner',
      businessName: 'OOS Cafe',
      slug:         'oos-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  // Insert a server-role user and log in to get its token
  const db       = getDatabase()
  const staffId   = generateId('u')
  const staffHash = await Bun.password.hash('SecurePass123!')
  db.run(
    `INSERT INTO users (id, merchant_id, email, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 'staff', 1, datetime('now'))`,
    [staffId, merchantId, 'staff@oos.test', staffHash, 'OOS Staff']
  )
  const loginRes = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: 'staff@oos.test', password: 'SecurePass123!' }),
  }))
  const loginBody = await loginRes.json() as { tokens: { accessToken: string } }
  staffToken = loginBody.tokens.accessToken

  // Seed a category, a menu item, and a modifier so link tests have real IDs
  const categoryId = `cat_${generateId('').slice(0, 8)}`
  db.run(
    `INSERT INTO menu_categories (id, merchant_id, name, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Mains', 1, datetime('now'), datetime('now'))`,
    [categoryId, merchantId]
  )

  itemId = `item_${generateId('').slice(0, 8)}`
  db.run(
    `INSERT INTO menu_items
       (id, merchant_id, category_id, name, price_cents, is_available, stock_status, created_at, updated_at)
     VALUES (?, ?, ?, 'Pad Thai', 1400, 1, 'in_stock', datetime('now'), datetime('now'))`,
    [itemId, merchantId, categoryId]
  )

  modGroupId = `mg_${generateId('').slice(0, 8)}`
  db.run(
    `INSERT INTO modifier_groups (id, merchant_id, name, min_required, max_allowed, is_mandatory, created_at, updated_at)
     VALUES (?, ?, 'Spice', 0, 1, 0, datetime('now'), datetime('now'))`,
    [modGroupId, merchantId]
  )

  modId = `mod_${generateId('').slice(0, 8)}`
  db.run(
    `INSERT INTO modifiers (id, group_id, name, price_cents, is_available, stock_status, created_at, updated_at)
     VALUES (?, ?, 'Mild', 0, 1, 'in_stock', datetime('now'), datetime('now'))`,
    [modId, modGroupId]
  )
})

// ── GET /oos/ingredients ──────────────────────────────────────────────────────

describe('GET /oos/ingredients', () => {
  test('returns empty array when no ingredients exist', async () => {
    const res  = await get('/oos/ingredients')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual([])
  })

  test('returns ingredients with linked items and modifiers after creation and linking', async () => {
    // Create an ingredient and link the seeded item + modifier
    const ingId = await createIngredient('Avocado')
    await post(`/oos/ingredients/${ingId}/items`,     { itemId })
    await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: modId })

    const res  = await get('/oos/ingredients')
    const body = await res.json() as Array<{
      id: string; name: string; isOut: boolean;
      items: Array<{ id: string }>; modifiers: Array<{ id: string }>
    }>

    expect(res.status).toBe(200)
    const found = body.find((i) => i.id === ingId)
    expect(found).toBeDefined()
    expect(found!.name).toBe('Avocado')
    expect(found!.isOut).toBe(false)
    expect(found!.items.some((it) => it.id === itemId)).toBe(true)
    expect(found!.modifiers.some((m) => m.id === modId)).toBe(true)
  })

  test('is accessible to staff role', async () => {
    const res = await get('/oos/ingredients', staffToken)
    expect(res.status).toBe(200)
  })
})

// ── POST /oos/ingredients ─────────────────────────────────────────────────────

describe('POST /oos/ingredients', () => {
  test('creates a new ingredient and returns 201 with id + name', async () => {
    const res  = await post('/oos/ingredients', { name: 'Broccoli' })
    const body = await res.json() as { id: string; name: string; isOut: boolean; items: unknown[]; modifiers: unknown[] }
    expect(res.status).toBe(201)
    expect(body.id).toBeTruthy()
    expect(body.name).toBe('Broccoli')
    expect(body.isOut).toBe(false)
    expect(body.items).toEqual([])
    expect(body.modifiers).toEqual([])
  })

  test('returns 409 when ingredient name already exists', async () => {
    await post('/oos/ingredients', { name: 'DuplicateIng' })
    const res  = await post('/oos/ingredients', { name: 'DuplicateIng' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(409)
    expect(body.error).toContain('already exists')
  })

  test('returns 400 when name is missing', async () => {
    const res  = await post('/oos/ingredients', {})
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toContain('name')
  })

  test('returns 400 when name is whitespace-only', async () => {
    const res  = await post('/oos/ingredients', { name: '   ' })
    expect(res.status).toBe(400)
  })

  test('staff role cannot create ingredients (403)', async () => {
    const res = await post('/oos/ingredients', { name: 'ServerOnlyIng' }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── PUT /oos/ingredients/:ingId ───────────────────────────────────────────────

describe('PUT /oos/ingredients/:ingId', () => {
  test('renames an ingredient', async () => {
    const ingId = await createIngredient('OldName')
    const res   = await put(`/oos/ingredients/${ingId}`, { name: 'NewName' })
    const body  = await res.json() as { success: boolean }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  test('returns 404 for unknown ingredient id', async () => {
    const res  = await put('/oos/ingredients/ing_doesnotexist', { name: 'X' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(404)
    expect(body.error).toBeTruthy()
  })

  test('returns 400 when name is missing', async () => {
    const ingId = await createIngredient('RenameTarget')
    const res   = await put(`/oos/ingredients/${ingId}`, {})
    expect(res.status).toBe(400)
  })

  test('staff role cannot rename ingredients (403)', async () => {
    const ingId = await createIngredient('NoRenameByServer')
    const res   = await put(`/oos/ingredients/${ingId}`, { name: 'Renamed' }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── DELETE /oos/ingredients/:ingId ────────────────────────────────────────────

describe('DELETE /oos/ingredients/:ingId', () => {
  test('deletes an ingredient and returns success', async () => {
    const ingId = await createIngredient('DeleteMe')
    const res   = await del(`/oos/ingredients/${ingId}`)
    const body  = await res.json() as { success: boolean }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  test('returns 404 for unknown ingredient id', async () => {
    const res = await del('/oos/ingredients/ing_doesnotexist')
    expect(res.status).toBe(404)
  })

  test('staff role cannot delete ingredients (403)', async () => {
    const ingId = await createIngredient('NoDeleteByServer')
    const res   = await del(`/oos/ingredients/${ingId}`, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── POST /oos/ingredients/:ingId/toggle ───────────────────────────────────────

describe('POST /oos/ingredients/:ingId/toggle', () => {
  test('toggle to out cascades out_today to linked items and modifiers', async () => {
    duckIngId = await createIngredient('Duck')
    await post(`/oos/ingredients/${duckIngId}/items`,     { itemId })
    await post(`/oos/ingredients/${duckIngId}/modifiers`, { modifierId: modId })

    // Ensure starting state is in_stock
    getDatabase().run('UPDATE menu_items SET stock_status = ? WHERE id = ?', ['in_stock', itemId])
    getDatabase().run('UPDATE modifiers SET stock_status = ? WHERE id = ?', ['in_stock', modId])

    const res  = await post(`/oos/ingredients/${duckIngId}/toggle`, {})
    const body = await res.json() as { success: boolean; isOut: boolean; stockStatus: string }

    expect(res.status).toBe(200)
    expect(body.isOut).toBe(true)
    expect(body.stockStatus).toBe('out_today')
    expect(itemStock(itemId)).toBe('out_today')
    expect(modStock(modId)).toBe('out_today')
  })

  test('toggle back to in cascades in_stock to linked items and modifiers', async () => {
    // Re-uses duckIngId set by the previous test — no list search needed
    const res  = await post(`/oos/ingredients/${duckIngId}/toggle`, {})
    const body = await res.json() as { isOut: boolean; stockStatus: string }

    expect(res.status).toBe(200)
    expect(body.isOut).toBe(false)
    expect(body.stockStatus).toBe('in_stock')
    expect(itemStock(itemId)).toBe('in_stock')
    expect(modStock(modId)).toBe('in_stock')
  })

  test('toggle with zero linked items/modifiers still succeeds', async () => {
    const ingId = await createIngredient('EmptyIngredient')
    const res   = await post(`/oos/ingredients/${ingId}/toggle`, {})
    const body  = await res.json() as { success: boolean; isOut: boolean }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.isOut).toBe(true)
  })

  test('returns 404 for unknown ingredient id', async () => {
    const res = await post('/oos/ingredients/ing_doesnotexist/toggle', {})
    expect(res.status).toBe(404)
  })

  test('staff role can toggle (200)', async () => {
    const ingId = await createIngredient('ServerToggle')
    const res   = await post(`/oos/ingredients/${ingId}/toggle`, {}, staffToken)
    expect(res.status).toBe(200)
  })
})

// ── POST /oos/ingredients/:ingId/items ────────────────────────────────────────

describe('POST /oos/ingredients/:ingId/items', () => {
  test('links a menu item to an ingredient', async () => {
    const ingId = await createIngredient('ItemLinkIng')
    const res   = await post(`/oos/ingredients/${ingId}/items`, { itemId })
    const body  = await res.json() as { success: boolean; item: { id: string; name: string } }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.item.id).toBe(itemId)
    expect(body.item.name).toBeTruthy()
  })

  test('linking the same item twice is idempotent (INSERT OR IGNORE)', async () => {
    const ingId = await createIngredient('IdempotentLinkIng')
    await post(`/oos/ingredients/${ingId}/items`, { itemId })
    const res = await post(`/oos/ingredients/${ingId}/items`, { itemId })
    expect(res.status).toBe(200)
  })

  test('returns 404 when item belongs to a different merchant', async () => {
    const ingId    = await createIngredient('CrossMerchantItem')
    const foreignId = `item_${generateId('').slice(0, 8)}`
    // Do NOT insert this item — it simply doesn't belong to this merchant
    const res = await post(`/oos/ingredients/${ingId}/items`, { itemId: foreignId })
    expect(res.status).toBe(404)
  })

  test('returns 400 when itemId is missing', async () => {
    const ingId = await createIngredient('MissingItemId')
    const res   = await post(`/oos/ingredients/${ingId}/items`, {})
    expect(res.status).toBe(400)
  })

  test('returns 404 when ingredient not found', async () => {
    const res = await post('/oos/ingredients/ing_doesnotexist/items', { itemId })
    expect(res.status).toBe(404)
  })

  test('staff role cannot link items (403)', async () => {
    const ingId = await createIngredient('NoLinkByServer')
    const res   = await post(`/oos/ingredients/${ingId}/items`, { itemId }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── DELETE /oos/ingredients/:ingId/items/:itemId ──────────────────────────────

describe('DELETE /oos/ingredients/:ingId/items/:itemId', () => {
  test('unlinks a menu item from an ingredient', async () => {
    const ingId = await createIngredient('UnlinkItemIng')
    await post(`/oos/ingredients/${ingId}/items`, { itemId })

    const res  = await del(`/oos/ingredients/${ingId}/items/${itemId}`)
    const body = await res.json() as { success: boolean }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)

    // Verify the link is gone in the list
    const listRes  = await get('/oos/ingredients')
    const list     = await listRes.json() as Array<{ id: string; items: Array<{ id: string }> }>
    const found    = list.find((i) => i.id === ingId)
    expect(found?.items.some((it) => it.id === itemId)).toBe(false)
  })

  test('returns 404 when ingredient not found', async () => {
    const res = await del(`/oos/ingredients/ing_doesnotexist/items/${itemId}`)
    expect(res.status).toBe(404)
  })

  test('staff role cannot unlink items (403)', async () => {
    const ingId = await createIngredient('UnlinkServerBlock')
    await post(`/oos/ingredients/${ingId}/items`, { itemId })
    const res = await del(`/oos/ingredients/${ingId}/items/${itemId}`, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── POST /oos/ingredients/:ingId/modifiers ────────────────────────────────────

describe('POST /oos/ingredients/:ingId/modifiers', () => {
  test('links a modifier to an ingredient', async () => {
    const ingId = await createIngredient('ModLinkIng')
    const res   = await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: modId })
    const body  = await res.json() as { success: boolean; modifier: { id: string; name: string; groupName: string } }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.modifier.id).toBe(modId)
    expect(body.modifier.name).toBeTruthy()
    expect(body.modifier.groupName).toBeTruthy()
  })

  test('linking the same modifier twice is idempotent', async () => {
    const ingId = await createIngredient('IdempotentModIng')
    await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: modId })
    const res = await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: modId })
    expect(res.status).toBe(200)
  })

  test('returns 404 when modifier belongs to a different merchant', async () => {
    const ingId      = await createIngredient('CrossMerchantMod')
    const foreignMod = `mod_${generateId('').slice(0, 8)}`
    const res = await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: foreignMod })
    expect(res.status).toBe(404)
  })

  test('returns 400 when modifierId is missing', async () => {
    const ingId = await createIngredient('MissingModId')
    const res   = await post(`/oos/ingredients/${ingId}/modifiers`, {})
    expect(res.status).toBe(400)
  })

  test('staff role cannot link modifiers (403)', async () => {
    const ingId = await createIngredient('NoModLinkByServer')
    const res   = await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: modId }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── DELETE /oos/ingredients/:ingId/modifiers/:modifierId ──────────────────────

describe('DELETE /oos/ingredients/:ingId/modifiers/:modifierId', () => {
  test('unlinks a modifier from an ingredient', async () => {
    const ingId = await createIngredient('UnlinkModIng')
    await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: modId })

    const res  = await del(`/oos/ingredients/${ingId}/modifiers/${modId}`)
    const body = await res.json() as { success: boolean }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  test('returns 404 when ingredient not found', async () => {
    const res = await del(`/oos/ingredients/ing_doesnotexist/modifiers/${modId}`)
    expect(res.status).toBe(404)
  })

  test('staff role cannot unlink modifiers (403)', async () => {
    const ingId = await createIngredient('UnlinkModServerBlock')
    await post(`/oos/ingredients/${ingId}/modifiers`, { modifierId: modId })
    const res = await del(`/oos/ingredients/${ingId}/modifiers/${modId}`, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── PATCH /oos/items/:itemId/stock ────────────────────────────────────────────

describe('PATCH /oos/items/:itemId/stock', () => {
  test('sets stock to out_today', async () => {
    const res  = await patch(`/oos/items/${itemId}/stock`, { stockStatus: 'out_today' })
    const body = await res.json() as { success: boolean; itemId: string; stockStatus: string }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.stockStatus).toBe('out_today')
    expect(itemStock(itemId)).toBe('out_today')
  })

  test('sets stock to out_indefinitely', async () => {
    const res  = await patch(`/oos/items/${itemId}/stock`, { stockStatus: 'out_indefinitely' })
    const body = await res.json() as { stockStatus: string }
    expect(res.status).toBe(200)
    expect(body.stockStatus).toBe('out_indefinitely')
  })

  test('sets stock back to in_stock', async () => {
    const res  = await patch(`/oos/items/${itemId}/stock`, { stockStatus: 'in_stock' })
    const body = await res.json() as { stockStatus: string }
    expect(res.status).toBe(200)
    expect(body.stockStatus).toBe('in_stock')
    expect(itemStock(itemId)).toBe('in_stock')
  })

  test('returns 400 for invalid stockStatus value', async () => {
    const res  = await patch(`/oos/items/${itemId}/stock`, { stockStatus: 'bogus' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toBeTruthy()
  })

  test('returns 404 for unknown item id', async () => {
    const res = await patch('/oos/items/item_doesnotexist/stock', { stockStatus: 'out_today' })
    expect(res.status).toBe(404)
  })

  test('staff role can set item stock (200)', async () => {
    const res = await patch(`/oos/items/${itemId}/stock`, { stockStatus: 'out_today' }, staffToken)
    expect(res.status).toBe(200)
  })
})

// ── PATCH /oos/modifiers/:modifierId/stock ────────────────────────────────────

describe('PATCH /oos/modifiers/:modifierId/stock', () => {
  test('sets modifier stock to out_today', async () => {
    const res  = await patch(`/oos/modifiers/${modId}/stock`, { stockStatus: 'out_today' })
    const body = await res.json() as { success: boolean; modifierId: string; stockStatus: string }
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.stockStatus).toBe('out_today')
    expect(modStock(modId)).toBe('out_today')
  })

  test('sets modifier stock back to in_stock', async () => {
    const res  = await patch(`/oos/modifiers/${modId}/stock`, { stockStatus: 'in_stock' })
    const body = await res.json() as { stockStatus: string }
    expect(res.status).toBe(200)
    expect(body.stockStatus).toBe('in_stock')
    expect(modStock(modId)).toBe('in_stock')
  })

  test('returns 400 for invalid stockStatus value', async () => {
    const res  = await patch(`/oos/modifiers/${modId}/stock`, { stockStatus: 'nope' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toBeTruthy()
  })

  test('returns 404 for unknown modifier id', async () => {
    const res = await patch('/oos/modifiers/mod_doesnotexist/stock', { stockStatus: 'out_today' })
    expect(res.status).toBe(404)
  })

  test('staff role can set modifier stock (200)', async () => {
    const res = await patch(`/oos/modifiers/${modId}/stock`, { stockStatus: 'out_indefinitely' }, staffToken)
    expect(res.status).toBe(200)
  })
})
