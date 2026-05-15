/**
 * Auth middleware integration tests
 *
 * Tests the middleware layer via real Hono routes rather than the
 * middleware functions in isolation.
 *
 * Endpoint guide:
 *   GET  /api/merchants/:id           → authenticate + requireOwnMerchant
 *   GET  /api/merchants/:id/employees → authenticate + requireRole('owner','manager')
 *   DELETE /api/merchants/:id/employees/:empId → authenticate + requireRole('owner')
 *
 * Covers:
 *  (a) missing Authorization header → 401
 *  (b) non-Bearer scheme (e.g. "Basic …") → 401
 *  (c) truncated / random string as token → 401 INVALID_TOKEN
 *  (d) expired JWT → 401 TOKEN_EXPIRED + security_events row
 *  (e) refresh token used as access token → 401 (type check)
 *  (f) valid access token → passes authenticate (200 or subsequent check)
 *  (g) staff token on owner+manager endpoint → 403
 *  (h) manager token on owner-only endpoint → 403
 *  (i) owner token on owner-only endpoint → passes (404 employee expected, not 403)
 *  (j) requireOwnMerchant: owner A accesses merchant B endpoint → 403
 *  (k) requireOwnMerchant: owner accesses own endpoint → 200
 *  (l) 403 from requireRole logs auth_insufficient_role security event
 *  (m) 403 from requireOwnMerchant logs auth_merchant_mismatch security event
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { signJWT, verifyJWT, createRefreshToken } from '../src/utils/jwt'

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let ownerToken  = ''
let merchantId  = ''
let userId      = ''
let merchantBId = ''
let ownerBToken = ''

/** Create a signed JWT with the given role/type for this test session. */
function makeToken(
  role:      'owner' | 'manager' | 'staff',
  type:      'access' | 'refresh' = 'access',
  expiresIn: number               = 86_400,
): string {
  return signJWT({ sub: userId, type, role, merchantId }, expiresIn)
}

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register primary merchant
  const regRes  = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'owner@authmw.test',
      password:     'SecurePass123!',
      fullName:     'Auth MW Owner',
      businessName: 'Auth MW Cafe',
      slug:         'auth-mw-cafe',
    }),
  }))
  const regBody  = await regRes.json()
  ownerToken     = regBody.tokens.accessToken
  merchantId     = regBody.merchant.id
  userId         = verifyJWT(ownerToken).sub

  // Register a second, unrelated merchant for cross-merchant tests
  const regBRes  = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'ownerb@authmw.test',
      password:     'SecurePass123!',
      fullName:     'Auth MW Owner B',
      businessName: 'Auth MW Cafe B',
      slug:         'auth-mw-cafe-b',
    }),
  }))
  const regBBody  = await regBRes.json()
  ownerBToken     = regBBody.tokens.accessToken
  merchantBId     = regBBody.merchant.id
})

// ---------------------------------------------------------------------------
// authenticate middleware
// ---------------------------------------------------------------------------

describe('authenticate middleware', () => {
  test('(a) missing Authorization header → 401', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toContain('authorization')
  })

  test('(b) non-Bearer scheme "Basic abc" → 401', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    }))
    expect(res.status).toBe(401)
  })

  test('(c) random string (not a JWT) → 401 INVALID_TOKEN', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: 'Bearer not-a-real-jwt-at-all' },
    }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('INVALID_TOKEN')
  })

  test('(d) expired JWT → 401 TOKEN_EXPIRED + security event logged', async () => {
    const expiredToken = makeToken('owner', 'access', -100)

    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('TOKEN_EXPIRED')

    const db  = getDatabase()
    const row = db.query<{ event_type: string }, []>(
      `SELECT event_type FROM security_events WHERE event_type = 'auth_expired_token' LIMIT 1`,
    ).get()
    expect(row?.event_type).toBe('auth_expired_token')
  })

  test('(e) refresh token used as access token → 401', async () => {
    const refreshToken = createRefreshToken(userId, merchantId, 'owner')

    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${refreshToken}` },
    }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/invalid token type/i)
  })

  test('(f) valid access token passes authenticate → 200', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }))
    // requireOwnMerchant is also applied; owner accesses own merchant → 200
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// requireRole middleware
// ---------------------------------------------------------------------------

describe('requireRole middleware', () => {
  test('(g) staff token on owner+manager endpoint → 403', async () => {
    const staffToken = makeToken('staff')
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/employees`,
      { headers: { Authorization: `Bearer ${staffToken}` } },
    ))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('permissions')
  })

  test('(h) manager token on owner-only DELETE endpoint → 403', async () => {
    const managerToken = makeToken('manager')
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/employees/emp_nonexistent`,
      {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${managerToken}` },
      },
    ))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('permissions')
  })

  test('(i) owner token on owner-only DELETE endpoint → passes role check (404 employee)', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/employees/emp_ghost_test`,
      {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    ))
    // Role check passes; employee doesn't exist → 404 (not 403)
    expect(res.status).toBe(404)
  })

  test('(j) manager token on owner+manager endpoint → 200 or non-403', async () => {
    const managerToken = makeToken('manager')
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/employees`,
      { headers: { Authorization: `Bearer ${managerToken}` } },
    ))
    // manager role is allowed on this endpoint → 200
    expect(res.status).toBe(200)
  })

  test('(l) 403 from requireRole logs auth_insufficient_role security event', async () => {
    const staffToken = makeToken('staff')
    await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/employees`,
      { headers: { Authorization: `Bearer ${staffToken}` } },
    ))

    const db  = getDatabase()
    const row = db.query<{ event_type: string }, []>(
      `SELECT event_type FROM security_events WHERE event_type = 'auth_insufficient_role' LIMIT 1`,
    ).get()
    expect(row?.event_type).toBe('auth_insufficient_role')
  })
})

// ---------------------------------------------------------------------------
// requireOwnMerchant middleware
// ---------------------------------------------------------------------------

describe('requireOwnMerchant middleware', () => {
  test('(j) owner of merchant A accessing merchant B endpoint → 403', async () => {
    // ownerToken belongs to merchantId (A); try to GET merchantBId (B)
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantBId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Access denied')
  })

  test('(k) owner accessing own merchant endpoint → 200', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }))
    expect(res.status).toBe(200)
  })

  test('(m) 403 from requireOwnMerchant logs auth_merchant_mismatch security event', async () => {
    await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantBId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }))

    const db  = getDatabase()
    const row = db.query<{ event_type: string }, []>(
      `SELECT event_type FROM security_events WHERE event_type = 'auth_merchant_mismatch' LIMIT 1`,
    ).get()
    expect(row?.event_type).toBe('auth_merchant_mismatch')
  })
})
