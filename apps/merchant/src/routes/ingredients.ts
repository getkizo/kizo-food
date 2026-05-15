/**
 * ingredients.ts — Extra ingredients + aliases CRUD, and AI key management
 *
 * All routes require authenticate + requireOwnMerchant (owner/manager only for writes).
 *
 * Extra ingredients: merchant-managed catalog of add-on ingredients with prices.
 * Ingredient aliases: maps customer-facing terms to canonical ingredients.
 * AI key: stores/removes the Anthropic API key used by the instruction parser.
 *
 * GET    /api/merchants/:id/ingredients              → list extra_ingredients
 * POST   /api/merchants/:id/ingredients              → create
 * PUT    /api/merchants/:id/ingredients/:ingr_id     → update
 * DELETE /api/merchants/:id/ingredients/:ingr_id     → delete
 *
 * GET    /api/merchants/:id/ingredient-aliases       → list ingredient_aliases
 * POST   /api/merchants/:id/ingredient-aliases       → create
 * PUT    /api/merchants/:id/ingredient-aliases/:alias_id  → update
 * DELETE /api/merchants/:id/ingredient-aliases/:alias_id  → delete
 *
 * POST   /api/merchants/:id/ai-key                   → store Anthropic key
 * DELETE /api/merchants/:id/ai-key                   → remove
 * GET    /api/merchants/:id/ai-key/status            → { configured: boolean }
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { serverError } from '../utils/server-error'
import { storeAPIKey, getAPIKey } from '../crypto/api-keys'

const ingredients = new Hono()

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = ['protein', 'vegetable', 'sauce', 'spice', 'dairy', 'other'] as const

// ---------------------------------------------------------------------------
// Extra ingredients
// ---------------------------------------------------------------------------

/** GET /api/merchants/:id/ingredients */
ingredients.get(
  '/api/merchants/:id/ingredients',
  authenticate,
  requireOwnMerchant,
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()
      const rows = db.query<{
        id: string; name: string; display_name: string | null; category: string;
        price_cents: number; is_available: number; charge_type: string; created_at: string
      }, [string]>(
        `SELECT id, name, display_name, category, price_cents, is_available, charge_type, created_at
           FROM extra_ingredients
          WHERE merchant_id = ?
          ORDER BY category, name`,
      ).all(merchantId)
      return c.json({ ingredients: rows })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** POST /api/merchants/:id/ingredients */
ingredients.post(
  '/api/merchants/:id/ingredients',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    let body: { name?: unknown; displayName?: unknown; category?: unknown; priceCents?: unknown; chargeType?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : ''
    if (!name) return c.json({ error: 'name is required' }, 400)

    const category = typeof body.category === 'string' ? body.category : 'other'
    if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
      return c.json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }, 400)
    }

    const priceCents = Math.max(0, Math.round(Number(body.priceCents ?? 0)))
    const displayName = typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim()
      : null
    const chargeType = body.chargeType === 'per_unit' ? 'per_unit' : 'per_entry'

    try {
      const db  = getDatabase()
      const id  = generateId('ingr')
      db.run(
        `INSERT INTO extra_ingredients (id, merchant_id, name, display_name, category, price_cents, is_available, charge_type)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [id, merchantId, name, displayName, category, priceCents, chargeType],
      )
      return c.json({ id, name, displayName, category, priceCents, isAvailable: true, chargeType }, 201)
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? ''
      if (msg.includes('UNIQUE')) return c.json({ error: `Ingredient "${name}" already exists` }, 409)
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** PUT /api/merchants/:id/ingredients/:ingr_id */
ingredients.put(
  '/api/merchants/:id/ingredients/:ingr_id',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingrId     = c.req.param('ingr_id')!
    let body: { displayName?: unknown; category?: unknown; priceCents?: unknown; isAvailable?: unknown; chargeType?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const db  = getDatabase()
    const row = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM extra_ingredients WHERE id = ? AND merchant_id = ?`,
    ).get(ingrId, merchantId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const sets: string[]                       = []
    const params: (string | number | null)[]   = []

    if (body.displayName !== undefined) {
      sets.push('display_name = ?')
      params.push(typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim()
        : null)
    }
    if (body.category !== undefined) {
      const cat = String(body.category)
      if (!(VALID_CATEGORIES as readonly string[]).includes(cat)) {
        return c.json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }, 400)
      }
      sets.push('category = ?')
      params.push(cat)
    }
    if (body.priceCents !== undefined) {
      sets.push('price_cents = ?')
      params.push(Math.max(0, Math.round(Number(body.priceCents))))
    }
    if (body.isAvailable !== undefined) {
      sets.push('is_available = ?')
      params.push(body.isAvailable ? 1 : 0)
    }
    if (body.chargeType !== undefined) {
      if (body.chargeType !== 'per_unit' && body.chargeType !== 'per_entry') {
        return c.json({ error: "chargeType must be 'per_unit' or 'per_entry'" }, 400)
      }
      sets.push('charge_type = ?')
      params.push(body.chargeType)
    }

    if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400)

    try {
      db.run(`UPDATE extra_ingredients SET ${sets.join(', ')} WHERE id = ?`, [...params, ingrId])
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** DELETE /api/merchants/:id/ingredients/:ingr_id */
ingredients.delete(
  '/api/merchants/:id/ingredients/:ingr_id',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingrId     = c.req.param('ingr_id')!
    try {
      const db     = getDatabase()
      const result = db.run(
        `DELETE FROM extra_ingredients WHERE id = ? AND merchant_id = ?`,
        [ingrId, merchantId],
      )
      if (result.changes === 0) return c.json({ error: 'Not found' }, 404)
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

// ---------------------------------------------------------------------------
// Ingredient aliases
// ---------------------------------------------------------------------------

/** GET /api/merchants/:id/ingredient-aliases */
ingredients.get(
  '/api/merchants/:id/ingredient-aliases',
  authenticate,
  requireOwnMerchant,
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()
      const rows = db.query<{
        id: string; alias_text: string; ingredient_id: string | null;
        ingredient_name: string | null; suggestion_text: string | null; created_at: string
      }, [string]>(
        `SELECT ia.id, ia.alias_text, ia.ingredient_id,
                ei.name AS ingredient_name, ia.suggestion_text, ia.created_at
           FROM ingredient_aliases ia
           LEFT JOIN extra_ingredients ei ON ei.id = ia.ingredient_id
          WHERE ia.merchant_id = ?
          ORDER BY ia.alias_text`,
      ).all(merchantId)
      return c.json({ aliases: rows })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** POST /api/merchants/:id/ingredient-aliases */
ingredients.post(
  '/api/merchants/:id/ingredient-aliases',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    let body: { aliasText?: unknown; ingredientId?: unknown; suggestionText?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const aliasText = typeof body.aliasText === 'string' ? body.aliasText.trim().toLowerCase() : ''
    if (!aliasText) return c.json({ error: 'aliasText is required' }, 400)

    const ingredientId  = typeof body.ingredientId  === 'string' ? body.ingredientId  : null
    const suggestionText = typeof body.suggestionText === 'string' && body.suggestionText.trim()
      ? body.suggestionText.trim()
      : null

    try {
      const db = getDatabase()

      // Validate ingredientId belongs to this merchant if provided
      if (ingredientId) {
        const ingr = db.query<{ id: string }, [string, string]>(
          `SELECT id FROM extra_ingredients WHERE id = ? AND merchant_id = ?`,
        ).get(ingredientId, merchantId)
        if (!ingr) return c.json({ error: 'ingredientId not found' }, 400)
      }

      const id = generateId('alia')
      db.run(
        `INSERT INTO ingredient_aliases (id, merchant_id, alias_text, ingredient_id, suggestion_text)
         VALUES (?, ?, ?, ?, ?)`,
        [id, merchantId, aliasText, ingredientId, suggestionText],
      )
      return c.json({ id, aliasText, ingredientId, suggestionText }, 201)
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? ''
      if (msg.includes('UNIQUE')) return c.json({ error: `Alias "${aliasText}" already exists` }, 409)
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** PUT /api/merchants/:id/ingredient-aliases/:alias_id */
ingredients.put(
  '/api/merchants/:id/ingredient-aliases/:alias_id',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const aliasId    = c.req.param('alias_id')!
    let body: { ingredientId?: unknown; suggestionText?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const db  = getDatabase()
    const row = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM ingredient_aliases WHERE id = ? AND merchant_id = ?`,
    ).get(aliasId, merchantId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const sets: string[]                     = []
    const params: (string | number | null)[] = []

    if ('ingredientId' in body) {
      const ingredientId = body.ingredientId ?? null
      if (ingredientId) {
        const ingr = db.query<{ id: string }, [string, string]>(
          `SELECT id FROM extra_ingredients WHERE id = ? AND merchant_id = ?`,
        ).get(ingredientId as string, merchantId)
        if (!ingr) return c.json({ error: 'ingredientId not found' }, 400)
      }
      sets.push('ingredient_id = ?')
      params.push((ingredientId as string | null) ?? null)
    }
    if ('suggestionText' in body) {
      sets.push('suggestion_text = ?')
      params.push(typeof body.suggestionText === 'string' && body.suggestionText.trim()
        ? body.suggestionText.trim()
        : null)
    }

    if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400)

    try {
      db.run(`UPDATE ingredient_aliases SET ${sets.join(', ')} WHERE id = ?`, [...params, aliasId])
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** DELETE /api/merchants/:id/ingredient-aliases/:alias_id */
ingredients.delete(
  '/api/merchants/:id/ingredient-aliases/:alias_id',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const aliasId    = c.req.param('alias_id')!
    try {
      const db     = getDatabase()
      const result = db.run(
        `DELETE FROM ingredient_aliases WHERE id = ? AND merchant_id = ?`,
        [aliasId, merchantId],
      )
      if (result.changes === 0) return c.json({ error: 'Not found' }, 404)
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

// ---------------------------------------------------------------------------
// AI key management
// ---------------------------------------------------------------------------

/** GET /api/merchants/:id/ai-key/status — { configured: boolean } */
ingredients.get(
  '/api/merchants/:id/ai-key/status',
  authenticate,
  requireOwnMerchant,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const key = await getAPIKey(merchantId, 'ai', 'anthropic')
      return c.json({ configured: key !== null })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** POST /api/merchants/:id/ai-key — store Anthropic API key */
ingredients.post(
  '/api/merchants/:id/ai-key',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    let body: { apiKey?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (!apiKey) return c.json({ error: 'apiKey is required' }, 400)
    if (!apiKey.startsWith('sk-ant-')) {
      return c.json({ error: 'Invalid Anthropic API key format (must start with sk-ant-)' }, 400)
    }

    try {
      const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined
      await storeAPIKey(merchantId, 'ai', 'anthropic', apiKey, ip)

      // Seed starter ingredients on first-time setup (table empty for merchant).
      // All prices default to 0 so the owner only sets what they actually charge.
      // Uses INSERT OR IGNORE so re-saving the key is safe (idempotent).
      const db = getDatabase()
      const alreadyHas = db.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM extra_ingredients WHERE merchant_id = ?`,
      ).get(merchantId)?.n ?? 0

      if (alreadyHas === 0) {
        const STARTER: Array<{ name: string; display_name: string; category: string }> = [
          { name: 'chicken',           display_name: 'Chicken',           category: 'protein'   },
          { name: 'tofu',              display_name: 'Tofu',              category: 'protein'   },
          { name: 'shrimp',            display_name: 'Shrimp',            category: 'protein'   },
          { name: 'beef',              display_name: 'Beef',              category: 'protein'   },
          { name: 'broccoli',          display_name: 'Broccoli',          category: 'vegetable' },
          { name: 'carrots',           display_name: 'Carrots',           category: 'vegetable' },
          { name: 'snap peas',         display_name: 'Snap Peas',         category: 'vegetable' },
          { name: 'mushrooms',         display_name: 'Mushrooms',         category: 'vegetable' },
          { name: 'baby corn',         display_name: 'Baby Corn',         category: 'vegetable' },
          { name: 'bell pepper',       display_name: 'Bell Pepper',       category: 'vegetable' },
          { name: 'onion',             display_name: 'Onion',             category: 'vegetable' },
          { name: 'garlic',            display_name: 'Garlic',            category: 'spice'     },
          { name: 'ginger',            display_name: 'Ginger',            category: 'spice'     },
          { name: 'dry chili flakes',  display_name: 'Dry Chili Flakes',  category: 'spice'     },
          { name: 'sriracha sauce',    display_name: 'Sriracha Sauce',    category: 'sauce'     },
          { name: 'peanut sauce',      display_name: 'Peanut Sauce',      category: 'sauce'     },
          { name: 'peanuts',           display_name: 'Peanuts',           category: 'other'     },
          { name: 'egg',               display_name: 'Egg',               category: 'other'     },
          { name: 'coconut milk',      display_name: 'Coconut Milk',      category: 'dairy'     },
        ]
        const insert = db.prepare(
          `INSERT OR IGNORE INTO extra_ingredients
             (id, merchant_id, name, display_name, category, price_cents, is_available)
           VALUES (?, ?, ?, ?, ?, 0, 1)`,
        )
        for (const row of STARTER) {
          insert.run(generateId('ingr'), merchantId, row.name, row.display_name, row.category)
        }
      }

      return c.json({ ok: true, seeded: alreadyHas === 0 })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** DELETE /api/merchants/:id/ai-key — remove Anthropic API key */
ingredients.delete(
  '/api/merchants/:id/ai-key',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()
      db.run(
        `DELETE FROM api_keys WHERE merchant_id = ? AND key_type = 'ai' AND provider = 'anthropic'`,
        [merchantId],
      )
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, "[ingredients]", err)
    }
  },
)

/** GET /api/merchants/:id/instruction-log — last 3 days of special instruction events */
ingredients.get(
  '/api/merchants/:id/instruction-log',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const db = getDatabase()

    interface LogRow {
      id:               string
      occurred_at:      string
      instruction_text: string
      outcome:          string
      surcharge_cents:  number
      item_name:        string | null
      order_id:         string | null
    }

    const rows = db.query<LogRow, [string]>(
      `SELECT
         sil.id,
         sil.occurred_at,
         sil.instruction_text,
         sil.outcome,
         sil.surcharge_cents,
         mi.name        AS item_name,
         sil.order_id
       FROM special_instruction_log sil
       LEFT JOIN menu_items mi ON mi.id = sil.item_id
       WHERE sil.merchant_id = ?
         AND sil.occurred_at >= datetime('now', '-3 days')
       ORDER BY sil.occurred_at DESC
       LIMIT 200`,
    ).all(merchantId)

    return c.json({ log: rows })
  },
)

export { ingredients }
