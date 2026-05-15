/**
 * Business hours and scheduled closures routes
 *
 * Hours are per-merchant, per-service-type ('regular' | 'catering'), per day-of-week.
 * Split hours (e.g. 11am–3pm then 4pm–9pm) are stored as multiple rows with slot_index.
 * Catering operates as a sub-store with independent hours but shared scheduled closures.
 *
 * GET    /api/merchants/:id/hours                  → { regular: [...], catering: [...] }
 * PUT    /api/merchants/:id/hours                  → Replace all slots for one service type
 * DELETE /api/merchants/:id/hours/:day             → Clear one day for a service type
 *
 * GET    /api/merchants/:id/closures               → [{ id, startDate, endDate, label }]
 * POST   /api/merchants/:id/closures               → Create a closure
 * PUT    /api/merchants/:id/closures/:closureId    → Update a closure
 * DELETE /api/merchants/:id/closures/:closureId    → Delete a closure
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { serverError } from '../utils/server-error'

const hours = new Hono()

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const TIME_RE = /^\d{2}:\d{2}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VALID_SERVICE_TYPES = ['regular', 'catering'] as const
type ServiceType = (typeof VALID_SERVICE_TYPES)[number]

/** Returns true when the string is a valid 24-hour HH:MM time. */
function isValidTime(t: string): boolean {
  if (!TIME_RE.test(t)) return false
  const [h, m] = t.split(':').map(Number)
  return h >= 0 && h <= 23 && m >= 0 && m <= 59
}

/** Returns true when closeTime is strictly after openTime (no overnight wrapping). */
function isCloseAfterOpen(open: string, close: string): boolean {
  return close > open
}

/** Returns true when the string is a valid ISO date (YYYY-MM-DD). */
function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false
  return !isNaN(Date.parse(d))
}

// ---------------------------------------------------------------------------
// Hours — business operating hours
// ---------------------------------------------------------------------------

/**
 * GET /api/merchants/:id/hours
 * Returns regular and catering hours grouped separately.
 */
hours.get(
  '/api/merchants/:id/hours',
  authenticate,
  requireOwnMerchant,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    try {
      const db = getDatabase()
      const rows = db
        .query<
          {
            id: string
            service_type: string
            day_of_week: number
            open_time: string
            close_time: string
            slot_index: number
            is_closed: number
          },
          [string]
        >(
          `SELECT id, service_type, day_of_week, open_time, close_time, slot_index, is_closed
           FROM business_hours
           WHERE merchant_id = ?
           ORDER BY service_type, day_of_week, slot_index`
        )
        .all(merchantId)

      const mapRow = (row: (typeof rows)[number]) => ({
        id: row.id,
        dayOfWeek: row.day_of_week,
        openTime: row.open_time,
        closeTime: row.close_time,
        slotIndex: row.slot_index,
        isClosed: row.is_closed === 1,
      })

      return c.json({
        regular: rows.filter((r) => r.service_type === 'regular').map(mapRow),
        catering: rows.filter((r) => r.service_type === 'catering').map(mapRow),
      })
    } catch (error) {
      return serverError(c, '[hours] GET', error, 'Failed to fetch hours')
    }
  }
)

/**
 * PUT /api/merchants/:id/hours
 * Atomically replaces all time slots for a given service type.
 * Send an empty slots array to clear all hours for that service type.
 *
 * Body: {
 *   serviceType: 'regular' | 'catering',
 *   slots: [{ dayOfWeek: 0–6, openTime: 'HH:MM', closeTime: 'HH:MM' }]
 * }
 *
 * Multiple slots for the same dayOfWeek = split hours.
 * slot_index is assigned automatically by position within each day.
 */
hours.put(
  '/api/merchants/:id/hours',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    try {
      const body = await c.req.json()
      const { serviceType, slots } = body

      if (!VALID_SERVICE_TYPES.includes(serviceType)) {
        return c.json(
          { error: `serviceType must be one of: ${VALID_SERVICE_TYPES.join(', ')}` },
          400
        )
      }

      if (!Array.isArray(slots)) {
        return c.json({ error: 'slots must be an array' }, 400)
      }

      // Validate each slot
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        const prefix = `slots[${i}]`

        if (!Number.isInteger(slot.dayOfWeek) || slot.dayOfWeek < 0 || slot.dayOfWeek > 6) {
          return c.json({ error: `${prefix}.dayOfWeek must be an integer between 0 (Sun) and 6 (Sat)` }, 400)
        }
        if (!slot.openTime || !isValidTime(slot.openTime)) {
          return c.json({ error: `${prefix}.openTime must be a valid 24-hour time (HH:MM)` }, 400)
        }
        if (!slot.closeTime || !isValidTime(slot.closeTime)) {
          return c.json({ error: `${prefix}.closeTime must be a valid 24-hour time (HH:MM)` }, 400)
        }
        if (!isCloseAfterOpen(slot.openTime, slot.closeTime)) {
          return c.json(
            { error: `${prefix}: closeTime (${slot.closeTime}) must be after openTime (${slot.openTime})` },
            400
          )
        }
      }

      // Group slots by dayOfWeek to assign slot_index
      const byDay = new Map<number, typeof slots>()
      for (const slot of slots) {
        const arr = byDay.get(slot.dayOfWeek) ?? []
        arr.push(slot)
        byDay.set(slot.dayOfWeek, arr)
      }

      const db = getDatabase()
      db.transaction(() => {
        db.run(
          `DELETE FROM business_hours WHERE merchant_id = ? AND service_type = ?`,
          [merchantId, serviceType]
        )
        for (const [dayOfWeek, daySlots] of byDay) {
          daySlots.forEach((slot: { openTime: string; closeTime: string }, slotIndex: number) => {
            db.run(
              `INSERT INTO business_hours
                (id, merchant_id, service_type, day_of_week, open_time, close_time, slot_index, is_closed)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
              [generateId('bh'), merchantId, serviceType, dayOfWeek, slot.openTime, slot.closeTime, slotIndex]
            )
          })
        }
      })()

      return c.json({ success: true, serviceType, count: slots.length })
    } catch (error) {
      return serverError(c, '[hours] PUT', error, 'Failed to update hours')
    }
  }
)

/**
 * DELETE /api/merchants/:id/hours/:day
 * Clears all time slots for a specific day and service type.
 * Query param: ?serviceType=regular|catering
 */
hours.delete(
  '/api/merchants/:id/hours/:day',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const dayParam = c.req.param('day')!
    const serviceType = c.req.query('serviceType') as ServiceType

    const dayOfWeek = parseInt(dayParam, 10)
    if (!Number.isInteger(dayOfWeek) || isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      return c.json({ error: 'day must be an integer between 0 (Sun) and 6 (Sat)' }, 400)
    }

    if (!serviceType || !VALID_SERVICE_TYPES.includes(serviceType)) {
      return c.json(
        { error: `serviceType query param required: one of ${VALID_SERVICE_TYPES.join(', ')}` },
        400
      )
    }

    try {
      const db = getDatabase()
      db.run(
        `DELETE FROM business_hours WHERE merchant_id = ? AND service_type = ? AND day_of_week = ?`,
        [merchantId, serviceType, dayOfWeek]
      )

      return c.json({ success: true, dayOfWeek, serviceType })
    } catch (error) {
      return serverError(c, '[hours] DELETE day', error, 'Failed to delete hours')
    }
  }
)

// ---------------------------------------------------------------------------
// Closures — scheduled closures shared by all service types
// ---------------------------------------------------------------------------

/**
 * GET /api/merchants/:id/closures
 * Returns all scheduled closures sorted by start date ascending.
 */
hours.get(
  '/api/merchants/:id/closures',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    try {
      const db = getDatabase()
      const rows = db
        .query<
          {
            id: string
            start_date: string
            end_date: string
            label: string
            created_at: string
            updated_at: string
          },
          [string]
        >(
          `SELECT id, start_date, end_date, label, created_at, updated_at
           FROM scheduled_closures
           WHERE merchant_id = ?
           ORDER BY start_date ASC`
        )
        .all(merchantId)

      return c.json(
        rows.map((r) => ({
          id: r.id,
          startDate: r.start_date,
          endDate: r.end_date,
          label: r.label,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }))
      )
    } catch (error) {
      return serverError(c, '[hours] GET closures', error, 'Failed to fetch closures')
    }
  }
)

/**
 * POST /api/merchants/:id/closures
 * Creates a scheduled closure.
 * For a single-day closure, set startDate === endDate.
 *
 * Body: { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', label: string }
 */
hours.post(
  '/api/merchants/:id/closures',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    try {
      const body = await c.req.json()
      const { startDate, endDate, label } = body

      if (!startDate || !isValidDate(startDate)) {
        return c.json({ error: 'startDate must be a valid date (YYYY-MM-DD)' }, 400)
      }
      if (!endDate || !isValidDate(endDate)) {
        return c.json({ error: 'endDate must be a valid date (YYYY-MM-DD)' }, 400)
      }
      if (endDate < startDate) {
        return c.json({ error: 'endDate must be on or after startDate' }, 400)
      }
      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return c.json({ error: 'label is required' }, 400)
      }
      if (label.trim().length > 100) {
        return c.json({ error: 'label must be 100 characters or fewer' }, 400)
      }

      const id = generateId('sc')
      const db = getDatabase()
      db.run(
        `INSERT INTO scheduled_closures (id, merchant_id, start_date, end_date, label)
         VALUES (?, ?, ?, ?, ?)`,
        [id, merchantId, startDate, endDate, label.trim()]
      )

      const created = db
        .query<
          { id: string; start_date: string; end_date: string; label: string; created_at: string; updated_at: string },
          [string]
        >(`SELECT id, start_date, end_date, label, created_at, updated_at FROM scheduled_closures WHERE id = ?`)
        .get(id)!

      return c.json(
        {
          id: created.id,
          startDate: created.start_date,
          endDate: created.end_date,
          label: created.label,
          createdAt: created.created_at,
          updatedAt: created.updated_at,
        },
        201
      )
    } catch (error) {
      return serverError(c, '[hours] POST closure', error, 'Failed to create closure')
    }
  }
)

/**
 * PUT /api/merchants/:id/closures/:closureId
 * Partially updates a scheduled closure.
 * Body: { startDate?, endDate?, label? }
 */
hours.put(
  '/api/merchants/:id/closures/:closureId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const closureId = c.req.param('closureId')!

    try {
      const db = getDatabase()

      const existing = db
        .query<{ id: string; start_date: string; end_date: string }, [string, string]>(
          `SELECT id, start_date, end_date FROM scheduled_closures WHERE id = ? AND merchant_id = ?`
        )
        .get(closureId, merchantId)

      if (!existing) {
        return c.json({ error: 'Closure not found' }, 404)
      }

      const body = await c.req.json()
      const { startDate, endDate, label } = body

      const updates: string[] = []
      const values: string[] = []

      if (startDate !== undefined) {
        if (!isValidDate(startDate)) {
          return c.json({ error: 'startDate must be a valid date (YYYY-MM-DD)' }, 400)
        }
        updates.push('start_date = ?')
        values.push(startDate)
      }
      if (endDate !== undefined) {
        if (!isValidDate(endDate)) {
          return c.json({ error: 'endDate must be a valid date (YYYY-MM-DD)' }, 400)
        }
        updates.push('end_date = ?')
        values.push(endDate)
      }
      if (label !== undefined) {
        if (typeof label !== 'string' || label.trim().length === 0) {
          return c.json({ error: 'label is required' }, 400)
        }
        if (label.trim().length > 100) {
          return c.json({ error: 'label must be 100 characters or fewer' }, 400)
        }
        updates.push('label = ?')
        values.push(label.trim())
      }

      if (updates.length === 0) {
        return c.json({ error: 'No fields to update' }, 400)
      }

      // Validate final date range using resolved values
      const resolvedStart = startDate ?? existing.start_date
      const resolvedEnd = endDate ?? existing.end_date
      if (resolvedEnd < resolvedStart) {
        return c.json({ error: 'endDate must be on or after startDate' }, 400)
      }

      updates.push(`updated_at = datetime('now')`)
      values.push(closureId, merchantId)

      db.run(
        `UPDATE scheduled_closures SET ${updates.join(', ')} WHERE id = ? AND merchant_id = ?`,
        values
      )

      const updated = db
        .query<
          { id: string; start_date: string; end_date: string; label: string; created_at: string; updated_at: string },
          [string]
        >(`SELECT id, start_date, end_date, label, created_at, updated_at FROM scheduled_closures WHERE id = ?`)
        .get(closureId)!

      return c.json({
        id: updated.id,
        startDate: updated.start_date,
        endDate: updated.end_date,
        label: updated.label,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      })
    } catch (error) {
      return serverError(c, '[hours] PUT closure', error, 'Failed to update closure')
    }
  }
)

/**
 * DELETE /api/merchants/:id/closures/:closureId
 * Deletes a scheduled closure.
 */
hours.delete(
  '/api/merchants/:id/closures/:closureId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const closureId = c.req.param('closureId')!

    try {
      const db = getDatabase()

      const existing = db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM scheduled_closures WHERE id = ? AND merchant_id = ?`
        )
        .get(closureId, merchantId)

      if (!existing) {
        return c.json({ error: 'Closure not found' }, 404)
      }

      db.run(`DELETE FROM scheduled_closures WHERE id = ? AND merchant_id = ?`, [closureId, merchantId])

      return c.json({ success: true })
    } catch (error) {
      return serverError(c, '[hours] DELETE closure', error, 'Failed to delete closure')
    }
  }
)

// ---------------------------------------------------------------------------
// Public hours feed — GET /api/store/hours.json
// ---------------------------------------------------------------------------

/**
 * OPTIONS /api/store/hours.json
 * CORS preflight for cross-origin requests from the merchant's external website.
 */
hours.options('/api/store/hours.json', (c) => {
  setHoursCorsHeaders(c)
  return new Response(null, { status: 204 })
})

/**
 * GET /api/store/hours.json
 * Public endpoint — no authentication required.
 *
 * Returns current business hours and upcoming scheduled closures so an
 * external website can display accurate open/closed status.
 *
 * CORS: only the origin matching `merchants.website` receives the
 * Access-Control-Allow-Origin header, so browser JS from any other
 * domain cannot read the response.
 */
hours.get('/api/store/hours.json', (c) => {
  try {
    const db = getDatabase()

    const merchant = db
      .query<{ id: string; timezone: string | null; website: string | null }, []>(
        `SELECT id, timezone, website FROM merchants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`
      )
      .get()

    if (!merchant) return c.json({ error: 'Not found' }, 404)

    const tz = merchant.timezone ?? 'America/Los_Angeles'

    // Today's date in the merchant's local timezone (YYYY-MM-DD)
    const todayLocal = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())

    // Current day-of-week in merchant timezone (0=Sun … 6=Sat)
    const dowLocal = new Date(
      new Date().toLocaleString('en-US', { timeZone: tz })
    ).getDay()

    // Current HH:MM in merchant timezone
    const timeLocal = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date())    // → "HH:MM"

    // Regular business hours
    const regularHours = db
      .query<
        { day_of_week: number; open_time: string; close_time: string; slot_index: number },
        [string]
      >(
        `SELECT day_of_week, open_time, close_time, slot_index
         FROM business_hours
         WHERE merchant_id = ? AND service_type = 'regular'
         ORDER BY day_of_week ASC, slot_index ASC`
      )
      .all(merchant.id)
      .map((h) => ({
        dayOfWeek: h.day_of_week,
        openTime:  h.open_time,
        closeTime: h.close_time,
        slotIndex: h.slot_index,
      }))

    // Upcoming scheduled closures (today onward, next 90 days)
    const ninetyDaysOut = new Date()
    ninetyDaysOut.setDate(ninetyDaysOut.getDate() + 90)
    const limitDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ninetyDaysOut)

    const scheduledClosures = db
      .query<
        { start_date: string; end_date: string; label: string },
        [string, string, string]
      >(
        `SELECT start_date, end_date, label
         FROM scheduled_closures
         WHERE merchant_id = ? AND end_date >= ? AND start_date <= ?
         ORDER BY start_date ASC`
      )
      .all(merchant.id, todayLocal, limitDate)
      .map((r) => ({
        startDate: r.start_date,
        endDate:   r.end_date,
        label:     r.label,
      }))

    // Is today a scheduled closure?
    const closedTodayClosure = scheduledClosures.find(
      (cl) => cl.startDate <= todayLocal && cl.endDate >= todayLocal
    ) ?? null

    // Are we within any regular-hours slot for today?
    const todaySlots = regularHours.filter((h) => h.dayOfWeek === dowLocal)
    const openNow = !closedTodayClosure && todaySlots.some(
      (h) => timeLocal >= h.openTime && timeLocal < h.closeTime
    )

    // Set CORS header if the requesting origin matches the merchant's website
    setHoursCorsHeaders(c, merchant.website)

    // Cache for 10 minutes — external site polls every hour, this smooths bursts
    c.header('Cache-Control', 'public, max-age=600, stale-while-revalidate=300')

    return c.json({
      timezone:          tz,
      isOpen:            openNow,
      closedToday:       closedTodayClosure !== null,
      closedTodayLabel:  closedTodayClosure?.label ?? null,
      regularHours,
      scheduledClosures,
      generatedAt:       new Date().toISOString(),
    })
  } catch (error) {
    return serverError(c, '[hours] GET /api/store/hours.json', error, 'Failed to fetch hours')
  }
})

/**
 * Set CORS headers for the public hours feed.
 * Only allows the origin that matches `merchantWebsite`; all others receive no ACAO header
 * so browsers will block cross-origin reads (same-origin requests always work).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono context type varies by router; using any avoids coupling this helper to a specific Hono generic
function setHoursCorsHeaders(c: any, merchantWebsite?: string | null): void {
  if (!merchantWebsite) return
  let siteOrigin: string
  try { siteOrigin = new URL(merchantWebsite).origin } catch { return }
  if (!siteOrigin || siteOrigin === 'null') return

  const requestOrigin = c.req.header('Origin') ?? ''
  if (requestOrigin === siteOrigin) {
    c.header('Access-Control-Allow-Origin', siteOrigin)
    c.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
    c.header('Access-Control-Max-Age', '86400')
    c.header('Vary', 'Origin')
  }
}

export { hours }
