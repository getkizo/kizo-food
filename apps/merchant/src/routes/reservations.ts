/**
 * Reservation routes
 *
 * Public endpoints (customer-facing, no auth):
 *   GET  /api/store/reservations/config              — feature flags, limits
 *   GET  /api/store/reservations/slots?date=YYYY-MM-DD — available time slots
 *   POST /api/store/reservations                     — create reservation
 *   DELETE /api/store/reservations/:id?code=XXX      — customer self-cancel
 *
 * Authenticated endpoints (staff/manager):
 *   GET    /api/merchants/:id/reservations?date=YYYY-MM-DD
 *   GET    /api/merchants/:id/reservations/upcoming
 *   PATCH  /api/merchants/:id/reservations/:resId
 *   DELETE /api/merchants/:id/reservations/:resId
 *
 * Capacity model:
 *   - Each table has an optional `seats` field (default 2 if unset)
 *   - Table groups (combinable tables) are defined in tableLayout.groups
 *   - A slot is available for party size N if there exists a table OR group
 *     with enough seats where all component tables are free in the time window
 *   - Blocking sources: active dine-in orders (same-day) + overlapping reservations
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { generateId } from '../utils/id'
import { serverError } from '../utils/server-error'
import { broadcastToMerchant } from '../services/sse'
import { randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import { getAPIKey } from '../crypto/api-keys'
import { logSecurityEvent } from '../services/security-log'

const reservations = new Hono()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TableObj {
  id: string
  label: string
  seats?: number
}

interface RoomObj {
  id: string
  name: string
  tables: TableObj[]
}

interface GroupObj {
  id: string
  name: string
  tableIds: string[]
  seats: number
}

interface TableLayout {
  rooms: RoomObj[]
  groups?: GroupObj[]
}

interface MerchantConfig {
  id: string
  business_name: string
  timezone: string
  table_layout: string | null
  reservation_enabled: number
  reservation_slot_minutes: number
  reservation_cutoff_minutes: number
  reservation_advance_days: number
  reservation_max_party_size: number
  reservation_start_time: string | null
  address: string | null
  phone_number: string | null
  receipt_email_from: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function nowTimeLocal(tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).format(new Date()).slice(0, 5)
}

/** Day of week (0=Sunday) for a local YYYY-MM-DD string */
function dowForDate(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** Add minutes to HH:MM, returns HH:MM, capped at 23:59 */
function addMinutes(time: string, minutes: number): string {
  if (!/^\d{2}:\d{2}$/.test(time)) return '00:00'
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + minutes
  if (total >= 24 * 60) return '23:59'
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Subtract minutes from HH:MM */
function subMinutes(time: string, minutes: number): string {
  if (!/^\d{2}:\d{2}$/.test(time)) return '00:00'
  const [h, m] = time.split(':').map(Number)
  const total = Math.max(0, h * 60 + m - minutes)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Generate a 6-character alphanumeric confirmation code */
function generateConfirmationCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[randomBytes(1)[0] % chars.length]).join('')
}

/** Parse table_layout JSON, return null on failure */
function parseLayout(json: string | null): TableLayout | null {
  if (!json) return null
  try { return JSON.parse(json) as TableLayout } catch { return null }
}

/** Get all tables across all rooms, with seats defaulting to 2 */
function allTables(layout: TableLayout): Array<TableObj & { seats: number }> {
  if (!Array.isArray(layout.rooms)) return []
  return layout.rooms.flatMap(r =>
    Array.isArray(r.tables) ? r.tables.map(t => ({ ...t, seats: t.seats ?? 2 })) : []
  )
}

/**
 * Determine blocked table IDs for a merchant in a time window.
 * Sources:
 *   1. Active dine-in orders (same-day only) — blocks by table_label
 *   2. Confirmed/seated reservations overlapping [slotTime, slotTime+slotMinutes)
 */
function blockedTableIds(
  db: ReturnType<typeof getDatabase>,
  merchantId: string,
  layout: TableLayout,
  date: string,
  slotTime: string,
  slotMinutes: number,
  excludeResId?: string,
  tz = 'America/Los_Angeles',
): Set<string> {
  const blocked = new Set<string>()
  const tables = allTables(layout)

  // Build label → id map for fast lookup
  const labelToId = new Map<string, string>()
  for (const t of tables) labelToId.set(t.label, t.id)

  // Use merchant local date — UTC date diverges from local near midnight
  const today = todayLocal(tz)

  // 1. Active dine-in orders (same day only — orders don't have an explicit end time)
  if (date === today) {
    const activeOrders = db
      .query<{ table_label: string }, [string]>(
        `SELECT table_label FROM orders
         WHERE merchant_id = ?
           AND order_type = 'dine_in'
           AND table_label IS NOT NULL
           AND status NOT IN ('cancelled','picked_up','completed','pos_error','refunded')`
      )
      .all(merchantId)

    for (const o of activeOrders) {
      const tId = labelToId.get(o.table_label)
      if (tId) blocked.add(tId)
    }
  }

  // 2. Overlapping confirmed/seated reservations
  // A reservation at T' overlaps [slotTime, slotTime+slotMinutes) if:
  //   T' < slotTime+slotMinutes  AND  T'+slotMinutes > slotTime
  // For equal-duration slots this simplifies to:
  //   T' < windowEnd  AND  T' >= slotTime-slotMinutes
  const windowEnd = addMinutes(slotTime, slotMinutes)

  type ResRow = { table_label: string | null; group_id: string | null }
  let query = `
    SELECT table_label, group_id FROM reservations
    WHERE merchant_id = ?
      AND date = ?
      AND status IN ('confirmed','seated')
      AND time < ?
      AND time >= ?`
  const params: string[] = [merchantId, date, windowEnd, subMinutes(slotTime, slotMinutes)]

  if (excludeResId) {
    query += ` AND id != ?`
    params.push(excludeResId)
  }

  const overlapping = db.query<ResRow, string[]>(query).all(...params)

  for (const r of overlapping) {
    if (r.table_label) {
      const tId = labelToId.get(r.table_label)
      if (tId) blocked.add(tId)
    }
    if (r.group_id) {
      const group = layout.groups?.find(g => g.id === r.group_id)
      if (group) group.tableIds.forEach(id => blocked.add(id))
    }
  }

  return blocked
}

/**
 * Find the best available assignment (table or group) for party size N.
 * Returns { type: 'table'|'group', id, label, seats } or null if none.
 */
function findAvailableAssignment(
  layout: TableLayout,
  partySize: number,
  blocked: Set<string>,
): { type: 'table' | 'group'; id: string; label: string; seats: number } | null {
  const tables = allTables(layout)

  // Check individual tables first — prefer smallest that fits (minimize fragmentation)
  const freeTables = tables
    .filter(t => t.seats >= partySize && !blocked.has(t.id))
    .sort((a, b) => a.seats - b.seats)

  if (freeTables.length > 0) {
    const t = freeTables[0]
    return { type: 'table', id: t.id, label: t.label, seats: t.seats }
  }

  // Check table groups — smallest that fits
  const groups = layout.groups ?? []
  const freeGroups = groups
    .filter(g => g.seats >= partySize && g.tableIds.every(id => !blocked.has(id)))
    .sort((a, b) => a.seats - b.seats)

  if (freeGroups.length > 0) {
    const g = freeGroups[0]
    return { type: 'group', id: g.id, label: g.name, seats: g.seats }
  }

  return null
}

/**
 * Generate available time slots for a given date.
 * Returns array of { time: 'HH:MM', available: boolean, remainingCapacity: number }
 */
function buildSlots(
  db: ReturnType<typeof getDatabase>,
  merchantId: string,
  config: MerchantConfig,
  layout: TableLayout | null,
  date: string,
  tz: string,
): Array<{ time: string; available: boolean; remainingCapacity: number }> {
  // Get business hours for this day
  const dow = dowForDate(date)
  const hoursRows = db
    .query<{ open_time: string; close_time: string }, [string, number]>(
      `SELECT open_time, close_time FROM business_hours
       WHERE merchant_id = ? AND service_type = 'regular'
         AND day_of_week = ? AND is_closed = 0
       ORDER BY open_time ASC`
    )
    .all(merchantId, dow)

  if (hoursRows.length === 0) return []

  // Check scheduled closures
  const closure = db
    .query<{ cnt: number }, [string, string, string]>(
      `SELECT COUNT(*) AS cnt FROM scheduled_closures
       WHERE merchant_id = ? AND start_date <= ? AND end_date >= ?`
    )
    .get(merchantId, date, date)

  if ((closure?.cnt ?? 0) > 0) return []

  // Latest close time across all hour segments
  const lastClose = hoursRows[hoursRows.length - 1].close_time
  const firstOpen = hoursRows[0].open_time

  // Cutoff: no new reservations within cutoff_minutes of last close
  const bookingCutoff = subMinutes(lastClose, config.reservation_cutoff_minutes)

  const today = todayLocal(tz)
  const nowTime = nowTimeLocal(tz)
  // Min lead time: 15 min from now (only applies for today)
  const minTime = date === today ? addMinutes(nowTime, 15) : '00:00'
  // Reservation start time: earliest slot allowed regardless of business hours
  const startFloor = config.reservation_start_time ?? '00:00'

  const slots: Array<{ time: string; available: boolean; remainingCapacity: number }> = []

  // 15-min grid from firstOpen to bookingCutoff
  let t = firstOpen
  while (t <= bookingCutoff) {
    if (t >= minTime && t >= startFloor) {
      let available = false
      let remaining = 0

      if (layout) {
        const blocked = blockedTableIds(
          db, merchantId, layout, date, t, config.reservation_slot_minutes, undefined, tz
        )
        // Compute remaining capacity = sum of seats on free tables + groups (de-dup group tables)
        const tables = allTables(layout)
        const freeTableIds = new Set(tables.filter(t2 => !blocked.has(t2.id)).map(t2 => t2.id))
        let freeCap = tables.filter(t2 => freeTableIds.has(t2.id)).reduce((s, t2) => s + t2.seats, 0)

        // Subtract group-claimed tables from individual count to avoid double-counting
        // (groups represent specific combos — their tables should not be counted separately)
        for (const g of layout.groups ?? []) {
          if (g.tableIds.every(id => freeTableIds.has(id))) {
            // Group is fully free — don't subtract, it's additional capacity through combination
          }
        }

        remaining = freeCap
        available = findAvailableAssignment(layout, 1, blocked) !== null
      } else {
        // No layout configured — allow all slots (staff assigns manually)
        available = true
        remaining = 99
      }

      slots.push({ time: t, available, remainingCapacity: remaining })
    }
    t = addMinutes(t, 15)
  }

  return slots
}

// ---------------------------------------------------------------------------
// Rate limiter (in-memory, per-IP)
// ---------------------------------------------------------------------------

const _rateMap = new Map<string, { count: number; resetAt: number }>()

function rateLimitOk(ip: string): boolean {
  const now = Date.now()
  const entry = _rateMap.get(ip)
  if (!entry || now > entry.resetAt) {
    _rateMap.set(ip, { count: 1, resetAt: now + 10 * 60_000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  // Prune expired entries when the map grows large (mirrors login/PIN rate limiters)
  if (_rateMap.size > 500) {
    const now2 = Date.now()
    for (const [k, v] of _rateMap) if (now2 > v.resetAt) _rateMap.delete(k)
  }
  return true
}

// ---------------------------------------------------------------------------
// Load appliance merchant config (same pattern as store.ts)
// ---------------------------------------------------------------------------

function getApplianceMerchantConfig(db: ReturnType<typeof getDatabase>): MerchantConfig | null {
  return db
    .query<MerchantConfig, []>(
      `SELECT id, business_name, timezone,
              table_layout, reservation_enabled, reservation_slot_minutes,
              reservation_cutoff_minutes, reservation_advance_days,
              reservation_max_party_size, reservation_start_time,
              address, phone_number, receipt_email_from
       FROM merchants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`
    )
    .get() ?? null
}

// ---------------------------------------------------------------------------
// Reservation confirmation email + .ics calendar invite
// ---------------------------------------------------------------------------

/** Format HH:MM (24h) to 12h display string for email body */
function fmtTime12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`
}

/** Format YYYY-MM-DD to display string */
function fmtDateDisplay(iso: string): string {
  const [y, mo, d] = iso.split('-').map(Number)
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
}

/** Build an iCalendar (.ics) string for the reservation */
function buildIcs(opts: {
  uid: string
  dtstart: string   // YYYYMMDDTHHmmss (local, no Z)
  dtend: string     // YYYYMMDDTHHmmss (local, no Z)
  tzid: string
  summary: string
  description: string
  location: string
}): string {
  const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kizo POS//Reservation//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=${opts.tzid}:${opts.dtstart}`,
    `DTEND;TZID=${opts.tzid}:${opts.dtend}`,
    `SUMMARY:${opts.summary}`,
    `DESCRIPTION:${opts.description.replace(/\n/g, '\\n')}`,
    `LOCATION:${opts.location}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reservation reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
}

/** HTML-escape a string for safe interpolation into an email body. */
function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Send confirmation email with .ics attachment. Silently no-ops if SMTP not configured. */
async function sendReservationConfirmation(
  m: MerchantConfig,
  opts: {
    reservationId: string
    confirmationCode: string
    customerName: string
    customerEmail: string
    partySize: number
    date: string
    time: string
    notes: string | null
  },
): Promise<void> {
  if (!m.receipt_email_from) return

  const appPassword = await getAPIKey(m.id, 'email', 'gmail').catch(() => null)
  if (!appPassword) return

  const tz = m.timezone || 'America/Los_Angeles'
  const displayDate = fmtDateDisplay(opts.date)
  const displayTime = fmtTime12(opts.time)
  const locationStr = m.address ?? m.business_name

  // Build .ics — slot duration is 1.5 hours for calendar block
  const [y, mo, d] = opts.date.split('-').map(Number)
  const [h, min] = opts.time.split(':').map(Number)
  const dtstart = `${String(y)}${String(mo).padStart(2,'0')}${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}${String(min).padStart(2,'0')}00`
  const endH = h + 1, endMin = min + 30
  const endHAdj = endH + Math.floor(endMin / 60)
  const endMinAdj = endMin % 60
  const dtend = `${String(y)}${String(mo).padStart(2,'0')}${String(d).padStart(2,'0')}T${String(endHAdj).padStart(2,'0')}${String(endMinAdj).padStart(2,'0')}00`

  const partyWord = opts.partySize === 1 ? '1 guest' : `${opts.partySize} guests`
  const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
  const icsDesc = `Reservation at ${icsEsc(m.business_name)}\\nDate: ${displayDate} at ${displayTime}\\nParty: ${partyWord}\\nConfirmation code: ${opts.confirmationCode}${opts.notes ? `\\nNotes: ${icsEsc(opts.notes)}` : ''}${m.phone_number ? `\\n\\nQuestions? Call us at ${m.phone_number}` : ''}`

  const ics = buildIcs({
    uid: `${opts.reservationId}@kizo`,
    dtstart,
    dtend,
    tzid: tz,
    summary: `Reservation at ${m.business_name}`,
    description: icsDesc,
    location: locationStr,
  })

  const smtpName = m.business_name.replace(/[\r\n"]+/g, c => c === '"' ? "'" : ' ')
  const bodyHtml = `
<!DOCTYPE html><html><body style="font-family:sans-serif;color:#222;max-width:520px;margin:0 auto;padding:24px">
<h2 style="margin-bottom:4px">Reservation Confirmed!</h2>
<p style="color:#555;margin-top:0">We look forward to seeing you.</p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
  <tr><td style="padding:8px 0;color:#555;width:40%">Date</td><td style="padding:8px 0;font-weight:600">${displayDate}</td></tr>
  <tr><td style="padding:8px 0;color:#555">Time</td><td style="padding:8px 0;font-weight:600">${displayTime}</td></tr>
  <tr><td style="padding:8px 0;color:#555">Party size</td><td style="padding:8px 0;font-weight:600">${partyWord}</td></tr>
  ${m.address ? `<tr><td style="padding:8px 0;color:#555">Location</td><td style="padding:8px 0">${esc(m.address)}</td></tr>` : ''}
  <tr><td style="padding:8px 0;color:#555">Confirmation</td><td style="padding:8px 0;font-family:monospace;font-size:1.1em;letter-spacing:0.1em;font-weight:700">${opts.confirmationCode}</td></tr>
</table>
${opts.notes ? `<p style="font-size:0.9em;color:#555">Your note: ${esc(opts.notes)}</p>` : ''}
<p style="font-size:0.85em;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px">We hold your table for 15 minutes. Please call us if you're running late or need to cancel.${m.phone_number ? ` Call ${esc(m.phone_number)}.` : ''}</p>
<p style="font-size:0.85em;color:#aaa">A calendar invite is attached to this email.</p>
</body></html>`

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: m.receipt_email_from, pass: appPassword },
  })

  await transporter.sendMail({
    from: `"${smtpName}" <${m.receipt_email_from}>`,
    to: opts.customerEmail,
    subject: `Reservation confirmed – ${displayDate} at ${displayTime}`,
    html: bodyHtml,
    attachments: [
      {
        filename: 'reservation.ics',
        content: ics,
        contentType: 'text/calendar; method=REQUEST',
      },
    ],
  })
}

// ===========================================================================
// PUBLIC ENDPOINTS
// ===========================================================================

/**
 * GET /api/store/reservations/config
 * Returns reservation settings for the appliance merchant.
 */
reservations.get('/api/store/reservations/config', (c) => {
  const db = getDatabase()
  const m = getApplianceMerchantConfig(db)
  if (!m) return c.json({ error: 'Merchant not found' }, 404)

  return c.json({
    enabled: m.reservation_enabled === 1,
    maxPartySize: m.reservation_max_party_size,
    advanceDays: m.reservation_advance_days,
    cutoffMinutes: m.reservation_cutoff_minutes,
    slotMinutes: m.reservation_slot_minutes,
    startTime: m.reservation_start_time ?? null,
  })
})

/**
 * GET /api/store/reservations/slots?date=YYYY-MM-DD
 * Returns available time slots for the given date.
 */
reservations.get('/api/store/reservations/slots', (c) => {
  const dateParam = c.req.query('date')
  if (!dateParam || !DATE_RE.test(dateParam)) {
    return c.json({ error: 'date is required (YYYY-MM-DD)' }, 400)
  }

  const db = getDatabase()
  const m = getApplianceMerchantConfig(db)
  if (!m) return c.json({ error: 'Merchant not found' }, 404)
  if (!m.reservation_enabled) return c.json({ error: 'Reservations not enabled' }, 403)

  const tz = m.timezone || 'America/Los_Angeles'
  const today = todayLocal(tz)
  const maxDate = addMinutes('00:00', 0) // just use date comparison

  // Validate date range
  if (dateParam < today) return c.json({ slots: [] })

  // Check advance days limit
  const limit = new Date(today)
  limit.setDate(limit.getDate() + m.reservation_advance_days)
  const limitStr = limit.toISOString().slice(0, 10)
  if (dateParam > limitStr) return c.json({ slots: [] })

  const layout = parseLayout(m.table_layout)
  const slots = buildSlots(db, m.id, m, layout, dateParam, tz)

  return c.json({ date: dateParam, slots })
})

/**
 * POST /api/store/reservations
 * Create a new reservation (customer-facing).
 */
reservations.post('/api/store/reservations', async (c) => {
  const ip = (c.get('ipAddress') as string | undefined) ?? 'unknown'
  if (!rateLimitOk(ip)) {
    return c.json({ error: 'Too many requests. Please try again in 10 minutes.' }, 429)
  }

  const db = getDatabase()
  const m = getApplianceMerchantConfig(db)
  if (!m) return c.json({ error: 'Merchant not found' }, 404)
  if (!m.reservation_enabled) return c.json({ error: 'Reservations not enabled' }, 403)

  const tz = m.timezone || 'America/Los_Angeles'

  let body: any
  try { body = await c.req.json() } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { customerName, customerPhone, customerEmail, partySize, date, time, notes, _hp } = body

  // Honeypot check — bots fill hidden fields; return a fake success so they get no signal
  if (_hp && String(_hp).length > 0) {
    const fakeCode = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')
    return c.json({ reservationId: 'fake', confirmationCode: fakeCode }, 201)
  }

  // Validate required fields
  if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
    return c.json({ error: 'customerName is required' }, 400)
  }
  if (!customerPhone && !customerEmail) {
    return c.json({ error: 'At least one of customerPhone or customerEmail is required' }, 400)
  }
  if (notes && notes.length > 500) {
    return c.json({ error: 'notes must be 500 characters or fewer' }, 400)
  }
  if (customerPhone) {
    const digits = String(customerPhone).replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) {
      return c.json({ error: 'customerPhone must be a valid phone number' }, 400)
    }
  }
  if (customerEmail && !/.+@.+\..+/.test(String(customerEmail))) {
    return c.json({ error: 'customerEmail must be a valid email address' }, 400)
  }
  if (!date || !DATE_RE.test(date)) {
    return c.json({ error: 'date must be YYYY-MM-DD' }, 400)
  }
  if (!time || !TIME_RE.test(time)) {
    return c.json({ error: 'time must be HH:MM' }, 400)
  }

  const ps = Number(partySize)
  if (!Number.isInteger(ps) || ps < 1) {
    return c.json({ error: 'partySize must be a positive integer' }, 400)
  }
  if (ps >= m.reservation_max_party_size) {
    return c.json({
      error: `For parties of ${m.reservation_max_party_size} or more, please call us directly.`,
      pleaseCall: true,
    }, 422)
  }

  // Date range check
  const today = todayLocal(tz)
  if (date < today) return c.json({ error: 'Cannot book in the past' }, 400)
  const limit = new Date(today)
  limit.setDate(limit.getDate() + m.reservation_advance_days)
  if (date > limit.toISOString().slice(0, 10)) {
    return c.json({ error: `Reservations only accepted up to ${m.reservation_advance_days} days in advance` }, 400)
  }

  // Re-validate this slot is still available
  const layout = parseLayout(m.table_layout)
  const slots = buildSlots(db, m.id, m, layout, date, tz)
  const slot = slots.find(s => s.time === time)
  if (!slot) return c.json({ error: 'Requested time is not available for this date' }, 409)
  if (!slot.available) return c.json({ error: 'This time slot is no longer available' }, 409)

  // Find best table/group assignment
  let assignedTableLabel: string | null = null
  let assignedGroupId: string | null = null

  if (layout) {
    const blocked = blockedTableIds(db, m.id, layout, date, time, m.reservation_slot_minutes, undefined, tz)
    const assignment = findAvailableAssignment(layout, ps, blocked)
    if (!assignment) return c.json({ error: 'No table available for this party size at this time' }, 409)
    if (assignment.type === 'table') assignedTableLabel = assignment.label
    else assignedGroupId = assignment.id
  }

  const id = generateId('res')
  const confirmationCode = generateConfirmationCode()

  db.run(
    `INSERT INTO reservations
       (id, merchant_id, customer_name, customer_phone, customer_email,
        party_size, date, time, table_label, group_id, notes, confirmation_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, m.id, customerName.trim(), customerPhone?.trim() ?? null,
      customerEmail?.trim() ?? null, ps, date, time,
      assignedTableLabel, assignedGroupId, notes?.trim() ?? null, confirmationCode,
    ]
  )

  // Notify dashboard via SSE
  broadcastToMerchant(m.id, 'reservation_new', {
    reservationId: id,
    customerName: customerName.trim(),
    partySize: ps,
    date,
    time,
    tableLabel: assignedTableLabel,
  })

  console.log(`[reservations] New reservation ${id} for ${customerName.trim()}, party ${ps}, ${date} ${time}`)

  // Send confirmation email with calendar invite (fire-and-forget, silent on error)
  if (customerEmail?.trim()) {
    sendReservationConfirmation(m, {
      reservationId: id,
      confirmationCode,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim(),
      partySize: ps,
      date,
      time,
      notes: notes?.trim() ?? null,
    }).catch(err => console.warn('[reservations] Email send failed:', err))
  }

  return c.json({ reservationId: id, confirmationCode }, 201)
})

/**
 * DELETE /api/store/reservations/:id?code=XXXXXX
 * Customer self-cancel using their confirmation code.
 */
reservations.delete('/api/store/reservations/:id', async (c) => {
  const ip = (c.get('ipAddress') as string | undefined) ?? 'unknown'
  if (!rateLimitOk(ip)) {
    return c.json({ error: 'Too many requests. Please try again in 10 minutes.' }, 429)
  }

  const resId = c.req.param('id')
  const code = c.req.query('code')

  if (!code) return c.json({ error: 'Confirmation code required' }, 400)

  const db = getDatabase()
  const m = getApplianceMerchantConfig(db)
  if (!m) return c.json({ error: 'Merchant not found' }, 404)

  const res = db
    .query<{ id: string; status: string; confirmation_code: string; date: string }, [string]>(
      `SELECT id, status, confirmation_code, date FROM reservations WHERE id = ?`
    )
    .get(resId)

  if (!res) return c.json({ error: 'Reservation not found' }, 404)
  if (res.confirmation_code !== code.toUpperCase()) {
    logSecurityEvent({
      type: 'invalid_confirmation_code',
      severity: 'warning',
      ip,
      detail: `reservation ${resId}`,
    })
    return c.json({ error: 'Invalid confirmation code' }, 403)
  }
  if (res.status === 'cancelled') return c.json({ error: 'Reservation already cancelled' }, 409)
  if (res.status === 'seated') return c.json({ error: 'Cannot cancel a seated reservation' }, 409)

  db.run(
    `UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
    [resId]
  )

  broadcastToMerchant(m.id, 'reservation_updated', { reservationId: resId, status: 'cancelled' })

  return c.json({ success: true })
})

// ===========================================================================
// AUTHENTICATED ENDPOINTS
// ===========================================================================

/**
 * GET /api/merchants/:id/reservations?date=YYYY-MM-DD
 * List reservations for a date (defaults to today).
 */
reservations.get(
  '/api/merchants/:id/reservations',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const db = getDatabase()

      const m = db
        .query<{ timezone: string }, [string]>(`SELECT timezone FROM merchants WHERE id = ?`)
        .get(merchantId)
      const tz = m?.timezone ?? 'America/Los_Angeles'

      const date = c.req.query('date') ?? todayLocal(tz)

      type ResRow = {
        id: string; customer_name: string; customer_phone: string | null
        customer_email: string | null; party_size: number; date: string; time: string
        status: string; table_label: string | null; group_id: string | null
        notes: string | null; confirmation_code: string; created_at: string
      }

      const rows = db
        .query<ResRow, [string, string]>(
          `SELECT id, customer_name, customer_phone, customer_email,
                  party_size, date, time, status, table_label, group_id,
                  notes, confirmation_code, created_at
           FROM reservations
           WHERE merchant_id = ? AND date = ?
           ORDER BY time ASC, created_at ASC`
        )
        .all(merchantId, date)

      return c.json({ date, reservations: rows.map(r => ({
        id: r.id,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        customerEmail: r.customer_email,
        partySize: r.party_size,
        date: r.date,
        time: r.time,
        status: r.status,
        tableLabel: r.table_label,
        groupId: r.group_id,
        notes: r.notes,
        confirmationCode: r.confirmation_code,
        createdAt: r.created_at,
      })) })
    } catch (err) {
      return serverError(c, '[reservations] GET list', err, 'Failed to list reservations')
    }
  }
)

/**
 * GET /api/merchants/:id/reservations/upcoming
 * Reservations in the next 60 minutes (for dashboard alert strip).
 */
reservations.get(
  '/api/merchants/:id/reservations/upcoming',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const db = getDatabase()

      const m = db
        .query<{ timezone: string }, [string]>(`SELECT timezone FROM merchants WHERE id = ?`)
        .get(merchantId)
      const tz = m?.timezone ?? 'America/Los_Angeles'

      const today = todayLocal(tz)
      const nowTime = nowTimeLocal(tz)
      const inSixty = addMinutes(nowTime, 60)

      type ResRow = {
        id: string; customer_name: string; party_size: number
        time: string; status: string; table_label: string | null; group_id: string | null
      }

      const rows = db
        .query<ResRow, [string, string, string, string]>(
          `SELECT id, customer_name, party_size, time, status, table_label, group_id
           FROM reservations
           WHERE merchant_id = ? AND date = ?
             AND time >= ? AND time <= ?
             AND status IN ('confirmed','seated')
           ORDER BY time ASC`
        )
        .all(merchantId, today, nowTime, inSixty)

      return c.json({ reservations: rows.map(r => ({
        id: r.id,
        customerName: r.customer_name,
        partySize: r.party_size,
        time: r.time,
        status: r.status,
        tableLabel: r.table_label,
        groupId: r.group_id,
        minutesUntil: (() => {
          const [h, min] = r.time.split(':').map(Number)
          const [nh, nm] = nowTime.split(':').map(Number)
          return (h * 60 + min) - (nh * 60 + nm)
        })(),
      })) })
    } catch (err) {
      return serverError(c, '[reservations] GET upcoming', err, 'Failed to list upcoming reservations')
    }
  }
)

/**
 * POST /api/merchants/:id/reservations
 * Staff-created reservation — bypasses slot availability check.
 * Allows booking outside normal hours or for parties over max size.
 */
reservations.post(
  '/api/merchants/:id/reservations',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const db = getDatabase()

      let body: any
      try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

      const { customerName, customerPhone, customerEmail, partySize, date, time, tableLabel, notes } = body

      if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
        return c.json({ error: 'customerName is required' }, 400)
      }
      if (!date || !DATE_RE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400)
      if (!time || !TIME_RE.test(time)) return c.json({ error: 'time must be HH:MM' }, 400)

      const ps = Number(partySize)
      if (!Number.isInteger(ps) || ps < 1) return c.json({ error: 'partySize must be a positive integer' }, 400)

      const id = generateId('res')
      const confirmationCode = generateConfirmationCode()

      db.run(
        `INSERT INTO reservations
           (id, merchant_id, customer_name, customer_phone, customer_email,
            party_size, date, time, table_label, notes, confirmation_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, merchantId, customerName.trim(), customerPhone?.trim() ?? null,
          customerEmail?.trim() ?? null, ps, date, time,
          tableLabel || null, notes?.trim() ?? null, confirmationCode,
        ]
      )

      broadcastToMerchant(merchantId, 'reservation_new', {
        reservationId: id, customerName: customerName.trim(), partySize: ps, date, time,
      })

      return c.json({ reservationId: id, confirmationCode }, 201)
    } catch (err) {
      return serverError(c, '[reservations] POST', err, 'Failed to create reservation')
    }
  }
)

/**
 * PATCH /api/merchants/:id/reservations/:resId
 * Update reservation: status, tableLabel, groupId, notes
 */
reservations.patch(
  '/api/merchants/:id/reservations/:resId',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const resId = c.req.param('resId')
      const db = getDatabase()

      const existing = db
        .query<{ id: string; status: string }, [string, string]>(
          `SELECT id, status FROM reservations WHERE id = ? AND merchant_id = ?`
        )
        .get(resId, merchantId)

      if (!existing) return c.json({ error: 'Reservation not found' }, 404)

      let body: any
      try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

      const updates: string[] = []
      const values: any[] = []

      if (body.status !== undefined) {
        const VALID = ['confirmed', 'seated', 'cancelled', 'no_show']
        if (!VALID.includes(body.status)) return c.json({ error: 'Invalid status' }, 400)
        updates.push('status = ?')
        values.push(body.status)
      }
      if (body.customerName !== undefined) {
        const n = String(body.customerName).trim()
        if (!n) return c.json({ error: 'customerName cannot be empty' }, 400)
        updates.push('customer_name = ?')
        values.push(n)
      }
      if (body.customerPhone !== undefined) {
        updates.push('customer_phone = ?')
        values.push(body.customerPhone || null)
      }
      if (body.customerEmail !== undefined) {
        updates.push('customer_email = ?')
        values.push(body.customerEmail || null)
      }
      if (body.date !== undefined) {
        if (!DATE_RE.test(body.date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400)
        updates.push('date = ?')
        values.push(body.date)
      }
      if (body.time !== undefined) {
        if (!TIME_RE.test(body.time)) return c.json({ error: 'time must be HH:MM' }, 400)
        updates.push('time = ?')
        values.push(body.time)
      }
      if (body.partySize !== undefined) {
        const ps = Number(body.partySize)
        if (!Number.isInteger(ps) || ps < 1) return c.json({ error: 'partySize must be a positive integer' }, 400)
        updates.push('party_size = ?')
        values.push(ps)
      }
      if (body.tableLabel !== undefined) {
        updates.push('table_label = ?')
        values.push(body.tableLabel || null)
      }
      if (body.groupId !== undefined) {
        updates.push('group_id = ?')
        values.push(body.groupId || null)
      }
      if (body.notes !== undefined) {
        updates.push('notes = ?')
        values.push(body.notes || null)
      }

      if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400)

      updates.push('updated_at = datetime(\'now\')')
      values.push(resId, merchantId)

      db.run(
        `UPDATE reservations SET ${updates.join(', ')} WHERE id = ? AND merchant_id = ?`,
        values
      )

      broadcastToMerchant(merchantId, 'reservation_updated', {
        reservationId: resId,
        status: body.status,
        tableLabel: body.tableLabel,
      })

      return c.json({ success: true })
    } catch (err) {
      return serverError(c, '[reservations] PATCH', err, 'Failed to update reservation')
    }
  }
)

/**
 * DELETE /api/merchants/:id/reservations/:resId
 * Staff cancel (manager/owner only — or any authenticated staff).
 */
reservations.delete(
  '/api/merchants/:id/reservations/:resId',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const resId = c.req.param('resId')
      const db = getDatabase()

      const existing = db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM reservations WHERE id = ? AND merchant_id = ?`
        )
        .get(resId, merchantId)

      if (!existing) return c.json({ error: 'Reservation not found' }, 404)

      db.run(
        `UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND merchant_id = ?`,
        [resId, merchantId]
      )

      broadcastToMerchant(merchantId, 'reservation_updated', { reservationId: resId, status: 'cancelled' })

      return c.json({ success: true })
    } catch (err) {
      return serverError(c, '[reservations] DELETE', err, 'Failed to cancel reservation')
    }
  }
)

export { reservations }
