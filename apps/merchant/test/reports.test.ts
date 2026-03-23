/**
 * Reports route tests
 * Tests sales, shifts, and tips report endpoints.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'

let accessToken = ''
let staffToken = ''
let merchantId = ''

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
      email:        'owner@reports.test',
      password:     'SecurePass123!',
      fullName:     'Reports Owner',
      businessName: 'Reports Cafe',
      slug:         'reports-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string }; tokens: { accessToken: string } }
  merchantId   = body.merchant.id
  accessToken  = body.tokens.accessToken

  // Create a staff user and get their token (staff role should be rejected by reports)
  const db = getDatabase()
  const { generateId } = await import('../src/utils/id')
  const staffId = generateId('u')
  const staffHash = await Bun.password.hash('SecurePass123!')
  db.run(
    `INSERT INTO users (id, merchant_id, email, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 'staff', 1, datetime('now'))`,
    [staffId, merchantId, 'staff@reports.test', staffHash, 'Staff User']
  )
  const staffLogin = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'staff@reports.test', password: 'SecurePass123!' }),
  }))
  const staffBody = await staffLogin.json() as { tokens: { accessToken: string } }
  staffToken = staffBody.tokens.accessToken
})

// ---------------------------------------------------------------------------
// Auth enforcement
// ---------------------------------------------------------------------------

describe('Reports — auth enforcement', () => {
  test('GET /reports/sales returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/sales`
    ))
    expect(res.status).toBe(401)
  })

  test('GET /reports/shifts returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/shifts`
    ))
    expect(res.status).toBe(401)
  })

  test('GET /reports/tips returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/tips`
    ))
    expect(res.status).toBe(401)
  })

  test('GET /reports/sales returns 403 for staff role', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/sales`,
      { headers: { Authorization: `Bearer ${staffToken}` } }
    ))
    expect(res.status).toBe(403)
  })

  test('GET /reports/shifts returns 403 for staff role', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/shifts`,
      { headers: { Authorization: `Bearer ${staffToken}` } }
    ))
    expect(res.status).toBe(403)
  })

  test('GET /reports/tips returns 403 for staff role', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/tips`,
      { headers: { Authorization: `Bearer ${staffToken}` } }
    ))
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Sales report
// ---------------------------------------------------------------------------

describe('Reports — sales', () => {
  test('returns 200 with summary and days for merchant with no orders', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/sales`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body).toHaveProperty('summary')
    expect(body).toHaveProperty('days')
    expect(Array.isArray(body.days)).toBe(true)
    expect(body.summary.totalOrders).toBe(0)
    expect(body.summary).toHaveProperty('grossSalesCents')
    expect(body.summary).toHaveProperty('netSalesCents')
    expect(body.summary).toHaveProperty('tipCents')
  })

  test('accepts custom date range and returns matching from/to', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/sales?from=2026-01-01&to=2026-01-31`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body.from).toBe('2026-01-01')
    expect(body.to).toBe('2026-01-31')
  })

  test('single-day report includes orders array', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/sales?from=${today}&to=${today}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body).toHaveProperty('orders')
    expect(Array.isArray(body.orders)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Shifts report
// ---------------------------------------------------------------------------

describe('Reports — shifts', () => {
  test('returns 200 with summary and empty employees array', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/shifts`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body).toHaveProperty('summary')
    expect(body).toHaveProperty('employees')
    expect(Array.isArray(body.employees)).toBe(true)
    expect(body.summary).toHaveProperty('grandTotalHours')
    expect(body.summary.grandTotalHours).toBe(0)
  })

  test('accepts date range', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/shifts?from=2026-01-01&to=2026-01-31`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.from).toBe('2026-01-01')
    expect(body.to).toBe('2026-01-31')
  })
})

// ---------------------------------------------------------------------------
// Tips report
// ---------------------------------------------------------------------------

describe('Reports — tips', () => {
  test('returns 200 with zero grand total and empty employees array', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/tips`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body).toHaveProperty('summary')
    expect(body).toHaveProperty('employees')
    expect(Array.isArray(body.employees)).toBe(true)
    expect(body.summary.grandTotalTipsCents).toBe(0)
  })

  test('accepts date range', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reports/tips?from=2026-01-01&to=2026-01-31`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.from).toBe('2026-01-01')
  })
})
