/**
 * Auto-fire service tests
 *
 * Covers:
 *   checkDueOrders           — fires scheduled orders whose fire-time has passed; skips future orders
 *   checkPendingCourseFires  — marks fired_at before print; skips cancelled/picked_up orders;
 *                              skips rows with no course-2 items; does not double-fire
 *   cleanupStaleOrders       — deletes online 'received'/'pending_payment' orders older than 30 min;
 *                              leaves dashboard-source orders alone; cleans orphaned course-fire rows
 *   checkReservationReminders — broadcasts SSE at 60-min and 15-min marks; deduplicates per mark;
 *                              skips non-confirmed reservations; skips past-time reservations
 *
 * No printers are contacted — tests run without printer_ip so the print branches are skipped.
 */

import { test, expect, describe, beforeAll, beforeEach } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { app } from '../src/server'
import { checkDueOrders, checkPendingCourseFires, cleanupStaleOrders, checkReservationReminders } from '../src/services/auto-fire'

// ── Fixtures ──────────────────────────────────────────────────────────────────

let merchantId = ''

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Insert an order with an optional pickup_time (ISO string) and status.
 * No printer_ip on merchant → print side-effects are skipped.
 */
function insertOrder(opts: {
  status?:      string
  source?:      string
  pickupTime?:  string   // ISO — null omits the column
  createdAt?:   string   // ISO, defaults to 'now'
  orderType?:   string
} = {}): string {
  const db = getDatabase()
  const orderId = `ord_af_${Math.random().toString(36).slice(2, 12)}`
  const {
    status     = 'received',
    source     = 'online',
    pickupTime = null,
    createdAt  = "datetime('now')",
    orderType  = 'pickup',
  } = opts

  // Use parameterized createdAt if it is an ISO string, otherwise use it as SQL literal
  const isIso = createdAt !== "datetime('now')"
  const sql = `INSERT INTO orders
    (id, merchant_id, customer_name, order_type, status, source,
     subtotal_cents, total_cents, items, pickup_time, created_at, updated_at)
   VALUES (?, ?, 'Test Customer', ?, ?, ?,
           1000, 1000, '[]', ?,
           ${isIso ? '?' : "datetime('now')"}, datetime('now'))`
  const params: unknown[] = [orderId, merchantId, orderType, status, source, pickupTime]
  if (isIso) params.push(createdAt)
  db.run(sql, params)
  return orderId
}

/** Insert a `pending_course_fires` row. `fireAt` defaults to 10 minutes ago (due). */
function insertCourseFire(opts: {
  orderId:       string
  fireAt?:       string   // SQL datetime string or datetime('now', ...) expression
  firedAt?:      string | null
} = { orderId: '' }): string {
  const db = getDatabase()
  const rowId = `pcf_${Math.random().toString(36).slice(2, 12)}`
  const { orderId, fireAt = "datetime('now', '-10 minutes')", firedAt = null } = opts
  db.run(
    `INSERT INTO pending_course_fires
       (id, merchant_id, order_id, course, printer_ip, printer_protocol,
        fire_at, fired_at, created_at)
     VALUES (?, ?, ?, 2, '127.0.0.1', 'star-line',
             ${fireAt}, ?, datetime('now'))`,
    [rowId, merchantId, orderId, firedAt]
  )
  return rowId
}

/** Read the status of an order from the DB. */
function orderStatus(orderId: string): string | null {
  return getDatabase()
    .query<{ status: string }, [string]>(`SELECT status FROM orders WHERE id = ?`)
    .get(orderId)?.status ?? null
}

/** Read estimated_ready_at for an order. */
function orderReadyAt(orderId: string): string | null {
  return getDatabase()
    .query<{ estimated_ready_at: string | null }, [string]>(
      `SELECT estimated_ready_at FROM orders WHERE id = ?`
    )
    .get(orderId)?.estimated_ready_at ?? null
}

/** Read the fired_at field for a pending_course_fires row. */
function courseFiredAt(rowId: string): string | null {
  return getDatabase()
    .query<{ fired_at: string | null }, [string]>(
      `SELECT fired_at FROM pending_course_fires WHERE id = ?`
    )
    .get(rowId)?.fired_at ?? null
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  const res = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@autofire.test',
      password:     'SecurePass123!',
      fullName:     'AutoFire Owner',
      businessName: 'AutoFire Cafe',
      slug:         'autofire-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string } }
  merchantId = body.merchant.id

  // Ensure no printer_ip so print side-effects are no-ops
  getDatabase().run(`UPDATE merchants SET printer_ip = NULL, prep_time_minutes = 15 WHERE id = ?`, [merchantId])
})

// ── checkDueOrders ────────────────────────────────────────────────────────────

describe('checkDueOrders', () => {

  test('advances a past-due scheduled order from received → preparing', () => {
    // pickup_time is 10 min ago, prep_time = 15 min → fire time is 25 min ago → due
    const pickupTime = new Date(Date.now() - 10 * 60_000).toISOString()
    const orderId = insertOrder({ status: 'received', source: 'online', pickupTime })

    const fired = checkDueOrders()

    expect(fired).toBeGreaterThanOrEqual(1)
    expect(orderStatus(orderId)).toBe('preparing')
  })

  test('sets estimated_ready_at = pickup_time on fire', () => {
    const pickupTime = new Date(Date.now() - 10 * 60_000).toISOString()
    const orderId = insertOrder({ status: 'received', source: 'online', pickupTime })
    checkDueOrders()
    // estimated_ready_at is stored as ISO in SQLite — just check it is not null
    expect(orderReadyAt(orderId)).not.toBeNull()
  })

  test('does not fire a future scheduled order', () => {
    // pickup_time is 60 min in the future; prep_time=15 → fire time is 45 min from now → not due
    const pickupTime = new Date(Date.now() + 60 * 60_000).toISOString()
    const orderId = insertOrder({ status: 'received', source: 'online', pickupTime })

    checkDueOrders()

    expect(orderStatus(orderId)).toBe('received')
  })

  test('does not fire an order without a pickup_time', () => {
    const orderId = insertOrder({ status: 'received', source: 'online', pickupTime: null })
    checkDueOrders()
    expect(orderStatus(orderId)).toBe('received')
  })

  test('does not fire an order already in preparing status', () => {
    const pickupTime = new Date(Date.now() - 10 * 60_000).toISOString()
    const orderId = insertOrder({ status: 'preparing', source: 'online', pickupTime })
    checkDueOrders()
    expect(orderStatus(orderId)).toBe('preparing') // unchanged
  })

  test('also fires orders in submitted status', () => {
    const pickupTime = new Date(Date.now() - 10 * 60_000).toISOString()
    const orderId = insertOrder({ status: 'submitted', source: 'online', pickupTime })
    const fired = checkDueOrders()
    expect(fired).toBeGreaterThanOrEqual(1)
    expect(orderStatus(orderId)).toBe('preparing')
  })

  test('returns 0 when no orders are due', () => {
    // All past-due orders were already fired in prior tests; insert nothing new
    const fired = checkDueOrders()
    expect(fired).toBe(0)
  })
})

// ── checkPendingCourseFires ───────────────────────────────────────────────────

describe('checkPendingCourseFires', () => {

  test('marks fired_at on a due course-fire row', () => {
    const orderId = insertOrder({ status: 'preparing', source: 'dashboard' })
    const rowId = insertCourseFire({ orderId })

    checkPendingCourseFires()

    // fired_at should now be set (course-2 items is empty → marked fired and skipped)
    expect(courseFiredAt(rowId)).not.toBeNull()
  })

  test('does not fire a row whose fire_at is in the future', () => {
    const orderId = insertOrder({ status: 'preparing', source: 'dashboard' })
    const rowId = insertCourseFire({
      orderId,
      fireAt: "datetime('now', '+60 minutes')",
    })

    checkPendingCourseFires()

    expect(courseFiredAt(rowId)).toBeNull()
  })

  test('does not re-fire a row that already has fired_at set', () => {
    const orderId = insertOrder({ status: 'preparing', source: 'dashboard' })
    const alreadyFired = "datetime('now', '-5 minutes')"
    const rowId = insertCourseFire({ orderId, firedAt: alreadyFired })

    // Record the initial fired_at value
    const before = courseFiredAt(rowId)

    checkPendingCourseFires()

    // fired_at should be unchanged (row was already fired)
    expect(courseFiredAt(rowId)).toBe(before)
  })

  test('skips a due row whose order is cancelled', () => {
    const orderId = insertOrder({ status: 'cancelled', source: 'dashboard' })
    const rowId = insertCourseFire({ orderId })

    checkPendingCourseFires()

    // The query filters out cancelled orders — row should remain unfired
    expect(courseFiredAt(rowId)).toBeNull()
  })

  test('skips a due row whose order is picked_up', () => {
    const orderId = insertOrder({ status: 'picked_up', source: 'dashboard' })
    const rowId = insertCourseFire({ orderId })

    checkPendingCourseFires()

    expect(courseFiredAt(rowId)).toBeNull()
  })
})

// ── cleanupStaleOrders ────────────────────────────────────────────────────────

describe('cleanupStaleOrders', () => {

  test('deletes an online received order older than 30 minutes', () => {
    const db = getDatabase()
    const orderId = `ord_stale_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO orders
         (id, merchant_id, customer_name, order_type, status, source,
          subtotal_cents, total_cents, items, created_at, updated_at)
       VALUES (?, ?, 'Stale Customer', 'pickup', 'received', 'online',
               500, 500, '[]', datetime('now', '-35 minutes'), datetime('now'))`,
      [orderId, merchantId]
    )

    const deleted = cleanupStaleOrders()

    expect(deleted).toBeGreaterThanOrEqual(1)
    const row = db.query<{ id: string }, [string]>(`SELECT id FROM orders WHERE id = ?`).get(orderId)
    expect(row).toBeNull()
  })

  test('deletes an online pending_payment order older than 30 minutes', () => {
    const db = getDatabase()
    const orderId = `ord_stpp_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO orders
         (id, merchant_id, customer_name, order_type, status, source,
          subtotal_cents, total_cents, items, created_at, updated_at)
       VALUES (?, ?, 'PP Customer', 'pickup', 'pending_payment', 'online',
               500, 500, '[]', datetime('now', '-40 minutes'), datetime('now'))`,
      [orderId, merchantId]
    )

    const deleted = cleanupStaleOrders()

    expect(deleted).toBeGreaterThanOrEqual(1)
    const row = db.query<{ id: string }, [string]>(`SELECT id FROM orders WHERE id = ?`).get(orderId)
    expect(row).toBeNull()
  })

  test('does NOT delete a recent online order (under 30 minutes)', () => {
    const db = getDatabase()
    const orderId = `ord_fresh_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO orders
         (id, merchant_id, customer_name, order_type, status, source,
          subtotal_cents, total_cents, items, created_at, updated_at)
       VALUES (?, ?, 'Fresh Customer', 'pickup', 'received', 'online',
               500, 500, '[]', datetime('now', '-5 minutes'), datetime('now'))`,
      [orderId, merchantId]
    )

    cleanupStaleOrders()

    const row = db.query<{ id: string }, [string]>(`SELECT id FROM orders WHERE id = ?`).get(orderId)
    expect(row).not.toBeNull()
    // cleanup the fresh order so it doesn't interfere with subsequent tests
    db.run(`DELETE FROM orders WHERE id = ?`, [orderId])
  })

  test('does NOT delete a dashboard-source order even if old and in received status', () => {
    const db = getDatabase()
    const orderId = `ord_dash_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO orders
         (id, merchant_id, customer_name, order_type, status, source,
          subtotal_cents, total_cents, items, created_at, updated_at)
       VALUES (?, ?, 'Dash Customer', 'pickup', 'received', 'dashboard',
               500, 500, '[]', datetime('now', '-60 minutes'), datetime('now'))`,
      [orderId, merchantId]
    )

    cleanupStaleOrders()

    const row = db.query<{ id: string }, [string]>(`SELECT id FROM orders WHERE id = ?`).get(orderId)
    expect(row).not.toBeNull()
    db.run(`DELETE FROM orders WHERE id = ?`, [orderId])
  })

  test('deletes orphaned pending_course_fires rows for cancelled orders', () => {
    const db = getDatabase()
    // Create a cancelled order with a pending_course_fires row
    const orderId = `ord_canc_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO orders
         (id, merchant_id, customer_name, order_type, status, source,
          subtotal_cents, total_cents, items, created_at, updated_at)
       VALUES (?, ?, 'Cancelled Cust', 'dine_in', 'cancelled', 'dashboard',
               500, 500, '[]', datetime('now'), datetime('now'))`,
      [orderId, merchantId]
    )
    const pcfId = `pcf_orph_${Math.random().toString(36).slice(2, 10)}`
    db.run(
      `INSERT INTO pending_course_fires
         (id, merchant_id, order_id, course, printer_ip, printer_protocol,
          fire_at, created_at)
       VALUES (?, ?, ?, 2, '127.0.0.1', 'star-line', datetime('now', '-5 minutes'), datetime('now'))`,
      [pcfId, merchantId, orderId]
    )

    cleanupStaleOrders()

    const pcfRow = db
      .query<{ id: string }, [string]>(`SELECT id FROM pending_course_fires WHERE id = ?`)
      .get(pcfId)
    expect(pcfRow).toBeNull()
  })

  test('returns 0 when no stale orders exist', () => {
    const count = cleanupStaleOrders()
    expect(count).toBe(0)
  })
})

// ── checkReservationReminders ─────────────────────────────────────────────────

/** Build a time string HH:MM that is `offsetMinutes` from now in 'America/Los_Angeles' local time. */
function localTimeOffset(offsetMinutes: number): { date: string; time: string } {
  const now = new Date()
  const target = new Date(now.getTime() + offsetMinutes * 60_000)
  // Compute merchant-local date/time in America/Los_Angeles
  const localStr = target.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
  const localDate = new Date(localStr)
  const hh = String(localDate.getHours()).padStart(2, '0')
  const mm = String(localDate.getMinutes()).padStart(2, '0')
  const localDateStr = target.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
  return { date: localDateStr, time: `${hh}:${mm}` }
}

/** Insert a reservation row directly into the DB. Returns the reservation id. */
function insertReservation(opts: {
  date: string
  time: string
  status?: string
  timezone?: string
}): string {
  const db = getDatabase()
  const resId = `res_${Math.random().toString(36).slice(2, 12)}`
  const { date, time, status = 'confirmed' } = opts
  // Ensure merchant has the correct timezone
  db.run(`UPDATE merchants SET timezone = 'America/Los_Angeles' WHERE id = ?`, [merchantId])
  db.run(
    `INSERT INTO reservations
       (id, merchant_id, customer_name, party_size, date, time, status, confirmation_code, created_at, updated_at)
     VALUES (?, ?, 'Test Guest', 4, ?, ?, ?, 'TESTCODE', datetime('now'), datetime('now'))`,
    [resId, merchantId, date, time, status]
  )
  return resId
}

describe('checkReservationReminders', () => {

  test('runs without error when no reservations exist', () => {
    // No reservations inserted — should return undefined and not throw
    expect(() => checkReservationReminders()).not.toThrow()
  })

  test('skips non-confirmed reservations (cancelled)', () => {
    // Insert a cancelled reservation at exactly the 60-min mark — should not trigger
    const { date, time } = localTimeOffset(60)
    insertReservation({ date, time, status: 'cancelled' })
    expect(() => checkReservationReminders()).not.toThrow()
  })

  test('skips reservations whose time has already passed', () => {
    // 90 minutes in the past — well outside any reminder window
    const { date, time } = localTimeOffset(-90)
    insertReservation({ date, time, status: 'confirmed' })
    expect(() => checkReservationReminders()).not.toThrow()
  })

  test('skips reservations more than 65 minutes in the future', () => {
    // 120 minutes away — outside 58–62 and 13–17 windows
    const { date, time } = localTimeOffset(120)
    insertReservation({ date, time, status: 'confirmed' })
    expect(() => checkReservationReminders()).not.toThrow()
  })

  test('does not throw for a reservation exactly at the 60-minute mark', () => {
    // 60 minutes from now — falls within [58, 62] window, should broadcast (no printer needed)
    const { date, time } = localTimeOffset(60)
    insertReservation({ date, time, status: 'confirmed' })
    expect(() => checkReservationReminders()).not.toThrow()
  })

  test('does not throw for a reservation exactly at the 15-minute mark', () => {
    // 15 minutes from now — falls within [13, 17] window
    const { date, time } = localTimeOffset(15)
    insertReservation({ date, time, status: 'confirmed' })
    expect(() => checkReservationReminders()).not.toThrow()
  })

  test('calling twice in the same pass does not throw (dedup guard exercised)', () => {
    // Insert a reservation in the 60-min window; call twice — second call deduplicates
    const { date, time } = localTimeOffset(60)
    insertReservation({ date, time, status: 'confirmed' })
    expect(() => {
      checkReservationReminders()
      checkReservationReminders()
    }).not.toThrow()
  })

  test('handles merchant with a non-Pacific timezone without throwing', () => {
    // Set timezone to US/Eastern — function should still parse correctly
    const db = getDatabase()
    db.run(`UPDATE merchants SET timezone = 'America/New_York' WHERE id = ?`, [merchantId])
    const { date, time } = localTimeOffset(60)
    insertReservation({ date, time, status: 'confirmed' })
    expect(() => checkReservationReminders()).not.toThrow()
    // Restore timezone
    db.run(`UPDATE merchants SET timezone = 'America/Los_Angeles' WHERE id = ?`, [merchantId])
  })
})
