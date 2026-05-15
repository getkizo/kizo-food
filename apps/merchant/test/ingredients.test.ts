/**
 * ingredients.ts route tests (TCG-16)
 *
 * Covers:
 *   Extra ingredients CRUD (GET / POST / PUT / DELETE)
 *   Ingredient aliases CRUD (GET / POST / PUT / DELETE)
 *   AI key management (GET status / POST / DELETE)
 *   Instruction log (GET /instruction-log)
 *   Role gates: owner/manager CRUD, owner-only for AI key, staff denied
 *   Validation: required fields, valid category, duplicate detection
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { generateId } from '../src/utils/id'

// ── fixtures ──────────────────────────────────────────────────────────────────

let ownerToken   = ''
let managerToken = ''
let staffToken   = ''
let merchantId   = ''

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

/** Create an extra ingredient and return its id */
async function createIngredient(
  name: string,
  opts: { category?: string; priceCents?: number; displayName?: string } = {},
): Promise<string> {
  const res  = await post('/ingredients', {
    name,
    category:    opts.category  ?? 'other',
    priceCents:  opts.priceCents ?? 0,
    displayName: opts.displayName,
  })
  const body = await res.json() as { id: string }
  return body.id
}

/** Create an ingredient alias and return its id */
async function createAlias(aliasText: string, ingredientId?: string): Promise<string> {
  const res  = await post('/ingredient-aliases', { aliasText, ingredientId })
  const body = await res.json() as { id: string }
  return body.id
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
      email:        'owner@ingr.test',
      password:     'SecurePass123!',
      fullName:     'Ingr Owner',
      businessName: 'Ingr Cafe',
      slug:         'ingr-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  const db = getDatabase()

  // Insert a manager-role user
  const managerId   = generateId('u')
  const managerHash = await Bun.password.hash('SecurePass123!')
  db.run(
    `INSERT INTO users (id, merchant_id, email, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 'manager', 1, datetime('now'))`,
    [managerId, merchantId, 'manager@ingr.test', managerHash, 'Ingr Manager']
  )
  const mgrLogin = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: 'manager@ingr.test', password: 'SecurePass123!' }),
  }))
  const mgrBody = await mgrLogin.json() as { tokens: { accessToken: string } }
  managerToken = mgrBody.tokens.accessToken

  // Insert a staff-role user
  const staffId   = generateId('u')
  const staffHash = await Bun.password.hash('SecurePass123!')
  db.run(
    `INSERT INTO users (id, merchant_id, email, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 'staff', 1, datetime('now'))`,
    [staffId, merchantId, 'staff@ingr.test', staffHash, 'Ingr Staff']
  )
  const staffLogin = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: 'staff@ingr.test', password: 'SecurePass123!' }),
  }))
  const staffBody = await staffLogin.json() as { tokens: { accessToken: string } }
  staffToken = staffBody.tokens.accessToken
})

// ── GET /ingredients ──────────────────────────────────────────────────────────

describe('GET /ingredients', () => {
  test('returns empty list initially', async () => {
    const res  = await get('/ingredients')
    const body = await res.json() as { ingredients: unknown[] }
    expect(res.status).toBe(200)
    expect(body.ingredients).toEqual([])
  })

  test('returns created ingredients sorted by category then name', async () => {
    await createIngredient('zucchini', { category: 'vegetable' })
    await createIngredient('avocado',  { category: 'vegetable' })

    const res  = await get('/ingredients')
    const body = await res.json() as { ingredients: Array<{ name: string; category: string }> }
    expect(res.status).toBe(200)

    const veg = body.ingredients.filter((i) => i.category === 'vegetable')
    const names = veg.map((i) => i.name)
    // avocado comes before zucchini alphabetically
    expect(names.indexOf('avocado')).toBeLessThan(names.indexOf('zucchini'))
  })

  test('returns all expected fields', async () => {
    const id  = await createIngredient('basil', { category: 'spice', priceCents: 150, displayName: 'Fresh Basil' })
    const res  = await get('/ingredients')
    const body = await res.json() as { ingredients: Array<Record<string, unknown>> }
    const found = body.ingredients.find((i) => i.id === id)
    expect(found).toBeDefined()
    expect(found!.name).toBe('basil')
    expect(found!.display_name).toBe('Fresh Basil')
    expect(found!.category).toBe('spice')
    expect(found!.price_cents).toBe(150)
    expect(found!.is_available).toBe(1)
  })

  test('returns 401 without token', async () => {
    const res = await app.fetch(new Request(base('/ingredients')))
    expect(res.status).toBe(401)
  })
})

// ── POST /ingredients ─────────────────────────────────────────────────────────

describe('POST /ingredients', () => {
  test('creates ingredient with minimal fields (201)', async () => {
    const res  = await post('/ingredients', { name: 'Tofu', category: 'protein' })
    const body = await res.json() as { id: string; name: string; category: string; priceCents: number; isAvailable: boolean }
    expect(res.status).toBe(201)
    expect(body.id).toMatch(/^ingr_/)
    expect(body.name).toBe('tofu')       // lowercased
    expect(body.category).toBe('protein')
    expect(body.priceCents).toBe(0)
    expect(body.isAvailable).toBe(true)
  })

  test('stores displayName when provided', async () => {
    const res  = await post('/ingredients', { name: 'Egg', category: 'other', displayName: 'Farm Egg' })
    const body = await res.json() as { displayName: string }
    expect(res.status).toBe(201)
    expect(body.displayName).toBe('Farm Egg')
  })

  test('stores priceCents and rounds it', async () => {
    const res  = await post('/ingredients', { name: 'PricedItem', category: 'other', priceCents: 199.9 })
    const body = await res.json() as { priceCents: number }
    expect(res.status).toBe(201)
    expect(body.priceCents).toBe(200)
  })

  test('normalises name to lowercase', async () => {
    const res  = await post('/ingredients', { name: 'GARLIC', category: 'spice' })
    const body = await res.json() as { name: string }
    expect(res.status).toBe(201)
    expect(body.name).toBe('garlic')
  })

  test('returns 400 when name is missing', async () => {
    const res  = await post('/ingredients', { category: 'other' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toContain('name')
  })

  test('returns 400 for invalid category', async () => {
    const res  = await post('/ingredients', { name: 'test', category: 'invalid' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toContain('category')
  })

  test('accepts all valid categories', async () => {
    const cats = ['protein', 'vegetable', 'sauce', 'spice', 'dairy', 'other']
    for (const cat of cats) {
      const res = await post('/ingredients', { name: `cat-${cat}`, category: cat })
      expect(res.status).toBe(201)
    }
  })

  test('returns 409 when ingredient name already exists', async () => {
    await post('/ingredients', { name: 'DupIngr', category: 'other' })
    const res  = await post('/ingredients', { name: 'DupIngr', category: 'protein' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(409)
    expect(body.error).toContain('already exists')
  })

  test('manager role can create (201)', async () => {
    const res = await post('/ingredients', { name: 'MgrIngr', category: 'other' }, managerToken)
    expect(res.status).toBe(201)
  })

  test('staff role cannot create (403)', async () => {
    const res = await post('/ingredients', { name: 'StaffIngr', category: 'other' }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── PUT /ingredients/:ingr_id ─────────────────────────────────────────────────

describe('PUT /ingredients/:ingr_id', () => {
  test('updates displayName', async () => {
    const id  = await createIngredient('UpdateTarget', { category: 'other' })
    const res = await put(`/ingredients/${id}`, { displayName: 'New Display' })
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })

  test('updates category to a valid value', async () => {
    const id  = await createIngredient('CatTarget', { category: 'other' })
    const res = await put(`/ingredients/${id}`, { category: 'protein' })
    expect(res.status).toBe(200)
  })

  test('updates priceCents', async () => {
    const id  = await createIngredient('PriceTarget', { category: 'other' })
    const res = await put(`/ingredients/${id}`, { priceCents: 500 })
    expect(res.status).toBe(200)
  })

  test('updates isAvailable to false', async () => {
    const id  = await createIngredient('AvailTarget', { category: 'other' })
    const res = await put(`/ingredients/${id}`, { isAvailable: false })
    expect(res.status).toBe(200)
  })

  test('returns 404 for unknown ingredient id', async () => {
    const res  = await put('/ingredients/ingr_doesnotexist', { displayName: 'X' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(404)
    expect(body.error).toBeTruthy()
  })

  test('returns 400 when no fields provided', async () => {
    const id  = await createIngredient('NoFieldTarget', { category: 'other' })
    const res = await put(`/ingredients/${id}`, {})
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid category in PUT', async () => {
    const id  = await createIngredient('InvalidCatPut', { category: 'other' })
    const res = await put(`/ingredients/${id}`, { category: 'bogus' })
    expect(res.status).toBe(400)
  })

  test('staff role cannot update (403)', async () => {
    const id  = await createIngredient('StaffPutTarget', { category: 'other' })
    const res = await put(`/ingredients/${id}`, { displayName: 'StaffBypassed' }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── DELETE /ingredients/:ingr_id ──────────────────────────────────────────────

describe('DELETE /ingredients/:ingr_id', () => {
  test('deletes an ingredient (200)', async () => {
    const id  = await createIngredient('DeleteIngr', { category: 'other' })
    const res = await del(`/ingredients/${id}`)
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })

  test('deleted ingredient no longer appears in list', async () => {
    const id  = await createIngredient('GoneIngr', { category: 'other' })
    await del(`/ingredients/${id}`)
    const res  = await get('/ingredients')
    const body = await res.json() as { ingredients: Array<{ id: string }> }
    expect(body.ingredients.some((i) => i.id === id)).toBe(false)
  })

  test('returns 404 for unknown ingredient id', async () => {
    const res = await del('/ingredients/ingr_doesnotexist')
    expect(res.status).toBe(404)
  })

  test('staff role cannot delete (403)', async () => {
    const id  = await createIngredient('StaffDelTarget', { category: 'other' })
    const res = await del(`/ingredients/${id}`, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── GET /ingredient-aliases ───────────────────────────────────────────────────

describe('GET /ingredient-aliases', () => {
  test('returns empty list initially', async () => {
    const res  = await get('/ingredient-aliases')
    const body = await res.json() as { aliases: unknown[] }
    expect(res.status).toBe(200)
    expect(Array.isArray(body.aliases)).toBe(true)
  })

  test('returns created aliases with ingredient_name join', async () => {
    const ingrId   = await createIngredient('TofuAlias', { category: 'protein' })
    const aliasId  = await createAlias('bean curd', ingrId)

    const res  = await get('/ingredient-aliases')
    const body = await res.json() as {
      aliases: Array<{ id: string; alias_text: string; ingredient_name: string | null }>
    }
    expect(res.status).toBe(200)

    const found = body.aliases.find((a) => a.id === aliasId)
    expect(found).toBeDefined()
    expect(found!.alias_text).toBe('bean curd')
    expect(found!.ingredient_name).toBe('tofualias')  // lowercased from 'TofuAlias'
  })
})

// ── POST /ingredient-aliases ──────────────────────────────────────────────────

describe('POST /ingredient-aliases', () => {
  test('creates an alias without linked ingredient (201)', async () => {
    const res  = await post('/ingredient-aliases', { aliasText: 'scallion' })
    const body = await res.json() as { id: string; aliasText: string; ingredientId: null }
    expect(res.status).toBe(201)
    expect(body.id).toMatch(/^alia_/)
    expect(body.aliasText).toBe('scallion')  // lowercased
    expect(body.ingredientId).toBeNull()
  })

  test('creates an alias linked to an ingredient', async () => {
    const ingrId  = await createIngredient('ChickenLinked', { category: 'protein' })
    const res     = await post('/ingredient-aliases', { aliasText: 'poultry', ingredientId: ingrId })
    const body    = await res.json() as { ingredientId: string }
    expect(res.status).toBe(201)
    expect(body.ingredientId).toBe(ingrId)
  })

  test('creates an alias with suggestionText', async () => {
    const res  = await post('/ingredient-aliases', { aliasText: 'soy protein', suggestionText: 'Did you mean Tofu?' })
    const body = await res.json() as { suggestionText: string }
    expect(res.status).toBe(201)
    expect(body.suggestionText).toBe('Did you mean Tofu?')
  })

  test('returns 400 when aliasText is missing', async () => {
    const res  = await post('/ingredient-aliases', {})
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toContain('aliasText')
  })

  test('returns 400 when ingredientId does not exist for this merchant', async () => {
    const res  = await post('/ingredient-aliases', {
      aliasText:   'phantom',
      ingredientId: 'ingr_doesnotexist',
    })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toContain('ingredientId')
  })

  test('returns 409 when alias text already exists', async () => {
    await post('/ingredient-aliases', { aliasText: 'DupAlias' })
    const res  = await post('/ingredient-aliases', { aliasText: 'DupAlias' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(409)
    expect(body.error).toContain('already exists')
  })

  test('normalises aliasText to lowercase', async () => {
    const res  = await post('/ingredient-aliases', { aliasText: 'BEAN SPROUTS' })
    const body = await res.json() as { aliasText: string }
    expect(res.status).toBe(201)
    expect(body.aliasText).toBe('bean sprouts')
  })

  test('staff role cannot create alias (403)', async () => {
    const res = await post('/ingredient-aliases', { aliasText: 'staffalias' }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── PUT /ingredient-aliases/:alias_id ─────────────────────────────────────────

describe('PUT /ingredient-aliases/:alias_id', () => {
  test('updates ingredient link on alias', async () => {
    const aliasId = await createAlias('nolink')
    const ingrId  = await createIngredient('LinkTarget', { category: 'other' })

    const res = await put(`/ingredient-aliases/${aliasId}`, { ingredientId: ingrId })
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })

  test('clears ingredient link by passing null', async () => {
    const ingrId  = await createIngredient('ClearLinkIngr', { category: 'other' })
    const aliasId = await createAlias('clearlink', ingrId)

    const res = await put(`/ingredient-aliases/${aliasId}`, { ingredientId: null })
    expect(res.status).toBe(200)
  })

  test('updates suggestionText', async () => {
    const aliasId = await createAlias('suggestme')
    const res     = await put(`/ingredient-aliases/${aliasId}`, { suggestionText: 'Try X' })
    expect(res.status).toBe(200)
  })

  test('returns 404 for unknown alias id', async () => {
    const res = await put('/ingredient-aliases/alia_doesnotexist', { suggestionText: 'X' })
    expect(res.status).toBe(404)
  })

  test('returns 400 when no fields provided', async () => {
    const aliasId = await createAlias('nofields')
    const res     = await put(`/ingredient-aliases/${aliasId}`, {})
    expect(res.status).toBe(400)
  })

  test('returns 400 when ingredientId does not exist for this merchant', async () => {
    const aliasId = await createAlias('invalidlink')
    const res     = await put(`/ingredient-aliases/${aliasId}`, { ingredientId: 'ingr_doesnotexist' })
    expect(res.status).toBe(400)
  })

  test('staff role cannot update alias (403)', async () => {
    const aliasId = await createAlias('staffputalias')
    const res     = await put(`/ingredient-aliases/${aliasId}`, { suggestionText: 'X' }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── DELETE /ingredient-aliases/:alias_id ──────────────────────────────────────

describe('DELETE /ingredient-aliases/:alias_id', () => {
  test('deletes an alias (200)', async () => {
    const aliasId = await createAlias('deleteme')
    const res     = await del(`/ingredient-aliases/${aliasId}`)
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })

  test('deleted alias no longer appears in list', async () => {
    const aliasId = await createAlias('gone')
    await del(`/ingredient-aliases/${aliasId}`)
    const res  = await get('/ingredient-aliases')
    const body = await res.json() as { aliases: Array<{ id: string }> }
    expect(body.aliases.some((a) => a.id === aliasId)).toBe(false)
  })

  test('returns 404 for unknown alias id', async () => {
    const res = await del('/ingredient-aliases/alia_doesnotexist')
    expect(res.status).toBe(404)
  })

  test('staff role cannot delete alias (403)', async () => {
    const aliasId = await createAlias('staffdelalias')
    const res     = await del(`/ingredient-aliases/${aliasId}`, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── GET /ai-key/status ────────────────────────────────────────────────────────

describe('GET /ai-key/status', () => {
  test('returns { configured: false } before any key is stored', async () => {
    const res  = await get('/ai-key/status')
    const body = await res.json() as { configured: boolean }
    expect(res.status).toBe(200)
    expect(body.configured).toBe(false)
  })
})

// ── POST /ai-key ──────────────────────────────────────────────────────────────

describe('POST /ai-key', () => {
  test('returns 400 when apiKey is missing', async () => {
    const res  = await post('/ai-key', {})
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toContain('apiKey')
  })

  test('returns 400 for key that does not start with sk-ant-', async () => {
    const res  = await post('/ai-key', { apiKey: 'sk-openai-invalid' })
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    expect(body.error).toContain('sk-ant-')
  })

  test('stores a valid-format key and returns ok: true (200)', async () => {
    const fakeKey = 'sk-ant-api03-test-key-for-unit-tests-xxxxxxxxxxxxxxxxxxxxxxxx'
    const res     = await post('/ai-key', { apiKey: fakeKey })
    const body    = await res.json() as { ok: boolean; seeded: boolean }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.seeded).toBe('boolean')
  })

  test('GET /ai-key/status returns configured: true after storing key', async () => {
    const res  = await get('/ai-key/status')
    const body = await res.json() as { configured: boolean }
    expect(res.status).toBe(200)
    expect(body.configured).toBe(true)
  })

  test('re-saving key is idempotent and still returns ok: true', async () => {
    const fakeKey = 'sk-ant-api03-test-key-for-unit-tests-xxxxxxxxxxxxxxxxxxxxxxxx'
    const res     = await post('/ai-key', { apiKey: fakeKey })
    const body    = await res.json() as { ok: boolean }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
  })

  test('manager role cannot store AI key (403 — owner only)', async () => {
    const fakeKey = 'sk-ant-api03-test-key-for-unit-tests-xxxxxxxxxxxxxxxxxxxxxxxx'
    const res     = await post('/ai-key', { apiKey: fakeKey }, managerToken)
    expect(res.status).toBe(403)
  })

  test('staff role cannot store AI key (403)', async () => {
    const fakeKey = 'sk-ant-api03-test-key-for-unit-tests-xxxxxxxxxxxxxxxxxxxxxxxx'
    const res     = await post('/ai-key', { apiKey: fakeKey }, staffToken)
    expect(res.status).toBe(403)
  })
})

// ── DELETE /ai-key ────────────────────────────────────────────────────────────

describe('DELETE /ai-key', () => {
  test('removes the stored key (200)', async () => {
    const res = await del('/ai-key')
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })

  test('GET /ai-key/status returns configured: false after deletion', async () => {
    const res  = await get('/ai-key/status')
    const body = await res.json() as { configured: boolean }
    expect(res.status).toBe(200)
    expect(body.configured).toBe(false)
  })

  test('manager role cannot delete AI key (403 — owner only)', async () => {
    const res = await del('/ai-key', managerToken)
    expect(res.status).toBe(403)
  })

  test('staff role cannot delete AI key (403)', async () => {
    const res = await del('/ai-key', staffToken)
    expect(res.status).toBe(403)
  })
})

// ── GET /instruction-log ──────────────────────────────────────────────────────

describe('GET /instruction-log', () => {
  test('returns { log: [] } when no instructions have been processed', async () => {
    const res  = await get('/instruction-log')
    const body = await res.json() as { log: unknown[] }
    expect(res.status).toBe(200)
    expect(body.log).toEqual([])
  })

  test('staff role cannot view instruction log (403)', async () => {
    const res = await get('/instruction-log', staffToken)
    expect(res.status).toBe(403)
  })

  test('manager role can view instruction log (200)', async () => {
    const res = await get('/instruction-log', managerToken)
    expect(res.status).toBe(200)
  })
})
