/**
 * Reservations route tests
 * Tests public config/slots/booking endpoints and authenticated management endpoints.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'

let accessToken = ''
let merchantId  = ''

// Reservation inserted by staff-create test — used for patch/delete tests
let createdReservationId = ''

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
      email:        'owner@reservations.test',
      password:     'SecurePass123!',
      fullName:     'Reservation Owner',
      businessName: 'Reservation Cafe',
      slug:         'reservation-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string }; tokens: { accessToken: string } }
  merchantId  = body.merchant.id
  accessToken = body.tokens.accessToken

  // Enable reservations on the merchant and set reasonable defaults
  const db = getDatabase()
  db.run(
    `UPDATE merchants
     SET reservation_enabled = 1,
         reservation_slot_minutes = 120,
         reservation_cutoff_minutes = 60,
         reservation_advance_days = 14,
         reservation_max_party_size = 10
     WHERE id = ?`,
    [merchantId]
  )
})

// ---------------------------------------------------------------------------
// Public config endpoint
// ---------------------------------------------------------------------------

describe('Reservations — public config', () => {
  test('GET /store/reservations/config returns enabled:true after enabling', async () => {
    const res = await app.fetch(new Request(
      'http://localhost:3000/api/store/reservations/config'
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body.enabled).toBe(true)
    expect(body).toHaveProperty('maxPartySize')
    expect(body).toHaveProperty('advanceDays')
    expect(body).toHaveProperty('slotMinutes')
  })

  test('GET /store/reservations/config returns enabled:false after disabling', async () => {
    const db = getDatabase()
    db.run(`UPDATE merchants SET reservation_enabled = 0 WHERE id = ?`, [merchantId])

    const res = await app.fetch(new Request(
      'http://localhost:3000/api/store/reservations/config'
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.enabled).toBe(false)

    // Re-enable for subsequent tests
    db.run(`UPDATE merchants SET reservation_enabled = 1 WHERE id = ?`, [merchantId])
  })
})

// ---------------------------------------------------------------------------
// Public slots endpoint
// ---------------------------------------------------------------------------

describe('Reservations — public slots', () => {
  test('returns 400 for missing date param', async () => {
    const res = await app.fetch(new Request(
      'http://localhost:3000/api/store/reservations/slots'
    ))
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid date format', async () => {
    const res = await app.fetch(new Request(
      'http://localhost:3000/api/store/reservations/slots?date=not-a-date'
    ))
    expect(res.status).toBe(400)
  })

  test('returns 403 when reservations are disabled', async () => {
    const db = getDatabase()
    db.run(`UPDATE merchants SET reservation_enabled = 0 WHERE id = ?`, [merchantId])

    const res = await app.fetch(new Request(
      'http://localhost:3000/api/store/reservations/slots?date=2026-12-25'
    ))
    expect(res.status).toBe(403)

    // Re-enable
    db.run(`UPDATE merchants SET reservation_enabled = 1 WHERE id = ?`, [merchantId])
  })

  test('returns slots array for a valid future date', async () => {
    // Use a far-future date within advance window to avoid cutoff logic
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 3)
    const dateStr = futureDate.toISOString().slice(0, 10)

    // Need business hours for slots to appear — seed a Monday-Sunday open window
    const db = getDatabase()
    const dow = futureDate.getDay()
    const { generateId } = await import('../src/utils/id')
    const bhId = generateId('bh')
    db.run(
      `INSERT OR IGNORE INTO business_hours
         (id, merchant_id, service_type, day_of_week, open_time, close_time, slot_index, is_closed, created_at, updated_at)
       VALUES (?, ?, 'regular', ?, '10:00', '22:00', 0, 0, datetime('now'), datetime('now'))`,
      [bhId, merchantId, dow]
    )

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/store/reservations/slots?date=${dateStr}`
    ))
    // Could be 200 (with slots) or 200 with empty slots — either is valid
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('slots')
    expect(Array.isArray(body.slots)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Public create reservation (customer-facing)
// ---------------------------------------------------------------------------

describe('Reservations — public create', () => {
  test('returns 403 when reservations are disabled', async () => {
    const db = getDatabase()
    db.run(`UPDATE merchants SET reservation_enabled = 0 WHERE id = ?`, [merchantId])

    const res = await app.fetch(new Request(
      'http://localhost:3000/api/store/reservations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Test Customer',
          partySize: 2,
          date: '2099-12-25',
          time: '18:00',
        }),
      }
    ))
    expect(res.status).toBe(403)

    // Re-enable
    db.run(`UPDATE merchants SET reservation_enabled = 1 WHERE id = ?`, [merchantId])
  })

  test('returns 400 for missing required fields', async () => {
    const res = await app.fetch(new Request(
      'http://localhost:3000/api/store/reservations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerName: 'Test' }),  // missing partySize, date, time
      }
    ))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Authenticated management: list by date
// ---------------------------------------------------------------------------

describe('Reservations — authenticated list', () => {
  test('GET /api/merchants/:id/reservations returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations`
    ))
    expect(res.status).toBe(401)
  })

  test('GET /api/merchants/:id/reservations returns reservations array', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations?date=${today}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body).toHaveProperty('reservations')
    expect(Array.isArray(body.reservations)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Authenticated management: upcoming
// ---------------------------------------------------------------------------

describe('Reservations — upcoming', () => {
  test('GET /api/merchants/:id/reservations/upcoming returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations/upcoming`
    ))
    expect(res.status).toBe(401)
  })

  test('returns upcoming reservations array', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations/upcoming`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('reservations')
    expect(Array.isArray(body.reservations)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Authenticated management: staff-create, patch, delete
// ---------------------------------------------------------------------------

describe('Reservations — staff create', () => {
  test('returns 400 for missing customerName', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ partySize: 2, date: '2099-01-01', time: '18:00' }),
      }
    ))
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid date format', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ customerName: 'John', partySize: 2, date: 'not-a-date', time: '18:00' }),
      }
    ))
    expect(res.status).toBe(400)
  })

  test('creates a reservation and returns id + confirmation code', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          customerName: 'Jane Doe',
          customerPhone: '555-0100',
          partySize: 3,
          date: '2099-06-15',
          time: '19:00',
        }),
      }
    ))
    expect(res.status).toBe(201)

    const body = await res.json() as any
    expect(body).toHaveProperty('reservationId')
    expect(body).toHaveProperty('confirmationCode')
    expect(typeof body.reservationId).toBe('string')
    expect(typeof body.confirmationCode).toBe('string')

    createdReservationId = body.reservationId
  })
})

describe('Reservations — patch', () => {
  test('returns 404 for unknown reservation id', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations/res_nonexistent`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ status: 'seated' }),
      }
    ))
    expect(res.status).toBe(404)
  })

  test('updates status of an existing reservation', async () => {
    // createdReservationId set by staff-create test above
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations/${createdReservationId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ status: 'seated' }),
      }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
  })

  test('returns 400 for invalid status value', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations/${createdReservationId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ status: 'vip' }),  // not a valid status
      }
    ))
    expect(res.status).toBe(400)
  })
})

describe('Reservations — delete by staff', () => {
  test('returns 404 for unknown reservation', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations/res_nonexistent`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    ))
    expect(res.status).toBe(404)
  })

  test('deletes an existing reservation', async () => {
    // First create a fresh reservation to delete
    const createRes = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          customerName: 'To Delete',
          partySize: 1,
          date: '2099-07-04',
          time: '12:00',
        }),
      }
    ))
    const { reservationId } = await createRes.json() as any

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/reservations/${reservationId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
  })
})
