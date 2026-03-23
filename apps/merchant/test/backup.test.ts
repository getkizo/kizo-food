/**
 * Backup, restore, and wipe route tests
 * Tests GET /backup, POST /restore, POST /wipe, GET/PUT/DELETE /s3-config
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'

let accessToken  = ''
let staffToken   = ''
let merchantId   = ''
let merchant2Id  = ''
let accessToken2 = ''

beforeAll(async () => {
  closeDatabase()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register primary merchant
  const res = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@backup.test',
      password:     'SecurePass123!',
      fullName:     'Backup Owner',
      businessName: 'Backup Cafe',
      slug:         'backup-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string }; tokens: { accessToken: string } }
  merchantId  = body.merchant.id
  accessToken = body.tokens.accessToken

  // Register second merchant — used for restore validation test (avoids sharing rate-limit slot)
  const res2 = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner2@backup.test',
      password:     'SecurePass123!',
      fullName:     'Backup Owner 2',
      businessName: 'Backup Cafe 2',
      slug:         'backup-cafe-2',
    }),
  }))
  const body2 = await res2.json() as { merchant: { id: string }; tokens: { accessToken: string } }
  merchant2Id  = body2.merchant.id
  accessToken2 = body2.tokens.accessToken

  // Create a staff user for role-enforcement tests
  const db = getDatabase()
  const { generateId } = await import('../src/utils/id')
  const staffId   = generateId('u')
  const staffHash = await Bun.password.hash('SecurePass123!')
  db.run(
    `INSERT INTO users (id, merchant_id, email, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 'staff', 1, datetime('now'))`,
    [staffId, merchantId, 'staff@backup.test', staffHash, 'Staff User']
  )
  const staffLogin = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'staff@backup.test', password: 'SecurePass123!' }),
  }))
  const staffBody = await staffLogin.json() as { tokens: { accessToken: string } }
  staffToken = staffBody.tokens.accessToken
})

// ---------------------------------------------------------------------------
// Auth enforcement — these do NOT consume rate-limit slots
// ---------------------------------------------------------------------------

describe('Backup — auth enforcement', () => {
  test('GET /backup returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/backup`
    ))
    expect(res.status).toBe(401)
  })

  test('GET /backup returns 403 for staff role', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/backup`,
      { headers: { Authorization: `Bearer ${staffToken}` } }
    ))
    expect(res.status).toBe(403)
  })

  test('POST /wipe returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/wipe`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'menu', confirm: true }) }
    ))
    expect(res.status).toBe(401)
  })

  test('POST /wipe returns 403 for staff role', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/wipe`,
      { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
        body: JSON.stringify({ type: 'menu', confirm: true }) }
    ))
    expect(res.status).toBe(403)
  })

  test('GET /s3-config returns 401 without token', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/s3-config`
    ))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// GET /backup — consumes backupLastRun slot for merchantId
// ---------------------------------------------------------------------------

describe('Backup — download', () => {
  test('returns menu backup as JSON attachment', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/backup?type=menu`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)

    const contentDisposition = res.headers.get('Content-Disposition') ?? ''
    expect(contentDisposition).toMatch(/attachment/)
    expect(contentDisposition).toMatch(/backup-menu/)

    const body = await res.json() as any
    expect(body).toHaveProperty('type', 'menu')
    expect(body).toHaveProperty('data')
  })

  test('returns 429 when called again within rate-limit window', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/backup?type=menu`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// POST /restore — consumes restoreLastRun slot for merchantId
// ---------------------------------------------------------------------------

describe('Backup — restore', () => {
  // Uses merchant2 so the primary merchant's rate-limit slot is untouched
  test('returns 400 for missing backup field', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchant2Id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken2}` },
        body: JSON.stringify({ backup: null }),
      }
    ))
    expect(res.status).toBe(400)
  })

  test('accepts a well-formed menu backup payload', async () => {
    const backupPayload = {
      backup: {
        type: 'menu',
        data: {
          categories: [],
          items: [],
          modifierGroups: [],
          modifiers: [],
          itemModifierGroups: [],
        },
      },
    }
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(backupPayload),
      }
    ))
    expect(res.status).toBe(200)

    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.type).toBe('menu')
  })
})

// ---------------------------------------------------------------------------
// POST /wipe — no rate limit
// ---------------------------------------------------------------------------

describe('Backup — wipe', () => {
  test('returns 400 when confirm flag is missing', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/wipe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ type: 'menu' }),
      }
    ))
    expect(res.status).toBe(400)
  })

  test('wipes menu data with confirm:true', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/wipe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ type: 'menu', confirm: true }),
      }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
    expect(body.wiped).toBe('menu')
  })

  test('returns 400 for unknown wipe type', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/wipe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ type: 'unknown', confirm: true }),
      }
    ))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// S3 config — no rate limit
// ---------------------------------------------------------------------------

describe('Backup — S3 config', () => {
  test('GET /s3-config returns configured:false when no creds are stored', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/s3-config`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.configured).toBe(false)
  })

  test('PUT /s3-config returns 400 for invalid bucket name', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/s3-config`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          bucket: 'INVALID BUCKET',  // uppercase + spaces → invalid
          region: 'us-east-1',
        }),
      }
    ))
    expect(res.status).toBe(400)
  })

  test('DELETE /s3-config is idempotent — returns success even with no creds', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/s3-config`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)
  })
})
