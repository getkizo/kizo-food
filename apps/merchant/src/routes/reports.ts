/**
 * Report endpoints — sales, shifts, tips
 *
 * All three reports require manager or owner role.
 * Employee authentication is a UI-layer concern only — JWTs carry
 * owner | manager | staff roles, not the employee-specific roles.
 *
 * All endpoints accept ?from=YYYY-MM-DD&to=YYYY-MM-DD query params.
 * Optional ?employeeId=<id> on shifts and tips for filtering by employee.
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { authenticate } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'

const reports = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse and validate YYYY-MM-DD, return fallback if invalid */
function parseDate(s: string | undefined, fallback: string): string {
  if (!s) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback
  return s
}

/** Today as YYYY-MM-DD in the merchant's local timezone */
function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** 30 days ago as YYYY-MM-DD in the merchant's local timezone */
function thirtyDaysAgoLocal(tz: string): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/**
 * Convert a merchant-local YYYY-MM-DD + HH:MM:SS to a UTC datetime string
 * suitable for comparing against SQLite's UTC created_at values.
 */
function localToUtc(localDate: string, localTime: string, tz: string): string {
  // Treat the local date/time as if it were UTC to get a reference point
  const approx = new Date(`${localDate}T${localTime}Z`)
  // Format that UTC instant in the merchant timezone to find the offset
  const datePart = new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(approx)
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, hourCycle: 'h23',
  }).format(approx)
  const offsetMs = new Date(`${datePart}T${timePart}Z`).getTime() - approx.getTime()
  return new Date(approx.getTime() - offsetMs).toISOString().replace('T', ' ').slice(0, 19)
}

/** Convert a UTC datetime string (from SQLite) to merchant-local YYYY-MM-DD HH:MM:SS */
function utcToLocal(utcStr: string, tz: string): string {
  const d = new Date(utcStr.replace(' ', 'T') + 'Z')
  const datePart = new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, hourCycle: 'h23',
  }).format(d)
  return `${datePart} ${timePart}`
}

/**
 * Compute shift duration in decimal hours, optionally applying a break rule.
 * Returns null when clock_out is missing (shift still open).
 */
function shiftHours(
  clockIn: string,
  clockOut: string,
  breakRule: { thresholdHours: number; deductionMinutes: number } | null
): number {
  const ms = new Date(clockOut).getTime() - new Date(clockIn).getTime()
  if (ms <= 0) return 0
  let hours = ms / 3_600_000
  if (breakRule && hours > breakRule.thresholdHours) {
    hours -= breakRule.deductionMinutes / 60
    if (hours < 0) hours = 0
  }
  return Math.round(hours * 100) / 100
}

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/reports/sales
// ---------------------------------------------------------------------------

reports.get(
  '/api/merchants/:id/reports/sales',
  authenticate,
  async (c: AuthContext) => {
    const user = c.get('user')
    if (!['owner', 'manager'].includes(user.role)) {
      return c.json({ error: 'Access denied' }, 403)
    }

    const merchantId = c.req.param('id')
    const db = getDatabase()

    // Fetch merchant timezone for local date calculations
    const mRow = db
      .query<{ timezone: string }, [string]>(`SELECT timezone FROM merchants WHERE id = ?`)
      .get(merchantId)
    const tz = mRow?.timezone ?? 'America/Los_Angeles'

    const from = parseDate(c.req.query('from'), thirtyDaysAgoLocal(tz))
    const to   = parseDate(c.req.query('to'),   todayLocal(tz))

    type OrderRow = {
      id: string
      customer_name: string
      created_at: string
      subtotal_cents: number
      discount_cents: number
      tax_cents: number
      service_charge_cents: number
      tip_cents: number
      paid_amount_cents: number
      payment_method: string | null
      refunded_cents: number
      p_card_cents: number | null
      p_cash_cents: number | null
      p_gift_card_cents: number | null
    }

    // Convert merchant-local date range to UTC bounds for SQL comparison
    const fromBound = localToUtc(from, '00:00:00', tz)
    const toBound   = localToUtc(to,   '23:59:59', tz)

    const rows = db
      .query<OrderRow, [string, string, string, string, string]>(
        `SELECT
           o.id,
           o.customer_name,
           o.created_at,
           COALESCE(o.subtotal_cents, 0)              AS subtotal_cents,
           COALESCE(o.discount_cents, 0)              AS discount_cents,
           COALESCE(o.tax_cents, 0)                   AS tax_cents,
           COALESCE(o.service_charge_cents, 0)        AS service_charge_cents,
           COALESCE(o.tip_cents, 0)                   AS tip_cents,
           COALESCE(o.paid_amount_cents, 0)           AS paid_amount_cents,
           o.payment_method,
           COALESCE(r.refunded_cents, 0)              AS refunded_cents,
           p.p_card_cents,
           p.p_cash_cents,
           p.p_gift_card_cents
         FROM orders o
         LEFT JOIN (
           SELECT order_id, SUM(refund_amount_cents) AS refunded_cents
           FROM refunds WHERE merchant_id = ?
           GROUP BY order_id
         ) r ON r.order_id = o.id
         LEFT JOIN (
           SELECT
             order_id,
             SUM(CASE WHEN payment_type = 'card'      THEN amount_cents ELSE 0 END) AS p_card_cents,
             SUM(CASE WHEN payment_type = 'cash'      THEN amount_cents ELSE 0 END) AS p_cash_cents,
             SUM(CASE WHEN payment_type = 'gift_card' THEN amount_cents ELSE 0 END) AS p_gift_card_cents
           FROM payments WHERE merchant_id = ?
           GROUP BY order_id
         ) p ON p.order_id = o.id
         WHERE o.merchant_id = ?
           AND COALESCE(o.paid_amount_cents, 0) > 0
           AND o.status NOT IN ('pending_payment', 'cancelled', 'pos_error')
           AND o.created_at >= ?
           AND o.created_at <= ?
         ORDER BY o.created_at ASC`
      )
      .all(merchantId, merchantId, merchantId, fromBound, toBound)

    // Accumulators
    let totalOrders        = 0
    let grossSalesCents    = 0
    let discountCents      = 0
    let refundedCents      = 0
    let taxCents           = 0
    let serviceChargeCents = 0
    let tipCents           = 0
    let amountCollectedCents = 0
    let cardAmountCents        = 0
    let cashAmountCents        = 0
    let giftCardAmountCents    = 0

    const byDay: Record<string, {
      orders: number
      grossSalesCents: number
      discountCents: number
      refundedCents: number
      taxCents: number
      serviceChargeCents: number
      tipCents: number
      amountCollectedCents: number
    }> = {}

    type OrderDetail = {
      id: string
      customerName: string
      createdAt: string
      paymentMethod: string
      subtotalCents: number
      discountCents: number
      taxCents: number
      serviceChargeCents: number
      tipCents: number
      amountCollectedCents: number
      refundedCents: number
    }
    const orderRows: OrderDetail[] = []

    for (const r of rows) {
      totalOrders++
      grossSalesCents      += r.subtotal_cents
      discountCents        += r.discount_cents
      refundedCents        += r.refunded_cents
      taxCents             += r.tax_cents
      serviceChargeCents   += r.service_charge_cents
      tipCents             += r.tip_cents
      amountCollectedCents += r.paid_amount_cents

      // In-restaurant orders have rows in the payments table with per-leg tender
      // breakdown (card/cash/gift_card). Online orders (Converge/Finix) have no
      // payments rows and rely solely on orders.payment_method.
      if (r.p_card_cents !== null) {
        cardAmountCents     += r.p_card_cents     ?? 0
        cashAmountCents     += r.p_cash_cents     ?? 0
        giftCardAmountCents += r.p_gift_card_cents ?? 0
      } else if (r.payment_method === 'cash') {
        cashAmountCents += r.paid_amount_cents
      } else if (r.payment_method === 'gift_card') {
        giftCardAmountCents += r.paid_amount_cents
      } else {
        cardAmountCents += r.paid_amount_cents
      }

      // Group by merchant-local date, not UTC date
      const localDt = utcToLocal(r.created_at, tz)
      const localDate = localDt.slice(0, 10)

      if (!byDay[localDate]) byDay[localDate] = {
        orders: 0, grossSalesCents: 0, discountCents: 0, refundedCents: 0,
        taxCents: 0, serviceChargeCents: 0, tipCents: 0, amountCollectedCents: 0,
      }
      byDay[localDate].orders++
      byDay[localDate].grossSalesCents      += r.subtotal_cents
      byDay[localDate].discountCents        += r.discount_cents
      byDay[localDate].refundedCents        += r.refunded_cents
      byDay[localDate].taxCents             += r.tax_cents
      byDay[localDate].serviceChargeCents   += r.service_charge_cents
      byDay[localDate].tipCents             += r.tip_cents
      byDay[localDate].amountCollectedCents += r.paid_amount_cents

      orderRows.push({
        id: r.id,
        customerName: r.customer_name,
        createdAt: localDt,
        paymentMethod: r.payment_method ?? 'card',
        subtotalCents: r.subtotal_cents,
        discountCents: r.discount_cents,
        taxCents: r.tax_cents,
        serviceChargeCents: r.service_charge_cents,
        tipCents: r.tip_cents,
        amountCollectedCents: r.paid_amount_cents,
        refundedCents: r.refunded_cents,
      })
    }

    // ── Gift card purchases ────────────────────────────────────────────────────
    // Gift card purchases are revenue collected but live in gift_card_purchases,
    // not in orders. Pull paid purchases for the same date range and fold them
    // into the same accumulators so they appear in summary totals, per-day rows,
    // and the per-order detail table.
    type GcpRow = {
      id: string
      customer_name: string
      created_at: string
      net_revenue_cents: number
      tax_embedded_cents: number
      total_cents: number
    }
    const gcpRows = db
      .query<GcpRow, [string, string, string]>(
        `SELECT id, customer_name, created_at,
                net_revenue_cents, tax_embedded_cents, total_cents
         FROM gift_card_purchases
         WHERE merchant_id = ?
           AND status = 'paid'
           AND created_at >= ?
           AND created_at <= ?
         ORDER BY created_at ASC`
      )
      .all(merchantId, fromBound, toBound)

    for (const g of gcpRows) {
      totalOrders++
      grossSalesCents      += g.net_revenue_cents
      taxCents             += g.tax_embedded_cents
      amountCollectedCents += g.total_cents
      giftCardAmountCents  += g.total_cents

      const localDt   = utcToLocal(g.created_at, tz)
      const localDate = localDt.slice(0, 10)

      if (!byDay[localDate]) byDay[localDate] = {
        orders: 0, grossSalesCents: 0, discountCents: 0, refundedCents: 0,
        taxCents: 0, serviceChargeCents: 0, tipCents: 0, amountCollectedCents: 0,
      }
      byDay[localDate].orders++
      byDay[localDate].grossSalesCents      += g.net_revenue_cents
      byDay[localDate].taxCents             += g.tax_embedded_cents
      byDay[localDate].amountCollectedCents += g.total_cents

      orderRows.push({
        id: g.id,
        customerName: g.customer_name,
        createdAt: localDt,
        paymentMethod: 'gift_card_purchase',
        subtotalCents: g.net_revenue_cents,
        discountCents: 0,
        taxCents: g.tax_embedded_cents,
        serviceChargeCents: 0,
        tipCents: 0,
        amountCollectedCents: g.total_cents,
        refundedCents: 0,
      })
    }

    const netSalesCents = grossSalesCents - discountCents - refundedCents

    const days = Object.entries(byDay).map(([date, d]) => ({
      date,
      orders: d.orders,
      grossSalesCents:    d.grossSalesCents,
      discountCents:      d.discountCents,
      refundedCents:      d.refundedCents,
      netSalesCents:      d.grossSalesCents - d.discountCents - d.refundedCents,
      taxCents:           d.taxCents,
      serviceChargeCents: d.serviceChargeCents,
      tipCents:           d.tipCents,
      amountCollectedCents: d.amountCollectedCents,
    }))

    return c.json({
      from,
      to,
      summary: {
        totalOrders,
        grossSalesCents,
        discountCents,
        refundedCents,
        netSalesCents,
        taxCents,
        tipCents,
        serviceChargeCents,
        amountCollectedCents,
        tenders: { card: cardAmountCents, cash: cashAmountCents, giftCard: giftCardAmountCents },
        // Legacy aliases — kept so older client builds don't break
        totalSalesCents:   netSalesCents,
        totalTipsCents:    tipCents,
        totalGrossCents:   grossSalesCents,
        totalRefundedCents: refundedCents,
        totalNetCents:     netSalesCents,
      },
      days,
      // Individual order rows included only for same-day view
      orders: from === to ? orderRows : undefined,
    })
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/reports/shifts
// Optional: ?employeeId=<id> to filter to one employee
// ---------------------------------------------------------------------------

reports.get(
  '/api/merchants/:id/reports/shifts',
  authenticate,
  async (c: AuthContext) => {
    const user = c.get('user')
    if (!['owner', 'manager'].includes(user.role)) {
      return c.json({ error: 'Access denied' }, 403)
    }

    const merchantId = c.req.param('id')
    const db = getDatabase()

    // Fetch break rule and timezone from merchant profile
    const merchantRow = db
      .query<{ break_rule: string | null; timezone: string }, [string]>(
        `SELECT break_rule, timezone FROM merchants WHERE id = ?`
      )
      .get(merchantId)
    const tz = merchantRow?.timezone ?? 'America/Los_Angeles'

    const from       = parseDate(c.req.query('from'), thirtyDaysAgoLocal(tz))
    const to         = parseDate(c.req.query('to'),   todayLocal(tz))
    const empFilter  = c.req.query('employeeId')

    let breakRule: { thresholdHours: number; deductionMinutes: number } | null = null
    try {
      if (merchantRow?.break_rule) breakRule = JSON.parse(merchantRow.break_rule)
    } catch {
      console.warn('[reports] malformed break_rule JSON for merchant', merchantId)
    }

    type ShiftRow = {
      employee_id: string
      nickname: string
      emp_role: string
      date: string
      clock_in: string
      clock_out: string | null
    }

    // Build query with optional employee filter using parameterised binding
    let sql = `
      SELECT
        t.employee_id,
        e.nickname,
        e.role   AS emp_role,
        t.date,
        t.clock_in,
        t.clock_out
      FROM timesheets t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.merchant_id = ?
        AND t.date >= ?
        AND t.date <= ?`

    const params: string[] = [merchantId, from, to]

    if (empFilter) {
      sql += ` AND t.employee_id = ?`
      params.push(empFilter)
    }

    sql += ` ORDER BY e.nickname ASC, t.date ASC, t.clock_in ASC`

    const rows = db.query<ShiftRow, string[]>(sql).all(...params)

    // Group by employee
    const byEmp: Record<string, {
      employeeId: string
      nickname: string
      role: string
      totalHours: number
      shifts: Array<{ date: string; clockIn: string; clockOut: string | null; hours: number | null }>
    }> = {}

    let grandTotalHours = 0

    for (const r of rows) {
      if (!byEmp[r.employee_id]) {
        byEmp[r.employee_id] = {
          employeeId: r.employee_id,
          nickname: r.nickname,
          role: r.emp_role,
          totalHours: 0,
          shifts: [],
        }
      }
      const hours = r.clock_out ? shiftHours(r.clock_in, r.clock_out, breakRule) : null
      byEmp[r.employee_id].shifts.push({
        date: r.date,
        clockIn: r.clock_in ? utcToLocal(r.clock_in, tz) : r.clock_in,
        clockOut: r.clock_out ? utcToLocal(r.clock_out, tz) : r.clock_out,
        hours,
      })
      if (hours != null) {
        byEmp[r.employee_id].totalHours += hours
        grandTotalHours += hours
      }
    }

    return c.json({
      from,
      to,
      breakRule,
      summary: { grandTotalHours: Math.round(grandTotalHours * 100) / 100 },
      employees: Object.values(byEmp).map((e) => ({
        ...e,
        totalHours: Math.round(e.totalHours * 100) / 100,
      })),
    })
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/reports/tips
// Optional: ?employeeId=<id> to filter to one employee
// ---------------------------------------------------------------------------

reports.get(
  '/api/merchants/:id/reports/tips',
  authenticate,
  async (c: AuthContext) => {
    const user = c.get('user')
    if (!['owner', 'manager'].includes(user.role)) {
      return c.json({ error: 'Access denied' }, 403)
    }

    const merchantId = c.req.param('id')
    const db = getDatabase()

    // Fetch merchant timezone
    const mRow = db
      .query<{ timezone: string }, [string]>(`SELECT timezone FROM merchants WHERE id = ?`)
      .get(merchantId)
    const tz = mRow?.timezone ?? 'America/Los_Angeles'

    const from      = parseDate(c.req.query('from'), thirtyDaysAgoLocal(tz))
    const to        = parseDate(c.req.query('to'),   todayLocal(tz))
    const empFilter = c.req.query('employeeId')

    type TipRow = {
      employee_id: string | null
      employee_nickname: string | null
      created_at: string
      tip_cents: number
    }

    // Convert merchant-local date range to UTC bounds for SQL comparison
    const fromBound = localToUtc(from, '00:00:00', tz)
    const toBound   = localToUtc(to,   '23:59:59', tz)

    let sql = `
      SELECT
        employee_id,
        employee_nickname,
        created_at,
        COALESCE(tip_cents, 0)         AS tip_cents
      FROM orders
      WHERE merchant_id = ?
        AND COALESCE(tip_cents, 0) > 0
        AND status NOT IN ('pending_payment', 'cancelled', 'pos_error')
        AND created_at >= ?
        AND created_at <= ?`

    const params: string[] = [merchantId, fromBound, toBound]

    if (empFilter) {
      sql += ` AND employee_id = ?`
      params.push(empFilter)
    }

    sql += ` ORDER BY employee_nickname ASC, created_at ASC`

    const rows = db.query<TipRow, string[]>(sql).all(...params)

    // Group by employee
    const byEmp: Record<string, {
      employeeId: string | null
      nickname: string
      totalTipCents: number
      orderCount: number
    }> = {}

    let grandTotalTipsCents = 0

    for (const r of rows) {
      const key  = r.employee_id ?? '__unassigned__'
      const nick = r.employee_nickname ?? 'Unassigned'
      if (!byEmp[key]) {
        byEmp[key] = { employeeId: r.employee_id, nickname: nick, totalTipCents: 0, orderCount: 0 }
      }
      byEmp[key].totalTipCents += r.tip_cents
      byEmp[key].orderCount++
      grandTotalTipsCents += r.tip_cents
    }

    return c.json({
      from,
      to,
      summary: { grandTotalTipsCents },
      employees: Object.values(byEmp),
    })
  }
)

export { reports }
