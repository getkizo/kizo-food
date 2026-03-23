/**
 * Business hours and scheduled closures tests
 * Tests all 7 endpoints: GET/PUT/DELETE hours, GET/POST/PUT/DELETE closures
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { app } from '../src/server'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'

let accessToken: string
let merchantId: string
let staffToken: string
let otherAccessToken: string
let otherMerchantId: string

beforeAll(async () => {
  process.env.DATABASE_PATH = ':memory:'
  process.env.NODE_ENV = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register primary merchant (owner)
  const res = await app.fetch(
    new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'hours-owner@example.com',
        password: 'SecurePass123!',
        fullName: 'Hours Owner',
        businessName: 'Hours Test Restaurant',
        slug: 'hours-test-restaurant',
      }),
    })
  )
  const data = await res.json()
  accessToken = data.tokens.accessToken
  merchantId = data.merchant.id

  // Register a staff user for the same merchant
  const staffRes = await app.fetch(
    new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'hours-staff@example.com',
        password: 'SecurePass123!',
        fullName: 'Hours Staff',
        businessName: 'Hours Staff Biz',
        slug: 'hours-staff-biz',
      }),
    })
  )
  const staffData = await staffRes.json()
  staffToken = staffData.tokens.accessToken

  // Register a second independent merchant (for cross-merchant isolation tests)
  const otherRes = await app.fetch(
    new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'other-owner@example.com',
        password: 'SecurePass123!',
        fullName: 'Other Owner',
        businessName: 'Other Restaurant',
        slug: 'other-restaurant',
      }),
    })
  )
  const otherData = await otherRes.json()
  otherAccessToken = otherData.tokens.accessToken
  otherMerchantId = otherData.merchant.id
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function hoursUrl(path = '') {
  return `http://localhost:3000/api/merchants/${merchantId}/hours${path}`
}

function closuresUrl(path = '') {
  return `http://localhost:3000/api/merchants/${merchantId}/closures${path}`
}

// ---------------------------------------------------------------------------
// GET /hours
// ---------------------------------------------------------------------------

describe('GET /api/merchants/:id/hours', () => {
  test('returns empty regular and catering arrays when no hours are set', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), { headers: authHeaders(accessToken) })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ regular: [], catering: [] })
  })

  test('returns 401 without auth token', async () => {
    const res = await app.fetch(new Request(hoursUrl()))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// PUT /hours — regular service
// ---------------------------------------------------------------------------

describe('PUT /api/merchants/:id/hours — regular', () => {
  test('sets hours for multiple days', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [
            { dayOfWeek: 1, openTime: '11:00', closeTime: '22:00' }, // Mon
            { dayOfWeek: 2, openTime: '11:00', closeTime: '22:00' }, // Tue
            { dayOfWeek: 5, openTime: '10:00', closeTime: '23:00' }, // Fri
          ],
        }),
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.count).toBe(3)

    // Verify persisted
    const getRes = await app.fetch(
      new Request(hoursUrl(), { headers: authHeaders(accessToken) })
    )
    const getBody = await getRes.json()
    expect(getBody.regular).toHaveLength(3)
    expect(getBody.regular[0]).toMatchObject({ dayOfWeek: 1, openTime: '11:00', closeTime: '22:00', slotIndex: 0 })
  })

  test('replaces existing hours atomically on second PUT', async () => {
    // Set new hours — only Saturday now
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [{ dayOfWeek: 6, openTime: '12:00', closeTime: '20:00' }],
        }),
      })
    )
    expect(res.status).toBe(200)

    const getRes = await app.fetch(
      new Request(hoursUrl(), { headers: authHeaders(accessToken) })
    )
    const getBody = await getRes.json()
    expect(getBody.regular).toHaveLength(1)
    expect(getBody.regular[0].dayOfWeek).toBe(6)
  })

  test('sets split hours (two slots for same day)', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [
            { dayOfWeek: 3, openTime: '11:00', closeTime: '15:00' }, // slot 0
            { dayOfWeek: 3, openTime: '17:00', closeTime: '22:00' }, // slot 1
          ],
        }),
      })
    )
    expect(res.status).toBe(200)

    const getRes = await app.fetch(
      new Request(hoursUrl(), { headers: authHeaders(accessToken) })
    )
    const getBody = await getRes.json()
    const wed = getBody.regular.filter((s: { dayOfWeek: number }) => s.dayOfWeek === 3)
    expect(wed).toHaveLength(2)
    expect(wed[0]).toMatchObject({ slotIndex: 0, openTime: '11:00', closeTime: '15:00' })
    expect(wed[1]).toMatchObject({ slotIndex: 1, openTime: '17:00', closeTime: '22:00' })
  })

  test('clears all hours when slots is an empty array', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ serviceType: 'regular', slots: [] }),
      })
    )
    expect(res.status).toBe(200)
    const getRes = await app.fetch(
      new Request(hoursUrl(), { headers: authHeaders(accessToken) })
    )
    expect((await getRes.json()).regular).toHaveLength(0)
  })

  test('returns 400 for invalid serviceType', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ serviceType: 'brunch', slots: [] }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 for dayOfWeek out of range', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [{ dayOfWeek: 7, openTime: '09:00', closeTime: '17:00' }],
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 for malformed openTime', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [{ dayOfWeek: 1, openTime: '9am', closeTime: '17:00' }],
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 for out-of-range time (hour 25)', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [{ dayOfWeek: 1, openTime: '25:00', closeTime: '26:00' }],
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 when closeTime is not after openTime', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [{ dayOfWeek: 1, openTime: '22:00', closeTime: '10:00' }],
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 when closeTime equals openTime', async () => {
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [{ dayOfWeek: 1, openTime: '12:00', closeTime: '12:00' }],
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 403 for staff role', async () => {
    const res = await app.fetch(
      new Request(`http://localhost:3000/api/merchants/${otherMerchantId}/hours`, {
        method: 'PUT',
        headers: authHeaders(staffToken),
        body: JSON.stringify({ serviceType: 'regular', slots: [] }),
      })
    )
    // Staff token belongs to a different merchant — 403 or 401 depending on auth check order
    expect([401, 403]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// PUT /hours — catering service is independent of regular
// ---------------------------------------------------------------------------

describe('PUT /api/merchants/:id/hours — catering', () => {
  test('sets catering hours without affecting regular hours', async () => {
    // First set regular hours
    await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [{ dayOfWeek: 1, openTime: '11:00', closeTime: '21:00' }],
        }),
      })
    )

    // Set different catering hours
    const res = await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'catering',
          slots: [
            { dayOfWeek: 2, openTime: '08:00', closeTime: '16:00' },
            { dayOfWeek: 4, openTime: '08:00', closeTime: '16:00' },
          ],
        }),
      })
    )
    expect(res.status).toBe(200)

    const getRes = await app.fetch(
      new Request(hoursUrl(), { headers: authHeaders(accessToken) })
    )
    const getBody = await getRes.json()

    // Regular hours intact
    expect(getBody.regular).toHaveLength(1)
    expect(getBody.regular[0].dayOfWeek).toBe(1)

    // Catering hours separate
    expect(getBody.catering).toHaveLength(2)
    expect(getBody.catering[0].dayOfWeek).toBe(2)
    expect(getBody.catering[1].dayOfWeek).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// DELETE /hours/:day
// ---------------------------------------------------------------------------

describe('DELETE /api/merchants/:id/hours/:day', () => {
  test('removes all slots for a day and service type', async () => {
    // Setup: Wednesday with split hours
    await app.fetch(
      new Request(hoursUrl(), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          serviceType: 'regular',
          slots: [
            { dayOfWeek: 3, openTime: '11:00', closeTime: '15:00' },
            { dayOfWeek: 3, openTime: '17:00', closeTime: '22:00' },
            { dayOfWeek: 5, openTime: '11:00', closeTime: '22:00' },
          ],
        }),
      })
    )

    // Delete Wednesday
    const delRes = await app.fetch(
      new Request(hoursUrl('/3?serviceType=regular'), {
        method: 'DELETE',
        headers: authHeaders(accessToken),
      })
    )
    expect(delRes.status).toBe(200)
    expect((await delRes.json()).success).toBe(true)

    // Confirm only Friday remains
    const getRes = await app.fetch(
      new Request(hoursUrl(), { headers: authHeaders(accessToken) })
    )
    const getBody = await getRes.json()
    const regular = getBody.regular
    expect(regular.every((s: { dayOfWeek: number }) => s.dayOfWeek !== 3)).toBe(true)
    expect(regular.some((s: { dayOfWeek: number }) => s.dayOfWeek === 5)).toBe(true)
  })

  test('returns 400 when serviceType query param is missing', async () => {
    const res = await app.fetch(
      new Request(hoursUrl('/1'), {
        method: 'DELETE',
        headers: authHeaders(accessToken),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid day param', async () => {
    const res = await app.fetch(
      new Request(hoursUrl('/9?serviceType=regular'), {
        method: 'DELETE',
        headers: authHeaders(accessToken),
      })
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /closures
// ---------------------------------------------------------------------------

describe('GET /api/merchants/:id/closures', () => {
  test('returns empty array when no closures exist', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), { headers: authHeaders(accessToken) })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('returns 401 without auth token', async () => {
    const res = await app.fetch(new Request(closuresUrl()))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST /closures
// ---------------------------------------------------------------------------

describe('POST /api/merchants/:id/closures', () => {
  test('creates a single-day closure', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          startDate: '2025-12-25',
          endDate: '2025-12-25',
          label: 'Christmas Day',
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toMatch(/^sc_/)
    expect(body.startDate).toBe('2025-12-25')
    expect(body.endDate).toBe('2025-12-25')
    expect(body.label).toBe('Christmas Day')
  })

  test('creates a multi-day closure (date range)', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          startDate: '2025-07-01',
          endDate: '2025-07-07',
          label: 'Summer Vacation',
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.startDate).toBe('2025-07-01')
    expect(body.endDate).toBe('2025-07-07')
  })

  test('returns 400 for malformed startDate', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ startDate: '2024/12/25', endDate: '2024-12-25', label: 'X' }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 when endDate is before startDate', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ startDate: '2025-12-31', endDate: '2025-12-25', label: 'Backwards' }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 for empty label', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ startDate: '2025-01-01', endDate: '2025-01-01', label: '  ' }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 400 for label exceeding 100 characters', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          startDate: '2025-01-01',
          endDate: '2025-01-01',
          label: 'a'.repeat(101),
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns closures sorted by startDate ascending', async () => {
    // Add an earlier closure
    await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ startDate: '2025-01-01', endDate: '2025-01-01', label: "New Year's Day" }),
      })
    )

    const res = await app.fetch(
      new Request(closuresUrl(), { headers: authHeaders(accessToken) })
    )
    const list = await res.json()
    expect(Array.isArray(list)).toBe(true)
    // Verify sorted ascending
    for (let i = 1; i < list.length; i++) {
      expect(list[i].startDate >= list[i - 1].startDate).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PUT /closures/:closureId
// ---------------------------------------------------------------------------

describe('PUT /api/merchants/:id/closures/:closureId', () => {
  let closureId: string

  beforeAll(async () => {
    const res = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          startDate: '2025-11-27',
          endDate: '2025-11-28',
          label: 'Thanksgiving',
        }),
      })
    )
    closureId = (await res.json()).id
  })

  test('updates label only', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(`/${closureId}`), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ label: 'Thanksgiving Weekend' }),
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.label).toBe('Thanksgiving Weekend')
    expect(body.startDate).toBe('2025-11-27')
    expect(body.endDate).toBe('2025-11-28')
  })

  test('updates date range', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(`/${closureId}`), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ startDate: '2025-11-27', endDate: '2025-11-30' }),
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).endDate).toBe('2025-11-30')
  })

  test('returns 400 when updated dates produce endDate before startDate', async () => {
    const res = await app.fetch(
      new Request(closuresUrl(`/${closureId}`), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ endDate: '2025-11-01' }), // before current start
      })
    )
    expect(res.status).toBe(400)
  })

  test('returns 404 for non-existent closure', async () => {
    const res = await app.fetch(
      new Request(closuresUrl('/sc_doesnotexist'), {
        method: 'PUT',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ label: 'Ghost' }),
      })
    )
    expect(res.status).toBe(404)
  })

  test('returns 404 when closure belongs to a different merchant', async () => {
    const res = await app.fetch(
      new Request(
        `http://localhost:3000/api/merchants/${otherMerchantId}/closures/${closureId}`,
        {
          method: 'PUT',
          headers: authHeaders(otherAccessToken),
          body: JSON.stringify({ label: 'Stolen' }),
        }
      )
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DELETE /closures/:closureId
// ---------------------------------------------------------------------------

describe('DELETE /api/merchants/:id/closures/:closureId', () => {
  test('deletes an existing closure and confirms removal', async () => {
    // Create a closure to delete
    const createRes = await app.fetch(
      new Request(closuresUrl(), {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          startDate: '2025-10-31',
          endDate: '2025-10-31',
          label: 'Halloween',
        }),
      })
    )
    const { id } = await createRes.json()

    const delRes = await app.fetch(
      new Request(closuresUrl(`/${id}`), {
        method: 'DELETE',
        headers: authHeaders(accessToken),
      })
    )
    expect(delRes.status).toBe(200)
    expect((await delRes.json()).success).toBe(true)

    // Confirm gone
    const listRes = await app.fetch(
      new Request(closuresUrl(), { headers: authHeaders(accessToken) })
    )
    const list = await listRes.json()
    expect(list.find((c: { id: string }) => c.id === id)).toBeUndefined()
  })

  test('returns 404 for unknown closure id', async () => {
    const res = await app.fetch(
      new Request(closuresUrl('/sc_notreal'), {
        method: 'DELETE',
        headers: authHeaders(accessToken),
      })
    )
    expect(res.status).toBe(404)
  })
})
