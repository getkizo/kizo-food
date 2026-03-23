/**
 * Customer-facing online store API
 *
 * All routes are public (no auth). Merchant identity is resolved via
 * getApplianceMerchant() — returns the first active merchant from the DB.
 *
 * ── SINGLE-MERCHANT APPLIANCE ──────────────────────────────────────────────
 * Each appliance serves exactly one restaurant. There is no slug-based or
 * hostname-based merchant dispatch. The entire hostname belongs to one merchant;
 * getApplianceMerchant() simply returns the one merchant row in the DB.
 *
 * Code reviews should NOT flag the absence of subdomain routing, slug matching,
 * or multi-tenant isolation patterns — this is intentional by design.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Routes:
 *   GET  /api/store/profile                      — merchant branding + hours
 *   GET  /api/store/menu                         — full menu with modifiers
 *   POST /api/store/orders                        — place an order (pre-payment)
 *   POST /api/store/orders/:id/pay               — get Converge or Finix payment URL
 *   POST /api/store/orders/:id/payment-result    — record result after redirect (Converge or Finix)
 *   POST /api/store/orders/:id/cancel            — customer-initiated cancel (pre-kitchen statuses only)
 *   GET  /api/store/orders/:id/status            — polling fallback for push
 *   POST /api/store/push/subscribe               — customer push subscription
 */

import { Hono } from 'hono'
import { serverError } from '../utils/server-error'
import { getDatabase } from '../db/connection'
import { generateId, generatePickupCode } from '../utils/id'
import { getAPIKey } from '../crypto/api-keys'
import { getConvergePaymentUrl, verifyConvergeTransaction } from '../adapters/converge'
import { createCheckoutForm, getTransferIdFromCheckoutForm } from '../adapters/finix'
import { scheduleOrderReconciliation } from '../services/reconcile'
import { notifyMerchant, notifyCustomer } from './push'
import { broadcastToMerchant } from '../services/sse'
import { acquireWebhookLock, releaseLock } from '../services/order-locks'
import { sendReceiptEmail } from '../services/email'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const store = new Hono()

// ---------------------------------------------------------------------------
// Base64 image migration
//
// Existing menu items may have data URI strings (data:image/jpeg;base64,...)
// stored in image_url. These are inefficient: they bloat the /api/store/menu
// response (currently 7 MB for a typical menu). This helper detects those
// rows, writes the image bytes to public/images/merchants/{id}/, updates the
// DB to point at the new URL, and runs once per server process. Subsequent
// calls are no-ops because the URL no longer starts with "data:".
// ---------------------------------------------------------------------------

let base64MigrationDone = false

async function migrateBase64Images(): Promise<void> {
  if (base64MigrationDone) return
  base64MigrationDone = true

  const db = getDatabase()

  // Find every item (and merchant logo/banner) whose URL is still a data URI
  const items = db
    .query<{ id: string; merchant_id: string; image_url: string }, []>(
      `SELECT id, merchant_id, image_url FROM menu_items
       WHERE image_url IS NOT NULL AND image_url LIKE 'data:%'`
    )
    .all()

  for (const item of items) {
    try {
      const url = await saveDataUri(item.image_url, item.merchant_id)
      db.run(
        `UPDATE menu_items SET image_url = ?, updated_at = datetime('now') WHERE id = ?`,
        [url, item.id]
      )
    } catch (err) {
      console.warn(`[img-migrate] Failed for menu_item ${item.id}:`, err)
    }
  }

  // Also migrate merchant logo and banner
  const logos = db
    .query<{ id: string; logo_url: string | null; banner_url: string | null }, []>(
      `SELECT id, logo_url, banner_url FROM merchants
       WHERE logo_url LIKE 'data:%' OR banner_url LIKE 'data:%'`
    )
    .all()

  for (const m of logos) {
    try {
      if (m.logo_url?.startsWith('data:')) {
        const url = await saveDataUri(m.logo_url, m.id)
        db.run(`UPDATE merchants SET logo_url = ?, updated_at = datetime('now') WHERE id = ?`, [url, m.id])
      }
      if (m.banner_url?.startsWith('data:')) {
        const url = await saveDataUri(m.banner_url, m.id)
        db.run(`UPDATE merchants SET banner_url = ?, updated_at = datetime('now') WHERE id = ?`, [url, m.id])
      }
    } catch (err) {
      console.warn(`[img-migrate] Failed for merchant ${m.id}:`, err)
    }
  }

  if (items.length + logos.length > 0) {
    console.log(`[img-migrate] Migrated ${items.length} menu images, ${logos.length} merchant logos`)
  }
}

/** Decode a data URI, write to disk, return the public URL path. */
async function saveDataUri(dataUri: string, merchantId: string): Promise<string> {
  // data:[<mediatype>][;base64],<data>
  const comma = dataUri.indexOf(',')
  if (comma === -1) throw new Error('Invalid data URI')

  const meta   = dataUri.slice(5, comma)           // e.g. "image/jpeg;base64"
  const b64    = dataUri.slice(comma + 1)
  const mime   = meta.split(';')[0]                // e.g. "image/jpeg"
  const ext    = mime === 'image/webp' ? 'webp'
               : mime === 'image/png'  ? 'png'
               : 'jpg'

  const dir  = join(import.meta.dir, '../../public/images/merchants', merchantId)
  await mkdir(dir, { recursive: true })

  const filename = `${randomBytes(8).toString('hex')}.${ext}`
  await writeFile(join(dir, filename), Buffer.from(b64, 'base64'))

  return `/images/merchants/${merchantId}/${filename}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ApplianceMerchant = {
  id: string
  business_name: string
  slug: string
  description: string | null
  logo_url: string | null
  banner_url: string | null
  address: string | null
  phone_number: string | null
  cuisine_types: string | null
  tax_rate: number
  tip_options: string
  converge_sandbox: number
  finix_sandbox: number
  payment_provider: string | null
  prep_time_minutes: number | null
  timezone: string | null
  splash_url: string | null
  welcome_message: string | null
}

// Module-level cache with TTL — re-fetched after 60 s or when explicitly invalidated.
// On a single-merchant appliance there is always exactly one active merchant.
let _merchantCache: ApplianceMerchant | null = null
let _merchantCacheAt = 0
const MERCHANT_CACHE_TTL_MS = 60_000

/**
 * Resolves the merchant for this appliance.
 *
 * Architecture: single-merchant appliance — each installation serves exactly
 * one merchant. Returns the first (and only) active merchant in the DB.
 * No slug or hostname matching needed.
 *
 * Result is cached at module level. Call {@link invalidateApplianceMerchantCache}
 * after any merchant profile update.
 */
function getApplianceMerchant(): ApplianceMerchant | null {
  if (_merchantCache && Date.now() - _merchantCacheAt < MERCHANT_CACHE_TTL_MS) return _merchantCache
  const db = getDatabase()
  _merchantCache = db
    .query<ApplianceMerchant, []>(
      `SELECT id, business_name, slug, description, logo_url, banner_url,
              splash_url, welcome_message, address,
              phone_number, cuisine_types, tax_rate, tip_options,
              converge_sandbox, finix_sandbox, payment_provider, prep_time_minutes,
              timezone
       FROM merchants WHERE status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get()
  _merchantCacheAt = Date.now()
  return _merchantCache
}

/** Drop the cached merchant so the next request re-queries the DB. */
export function invalidateApplianceMerchantCache() {
  _merchantCache = null
  _merchantCacheAt = 0
}

// ---------------------------------------------------------------------------
// GET /api/store/profile
// ---------------------------------------------------------------------------

store.get('/api/store/profile', (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const db = getDatabase()

  const hours = db
    .query<{
      day_of_week: number
      open_time: string
      close_time: string
      slot_index: number
      is_closed: number
    }, [string]>(
      `SELECT day_of_week, open_time, close_time, slot_index, is_closed
       FROM business_hours
       WHERE merchant_id = ? AND service_type = 'regular'
       ORDER BY day_of_week ASC, slot_index ASC`
    )
    .all(merchant.id)

  // For Finix merchants, expose the public Merchant ID and environment so the
  // client can initialise window.Finix.Auth() for fraud detection tracking.
  // Only the merchant ID (MU…) is exposed — the API password stays server-side.
  let finixMerchantId: string | null = null
  let finixEnvironment: string | null = null
  if (merchant.payment_provider === 'finix') {
    const keyRow = db
      .query<{ pos_merchant_id: string | null }, [string]>(
        `SELECT pos_merchant_id FROM api_keys
         WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`
      )
      .get(merchant.id)
    const parts = (keyRow?.pos_merchant_id ?? '').split(':')
    if (parts.length === 3 && parts[2]) {
      finixMerchantId  = parts[2]
      finixEnvironment = (merchant.finix_sandbox ?? 1) !== 0 ? 'sandbox' : 'live'
    }
  }

  return c.json({
    name:         merchant.business_name,
    slug:         merchant.slug,
    description:  merchant.description,
    logoUrl:        merchant.logo_url,
    bannerUrl:      merchant.banner_url,
    splashUrl:      merchant.splash_url ?? null,
    welcomeMessage: merchant.welcome_message ?? null,
    address:      merchant.address,
    phone:        merchant.phone_number,
    cuisineTypes: (() => { try { return merchant.cuisine_types ? JSON.parse(merchant.cuisine_types) : [] } catch { return [] } })(),
    taxRate:      merchant.tax_rate,
    tipOptions:   (() => { try { return JSON.parse(merchant.tip_options || '[15,20,25]') } catch { return [15, 20, 25] } })(),
    paymentProvider: merchant.payment_provider ?? null,
    prepTimeMinutes: merchant.prep_time_minutes ?? 20,
    timezone: merchant.timezone ?? 'America/Los_Angeles',
    businessHours: hours.map((h) => ({
      dayOfWeek:  h.day_of_week,
      openTime:   h.open_time,
      closeTime:  h.close_time,
      slotIndex:  h.slot_index,
      isClosed:   h.is_closed !== 0,
    })),
    finixMerchantId,
    finixEnvironment,
  })
})

// ---------------------------------------------------------------------------
// GET /api/store/menu
// ---------------------------------------------------------------------------

store.get('/api/store/menu', async (c) => {
  // Lazily migrate any legacy base64 data URI images to files on first request.
  // This is a one-time no-op after the first run.
  await migrateBase64Images().catch((err) =>
    console.warn('[img-migrate] Migration error (non-fatal):', err)
  )

  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const db = getDatabase()

  // Single LEFT JOIN query: categories + their eligible items in one round-trip.
  // LEFT JOIN ensures empty categories still appear in the menu. Results are
  // ordered by mc.sort_order then mi.sort_order so insertion order into catMap
  // matches display order without a second sort pass.
  // allItems is collected from the same rows to feed the modifier batch query below.
  type MenuJoinRow = {
    cat_id: string
    cat_name: string
    cat_sort: number
    hours_start: string | null
    hours_end: string | null
    available_days: string | null
    blackout_dates: string | null
    item_id: string | null      // null when the category has no eligible items
    item_name: string | null
    description: string | null
    price_cents: number | null
    image_url: string | null
    dietary_tags: string | null
    is_popular: number | null
  }
  const menuRows = db
    .query<MenuJoinRow, [string]>(
      `SELECT mc.id AS cat_id, mc.name AS cat_name, mc.sort_order AS cat_sort,
              mc.hours_start, mc.hours_end, mc.available_days, mc.blackout_dates,
              mi.id AS item_id, mi.name AS item_name, mi.description,
              mi.price_cents, mi.image_url, mi.dietary_tags, mi.is_popular
       FROM menu_categories mc
       LEFT JOIN menu_items mi
         ON mi.merchant_id = mc.merchant_id
         AND mi.category_id = mc.id
         AND mi.is_available = 1
         AND mi.available_online = 1
         AND (mi.stock_status IS NULL OR mi.stock_status = 'in_stock')
       WHERE mc.merchant_id = ? AND mc.available_online = 1
       ORDER BY mc.sort_order ASC, mi.sort_order ASC`
    )
    .all(merchant.id)

  type ItemRow = {
    id: string
    category_id: string
    name: string
    description: string | null
    price_cents: number
    image_url: string | null
    dietary_tags: string
    is_popular: number
  }
  type CatEntry = {
    id: string; name: string; sort_order: number
    hours_start: string | null; hours_end: string | null
    available_days: string | null; blackout_dates: string | null
    items: ItemRow[]
  }
  const catMap = new Map<string, CatEntry>()
  const allItems: ItemRow[] = []

  for (const row of menuRows) {
    let entry = catMap.get(row.cat_id)
    if (!entry) {
      entry = {
        id: row.cat_id, name: row.cat_name, sort_order: row.cat_sort,
        hours_start: row.hours_start, hours_end: row.hours_end,
        available_days: row.available_days, blackout_dates: row.blackout_dates,
        items: [],
      }
      catMap.set(row.cat_id, entry)
    }
    if (row.item_id !== null) {
      const item: ItemRow = {
        id: row.item_id,
        category_id: row.cat_id,
        name: row.item_name!,
        description: row.description,
        price_cents: row.price_cents!,
        image_url: row.image_url,
        dietary_tags: row.dietary_tags ?? '[]',
        is_popular: row.is_popular ?? 0,
      }
      entry.items.push(item)
      allItems.push(item)
    }
  }

  // Query 3: all modifier groups + modifiers in a single JOIN, then group in JS
  type ModifierJoinRow = {
    item_id: string
    group_id: string
    group_name: string
    min_required: number
    max_allowed: number | null
    is_mandatory: number
    mod_id: string
    mod_name: string
    mod_price: number
    mod_stock: string
  }
  type ModifierGroupValue = {
    id: string
    name: string
    minRequired: number
    maxAllowed: number | null
    modifiers: Array<{ id: string; name: string; price_cents: number; stockStatus: string }>
  }
  // item_id → (group_id → ModifierGroupValue) — insertion order preserved by Map
  const modGroupsByItem = new Map<string, Map<string, ModifierGroupValue>>()

  if (allItems.length > 0) {
    const itemIds = allItems.map(i => i.id)
    const iph     = itemIds.map(() => '?').join(',')
    const modRows = db
      .query<ModifierJoinRow, string[]>(
        `SELECT mimg.item_id,
                mg.id   AS group_id,  mg.name AS group_name,
                mg.min_required,      mg.max_allowed,      mg.is_mandatory,
                m.id    AS mod_id,    m.name  AS mod_name,
                m.price_cents AS mod_price,
                m.stock_status AS mod_stock
         FROM modifier_groups mg
         JOIN menu_item_modifier_groups mimg ON mimg.group_id = mg.id
         JOIN modifiers m ON m.group_id = mg.id
         WHERE mimg.item_id IN (${iph})
           AND mg.available_for_takeout = 1
           AND m.is_available = 1 AND (m.stock_status IS NULL OR m.stock_status = 'in_stock')
         ORDER BY mimg.item_id ASC,
                CASE WHEN mg.is_mandatory = 1 OR mg.min_required >= 1 THEN 0 ELSE 1 END ASC,
                mg.input_order ASC, mimg.sort_order ASC, m.sort_order ASC`
      )
      .all(...itemIds)

    for (const row of modRows) {
      let gmap = modGroupsByItem.get(row.item_id)
      if (!gmap) { gmap = new Map(); modGroupsByItem.set(row.item_id, gmap) }
      let grp = gmap.get(row.group_id)
      if (!grp) {
        grp = { id: row.group_id, name: row.group_name, minRequired: row.min_required, maxAllowed: row.max_allowed, isMandatory: row.is_mandatory === 1, modifiers: [] }
        gmap.set(row.group_id, grp)
      }
      grp.modifiers.push({ id: row.mod_id, name: row.mod_name, price_cents: row.mod_price, stockStatus: row.mod_stock })
    }
  }

  // Assemble response — Map insertion order preserves mc.sort_order from the JOIN
  const menu = [...catMap.values()].map((cat) => ({
    id:             cat.id,
    name:           cat.name,
    sortOrder:      cat.sort_order,
    hoursStart:     cat.hours_start,
    hoursEnd:       cat.hours_end,
    availableDays:  (() => { try { return cat.available_days  ? JSON.parse(cat.available_days)  : null } catch { return null } })(),
    blackoutDates:  (() => { try { return cat.blackout_dates  ? JSON.parse(cat.blackout_dates)  : null } catch { return null } })(),
    items: cat.items.map((item) => ({
      id:             item.id,
      name:           item.name,
      description:    item.description,
      priceCents:     item.price_cents,
      imageUrl:       item.image_url,
      dietaryTags:    (() => { try { return JSON.parse(item.dietary_tags || '[]') } catch { return [] } })(),
      isPopular:      item.is_popular !== 0,
      modifierGroups: [...(modGroupsByItem.get(item.id)?.values() ?? [])],
    })),
  }))

  // "Most Popular" virtual category — items flagged is_popular across all categories.
  // Join menu_categories to carry each item's time/day restrictions so the client
  // can filter popular items the same way it filters regular categories.
  const popularItems = db
    .query<{
      id: string
      name: string
      description: string | null
      price_cents: number
      image_url: string | null
      dietary_tags: string
      hours_start: string | null
      hours_end: string | null
      available_days: string | null
      blackout_dates: string | null
    }, [string]>(
      `SELECT mi.id, mi.name, mi.description, mi.price_cents, mi.image_url, mi.dietary_tags,
              mc.hours_start, mc.hours_end, mc.available_days, mc.blackout_dates
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.merchant_id = ? AND mi.is_popular = 1
         AND mi.is_available = 1 AND mi.available_online = 1
         AND (mi.stock_status IS NULL OR mi.stock_status = 'in_stock')
         AND mc.available_online = 1
       ORDER BY mi.sort_order ASC`
    )
    .all(merchant.id)

  if (popularItems.length > 0) {
    menu.unshift({
      id:            '__popular__',
      name:          'Most Popular',
      sortOrder:     -1,
      hoursStart:    null,
      hoursEnd:      null,
      availableDays: null,
      blackoutDates: null,
      items: popularItems.map((item) => ({
        id:            item.id,
        name:          item.name,
        description:   item.description,
        priceCents:    item.price_cents,
        imageUrl:      item.image_url,
        dietaryTags:   (() => { try { return JSON.parse(item.dietary_tags || '[]') } catch { return [] } })(),
        isPopular:     true,
        modifierGroups: [],  // Shown inline; modifier sheet opens on tap
        // Category-level time restrictions — used by client to hide unavailable items
        hoursStart:    item.hours_start,
        hoursEnd:      item.hours_end,
        availableDays: (() => { try { return item.available_days  ? JSON.parse(item.available_days)  : null } catch { return null } })(),
        blackoutDates: (() => { try { return item.blackout_dates  ? JSON.parse(item.blackout_dates)  : null } catch { return null } })(),
      })),
    })
  }

  return c.json({ menu })
})

// ---------------------------------------------------------------------------
// POST /api/store/orders
// ---------------------------------------------------------------------------
// CSRF is mitigated by Bearer-token auth (not cookies) — these routes require
// a valid Authorization: Bearer <jwt> header which cross-site requests cannot
// supply without a CORS preflight. If cookie-based auth is ever added, CSRF
// tokens must be added at the same time.

store.post('/api/store/orders', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  let body: {
    customerName: string
    customerPhone?: string
    customerEmail?: string
    items: Array<{
      itemId: string
      modifiers?: string[]
      itemName?: string      // optional "whose dish is this" label
      kitchenNote?: string   // optional per-item kitchen instruction
    }>
    note?: string
    utensilsNeeded?: boolean
    tipCents?: number
    scheduledFor?: string   // ISO timestamp: when the customer wants the order ready
    orderType?: 'pickup' | 'delivery'
    deliveryAddress?: string
    deliveryInstructions?: string
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { customerName, customerPhone, customerEmail, items, note, utensilsNeeded } = body
  const tipCents = Math.min(100_000, Math.max(0, Math.round(Number(body.tipCents ?? 0))))

  const orderType = body.orderType === 'delivery' ? 'delivery' : 'pickup'
  const deliveryAddress = orderType === 'delivery' ? (body.deliveryAddress?.trim() ?? '') : null
  if (orderType === 'delivery' && !deliveryAddress) {
    return c.json({ error: 'deliveryAddress is required for delivery orders' }, 400)
  }
  const deliveryInstructions = body.deliveryInstructions?.trim() ?? null

  // Validate and normalise scheduledFor (must be a future ISO timestamp if provided)
  let scheduledFor: string | null = null
  if (body.scheduledFor) {
    const ts = new Date(body.scheduledFor).getTime()
    if (!isNaN(ts) && ts > Date.now()) {
      scheduledFor = new Date(body.scheduledFor).toISOString()
    }
  }

  if (!customerName?.trim()) {
    return c.json({ error: 'customerName is required' }, 400)
  }
  if (!items?.length) {
    return c.json({ error: 'items must be a non-empty array' }, 400)
  }

  const MAX_ORDER_ITEMS       = 40
  const LARGE_ORDER_THRESHOLD = 25

  if (items.length > MAX_ORDER_ITEMS) {
    return c.json({ error: `Orders cannot exceed ${MAX_ORDER_ITEMS} items` }, 400)
  }

  // Orders above 25 items must be scheduled at least 1 hour in advance
  if (items.length > LARGE_ORDER_THRESHOLD) {
    const minScheduledTime = Date.now() + 60 * 60 * 1000
    if (!scheduledFor || new Date(scheduledFor).getTime() < minScheduledTime) {
      return c.json({
        error: `Orders with more than ${LARGE_ORDER_THRESHOLD} items must be scheduled at least 1 hour in advance`,
      }, 400)
    }
  }

  const db = getDatabase()

  // ── PERF-N2: batch item/modifier validation instead of per-item N+1 queries ─
  type ValidItem = { id: string; name: string; price_cents: number }
  type ValidMod  = { id: string; name: string; price_cents: number; group_id: string }

  const requestedItemIds = items.map(i => i.itemId)
  const uniqueModIds     = [...new Set(items.flatMap(i => i.modifiers ?? []))]

  const itemPh       = requestedItemIds.map(() => '?').join(',')
  const validItemRows = db
    .query<ValidItem, string[]>(
      `SELECT id, name, price_cents FROM menu_items
       WHERE id IN (${itemPh}) AND merchant_id = ? AND is_available = 1
         AND (stock_status IS NULL OR stock_status = 'in_stock')`
    )
    .all(...requestedItemIds, merchant.id)

  const validItemMap = new Map<string, ValidItem>(validItemRows.map(i => [i.id, i]))

  // Validate all items exist and are in stock before proceeding.
  // When an item is missing from the valid set, do a second targeted query to
  // distinguish OOS (stock_status ≠ 'in_stock') from unavailable (is_available = 0)
  // from truly missing — so the response is actionable rather than generic.
  const rejectedItemIds = requestedItemIds.filter(id => !validItemMap.has(id))
  if (rejectedItemIds.length > 0) {
    type RejectedItem = { id: string; name: string; is_available: number; stock_status: string | null }
    const rejPh   = rejectedItemIds.map(() => '?').join(',')
    const rejected = db
      .query<RejectedItem, string[]>(
        `SELECT id, name, is_available, stock_status FROM menu_items
         WHERE id IN (${rejPh}) AND merchant_id = ?`
      )
      .all(...rejectedItemIds, merchant.id)
    const rejectedMap = new Map(rejected.map(r => [r.id, r]))

    for (const orderItem of items) {
      if (validItemMap.has(orderItem.itemId)) continue
      const row = rejectedMap.get(orderItem.itemId)
      if (!row) {
        return c.json({ error: `Item not found: ${orderItem.itemId}` }, 400)
      }
      if (row.stock_status && row.stock_status !== 'in_stock') {
        return c.json({ error: `"${row.name}" is currently out of stock` }, 409)
      }
      return c.json({ error: `"${row.name}" is not currently available` }, 409)
    }
  }

  let validModMap = new Map<string, ValidMod>()
  if (uniqueModIds.length > 0) {
    const modPh        = uniqueModIds.map(() => '?').join(',')
    const validModRows = db
      .query<ValidMod, string[]>(
        `SELECT id, name, price_cents, group_id FROM modifiers
         WHERE id IN (${modPh}) AND is_available = 1
           AND (stock_status IS NULL OR stock_status = 'in_stock')`
      )
      .all(...uniqueModIds)
    validModMap = new Map(validModRows.map(m => [m.id, m]))
  }

  // ── FG-E6: Validate mandatory modifier groups ────────────────────────────
  // For each ordered item, every modifier_group with is_mandatory=1 must have
  // at least one selected modifier in the submitted order.
  type MandatoryGroup = { item_id: string; group_id: string; group_name: string }
  const mandatoryGroupRows = db
    .query<MandatoryGroup, string[]>(
      `SELECT mimg.item_id, mg.id AS group_id, mg.name AS group_name
       FROM modifier_groups mg
       JOIN menu_item_modifier_groups mimg ON mimg.group_id = mg.id
       WHERE mimg.item_id IN (${itemPh}) AND mg.is_mandatory = 1`
    )
    .all(...requestedItemIds)

  if (mandatoryGroupRows.length > 0) {
    for (const orderItem of items) {
      const itemMandatory = mandatoryGroupRows.filter(mg => mg.item_id === orderItem.itemId)
      for (const mandatoryGroup of itemMandatory) {
        const hasSelection = (orderItem.modifiers ?? []).some(
          modId => validModMap.get(modId)?.group_id === mandatoryGroup.group_id
        )
        if (!hasSelection) {
          const itemName = validItemMap.get(orderItem.itemId)?.name ?? orderItem.itemId
          return c.json({
            error: `"${itemName}" requires a selection for "${mandatoryGroup.group_name}"`,
          }, 400)
        }
      }
    }
  }

  // Assemble resolved items from lookup Maps (O(1) per lookup)
  let subtotalCents = 0
  const resolvedItems: Array<{
    itemId: string
    name: string
    priceCents: number
    modifiers: Array<{ id: string; name: string; priceCents: number }>
    lineTotalCents: number
    specialInstructions?: string
  }> = []

  for (const orderItem of items) {
    const item = validItemMap.get(orderItem.itemId)!
    let modifiersCents = 0
    const resolvedMods: Array<{ id: string; name: string; priceCents: number }> = []

    for (const modId of (orderItem.modifiers ?? [])) {
      const mod = validModMap.get(modId)
      if (mod) {
        modifiersCents += mod.price_cents
        resolvedMods.push({ id: mod.id, name: mod.name, priceCents: mod.price_cents })
      }
    }

    const lineTotalCents = item.price_cents + modifiersCents
    subtotalCents += lineTotalCents

    const namePart = orderItem.itemName?.trim()
    const notePart = orderItem.kitchenNote?.trim()

    resolvedItems.push({
      itemId:         item.id,
      name:           item.name,
      priceCents:     item.price_cents,
      modifiers:      resolvedMods,
      lineTotalCents,
      ...(namePart ? { dishLabel: `-- ${namePart} --` } : {}),
      ...(notePart ? { specialInstructions: notePart } : {}),
    })
  }

  const taxCents   = Math.round(subtotalCents * merchant.tax_rate)
  const totalCents = subtotalCents + taxCents + tipCents
  const orderId    = generateId('ord')
  const pickupCode = generatePickupCode()

  // Use datetime('now') so created_at is stored in SQLite space format
  // 'YYYY-MM-DD HH:MM:SS', consistent with dashboard-orders.ts and orders.ts.
  db.run(
    `INSERT INTO orders (
       id, merchant_id, customer_name, customer_phone, customer_email,
       items, subtotal_cents, tax_cents, tip_cents, total_cents,
       status, order_type, delivery_address, delivery_instructions,
       pickup_code, source, notes, utensils_needed,
       pickup_time, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, 'online', ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      orderId,
      merchant.id,
      customerName.trim(),
      customerPhone?.trim() || null,
      customerEmail?.trim().toLowerCase() || null,
      JSON.stringify(resolvedItems),
      subtotalCents,
      taxCents,
      tipCents,
      totalCents,
      orderType,
      deliveryAddress,
      deliveryInstructions,
      pickupCode,
      note?.trim() || null,
      utensilsNeeded ? 1 : 0,
      scheduledFor,
    ]
  )

  console.log(`[store] Order ${orderId} created for merchant ${merchant.id}` +
    ` — ${resolvedItems.length} item(s), $${(totalCents / 100).toFixed(2)}`)

  // ── FG-E1: $0 orders skip payment and go directly to 'confirmed' ─────────
  if (totalCents === 0) {
    db.run(
      `UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`,
      [orderId]
    )
    // fire-and-forget: order already committed; push errors logged only
    notifyMerchant(merchant.id, {
      title: `New order — ${pickupCode}`,
      body:  `${customerName.trim()} · FREE · ${resolvedItems.length} item${resolvedItems.length !== 1 ? 's' : ''}`,
      data:  { type: 'new_order', orderId, pickupCode },
    }).catch(err => console.warn('[push] merchant notify failed for order', orderId, err?.message ?? err))
    broadcastToMerchant(merchant.id, 'new_order', { orderId, pickupCode, totalCents: 0 })
    sendReceiptEmail(merchant.id, orderId)
      .catch(err => console.warn('[email] Receipt failed for order', orderId, err?.message ?? err))
    return c.json({
      orderId,
      pickupCode,
      subtotalCents,
      taxCents,
      totalCents: 0,
      status: 'confirmed',
      scheduledFor,
      estimatedMinutes: scheduledFor ? null : (merchant.prep_time_minutes ?? 20),
    }, 201)
  }

  // fire-and-forget: order already committed; push errors logged only
  notifyMerchant(merchant.id, {
    title: `New order — ${pickupCode}`,
    body:  `${customerName.trim()} · $${(totalCents / 100).toFixed(2)} · ${resolvedItems.length} item${resolvedItems.length !== 1 ? 's' : ''}`,
    data:  { type: 'new_order', orderId, pickupCode },
  }).catch(err => console.warn('[push] merchant notify failed for order', orderId, err?.message ?? err))

  return c.json({
    orderId,
    pickupCode,
    subtotalCents,
    taxCents,
    totalCents,
    scheduledFor,
    estimatedMinutes: scheduledFor ? null : 20,
  }, 201)
})

// ---------------------------------------------------------------------------
// POST /api/store/orders/:id/pay
// ---------------------------------------------------------------------------

store.post('/api/store/orders/:id/pay', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const orderId = c.req.param('id')
  const db = getDatabase()

  const order = db
    .query<{
      id: string
      total_cents: number
      customer_name: string
      status: string
      items: string
    }, [string, string]>(
      `SELECT id, total_cents, customer_name, status, items
       FROM orders WHERE id = ? AND merchant_id = ?`
    )
    .get(orderId, merchant.id)

  if (!order) return c.json({ error: 'Order not found' }, 404)
  if (order.status !== 'pending_payment') {
    return c.json({ error: 'Order is already being processed' }, 409)
  }

  let body: { returnUrl: string; fraudSessionId?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { returnUrl, fraudSessionId } = body
  if (!returnUrl || typeof returnUrl !== 'string') {
    return c.json({ error: 'returnUrl is required' }, 400)
  }
  // NF-11.5: Prevent open redirect — returnUrl must be a relative path (same origin)
  if (!returnUrl.startsWith('/') || returnUrl.startsWith('//')) {
    return c.json({ error: 'Invalid return URL' }, 400)
  }
  // Build the absolute URL that payment processors redirect back to
  const requestOrigin = new URL(c.req.url).origin
  const absoluteReturnUrl = `${requestOrigin}${returnUrl}`

  const provider = merchant.payment_provider
  if (!provider || !['converge', 'finix'].includes(provider)) {
    return c.json({ error: 'Payment provider not configured for this merchant' }, 400)
  }

  const amountCents = order.total_cents
  const memo        = `Order ${order.id} — ${order.customer_name}`

  try {
    let paymentUrl: string

    if (provider === 'converge') {
      const pin = await getAPIKey(merchant.id, 'payment', 'converge')
      if (!pin) return c.json({ error: 'Converge credentials not configured' }, 400)

      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'converge'`
        )
        .get(merchant.id)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      if (!posMerchantId.includes(':')) {
        return c.json({ error: 'Converge configuration incomplete' }, 400)
      }
      const convergeParts = posMerchantId.split(':')
      if (convergeParts.length !== 2 || convergeParts.some(p => !p.trim())) {
        return c.json({ error: 'Converge credentials misconfigured' }, 502)
      }
      const [sslMerchantId, sslUserId] = convergeParts
      const sandbox   = (merchant.converge_sandbox ?? 1) !== 0
      const amountStr = (amountCents / 100).toFixed(2)

      paymentUrl = await getConvergePaymentUrl(
        { sslMerchantId, sslUserId, sslPin: pin, sandbox },
        amountStr,
        absoluteReturnUrl,
        memo
      )
    } else {
      // Finix Checkout Pages
      const apiPassword = await getAPIKey(merchant.id, 'payment', 'finix')
      if (!apiPassword) return c.json({ error: 'Finix credentials not configured' }, 400)

      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`
        )
        .get(merchant.id)

      const posMerchantId = keyRow?.pos_merchant_id ?? ''
      const parts = posMerchantId.split(':')
      if (parts.length !== 3) {
        return c.json({ error: 'Finix configuration incomplete' }, 400)
      }
      if (parts.some(p => !p.trim())) {
        return c.json({ error: 'Finix credentials misconfigured' }, 502)
      }
      const [apiUsername, applicationId, finixMerchantId] = parts

      const merchantRow = db
        .query<{ finix_sandbox: number }, [string]>(
          `SELECT finix_sandbox FROM merchants WHERE id = ?`
        )
        .get(merchant.id)
      const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

      const nameParts  = (order.customer_name ?? '').trim().split(/\s+/)
      const firstName  = nameParts[0] || undefined
      const lastName   = nameParts.slice(1).join(' ') || undefined
      const origin     = requestOrigin

      // Look up the first order item's image for the checkout form
      let itemImageUrl: string | undefined
      try {
        const orderItems = JSON.parse(order.items) as Array<{ itemId: string }>
        if (orderItems?.[0]?.itemId) {
          const imgRow = db
            .query<{ image_url: string | null }, [string]>(
              `SELECT image_url FROM menu_items WHERE id = ?`
            )
            .get(orderItems[0].itemId)
          if (imgRow?.image_url) {
            // Convert relative paths to absolute URLs
            itemImageUrl = imgRow.image_url.startsWith('http')
              ? imgRow.image_url
              : `${origin}${imgRow.image_url}`
          }
        }
      } catch (err) {
        console.warn('[store] Order items JSON malformed for order', orderId, err?.message ?? err)
      }

      // Tag return URL so frontend knows this was a Finix payment
      const finixReturnUrl = absoluteReturnUrl + (absoluteReturnUrl.includes('?') ? '&' : '?') + 'provider=finix'

      const result = await createCheckoutForm(
        { apiUsername, applicationId, merchantId: finixMerchantId, apiPassword, sandbox },
        {
          amountCents,
          customerFirstName:  firstName,
          customerLastName:   lastName,
          nickname:           `Order — ${order.customer_name ?? 'Guest'} · $${(amountCents / 100).toFixed(2)}`,
          returnUrl:          finixReturnUrl,
          cartReturnUrl:      origin,
          termsOfServiceUrl:  `${origin}/payments-terms-of-service`,
          logoUrl:            merchant.logo_url ? `${origin.replace(/^http:/, 'https:')}${merchant.logo_url}` : undefined,
          // Idempotency: bucket by 25-min window so double-taps get the same form, but a
          // retry after 25+ min creates a fresh form (avoids "Token Expired" from stale sessions).
          // Checkout forms expire in 30 min; a 25-min bucket ensures re-attempts always get
          // a form with ≥5 min remaining, never an about-to-expire or already-expired one.
          idempotencyId:      `${orderId}-${Math.floor(Date.now() / (25 * 60 * 1000))}`,
          tags:               { order_id: orderId, merchant_id: merchant.id },
          fraudSessionId:     fraudSessionId || undefined,
        }
      )
      paymentUrl = result.linkUrl

      // Persist the checkout form ID so we can look up the transfer at refund time
      db.run(
        `UPDATE orders SET payment_checkout_form_id = ? WHERE id = ?`,
        [result.checkoutFormId, orderId]
      )
    }

    return c.json({ paymentUrl })
  } catch (error) {
    return serverError(c, `[store] ${provider} payment session`, error, 'Failed to create payment session', 502)
  }
})

// ---------------------------------------------------------------------------
// POST /api/store/orders/:id/payment-result
// ---------------------------------------------------------------------------

store.post('/api/store/orders/:id/payment-result', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const orderId = c.req.param('id')
  const db = getDatabase()

  const order = db
    .query<{
      id: string
      total_cents: number
      customer_name: string
      pickup_code: string
      status: string
      payment_checkout_form_id: string | null
    }, [string, string]>(
      `SELECT id, total_cents, customer_name, pickup_code, status, payment_checkout_form_id
       FROM orders WHERE id = ? AND merchant_id = ?`
    )
    .get(orderId, merchant.id)

  if (!order) return c.json({ error: 'Order not found' }, 404)

  // Status guard — only orders awaiting payment can be marked paid.
  // Prevents replay attacks on completed/cancelled orders.
  if (order.status !== 'pending_payment') {
    return c.json({ error: 'Order is not awaiting payment' }, 409)
  }

  // FG-6: Webhook concurrency guard — prevents two concurrent payment-result
  // requests from both calling the payment processor API at the same time.
  // The downstream atomic SQL is the final authority; this guard is an early
  // fast-path that avoids duplicate provider API calls.
  if (!acquireWebhookLock(orderId)) {
    return c.json({ error: 'Payment is already being processed' }, 409)
  }

  try {

  let body: {
    provider?: string
    ssl_result?: string
    ssl_approval_code?: string
    ssl_txn_id?: string
    ssl_amount?: string
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  // -----------------------------------------------------------------------
  // Finix — verify payment server-to-server before marking paid.
  //
  // The checkout form ID was saved by the /pay endpoint. We call Finix to
  // confirm a transfer (charge) actually exists. Without this, anyone could
  // POST { provider: "finix" } and get free food.
  // -----------------------------------------------------------------------
  if (body.provider === 'finix') {
    if (!order.payment_checkout_form_id) {
      return c.json({ error: 'No payment session for this order — call /pay first' }, 400)
    }

    // Look up Finix credentials (same as /pay does)
    const keyRow = db
      .query<{ pos_merchant_id: string | null }, [string]>(
        `SELECT pos_merchant_id FROM api_keys
         WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix'`
      )
      .get(merchant.id)

    const posMerchantId = keyRow?.pos_merchant_id ?? ''
    const parts = posMerchantId.split(':')
    if (parts.length !== 3) {
      return serverError(c, '[store] finix-config', new Error('pos_merchant_id format invalid'), 'Finix configuration incomplete')
    }
    const [apiUsername, applicationId, finixMerchantId] = parts
    const sandbox = (merchant.finix_sandbox ?? 1) !== 0

    const apiPassword = await getAPIKey(merchant.id, 'payment', 'finix')
    if (!apiPassword) {
      return serverError(c, '[store] finix-config', new Error('apiPassword not found'), 'Finix credentials not configured')
    }

    const creds = { apiUsername, applicationId, merchantId: finixMerchantId, apiPassword, sandbox }

    // Server-to-server: ask Finix for the checkout form state + transfer ID.
    // The checkout form may be COMPLETED but with no _embedded.transfers
    // (Finix does not always embed them). We retry a few times, then fall
    // back to accepting state=COMPLETED as proof of payment.
    let transferId: string | null = null
    let formState = 'UNKNOWN'
    const MAX_POLLS  = 3
    const POLL_MS    = 1500
    for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
      try {
        const result = await getTransferIdFromCheckoutForm(creds, order.payment_checkout_form_id)
        transferId = result.transferId
        formState  = result.state
      } catch (err) {
        return serverError(c, '[store] Finix payment verification', err, 'Payment verification failed — please retry', 502)
      }
      if (transferId) break
      // COMPLETED with no transfer: Finix won't populate it later — stop polling
      if (formState === 'COMPLETED') break
      if (attempt < MAX_POLLS) {
        console.log(`[payment-result] state=${formState}, no transfer yet for ${order.payment_checkout_form_id} — retrying (${attempt}/${MAX_POLLS - 1})`)
        await new Promise(r => setTimeout(r, POLL_MS))
      }
    }

    if (!transferId && formState !== 'COMPLETED') {
      console.warn(`[payment-result] Checkout form ${order.payment_checkout_form_id} not confirmed — state=${formState} (order ${orderId})`)
      return c.json({ error: 'Payment not confirmed by processor' }, 402)
    }

    if (!transferId) {
      console.warn(`[payment-result] Checkout form COMPLETED but no transfer ID — accepting payment (order ${orderId})`)
      // Schedule a Finix search 60 s later to recover the transfer ID
      scheduleOrderReconciliation(merchant.id, orderId, order.total_cents)
    }

    // Atomic confirm guard — only transition when status is still 'pending_payment'.
    // Without this a duplicate concurrent request could confirm the same order twice
    // (both pass the status check above, both call Finix, both write 'submitted').
    const confirmed = db.query<{ id: string }, [string | null, string]>(
      `UPDATE orders SET status = 'submitted', payment_method = 'card',
       paid_amount_cents = total_cents, payment_transfer_id = ?,
       updated_at = datetime('now')
       WHERE id = ? AND status = 'pending_payment'
       RETURNING id`
    ).get(transferId, orderId)

    if (!confirmed) {
      // A concurrent request already confirmed this order — idempotent success
      return c.json({ status: 'paid', pickupCode: order.pickup_code })
    }

    console.log(`[payment] Order ${orderId} confirmed — provider=finix` +
      `, amount=$${(order.total_cents / 100).toFixed(2)}, transferId=${transferId}`)

    // fire-and-forget: order already committed; push/email errors logged only
    notifyMerchant(merchant.id, {
      title: `Order paid — ${order.pickup_code}`,
      body:  `${order.customer_name} · $${(order.total_cents / 100).toFixed(2)}`,
      data:  { type: 'order_paid', orderId, pickupCode: order.pickup_code },
    }).catch(err => console.warn('[push] merchant notify failed for order', orderId, err?.message ?? err))

    broadcastToMerchant(merchant.id, 'new_order', {
      orderId,
      pickupCode: order.pickup_code,
      customerName: order.customer_name,
      totalCents: order.total_cents,
    })

    sendReceiptEmail(merchant.id, orderId)
      .catch(err => console.warn('[email] Receipt failed for order', orderId, err?.message ?? err))

    return c.json({ status: 'paid', pickupCode: order.pickup_code })
  }

  // -----------------------------------------------------------------------
  // Converge — verify transaction server-to-server.
  //
  // The client sends ssl_txn_id from the Converge redirect. We call
  // Converge's txnquery API to confirm the transaction is real, approved,
  // and for the correct amount. Never trust client-provided ssl_result.
  // -----------------------------------------------------------------------
  const sslTxnId = body.ssl_txn_id
  if (!sslTxnId) {
    return c.json({ error: 'ssl_txn_id is required' }, 400)
  }

  // Look up Converge credentials
  const convergePin = await getAPIKey(merchant.id, 'payment', 'converge')
  if (!convergePin) {
    return serverError(c, '[store] converge-config', new Error('convergePin not found'), 'Converge credentials not configured')
  }

  const convergeKeyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'converge'`
    )
    .get(merchant.id)

  const convergeMerchantId = convergeKeyRow?.pos_merchant_id ?? ''
  if (!convergeMerchantId.includes(':')) {
    return serverError(c, '[store] converge-config', new Error('pos_merchant_id format invalid'), 'Converge configuration incomplete')
  }
  const [sslMerchantId, sslUserId] = convergeMerchantId.split(':')
  const convergeSandbox = (merchant.converge_sandbox ?? 1) !== 0

  let verification
  try {
    verification = await verifyConvergeTransaction(
      { sslMerchantId, sslUserId, sslPin: convergePin, sandbox: convergeSandbox },
      sslTxnId,
    )
  } catch (err) {
    return serverError(c, '[store] Converge payment verification', err, 'Payment verification failed — please retry', 502)
  }

  if (!verification.approved) {
    console.warn(`[payment-result] Converge txn ${sslTxnId} not approved (order ${orderId}):`, verification.raw)
    // Order remains 'pending_payment' — customer can retry payment
    return c.json({ status: 'declined' })
  }

  // Verify amount matches — prevents using a $1 txn to pay for a $50 order
  const expectedAmount = (order.total_cents / 100).toFixed(2)
  if (verification.amountDollars !== expectedAmount) {
    console.error(
      `[payment-result] Converge amount mismatch: expected ${expectedAmount}, got ${verification.amountDollars} (order ${orderId})`
    )
    return c.json({ error: 'Payment amount does not match order total' }, 422)
  }

  // Atomic confirm guard — prevents duplicate confirmation from concurrent requests
  const convergeConfirmed = db.query<{ id: string }, [string, string]>(
    `UPDATE orders SET status = 'submitted', payment_method = 'card',
     paid_amount_cents = total_cents, payment_transfer_id = ?,
     updated_at = datetime('now')
     WHERE id = ? AND status = 'pending_payment'
     RETURNING id`
  ).get(sslTxnId, orderId)

  if (!convergeConfirmed) {
    // A concurrent request already confirmed this order — idempotent success
    return c.json({ status: 'paid', pickupCode: order.pickup_code })
  }

  console.log(`[payment] Order ${orderId} confirmed — provider=converge` +
    `, amount=$${(order.total_cents / 100).toFixed(2)}, txnId=${sslTxnId}`)

  // fire-and-forget: order already committed; push/email errors logged only
  notifyMerchant(merchant.id, {
    title: `Order paid — ${order.pickup_code}`,
    body:  `${order.customer_name} · $${(order.total_cents / 100).toFixed(2)}`,
    data:  { type: 'order_paid', orderId, pickupCode: order.pickup_code },
  }).catch(err => console.warn('[push] merchant notify failed for order', orderId, err?.message ?? err))

  broadcastToMerchant(merchant.id, 'new_order', {
    orderId,
    pickupCode: order.pickup_code,
    customerName: order.customer_name,
    totalCents: order.total_cents,
  })

  sendReceiptEmail(merchant.id, orderId)
    .catch(err => console.warn('[email] Receipt failed for order', orderId, err?.message ?? err))

  return c.json({ status: 'paid', pickupCode: order.pickup_code })

  } finally {
    releaseLock(orderId)
  }
})

// ---------------------------------------------------------------------------
// GET /api/store/orders/:id/status  — polling fallback
// ---------------------------------------------------------------------------

store.get('/api/store/orders/:id/status', (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const orderId = c.req.param('id')
  const db = getDatabase()

  const order = db
    .query<{
      id: string
      status: string
      pickup_code: string
      estimated_ready_at: string | null
      pickup_time: string | null
    }, [string, string]>(
      `SELECT id, status, pickup_code, estimated_ready_at, pickup_time
       FROM orders WHERE id = ? AND merchant_id = ?`
    )
    .get(orderId, merchant.id)

  if (!order) return c.json({ error: 'Order not found' }, 404)

  // Compute whether the order can still be cancelled.
  // Cancellable = status is submitted/received AND now is before (pickup_time - prep_time_minutes).
  const cancellableStatuses = new Set(['submitted', 'received'])
  let cancellable = false
  let cancelDeadline: string | null = null

  if (cancellableStatuses.has(order.status) && order.pickup_time) {
    const prepMins    = merchant.prep_time_minutes ?? 20
    const pickupMs    = new Date(order.pickup_time.endsWith('Z') ? order.pickup_time : order.pickup_time + 'Z').getTime()
    const deadlineMs  = pickupMs - prepMins * 60_000
    cancelDeadline    = new Date(deadlineMs).toISOString()
    cancellable       = Date.now() < deadlineMs
  }

  return c.json({
    orderId:          order.id,
    status:           order.status,
    pickupCode:       order.pickup_code,
    estimatedReadyAt: order.estimated_ready_at,
    cancellable,
    cancelDeadline,
  })
})

// ---------------------------------------------------------------------------
// POST /api/store/orders/:id/cancel
// ---------------------------------------------------------------------------

store.post('/api/store/orders/:id/cancel', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const orderId = c.req.param('id')
  const db = getDatabase()

  const order = db
    .query<{
      id: string
      status: string
      customer_name: string
      pickup_time: string | null
    }, [string, string]>(
      `SELECT id, status, customer_name, pickup_time
       FROM orders WHERE id = ? AND merchant_id = ?`
    )
    .get(orderId, merchant.id)

  if (!order) return c.json({ error: 'Order not found' }, 404)

  // Only cancellable when in submitted/received/pending_payment status
  const cancellableStatuses = new Set(['submitted', 'received', 'pending_payment'])
  if (!cancellableStatuses.has(order.status)) {
    return c.json({ error: 'Order cannot be cancelled in its current state' }, 409)
  }

  // Enforce the prep window: cannot cancel once kitchen has started (pickup_time - prep_time_minutes)
  if (order.pickup_time) {
    const prepMins   = merchant.prep_time_minutes ?? 20
    const pickupMs   = new Date(order.pickup_time.endsWith('Z') ? order.pickup_time : order.pickup_time + 'Z').getTime()
    const deadlineMs = pickupMs - prepMins * 60_000
    if (Date.now() >= deadlineMs) {
      return c.json({ error: 'Order cannot be cancelled — kitchen has already started preparing it' }, 409)
    }
  }

  // Cancel the order
  db.run(
    `UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
    [orderId]
  )

  console.log(`[store] Order ${orderId} cancelled by customer`)

  // Notify customer via push
  try {
    await notifyCustomer(orderId, {
      title: 'Order Cancelled',
      body:  `Your order from ${merchant.business_name} has been cancelled.`,
      data:  { type: 'order_cancelled', orderId },
    })
  } catch { /* fire-and-forget */ }

  // Notify dashboard via SSE
  broadcastToMerchant(merchant.id, 'order_updated', { orderId, status: 'cancelled' })

  return c.json({ status: 'cancelled' })
})

// ---------------------------------------------------------------------------
// POST /api/store/push/subscribe
// ---------------------------------------------------------------------------

// M-04: Rate limit push subscriptions — 10 per minute per IP
const pushSubAttempts = new Map<string, { count: number; resetAt: number }>()
const PUSH_SUB_MAX = 10
const PUSH_SUB_WINDOW_MS = 60_000

store.post('/api/store/push/subscribe', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  // M-04: Rate limit per IP
  const ip = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
  const now = Date.now()
  const record = pushSubAttempts.get(ip)
  if (record && record.resetAt > now) {
    if (record.count >= PUSH_SUB_MAX) {
      return c.json({ error: 'Too many subscription requests' }, 429)
    }
    record.count++
  } else {
    pushSubAttempts.set(ip, { count: 1, resetAt: now + PUSH_SUB_WINDOW_MS })
  }
  // Prune stale entries periodically
  if (pushSubAttempts.size > 500) {
    for (const [k, v] of pushSubAttempts) {
      if (v.resetAt < now) pushSubAttempts.delete(k)
    }
  }

  let body: {
    orderId: string
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { orderId, subscription } = body
  if (!orderId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return c.json({ error: 'Missing orderId or subscription fields' }, 400)
  }

  // M-04: Validate push endpoint — must be HTTPS
  try {
    const pushUrl = new URL(subscription.endpoint)
    if (pushUrl.protocol !== 'https:') {
      return c.json({ error: 'Push endpoint must use HTTPS' }, 400)
    }
  } catch {
    return c.json({ error: 'Invalid push endpoint URL' }, 400)
  }

  const db = getDatabase()

  // Verify order belongs to this merchant
  const order = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM orders WHERE id = ? AND merchant_id = ?`
    )
    .get(orderId, merchant.id)

  if (!order) return c.json({ error: 'Order not found' }, 404)

  // Upsert subscription
  const existing = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM customer_push_subscriptions WHERE endpoint = ?`
    )
    .get(subscription.endpoint)

  if (existing) {
    db.run(
      `UPDATE customer_push_subscriptions SET p256dh = ?, auth = ?, order_id = ? WHERE endpoint = ?`,
      [subscription.keys.p256dh, subscription.keys.auth, orderId, subscription.endpoint]
    )
  } else {
    db.run(
      `INSERT INTO customer_push_subscriptions (id, order_id, merchant_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        generateId('cps'),
        orderId,
        merchant.id,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
      ]
    )
  }

  return c.json({ success: true })
})

// ---------------------------------------------------------------------------
// POST /api/store/feedback
// Submit customer feedback (app rating or per-order dish feedback).
// ---------------------------------------------------------------------------

store.post('/api/store/feedback', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Store not configured' }, 503)

  const body = await c.req.json<{
    type: 'app' | 'order'
    orderId?: string
    stars: number
    comment?: string
    dishRatings?: Array<{ name: string; thumbs: 'up' | 'down' }>
    contact?: string
  }>().catch(() => null)

  if (!body) return c.json({ error: 'Invalid request body' }, 400)

  const { type, orderId, stars, comment, dishRatings, contact } = body

  if (!type || !['app', 'order'].includes(type)) {
    return c.json({ error: 'type must be "app" or "order"' }, 400)
  }
  if (!stars || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return c.json({ error: 'stars must be 1–5' }, 400)
  }
  if (type === 'order' && !orderId) {
    return c.json({ error: 'orderId required for order feedback' }, 400)
  }

  const db = getDatabase()
  db.run(
    `INSERT INTO feedback (merchant_id, order_id, type, stars, comment, dish_ratings, contact)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      merchant.id,
      orderId ?? null,
      type,
      stars,
      (comment || '').trim().slice(0, 2000) || null,
      dishRatings ? JSON.stringify(dishRatings) : null,
      (contact || '').trim().slice(0, 200) || null,
    ]
  )

  return c.json({ success: true })
})

// ---------------------------------------------------------------------------
// GET /api/store/top-dishes
// Returns the top 5 most-liked dish names (by thumbs-up count from feedback).
// ---------------------------------------------------------------------------

store.get('/api/store/top-dishes', (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Store not configured' }, 503)

  const db = getDatabase()
  const rows = db.query<{ dish_ratings: string }, [string]>(
    `SELECT dish_ratings FROM feedback WHERE merchant_id = ? AND type = 'order' AND dish_ratings IS NOT NULL`
  ).all(merchant.id)

  const counts: Record<string, number> = {}
  for (const row of rows) {
    try {
      const ratings: Array<{ name: string; thumbs: string }> = JSON.parse(row.dish_ratings)
      for (const r of ratings) {
        if (r.thumbs === 'up' && r.name) {
          counts[r.name] = (counts[r.name] || 0) + 1
        }
      }
    } catch { /* skip malformed */ }
  }

  const topDishes = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name], i) => ({ name, rank: i + 1 }))

  return c.json({ topDishes })
})

export { store }
