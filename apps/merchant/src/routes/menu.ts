/**
 * Menu routes
 * Serves menu data and imports from POS providers (Clover, Toast, Square)
 *
 * GET  /api/merchants/:id/menu                               — full menu (categories → items → modifiers)
 * POST /api/merchants/:id/menu/sync                          — import menu from POS provider (body: { provider })
 * POST /api/merchants/:id/menu/items                         — create a new locally-managed item in a category
 * PUT  /api/merchants/:id/menu/items/:itemId/image           — set image URL for an item
 * PUT  /api/merchants/:id/menu/items/:itemId                 — update item (name, description, imageUrl, modifierGroupIds)
 * PUT  /api/merchants/:id/menu/modifier-groups/:groupId/items — reassign items to a modifier group
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { authenticate, requireRole } from '../middleware/auth'
import { getAPIKey, getPOSMerchantId } from '../crypto/api-keys'
import { CloverMenuImporter } from '../adapters/clover'
import { ToastMenuImporter } from '../adapters/toast'
import { SquareMenuImporter } from '../adapters/square'
import type { MenuImportAdapter } from '../adapters/types'
import type { AuthContext } from '../middleware/auth'
import type { POSMenuData } from '../adapters/types'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { serverError } from '../utils/server-error'

const menu = new Hono()

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/menu
// Returns the locally-stored menu (categories → items → modifierGroups → modifiers)
// ---------------------------------------------------------------------------
menu.get('/api/merchants/:id/menu', authenticate, async (c: AuthContext) => {
  const merchantId = c.req.param('id')
  const db = getDatabase()

  // Single JOIN query: 1 round-trip instead of 2+N+M+K queries
  type MenuRow = {
    cat_id: string; cat_name: string; cat_sort: number
    cat_avail_online: number; cat_avail_store: number
    hours_start: string | null; hours_end: string | null
    course_order: number | null; is_last_course: number; print_destination: string
    item_id: string | null; item_name: string | null; item_desc: string | null
    price_cents: number | null; price_type: string | null; image_url: string | null
    item_is_available: number | null; item_avail_online: number | null
    item_stock_status: string | null; dietary_tags: string | null
    item_sort: number | null; pos_item_id: string | null; is_popular: number | null
    mg_id: string | null; mg_name: string | null; min_required: number | null
    max_allowed: number | null; pos_group_id: string | null
    available_for_takeout: number | null; is_mandatory: number | null
    input_order: number | null; mimg_sort: number | null
    mod_id: string | null; mod_name: string | null; mod_price: number | null
    mod_is_available: number | null; mod_stock_status: string | null; mod_sort: number | null
  }

  const menuRows = db
    .query<MenuRow, [string]>(
      `SELECT
        mc.id AS cat_id, mc.name AS cat_name, mc.sort_order AS cat_sort,
        mc.available_online AS cat_avail_online, mc.available_in_store AS cat_avail_store,
        mc.hours_start, mc.hours_end, mc.course_order, mc.is_last_course, mc.print_destination,
        mi.id AS item_id, mi.name AS item_name, mi.description AS item_desc,
        mi.price_cents, mi.price_type, mi.image_url,
        mi.is_available AS item_is_available, mi.available_online AS item_avail_online,
        mi.stock_status AS item_stock_status, mi.dietary_tags,
        mi.sort_order AS item_sort, mi.pos_item_id, mi.is_popular,
        mg.id AS mg_id, mg.name AS mg_name, mg.min_required, mg.max_allowed,
        mg.pos_group_id, mg.available_for_takeout, mg.is_mandatory, mg.input_order,
        mimg.sort_order AS mimg_sort,
        m.id AS mod_id, m.name AS mod_name, m.price_cents AS mod_price,
        m.is_available AS mod_is_available, m.stock_status AS mod_stock_status,
        m.sort_order AS mod_sort
       FROM menu_categories mc
       LEFT JOIN menu_items mi ON mi.category_id = mc.id AND mi.merchant_id = mc.merchant_id
       LEFT JOIN menu_item_modifier_groups mimg ON mimg.item_id = mi.id
       LEFT JOIN modifier_groups mg ON mg.id = mimg.group_id
       LEFT JOIN modifiers m ON m.group_id = mg.id
       WHERE mc.merchant_id = ?
       ORDER BY mc.sort_order ASC, mi.sort_order ASC,
                CASE WHEN mg.is_mandatory = 1 OR mg.min_required >= 1 THEN 0 ELSE 1 END ASC,
                mg.input_order ASC, mimg.sort_order ASC, m.sort_order ASC`
    )
    .all(merchantId)

  // Assemble nested structure in-memory (Maps preserve insertion order)
  const catMap = new Map<string, {
    id: string; name: string; sortOrder: number
    availableOnline: boolean; availableInStore: boolean
    hoursStart: string | null; hoursEnd: string | null
    courseOrder: number | null; isLastCourse: boolean; printDestination: string
    items: Map<string, {
      id: string; posItemId: string | null; name: string; description: string | null
      priceCents: number; priceType: string; imageUrl: string | null
      isAvailable: boolean; availableOnline: boolean
      stockStatus: string; dietaryTags: unknown[]; sortOrder: number; isPopular: boolean
      modifierGroups: Map<string, {
        id: string; posGroupId: string | null; name: string
        minRequired: number; maxAllowed: number | null
        availableForTakeout: boolean; isMandatory: boolean; inputOrder: number
        modifiers: { id: string; name: string; priceCents: number; isAvailable: boolean; stockStatus: string; sortOrder: number }[]
      }>
    }>
  }>()

  for (const row of menuRows) {
    let catEntry = catMap.get(row.cat_id)
    if (!catEntry) {
      catEntry = {
        id: row.cat_id, name: row.cat_name, sortOrder: row.cat_sort,
        availableOnline: row.cat_avail_online !== 0, availableInStore: row.cat_avail_store !== 0,
        hoursStart: row.hours_start ?? null, hoursEnd: row.hours_end ?? null,
        courseOrder: row.course_order ?? null, isLastCourse: row.is_last_course === 1,
        printDestination: row.print_destination ?? 'both',
        items: new Map(),
      }
      catMap.set(row.cat_id, catEntry)
    }

    if (row.item_id == null) continue
    let itemEntry = catEntry.items.get(row.item_id)
    if (!itemEntry) {
      itemEntry = {
        id: row.item_id, posItemId: row.pos_item_id,
        name: row.item_name!, description: row.item_desc,
        priceCents: row.price_cents!, priceType: row.price_type!,
        imageUrl: row.image_url, isAvailable: row.item_is_available === 1,
        availableOnline: row.item_avail_online === 1,
        stockStatus: row.item_stock_status ?? 'in_stock',
        dietaryTags: row.dietary_tags ? JSON.parse(row.dietary_tags) : [],
        sortOrder: row.item_sort!, isPopular: row.is_popular === 1,
        modifierGroups: new Map(),
      }
      catEntry.items.set(row.item_id, itemEntry)
    }

    if (row.mg_id == null) continue
    let mgEntry = itemEntry.modifierGroups.get(row.mg_id)
    if (!mgEntry) {
      mgEntry = {
        id: row.mg_id, posGroupId: row.pos_group_id,
        name: row.mg_name!, minRequired: row.min_required!,
        maxAllowed: row.max_allowed, availableForTakeout: row.available_for_takeout !== 0,
        isMandatory: row.is_mandatory === 1, inputOrder: row.input_order ?? 0,
        modifiers: [],
      }
      itemEntry.modifierGroups.set(row.mg_id, mgEntry)
    }
    if (row.mod_id != null) {
      mgEntry.modifiers.push({
        id: row.mod_id, name: row.mod_name!, priceCents: row.mod_price!,
        isAvailable: row.mod_is_available === 1,
        stockStatus: row.mod_stock_status ?? 'in_stock', sortOrder: row.mod_sort!,
      })
    }
  }

  const result = Array.from(catMap.values()).map((cat) => ({
    id: cat.id, name: cat.name, sortOrder: cat.sortOrder,
    availableOnline: cat.availableOnline, availableInStore: cat.availableInStore,
    hoursStart: cat.hoursStart, hoursEnd: cat.hoursEnd,
    courseOrder: cat.courseOrder, isLastCourse: cat.isLastCourse,
    printDestination: cat.printDestination as 'both' | 'kitchen' | 'counter',
    items: Array.from(cat.items.values()).map((item) => ({
      id: item.id, posItemId: item.posItemId, name: item.name,
      description: item.description, priceCents: item.priceCents,
      priceType: item.priceType, imageUrl: item.imageUrl,
      isAvailable: item.isAvailable, availableOnline: item.availableOnline,
      stockStatus: item.stockStatus, dietaryTags: item.dietaryTags,
      sortOrder: item.sortOrder, isPopular: item.isPopular,
      modifierGroups: Array.from(item.modifierGroups.values()),
    })),
  }))

  // Uncategorized items
  const uncategorized = db
    .query<
      { id: string; name: string; description: string | null; price_cents: number; price_type: string; image_url: string | null; is_available: number },
      [string]
    >(
      `SELECT id, name, description, price_cents, price_type, image_url, is_available
       FROM menu_items WHERE merchant_id = ? AND category_id IS NULL ORDER BY sort_order ASC`
    )
    .all(merchantId)

  // All modifier groups — 2 queries instead of 2N
  type GroupModRow = {
    id: string; name: string; min_required: number; max_allowed: number | null
    pos_group_id: string | null; available_for_takeout: number; is_mandatory: number; input_order: number
    mod_id: string | null; mod_name: string | null; mod_price: number | null
    mod_is_available: number | null; mod_stock_status: string | null; mod_sort: number | null
  }

  const groupModRows = db
    .query<GroupModRow, [string]>(
      `SELECT mg.id, mg.name, mg.min_required, mg.max_allowed, mg.pos_group_id,
              mg.available_for_takeout, mg.is_mandatory, mg.input_order,
              m.id AS mod_id, m.name AS mod_name, m.price_cents AS mod_price,
              m.is_available AS mod_is_available, m.stock_status AS mod_stock_status,
              m.sort_order AS mod_sort
       FROM modifier_groups mg
       LEFT JOIN modifiers m ON m.group_id = mg.id
       WHERE mg.merchant_id = ?
       ORDER BY CASE WHEN mg.is_mandatory = 1 OR mg.min_required >= 1 THEN 0 ELSE 1 END ASC,
                mg.input_order ASC, mg.name ASC, m.sort_order ASC`
    )
    .all(merchantId)

  const assignedRows = db
    .query<{ group_id: string; item_id: string }, [string]>(
      `SELECT mimg.group_id, mimg.item_id
       FROM menu_item_modifier_groups mimg
       JOIN modifier_groups mg ON mg.id = mimg.group_id
       WHERE mg.merchant_id = ?`
    )
    .all(merchantId)

  const assignedByGroup = new Map<string, string[]>()
  for (const { group_id, item_id } of assignedRows) {
    let arr = assignedByGroup.get(group_id)
    if (!arr) { arr = []; assignedByGroup.set(group_id, arr) }
    arr.push(item_id)
  }

  const groupMap = new Map<string, {
    id: string; posGroupId: string | null; name: string
    minRequired: number; maxAllowed: number | null
    availableForTakeout: boolean; isMandatory: boolean; inputOrder: number
    modifiers: { id: string; name: string; priceCents: number; isAvailable: boolean; stockStatus: string; sortOrder: number }[]
    assignedItemIds: string[]
  }>()

  for (const row of groupModRows) {
    if (!groupMap.has(row.id)) {
      groupMap.set(row.id, {
        id: row.id, posGroupId: row.pos_group_id, name: row.name,
        minRequired: row.min_required, maxAllowed: row.max_allowed,
        availableForTakeout: row.available_for_takeout !== 0,
        isMandatory: row.is_mandatory === 1, inputOrder: row.input_order ?? 0,
        modifiers: [], assignedItemIds: assignedByGroup.get(row.id) ?? [],
      })
    }
    if (row.mod_id != null) {
      groupMap.get(row.id)!.modifiers.push({
        id: row.mod_id, name: row.mod_name!, priceCents: row.mod_price!,
        isAvailable: row.mod_is_available === 1,
        stockStatus: row.mod_stock_status ?? 'in_stock', sortOrder: row.mod_sort!,
      })
    }
  }

  const allModifierGroups = Array.from(groupMap.values())

  return c.json({
    categories: result,
    uncategorizedItems: uncategorized.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      priceCents: item.price_cents,
      priceType: item.price_type,
      imageUrl: item.image_url,
      isAvailable: item.is_available === 1,
      modifierGroups: [],
    })),
    allModifierGroups,
    lastSynced: db
      .query<{ value: string }, [string]>(
        `SELECT value FROM system_metadata WHERE key = ?`
      )
      .get(`menu_last_synced_${merchantId}`)?.value ?? null,
  })
})

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/menu/categories
// Create a new locally-managed menu category.
// ---------------------------------------------------------------------------
menu.post(
  '/api/merchants/:id/menu/categories',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const { name } = await c.req.json<{ name: string }>()

    if (!name || !name.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }

    const db = getDatabase()
    const id = `cat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    const maxRow = db
      .query<{ maxOrder: number | null }, [string]>(
        `SELECT MAX(sort_order) AS maxOrder FROM menu_categories WHERE merchant_id = ?`
      )
      .get(merchantId)
    const sortOrder = (maxRow && maxRow.maxOrder != null ? maxRow.maxOrder : -1) + 1

    db.run(
      `INSERT INTO menu_categories (id, merchant_id, name, sort_order, available_online, available_in_store)
       VALUES (?, ?, ?, ?, 1, 1)`,
      [id, merchantId, name.trim(), sortOrder]
    )

    return c.json({ success: true, id, name: name.trim() }, 201)
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/menu/categories/:catId
// Delete a category. SQLite ON DELETE SET NULL moves its items to Uncategorized.
// ---------------------------------------------------------------------------
menu.delete(
  '/api/merchants/:id/menu/categories/:catId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const catId = c.req.param('catId')

    const db = getDatabase()

    const cat = db
      .query<{ id: string; name: string }, [string, string]>(
        `SELECT id, name FROM menu_categories WHERE id = ? AND merchant_id = ?`
      )
      .get(catId, merchantId)

    if (!cat) return c.json({ error: 'Category not found' }, 404)

    const itemCount = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ?`
      )
      .get(catId)

    // ON DELETE SET NULL handles moving items to Uncategorized
    db.run(`DELETE FROM menu_categories WHERE id = ? AND merchant_id = ?`, [catId, merchantId])

    return c.json({ success: true, catId, itemsMoved: itemCount ? itemCount.n : 0 })
  }
)

// ---------------------------------------------------------------------------
// PUT /api/merchants/:id/menu/categories/:catId
// Update category: name, availableOnline, availableInStore, hoursStart, hoursEnd
// ---------------------------------------------------------------------------
menu.put(
  '/api/merchants/:id/menu/categories/:catId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const catId = c.req.param('catId')

    const { name, availableOnline, availableInStore, hoursStart, hoursEnd, courseOrder, isLastCourse, printDestination } = await c.req.json<{
      name?: string
      availableOnline?: boolean
      availableInStore?: boolean
      hoursStart?: string | null
      hoursEnd?: string | null
      /** Numbered course position (1, 2, 3…); null = main/un-numbered */
      courseOrder?: number | null
      /** true = "Last" position (e.g. Desserts) */
      isLastCourse?: boolean
      /** Where to print items from this category */
      printDestination?: 'both' | 'kitchen' | 'counter'
    }>()

    const db = getDatabase()

    const cat = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM menu_categories WHERE id = ? AND merchant_id = ?`
      )
      .get(catId, merchantId)

    if (!cat) return c.json({ error: 'Category not found' }, 404)

    if (name !== undefined) {
      if (!name.trim()) return c.json({ error: 'name cannot be empty' }, 400)
      db.run(
        `UPDATE menu_categories SET name = ?, updated_at = datetime('now') WHERE id = ?`,
        [name.trim(), catId]
      )
    }

    if (availableOnline !== undefined) {
      db.run(
        `UPDATE menu_categories SET available_online = ?, updated_at = datetime('now') WHERE id = ?`,
        [availableOnline ? 1 : 0, catId]
      )
    }

    if (availableInStore !== undefined) {
      db.run(
        `UPDATE menu_categories SET available_in_store = ?, updated_at = datetime('now') WHERE id = ?`,
        [availableInStore ? 1 : 0, catId]
      )
    }

    if (hoursStart !== undefined || hoursEnd !== undefined) {
      db.run(
        `UPDATE menu_categories SET hours_start = ?, hours_end = ?, updated_at = datetime('now') WHERE id = ?`,
        [hoursStart ?? null, hoursEnd ?? null, catId]
      )
    }

    if (courseOrder !== undefined) {
      db.run(
        `UPDATE menu_categories SET course_order = ?, updated_at = datetime('now') WHERE id = ?`,
        [courseOrder ?? null, catId]
      )
    }

    if (isLastCourse !== undefined) {
      db.run(
        `UPDATE menu_categories SET is_last_course = ?, updated_at = datetime('now') WHERE id = ?`,
        [isLastCourse ? 1 : 0, catId]
      )
    }

    if (printDestination !== undefined) {
      const valid = ['both', 'kitchen', 'counter']
      if (!valid.includes(printDestination)) return c.json({ error: 'Invalid printDestination' }, 400)
      db.run(
        `UPDATE menu_categories SET print_destination = ?, updated_at = datetime('now') WHERE id = ?`,
        [printDestination, catId]
      )
    }

    return c.json({ success: true, catId })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/menu/sync
// Imports menu from a POS provider and upserts into local DB.
// Body: { provider: 'clover' | 'toast' | 'square' }  (defaults to 'clover')
// ---------------------------------------------------------------------------

/** Factory: resolve a MenuImportAdapter for the given provider */
async function createMenuImporter(
  merchantId: string,
  provider: string
): Promise<MenuImportAdapter> {
  switch (provider) {
    case 'clover': {
      const apiKey = await getAPIKey(merchantId, 'pos', 'clover')
      if (!apiKey) throw Object.assign(new Error('Clover API key not configured'), { status: 400 })
      const cloverMerchantId = getPOSMerchantId(merchantId, 'clover')
      if (!cloverMerchantId) throw Object.assign(new Error('Clover Merchant ID not configured'), { status: 400 })
      return new CloverMenuImporter({
        merchantId: cloverMerchantId,
        posType: 'clover',
        apiKey,
        sandboxMode: process.env.CLOVER_SANDBOX === 'true',
      })
    }
    case 'toast':
      return new ToastMenuImporter()
    case 'square':
      return new SquareMenuImporter()
    default:
      throw Object.assign(new Error(`Unknown provider: ${provider}`), { status: 400 })
  }
}

menu.post(
  '/api/merchants/:id/menu/sync',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    const body = await c.req.json<{ provider?: string }>().catch(() => ({}))
    const provider = body.provider ?? 'clover'

    let adapter: MenuImportAdapter
    try {
      adapter = await createMenuImporter(merchantId, provider)
    } catch (err: any) {
      return c.json({ error: err.message }, err.status ?? 400)
    }

    let menuData: POSMenuData
    try {
      menuData = await adapter.fetchMenu()
    } catch (error) {
      return serverError(c, '[menu] sync', error, `Failed to fetch menu from ${provider}`, 502)
    }

    const db = getDatabase()

    // Upsert in a transaction for atomicity
    db.transaction(() => {
      // --- Categories ---
      for (const cat of menuData.categories) {
        db.run(
          `INSERT INTO menu_categories (id, merchant_id, name, sort_order, pos_category_id, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             sort_order = excluded.sort_order,
             updated_at = excluded.updated_at`,
          [cat.id, merchantId, cat.name, cat.sortOrder, cat.posCategoryId ?? cat.id]
        )

        // --- Items in this category ---
        for (const item of cat.items) {
          db.run(
            `INSERT INTO menu_items (id, merchant_id, category_id, pos_item_id, name, description, price_cents, price_type, is_available, sort_order, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
               category_id = excluded.category_id,
               name = excluded.name,
               description = excluded.description,
               price_cents = excluded.price_cents,
               price_type = excluded.price_type,
               is_available = excluded.is_available,
               sort_order = excluded.sort_order,
               updated_at = excluded.updated_at`,
            [
              item.id, merchantId, cat.id, item.posItemId ?? item.id,
              item.name, item.description ?? null,
              item.priceCents, item.priceType,
              item.isAvailable ? 1 : 0,
              item.sortOrder,
            ]
          )

          upsertModifierGroups(db, merchantId, item.id, item.modifierGroups)
        }
      }

      // --- Uncategorized items ---
      for (const item of menuData.uncategorizedItems) {
        db.run(
          `INSERT INTO menu_items (id, merchant_id, category_id, pos_item_id, name, description, price_cents, price_type, is_available, sort_order, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             category_id = NULL,
             name = excluded.name,
             description = excluded.description,
             price_cents = excluded.price_cents,
             price_type = excluded.price_type,
             is_available = excluded.is_available,
             sort_order = excluded.sort_order,
             updated_at = excluded.updated_at`,
          [
            item.id, merchantId, item.posItemId ?? item.id,
            item.name, item.description ?? null,
            item.priceCents, item.priceType,
            item.isAvailable ? 1 : 0,
            item.sortOrder,
          ]
        )

        upsertModifierGroups(db, merchantId, item.id, item.modifierGroups)
      }

      // Record sync timestamp
      db.run(
        `INSERT OR REPLACE INTO system_metadata (key, value, updated_at)
         VALUES (?, ?, datetime('now'))`,
        [`menu_last_synced_${merchantId}`, menuData.lastUpdated]
      )
    })()

    const totalItems =
      menuData.categories.reduce((n, c) => n + c.items.length, 0) +
      menuData.uncategorizedItems.length

    return c.json({
      success: true,
      categoriesCount: menuData.categories.length,
      itemsCount: totalItems,
      lastSynced: menuData.lastUpdated,
    })
  }
)

// ---------------------------------------------------------------------------
// PUT /api/merchants/:id/menu/items/:itemId/image
// Set or update the image URL for a menu item (merchant-managed, not from Clover)
// ---------------------------------------------------------------------------
menu.put(
  '/api/merchants/:id/menu/items/:itemId/image',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const itemId = c.req.param('itemId')

    const { imageUrl } = await c.req.json<{ imageUrl: string }>()

    if (!imageUrl || typeof imageUrl !== 'string') {
      return c.json({ error: 'imageUrl is required' }, 400)
    }
    // L-03: Only allow HTTPS URLs or absolute local paths — prevents malicious
    // URLs from being served to customers (e.g. javascript:, data:, http:)
    if (!imageUrl.startsWith('https://') && !imageUrl.startsWith('/images/')) {
      return c.json({ error: 'imageUrl must start with https:// or /images/' }, 400)
    }

    const db = getDatabase()
    const result = db.run(
      `UPDATE menu_items SET image_url = ?, updated_at = datetime('now')
       WHERE id = ? AND merchant_id = ?`,
      [imageUrl, itemId, merchantId]
    )

    if (result.changes === 0) {
      return c.json({ error: 'Item not found' }, 404)
    }

    return c.json({ success: true, itemId, imageUrl })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/images
// Upload a menu image (multipart/form-data, field name: "image").
// Saves to public/images/merchants/{merchantId}/ and returns the URL path.
// The dashboard converts to WebP client-side before uploading, so we just
// persist whatever binary the client sends.
// ---------------------------------------------------------------------------
menu.post(
  '/api/merchants/:id/images',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    const formData = await c.req.formData().catch(() => null)
    const file = formData?.get('image')

    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: 'image field is required (multipart/form-data)' }, 400)
    }

    // Accept only image MIME types
    if (!file.type.startsWith('image/')) {
      return c.json({ error: 'File must be an image' }, 400)
    }

    // Determine extension from MIME type
    const ext = file.type === 'image/webp' ? 'webp'
              : file.type === 'image/jpeg' ? 'jpg'
              : file.type === 'image/png'  ? 'png'
              : 'img'

    const dir = join(import.meta.dir, '../../public/images/merchants', merchantId)
    await mkdir(dir, { recursive: true })

    const filename = `${randomBytes(8).toString('hex')}.${ext}`
    const filepath = join(dir, filename)
    await writeFile(filepath, Buffer.from(await file.arrayBuffer()))

    const url = `/images/merchants/${merchantId}/${filename}`
    return c.json({ url })
  }
)

// ---------------------------------------------------------------------------
// PUT /api/merchants/:id/menu/items/:itemId
// Update item metadata (name, description, imageUrl) and modifier group assignments
// ---------------------------------------------------------------------------
menu.put(
  '/api/merchants/:id/menu/items/:itemId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const itemId = c.req.param('itemId')

    const body = await c.req.json<{
      name?: string
      description?: string | null
      priceCents?: number
      imageUrl?: string | null
      availableOnline?: boolean
      isPopular?: boolean
      stockStatus?: 'in_stock' | 'out_today' | 'out_indefinitely'
      dietaryTags?: string[]
      modifierGroupIds?: string[]
      categoryId?: string | null
    }>()

    const db = getDatabase()

    // Verify item belongs to this merchant
    const existing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM menu_items WHERE id = ? AND merchant_id = ?`
      )
      .get(itemId, merchantId)

    if (!existing) {
      return c.json({ error: 'Item not found' }, 404)
    }

    db.transaction(() => {
      // Update scalar fields only if provided
      if (body.name !== undefined || body.description !== undefined || body.priceCents !== undefined || body.imageUrl !== undefined || body.availableOnline !== undefined || body.stockStatus !== undefined || body.dietaryTags !== undefined || body.categoryId !== undefined) {
        const sets: string[] = []
        const params: unknown[] = []

        if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name) }
        if (body.description !== undefined) { sets.push('description = ?'); params.push(body.description) }
        if (body.priceCents !== undefined) {
          if (typeof body.priceCents !== 'number' || body.priceCents < 0) {
            return c.json({ error: 'priceCents must be a non-negative integer' }, 400)
          }
          sets.push('price_cents = ?'); params.push(body.priceCents)
        }
        if (body.imageUrl !== undefined) { sets.push('image_url = ?'); params.push(body.imageUrl) }
        if (body.availableOnline !== undefined) { sets.push('available_online = ?'); params.push(body.availableOnline ? 1 : 0) }
        if (body.isPopular !== undefined) { sets.push('is_popular = ?'); params.push(body.isPopular ? 1 : 0) }
        if (body.stockStatus !== undefined) { sets.push('stock_status = ?'); params.push(body.stockStatus) }
        if (body.dietaryTags !== undefined) { sets.push('dietary_tags = ?'); params.push(JSON.stringify(body.dietaryTags)) }
        if (body.categoryId !== undefined) { sets.push('category_id = ?'); params.push(body.categoryId) }

        sets.push("updated_at = datetime('now')")
        params.push(itemId, merchantId)

        db.run(
          `UPDATE menu_items SET ${sets.join(', ')} WHERE id = ? AND merchant_id = ?`,
          params as string[]
        )
      }

      // Reassign modifier groups if provided
      if (body.modifierGroupIds !== undefined) {
        db.run(`DELETE FROM menu_item_modifier_groups WHERE item_id = ?`, [itemId])

        for (let i = 0; i < body.modifierGroupIds.length; i++) {
          db.run(
            `INSERT OR REPLACE INTO menu_item_modifier_groups (item_id, group_id, sort_order) VALUES (?, ?, ?)`,
            [itemId, body.modifierGroupIds[i], i]
          )
        }
      }
    })()

    return c.json({ success: true, itemId })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/menu/items
// Create a new locally-managed menu item in a category.
// Body: { categoryId, name, priceCents, description?, imageUrl?,
//         stockStatus?, dietaryTags?, availableOnline?, modifierGroupIds? }
// ---------------------------------------------------------------------------
menu.post(
  '/api/merchants/:id/menu/items',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    const body = await c.req.json<{
      categoryId: string
      name: string
      priceCents: number
      description?: string | null
      imageUrl?: string | null
      isPopular?: boolean
      stockStatus?: 'in_stock' | 'out_today' | 'out_indefinitely'
      dietaryTags?: string[]
      availableOnline?: boolean
      modifierGroupIds?: string[]
    }>()

    if (!body.name?.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }
    if (typeof body.priceCents !== 'number' || body.priceCents < 0) {
      return c.json({ error: 'priceCents must be a non-negative integer' }, 400)
    }
    if (!body.categoryId) {
      return c.json({ error: 'categoryId is required' }, 400)
    }

    const db = getDatabase()

    // Verify category belongs to this merchant
    const cat = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM menu_categories WHERE id = ? AND merchant_id = ?`
      )
      .get(body.categoryId, merchantId)

    if (!cat) {
      return c.json({ error: 'Category not found' }, 404)
    }

    // Place new item at the end of the category
    const maxRow = db
      .query<{ maxOrder: number | null }, [string]>(
        `SELECT MAX(sort_order) AS maxOrder FROM menu_items WHERE category_id = ?`
      )
      .get(body.categoryId)

    const sortOrder = (maxRow?.maxOrder ?? -1) + 1
    const itemId = `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    db.transaction(() => {
      db.run(
        `INSERT INTO menu_items
           (id, merchant_id, category_id, name, description, price_cents,
            image_url, stock_status, dietary_tags, available_online, is_popular, sort_order,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [
          itemId,
          merchantId,
          body.categoryId,
          body.name.trim(),
          body.description?.trim() ?? null,
          body.priceCents,
          body.imageUrl ?? null,
          body.stockStatus ?? 'in_stock',
          JSON.stringify(body.dietaryTags ?? []),
          (body.availableOnline ?? true) ? 1 : 0,
          (body.isPopular ?? false) ? 1 : 0,
          sortOrder,
        ]
      )

      for (let i = 0; i < (body.modifierGroupIds?.length ?? 0); i++) {
        db.run(
          `INSERT OR REPLACE INTO menu_item_modifier_groups (item_id, group_id, sort_order) VALUES (?, ?, ?)`,
          [itemId, body.modifierGroupIds![i], i]
        )
      }
    })()

    return c.json({ success: true, itemId }, 201)
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/menu/items/:itemId
// Permanently removes a menu item and its modifier group assignments.
// ---------------------------------------------------------------------------
menu.delete(
  '/api/merchants/:id/menu/items/:itemId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const itemId = c.req.param('itemId')

    const db = getDatabase()

    const existing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM menu_items WHERE id = ? AND merchant_id = ?`
      )
      .get(itemId, merchantId)

    if (!existing) return c.json({ error: 'Item not found' }, 404)

    // Cascade deletes menu_item_modifier_groups via FK ON DELETE CASCADE
    db.run(`DELETE FROM menu_items WHERE id = ? AND merchant_id = ?`, [itemId, merchantId])

    return c.json({ success: true, itemId })
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/menu/categories/:catId/items/reorder
// Persist a new sort_order for items in a category after drag-and-drop
// ---------------------------------------------------------------------------
menu.patch(
  '/api/merchants/:id/menu/categories/:catId/items/reorder',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const catId = c.req.param('catId')
    const { itemIds } = await c.req.json<{ itemIds: string[] }>()

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return c.json({ error: 'itemIds must be a non-empty array' }, 400)
    }

    const db = getDatabase()

    db.transaction(() => {
      itemIds.forEach((id, index) => {
        db.run(
          `UPDATE menu_items SET sort_order = ? WHERE id = ? AND merchant_id = ? AND category_id = ?`,
          [index, id, merchantId, catId]
        )
      })
    })()

    return c.json({ success: true })
  }
)

// ---------------------------------------------------------------------------
// PUT /api/merchants/:id/menu/modifier-groups/:groupId/items
// Reassign which items use a given modifier group
// ---------------------------------------------------------------------------
menu.put(
  '/api/merchants/:id/menu/modifier-groups/:groupId/items',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const groupId = c.req.param('groupId')

    const body = await c.req.json<{ itemIds: string[] }>()

    if (!Array.isArray(body.itemIds)) {
      return c.json({ error: 'itemIds must be an array' }, 400)
    }

    const db = getDatabase()

    // Verify modifier group belongs to this merchant
    const group = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM modifier_groups WHERE id = ? AND merchant_id = ?`
      )
      .get(groupId, merchantId)

    if (!group) {
      return c.json({ error: 'Modifier group not found' }, 404)
    }

    db.transaction(() => {
      // Remove all current assignments for this group
      db.run(`DELETE FROM menu_item_modifier_groups WHERE group_id = ?`, [groupId])

      // Re-insert only the selected items
      for (let i = 0; i < body.itemIds.length; i++) {
        db.run(
          `INSERT OR REPLACE INTO menu_item_modifier_groups (item_id, group_id, sort_order) VALUES (?, ?, ?)`,
          [body.itemIds[i], groupId, i]
        )
      }
    })()

    return c.json({ success: true, groupId, itemCount: body.itemIds.length })
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/menu/modifiers/:modifierId/stock
// Set stock status on a single modifier (e.g. peanut sauce out today)
// ---------------------------------------------------------------------------
menu.patch(
  '/api/merchants/:id/menu/modifiers/:modifierId/stock',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const modifierId = c.req.param('modifierId')

    const { stockStatus } = await c.req.json<{ stockStatus: 'in_stock' | 'out_today' | 'out_indefinitely' }>()

    const valid = ['in_stock', 'out_today', 'out_indefinitely']
    if (!valid.includes(stockStatus)) {
      return c.json({ error: 'Invalid stockStatus' }, 400)
    }

    const db = getDatabase()

    // Verify modifier belongs to this merchant (via group → item → merchant)
    const exists = db
      .query<{ id: string }, [string, string]>(
        `SELECT m.id FROM modifiers m
         JOIN modifier_groups mg ON mg.id = m.group_id
         WHERE m.id = ? AND mg.merchant_id = ?`
      )
      .get(modifierId, merchantId)

    if (!exists) return c.json({ error: 'Modifier not found' }, 404)

    db.run(
      `UPDATE modifiers SET stock_status = ?, updated_at = datetime('now') WHERE id = ?`,
      [stockStatus, modifierId]
    )

    return c.json({ success: true, modifierId, stockStatus })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/menu/modifier-groups
// Create a new (empty) modifier group for this merchant.
// ---------------------------------------------------------------------------
menu.post(
  '/api/merchants/:id/menu/modifier-groups',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const { name } = await c.req.json<{ name: string }>()

    if (!name?.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }

    const db = getDatabase()
    const id = `mg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    // Initialize input_order to the current number of groups so each new group
    // gets a unique sequential position (0, 1, 2, …)
    const countRow = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM modifier_groups WHERE merchant_id = ?`
      )
      .get(merchantId)
    const inputOrder = countRow?.n ?? 0

    db.run(
      `INSERT INTO modifier_groups (id, merchant_id, name, min_required, max_allowed, available_for_takeout, input_order, updated_at)
       VALUES (?, ?, ?, 0, 1, 1, ?, datetime('now'))`,
      [id, merchantId, name.trim(), inputOrder]
    )

    return c.json({ success: true, id }, 201)
  }
)

// PUT /api/merchants/:id/menu/modifier-groups/:groupId/options
// Replace the ordered list of modifier options for a group.
// Each option: { id?, name, priceCents }
// Existing options (with id) are updated; omitted ones are deleted; new ones inserted.
// ---------------------------------------------------------------------------
menu.put(
  '/api/merchants/:id/menu/modifier-groups/:groupId/options',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const groupId = c.req.param('groupId')

    const { name: groupNameRaw, availableForTakeout, isMandatory, inputOrder, minRequired, maxAllowed, options } = await c.req.json<{
      name?: string
      availableForTakeout?: boolean
      /** true = must select before adding item to order */
      isMandatory?: boolean
      /** display/fill order when taking an order (lower = first) */
      inputOrder?: number
      /** minimum number of options the customer must select (0 = optional) */
      minRequired?: number
      /** maximum options allowed (null = unlimited, 1 = single-select) */
      maxAllowed?: number | null
      options: Array<{ id?: string; name: string; priceCents: number }>
    }>()

    if (!Array.isArray(options)) {
      return c.json({ error: 'options must be an array' }, 400)
    }

    const db = getDatabase()

    // Verify group belongs to this merchant
    const group = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM modifier_groups WHERE id = ? AND merchant_id = ?`
      )
      .get(groupId, merchantId)

    if (!group) return c.json({ error: 'Modifier group not found' }, 404)

    // FG-E2: validate modifier option prices before entering the transaction
    for (const opt of options) {
      if (typeof opt.priceCents !== 'number' || opt.priceCents < 0) {
        return c.json({ error: `Modifier option "${opt.name}" priceCents must be a non-negative integer` }, 400)
      }
    }

    db.transaction(() => {
      // Update group scalar fields if provided
      const groupName = groupNameRaw?.trim()
      if (groupName || availableForTakeout !== undefined || isMandatory !== undefined || inputOrder !== undefined || minRequired !== undefined || maxAllowed !== undefined) {
        const setParts: string[] = []
        const setVals: (string | number | null)[] = []
        if (groupName) { setParts.push('name = ?'); setVals.push(groupName) }
        if (availableForTakeout !== undefined) { setParts.push('available_for_takeout = ?'); setVals.push(availableForTakeout ? 1 : 0) }
        if (isMandatory !== undefined) { setParts.push('is_mandatory = ?'); setVals.push(isMandatory ? 1 : 0) }
        if (inputOrder !== undefined) { setParts.push('input_order = ?'); setVals.push(inputOrder) }
        if (minRequired !== undefined) { setParts.push('min_required = ?'); setVals.push(Math.max(0, Math.round(minRequired))) }
        if (maxAllowed !== undefined) { setParts.push('max_allowed = ?'); setVals.push(maxAllowed !== null ? Math.max(1, Math.round(maxAllowed)) : null) }
        setParts.push("updated_at = datetime('now')")
        // SECURITY (M-05): All SET field names above are hardcoded string literals —
        // never interpolate user-controlled strings into this template.
        db.run(`UPDATE modifier_groups SET ${setParts.join(', ')} WHERE id = ?`, [...setVals, groupId])
      }

      // Collect IDs of options being kept/updated
      const keptIds = options.filter((o) => o.id).map((o) => o.id as string)

      // Delete options not in the new list
      const existing = db
        .query<{ id: string }, [string]>(`SELECT id FROM modifiers WHERE group_id = ?`)
        .all(groupId)
        .map((r) => r.id)

      for (const existingId of existing) {
        if (!keptIds.includes(existingId)) {
          db.run(`DELETE FROM modifiers WHERE id = ?`, [existingId])
        }
      }

      // Upsert options in order (price already validated before transaction)
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]
        const id = opt.id ?? `mod_${Date.now()}_${i}`
        db.run(
          `INSERT INTO modifiers (id, group_id, name, price_cents, sort_order, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             price_cents = excluded.price_cents,
             sort_order = excluded.sort_order,
             updated_at = excluded.updated_at`,
          [id, groupId, opt.name.trim(), opt.priceCents, i]
        )
      }
    })()

    return c.json({ success: true, groupId, count: options.length })
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/menu/modifier-groups/reorder
// Persist the display order of modifier groups after a drag-and-drop reorder.
// Body: { order: string[] }  — array of group IDs in new display order (index = input_order)
// ---------------------------------------------------------------------------
menu.patch(
  '/api/merchants/:id/menu/modifier-groups/reorder',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const { order } = await c.req.json<{ order: string[] }>()

    if (!Array.isArray(order)) {
      return c.json({ error: 'order must be an array of group IDs' }, 400)
    }

    const db = getDatabase()

    db.transaction(() => {
      for (let i = 0; i < order.length; i++) {
        db.run(
          `UPDATE modifier_groups SET input_order = ?, updated_at = datetime('now')
           WHERE id = ? AND merchant_id = ?`,
          [i, order[i], merchantId]
        )
      }
    })()

    return c.json({ success: true })
  }
)

// ---------------------------------------------------------------------------
// Helper: upsert modifier groups and their modifiers for an item
// ---------------------------------------------------------------------------
function upsertModifierGroups(
  db: ReturnType<typeof getDatabase>,
  merchantId: string,
  itemId: string,
  groups: POSMenuData['categories'][0]['items'][0]['modifierGroups']
) {
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]

    db.run(
      `INSERT INTO modifier_groups (id, merchant_id, pos_group_id, name, min_required, max_allowed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         min_required = excluded.min_required,
         max_allowed = excluded.max_allowed,
         updated_at = excluded.updated_at`,
      [group.id, merchantId, group.posGroupId ?? group.id, group.name, group.minRequired, group.maxAllowed ?? null]
    )

    db.run(
      `INSERT OR REPLACE INTO menu_item_modifier_groups (item_id, group_id, sort_order)
       VALUES (?, ?, ?)`,
      [itemId, group.id, i]
    )

    for (let j = 0; j < group.modifiers.length; j++) {
      const mod = group.modifiers[j]
      db.run(
        `INSERT INTO modifiers (id, group_id, pos_modifier_id, name, price_cents, is_available, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           price_cents = excluded.price_cents,
           is_available = excluded.is_available,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
        [mod.id, group.id, mod.posModifierId ?? mod.id, mod.name, mod.priceCents, mod.isAvailable ? 1 : 0, j]
      )
    }
  }
}

export { menu }
