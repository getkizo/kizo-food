/**
 * Auto-reset OOS service tests
 *
 * Covers:
 *  - runResetForMerchant: resets out_today items + modifiers, leaves out_indefinitely, returns counts
 *  - checkOosResets: timing guard (before / after resetAfter), deduplication, per-merchant isolation
 *  - checkOosResets: business hours path (60 min after close_time)
 *  - checkOosResets: 02:00 fallback when no hours or on a scheduled closure day
 *  - checkOosResets: skips non-active merchants
 *  - resetOosState: clears dedup map, allowing re-reset on same local day
 *
 * Time is controlled by replacing globalThis.Date with a subclass that returns
 * a fixed timestamp — this propagates into Intl.DateTimeFormat.format(new Date())
 * calls inside the service without touching the original Date constructor.
 */

import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { app } from '../src/server'
import { checkOosResets, runResetForMerchant, resetOosState } from '../src/services/auto-reset-oos'

// ── Time mock ─────────────────────────────────────────────────────────────────

const _OrigDate = globalThis.Date

/**
 * Replace globalThis.Date with a subclass frozen at `isoString`.
 * `new Date()` (no-args) → frozen timestamp; `new Date(value)` → normal.
 * Intl.DateTimeFormat.format(new Date()) will see the frozen timestamp.
 */
function mockDate(isoString: string): void {
  const ms = _OrigDate.parse(isoString)
  // @ts-ignore — intentional test-only monkey-patch
  globalThis.Date = class MockDate extends _OrigDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(ms)
      // @ts-ignore
      else super(...args)
    }
    static now(): number { return ms }
    static parse(s: string): number { return _OrigDate.parse(s) }
    static UTC(...args: number[]): number { return _OrigDate.UTC(...args) }
  }
}

function restoreDate(): void {
  globalThis.Date = _OrigDate
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let merchantId = ''
let categoryId = ''
let itemId = ''
let modGroupId = ''
let modId = ''

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Insert a business_hours row for this merchant on a specific DOW.
 * Deletes any existing row for that service_type + day_of_week first.
 */
function setBusinessHours(closeTime: string, dow: number): void {
  const db = getDatabase()
  db.run(
    `DELETE FROM business_hours
     WHERE merchant_id = ? AND service_type = 'regular' AND day_of_week = ?`,
    [merchantId, dow],
  )
  const id = `bh_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO business_hours
       (id, merchant_id, service_type, day_of_week, open_time, close_time, slot_index, is_closed, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [id, merchantId, 'regular', dow, '09:00', closeTime, 0, 0],
  )
}

function clearBusinessHours(): void {
  getDatabase().run(`DELETE FROM business_hours WHERE merchant_id = ?`, [merchantId])
}

function addScheduledClosure(dateStr: string): void {
  const db = getDatabase()
  const id = `sc_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO scheduled_closures
       (id, merchant_id, start_date, end_date, label, created_at, updated_at)
     VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`,
    [id, merchantId, dateStr, dateStr, 'Test closure'],
  )
}

function clearClosures(): void {
  getDatabase().run(`DELETE FROM scheduled_closures WHERE merchant_id = ?`, [merchantId])
}

function setItemStatus(status: string): void {
  getDatabase().run(`UPDATE menu_items SET stock_status = ? WHERE id = ?`, [status, itemId])
}

function setModStatus(status: string): void {
  getDatabase().run(`UPDATE modifiers SET stock_status = ? WHERE id = ?`, [status, modId])
}

function getItemStatus(): string {
  return getDatabase()
    .query<{ stock_status: string }, [string]>(
      `SELECT stock_status FROM menu_items WHERE id = ?`,
    )
    .get(itemId)?.stock_status ?? 'null'
}

function getModStatus(): string {
  return getDatabase()
    .query<{ stock_status: string }, [string]>(
      `SELECT stock_status FROM modifiers WHERE id = ?`,
    )
    .get(modId)?.stock_status ?? 'null'
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@oos.test',
      password:     'SecurePass123!',
      fullName:     'OOS Owner',
      businessName: 'OOS Cafe',
      slug:         'oos-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string } }
  merchantId = body.merchant.id

  // Pin timezone to UTC so date/time assertions are deterministic
  getDatabase().run(`UPDATE merchants SET timezone = 'UTC' WHERE id = ?`, [merchantId])

  // Seed a category + item
  categoryId = `cat_oos_${Math.random().toString(36).slice(2, 8)}`
  getDatabase().run(
    `INSERT INTO menu_categories (id, merchant_id, name, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,datetime('now'),datetime('now'))`,
    [categoryId, merchantId, 'Mains', 1],
  )

  itemId = `item_oos_${Math.random().toString(36).slice(2, 8)}`
  getDatabase().run(
    `INSERT INTO menu_items
       (id, merchant_id, category_id, name, price_cents, is_available, stock_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [itemId, merchantId, categoryId, 'Pad Thai', 1400, 1, 'in_stock'],
  )

  // Seed a modifier group + modifier
  modGroupId = `mg_oos_${Math.random().toString(36).slice(2, 8)}`
  getDatabase().run(
    `INSERT INTO modifier_groups (id, merchant_id, name, min_required, max_allowed, is_mandatory, created_at, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [modGroupId, merchantId, 'Spice Level', 0, 1, 0],
  )

  modId = `mod_oos_${Math.random().toString(36).slice(2, 8)}`
  getDatabase().run(
    `INSERT INTO modifiers (id, group_id, name, price_cents, is_available, stock_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [modId, modGroupId, 'Mild', 0, 1, 'in_stock'],
  )
})

beforeEach(() => {
  resetOosState()
  clearBusinessHours()
  clearClosures()
  setItemStatus('in_stock')
  setModStatus('in_stock')
  restoreDate()
})

afterEach(() => {
  restoreDate()
})

// ── runResetForMerchant ───────────────────────────────────────────────────────

describe('runResetForMerchant', () => {
  test('resets out_today item back to in_stock', () => {
    setItemStatus('out_today')
    runResetForMerchant(merchantId)
    expect(getItemStatus()).toBe('in_stock')
  })

  test('resets out_today modifier back to in_stock', () => {
    setModStatus('out_today')
    runResetForMerchant(merchantId)
    expect(getModStatus()).toBe('in_stock')
  })

  test('leaves out_indefinitely item untouched', () => {
    setItemStatus('out_indefinitely')
    runResetForMerchant(merchantId)
    expect(getItemStatus()).toBe('out_indefinitely')
  })

  test('leaves out_indefinitely modifier untouched', () => {
    setModStatus('out_indefinitely')
    runResetForMerchant(merchantId)
    expect(getModStatus()).toBe('out_indefinitely')
  })

  test('returns correct change counts when items and modifiers are out_today', () => {
    setItemStatus('out_today')
    setModStatus('out_today')
    const { items, modifiers } = runResetForMerchant(merchantId)
    expect(items).toBe(1)
    expect(modifiers).toBe(1)
  })

  test('returns zero counts when nothing is out_today', () => {
    // beforeEach resets both to in_stock
    const { items, modifiers } = runResetForMerchant(merchantId)
    expect(items).toBe(0)
    expect(modifiers).toBe(0)
  })
})

// ── checkOosResets — 02:00 fallback (no business hours) ──────────────────────

describe('checkOosResets — 02:00 fallback (no business hours configured)', () => {
  // All tests in this block use the no-hours fallback (resetAfter = 02:00 UTC)
  // Merchant timezone is UTC, so 2026-03-20T03:00:00Z → local time "03:00" > "02:00"
  // and 2026-03-20T01:00:00Z → local time "01:00" < "02:00"

  test('fires reset when local time is past 02:00 fallback', () => {
    setItemStatus('out_today')
    mockDate('2026-03-20T03:00:00Z')

    const count = checkOosResets()
    expect(count).toBe(1)
    expect(getItemStatus()).toBe('in_stock')
  })

  test('does not fire reset when local time is before 02:00 fallback', () => {
    setItemStatus('out_today')
    mockDate('2026-03-20T01:00:00Z')

    const count = checkOosResets()
    expect(count).toBe(0)
    expect(getItemStatus()).toBe('out_today')
  })
})

// ── checkOosResets — business hours path ─────────────────────────────────────

describe('checkOosResets — 60 minutes after close_time', () => {
  // 2026-03-20 is a Friday (DOW = 5)
  const FRIDAY = 5

  test('fires reset 70 minutes after close_time', () => {
    // Close 20:00 → resetAfter 21:00; now = 21:10 → should fire
    setBusinessHours('20:00', FRIDAY)
    setItemStatus('out_today')
    mockDate('2026-03-20T21:10:00Z')

    const count = checkOosResets()
    expect(count).toBe(1)
    expect(getItemStatus()).toBe('in_stock')
  })

  test('does not fire reset 30 minutes after close_time', () => {
    // Close 20:00 → resetAfter 21:00; now = 20:30 → should not fire
    setBusinessHours('20:00', FRIDAY)
    setItemStatus('out_today')
    mockDate('2026-03-20T20:30:00Z')

    const count = checkOosResets()
    expect(count).toBe(0)
    expect(getItemStatus()).toBe('out_today')
  })

  test('fires reset exactly at resetAfter (boundary inclusive)', () => {
    // Close 20:00 → resetAfter 21:00; now = 21:00 → should fire
    setBusinessHours('20:00', FRIDAY)
    setItemStatus('out_today')
    mockDate('2026-03-20T21:00:00Z')

    const count = checkOosResets()
    expect(count).toBe(1)
    expect(getItemStatus()).toBe('in_stock')
  })
})

// ── checkOosResets — deduplication ───────────────────────────────────────────

describe('checkOosResets — deduplication', () => {
  test('does not reset twice on the same merchant-local day', () => {
    setItemStatus('out_today')
    mockDate('2026-03-20T03:00:00Z')

    checkOosResets()           // first call — fires, marks 2026-03-20
    setItemStatus('out_today') // re-mark to verify second call is a no-op

    const count = checkOosResets()  // second call — dedup blocks it
    expect(count).toBe(0)
    expect(getItemStatus()).toBe('out_today')  // not touched by second call
  })

  test('fires again on the next merchant-local day without clearing state', () => {
    setItemStatus('out_today')
    mockDate('2026-03-20T03:00:00Z')
    checkOosResets()   // day 1 — fires

    setItemStatus('out_today')
    mockDate('2026-03-21T03:00:00Z')  // day 2 — new local date breaks dedup
    const count = checkOosResets()

    expect(count).toBe(1)
    expect(getItemStatus()).toBe('in_stock')
  })
})

// ── checkOosResets — scheduled closure fallback ───────────────────────────────

describe('checkOosResets — 02:00 fallback on scheduled closure days', () => {
  test('ignores close_time and uses 02:00 fallback when today is a closure', () => {
    // Business hours say close at 20:00 (would give resetAfter = 21:00)
    // But a scheduled closure for 2026-03-20 forces the 02:00 fallback
    setBusinessHours('20:00', 5)            // Friday
    addScheduledClosure('2026-03-20')
    setItemStatus('out_today')
    mockDate('2026-03-20T03:00:00Z')        // 03:00 > 02:00 fallback → should fire

    const count = checkOosResets()
    expect(count).toBe(1)
    expect(getItemStatus()).toBe('in_stock')
  })

  test('does not fire before 02:00 on a closure day even if past business close_time', () => {
    setBusinessHours('20:00', 5)
    addScheduledClosure('2026-03-20')
    setItemStatus('out_today')
    // Without closure: 21:10 would fire (past 21:00 resetAfter)
    // With closure: fallback is 02:00, and 01:50 < 02:00 → should not fire
    mockDate('2026-03-20T01:50:00Z')

    const count = checkOosResets()
    expect(count).toBe(0)
    expect(getItemStatus()).toBe('out_today')
  })
})

// ── checkOosResets — inactive merchants ───────────────────────────────────────

describe('checkOosResets — skips non-active merchants', () => {
  afterEach(() => {
    // Always restore merchant status so other describe blocks are not affected
    getDatabase().run(`UPDATE merchants SET status = 'active' WHERE id = ?`, [merchantId])
  })

  test('does not reset out_today items for an inactive merchant', () => {
    getDatabase().run(`UPDATE merchants SET status = 'inactive' WHERE id = ?`, [merchantId])
    setItemStatus('out_today')
    mockDate('2026-03-20T03:00:00Z')

    const count = checkOosResets()
    expect(count).toBe(0)
    expect(getItemStatus()).toBe('out_today')
  })
})

// ── resetOosState ─────────────────────────────────────────────────────────────

describe('resetOosState', () => {
  test('allows re-reset on the same local day after state is cleared', () => {
    setItemStatus('out_today')
    mockDate('2026-03-20T03:00:00Z')

    checkOosResets()           // fires — dedup marks 2026-03-20
    setItemStatus('out_today') // re-mark
    resetOosState()            // clear dedup map

    const count = checkOosResets()  // should fire again
    expect(count).toBe(1)
    expect(getItemStatus()).toBe('in_stock')
  })
})
