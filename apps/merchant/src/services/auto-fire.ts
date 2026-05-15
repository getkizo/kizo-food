/**
 * Auto-fire service
 *
 * For scheduled orders, the customer specifies when their order should be READY.
 * This service polls every 60 seconds and fires orders to the kitchen at:
 *
 *   pickup_time - prep_time_minutes
 *
 * When an order is due to fire:
 *   1. Status advances from 'submitted'|'received' → 'preparing'
 *   2. estimated_ready_at is set to pickup_time
 *   3. Kitchen ticket is printed
 *   4. SSE broadcast notifies dashboard clients
 */

import { getDatabase } from '../db/connection'
import { printKitchenTicket, course2Items, kitchenItems, nonGfItems } from './printer'
import { enrichItemsWithCategory } from '../utils/print-items'
import type { OrderItemShape } from '../utils/print-items'
import { broadcastToMerchant } from './sse'
import { logger } from '../utils/logger'

interface DueOrder {
  id: string
  merchant_id: string
  order_type: string
  customer_name: string | null
  table_label: string | null
  notes: string | null
  items: string
  pickup_time: string
  printer_ip: string | null
  kitchen_printer_protocol: string | null
  receipt_style: string | null
  merchant_name: string | null
  timezone: string | null
  created_at: string | null
}

/**
 * Run one pass: find all scheduled orders in 'submitted' or 'received' status
 * whose fire time has passed (pickup_time - prep_time_minutes <= now) and
 * advance them to 'preparing'.
 *
 * @returns number of orders fired
 */
export function checkDueOrders(): number {
  const db = getDatabase()

  const due = db
    .query<DueOrder, []>(
      `SELECT
         o.id,
         o.merchant_id,
         o.order_type,
         o.customer_name,
         o.table_label,
         o.notes,
         o.items,
         o.pickup_time,
         m.printer_ip,
         m.kitchen_printer_protocol,
         m.receipt_style,
         m.business_name AS merchant_name,
         m.timezone,
         o.created_at
       FROM orders o
       JOIN merchants m ON m.id = o.merchant_id
       WHERE o.status IN ('submitted', 'received')
         AND o.pickup_time IS NOT NULL
         AND datetime(o.pickup_time, '-' || m.prep_time_minutes || ' minutes') <= datetime('now')`
    )
    .all()

  let fired = 0

  for (const order of due) {
    try {
      // Advance status and record estimated_ready_at
      db.run(
        `UPDATE orders
         SET status = 'preparing',
             estimated_ready_at = pickup_time,
             updated_at = datetime('now')
         WHERE id = ?`,
        [order.id],
      )

      logger.info('[auto-fire]', 'Fired order', {
        orderId: order.id, merchantId: order.merchant_id, pickupTime: order.pickup_time,
      })

      // Print kitchen ticket (non-blocking, errors logged not thrown)
      if (order.printer_ip) {
        // Stored items differ by source:
        //   store orders:      { itemId, name, priceCents, modifiers, lineTotalCents }  (qty=1 per entry)
        //   dashboard orders:  { itemId, dishName, quantity, priceCents, modifiers, lineTotalCents }
        let items: Array<{
          dishName?: string
          name?: string
          quantity?: number
          priceCents?: number
          modifiers?: Array<{ name: string; priceCents: number }>
          lineTotalCents?: number
        }> = []
        try {
          items = JSON.parse(order.items ?? '[]')
        } catch (err) {
          logger.error('[auto-fire]', 'JSON.parse failed for order items', {
            orderId: order.id, raw: String(order.items).slice(0, 120), err: String(err),
          })
        }

        const printItems = items.map(item => ({
          dishName:      item.dishName ?? item.name ?? '?',
          quantity:      item.quantity ?? 1,
          priceCents:    item.priceCents ?? 0,
          modifiers:     item.modifiers ?? [],
          lineTotalCents: item.lineTotalCents,
        }))

        printKitchenTicket({
          printerIp: order.printer_ip,
          printerProtocol: (order.kitchen_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt',
          receiptStyle: (order.receipt_style ?? 'classic') as 'classic' | 'html',
          orderId: order.id,
          orderType: order.order_type,
          merchantName: order.merchant_name,
          customerName: order.customer_name,
          tableLabel: order.table_label,
          notes: order.notes,
          items: printItems,
          createdAt: order.created_at,
          scheduledFor: order.pickup_time,
          timezone: order.timezone,
        }).then(result => {
          if (result.webprntFallbackUsed) {
            broadcastToMerchant(order.merchant_id, 'printer_warning', {
              message: `WebPRNT is not enabled on your printer — printing via fallback mode. Open http://${order.printer_ip}/ in your browser to enable it (login: root / public).`,
            })
          }
        }).catch(err => {
          logger.error('[auto-fire]', 'Print failed', {
            orderId: order.id, printer: order.printer_ip,
            protocol: order.kitchen_printer_protocol, items: printItems.length,
            err: err instanceof Error ? err.message : String(err),
          })
        })
      }

      // Notify dashboard clients via SSE
      broadcastToMerchant(order.merchant_id, 'order_updated', {
        orderId: order.id,
        status: 'preparing',
      })

      fired++
    } catch (err) {
      logger.error('[auto-fire]', 'Error processing order', { orderId: order.id, err: String(err) })
    }
  }

  return fired
}

interface PendingCourseFire {
  id: string
  merchant_id: string
  order_id: string
  course: number
  printer_ip: string
  printer_protocol: string
  print_language: string | null
  ticket_type: string
  // order fields joined in
  order_type: string
  customer_name: string | null
  table_label: string | null
  room_label: string | null
  notes: string | null
  items: string
  created_at: string | null
  merchant_name: string | null
  receipt_style: string | null
}

/**
 * Run one pass: find all pending course fires whose fire_at has passed,
 * print the course-2 kitchen ticket, and mark them as fired.
 *
 * @returns number of course fires executed
 */
export function checkPendingCourseFires(): number {
  const db = getDatabase()

  const due = db
    .query<PendingCourseFire, []>(
      `SELECT
         pcf.id, pcf.merchant_id, pcf.order_id, pcf.course,
         pcf.printer_ip, pcf.printer_protocol, pcf.print_language, pcf.ticket_type,
         o.order_type, o.customer_name, o.table_label, o.room_label,
         o.notes, o.items, o.created_at,
         m.business_name AS merchant_name,
         m.receipt_style
       FROM pending_course_fires pcf
       JOIN orders o ON o.id = pcf.order_id
       JOIN merchants m ON m.id = pcf.merchant_id
       WHERE pcf.fired_at IS NULL
         AND datetime(pcf.fire_at) <= datetime('now')
         AND o.status NOT IN ('cancelled', 'picked_up', 'completed')`
    )
    .all()

  let fired = 0

  for (const pcf of due) {
    try {
      let rawItems: OrderItemShape[] = []
      try { rawItems = JSON.parse(pcf.items ?? '[]') } catch (err) {
        logger.error('[auto-fire]', 'JSON.parse failed for pending_course_fires items', {
          pcfId: pcf.id, orderId: pcf.order_id, raw: String(pcf.items).slice(0, 120), err: String(err),
        })
      }

      const allItems = enrichItemsWithCategory(rawItems)
      const itemsForCourse = pcf.ticket_type === 'non_gf'
        ? nonGfItems(kitchenItems(allItems))
        : course2Items(allItems)

      if (itemsForCourse.length === 0) {
        // Nothing to print — mark as fired and skip
        db.run(`UPDATE pending_course_fires SET fired_at = datetime('now') WHERE id = ?`, [pcf.id])
        continue
      }

      // Mark fired BEFORE dispatching the print — if the process crashes after
      // TCP connect but before the UPDATE, a restart would re-fire the same course
      // ticket (duplicate print). A missed print is recoverable via manual reprint;
      // a duplicate print is not.
      db.run(`UPDATE pending_course_fires SET fired_at = datetime('now') WHERE id = ?`, [pcf.id])

      printKitchenTicket({
        printerIp: pcf.printer_ip,
        printerProtocol: (pcf.printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt',
        receiptStyle: (pcf.receipt_style ?? 'classic') as 'classic' | 'html',
        printLanguage: pcf.print_language ?? 'en',
        orderId: pcf.order_id,
        orderType: pcf.order_type,
        merchantName: pcf.merchant_name,
        customerName: pcf.customer_name,
        tableLabel: pcf.table_label,
        roomLabel: pcf.room_label,
        notes: pcf.notes,
        items: itemsForCourse,
        createdAt: pcf.created_at,
      }).then(result => {
        db.run(`UPDATE pending_course_fires SET print_status = 'sent' WHERE id = ?`, [pcf.id])
        if (result.webprntFallbackUsed) {
          broadcastToMerchant(pcf.merchant_id, 'printer_warning', {
            message: `WebPRNT is not enabled on your printer — printing via fallback mode. Open http://${pcf.printer_ip}/ in your browser to enable it (login: root / public).`,
          })
        }
      }).catch(err => {
        logger.error('[auto-fire]', 'Course print failed', {
          pcfId: pcf.id, orderId: pcf.order_id, course: pcf.course,
          printer: pcf.printer_ip, protocol: pcf.printer_protocol, items: itemsForCourse.length,
          err: err instanceof Error ? err.message : String(err),
        })
        db.run(`UPDATE pending_course_fires SET print_status = 'failed' WHERE id = ?`, [pcf.id])
        broadcastToMerchant(pcf.merchant_id, 'printer_warning', {
          message: pcf.ticket_type === 'non_gf'
            ? `Non-GF kitchen ticket failed to print for order ${pcf.order_id} — printer=${pcf.printer_ip}. Manual reprint required.`
            : `Course ${pcf.course} kitchen ticket failed to print for order ${pcf.order_id} — printer=${pcf.printer_ip}. Manual reprint required.`,
          orderId: pcf.order_id,
          course: pcf.course,
        })
      })

      logger.info('[auto-fire]', 'Fired course ticket', { orderId: pcf.order_id, course: pcf.course, ticketType: pcf.ticket_type })

      broadcastToMerchant(pcf.merchant_id, 'order_updated', {
        orderId: pcf.order_id,
        courseFired: pcf.course,
      })

      fired++
    } catch (err) {
      logger.error('[auto-fire]', 'Error processing course fire', { pcfId: pcf.id, err: String(err) })
    }
  }

  return fired
}

// ---------------------------------------------------------------------------
// STALE-1: Cancel abandoned online orders
//
// Online orders enter 'received' status at creation (pre-payment). If the
// customer never completes payment (closes browser, card declined + gives up,
// etc.), the order sits in 'received' forever. This pass deletes those rows
// after 30 minutes — long enough for slow payment processors, short enough
// to keep the dashboard clean. Only online-source orders are affected;
// in-person / dashboard orders in 'received' are left alone.
// ---------------------------------------------------------------------------

const STALE_ORDER_AGE_MINUTES = 30

/**
 * Delete online orders stuck in 'received' or 'pending_payment' status for
 * longer than {@link STALE_ORDER_AGE_MINUTES}. These have no completed payment
 * and will never transition — safe to remove.
 *
 * NOTE: paid orders transition to 'submitted', so they are never affected.
 *
 * @returns number of stale orders deleted
 */
export function cleanupStaleOrders(): number {
  const db = getDatabase()

  // Delete orphaned pending_course_fires rows for cancelled orders.
  // These are never fired (checkPendingCourseFires skips cancelled orders)
  // but without explicit cleanup they accumulate and are never GC'd by
  // cleanupFiredCourses() (which only removes rows with fired_at IS NOT NULL).
  db.run(
    `DELETE FROM pending_course_fires
     WHERE order_id IN (
       SELECT id FROM orders WHERE status = 'cancelled'
     )`
  )

  const result = db.run(
    `DELETE FROM orders
     WHERE status IN ('received', 'pending_payment')
       AND source = 'online'
       AND created_at < datetime('now', '-${STALE_ORDER_AGE_MINUTES} minutes')`,
  ) as { changes: number }
  const count = result.changes ?? 0
  if (count > 0) {
    logger.info('[auto-fire]', 'Cleaned up stale unpaid orders', { count })
  }
  return count
}

// ---------------------------------------------------------------------------
// Reservation reminders — SSE alerts at 60 min and 15 min before reservation
// ---------------------------------------------------------------------------

/** Dedup set: entries are `${reservationId}:60` or `${reservationId}:15` */
const _reminderSent = new Set<string>()

/** Track which UTC date was last used to clear dedup set (reset at midnight) */
let _reminderClearDate: string | null = null

/**
 * Run one pass: find reservations due in the next 60 minutes (or next 15 minutes)
 * and broadcast a `reservation_reminder` SSE event to the dashboard — once per mark.
 *
 * Dedup is in-memory; entries clear at the start of each new UTC day.
 */
export function checkReservationReminders(): void {
  const db = getDatabase()

  // Reset dedup set at the start of each new day
  const todayUtc = new Date().toISOString().slice(0, 10)
  if (_reminderClearDate !== todayUtc) {
    _reminderClearDate = todayUtc
    _reminderSent.clear()
  }

  type ResRow = {
    id: string
    merchant_id: string
    customer_name: string
    party_size: number
    date: string
    time: string
    table_label: string | null
    timezone: string | null
  }

  // Fetch all confirmed reservations for today (merchant local date) from all merchants.
  // We join merchants to get timezone for proper local-time comparison.
  // SQLite datetime('now') is UTC — convert reservation datetime to UTC for comparison.
  // Simpler: fetch reservations for today (UTC date) or tomorrow (UTC date) and filter in JS.
  const now = new Date()
  const todayUtcDate = now.toISOString().slice(0, 10)
  // Also include tomorrow's date to catch near-midnight reservations
  const tomorrow = new Date(now)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowUtcDate = tomorrow.toISOString().slice(0, 10)

  const rows = db
    .query<ResRow, [string, string]>(
      `SELECT r.id, r.merchant_id, r.customer_name, r.party_size, r.date, r.time,
              r.table_label, m.timezone
       FROM reservations r
       JOIN merchants m ON m.id = r.merchant_id
       WHERE r.status = 'confirmed'
         AND r.date IN (?, ?)
       ORDER BY r.date, r.time`
    )
    .all(todayUtcDate, tomorrowUtcDate)

  for (const res of rows) {
    try {
      const tz = res.timezone ?? 'America/Los_Angeles'

      // Parse reservation datetime in merchant's local timezone
      // We approximate by converting the merchant's "local now" to minutes-of-day
      const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }))
      const localNowMinutes = localNow.getHours() * 60 + localNow.getMinutes()

      // Parse today's local date for the merchant
      const localTodayStr = localNow.toLocaleDateString('en-CA') // YYYY-MM-DD

      // Only process reservations for today in merchant's local time
      if (res.date !== localTodayStr) continue

      const [rh, rm] = res.time.split(':').map(Number)
      const resMinutes = rh * 60 + rm
      const minutesUntil = resMinutes - localNowMinutes

      // Check 60-minute mark: within [58, 62] minutes
      const key60 = `${res.id}:60`
      if (minutesUntil >= 58 && minutesUntil <= 62 && !_reminderSent.has(key60)) {
        _reminderSent.add(key60)
        broadcastToMerchant(res.merchant_id, 'reservation_reminder', {
          reservationId: res.id,
          customerName: res.customer_name,
          partySize: res.party_size,
          time: res.time,
          tableLabel: res.table_label,
          minutesUntil: Math.round(minutesUntil),
          mark: 60,
        })
        logger.info('[auto-fire]', 'Reservation reminder sent', { reservationId: res.id, customerName: res.customer_name, time: res.time, mark: 60 })
      }

      // Check 15-minute mark: within [13, 17] minutes
      const key15 = `${res.id}:15`
      if (minutesUntil >= 13 && minutesUntil <= 17 && !_reminderSent.has(key15)) {
        _reminderSent.add(key15)
        broadcastToMerchant(res.merchant_id, 'reservation_reminder', {
          reservationId: res.id,
          customerName: res.customer_name,
          partySize: res.party_size,
          time: res.time,
          tableLabel: res.table_label,
          minutesUntil: Math.round(minutesUntil),
          mark: 15,
        })
        logger.info('[auto-fire]', 'Reservation reminder sent', { reservationId: res.id, customerName: res.customer_name, time: res.time, mark: 15 })
      }
    } catch (err) {
      logger.error('[auto-fire]', 'Error processing reservation reminder', { reservationId: res.id, err: String(err) })
    }
  }
}

// Module-level timestamp tracking last cleanup run (avoids repeated cleanup each poll cycle)
let _lastCourseFireCleanup: number | null = null

/** Guard preventing overlapping interval ticks if a sync DB call stalls the event loop. */
let _autoFireRunning = false
const COURSE_FIRE_CLEANUP_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Delete `pending_course_fires` rows that were fired more than 30 days ago.
 * Runs at most once every 30 days (module-level gate).
 */
export function checkAdvanceOrderReminders(): void {
  const db = getDatabase()

  type AoReminderRow = {
    id: string
    merchant_id: string
    customer_name: string
    customer_phone: string | null
    scheduled_for: string
    reminder_24h_fired: number
    reminder_day_fired: number
    timezone: string | null
  }

  const now = new Date()
  // Fetch pending orders within the next 48 h that still need a reminder fired.
  // 48-hour window catches: 24h-before reminder (fires at T-24h) and
  // same-day 9 AM reminder (fires on the day of, at or after 09:00 local).
  const lookaheadUtc = new Date(now.getTime() + 48 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  const rows = db.query<AoReminderRow, [string]>(
    `SELECT ao.id, ao.merchant_id, ao.customer_name, ao.customer_phone, ao.scheduled_for,
            ao.reminder_24h_fired, ao.reminder_day_fired, m.timezone
     FROM advance_orders ao
     JOIN merchants m ON m.id = ao.merchant_id
     WHERE ao.status = 'pending'
       AND ao.scheduled_for >= datetime('now')
       AND ao.scheduled_for <= ?
       AND (ao.reminder_24h_fired = 0 OR ao.reminder_day_fired = 0)
     ORDER BY ao.scheduled_for ASC`
  ).all(lookaheadUtc)

  for (const row of rows) {
    try {
      const tz = row.timezone ?? 'America/Los_Angeles'
      const scheduledUtc = new Date(
        row.scheduled_for.endsWith('Z') || row.scheduled_for.includes('+')
          ? row.scheduled_for : row.scheduled_for + 'Z'
      )

      // ── 24-hour reminder ───────────────────────────────────────────────────
      if (row.reminder_24h_fired === 0) {
        const reminderAt = new Date(scheduledUtc.getTime() - 24 * 60 * 60 * 1000)
        if (now >= reminderAt) {
          db.run(`UPDATE advance_orders SET reminder_24h_fired = 1 WHERE id = ?`, [row.id])
          const scheduledLabel = scheduledUtc.toLocaleString('en-US', {
            timeZone: tz, month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
          })
          broadcastToMerchant(row.merchant_id, 'advance_order_reminder', {
            aoId:           row.id,
            customerName:   row.customer_name,
            customerPhone:  row.customer_phone,
            scheduledFor:   row.scheduled_for,
            scheduledLabel,
            mark:           '24h',
          })
          logger.info('[auto-fire]', 'Advance order 24h reminder sent', {
            aoId: row.id, customerName: row.customer_name, scheduledFor: row.scheduled_for,
          })
        }
      }

      // ── Day-of 9 AM reminder ───────────────────────────────────────────────
      if (row.reminder_day_fired === 0) {
        const localNow       = new Date(now.toLocaleString('en-US', { timeZone: tz }))
        const localNowDate   = localNow.toLocaleDateString('en-CA')           // YYYY-MM-DD
        const localScheduled = new Date(scheduledUtc.toLocaleString('en-US', { timeZone: tz }))
        const localSchedDate = localScheduled.toLocaleDateString('en-CA')
        const localHour      = localNow.getHours() + localNow.getMinutes() / 60

        if (localNowDate === localSchedDate && localHour >= 9) {
          db.run(`UPDATE advance_orders SET reminder_day_fired = 1 WHERE id = ?`, [row.id])
          const scheduledLabel = scheduledUtc.toLocaleString('en-US', {
            timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
          })
          broadcastToMerchant(row.merchant_id, 'advance_order_reminder', {
            aoId:           row.id,
            customerName:   row.customer_name,
            customerPhone:  row.customer_phone,
            scheduledFor:   row.scheduled_for,
            scheduledLabel,
            mark:           'day',
          })
          logger.info('[auto-fire]', 'Advance order day-of reminder sent', {
            aoId: row.id, customerName: row.customer_name, scheduledFor: row.scheduled_for,
          })
        }
      }
    } catch (err) {
      logger.error('[auto-fire]', 'Error processing advance order reminder', {
        aoId: row.id, err: String(err),
      })
    }
  }
}

function cleanupFiredCourses(): void {
  if (_lastCourseFireCleanup !== null &&
      Date.now() - _lastCourseFireCleanup < COURSE_FIRE_CLEANUP_INTERVAL_MS) {
    return
  }
  _lastCourseFireCleanup = Date.now()
  const db = getDatabase()
  const result = db.run(
    `DELETE FROM pending_course_fires
     WHERE fired_at IS NOT NULL
       AND fired_at < datetime('now', '-30 days')`
  ) as { changes: number }
  if (result.changes > 0) {
    logger.info('[auto-fire]', 'Cleaned up old pending_course_fires rows', { count: result.changes })
  }
}

/**
 * Start the auto-fire background check.
 * Runs once immediately on startup, then every 60 seconds.
 *
 * @returns a zero-argument cleanup function — call it on graceful shutdown to
 *          stop the interval. Consistent with the `startAutoResetOos` contract.
 */
export function startAutoFire(): () => void {
  const INTERVAL_MS = 60_000 // 60 seconds

  // Immediate first run to catch anything missed before restart
  try {
    checkDueOrders()
    checkPendingCourseFires()
    cleanupFiredCourses()
    cleanupStaleOrders()
    checkReservationReminders()
    checkAdvanceOrderReminders()
  } catch (err) {
    logger.error('[auto-fire]', 'Startup check failed (will retry on next interval)', { err: String(err) })
  }

  const handle = setInterval(() => {
    if (_autoFireRunning) {
      logger.warn('[auto-fire]', 'Previous interval tick still running — skipping')
      return
    }
    _autoFireRunning = true
    try {
      checkDueOrders()
      checkPendingCourseFires()
      cleanupFiredCourses()
      cleanupStaleOrders()
      checkReservationReminders()
    } catch (err) {
      logger.error('[auto-fire]', 'Interval check failed', { err: String(err) })
    } finally {
      _autoFireRunning = false
    }
  }, INTERVAL_MS)

  return () => clearInterval(handle)
}
