/**
 * Backup, Restore, Wipe, and S3-config endpoints.
 *
 * Backup types:  menu | orders | employees | profile | full
 * Restore:       Replace strategy — wipe target data, then re-insert
 * Wipe:          Destructive reset with explicit confirm flag
 * S3 config:     Credentials stored encrypted via api_keys table (keyType='cloud', provider='s3')
 *
 * API keys / payment credentials are NEVER included in any backup.
 */

import { Hono } from 'hono'
import { getDatabase }                   from '../db/connection'
import { authenticate, requireRole } from '../middleware/auth'
import type { AuthContext }              from '../middleware/auth'
import { storeAPIKey, getAPIKey, deleteAPIKey } from '../crypto/api-keys'
import { s3PutObject, s3GetObject }      from '../services/s3'
import type { S3Config }                 from '../services/s3'
import { serverError }                   from '../utils/server-error'

const backup = new Hono()

// ---------------------------------------------------------------------------
// Rate limiter — per-merchant, for CPU/disk-intensive backup and restore ops
// M-10: Prevents repeated backup/restore from exhausting disk I/O or CPU.
// ---------------------------------------------------------------------------
const backupLastRun = new Map<string, number>()  // merchantId → lastRunAt
const restoreLastRun = new Map<string, number>()
const BACKUP_MIN_INTERVAL_MS = 60 * 1000  // 1 per minute

function checkBackupRateLimit(map: Map<string, number>, merchantId: string): boolean {
  const last = map.get(merchantId) ?? 0
  if (Date.now() - last < BACKUP_MIN_INTERVAL_MS) return false
  map.set(merchantId, Date.now())
  return true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayISO() { return new Date().toISOString().slice(0, 10) }

function parseDate(s: string | undefined, fallback: string): string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback
  return s
}

/** Strip sam_state from every order row (internal FSM — not portable) */
function stripSamState<T extends { sam_state?: unknown }>(rows: T[]): Omit<T, 'sam_state'>[] {
  return rows.map(({ sam_state: _, ...rest }) => rest as Omit<T, 'sam_state'>)
}

// ---------------------------------------------------------------------------
// Backup data shape — mirrors what backupMenu/Orders/Employees/Profile emit
// ---------------------------------------------------------------------------

interface BackupCategoryRow {
  id: string; merchant_id?: string; name: string
  sort_order?: number; pos_category_id?: string | null
  created_at: string; updated_at: string
}
interface BackupMenuItemRow {
  id: string; merchant_id?: string; category_id?: string | null
  pos_item_id?: string | null; name: string; description?: string | null
  price_cents?: number; price_type?: string; image_url?: string | null
  is_available?: number; sort_order?: number; created_at: string; updated_at: string
  available_online?: number | null; stock_status?: string | null
  dietary_tags?: string | null; is_popular?: number | null
}
interface BackupModifierGroupRow {
  id: string; merchant_id?: string; pos_group_id?: string | null; name: string
  min_required?: number; max_allowed?: number | null; created_at: string; updated_at: string
}
interface BackupModifierRow {
  id: string; group_id: string; pos_modifier_id?: string | null; name: string
  price_cents?: number; is_available?: number; sort_order?: number
  created_at: string; updated_at: string
}
interface BackupItemModifierGroupRow {
  item_id: string; group_id: string; sort_order?: number
}
interface BackupOrderRow {
  id: string; merchant_id?: string; customer_name: string
  customer_phone?: string | null; customer_email?: string | null
  items: string; subtotal_cents?: number; tax_cents?: number; total_cents?: number
  status?: string; pos_order_id?: string | null; pos_provider?: string | null
  order_type?: string; pickup_code?: string | null; pickup_time?: string | null
  created_at: string; updated_at: string; completed_at?: string | null
  notes?: string | null; table_label?: string | null; room_label?: string | null
  employee_id?: string | null; employee_nickname?: string | null
  tip_cents?: number | null; paid_amount_cents?: number | null
  payment_method?: string | null
}
interface BackupEmployeeRow {
  id: string; merchant_id?: string; nickname: string; access_code_hash: string
  role: string; schedule?: string | null; active?: number; created_at: string; updated_at: string
}
interface BackupShiftRow {
  id: string; employee_id: string; merchant_id?: string
  clock_in: string; clock_out?: string | null; date: string
  auto_clocked_out?: number; scheduled_end?: string | null; created_at: string
}
interface BackupProfileRow {
  business_name?: string; description?: string | null; cuisine_types?: string | null
  logo_url?: string | null; banner_url?: string | null; table_layout?: string | null
  phone_number?: string | null; email?: string | null; website?: string | null
  address?: string | null; tax_rate?: number; tip_options?: string | null
  printer_ip?: string | null; counter_printer_ip?: string | null
  receipt_printer_ip?: string | null; kitchen_printer_protocol?: string | null
  counter_printer_protocol?: string | null; receipt_printer_protocol?: string | null
  show_employee_sales?: number | null; payment_provider?: string | null
  pay_period_type?: string | null; pay_period_anchor?: string | null
  break_rule?: string | null
}
interface BackupHourRow {
  id: string; service_type: string; day_of_week: number
  open_time?: string | null; close_time?: string | null
  slot_index?: number; is_closed?: number; created_at: string; updated_at: string
}
interface BackupClosureRow {
  id: string; start_date: string; end_date: string
  label?: string | null; created_at: string; updated_at: string
}

/**
 * Shape of `backup.data` in a restore payload.
 * For type-specific backups only the relevant fields are present;
 * for 'full' backups all fields are merged into one object.
 */
interface BackupData {
  categories?:         BackupCategoryRow[]
  items?:              BackupMenuItemRow[]
  modifierGroups?:     BackupModifierGroupRow[]
  modifiers?:          BackupModifierRow[]
  itemModifierGroups?: BackupItemModifierGroupRow[]
  orders?:             BackupOrderRow[]
  employees?:          BackupEmployeeRow[]
  shifts?:             BackupShiftRow[]
  profile?:            BackupProfileRow
  hours?:              BackupHourRow[]
  closures?:           BackupClosureRow[]
}

// ---------------------------------------------------------------------------
// Backup generation
// ---------------------------------------------------------------------------

type BackupType = 'menu' | 'orders' | 'employees' | 'profile' | 'full'

function backupMenu(db: ReturnType<typeof getDatabase>, merchantId: string) {
  const categories = db.query<BackupCategoryRow, [string]>(
    `SELECT * FROM menu_categories WHERE merchant_id = ? ORDER BY sort_order`
  ).all(merchantId)

  const items = db.query<BackupMenuItemRow, [string]>(
    `SELECT * FROM menu_items WHERE merchant_id = ? ORDER BY sort_order`
  ).all(merchantId)

  const modifierGroups = db.query<BackupModifierGroupRow, [string]>(
    `SELECT * FROM modifier_groups WHERE merchant_id = ?`
  ).all(merchantId)

  const modifiers = db.query<BackupModifierRow, [string]>(
    `SELECT m.* FROM modifiers m
     JOIN modifier_groups mg ON mg.id = m.group_id
     WHERE mg.merchant_id = ?`
  ).all(merchantId)

  const itemModifierGroups = db.query<BackupItemModifierGroupRow, [string]>(
    `SELECT img.* FROM menu_item_modifier_groups img
     JOIN menu_items mi ON mi.id = img.item_id
     WHERE mi.merchant_id = ?`
  ).all(merchantId)

  return { categories, items, modifierGroups, modifiers, itemModifierGroups }
}

function backupOrders(
  db: ReturnType<typeof getDatabase>,
  merchantId: string,
  from: string,
  to: string
) {
  const orders = stripSamState(
    db.query<BackupOrderRow & { sam_state?: string | null }, [string, string, string]>(
      `SELECT * FROM orders
       WHERE merchant_id = ?
         AND substr(created_at, 1, 10) >= ?
         AND substr(created_at, 1, 10) <= ?
       ORDER BY created_at ASC`
    ).all(merchantId, from, to)
  )
  return { orders }
}

function backupEmployees(
  db: ReturnType<typeof getDatabase>,
  merchantId: string,
  from: string,
  to: string
) {
  const employees = db.query<BackupEmployeeRow, [string]>(
    `SELECT * FROM employees WHERE merchant_id = ?`
  ).all(merchantId)

  const shifts = db.query<BackupShiftRow, [string, string, string]>(
    `SELECT t.* FROM timesheets t
     WHERE t.merchant_id = ?
       AND t.date >= ?
       AND t.date <= ?
     ORDER BY t.date ASC, t.clock_in ASC`
  ).all(merchantId, from, to)

  return { employees, shifts }
}

function backupProfile(db: ReturnType<typeof getDatabase>, merchantId: string) {
  const row = db.query<BackupProfileRow, [string]>(
    `SELECT
       id, business_name, slug, description, cuisine_types, logo_url, banner_url,
       table_layout, phone_number, email, website, address, status, tax_rate,
       tip_options, printer_ip, counter_printer_ip, receipt_printer_ip,
       kitchen_printer_protocol, counter_printer_protocol, receipt_printer_protocol,
       show_employee_sales, payment_provider, pay_period_type, pay_period_anchor,
       break_rule
     FROM merchants WHERE id = ?`
  ).get(merchantId)

  const hours = db.query<BackupHourRow, [string]>(
    `SELECT * FROM business_hours WHERE merchant_id = ? ORDER BY service_type, day_of_week, slot_index`
  ).all(merchantId)

  const closures = db.query<BackupClosureRow, [string]>(
    `SELECT * FROM scheduled_closures WHERE merchant_id = ? ORDER BY start_date`
  ).all(merchantId)

  return { profile: row, hours, closures }
}

async function generateBackup(
  merchantId: string,
  type: BackupType,
  from: string,
  to: string
): Promise<object> {
  const db = getDatabase()

  let data: object
  if (type === 'menu') {
    data = backupMenu(db, merchantId)
  } else if (type === 'orders') {
    data = backupOrders(db, merchantId, from, to)
  } else if (type === 'employees') {
    data = backupEmployees(db, merchantId, from, to)
  } else if (type === 'profile') {
    data = backupProfile(db, merchantId)
  } else {
    // full
    data = {
      ...backupMenu(db, merchantId),
      ...backupOrders(db, merchantId, from, to),
      ...backupEmployees(db, merchantId, from, to),
      ...backupProfile(db, merchantId),
    }
  }

  return {
    version:    '1',
    merchantId,
    type,
    createdAt:  new Date().toISOString(),
    from:       type === 'orders' || type === 'employees' || type === 'full' ? from : null,
    to:         type === 'orders' || type === 'employees' || type === 'full' ? to   : null,
    data,
  }
}

// ---------------------------------------------------------------------------
// Restore helpers (Replace strategy)
// ---------------------------------------------------------------------------

function restoreMenu(db: ReturnType<typeof getDatabase>, merchantId: string, data: BackupData): { restoredCount: number; skippedCount: number } {
  return db.transaction(() => {
    // Delete in FK-safe order (children first)
    db.run(`DELETE FROM menu_item_modifier_groups
            WHERE item_id IN (SELECT id FROM menu_items WHERE merchant_id = ?)`, [merchantId])
    db.run(`DELETE FROM modifiers
            WHERE group_id IN (SELECT id FROM modifier_groups WHERE merchant_id = ?)`, [merchantId])
    db.run(`DELETE FROM modifier_groups WHERE merchant_id = ?`, [merchantId])
    db.run(`DELETE FROM menu_items WHERE merchant_id = ?`,      [merchantId])
    db.run(`DELETE FROM menu_categories WHERE merchant_id = ?`, [merchantId])

    let restoredCount = 0
    let totalAttempted = 0

    for (const row of (data.categories ?? [])) {
      totalAttempted++
      restoredCount += db.run(
        `INSERT OR IGNORE INTO menu_categories
         (id, merchant_id, name, sort_order, pos_category_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, merchantId, row.name, row.sort_order ?? 0,
         row.pos_category_id ?? null, row.created_at, row.updated_at]
      ).changes
    }

    for (const row of (data.items ?? [])) {
      totalAttempted++
      restoredCount += db.run(
        `INSERT OR IGNORE INTO menu_items
         (id, merchant_id, category_id, pos_item_id, name, description,
          price_cents, price_type, image_url, is_available, sort_order,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, merchantId, row.category_id ?? null, row.pos_item_id ?? null,
         row.name, row.description ?? null, row.price_cents ?? 0,
         row.price_type ?? 'FIXED', row.image_url ?? null,
         row.is_available ?? 1, row.sort_order ?? 0,
         row.created_at, row.updated_at]
      ).changes
      // Migration columns — use UPDATE to set them if present
      if (row.available_online !== undefined || row.stock_status !== undefined ||
          row.dietary_tags !== undefined || row.is_popular !== undefined) {
        db.run(
          `UPDATE menu_items SET
             available_online = COALESCE(?, available_online),
             stock_status     = COALESCE(?, stock_status),
             dietary_tags     = COALESCE(?, dietary_tags),
             is_popular       = COALESCE(?, is_popular)
           WHERE id = ?`,
          [row.available_online ?? null, row.stock_status ?? null,
           row.dietary_tags ?? null, row.is_popular ?? null, row.id]
        )
      }
    }

    for (const row of (data.modifierGroups ?? [])) {
      totalAttempted++
      restoredCount += db.run(
        `INSERT OR IGNORE INTO modifier_groups
         (id, merchant_id, pos_group_id, name, min_required, max_allowed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, merchantId, row.pos_group_id ?? null, row.name,
         row.min_required ?? 0, row.max_allowed ?? null,
         row.created_at, row.updated_at]
      ).changes
    }

    for (const row of (data.modifiers ?? [])) {
      totalAttempted++
      restoredCount += db.run(
        `INSERT OR IGNORE INTO modifiers
         (id, group_id, pos_modifier_id, name, price_cents, is_available, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.group_id, row.pos_modifier_id ?? null, row.name,
         row.price_cents ?? 0, row.is_available ?? 1, row.sort_order ?? 0,
         row.created_at, row.updated_at]
      ).changes
    }

    for (const row of (data.itemModifierGroups ?? [])) {
      totalAttempted++
      restoredCount += db.run(
        `INSERT OR IGNORE INTO menu_item_modifier_groups (item_id, group_id, sort_order)
         VALUES (?, ?, ?)`,
        [row.item_id, row.group_id, row.sort_order ?? 0]
      ).changes
    }

    return { restoredCount, skippedCount: totalAttempted - restoredCount }
  })()
}

function restoreOrders(
  db: ReturnType<typeof getDatabase>,
  merchantId: string,
  data: BackupData,
  from: string,
  to: string
): { restoredCount: number; skippedCount: number } {
  return db.transaction(() => {
    // Delete orders in the date range, then re-insert
    db.run(
      `DELETE FROM orders
       WHERE merchant_id = ?
         AND substr(created_at, 1, 10) >= ?
         AND substr(created_at, 1, 10) <= ?`,
      [merchantId, from, to]
    )

    let restoredCount = 0
    const totalAttempted = (data.orders ?? []).length

    for (const row of (data.orders ?? [])) {
      restoredCount += db.run(
        `INSERT OR IGNORE INTO orders
         (id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents,
          status, pos_order_id, pos_provider, order_type, pickup_code, pickup_time,
          created_at, updated_at, completed_at)
         VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?)`,
        [row.id, merchantId, row.customer_name, row.customer_phone ?? null,
         row.customer_email ?? null, row.items, row.subtotal_cents ?? 0,
         row.tax_cents ?? 0, row.total_cents ?? 0, row.status ?? 'completed',
         row.pos_order_id ?? null, row.pos_provider ?? null,
         row.order_type ?? 'pickup', row.pickup_code ?? null,
         row.pickup_time ?? null, row.created_at, row.updated_at,
         row.completed_at ?? null]
      ).changes
      // Migration columns
      db.run(
        `UPDATE orders SET
           notes            = COALESCE(?, notes),
           table_label      = COALESCE(?, table_label),
           room_label       = COALESCE(?, room_label),
           employee_id      = COALESCE(?, employee_id),
           employee_nickname= COALESCE(?, employee_nickname),
           tip_cents        = COALESCE(?, tip_cents),
           paid_amount_cents= COALESCE(?, paid_amount_cents),
           payment_method   = COALESCE(?, payment_method)
         WHERE id = ?`,
        [row.notes ?? null, row.table_label ?? null, row.room_label ?? null,
         row.employee_id ?? null, row.employee_nickname ?? null,
         row.tip_cents ?? null, row.paid_amount_cents ?? null,
         row.payment_method ?? null, row.id]
      )
    }

    return { restoredCount, skippedCount: totalAttempted - restoredCount }
  })()
}

function restoreEmployees(db: ReturnType<typeof getDatabase>, merchantId: string, data: BackupData): { restoredCount: number; skippedCount: number } {
  return db.transaction(() => {
    db.run(`DELETE FROM timesheets WHERE merchant_id = ?`, [merchantId])
    db.run(`DELETE FROM employees  WHERE merchant_id = ?`, [merchantId])

    let restoredCount = 0
    let totalAttempted = 0

    for (const row of (data.employees ?? [])) {
      totalAttempted++
      restoredCount += db.run(
        `INSERT OR IGNORE INTO employees
         (id, merchant_id, nickname, access_code_hash, role, schedule, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.id, merchantId, row.nickname, row.access_code_hash,
         row.role, row.schedule ?? null, row.active ?? 1,
         row.created_at, row.updated_at]
      ).changes
    }

    for (const row of (data.shifts ?? [])) {
      totalAttempted++
      restoredCount += db.run(
        `INSERT OR IGNORE INTO timesheets
         (id, employee_id, merchant_id, clock_in, clock_out, date,
          auto_clocked_out, scheduled_end, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.id, row.employee_id, merchantId,
         row.clock_in, row.clock_out ?? null, row.date,
         row.auto_clocked_out ?? 0, row.scheduled_end ?? null,
         row.created_at]
      ).changes
    }

    return { restoredCount, skippedCount: totalAttempted - restoredCount }
  })()
}

function restoreProfile(db: ReturnType<typeof getDatabase>, merchantId: string, data: BackupData) {
  db.transaction(() => {
    const p = data.profile ?? {}
    db.run(
      `UPDATE merchants SET
         business_name             = COALESCE(?, business_name),
         description               = ?,
         cuisine_types             = ?,
         logo_url                  = ?,
         banner_url                = ?,
         table_layout              = ?,
         phone_number              = ?,
         email                     = ?,
         website                   = ?,
         address                   = ?,
         tax_rate                  = COALESCE(?, tax_rate),
         tip_options               = COALESCE(?, tip_options),
         printer_ip                = ?,
         counter_printer_ip        = ?,
         receipt_printer_ip        = ?,
         kitchen_printer_protocol  = COALESCE(?, kitchen_printer_protocol),
         counter_printer_protocol  = COALESCE(?, counter_printer_protocol),
         receipt_printer_protocol  = COALESCE(?, receipt_printer_protocol),
         show_employee_sales       = COALESCE(?, show_employee_sales),
         payment_provider          = ?,
         pay_period_type           = COALESCE(?, pay_period_type),
         pay_period_anchor         = ?,
         break_rule                = ?,
         updated_at                = datetime('now')
       WHERE id = ?`,
      [p.business_name ?? null, p.description ?? null, p.cuisine_types ?? null,
       p.logo_url ?? null, p.banner_url ?? null, p.table_layout ?? null,
       p.phone_number ?? null, p.email ?? null, p.website ?? null, p.address ?? null,
       p.tax_rate ?? null, p.tip_options ?? null,
       p.printer_ip ?? null, p.counter_printer_ip ?? null, p.receipt_printer_ip ?? null,
       p.kitchen_printer_protocol ?? null, p.counter_printer_protocol ?? null,
       p.receipt_printer_protocol ?? null,
       p.show_employee_sales ?? null, p.payment_provider ?? null,
       p.pay_period_type ?? null, p.pay_period_anchor ?? null,
       p.break_rule ?? null, merchantId]
    )

    db.run(`DELETE FROM business_hours      WHERE merchant_id = ?`, [merchantId])
    db.run(`DELETE FROM scheduled_closures  WHERE merchant_id = ?`, [merchantId])

    for (const row of (data.hours ?? [])) {
      db.run(
        `INSERT OR IGNORE INTO business_hours
         (id, merchant_id, service_type, day_of_week, open_time, close_time,
          slot_index, is_closed, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [row.id, merchantId, row.service_type, row.day_of_week,
         row.open_time ?? null, row.close_time ?? null,
         row.slot_index ?? 0, row.is_closed ?? 0,
         row.created_at, row.updated_at]
      )
    }

    for (const row of (data.closures ?? [])) {
      db.run(
        `INSERT OR IGNORE INTO scheduled_closures
         (id, merchant_id, start_date, end_date, label, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        [row.id, merchantId, row.start_date, row.end_date,
         row.label ?? null, row.created_at, row.updated_at]
      )
    }
  })()
}

// ---------------------------------------------------------------------------
// S3 config helpers
// ---------------------------------------------------------------------------

async function getS3Config(merchantId: string): Promise<S3Config | null> {
  const raw = await getAPIKey(merchantId, 'cloud', 's3')
  if (!raw) return null
  try { return JSON.parse(raw) as S3Config } catch { return null }
}

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/backup
// ?type=menu|orders|employees|profile|full  &from=YYYY-MM-DD  &to=YYYY-MM-DD
// ---------------------------------------------------------------------------

backup.get(
  '/api/merchants/:id/backup',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {

    const merchantId = c.req.param('id')

    // M-10: Rate-limit backup generation (1 per minute per merchant)
    if (!checkBackupRateLimit(backupLastRun, merchantId)) {
      return c.json({ error: 'Backup rate limit exceeded. Please wait 1 minute between backups.' }, 429)
    }

    const rawType    = c.req.query('type') ?? 'full'
    const validTypes: BackupType[] = ['menu', 'orders', 'employees', 'profile', 'full']
    const type = validTypes.includes(rawType as BackupType) ? rawType as BackupType : 'full'

    const thirtyAgo = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10) })()
    const from = parseDate(c.req.query('from'), thirtyAgo)
    const to   = parseDate(c.req.query('to'),   todayISO())

    try {
      const payload  = await generateBackup(merchantId, type, from, to)
      const json     = JSON.stringify(payload, null, 2)
      const filename = `backup-${type}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`

      return new Response(json, {
        headers: {
          'Content-Type':        'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    } catch (err) {
      return serverError(c, '[backup] GET', err, 'Backup generation failed')
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/restore
// Body: { backup: <backup JSON object> }
// ---------------------------------------------------------------------------

backup.post(
  '/api/merchants/:id/restore',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    // M-10: Rate-limit restore operations (1 per minute per merchant)
    if (!checkBackupRateLimit(restoreLastRun, merchantId)) {
      return c.json({ error: 'Restore rate limit exceeded. Please wait 1 minute between restores.' }, 429)
    }

    let body: { backup?: { type?: unknown; data?: unknown; from?: unknown; to?: unknown } }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const bk = body.backup
    if (!bk || !bk.type || !bk.data) {
      return c.json({ error: 'backup.type and backup.data are required' }, 400)
    }

    const validTypes: BackupType[] = ['menu', 'orders', 'employees', 'profile', 'full']
    if (!validTypes.includes(bk.type as BackupType)) {
      return c.json({ error: `Unknown backup type: ${bk.type}` }, 400)
    }

    // H-08: Basic schema validation — data must be a plain object
    if (typeof bk.data !== 'object' || bk.data === null || Array.isArray(bk.data)) {
      return c.json({ error: 'backup.data must be a JSON object' }, 400)
    }

    const backupType = bk.type as BackupType
    const backupData = bk.data as BackupData
    const from = parseDate(typeof bk.from === 'string' ? bk.from : undefined, (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10) })())
    const to   = parseDate(typeof bk.to   === 'string' ? bk.to   : undefined, todayISO())

    const db = getDatabase()

    try {
      let restoredCount = 0
      let skippedCount  = 0

      if (backupType === 'menu' || backupType === 'full') {
        const counts = restoreMenu(db, merchantId, backupData)
        restoredCount += counts.restoredCount
        skippedCount  += counts.skippedCount
      }
      if (backupType === 'orders' || backupType === 'full') {
        const counts = restoreOrders(db, merchantId, backupData, from, to)
        restoredCount += counts.restoredCount
        skippedCount  += counts.skippedCount
      }
      if (backupType === 'employees' || backupType === 'full') {
        const counts = restoreEmployees(db, merchantId, backupData)
        restoredCount += counts.restoredCount
        skippedCount  += counts.skippedCount
      }
      if (backupType === 'profile' || backupType === 'full') {
        restoreProfile(db, merchantId, backupData)
      }

      return c.json({ success: true, type: backupType, restoredCount, skippedCount })
    } catch (err) {
      return serverError(c, '[backup] restore', err, 'Restore failed')
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/wipe
// Body: { type: 'menu' | 'employees' | 'full', confirm: true }
// ---------------------------------------------------------------------------

backup.post(
  '/api/merchants/:id/wipe',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    let body: { type?: string; confirm?: boolean }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    if (!body.confirm) return c.json({ error: 'confirm: true is required' }, 400)
    const validWipeTypes = ['menu', 'employees', 'full']
    if (!body.type || !validWipeTypes.includes(body.type)) {
      return c.json({ error: 'type must be menu | employees | full' }, 400)
    }

    const db = getDatabase()

    try {
      db.transaction(() => {
        if (body.type === 'menu' || body.type === 'full') {
          db.run(`DELETE FROM menu_item_modifier_groups
                  WHERE item_id IN (SELECT id FROM menu_items WHERE merchant_id = ?)`, [merchantId])
          db.run(`DELETE FROM modifiers
                  WHERE group_id IN (SELECT id FROM modifier_groups WHERE merchant_id = ?)`, [merchantId])
          db.run(`DELETE FROM modifier_groups WHERE merchant_id = ?`, [merchantId])
          db.run(`DELETE FROM menu_items      WHERE merchant_id = ?`, [merchantId])
          db.run(`DELETE FROM menu_categories WHERE merchant_id = ?`, [merchantId])
        }

        if (body.type === 'employees' || body.type === 'full') {
          db.run(`DELETE FROM timesheets WHERE merchant_id = ?`, [merchantId])
          db.run(`DELETE FROM employees  WHERE merchant_id = ?`, [merchantId])
        }

        if (body.type === 'full') {
          db.run(`DELETE FROM orders             WHERE merchant_id = ?`, [merchantId])
          db.run(`DELETE FROM business_hours     WHERE merchant_id = ?`, [merchantId])
          db.run(`DELETE FROM scheduled_closures WHERE merchant_id = ?`, [merchantId])
          // Reset merchant to safe defaults
          db.run(
            `UPDATE merchants SET
               description = NULL, cuisine_types = NULL,
               logo_url = NULL, banner_url = NULL, table_layout = NULL,
               phone_number = NULL, website = NULL, address = NULL,
               tax_rate = 0, tip_options = '[15,20,25]',
               printer_ip = NULL, counter_printer_ip = NULL, receipt_printer_ip = NULL,
               payment_provider = NULL,
               updated_at = datetime('now')
             WHERE id = ?`,
            [merchantId]
          )
        }
      })()

      return c.json({ success: true, wiped: body.type })
    } catch (err) {
      return serverError(c, '[backup] wipe', err, 'Wipe failed')
    }
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/s3-config   — status only (never returns credentials)
// ---------------------------------------------------------------------------

backup.get(
  '/api/merchants/:id/s3-config',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const cfg = await getS3Config(merchantId)
    if (!cfg) return c.json({ configured: false })
    return c.json({ configured: true, bucket: cfg.bucket, region: cfg.region })
  }
)

// ---------------------------------------------------------------------------
// PUT /api/merchants/:id/s3-config   — save encrypted credentials
// Body: { accessKeyId, secretAccessKey, bucket, region }
// ---------------------------------------------------------------------------

backup.put(
  '/api/merchants/:id/s3-config',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    let body: { accessKeyId?: string; secretAccessKey?: string; bucket?: string; region?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const { accessKeyId, secretAccessKey, bucket, region } = body
    if (!accessKeyId || !secretAccessKey || !bucket || !region) {
      return c.json({ error: 'accessKeyId, secretAccessKey, bucket, and region are required' }, 400)
    }

    // H-02: Validate bucket name (AWS rules: 3-63 chars, lowercase, no IP-style)
    if (!/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(bucket) || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
      return c.json({ error: 'Invalid S3 bucket name' }, 400)
    }
    // H-02: Validate region format (e.g. us-east-1, ap-southeast-2)
    if (!/^[a-z]{2}(-[a-z]+-\d+)?$/.test(region)) {
      return c.json({ error: 'Invalid AWS region format' }, 400)
    }

    const ipAddress = c.get('ipAddress') ?? ''
    await storeAPIKey(merchantId, 'cloud', 's3', JSON.stringify({ accessKeyId, secretAccessKey, bucket, region }), ipAddress)

    return c.json({ success: true, bucket, region })
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/s3-config
// ---------------------------------------------------------------------------

backup.delete(
  '/api/merchants/:id/s3-config',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const ipAddress  = c.get('ipAddress') ?? ''
    try {
      await deleteAPIKey(merchantId, 'cloud', 's3', ipAddress)
      return c.json({ success: true })
    } catch {
      return c.json({ success: true }) // idempotent — already gone is fine
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/s3-backup/trigger   — manual S3 backup trigger
// ---------------------------------------------------------------------------

backup.post(
  '/api/merchants/:id/s3-backup/trigger',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const cfg = await getS3Config(merchantId)
    if (!cfg) return c.json({ error: 'S3 not configured' }, 400)

    try {
      const yesterday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10) })()
      const payload   = await generateBackup(merchantId, 'orders', yesterday, yesterday)
      const key       = `${merchantId}/orders/${yesterday}.json`
      await s3PutObject(cfg, key, JSON.stringify(payload))
      return c.json({ success: true, key, date: yesterday })
    } catch (err) {
      return serverError(c, '[backup] S3 backup', err, 'S3 backup upload failed')
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/restore/s3   — download latest backup from S3 and restore
// Body: { key: string }   — S3 object key, e.g. "m_abc/orders/2026-02-27.json"
// ---------------------------------------------------------------------------

backup.post(
  '/api/merchants/:id/restore/s3',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    let body: { key?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const { key } = body
    if (!key?.trim()) {
      return c.json({ error: 'key is required (S3 object key to restore from)' }, 400)
    }

    const cfg = await getS3Config(merchantId)
    if (!cfg) {
      return c.json({ error: 'S3 not configured for this merchant' }, 400)
    }

    let json: string
    try {
      json = await s3GetObject(cfg, key.trim())
    } catch (err) {
      return serverError(c, '[backup] S3 restore download', err, 'S3 download failed')
    }

    let bk: { type?: unknown; data?: unknown; from?: unknown; to?: unknown }
    try {
      const parsed = JSON.parse(json)
      bk = parsed.backup ?? parsed  // handle both { backup: {...} } and bare backup objects
    } catch {
      return c.json({ error: 'Downloaded object is not valid JSON' }, 400)
    }

    if (!bk?.type || !bk?.data) {
      return c.json({ error: 'Backup object must have type and data fields' }, 400)
    }

    const validTypes: BackupType[] = ['menu', 'orders', 'employees', 'profile', 'full']
    if (!validTypes.includes(bk.type as BackupType)) {
      return c.json({ error: `Unknown backup type: ${bk.type}` }, 400)
    }

    if (typeof bk.data !== 'object' || bk.data === null || Array.isArray(bk.data)) {
      return c.json({ error: 'backup.data must be a JSON object' }, 400)
    }

    const s3BackupType = bk.type as BackupType
    const s3BackupData = bk.data as BackupData
    const from = parseDate(typeof bk.from === 'string' ? bk.from : undefined, (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10) })())
    const to   = parseDate(typeof bk.to   === 'string' ? bk.to   : undefined, todayISO())

    const db = getDatabase()

    try {
      let restoredCount = 0
      let skippedCount  = 0

      if (s3BackupType === 'menu' || s3BackupType === 'full') {
        const counts = restoreMenu(db, merchantId, s3BackupData)
        restoredCount += counts.restoredCount
        skippedCount  += counts.skippedCount
      }
      if (s3BackupType === 'orders' || s3BackupType === 'full') {
        const counts = restoreOrders(db, merchantId, s3BackupData, from, to)
        restoredCount += counts.restoredCount
        skippedCount  += counts.skippedCount
      }
      if (s3BackupType === 'employees' || s3BackupType === 'full') {
        const counts = restoreEmployees(db, merchantId, s3BackupData)
        restoredCount += counts.restoredCount
        skippedCount  += counts.skippedCount
      }
      if (s3BackupType === 'profile' || s3BackupType === 'full') {
        restoreProfile(db, merchantId, s3BackupData)
      }

      return c.json({ success: true, key, type: s3BackupType, restoredCount, skippedCount })
    } catch (err) {
      return serverError(c, '[backup] S3 restore', err, 'S3 restore failed')
    }
  }
)

export { backup }

// ---------------------------------------------------------------------------
// Export helpers used by auto-backup service
// ---------------------------------------------------------------------------

export { generateBackup, getS3Config }
