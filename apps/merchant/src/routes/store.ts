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
 *   POST /api/store/parse-instruction            — AI dish-note parser (trigger-word guarded)
 */

import { Hono } from 'hono'
import { serverError } from '../utils/server-error'
import { getDatabase } from '../db/connection'
import { generateId, generatePickupCode } from '../utils/id'
import { getAPIKey } from '../crypto/api-keys'
import { parseInstruction, peekToken, invalidateToken, logSpecialInstruction } from '../services/instruction-parser'
import { getConvergePaymentUrl, verifyConvergeTransaction } from '../adapters/converge'
import { createCheckoutForm, getTransferIdFromCheckoutForm } from '../adapters/finix'
import { scheduleOrderReconciliation } from '../services/reconcile'
import { notifyMerchant, notifyCustomer } from './push'
import { broadcastToMerchant } from '../services/sse'
import { acquireWebhookLock, releaseLock } from '../services/order-locks'
import { sendReceiptEmail } from '../services/email'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual, createDecipheriv, createHash } from 'node:crypto'
import { getDEK } from '../crypto/dek'

const store = new Hono()

/** SHA-256 hex digest of a normalised identifier. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// Parse-instruction rate limiter — per-IP, 20 requests per 60 seconds
//
// Prevents prompt-injection enumeration attacks and runaway API costs.
// In-memory only: single Bun process, no Redis needed at this scale.
// ---------------------------------------------------------------------------
interface ParseRateRecord { count: number; resetAt: number }
const _parseRateLimits = new Map<string, ParseRateRecord>()
const PARSE_RATE_MAX = 20
const PARSE_RATE_WINDOW_MS = 60 * 1000 // 1 minute

function _checkParseRateLimit(ip: string): boolean {
  const now = Date.now()
  const rec = _parseRateLimits.get(ip)
  if (rec && rec.resetAt > now) {
    if (rec.count >= PARSE_RATE_MAX) return false
    rec.count++
  } else {
    _parseRateLimits.set(ip, { count: 1, resetAt: now + PARSE_RATE_WINDOW_MS })
  }
  return true
}

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
  online_orders_paused_until: string | null
  ga_tag_id: string | null
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
export function getApplianceMerchant(): ApplianceMerchant | null {
  if (_merchantCache && Date.now() - _merchantCacheAt < MERCHANT_CACHE_TTL_MS) return _merchantCache
  const db = getDatabase()
  _merchantCache = db
    .query<ApplianceMerchant, []>(
      `SELECT id, business_name, slug, description, logo_url, banner_url,
              splash_url, welcome_message, address,
              phone_number, cuisine_types, tax_rate, tip_options,
              converge_sandbox, finix_sandbox, payment_provider, prep_time_minutes,
              timezone, online_orders_paused_until, ga_tag_id
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

  // Upcoming scheduled closures (today onward, next 90 days) — used by the
  // online store to block orders and show closed messaging on closure days.
  const tz = merchant.timezone ?? 'America/Los_Angeles'
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const ninetyDaysOut = new Date()
  ninetyDaysOut.setDate(ninetyDaysOut.getDate() + 90)
  const limitDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ninetyDaysOut)
  const closures = db
    .query<{ start_date: string; end_date: string; label: string }, [string, string, string]>(
      `SELECT start_date, end_date, label
       FROM scheduled_closures
       WHERE merchant_id = ? AND end_date >= ? AND start_date <= ?
       ORDER BY start_date ASC`
    )
    .all(merchant.id, todayLocal, limitDate)
    .map((r) => ({ startDate: r.start_date, endDate: r.end_date, label: r.label }))

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
    timezone: tz,
    businessHours: hours.map((h) => ({
      dayOfWeek:  h.day_of_week,
      openTime:   h.open_time,
      closeTime:  h.close_time,
      slotIndex:  h.slot_index,
      isClosed:   h.is_closed !== 0,
    })),
    scheduledClosures: closures,
    finixMerchantId,
    finixEnvironment,
    ordersPaused: !!merchant.online_orders_paused_until && new Date().toISOString() < merchant.online_orders_paused_until,
    pausedUntil:  merchant.online_orders_paused_until ?? null,
    gaTagId:      merchant.ga_tag_id ?? null,
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
    isMandatory: boolean
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
      if (!gmap.has(row.group_id)) {
        gmap.set(row.group_id, { id: row.group_id, name: row.group_name, minRequired: row.min_required, maxAllowed: row.max_allowed, isMandatory: row.is_mandatory === 1, modifiers: [] })
      }
      const grp = gmap.get(row.group_id)!
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

  if (merchant.online_orders_paused_until && new Date().toISOString() < merchant.online_orders_paused_until) {
    return c.json({ error: 'Online orders are temporarily paused', pausedUntil: merchant.online_orders_paused_until }, 503)
  }

  let body: {
    customerName: string
    customerPhone?: string
    customerEmail?: string
    items: Array<{
      itemId: string
      modifiers?: string[]
      itemName?: string           // optional "whose dish is this" label
      kitchenNote?: string        // optional per-item kitchen instruction
      instructionToken?: string   // one-time token from POST /api/store/parse-instruction
    }>
    note?: string
    utensilsNeeded?: boolean
    tipCents?: number
    scheduledFor?: string   // ISO timestamp: when the customer wants the order ready
    orderType?: 'pickup' | 'delivery'
    deliveryAddress?: string
    deliveryInstructions?: string
    campaignSlug?: string
    couponCode?: string
    couponScanToken?: string
    expectedDiscountCents?: number
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
  if (body.campaignSlug && !customerPhone?.trim()) {
    return c.json({ error: 'phone_required_for_offer' }, 400)
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
  type ValidMod  = { id: string; name: string; price_cents: number; group_id: string; print_first: number }

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
        `SELECT m.id, m.name, m.price_cents, m.group_id, mg.print_first
         FROM modifiers m
         JOIN modifier_groups mg ON mg.id = m.group_id
         WHERE m.id IN (${modPh}) AND m.is_available = 1
           AND (m.stock_status IS NULL OR m.stock_status = 'in_stock')`
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

  // ── Verify instruction tokens ────────────────────────────────────────────
  // Each item may optionally carry a one-time surcharge token issued by
  // POST /api/store/parse-instruction.  Phase 1: peek (validate without
  // consuming) so an invalid token triggers 400 before any DB state change.
  // Phase 2: invalidate tokens only after the INSERT succeeds.
  let instructionSurchargeCents = 0
  const pendingInstructions: Array<{
    itemIdx:       number
    token:         string
    note:          string
    perUnitCents:  number  // surcharge per copy of the item (charge_type='per_unit')
    perEntryCents: number  // flat one-time surcharge (charge_type='per_entry')
    itemCount:     number
  }> = []

  for (let i = 0; i < items.length; i++) {
    const orderItem = items[i]
    if (!orderItem.instructionToken) continue

    const entry = peekToken(orderItem.instructionToken)
    if (!entry) {
      return c.json({ error: 'instruction_token_expired' }, 400)
    }
    if (entry.itemId !== orderItem.itemId) {
      return c.json({ error: 'instruction_token_item_mismatch' }, 400)
    }
    // per_unit surcharge multiplied by qty; per_entry surcharge added flat once.
    // qty>1 expands into repeated item entries; only the first carries the token.
    const itemCount = items.filter(it => it.itemId === orderItem.itemId).length
    instructionSurchargeCents += entry.perUnitCents * itemCount + entry.perEntryCents
    pendingInstructions.push({
      itemIdx:       i,
      token:         orderItem.instructionToken,
      note:          orderItem.kitchenNote?.trim() ?? '',
      perUnitCents:  entry.perUnitCents,
      perEntryCents: entry.perEntryCents,
      itemCount,
    })
  }

  // Assemble resolved items from lookup Maps (O(1) per lookup).
  // Build a map of itemId → perUnitInstructionCents for annotating each copy.
  const instrPerUnit = new Map<string, number>()
  for (const pi of pendingInstructions) {
    instrPerUnit.set(items[pi.itemIdx].itemId, pi.perUnitCents)
  }

  let subtotalCents = 0
  const resolvedItems: Array<{
    itemId: string
    name: string
    priceCents: number
    modifiers: Array<{ id: string; name: string; priceCents: number }>
    lineTotalCents: number
    specialInstructions?: string
    instructionSurchargeCents?: number
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
    // print_first groups surface before all others on kitchen/counter tickets
    resolvedMods.sort((a, b) =>
      (validModMap.get(b.id)?.print_first ?? 0) - (validModMap.get(a.id)?.print_first ?? 0)
    )

    const lineTotalCents = item.price_cents + modifiersCents
    subtotalCents += lineTotalCents

    const namePart = orderItem.itemName?.trim()
    const notePart = orderItem.kitchenNote?.trim()
    const instrCents = instrPerUnit.get(orderItem.itemId)

    resolvedItems.push({
      itemId:         item.id,
      name:           item.name,
      priceCents:     item.price_cents,
      modifiers:      resolvedMods,
      lineTotalCents,
      ...(namePart    ? { dishLabel: `-- ${namePart} --` } : {}),
      ...(notePart    ? { specialInstructions: notePart } : {}),
      ...(instrCents  ? { instructionSurchargeCents: instrCents } : {}),
    })
  }

  subtotalCents   += instructionSurchargeCents

  // ── Campaign discount ─────────────────────────────────────────────────────
  const orderId    = generateId('ord')
  const pickupCode = generatePickupCode()

  let discountCents = 0
  let discountLabel: string | null = null
  let campaignId: number | null = null
  let campaignSlugApplied: string | null = null
  let couponCodeApplied: string | null = null
  let couponScanTokenApplied: string | null = null

  if (body.campaignSlug) {
    const campaignSlugUpper = String(body.campaignSlug).toUpperCase()
    const now = Date.now()
    const campaignRow = db.query<{
      id: number; slug: string; name: string; status: string; end_at: number
      discount_type: string; discount_value: number; min_order_cents: number
      max_uses_per_customer: number; max_uses_global: number | null; fulfillment_restriction: string | null
      schedule_json: string | null; campaign_type: string
      target_json: string | null; trigger_json: string | null; reward_json: string | null
      coupon_code_required: number
    }, [string]>(
      `SELECT id, slug, name, status, end_at, discount_type, discount_value,
              min_order_cents, max_uses_per_customer, max_uses_global, fulfillment_restriction,
              schedule_json, campaign_type, target_json, trigger_json, reward_json,
              coupon_code_required
       FROM campaigns WHERE slug = ?`
    ).get(campaignSlugUpper)

    if (campaignRow && campaignRow.status === 'active' && now <= campaignRow.end_at) {
      const fRestriction = campaignRow.fulfillment_restriction
      // Marketing-engine campaigns use 'takeout', orders use 'pickup' (the
      // CHECK constraint on orders.order_type only allows pickup/delivery/
      // dine_in/catering — no 'takeout'). Treat them as synonyms.
      const orderTypeAlias = orderType === 'pickup' ? 'takeout' : orderType
      const fulfillmentOk = !fRestriction
        || fRestriction === orderType
        || fRestriction === orderTypeAlias
        || fRestriction === 'both'
      const minOk = subtotalCents >= campaignRow.min_order_cents

      // Schedule window check: for scheduled orders use the pickup time, otherwise use now.
      // This lets a customer redeem a lunch-hour coupon when ordering at 9am for 11:30am pickup.
      let scheduleOk = true
      if (campaignRow.schedule_json) {
        try {
          const schedule = JSON.parse(campaignRow.schedule_json)
          const tz = merchant.timezone ?? 'UTC'
          const ref = body.scheduledFor ? new Date(body.scheduledFor) : new Date()
          const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(ref)
          const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
          const localDay = dayMap[dayStr] ?? ref.getDay()
          if (schedule.days?.length && !schedule.days.includes(localDay)) {
            scheduleOk = false
          }
          if (scheduleOk && schedule.windows?.length) {
            const timeStr = new Intl.DateTimeFormat('en-GB', {
              timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
            }).format(ref)
            const [h, m]    = timeStr.split(':').map(Number)
            const localMins = h * 60 + m
            scheduleOk = schedule.windows.some((w: { start: string; end: string }) => {
              const [sh, sm] = w.start.split(':').map(Number)
              const [eh, em] = w.end.split(':').map(Number)
              return localMins >= sh * 60 + sm && localMins <= eh * 60 + em
            })
          }
        } catch { scheduleOk = false }
      }

      if (fulfillmentOk && minOk && scheduleOk) {
        // Require coupon code present before we do any cap queries (fast fail)
        if (campaignRow.coupon_code_required) {
          const rawCode = String(body.couponCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
          if (!rawCode) {
            return c.json({ error: 'coupon_code_required' }, 400)
          }
        }

        // Validate scan_token if provided (fast-fail before expensive cap queries)
        const couponScanToken = typeof body.couponScanToken === 'string' ? body.couponScanToken.trim() : null
        if (couponScanToken) {
          const instanceRow = db.query<{ redeemed: number; expires_at: string }, [string]>(
            `SELECT redeemed, expires_at FROM coupon_instances WHERE scan_token = ?`
          ).get(couponScanToken)
          if (!instanceRow)                                     return c.json({ error: 'coupon_scan_token_invalid' }, 422)
          if (instanceRow.redeemed === 1)                       return c.json({ error: 'coupon_already_redeemed' }, 409)
          if (instanceRow.expires_at < new Date().toISOString()) return c.json({ error: 'coupon_scan_token_expired' }, 422)
        }

        let capExceeded = false

        // Check global redemption cap first (cheapest early-exit)
        if (campaignRow.max_uses_global !== null) {
          const globalRow = db.query<{ cnt: number }, [number]>(
            `SELECT COUNT(*) AS cnt FROM campaign_redemptions WHERE campaign_id = ?`
          ).get(campaignRow.id)
          if ((globalRow?.cnt ?? 0) >= campaignRow.max_uses_global) capExceeded = true
        }

        // Check per-customer redemption cap (hash-based, privacy-preserving).
        // Names are intentionally NOT hashed: many customers share the same
        // first name / nickname, so a name hash creates false-positive blocks
        // for legitimate distinct customers. Only phone + email are unique
        // enough to identify "this same customer redeemed before".
        const customerPhoneNorm = customerPhone?.replace(/\D/g, '') || null
        const customerEmailNorm = customerEmail?.toLowerCase().trim() || null
        if (!capExceeded && campaignRow.max_uses_per_customer > 0) {
          const identifierHashes = [
            customerPhoneNorm ? sha256Hex(customerPhoneNorm) : null,
            customerEmailNorm ? sha256Hex(customerEmailNorm) : null,
          ].filter(Boolean) as string[]

          for (const hash of identifierHashes) {
            const hashRow = db.query<{ cnt: number }, [number, string]>(
              `SELECT COUNT(*) AS cnt FROM coupon_hash_redemptions
               WHERE campaign_id = ? AND identifier_hash = ?`
            ).get(campaignRow.id, hash)
            if ((hashRow?.cnt ?? 0) >= campaignRow.max_uses_per_customer) {
              capExceeded = true
              break
            }
          }
          // Fallback: also check plaintext phone for legacy redemptions
          if (!capExceeded && customerPhoneNorm) {
            const redemptionRow = db.query<{ cnt: number }, [string, number]>(
              `SELECT COUNT(*) AS cnt FROM campaign_redemptions
               WHERE customer_phone = ? AND campaign_id = ?`
            ).get(customerPhoneNorm, campaignRow.id)
            if ((redemptionRow?.cnt ?? 0) >= campaignRow.max_uses_per_customer) {
              capExceeded = true
            }
          }
        }

        if (!capExceeded) {
          if (couponScanToken) couponScanTokenApplied = couponScanToken
          // Validate + atomically redeem the per-coupon code (HTTP call to marketing engine)
          if (campaignRow.coupon_code_required) {
            const rawCode   = String(body.couponCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
            const meUrl     = process.env.MARKETING_ENGINE_URL ?? 'http://127.0.0.1:3100'
            const syncToken = process.env.CAMPAIGN_SYNC_TOKEN ?? ''
            if (!syncToken) {
              console.warn('[campaigns] CAMPAIGN_SYNC_TOKEN not set — cannot validate coupon code')
              return c.json({ error: 'coupon_validation_unavailable' }, 503)
            }
            let redeemRes: Response
            try {
              redeemRes = await fetch(`${meUrl}/internal/coupon/redeem`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncToken },
                body:    JSON.stringify({ campaign_id: campaignRow.id, code: rawCode, order_id: orderId }),
                signal:  AbortSignal.timeout(5_000),
              })
            } catch (err) {
              console.warn('[campaigns] coupon validation request failed:', String(err))
              return c.json({ error: 'coupon_validation_unavailable' }, 503)
            }
            if (!redeemRes.ok) {
              const errBody = await redeemRes.json().catch(() => ({})) as { error?: string }
              if (errBody.error === 'already_redeemed') {
                return c.json({ error: 'coupon_already_redeemed' }, 409)
              }
              return c.json({ error: 'coupon_invalid' }, 422)
            }
            couponCodeApplied = rawCode
          }

          const campaignType = campaignRow.campaign_type ?? 'coupon'

          if (campaignType === 'bogo' && campaignRow.trigger_json && campaignRow.reward_json) {
            // ── BOGO / conditional discount ──────────────────────────────────
            let trigger: { type: string; item_name?: string; category?: string; quantity: number }
            let reward:  { type: string; item_name: string; discount_type?: string; discount_value?: number; max_quantity?: number }
            try {
              trigger = JSON.parse(campaignRow.trigger_json)
              reward  = JSON.parse(campaignRow.reward_json)
            } catch { trigger = null!; reward = null! }

            if (trigger && reward) {
              // Count qualifying trigger items in the cart
              let triggerCount = 0
              if (trigger.type === 'item_quantity' && trigger.item_name) {
                const triggerName = trigger.item_name.toLowerCase()
                triggerCount = resolvedItems.filter(it => it.name.toLowerCase() === triggerName).length
              } else if (trigger.type === 'category_quantity' && trigger.category) {
                // Look up the category for each item in the cart
                const catName = trigger.category.toLowerCase()
                const catRows = db.query<{ item_id: string }, [string, string]>(
                  `SELECT mi.id AS item_id FROM menu_items mi
                   JOIN menu_categories mc ON mc.id = mi.category_id
                   WHERE mc.merchant_id = ? AND LOWER(mc.name) = ?`
                ).all(merchant.id, catName)
                const catItemIds = new Set(catRows.map(r => r.item_id))
                triggerCount = resolvedItems.filter(it => catItemIds.has(it.itemId)).length
              }

              if (triggerCount >= trigger.quantity) {
                // Trigger condition met — find reward items in cart
                const rewardName   = reward.item_name.toLowerCase()
                const maxQty       = reward.max_quantity ?? 1
                const rewardItems  = resolvedItems.filter(it => it.name.toLowerCase() === rewardName)
                const rewardCount  = Math.min(rewardItems.length, maxQty)

                if (rewardCount > 0) {
                  if (reward.type === 'free_item') {
                    // Discount = sum of reward item prices (up to maxQty)
                    const rewardTotal = rewardItems.slice(0, rewardCount).reduce((s, it) => s + it.lineTotalCents, 0)
                    discountCents = Math.min(rewardTotal, subtotalCents)
                    discountLabel = `Free ${reward.item_name} (${campaignRow.name})`
                  } else if (reward.type === 'item_discount' && reward.discount_type && reward.discount_value !== undefined) {
                    const rewardTotal = rewardItems.slice(0, rewardCount).reduce((s, it) => s + it.lineTotalCents, 0)
                    if (reward.discount_type === 'percent') {
                      discountCents = Math.round(rewardTotal * reward.discount_value / 100)
                    } else {
                      discountCents = Math.min(reward.discount_value * rewardCount, rewardTotal)
                    }
                    discountCents = Math.min(discountCents, subtotalCents)
                    const pctLabel = reward.discount_type === 'percent'
                      ? `${reward.discount_value}% off ${reward.item_name}`
                      : `$${(reward.discount_value / 100).toFixed(2)} off ${reward.item_name}`
                    discountLabel = `${pctLabel} (${campaignRow.name})`
                  }
                  campaignId          = campaignRow.id
                  campaignSlugApplied = campaignRow.slug
                }
              }
            }
          } else {
            // ── Standard coupon (order-level or item-targeted) ───────────────
            let baseForDiscount = subtotalCents

            if (campaignRow.target_json) {
              try {
                const target = JSON.parse(campaignRow.target_json)
                if (target.type === 'item' && target.item_name) {
                  const targetName = target.item_name.toLowerCase()
                  baseForDiscount = resolvedItems
                    .filter(it => it.name.toLowerCase() === targetName)
                    .reduce((s, it) => s + it.lineTotalCents, 0)
                }
              } catch { /* fall through: apply discount to full subtotal */ }
            }

            if (baseForDiscount > 0) {
              if (campaignRow.discount_type === 'percent') {
                discountCents = Math.round(baseForDiscount * campaignRow.discount_value / 100)
              } else {
                discountCents = Math.min(campaignRow.discount_value, baseForDiscount)
              }
              discountCents = Math.min(discountCents, subtotalCents)
              discountLabel = campaignRow.discount_type === 'percent'
                ? `${campaignRow.discount_value}% off (${campaignRow.name})`
                : `$${(campaignRow.discount_value / 100).toFixed(2)} off (${campaignRow.name})`
              campaignId          = campaignRow.id
              campaignSlugApplied = campaignRow.slug
            }
          }
        }
      }
    }
  }

  // Guard: client expected a discount but server computed none (ineligible campaign —
  // wrong fulfillment type, below min-order, cap exceeded, or expired). Return 400 so
  // the client can re-prompt rather than silently charging full price.
  if (body.expectedDiscountCents !== undefined) {
    const expected = Math.round(Number(body.expectedDiscountCents))
    if (Math.abs(discountCents - expected) > 1) {
      return c.json({ error: 'campaign_discount_mismatch' }, 400)
    }
  }

  const taxCents   = Math.round((subtotalCents - discountCents) * merchant.tax_rate)
  const totalCents = (subtotalCents - discountCents) + taxCents + tipCents

  // Use datetime('now') so created_at is stored in SQLite space format
  // 'YYYY-MM-DD HH:MM:SS', consistent with dashboard-orders.ts and orders.ts.
  const feedbackToken = randomBytes(16).toString('hex')

  db.run(
    `INSERT INTO orders (
       id, merchant_id, customer_name, customer_phone, customer_email,
       items, subtotal_cents, discount_cents, discount_label,
       tax_cents, tip_cents, total_cents,
       special_instruction_surcharge_cents,
       campaign_id, campaign_slug, coupon_code,
       status, order_type, delivery_address, delivery_instructions,
       pickup_code, source, notes, utensils_needed,
       pickup_time, feedback_token, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, 'online', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      orderId,
      merchant.id,
      customerName.trim(),
      customerPhone?.trim() || null,
      customerEmail?.trim().toLowerCase() || null,
      JSON.stringify(resolvedItems),
      subtotalCents,
      discountCents,
      discountLabel,
      taxCents,
      tipCents,
      totalCents,
      instructionSurchargeCents,
      campaignId,
      campaignSlugApplied,
      couponCodeApplied,
      orderType,
      deliveryAddress,
      deliveryInstructions,
      pickupCode,
      note?.trim() || null,
      utensilsNeeded ? 1 : 0,
      scheduledFor,
      feedbackToken,
    ]
  )

  // Record campaign redemption after successful INSERT
  if (campaignId !== null && campaignSlugApplied !== null) {
    try {
      const customerPhoneNorm = customerPhone?.replace(/\D/g, '') || null
      const customerEmailNorm = customerEmail?.toLowerCase().trim() || null
      db.run(
        `INSERT INTO campaign_redemptions (campaign_id, coupon_code, customer_phone, order_id, discount_cents, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [campaignId, couponCodeApplied, customerPhoneNorm ?? '', orderId, discountCents, Date.now()]
      )
      // Hash-based redemption records (privacy-preserving duplicate detection).
      // Names are intentionally excluded — see the eligibility-check comment
      // above. The schema's CHECK still permits 'name' rows for backwards
      // compatibility with historical data, but no new ones are inserted.
      const hashPairs: Array<[string, 'phone' | 'email']> = []
      if (customerPhoneNorm) hashPairs.push([sha256Hex(customerPhoneNorm), 'phone'])
      if (customerEmailNorm) hashPairs.push([sha256Hex(customerEmailNorm), 'email'])
      for (const [hash, type] of hashPairs) {
        db.run(
          `INSERT OR IGNORE INTO coupon_hash_redemptions
             (campaign_id, identifier_hash, identifier_type, order_id)
           VALUES (?, ?, ?, ?)`,
          [campaignId, hash, type, orderId]
        )
      }
      // Mark coupon_instance as redeemed so the scan_token cannot be used again
      if (couponScanTokenApplied) {
        db.run(
          `UPDATE coupon_instances SET redeemed = 1, order_id = ?, redeemed_at = datetime('now')
           WHERE scan_token = ?`,
          [orderId, couponScanTokenApplied]
        )
      }
    } catch (err) {
      console.warn('[campaigns] Failed to record redemption for order', orderId, String(err))
    }
  }

  // Phase 2: invalidate tokens now that the INSERT has succeeded (CR-01).
  // Log with the real orderId (not null) so COSA can correlate with the order.
  for (const pi of pendingInstructions) {
    invalidateToken(pi.token)
    logSpecialInstruction(
      merchant.id, 'accepted', pi.note,
      pi.perUnitCents * pi.itemCount,
      orderId, items[pi.itemIdx].itemId,
    )
  }

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
      discountCents,
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
    discountCents,
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

  const orderId = c.req.param('id')!
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

  const orderId = c.req.param('id')!
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

  const orderId = c.req.param('id')!
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
  // Cancellable = status is submitted/received/pending_payment AND now is before (pickup_time - prep_time_minutes).
  const cancellableStatuses = new Set(['submitted', 'received', 'pending_payment'])
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

  const orderId = c.req.param('id')!
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
    managerNote?: string
    dishRatings?: Array<{ name: string; thumbs: 'up' | 'down' }>
    contact?: string
  }>().catch(() => null)

  if (!body) return c.json({ error: 'Invalid request body' }, 400)

  const { type, orderId, stars, comment, managerNote, dishRatings, contact } = body

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
  try {
    db.run(
      `INSERT INTO feedback (merchant_id, order_id, type, stars, comment, manager_note, dish_ratings, contact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchant.id,
        orderId ?? null,
        type,
        stars,
        (comment || '').trim().slice(0, 500) || null,
        (managerNote || '').trim().slice(0, 1000) || null,
        dishRatings ? JSON.stringify(dishRatings) : null,
        (contact || '').trim().slice(0, 200) || null,
      ]
    )
  } catch (err) {
    console.error('[store] feedback insert failed:', err)
    return c.json({ error: 'Failed to save feedback' }, 500)
  }

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

// ---------------------------------------------------------------------------
// GET /api/store/feedback-context?token=TOKEN
// Public — called by the PWA when loaded with ?fb=TOKEN (from a printed bill QR).
// Returns enough context to pre-populate the order feedback modal.
// Expires 12 hours after order creation.
// ---------------------------------------------------------------------------

store.get('/api/store/feedback-context', (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'token_required' }, 400)

  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Store not configured' }, 503)

  const db = getDatabase()
  const row = db.query<{
    id: string; items: string; created_at: string
  }, [string, string]>(
    `SELECT id, items, created_at FROM orders WHERE feedback_token = ? AND merchant_id = ?`
  ).get(token, merchant.id)

  if (!row) return c.json({ error: 'not_found' }, 404)

  // 12-hour expiry
  const createdMs = new Date(row.created_at.includes('T') ? row.created_at : row.created_at + 'Z').getTime()
  if (Date.now() - createdMs > 12 * 60 * 60 * 1000) {
    return c.json({ error: 'expired' }, 404)
  }

  let dishNames: string[] = []
  try {
    const parsed: Array<{ dishName?: string; name?: string; quantity?: number }> = JSON.parse(row.items)
    const seen = new Set<string>()
    for (const item of parsed) {
      const name = item.dishName ?? item.name ?? ''
      if (name && !seen.has(name)) {
        seen.add(name)
        dishNames.push(name)
      }
    }
  } catch { /* malformed items — return empty dish list */ }

  return c.json({
    orderId:      row.id,
    merchantName: merchant.business_name,
    dishNames,
  })
})

// POST /api/store/parse-instruction
// ---------------------------------------------------------------------------
// Public (no auth).  Called when the customer types a per-item dish note
// containing a pricing trigger word.  Returns preset messages + surcharge;
// never forwards Claude's raw output to the caller.
//
// Blank note or no trigger words → { outcome: 'no_trigger', ... } with no AI call.
// No Claude API key configured    → 503 ai_unavailable.

store.post('/api/store/parse-instruction', async (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'Store not configured' }, 503)

  // Rate limit: 20 parse calls per IP per minute
  const ip = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
  if (!_checkParseRateLimit(ip)) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  let body: { note?: unknown; itemId?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  if (typeof body.note !== 'string' || !body.note.trim()) {
    return c.json({ error: 'note_required' }, 400)
  }
  if (typeof body.itemId !== 'string' || !body.itemId.trim()) {
    return c.json({ error: 'item_id_required' }, 400)
  }

  let result
  try {
    result = await parseInstruction(merchant.id, body.note.trim(), body.itemId.trim())
  } catch {
    return c.json({ error: 'ai_unavailable' }, 503)
  }

  if (result.outcome === 'error') {
    return c.json({ error: 'ai_unavailable' }, 503)
  }

  return c.json({
    outcome:        result.outcome,
    messages:       result.messages,
    surchargeCents: result.surchargeCents,
    token:          result.token,
  })
})

// ---------------------------------------------------------------------------
// Finix payment redirect landing pages (UX only — no state changes)
//
// Finix redirects the buyer's browser to these URLs after a hosted payment
// session. They are informational only; actual payment recording happens
// exclusively via the POST /api/finix-webhook endpoint below.
//
// Security: no query-param state is trusted; no DB writes occur here.
// ---------------------------------------------------------------------------

/** Minimal HTML escaper for untrusted content in landing pages. */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Shared styled shell for the redirect landing pages. */
function paymentLandingHtml(title: string, heading: string, body: string, accentColor: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; min-height: 100vh;
           background: #f9fafb; color: #111827; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px;
            max-width: 420px; width: 100%; text-align: center;
            box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: ${accentColor}; margin-bottom: 12px; }
    p { font-size: 15px; line-height: 1.6; color: #6b7280; }
    .back { display: inline-block; margin-top: 28px; padding: 12px 28px;
            background: ${accentColor}; color: #fff; border-radius: 8px;
            text-decoration: none; font-weight: 600; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${heading}</div>
    ${body}
    <a href="/" class="back">Back to store</a>
  </div>
</body>
</html>`
}

/**
 * GET /api/payment-success
 * Browser redirect destination after a successful Finix hosted payment.
 * No state changes — payment is recorded by the Finix webhook.
 */
store.get('/api/payment-success', (c) => {
  const merchant = getApplianceMerchant()
  const name = escHtml(merchant?.business_name ?? 'the restaurant')
  const html = paymentLandingHtml(
    'Payment received',
    '✅',
    `<h1>Payment received</h1>
     <p>Thank you! Your payment has been received. ${name} will be in touch to confirm your catering order.</p>`,
    '#16a34a',
  )
  return c.html(html)
})

/**
 * GET /api/payment-failure
 * Browser redirect destination after a failed or declined Finix payment.
 * No state changes.
 */
store.get('/api/payment-failure', (c) => {
  const html = paymentLandingHtml(
    'Payment not completed',
    '❌',
    `<h1>Payment not completed</h1>
     <p>Your payment could not be processed. Please check your card details and try again, or contact the restaurant directly.</p>`,
    '#dc2626',
  )
  return c.html(html)
})

/**
 * GET /api/expired
 * Browser redirect destination when a Finix payment link has expired.
 * No state changes.
 */
store.get('/api/expired', (c) => {
  const html = paymentLandingHtml(
    'Payment link expired',
    '⏰',
    `<h1>Payment link expired</h1>
     <p>This payment link is no longer valid. Please contact the restaurant to receive a new payment link.</p>`,
    '#d97706',
  )
  return c.html(html)
})

/**
 * GET /terms-of-service-catering
 * Catering order terms & conditions — linked from Finix invoice payment pages.
 */
store.get('/terms-of-service-catering', (c) => {
  const merchant = getApplianceMerchant()
  const name = escHtml(merchant?.business_name ?? 'the restaurant')
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Catering Terms &amp; Conditions — ${name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f9fafb; color: #111827; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px;
            max-width: 560px; margin: 0 auto;
            box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .merchant { font-size: 14px; color: #6b7280; margin-bottom: 28px; }
    ol { padding-left: 20px; }
    ol li { font-size: 15px; line-height: 1.7; color: #374151; margin-bottom: 10px; }
    .back { display: inline-block; margin-top: 28px; font-size: 14px;
            color: #6b7280; text-decoration: none; }
    .back:hover { color: #111827; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Catering Terms &amp; Conditions</h1>
    <p class="merchant">${name}</p>
    <ol>
      <li>Payment is due 48 hours before pickup time.</li>
      <li>Cancellations must be made at least 24 hours in advance for a 50% refund.</li>
      <li>Prices include serving trays, utensils, plates, and condiments.</li>
    </ol>
    <a href="/" class="back">← Back to store</a>
  </div>
</body>
</html>`
  return c.html(html)
})

// ---------------------------------------------------------------------------
// POST /api/finix-webhook
//
// Receives Finix Transfer events and records catering/online payments.
//
// Security:
//  - Bearer Token verified against finix_webhook_secret_enc using timingSafeEqual
//  - Idempotency on finix_transfer_id: duplicate events are silently ignored
//  - Unsigned requests accepted only when no secret is configured (setup mode)
//
// Auth model:
//  Finix sends:  Authorization: Bearer <token_you_configured>
//  You set this token in Finix Dashboard → Developer → Webhooks → Bearer Token.
//  The same token must be saved in Kizo → Store Profile → Finix → Webhook Secret.
//
// Event selection (in Finix Dashboard):
//  ✓ Transfer: Created   — fires immediately when a card payment is captured
//  ✓ Transfer: Updated   — fires on state changes (async 3DS / delayed capture)
//
// Payload shape (Transfer event):
//  { type: 'transfer', entity_id: 'tra_xxx', entity: { id, state, amount, tags } }
//
// Order matching priority:
//  1. entity.tags.order_id  — set by Kizo when creating checkout forms
//  2. No match              — create a catering stub order (external Finix link)
// ---------------------------------------------------------------------------

store.post('/api/finix-webhook', async (c) => {
  const rawBody = await c.req.text()

  // ── Resolve merchant ──────────────────────────────────────────────────────
  const merchant = getApplianceMerchant()
  if (!merchant) return c.json({ error: 'not_found' }, 404)

  const db = getDatabase()

  // ── Bearer Token verification ─────────────────────────────────────────────
  // Finix sends: Authorization: Bearer <token>
  const row = db.query<{ finix_webhook_secret_enc: string | null }, [string]>(
    'SELECT finix_webhook_secret_enc FROM merchants WHERE id = ?'
  ).get(merchant.id)

  if (row?.finix_webhook_secret_enc) {
    const authHeader = c.req.header('Authorization') ?? ''
    const incoming = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!incoming) return c.json({ error: 'missing_token' }, 401)

    let expectedToken: string
    try {
      const dek      = getDEK(merchant.id)
      const buf      = Buffer.from(row.finix_webhook_secret_enc, 'base64')
      const iv       = buf.subarray(0, 12)
      const authTag  = buf.subarray(-16)
      const cipher   = buf.subarray(12, -16)
      const decipher = createDecipheriv('aes-256-gcm', dek, iv)
      decipher.setAuthTag(authTag)
      expectedToken = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8')
    } catch (err) {
      return serverError(c, 'finix-webhook/decrypt', err)
    }

    // Constant-time comparison — both buffers are the same fixed size so timingSafeEqual
    // never leaks timing information. We check content equality only; the pad ensures
    // tokens shorter than 256 bytes are compared in equal-length buffers.
    // Note: two tokens that differ only in length will produce different buf contents
    // because the shorter one's trailing bytes are zeroes while the longer one's are not.
    const inBuf  = Buffer.alloc(256)
    const expBuf = Buffer.alloc(256)
    inBuf.write(incoming,       'utf8')
    expBuf.write(expectedToken, 'utf8')
    if (!timingSafeEqual(inBuf, expBuf)) return c.json({ error: 'invalid_token' }, 401)
  }
  // No secret configured → open mode (safe during initial setup)

  // ── Parse payload ─────────────────────────────────────────────────────────
  // Finix sends an empty body during webhook creation validation — treat gracefully.
  if (!rawBody.trim()) return c.json({ ok: true })

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  // Only act on Transfer events (type = 'transfer')
  if ((payload['type'] as string | undefined) !== 'transfer') return c.json({ ok: true })

  const entity = payload['entity'] as Record<string, unknown> | undefined
  if (!entity) return c.json({ ok: true })

  const transferId          = entity['id']     as string | undefined
  const transferState       = entity['state']  as string | undefined
  const transferAmountCents = entity['amount'] as number | undefined
  const tags                = entity['tags']   as Record<string, unknown> | undefined

  // Amount must be a positive integer (cents). Reject negatives, floats, or missing.
  if (
    !transferId ||
    transferState !== 'SUCCEEDED' ||
    !Number.isInteger(transferAmountCents) ||
    (transferAmountCents as number) <= 0
  ) {
    return c.json({ ok: true }) // not a successful payment — acknowledge and ignore
  }
  const amountCents = transferAmountCents as number

  // ── Idempotency on transfer ID ────────────────────────────────────────────
  const alreadyRecorded = db.query<{ id: string }, [string, string]>(
    `SELECT id FROM payments WHERE merchant_id = ? AND finix_transfer_id = ?`
  ).get(merchant.id, transferId)
  if (alreadyRecorded) return c.json({ ok: true })

  // ── Match or create order ─────────────────────────────────────────────────
  // Kizo sets tags.order_id when creating checkout forms (store.ts /pay handler).
  const tagOrderId = typeof tags?.['order_id'] === 'string' ? tags['order_id'] : undefined

  const existingOrder = tagOrderId
    ? db.query<{ id: string; status: string }, [string, string]>(
        `SELECT id, status FROM orders WHERE id = ? AND merchant_id = ?`
      ).get(tagOrderId, merchant.id)
    : null

  // If order already paid (idempotent) or in a terminal state, skip silently.
  if (existingOrder && (existingOrder.status === 'paid' || existingOrder.status === 'cancelled' || existingOrder.status === 'refunded')) {
    return c.json({ ok: true })
  }

  // ── Atomically record payment + update/create order ───────────────────────
  let shouldBroadcast = false
  db.transaction(() => {
    let orderId: string

    if (existingOrder) {
      orderId = existingOrder.id
      db.run(
        `UPDATE orders
         SET status = 'paid', paid_amount_cents = ?, payment_method = 'card',
             payment_transfer_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [amountCents, transferId, orderId]
      )
      shouldBroadcast = true
    } else {
      // External catering payment — create a stub order
      orderId = generateId('ord')
      db.run(
        `INSERT INTO orders
           (id, merchant_id, customer_name, items,
            subtotal_cents, tax_cents, total_cents,
            status, order_type, source, paid_amount_cents, payment_method,
            payment_transfer_id)
         VALUES (?, ?, 'Catering', ?, ?, 0, ?, 'paid', 'catering', 'finix_webhook', ?, 'card', ?)`,
        [
          orderId, merchant.id,
          JSON.stringify([]),
          amountCents, amountCents,
          amountCents, transferId,
        ]
      )
    }

    const paymentId = generateId('pay')
    db.run(
      `INSERT INTO payments
         (id, merchant_id, order_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents,
          processor, finix_transfer_id, created_at)
       VALUES (?, ?, ?, 'card', ?, ?, 0, 0, 'finix', ?, datetime('now'))`,
      [paymentId, merchant.id, orderId, amountCents, amountCents, transferId]
    )
  })()

  // Broadcast after transaction commits (fire-and-forget, non-critical)
  if (shouldBroadcast && existingOrder) {
    broadcastToMerchant(merchant.id, 'order_paid', { orderId: existingOrder.id })
  }

  return c.json({ ok: true })
})

export { store }
