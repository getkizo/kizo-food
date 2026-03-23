/**
 * Daily closeout email service
 *
 * Sends a sales summary email 60 minutes after the business closes each day.
 * Uses the last closing time from the `business_hours` table for the current
 * day-of-week. If the business is closed (no hours or scheduled closure),
 * sends an empty closeout report.
 *
 * Email is sent to the merchant's `email` column (store profile contact email)
 * from the `receipt_email_from` Gmail address (same credentials as receipt emails).
 *
 * Runs on a 30-minute polling interval.
 */

import nodemailer from 'nodemailer'
import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { prunePaymentEvents } from './payment-log'

// ---------------------------------------------------------------------------
// Helpers (same timezone helpers as reports.ts — kept local to avoid coupling)
// ---------------------------------------------------------------------------

/** Today as YYYY-MM-DD in the given timezone */
function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** Current time as HH:MM in the given timezone */
function nowTimeLocal(tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).format(new Date())
}

/** Day of week (0=Sunday) in the given timezone */
function todayDow(tz: string): number {
  const dateStr = todayLocal(tz)
  // Parse YYYY-MM-DD and get day of week
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/**
 * Convert a merchant-local YYYY-MM-DD + HH:MM:SS to a UTC datetime string
 * suitable for comparing against SQLite's UTC created_at values.
 *
 * NOTE: Approximate UTC conversion — can be ±1h on DST transition days (spring-forward /
 * fall-back). Affects ~2 days/year in DST-observing timezones. Acceptable for a background
 * reporting service; not suitable for precision billing.
 */
function localToUtc(localDate: string, localTime: string, tz: string): string {
  const approx = new Date(`${localDate}T${localTime}Z`)
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

/** Convert a UTC datetime string (from SQLite) to merchant-local HH:MM AM/PM */
function utcToLocalTime(utcStr: string, tz: string): string {
  const d = new Date(utcStr.replace(' ', 'T') + 'Z')
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d)
}

function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

function esc(str: string | null | undefined): string {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// State — dedup guards for single-merchant appliance
// ---------------------------------------------------------------------------

/** YYYY-MM-DD of the last closeout email sent; null if not yet sent today. */
let _lastSentDate: string | null = null

/** YYYY-MM-DD of the last reservation briefing sent; null if not yet sent today. */
let _lastBriefingDate: string | null = null

/** True while an async closeout email is in-flight. */
let _sendInProgress = false

/** True while an async briefing email is in-flight. */
let _briefingInProgress = false

/** Clear deduplication state — for use in tests only. */
export function resetCloseoutState(): void {
  _lastSentDate = null
  _lastBriefingDate = null
  _sendInProgress = false
  _briefingInProgress = false
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

interface MerchantRow {
  id: string
  business_name: string
  email: string | null
  receipt_email_from: string | null
  timezone: string
  phone_number: string | null
  address: string | null
}

/**
 * One polling pass: send the daily closeout email if it's 60+ minutes past
 * the merchant's last closing time and we haven't sent one yet today.
 *
 * This appliance serves a single merchant. No loop over merchants is needed.
 */
export async function checkCloseouts(): Promise<number> {
  // Prune stale payment_events on every sweep so the table stays bounded even
  // when reconciliation is disabled (secondary call site per payment-log.ts warning).
  prunePaymentEvents()

  const db = getDatabase()

  const merchant = db
    .query<MerchantRow, []>(
      `SELECT id, business_name, email, receipt_email_from, timezone,
              phone_number, address
       FROM merchants WHERE status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get()

  if (!merchant) return 0
  if (!merchant.email || !merchant.receipt_email_from) return 0

  const tz = merchant.timezone || 'America/Los_Angeles'
  const today = todayLocal(tz)

  // Already sent for today?
  if (_lastSentDate === today) return 0
  if (_sendInProgress) return 0

  _sendInProgress = true
  try {
    // Determine last closing time for today's day-of-week
    const dow = todayDow(tz)
    const lastClose = getLastCloseTime(merchant.id, dow)

    // Check scheduled closures — if today is a closure day, send empty report
    const isClosed = isScheduledClosure(merchant.id, today) || lastClose === null

    if (isClosed) {
      // For closed days, send at a fixed time: 9:00 PM (21:00)
      const nowTime = nowTimeLocal(tz)
      if (nowTime < '21:00') return 0

      const ok = await sendCloseoutEmail(merchant, tz, today, true)
      if (ok) {
        _lastSentDate = today
        console.log(`[closeout] Sent empty closeout for ${merchant.business_name} (${today}, closed)`)
        return 1
      }
    } else {
      // Open day: send 60 min after last closing time
      const sendAfter = addMinutes(lastClose, 60)
      const nowTime = nowTimeLocal(tz)
      if (nowTime < sendAfter) return 0

      const ok = await sendCloseoutEmail(merchant, tz, today, false)
      if (ok) {
        _lastSentDate = today
        console.log(`[closeout] Sent closeout for ${merchant.business_name} (${today}, closes ${lastClose})`)
        return 1
      }
    }
    return 0
  } catch (err) {
    const isDekError = err instanceof Error && err.message.includes('Failed to decrypt DEK')
    if (isDekError) {
      // Master key mismatch — re-entering the API key in Store Profile will fix it.
      // Suppress retries until tomorrow to prevent log spam.
      _lastSentDate = today
      console.error(
        `[closeout] Cannot decrypt email API key for ${merchant.id} — master key mismatch. ` +
        `Re-enter the Gmail app password in Store Profile → Email Settings to re-encrypt it. ` +
        `Closeout skipped for today.`
      )
    } else {
      console.error('[closeout] Error:', err)
    }
    return 0
  } finally {
    _sendInProgress = false
  }
}

/**
 * Get the latest close_time across all 'regular' hour slots for a given day.
 * Returns HH:MM or null if no hours are configured for that day.
 */
function getLastCloseTime(merchantId: string, dow: number): string | null {
  const db = getDatabase()
  const row = db
    .query<{ close_time: string }, [string, number]>(
      `SELECT MAX(close_time) AS close_time
       FROM business_hours
       WHERE merchant_id = ?
         AND service_type = 'regular'
         AND day_of_week = ?
         AND is_closed = 0`
    )
    .get(merchantId, dow)

  return row?.close_time ?? null
}

/** Check if today falls within any scheduled closure for this merchant. */
function isScheduledClosure(merchantId: string, todayDate: string): boolean {
  const db = getDatabase()
  const row = db
    .query<{ cnt: number }, [string, string, string]>(
      `SELECT COUNT(*) AS cnt FROM scheduled_closures
       WHERE merchant_id = ?
         AND start_date <= ?
         AND end_date   >= ?`
    )
    .get(merchantId, todayDate, todayDate)

  return (row?.cnt ?? 0) > 0
}

/** Add minutes to HH:MM string, returning HH:MM (capped at 23:59). */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + minutes
  const newH = Math.min(Math.floor(total / 60), 23)
  const newM = total >= 24 * 60 ? 59 : total % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Sales data query (reuses reports.ts logic)
// ---------------------------------------------------------------------------

interface SalesData {
  totalOrders: number
  grossSalesCents: number
  discountCents: number
  refundedCents: number
  netSalesCents: number
  taxCents: number
  serviceChargeCents: number
  tipCents: number
  amountCollectedCents: number
  cardCents: number
  cashCents: number
  orders: Array<{
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
  }>
}

function getSalesData(merchantId: string, date: string, tz: string): SalesData {
  const db = getDatabase()

  const fromBound = localToUtc(date, '00:00:00', tz)
  const toBound   = localToUtc(date, '23:59:59', tz)

  type OrderRow = {
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
  }

  const rows = db
    .query<OrderRow, [string, string, string, string]>(
      `SELECT
         o.customer_name,
         o.created_at,
         COALESCE(o.subtotal_cents, 0)              AS subtotal_cents,
         COALESCE(o.discount_cents, 0)              AS discount_cents,
         COALESCE(o.tax_cents, 0)                   AS tax_cents,
         COALESCE(o.service_charge_cents, 0)        AS service_charge_cents,
         COALESCE(o.tip_cents, 0)                   AS tip_cents,
         COALESCE(o.paid_amount_cents, 0)           AS paid_amount_cents,
         o.payment_method,
         COALESCE(r.refunded_cents, 0)              AS refunded_cents
       FROM orders o
       LEFT JOIN (
         SELECT order_id, SUM(refund_amount_cents) AS refunded_cents
         FROM refunds WHERE merchant_id = ?
         GROUP BY order_id
       ) r ON r.order_id = o.id
       WHERE o.merchant_id = ?
         AND COALESCE(o.paid_amount_cents, 0) > 0
         AND o.status NOT IN ('pending_payment', 'cancelled', 'pos_error')
         AND o.created_at >= ?
         AND o.created_at <= ?
       ORDER BY o.created_at ASC`
    )
    .all(merchantId, merchantId, fromBound, toBound)

  let totalOrders        = 0
  let grossSalesCents    = 0
  let discountCents      = 0
  let refundedCents      = 0
  let taxCents           = 0
  let serviceChargeCents = 0
  let tipCents           = 0
  let amountCollectedCents = 0
  let cardCents          = 0
  let cashCents          = 0

  const orders: SalesData['orders'] = []

  for (const r of rows) {
    totalOrders++
    grossSalesCents      += r.subtotal_cents
    discountCents        += r.discount_cents
    refundedCents        += r.refunded_cents
    taxCents             += r.tax_cents
    serviceChargeCents   += r.service_charge_cents
    tipCents             += r.tip_cents
    amountCollectedCents += r.paid_amount_cents

    if (r.payment_method === 'cash') cashCents += r.paid_amount_cents
    else                              cardCents += r.paid_amount_cents

    orders.push({
      customerName: r.customer_name,
      createdAt: utcToLocalTime(r.created_at, tz),
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

  return {
    totalOrders, grossSalesCents, discountCents, refundedCents,
    netSalesCents: grossSalesCents - discountCents - refundedCents,
    taxCents, serviceChargeCents, tipCents, amountCollectedCents,
    cardCents, cashCents, orders,
  }
}

// ---------------------------------------------------------------------------
// Email sending
// ---------------------------------------------------------------------------

async function sendCloseoutEmail(
  merchant: MerchantRow,
  tz: string,
  date: string,
  isClosed: boolean,
): Promise<boolean> {
  const appPassword = await getAPIKey(merchant.id, 'email', 'gmail')
  if (!appPassword) {
    console.warn(`[closeout] No Gmail app password for ${merchant.id} — skipping`)
    return false
  }

  const sales = isClosed ? null : getSalesData(merchant.id, date, tz)
  const html = buildCloseoutHtml(merchant, date, tz, sales, isClosed)

  // Format date for subject line
  const dateObj = new Date(date + 'T12:00:00')
  const dateLabel = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  const smtpName = merchant.business_name.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: merchant.receipt_email_from!, pass: appPassword },
  })

  await transporter.sendMail({
    from: `"${smtpName}" <${merchant.receipt_email_from}>`,
    to: merchant.email!,
    subject: `Daily Closeout — ${dateLabel}`,
    html,
  })

  return true
}

// ---------------------------------------------------------------------------
// HTML template — matches dashboard reports format
// ---------------------------------------------------------------------------

function buildCloseoutHtml(
  merchant: MerchantRow,
  date: string,
  tz: string,
  sales: SalesData | null,
  isClosed: boolean,
): string {
  const biz = esc(merchant.business_name)

  const dateObj = new Date(date + 'T12:00:00')
  const dateLabel = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  // Contact line
  const contactParts: string[] = []
  if (merchant.address) contactParts.push(esc(merchant.address))
  if (merchant.phone_number) contactParts.push(esc(merchant.phone_number))
  const contactLine = contactParts.length > 0
    ? `<p style="margin:4px 0 0;font-size:12px;color:#aaa;">${contactParts.join(' &middot; ')}</p>`
    : ''

  if (isClosed || !sales) {
    return wrapEmail(biz, dateLabel, contactLine, `
      <tr><td style="padding:24px;text-align:center;">
        <p style="margin:0;font-size:16px;color:#888;">Business was closed on this date.</p>
        <p style="margin:8px 0 0;font-size:14px;color:#aaa;">No transactions recorded.</p>
      </td></tr>
    `)
  }

  // Summary block
  const fmt = formatCents
  const summaryRows = [
    row('Gross Sales', fmt(sales.grossSalesCents)),
    row('Discounts', sales.discountCents > 0 ? `<span style="color:#c0392b;">-${fmt(sales.discountCents)}</span>` : fmt(0)),
    row('Refunds', sales.refundedCents > 0 ? `<span style="color:#c0392b;">-${fmt(sales.refundedCents)}</span>` : fmt(0)),
    divider(),
    row('Net Sales', fmt(sales.netSalesCents), true),
    spacer(),
    row('Taxes &amp; Fees', fmt(sales.taxCents)),
    row('Tips', fmt(sales.tipCents)),
    row('Service Charge', fmt(sales.serviceChargeCents)),
    divider(),
    row('Amount Collected', fmt(sales.amountCollectedCents), true),
  ].join('')

  // Tender types
  const tenderRows = `
    <tr><td style="padding:4px 12px;">Card</td><td style="padding:4px 12px;text-align:right;">${fmt(sales.cardCents)}</td></tr>
    <tr><td style="padding:4px 12px;">Cash</td><td style="padding:4px 12px;text-align:right;">${fmt(sales.cashCents)}</td></tr>
    <tr style="border-top:2px solid #111;font-weight:bold;">
      <td style="padding:6px 12px;">Total</td>
      <td style="padding:6px 12px;text-align:right;">${fmt(sales.amountCollectedCents)}</td>
    </tr>
  `

  // Order detail table
  let orderDetailHtml = ''
  if (sales.orders.length > 0) {
    const headerRow = `
      <tr style="background:#f5f5f5;">
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Time</th>
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Customer</th>
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Tender</th>
        <th style="padding:6px 8px;text-align:right;font-size:12px;">Subtotal</th>
        <th style="padding:6px 8px;text-align:right;font-size:12px;">Discount</th>
        <th style="padding:6px 8px;text-align:right;font-size:12px;">Tax</th>
        <th style="padding:6px 8px;text-align:right;font-size:12px;">Tip</th>
        <th style="padding:6px 8px;text-align:right;font-size:12px;">Svc Chg</th>
        <th style="padding:6px 8px;text-align:right;font-size:12px;">Total</th>
      </tr>`

    const dataRows = sales.orders.map(o => `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:5px 8px;font-size:12px;">${esc(o.createdAt)}</td>
        <td style="padding:5px 8px;font-size:12px;">${esc(o.customerName)}</td>
        <td style="padding:5px 8px;font-size:12px;">${esc(o.paymentMethod)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmt(o.subtotalCents)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;">${o.discountCents > 0 ? '<span style="color:#c0392b;">-' + fmt(o.discountCents) + '</span>' : fmt(0)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmt(o.taxCents)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmt(o.tipCents)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmt(o.serviceChargeCents)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmt(o.amountCollectedCents)}</td>
      </tr>`).join('')

    const totalRow = `
      <tr style="border-top:2px solid #111;font-weight:bold;">
        <td colspan="3" style="padding:6px 8px;font-size:12px;">Total (${sales.totalOrders})</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;">${fmt(sales.grossSalesCents)}</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;">${sales.discountCents > 0 ? '-' + fmt(sales.discountCents) : fmt(0)}</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;">${fmt(sales.taxCents)}</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;">${fmt(sales.tipCents)}</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;">${fmt(sales.serviceChargeCents)}</td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;">${fmt(sales.amountCollectedCents)}</td>
      </tr>`

    orderDetailHtml = `
      <tr><td style="padding:16px 24px 0;">
        <p style="margin:0 0 8px;font-weight:bold;font-size:14px;color:#333;">Order Detail</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:4px;">
          ${headerRow}${dataRows}${totalRow}
        </table>
      </td></tr>`
  }

  const body = `
    <!-- Summary -->
    <tr><td style="padding:16px 24px 0;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="vertical-align:top;width:55%;padding-right:16px;">
            <p style="margin:0 0 8px;font-weight:bold;font-size:14px;color:#333;">Sales Summary</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${summaryRows}
            </table>
          </td>
          <td style="vertical-align:top;width:45%;">
            <p style="margin:0 0 8px;font-weight:bold;font-size:14px;color:#333;">Tender Types</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:4px;">
              ${tenderRows}
            </table>
            <p style="margin:8px 0 0;font-size:13px;color:#888;">${sales.totalOrders} order${sales.totalOrders !== 1 ? 's' : ''}</p>
          </td>
        </tr>
      </table>
    </td></tr>
    ${orderDetailHtml}
  `

  return wrapEmail(biz, dateLabel, contactLine, body)
}

/** Wrap content in the email chrome (header, footer) */
function wrapEmail(
  bizName: string,
  dateLabel: string,
  contactLine: string,
  body: string,
  subtitle = 'Daily Closeout Report',
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subtitle)} — ${esc(dateLabel)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table width="100%" style="max-width:640px;background:#fff;border-radius:8px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#111;padding:24px;text-align:center;">
              <p style="margin:0;font-size:20px;font-weight:bold;color:#fff;">${bizName}</p>
              <p style="margin:8px 0 0;font-size:13px;color:#aaa;">${esc(subtitle)}</p>
              <p style="margin:4px 0 0;font-size:13px;color:#ccc;">${esc(dateLabel)}</p>
              ${contactLine}
            </td>
          </tr>

          ${body}

          <!-- Footer -->
          <tr>
            <td style="background:#f9f9f9;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;font-size:11px;color:#999;">
                This report was generated automatically by Kizo.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** Summary row helper */
function row(label: string, value: string, bold = false): string {
  const style = bold
    ? 'font-weight:bold;padding:6px 0;'
    : 'padding:4px 0;color:#555;'
  return `<tr>
    <td style="${style}">${label}</td>
    <td style="${style}text-align:right;">${value}</td>
  </tr>`
}

function divider(): string {
  return '<tr><td colspan="2" style="border-top:1px solid #ddd;padding:0;"></td></tr>'
}

function spacer(): string {
  return '<tr><td colspan="2" style="padding:4px 0;"></td></tr>'
}

// ---------------------------------------------------------------------------
// Reservation morning briefing
// ---------------------------------------------------------------------------

interface ReservationBriefingMerchant {
  id: string
  business_name: string
  email: string | null
  receipt_email_from: string | null
  timezone: string
  reservation_enabled: number
  reservation_briefing_time: string
}

interface ReservationRow {
  customer_name: string
  party_size: number
  time: string
  table_label: string | null
  notes: string | null
  customer_phone: string | null
}

/**
 * One polling pass: send today's reservation briefing to each active merchant
 * whose reservation feature is enabled and whose configured send time has passed.
 * Sends at most once per day per merchant.
 */
export async function checkReservationBriefings(): Promise<number> {
  const db = getDatabase()

  const merchant = db
    .query<ReservationBriefingMerchant, []>(
      `SELECT id, business_name, email, receipt_email_from,
              COALESCE(timezone, 'America/Los_Angeles') AS timezone,
              COALESCE(reservation_enabled, 0)          AS reservation_enabled,
              COALESCE(reservation_briefing_time, '07:30') AS reservation_briefing_time
       FROM merchants WHERE status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get()

  if (!merchant) return 0
  if (!merchant.reservation_enabled) return 0
  if (!merchant.email || !merchant.receipt_email_from) return 0

  const tz = merchant.timezone
  const today = todayLocal(tz)

  // Already sent today?
  if (_lastBriefingDate === today) return 0
  if (_briefingInProgress) return 0

  _briefingInProgress = true
  try {
    // Not yet time?
    const nowTime = nowTimeLocal(tz)
    if (nowTime < merchant.reservation_briefing_time) return 0

    const reservations = db
      .query<ReservationRow, [string, string]>(
        `SELECT customer_name, party_size, time, table_label, notes, customer_phone
         FROM reservations
         WHERE merchant_id = ? AND date = ? AND status = 'confirmed'
         ORDER BY time ASC`
      )
      .all(merchant.id, today)

    const appPassword = await getAPIKey(merchant.id, 'email', 'gmail')
    if (!appPassword) {
      console.warn(`[briefing] No Gmail app password for ${merchant.id} — skipping`)
      return 0
    }

    const html = buildBriefingHtml(merchant, today, reservations)
    const dateObj = new Date(today + 'T12:00:00')
    const dateLabel = dateObj.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    })
    const smtpName = merchant.business_name.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: merchant.receipt_email_from!, pass: appPassword },
    })

    await transporter.sendMail({
      from: `"${smtpName}" <${merchant.receipt_email_from}>`,
      to: merchant.email,
      subject: `Reservations for ${dateLabel} — ${reservations.length} booking${reservations.length !== 1 ? 's' : ''}`,
      html,
    })

    _lastBriefingDate = today
    console.log(
      `[briefing] Sent to ${merchant.business_name}: ${reservations.length} reservation(s) for ${today}`,
    )
    return 1
  } catch (err) {
    const isDekError = err instanceof Error && err.message.includes('Failed to decrypt DEK')
    if (isDekError) {
      // Master key mismatch — re-entering the API key in Store Profile will fix it.
      // Suppress retries until tomorrow to prevent log spam.
      _lastBriefingDate = today
      console.error(
        `[briefing] Cannot decrypt email API key for ${merchant.id} — master key mismatch. ` +
        `Re-enter the Gmail app password in Store Profile → Email Settings to re-encrypt it. ` +
        `Briefing skipped for today.`
      )
    } else {
      console.error('[briefing] Error:', err)
    }
    return 0
  } finally {
    _briefingInProgress = false
  }
}

function buildBriefingHtml(
  merchant: ReservationBriefingMerchant,
  date: string,
  reservations: ReservationRow[],
): string {
  const biz = esc(merchant.business_name)
  const dateObj = new Date(date + 'T12:00:00')
  const dateLabel = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  const totalCovers = reservations.reduce((sum, r) => sum + r.party_size, 0)

  /** Format HH:MM → h:MM AM/PM */
  const fmtTime = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    const period = h < 12 ? 'AM' : 'PM'
    const hour = h % 12 || 12
    return `${hour}:${String(m).padStart(2, '0')} ${period}`
  }

  let bodyContent: string
  if (reservations.length === 0) {
    bodyContent = `
      <tr><td style="padding:24px;text-align:center;">
        <p style="margin:0;font-size:16px;color:#888;">No reservations today.</p>
      </td></tr>`
  } else {
    const summaryBlock = `
      <tr><td style="padding:16px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:4px 0;color:#555;">Bookings</td>
            <td style="padding:4px 0;text-align:right;font-weight:bold;">${reservations.length}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#555;">Total covers</td>
            <td style="padding:4px 0;text-align:right;font-weight:bold;">${totalCovers}</td>
          </tr>
        </table>
      </td></tr>`

    const headerRow = `
      <tr style="background:#f5f5f5;">
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Time</th>
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Guest</th>
        <th style="padding:6px 8px;text-align:center;font-size:12px;">Party</th>
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Phone</th>
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Table</th>
        <th style="padding:6px 8px;text-align:left;font-size:12px;">Notes</th>
      </tr>`

    const dataRows = reservations.map(r => `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:5px 8px;font-size:12px;white-space:nowrap;">${esc(fmtTime(r.time))}</td>
        <td style="padding:5px 8px;font-size:12px;">${esc(r.customer_name)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:center;">${r.party_size}</td>
        <td style="padding:5px 8px;font-size:12px;">${r.customer_phone ? esc(r.customer_phone) : ''}</td>
        <td style="padding:5px 8px;font-size:12px;">${r.table_label ? esc(r.table_label) : ''}</td>
        <td style="padding:5px 8px;font-size:12px;color:#666;">${r.notes ? esc(r.notes) : ''}</td>
      </tr>`).join('')

    const detailBlock = `
      <tr><td style="padding:16px 24px 0;">
        <p style="margin:0 0 8px;font-weight:bold;font-size:14px;color:#333;">Reservation List</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:4px;">
          ${headerRow}${dataRows}
        </table>
      </td></tr>`

    bodyContent = summaryBlock + detailBlock
  }

  return wrapEmail(biz, dateLabel, '', bodyContent, 'Reservation Briefing')
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Start the daily closeout background check.
 * Polls every 30 minutes (coarse granularity — closeout email can arrive up to 30 min late).
 *
 * @returns cleanup function for graceful shutdown
 */
export function startDailyCloseout(): () => void {
  const INTERVAL_MS = 30 * 60_000 // 30 minutes

  // Don't run in test environment
  if (process.env.NODE_ENV === 'test') return () => {}

  /** Guard preventing overlapping ticks if async work stalls across the 30-min boundary. */
  let _closeoutRunning = false

  const handle = setInterval(() => {
    if (_closeoutRunning) {
      console.warn('[closeout] Previous interval tick still running — skipping')
      return
    }
    _closeoutRunning = true
    Promise.all([
      checkCloseouts().catch(err => {
        console.error('[closeout] Interval check failed:', err)
      }),
      checkReservationBriefings().catch(err => {
        console.error('[briefing] Interval check failed:', err)
      }),
    ]).finally(() => {
      _closeoutRunning = false
    })
  }, INTERVAL_MS)

  return () => clearInterval(handle)
}
