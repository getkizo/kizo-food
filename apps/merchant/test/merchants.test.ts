/**
 * Merchant profile integration tests
 *
 * Covers GET profile, PUT profile fields (taxRate, tipOptions, printerIp),
 * owner-only field restrictions, and webhook secret CRUD.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { signJWT, verifyJWT } from '../src/utils/jwt'

let ownerToken  = ''
let merchantId  = ''
let userId      = ''

function makeToken(role: 'owner' | 'manager' | 'staff'): string {
  return signJWT({ sub: userId, type: 'access', role, merchantId }, 86_400)
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

  const res  = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'owner@merchants.test',
      password:     'SecurePass123!',
      fullName:     'Merchants Owner',
      businessName: 'Merchants Test Cafe',
      slug:         'merchants-test-cafe',
    }),
  }))
  const body = await res.json()
  ownerToken = body.tokens.accessToken
  merchantId = body.merchant.id
  userId     = verifyJWT(ownerToken).sub
})

// ---------------------------------------------------------------------------
// GET /api/merchants/:id
// ---------------------------------------------------------------------------

describe('GET /api/merchants/:id', () => {
  test('returns full merchant profile → 200', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(merchantId)
    expect(typeof body.businessName).toBe('string')
    expect(typeof body.taxRate).toBe('number')
  })

  test('wrong token (different merchantId) → 403', async () => {
    // Token has a different merchantId embedded
    const alienToken = signJWT({ sub: userId, type: 'access', role: 'owner', merchantId: 'merch_other' }, 86_400)
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${alienToken}` },
    }))
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// PUT /api/merchants/:id
// ---------------------------------------------------------------------------

describe('PUT /api/merchants/:id — taxRate', () => {
  test('valid taxRate (0.0875) is accepted → 200', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ taxRate: 0.0875 }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.taxRate).toBeCloseTo(0.0875, 4)
  })

  test('taxRate > 1 → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ taxRate: 1.5 }),
    }))
    expect(res.status).toBe(400)
  })

  test('taxRate < 0 → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ taxRate: -0.1 }),
    }))
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/merchants/:id — tipOptions', () => {
  test('valid tip options array → 200', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ tipOptions: [15, 18, 20, 25] }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tipOptions).toEqual([15, 18, 20, 25])
  })

  test('invalid tip value not in allowed set → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ tipOptions: [12, 15, 20] }),
    }))
    expect(res.status).toBe(400)
  })

  test('too few tip values (< 2) → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ tipOptions: [15] }),
    }))
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/merchants/:id — printerIp', () => {
  test('updates printerIp → 200', async () => {
    const res  = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({ printerIp: '192.168.1.100' }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.printerIp).toBe('192.168.1.100')
  })
})

describe('PUT /api/merchants/:id — owner-only field via manager', () => {
  test('manager changing status → 403', async () => {
    const managerToken = makeToken('manager')
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` },
      body:    JSON.stringify({ status: 'inactive' }),
    }))
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Webhook secret CRUD
// ---------------------------------------------------------------------------

describe('Webhook secret endpoints', () => {
  test('GET /webhook/secret/status → { configured: false } initially', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/webhook/secret/status`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(false)
  })

  test('POST /webhook/secret → returns plaintext 64-char hex secret', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/webhook/secret`,
      { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.secret).toBe('string')
    expect(body.secret).toHaveLength(64)
  })

  test('GET /webhook/secret/status → { configured: true } after POST', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/webhook/secret/status`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(true)
  })

  test('DELETE /webhook/secret → { ok: true }', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/webhook/secret`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test('GET /webhook/secret/status → { configured: false } after DELETE', async () => {
    const res  = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/webhook/secret/status`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    ))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(false)
  })

  test('no updates body → 400', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000/api/merchants/${merchantId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body:    JSON.stringify({}),
    }))
    expect(res.status).toBe(400)
  })
})
