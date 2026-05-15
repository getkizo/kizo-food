/**
 * OOS (Out-of-Stock) Ingredient Shortcuts
 *
 * Manages named "86 buttons" (Avocado, Broccoli, Duck…) that bulk-toggle all
 * linked menu items + modifier options OOS/back in one call or voice command.
 *
 * All authenticated roles can read + toggle ingredients.
 * Only owner/manager can create, rename, delete, or edit associations.
 *
 * Also provides server-accessible stock-patch endpoints for the OOS tab
 * (the existing PATCH /menu/items/:id and /menu/modifiers/:id/stock are
 * owner/manager-only; these new endpoints under /oos/ allow server role).
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { authenticate, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'

const oos = new Hono()

const VALID_STOCK = ['in_stock', 'out_today', 'out_indefinitely'] as const
type StockStatus = (typeof VALID_STOCK)[number]

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/oos/ingredients
// List all ingredient shortcuts with linked items/modifiers + status.
// Accessible to all authenticated roles (server, chef, manager, owner).
// ---------------------------------------------------------------------------
oos.get('/api/merchants/:id/oos/ingredients', authenticate, async (c: AuthContext) => {
  const merchantId = c.req.param('id')!
  const db = getDatabase()

  const ingredients = db
    .query<{ id: string; name: string; sort_order: number; is_out: number }, [string]>(
      `SELECT id, name, sort_order, is_out FROM oos_ingredients
       WHERE merchant_id = ? ORDER BY sort_order, name`
    )
    .all(merchantId)

  if (ingredients.length === 0) return c.json([])

  const ingIds = ingredients.map((i) => i.id)
  const placeholders = ingIds.map(() => '?').join(',')

  const itemLinks = db
    .query<
      { ingredient_id: string; item_id: string; item_name: string; stock_status: string },
      string[]
    >(
      `SELECT oii.ingredient_id, mi.id AS item_id, mi.name AS item_name, mi.stock_status
       FROM oos_ingredient_items oii
       JOIN menu_items mi ON mi.id = oii.item_id
       WHERE oii.ingredient_id IN (${placeholders})`
    )
    .all(...ingIds)

  const modLinks = db
    .query<
      {
        ingredient_id: string
        modifier_id: string
        modifier_name: string
        group_name: string
        stock_status: string
      },
      string[]
    >(
      `SELECT oim.ingredient_id, m.id AS modifier_id, m.name AS modifier_name,
              mg.name AS group_name, m.stock_status
       FROM oos_ingredient_modifiers oim
       JOIN modifiers m ON m.id = oim.modifier_id
       JOIN modifier_groups mg ON mg.id = m.group_id
       WHERE oim.ingredient_id IN (${placeholders})`
    )
    .all(...ingIds)

  const result = ingredients.map((ing) => ({
    id: ing.id,
    name: ing.name,
    sortOrder: ing.sort_order,
    isOut: ing.is_out === 1,
    items: itemLinks
      .filter((l) => l.ingredient_id === ing.id)
      .map((l) => ({ id: l.item_id, name: l.item_name, stockStatus: l.stock_status })),
    modifiers: modLinks
      .filter((l) => l.ingredient_id === ing.id)
      .map((l) => ({
        id: l.modifier_id,
        name: l.modifier_name,
        groupName: l.group_name,
        stockStatus: l.stock_status,
      })),
  }))

  return c.json(result)
})

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/oos/ingredients
// Create a new ingredient shortcut (owner/manager only).
// ---------------------------------------------------------------------------
oos.post(
  '/api/merchants/:id/oos/ingredients',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    let body: { name: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.name?.trim()) return c.json({ error: 'name required' }, 400)
    const name = body.name.trim()

    const db = getDatabase()

    const existing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM oos_ingredients WHERE merchant_id = ? AND name = ?`
      )
      .get(merchantId, name)
    if (existing) return c.json({ error: 'Ingredient already exists' }, 409)

    const maxRow = db
      .query<{ max: number | null }, [string]>(
        `SELECT MAX(sort_order) AS max FROM oos_ingredients WHERE merchant_id = ?`
      )
      .get(merchantId)

    db.run(`INSERT INTO oos_ingredients (merchant_id, name, sort_order) VALUES (?, ?, ?)`, [
      merchantId,
      name,
      (maxRow?.max ?? -1) + 1,
    ])

    const created = db
      .query<{ id: string; name: string; sort_order: number; is_out: number }, [string, string]>(
        `SELECT id, name, sort_order, is_out FROM oos_ingredients WHERE merchant_id = ? AND name = ?`
      )
      .get(merchantId, name)!

    return c.json(
      { id: created.id, name: created.name, sortOrder: created.sort_order, isOut: false, items: [], modifiers: [] },
      201
    )
  }
)

// ---------------------------------------------------------------------------
// PUT /api/merchants/:id/oos/ingredients/:ingId
// Rename an ingredient shortcut (owner/manager only).
// ---------------------------------------------------------------------------
oos.put(
  '/api/merchants/:id/oos/ingredients/:ingId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingId = c.req.param('ingId')!
    let body: { name: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.name?.trim()) return c.json({ error: 'name required' }, 400)

    const db = getDatabase()
    const exists = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM oos_ingredients WHERE id = ? AND merchant_id = ?`
      )
      .get(ingId, merchantId)
    if (!exists) return c.json({ error: 'Not found' }, 404)

    db.run(`UPDATE oos_ingredients SET name = ? WHERE id = ?`, [body.name.trim(), ingId])
    return c.json({ success: true })
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/oos/ingredients/:ingId
// Delete an ingredient shortcut — cascades to association tables.
// ---------------------------------------------------------------------------
oos.delete(
  '/api/merchants/:id/oos/ingredients/:ingId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingId = c.req.param('ingId')!
    const db = getDatabase()

    const exists = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM oos_ingredients WHERE id = ? AND merchant_id = ?`
      )
      .get(ingId, merchantId)
    if (!exists) return c.json({ error: 'Not found' }, 404)

    db.run(`DELETE FROM oos_ingredients WHERE id = ?`, [ingId])
    return c.json({ success: true })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/oos/ingredients/:ingId/toggle
// Toggle the ingredient's 86 state; marks/restores all linked items + modifiers.
// Accessible to all authenticated roles.
// ---------------------------------------------------------------------------
oos.post(
  '/api/merchants/:id/oos/ingredients/:ingId/toggle',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingId = c.req.param('ingId')!
    const db = getDatabase()

    const ing = db
      .query<{ id: string; is_out: number }, [string, string]>(
        `SELECT id, is_out FROM oos_ingredients WHERE id = ? AND merchant_id = ?`
      )
      .get(ingId, merchantId)
    if (!ing) return c.json({ error: 'Not found' }, 404)

    const newIsOut = ing.is_out === 0 ? 1 : 0
    const newStatus: StockStatus = newIsOut === 1 ? 'out_today' : 'in_stock'

    db.run(
      `UPDATE menu_items SET stock_status = ?, updated_at = datetime('now')
       WHERE id IN (SELECT item_id FROM oos_ingredient_items WHERE ingredient_id = ?)`,
      [newStatus, ingId]
    )
    db.run(
      `UPDATE modifiers SET stock_status = ?, updated_at = datetime('now')
       WHERE id IN (SELECT modifier_id FROM oos_ingredient_modifiers WHERE ingredient_id = ?)`,
      [newStatus, ingId]
    )
    db.run(`UPDATE oos_ingredients SET is_out = ? WHERE id = ?`, [newIsOut, ingId])

    return c.json({ success: true, isOut: newIsOut === 1, stockStatus: newStatus })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/oos/ingredients/:ingId/items
// Link a menu item to an ingredient shortcut (owner/manager only).
// ---------------------------------------------------------------------------
oos.post(
  '/api/merchants/:id/oos/ingredients/:ingId/items',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingId = c.req.param('ingId')!
    let body: { itemId: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const { itemId } = body
    if (!itemId) return c.json({ error: 'itemId required' }, 400)

    const db = getDatabase()

    const ing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM oos_ingredients WHERE id = ? AND merchant_id = ?`
      )
      .get(ingId, merchantId)
    if (!ing) return c.json({ error: 'Ingredient not found' }, 404)

    const item = db
      .query<{ id: string; name: string }, [string, string]>(
        `SELECT id, name FROM menu_items WHERE id = ? AND merchant_id = ?`
      )
      .get(itemId, merchantId)
    if (!item) return c.json({ error: 'Item not found' }, 404)

    db.run(
      `INSERT OR IGNORE INTO oos_ingredient_items (ingredient_id, item_id) VALUES (?, ?)`,
      [ingId, itemId]
    )
    return c.json({ success: true, item: { id: item.id, name: item.name } })
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/oos/ingredients/:ingId/items/:itemId
// Remove a menu item link from an ingredient shortcut.
// ---------------------------------------------------------------------------
oos.delete(
  '/api/merchants/:id/oos/ingredients/:ingId/items/:itemId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingId = c.req.param('ingId')!
    const itemId = c.req.param('itemId')!
    const db = getDatabase()

    const ing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM oos_ingredients WHERE id = ? AND merchant_id = ?`
      )
      .get(ingId, merchantId)
    if (!ing) return c.json({ error: 'Not found' }, 404)

    db.run(`DELETE FROM oos_ingredient_items WHERE ingredient_id = ? AND item_id = ?`, [ingId, itemId])
    return c.json({ success: true })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/oos/ingredients/:ingId/modifiers
// Link a modifier option to an ingredient shortcut (owner/manager only).
// ---------------------------------------------------------------------------
oos.post(
  '/api/merchants/:id/oos/ingredients/:ingId/modifiers',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingId = c.req.param('ingId')!
    let body: { modifierId: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const { modifierId } = body
    if (!modifierId) return c.json({ error: 'modifierId required' }, 400)

    const db = getDatabase()

    const ing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM oos_ingredients WHERE id = ? AND merchant_id = ?`
      )
      .get(ingId, merchantId)
    if (!ing) return c.json({ error: 'Ingredient not found' }, 404)

    const mod = db
      .query<{ id: string; name: string; group_name: string }, [string, string]>(
        `SELECT m.id, m.name, mg.name AS group_name
         FROM modifiers m JOIN modifier_groups mg ON mg.id = m.group_id
         WHERE m.id = ? AND mg.merchant_id = ?`
      )
      .get(modifierId, merchantId)
    if (!mod) return c.json({ error: 'Modifier not found' }, 404)

    db.run(
      `INSERT OR IGNORE INTO oos_ingredient_modifiers (ingredient_id, modifier_id) VALUES (?, ?)`,
      [ingId, modifierId]
    )
    return c.json({ success: true, modifier: { id: mod.id, name: mod.name, groupName: mod.group_name } })
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/oos/ingredients/:ingId/modifiers/:modifierId
// Remove a modifier option link from an ingredient shortcut.
// ---------------------------------------------------------------------------
oos.delete(
  '/api/merchants/:id/oos/ingredients/:ingId/modifiers/:modifierId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const ingId = c.req.param('ingId')!
    const modifierId = c.req.param('modifierId')!
    const db = getDatabase()

    const ing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM oos_ingredients WHERE id = ? AND merchant_id = ?`
      )
      .get(ingId, merchantId)
    if (!ing) return c.json({ error: 'Not found' }, 404)

    db.run(
      `DELETE FROM oos_ingredient_modifiers WHERE ingredient_id = ? AND modifier_id = ?`,
      [ingId, modifierId]
    )
    return c.json({ success: true })
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/oos/items/:itemId/stock
// Set stock status on a single menu item — accessible to all roles (incl. server).
// Complements the owner/manager-only PUT /menu/items/:id endpoint.
// ---------------------------------------------------------------------------
oos.patch('/api/merchants/:id/oos/items/:itemId/stock', authenticate, async (c: AuthContext) => {
  const merchantId = c.req.param('id')!
  const itemId = c.req.param('itemId')!
  let body: { stockStatus: StockStatus }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const { stockStatus } = body

  if (!VALID_STOCK.includes(stockStatus)) return c.json({ error: 'Invalid stockStatus' }, 400)

  const db = getDatabase()
  const item = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM menu_items WHERE id = ? AND merchant_id = ?`
    )
    .get(itemId, merchantId)
  if (!item) return c.json({ error: 'Item not found' }, 404)

  db.run(
    `UPDATE menu_items SET stock_status = ?, updated_at = datetime('now') WHERE id = ?`,
    [stockStatus, itemId]
  )
  return c.json({ success: true, itemId, stockStatus })
})

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/oos/modifiers/:modifierId/stock
// Set stock status on a single modifier option — accessible to all roles.
// ---------------------------------------------------------------------------
oos.patch(
  '/api/merchants/:id/oos/modifiers/:modifierId/stock',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const modifierId = c.req.param('modifierId')!
    let body: { stockStatus: StockStatus }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const { stockStatus } = body

    if (!VALID_STOCK.includes(stockStatus)) return c.json({ error: 'Invalid stockStatus' }, 400)

    const db = getDatabase()
    const mod = db
      .query<{ id: string }, [string, string]>(
        `SELECT m.id FROM modifiers m JOIN modifier_groups mg ON mg.id = m.group_id
         WHERE m.id = ? AND mg.merchant_id = ?`
      )
      .get(modifierId, merchantId)
    if (!mod) return c.json({ error: 'Modifier not found' }, 404)

    db.run(
      `UPDATE modifiers SET stock_status = ?, updated_at = datetime('now') WHERE id = ?`,
      [stockStatus, modifierId]
    )
    return c.json({ success: true, modifierId, stockStatus })
  }
)

export { oos }
