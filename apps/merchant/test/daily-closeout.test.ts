/**
 * Daily closeout service tests
 *
 * Tests:
 *  (a) skips if merchant has no email config
 *  (b) skips if current time is before sendAfter (close + 60 min)
 *  (c) sends when current time is at or past sendAfter
 *  (d) deduplication — second call for same date does not re-send
 *  (e) sends empty report (or skips) on scheduled closure days depending on wall time
 *  (f) skips empty report before 21:00 on a closure day
 */

import { test, expect, beforeAll, beforeEach } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { storeAPIKey } from '../src/crypto/api-keys'
import { checkCloseouts, resetCloseoutState } from '../src/services/daily-closeout'
import { app } from '../src/server'

// ── module-level mock ──────────────────────────────────────────────────────────
// Patch nodemailer before any imports run so sendMail never hits real SMTP.

import nodemailer from 'nodemailer'

const _sentMails: unknown[] = []
const _mockTransporter = {
  sendMail: (opts: unknown) => { _sentMails.push(opts); return Promise.resolve({ messageId: 'mock-id' }) },
}
// @ts-ignore — intentional monkey-patch for tests
nodemailer.createTransport = () => _mockTransporter

// ── fixtures ───────────────────────────────────────────────────────────────────

let merchantId = ''

// ── helpers ────────────────────────────────────────────────────────────────────

/** Create or overwrite the test merchant's email config and hours for a given DOW */
function setMerchantConfig(opts: {
  email?: string | null
  receiptEmailFrom?: string | null
  closeTime?: string | null    // HH:MM, null = no hours row
  dow?: number                  // 0=Sun, default to today's DOW in merchant's timezone
}) {
  const db = getDatabase()

  if (opts.email !== undefined) {
    db.run(`UPDATE merchants SET email = ? WHERE id = ?`, [opts.email, merchantId])
  }
  if (opts.receiptEmailFrom !== undefined) {
    db.run(`UPDATE merchants SET receipt_email_from = ? WHERE id = ?`, [opts.receiptEmailFrom, merchantId])
  }

  // Mirror production: use the merchant's configured timezone for DOW, not UTC.
  // Without this, a server near UTC midnight may seed the wrong business_hours row.
  const tzRow = db.query<{ timezone: string }, [string]>(
    `SELECT timezone FROM merchants WHERE id = ?`
  ).get(merchantId)
  const tz = tzRow?.timezone ?? 'UTC'
  const dow = opts.dow ?? localDow(tz)

  db.run(
    `DELETE FROM business_hours WHERE merchant_id = ? AND service_type = 'regular' AND day_of_week = ?`,
    [merchantId, dow],
  )

  if (opts.closeTime) {
    const id = `bh_test_${Math.random().toString(36).slice(2, 8)}`
    db.run(
      `INSERT INTO business_hours
         (id, merchant_id, service_type, day_of_week, open_time, close_time, slot_index, is_closed, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [id, merchantId, 'regular', dow, '09:00', opts.closeTime, 0, 0],
    )
  }
}

/** Add a scheduled closure for a given date string */
function addClosure(dateStr: string) {
  const db = getDatabase()
  const id = `sc_test_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO scheduled_closures (id, merchant_id, start_date, end_date, label, created_at, updated_at)
     VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`,
    [id, merchantId, dateStr, dateStr, 'Test closure'],
  )
}

/** Remove all scheduled closures for the test merchant */
function clearClosures() {
  getDatabase().run(`DELETE FROM scheduled_closures WHERE merchant_id = ?`, [merchantId])
}

/**
 * Day-of-week (0=Sun) for the current moment in the given timezone.
 * Mirrors daily-closeout.ts todayDow() so test helpers stay in sync
 * with production code when the merchant timezone differs from UTC.
 */
function localDow(tz: string): number {
  const dateStr = new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** Current date as YYYY-MM-DD in UTC */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── setup ──────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register merchant
  const res = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@closeout.test',
      password:     'SecurePass123!',
      fullName:     'Closeout Owner',
      businessName: 'Closeout Cafe',
      slug:         'closeout-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string } }
  merchantId = body.merchant.id

  // Set timezone to UTC so time assertions are deterministic
  getDatabase().run(`UPDATE merchants SET timezone = 'UTC' WHERE id = ?`, [merchantId])

  // Seed a mock Gmail app password so sendCloseoutEmail passes the API-key check
  await storeAPIKey(merchantId, 'email', 'gmail', 'mock-app-password', undefined)

  // Set email and from address
  setMerchantConfig({ email: 'owner@closeout.test', receiptEmailFrom: 'noreply@closeout.test' })
})

beforeEach(() => {
  resetCloseoutState()
  clearClosures()
  _sentMails.length = 0
})

// ── tests ──────────────────────────────────────────────────────────────────────

test('(a) skips merchant with no email config', async () => {
  // Temporarily clear email
  getDatabase().run(`UPDATE merchants SET email = NULL WHERE id = ?`, [merchantId])
  setMerchantConfig({ closeTime: '00:00' })

  const sent = await checkCloseouts()
  expect(sent).toBe(0)
  expect(_sentMails.length).toBe(0)

  // Restore
  getDatabase().run(`UPDATE merchants SET email = 'owner@closeout.test' WHERE id = ?`, [merchantId])
})

test('(b) skips when current time is before close + 60 min', async () => {
  // Close at 23:00 UTC → sendAfter = 00:00 next day — always in the future
  setMerchantConfig({ closeTime: '23:00' })

  const sent = await checkCloseouts()
  expect(sent).toBe(0)
  expect(_sentMails.length).toBe(0)
})

test('(c) sends when current time is past sendAfter', async () => {
  // Use a close time 2 hours ago — sendAfter = 1 hour ago, always in the past
  const pastCloseTime = new Date(Date.now() - 2 * 3_600_000)
    .toTimeString()
    .slice(0, 5)
  setMerchantConfig({ closeTime: pastCloseTime })

  const sent = await checkCloseouts()
  expect(sent).toBeGreaterThan(0)
  expect(_sentMails.length).toBeGreaterThan(0)
})

test('(d) deduplication — second call for same date does not re-send', async () => {
  // Use a close time 2 hours ago — sendAfter = 1 hour ago, always in the past
  const pastCloseTime = new Date(Date.now() - 2 * 3_600_000)
    .toTimeString()
    .slice(0, 5)
  setMerchantConfig({ closeTime: pastCloseTime })

  const first  = await checkCloseouts()
  const second = await checkCloseouts()

  expect(first).toBeGreaterThan(0)
  expect(second).toBe(0)  // already sent for today
  expect(_sentMails.length).toBe(first)  // no extra mails on second call
})

test('(e) sends empty report on scheduled closure day at or after 21:00 UTC', async () => {
  const today = todayUtc()
  setMerchantConfig({ closeTime: null })  // no hours = closed
  addClosure(today)

  const nowHour = new Date().getUTCHours()

  if (nowHour >= 21) {
    // At or after 21:00 — empty report should be sent
    const sent = await checkCloseouts()
    expect(sent).toBeGreaterThan(0)
    expect(_sentMails.length).toBeGreaterThan(0)
  } else {
    // Before 21:00 — should skip
    const sent = await checkCloseouts()
    expect(sent).toBe(0)
    expect(_sentMails.length).toBe(0)
  }
})

test('(f) skips empty report before 21:00 on a closure day', async () => {
  const nowHour = new Date().getUTCHours()
  if (nowHour >= 21) {
    // Can't test the before-21:00 path at this hour; pass trivially
    expect(true).toBe(true)
    return
  }

  const today = todayUtc()
  setMerchantConfig({ closeTime: null })
  addClosure(today)

  const sent = await checkCloseouts()
  expect(sent).toBe(0)
  expect(_sentMails.length).toBe(0)
})
