/**
 * Employee management routes
 *
 * GET    /api/merchants/:id/employees                       — list active + inactive employees
 * POST   /api/merchants/:id/employees                       — create employee with hashed PIN
 * PUT    /api/merchants/:id/employees/:empId                — update employee fields
 * DELETE /api/merchants/:id/employees/:empId                — hard-delete employee record
 * POST   /api/merchants/:id/employees/authenticate          — verify 4-digit PIN (rate-limited)
 * POST   /api/merchants/:id/employees/:empId/clock-in       — open a new timesheet shift
 * POST   /api/merchants/:id/employees/:empId/clock-out      — close the open shift, record tip
 * GET    /api/merchants/:id/timesheets                      — list shifts for a date range
 * GET    /api/merchants/:id/employees/:empId/sales          — employee sales totals (today + 14d)
 *
 * PIN security:
 *   PINs are SHA-256 hashed before storage — never stored in plaintext.
 *   Rate limiting: max {@link PIN_MAX_ATTEMPTS} failures per IP per 10 min (IP-based) and
 *   max {@link PIN_HASH_MAX_FAILURES} failures per PIN hash per 30 min (hash-based lockout),
 *   preventing distributed brute-force against a known employee's PIN.
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { authenticate, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import {
  hashCode,
  recordFailedPin,
  recordFailedPinHash,
  isPinHashLocked,
  isIpLocked,
  clearIpAttempts,
  clearPinHashFailures,
  getRequestIp,
} from '../services/pin-auth'

// Re-export for callers that previously imported from this route module.
export { hashCode } from '../services/pin-auth'

const employees = new Hono()

// PIN rate-limit state and helpers live in src/services/pin-auth.ts so the
// payment-modal pause + writeoff endpoints can apply the same protection.

/**
 * GET /api/merchants/:id/employees
 *
 * Returns all employees belonging to the merchant, both active and inactive.
 *
 * @returns `{ employees: Employee[] }` — sorted by nickname ascending
 */
employees.get(
  '/api/merchants/:id/employees',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const db = getDatabase()

    const rows = db
      .query<{
        id: string
        nickname: string
        role: string
        language: string
        schedule: string | null
        active: number
        created_at: string
      }, [string]>(
        `SELECT id, nickname, role, language, schedule, active, created_at
         FROM employees WHERE merchant_id = ? ORDER BY nickname ASC`
      )
      .all(merchantId)

    return c.json({
      employees: rows.map((e) => ({
        id: e.id,
        nickname: e.nickname,
        role: e.role,
        language: e.language ?? 'en',
        schedule: e.schedule ? JSON.parse(e.schedule) : null,
        active: e.active === 1,
        createdAt: e.created_at,
      })),
    })
  }
)

/**
 * POST /api/merchants/:id/employees
 *
 * Creates a new employee. The `accessCode` PIN is SHA-256 hashed before
 * storage — the plaintext never persists.
 *
 * @param body.nickname - Display name
 * @param body.accessCode - 4-digit PIN
 * @param body.role - `'owner' | 'manager' | 'staff'`
 * @param body.schedule - Optional weekly schedule object
 * @returns `{ id, nickname, role, createdAt }`
 */
employees.post(
  '/api/merchants/:id/employees',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const body = await c.req.json<{
      nickname: string
      accessCode: string
      role: string
      language?: string
      schedule?: Record<string, { start: string; end: string } | null>
    }>()

    if (!body.nickname?.trim()) {
      return c.json({ error: 'nickname is required' }, 400)
    }
    if (body.nickname.trim().length > 64) {
      return c.json({ error: 'nickname must be 64 characters or fewer' }, 400)
    }
    if (!/^\d{4}$/.test(body.accessCode)) {
      return c.json({ error: 'accessCode must be exactly 4 digits' }, 400)
    }
    if (!['server', 'chef', 'manager'].includes(body.role)) {
      return c.json({ error: 'role must be server, chef, or manager' }, 400)
    }
    const language = body.language === 'es' ? 'es' : 'en'

    const db = getDatabase()
    const codeHash = hashCode(merchantId, body.accessCode)

    // Ensure code is unique within this merchant
    const existing = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM employees WHERE merchant_id = ? AND access_code_hash = ?`
      )
      .get(merchantId, codeHash)

    if (existing) {
      return c.json({ error: 'That access code is already in use by another employee' }, 409)
    }

    const empId = generateId('emp')

    db.run(
      `INSERT INTO employees (id, merchant_id, nickname, access_code_hash, role, language, schedule, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
      [
        empId,
        merchantId,
        body.nickname.trim(),
        codeHash,
        body.role,
        language,
        body.schedule ? JSON.stringify(body.schedule) : null,
      ]
    )

    return c.json({ id: empId, nickname: body.nickname.trim(), role: body.role, language }, 201)
  }
)

/**
 * PUT /api/merchants/:id/employees/:empId
 *
 * Updates an employee's fields. All fields are optional; only supplied
 * keys are patched. If `accessCode` is provided it is re-hashed.
 * Setting `active: false` effectively deactivates the employee.
 *
 * @param body.nickname - New display name
 * @param body.accessCode - New 4-digit PIN (re-hashed on update)
 * @param body.role - `'owner' | 'manager' | 'staff'`
 * @param body.schedule - Weekly availability object
 * @param body.active - `false` to deactivate
 */
employees.put(
  '/api/merchants/:id/employees/:empId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const empId = c.req.param('empId')!
    const db = getDatabase()

    const emp = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM employees WHERE id = ? AND merchant_id = ?`
      )
      .get(empId, merchantId)

    if (!emp) return c.json({ error: 'Employee not found' }, 404)

    const body = await c.req.json<{
      nickname?: string
      accessCode?: string
      role?: string
      language?: string
      schedule?: Record<string, { start: string; end: string } | null>
      active?: boolean
    }>()

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (body.nickname !== undefined) {
      if (body.nickname.trim().length === 0) {
        return c.json({ error: 'nickname is required' }, 400)
      }
      if (body.nickname.trim().length > 64) {
        return c.json({ error: 'nickname must be 64 characters or fewer' }, 400)
      }
      updates.push('nickname = ?')
      values.push(body.nickname.trim())
    }
    if (body.accessCode !== undefined) {
      if (!/^\d{4}$/.test(body.accessCode)) {
        return c.json({ error: 'accessCode must be exactly 4 digits' }, 400)
      }
      const codeHash = hashCode(merchantId, body.accessCode)
      // Ensure code is unique (exclude current employee)
      const conflict = db
        .query<{ id: string }, [string, string, string]>(
          `SELECT id FROM employees WHERE merchant_id = ? AND access_code_hash = ? AND id != ?`
        )
        .get(merchantId, codeHash, empId)
      if (conflict) {
        return c.json({ error: 'That access code is already in use by another employee' }, 409)
      }
      updates.push('access_code_hash = ?')
      values.push(codeHash)
    }
    if (body.role !== undefined) {
      if (!['server', 'chef', 'manager'].includes(body.role)) {
        return c.json({ error: 'role must be server, chef, or manager' }, 400)
      }
      updates.push('role = ?')
      values.push(body.role)
    }
    if (body.language !== undefined) {
      updates.push('language = ?')
      values.push(body.language === 'es' ? 'es' : 'en')
    }
    if (body.schedule !== undefined) {
      updates.push('schedule = ?')
      values.push(body.schedule === null ? null : JSON.stringify(body.schedule))
    }
    if (body.active !== undefined) {
      updates.push('active = ?')
      values.push(body.active ? 1 : 0)
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400)
    }

    updates.push("updated_at = datetime('now')")
    values.push(empId)

    // SECURITY (M-05): All SET field names above are hardcoded string literals —
    // never interpolate user-controlled strings into this template.
    db.run(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, values)

    return c.json({ ok: true })
  }
)

/**
 * DELETE /api/merchants/:id/employees/:empId
 *
 * Hard-deletes the employee record from the database. Owner-only.
 *
 * @returns `{ ok: true }`
 * @throws 404 if the employee does not belong to this merchant
 */
employees.delete(
  '/api/merchants/:id/employees/:empId',
  authenticate,
  requireRole('owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const empId = c.req.param('empId')!
    const db = getDatabase()

    const emp = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM employees WHERE id = ? AND merchant_id = ?`
      )
      .get(empId, merchantId)

    if (!emp) return c.json({ error: 'Employee not found' }, 404)

    db.run(`DELETE FROM employees WHERE id = ?`, [empId])

    return c.json({ ok: true })
  }
)

/**
 * POST /api/merchants/:id/employees/authenticate
 *
 * Verifies a 4-digit employee PIN and returns the matching active employee.
 * Employee mode is a UI-layer concept — the request still requires a valid
 * admin JWT; this endpoint just maps a PIN to a staff identity for UX purposes
 * (e.g. "which server is clocking in?").
 *
 * Rate limited: {@link PIN_MAX_ATTEMPTS} failures per IP per 10 min; also
 * {@link PIN_HASH_MAX_FAILURES} failures per specific PIN hash per 30 min.
 * Returns 429 on lockout.
 *
 * @param body.code - 4-digit PIN string
 * @returns `{ employee: { id, nickname, role } }`
 * @throws 401 if no active employee matches; 429 on rate-limit lockout
 */
employees.post(
  '/api/merchants/:id/employees/authenticate',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!

    // Rate-limit PIN attempts per source IP. The IP can be null on local LAN
    // (no cf-connecting-ip / x-forwarded-for); the per-PIN-hash lockout below
    // is the safety net in that case.
    const ip = getRequestIp({
      cfConnectingIp: c.req.header('cf-connecting-ip') ?? null,
      xForwardedFor:  c.req.header('x-forwarded-for') ?? null,
    })
    if (ip !== null && isIpLocked(ip)) {
      return c.json({ error: 'Too many PIN attempts. Try again in 10 minutes.' }, 429)
    }

    const body = await c.req.json<{ code: string }>()

    if (!/^\d{4}$/.test(body.code)) {
      return c.json({ error: 'Invalid code' }, 400)
    }

    const db = getDatabase()
    const codeHash = hashCode(merchantId, body.code)

    // Check per-PIN-hash lockout (M-02: per-employee lockout after 3 failures)
    if (isPinHashLocked(merchantId, codeHash)) {
      return c.json({ error: 'PIN locked due to too many failed attempts. Try again in 30 minutes.' }, 429)
    }

    const emp = db
      .query<{
        id: string
        nickname: string
        role: string
        language: string
        schedule: string | null
      }, [string, string]>(
        `SELECT id, nickname, role, language, schedule
         FROM employees WHERE merchant_id = ? AND access_code_hash = ? AND active = 1`
      )
      .get(merchantId, codeHash)

    if (!emp) {
      recordFailedPin(ip)
      recordFailedPinHash(merchantId, codeHash)
      return c.json({ error: 'Invalid code or employee inactive' }, 401)
    }

    // Successful — clear failed attempt counters
    clearIpAttempts(ip)
    clearPinHashFailures(merchantId, codeHash)

    // Check if employee has any open shift (no clock-out), regardless of date
    const openShift = db
      .query<{ id: string; clock_in: string }, [string]>(
        `SELECT id, clock_in FROM timesheets
         WHERE employee_id = ? AND clock_out IS NULL
         ORDER BY clock_in DESC LIMIT 1`
      )
      .get(emp.id)

    return c.json({
      employee: {
        id: emp.id,
        nickname: emp.nickname,
        role: emp.role,
        language: emp.language ?? 'en',
        schedule: emp.schedule ? JSON.parse(emp.schedule) : null,
      },
      clockedIn: openShift !== null,
      openShiftId: openShift?.id ?? null,
    })
  }
)

/**
 * POST /api/merchants/:id/employees/:empId/clock-in
 *
 * Opens a new timesheet shift for the employee. Returns 409 if the
 * employee already has an open (unclosed) shift for today.
 *
 * @returns `{ shiftId: string, clockIn: string }` (ISO timestamp)
 */
employees.post(
  '/api/merchants/:id/employees/:empId/clock-in',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const empId = c.req.param('empId')!
    const db = getDatabase()

    const emp = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM employees WHERE id = ? AND merchant_id = ? AND active = 1`
      )
      .get(empId, merchantId)

    if (!emp) return c.json({ error: 'Employee not found' }, 404)

    // Local date in the process timezone (appliance runs in PDT)
    const nowDate = new Date()
    const today = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`

    // Check for any open shift (no clock-out), regardless of date
    const existing = db
      .query<{ id: string; date: string; schedule: string | null }, [string]>(
        `SELECT ts.id, ts.date, e.schedule
         FROM timesheets ts
         JOIN employees e ON e.id = ts.employee_id
         WHERE ts.employee_id = ? AND ts.clock_out IS NULL
         ORDER BY ts.clock_in DESC LIMIT 1`
      )
      .get(empId)

    if (existing) {
      if (existing.date >= today) {
        // Genuinely clocked in today — block the request
        return c.json({ error: 'Already clocked in', shiftId: existing.id }, 409)
      }

      // Stale open shift from a previous day — auto-close it at its scheduled end
      // before opening today's shift. This handles the case where an employee forgot
      // to clock out and the auto-clockout service hasn't run yet.
      let scheduledEnd: string | null = null
      if (existing.schedule) {
        try {
          const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
          const weekly = JSON.parse(existing.schedule) as Record<string, { start: string; end: string } | null>
          const [y, mo, d] = existing.date.split('-').map(Number)
          const dowKey = DOW[new Date(y, mo - 1, d).getDay()]
          const daySchedule = weekly[dowKey]
          if (daySchedule?.end) {
            scheduledEnd = daySchedule.end
            const endDate = new Date(y, mo - 1, d, ...daySchedule.end.split(':').map(Number) as [number, number])
            db.run(
              `UPDATE timesheets SET clock_out = ?, auto_clocked_out = 1, scheduled_end = ? WHERE id = ?`,
              [endDate.toISOString(), scheduledEnd, existing.id]
            )
          }
        } catch { /* leave stale shift open if schedule unparseable */ }
      }
      if (!scheduledEnd) {
        // No schedule — close at midnight of the shift date as a fallback
        const [y, mo, d] = existing.date.split('-').map(Number)
        const midnight = new Date(y, mo - 1, d + 1)
        db.run(
          `UPDATE timesheets SET clock_out = ?, auto_clocked_out = 1 WHERE id = ?`,
          [midnight.toISOString(), existing.id]
        )
      }
    }

    const shiftId = generateId('ts')
    const now = nowDate.toISOString()

    db.run(
      `INSERT INTO timesheets (id, employee_id, merchant_id, clock_in, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [shiftId, empId, merchantId, now, today, now]
    )

    return c.json({ shiftId, clockIn: now }, 201)
  }
)

/**
 * POST /api/merchants/:id/employees/:empId/clock-out
 *
 * Closes the employee's open timesheet shift and records an optional tip.
 * If `shiftId` is omitted the server finds the open shift for today.
 *
 * @param body.shiftId - Explicit shift ID to close (optional; defaults to today's open shift)
 * @returns `{ shiftId: string, clockOut: string }` (ISO timestamp)
 */
employees.post(
  '/api/merchants/:id/employees/:empId/clock-out',
  authenticate,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const empId = c.req.param('empId')!
    const db = getDatabase()

    const emp = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM employees WHERE id = ? AND merchant_id = ?`
      )
      .get(empId, merchantId)

    if (!emp) return c.json({ error: 'Employee not found' }, 404)

    const body = await c.req.json<{ shiftId?: string }>().catch(() => ({} as { shiftId?: string }))

    let shiftId = body.shiftId ?? null
    if (!shiftId) {
      const open = db
        .query<{ id: string }, [string]>(
          `SELECT id FROM timesheets WHERE employee_id = ? AND clock_out IS NULL
           ORDER BY clock_in DESC LIMIT 1`
        )
        .get(empId)
      shiftId = open?.id ?? null
    }

    if (!shiftId) {
      return c.json({ error: 'No open shift found' }, 404)
    }

    const now = new Date().toISOString()
    db.run(
      `UPDATE timesheets SET clock_out = ? WHERE id = ? AND employee_id = ?`,
      [now, shiftId, empId]
    )

    return c.json({ shiftId, clockOut: now })
  }
)

/**
 * GET /api/merchants/:id/timesheets
 *
 * Returns all timesheet shifts in the given date range, optionally filtered
 * to a single employee. Used by the Timesheets report tab.
 *
 * @param query.from - Start date `YYYY-MM-DD` (default: today)
 * @param query.to - End date `YYYY-MM-DD` (default: today)
 * @param query.employeeId - Filter to a specific employee (optional)
 * @returns `{ timesheets: Timesheet[] }`
 */
employees.get(
  '/api/merchants/:id/timesheets',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const db = getDatabase()

    const today = new Date().toISOString().slice(0, 10)
    const from = c.req.query('from') || today
    const to = c.req.query('to') || today
    const empFilter = c.req.query('employeeId')

    let query = `
      SELECT t.id, t.employee_id, e.nickname, e.role,
             t.clock_in, t.clock_out, t.date
      FROM timesheets t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.merchant_id = ? AND t.date >= ? AND t.date <= ?`

    const params: string[] = [merchantId, from, to]

    if (empFilter) {
      query += ` AND t.employee_id = ?`
      params.push(empFilter)
    }

    query += ` ORDER BY t.date DESC, t.clock_in DESC`

    const rows = db.query<{
      id: string
      employee_id: string
      nickname: string
      role: string
      clock_in: string
      clock_out: string | null
      date: string
    }, string[]>(query).all(...params)

    return c.json({
      timesheets: rows.map((r) => ({
        id: r.id,
        employeeId: r.employee_id,
        nickname: r.nickname,
        role: r.role,
        clockIn: r.clock_in,
        clockOut: r.clock_out,
        date: r.date,
      })),
      range: { from, to },
    })
  }
)

/**
 * GET /api/merchants/:id/employees/:empId/sales
 *
 * Returns the employee's order sales totals for today and the past 14 days.
 * Used in the clock-out modal so servers can review their own collected amounts
 * before signing off. Manager+ required (staff see only their own `:empId`).
 *
 * @returns `{ today: SalesTotals, fortnight: SalesTotals }`
 */
employees.get(
  '/api/merchants/:id/employees/:empId/sales',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const empId      = c.req.param('empId')!
    const db = getDatabase()

    // Check the merchant's setting — return 403 if sharing is disabled
    const setting = db
      .query<{ show_employee_sales: number }, [string]>(
        `SELECT show_employee_sales FROM merchants WHERE id = ?`
      )
      .get(merchantId)

    if (!setting || setting.show_employee_sales === 0) {
      return c.json({ error: 'Sales sharing is disabled for this store' }, 403)
    }

    // Date boundaries (SQLite stores created_at as ISO strings in UTC)
    const now = new Date()
    const todayISO = now.toISOString().slice(0, 10)          // 'YYYY-MM-DD'

    const fortnightDate = new Date(now)
    fortnightDate.setDate(fortnightDate.getDate() - 13)      // today + 13 prior days = 14 days
    const fortnightISO = fortnightDate.toISOString().slice(0, 10)

    type SummaryRow = { order_count: number; subtotal: number | null; tax: number | null; total: number | null }

    const summaryQuery = db.query<SummaryRow, [string, string, string, string]>(
      `SELECT COUNT(*) AS order_count,
              SUM(subtotal_cents) AS subtotal,
              SUM(tax_cents)      AS tax,
              SUM(total_cents)    AS total
       FROM orders
       WHERE merchant_id = ?
         AND employee_id = ?
         AND date(created_at) >= ?
         AND date(created_at) <= ?`
    )

    const todayRow     = summaryQuery.get(merchantId, empId, todayISO, todayISO)
    const fortnightRow = summaryQuery.get(merchantId, empId, fortnightISO, todayISO)

    const toSummary = (row: SummaryRow | null) => {
      const subtotal = row?.subtotal ?? 0
      const tax      = row?.tax      ?? 0
      const total    = row?.total    ?? 0
      return {
        orderCount:    row?.order_count ?? 0,
        subtotalCents: subtotal,
        taxCents:      tax,
        tipsCents:     Math.max(0, total - subtotal - tax),
        totalCents:    total,
      }
    }

    return c.json({
      today:     toSummary(todayRow),
      fortnight: toSummary(fortnightRow),
    })
  }
)

export { employees }
