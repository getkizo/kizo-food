/**
 * Terminal management route tests
 *
 * Tests GET/POST/PUT/DELETE /api/merchants/:id/terminals
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

// ── fixtures ───────────────────────────────────────────────────────────────────

let ownerToken  = ''
let otherToken  = ''
let merchantId  = ''
let otherMerchantId = ''

// ── helpers ────────────────────────────────────────────────────────────────────

async function get(path: string, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }))
}

async function post(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

async function put(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  }))
}

async function del(path: string, token = ownerToken): Promise<Response> {
  return app.fetch(new Request(`http://localhost:3000${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }))
}

function terminalsPath(mid = merchantId) { return `/api/merchants/${mid}/terminals` }
function terminalPath(id: string, mid = merchantId) { return `/api/merchants/${mid}/terminals/${id}` }

// ── setup ──────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  // Register owner merchant
  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@terminals.test',
      password:     'SecurePass123!',
      fullName:     'Terminal Owner',
      businessName: 'Terminal Cafe',
      slug:         'terminal-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id

  // Register a second merchant for cross-merchant access tests
  const reg2Res = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'other@terminals.test',
      password:     'SecurePass123!',
      fullName:     'Other Owner',
      businessName: 'Other Cafe',
      slug:         'other-cafe',
    }),
  }))
  const reg2Body = await reg2Res.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  otherToken      = reg2Body.tokens.accessToken
  otherMerchantId = reg2Body.merchant.id
})

// ── GET ────────────────────────────────────────────────────────────────────────

describe('GET /api/merchants/:id/terminals', () => {
  test('returns empty list when no terminals', async () => {
    const res  = await get(terminalsPath())
    const body = await res.json() as { terminals: unknown[] }
    expect(res.status).toBe(200)
    expect(body.terminals).toEqual([])
  })

  test('requires authentication', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000${terminalsPath()}`))
    expect(res.status).toBe(401)
  })

  test('blocks cross-merchant access', async () => {
    const res = await get(terminalsPath(merchantId), otherToken)
    expect(res.status).toBe(403)
  })
})

// ── POST ───────────────────────────────────────────────────────────────────────

describe('POST /api/merchants/:id/terminals', () => {
  test('creates a terminal with all fields', async () => {
    const res  = await post(terminalsPath(), { model: 'pax_a920_pro', nickname: 'Counter 1', serialNumber: 'SN12345' })
    const body = await res.json() as { terminal: { id: string; model: string; nickname: string; serialNumber: string; createdAt: string } }
    expect(res.status).toBe(201)
    expect(body.terminal.model).toBe('pax_a920_pro')
    expect(body.terminal.nickname).toBe('Counter 1')
    expect(body.terminal.serialNumber).toBe('SN12345')
    expect(body.terminal.id).toMatch(/^term_/)
    expect(body.terminal.createdAt).toBeTruthy()
  })

  test('creates a terminal without serial number', async () => {
    const res  = await post(terminalsPath(), { model: 'pax_d135', nickname: 'Front Desk' })
    const body = await res.json() as { terminal: { serialNumber: null } }
    expect(res.status).toBe(201)
    expect(body.terminal.serialNumber).toBeNull()
  })

  test('creates all three supported models', async () => {
    for (const model of ['pax_a800', 'pax_a920_pro', 'pax_d135']) {
      const res = await post(terminalsPath(), { model, nickname: `Test ${model}` })
      expect(res.status).toBe(201)
    }
  })

  test('rejects invalid model', async () => {
    const res = await post(terminalsPath(), { model: 'clover_flex', nickname: 'Test' })
    expect(res.status).toBe(400)
  })

  test('rejects missing nickname', async () => {
    const res = await post(terminalsPath(), { model: 'pax_a800' })
    expect(res.status).toBe(400)
  })

  test('rejects empty nickname', async () => {
    const res = await post(terminalsPath(), { model: 'pax_a800', nickname: '   ' })
    expect(res.status).toBe(400)
  })

  test('rejects nickname > 64 chars', async () => {
    const res = await post(terminalsPath(), { model: 'pax_a800', nickname: 'A'.repeat(65) })
    expect(res.status).toBe(400)
  })

  test('row is persisted in DB', async () => {
    const res  = await post(terminalsPath(), { model: 'pax_a800', nickname: 'DB Check' })
    const body = await res.json() as { terminal: { id: string } }
    const db   = getDatabase()
    const row  = db.query<{ nickname: string }, [string]>(
      `SELECT nickname FROM terminals WHERE id = ?`
    ).get(body.terminal.id)
    expect(row?.nickname).toBe('DB Check')
  })

  test('requires authentication', async () => {
    const res = await app.fetch(new Request(`http://localhost:3000${terminalsPath()}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: 'pax_a800', nickname: 'Unauth' }),
    }))
    expect(res.status).toBe(401)
  })

  test('blocks cross-merchant creation', async () => {
    const res = await post(terminalsPath(merchantId), { model: 'pax_a800', nickname: 'Hack' }, otherToken)
    expect(res.status).toBe(403)
  })
})

// ── GET list after inserts ─────────────────────────────────────────────────────

describe('GET returns inserted terminals', () => {
  test('lists all terminals for merchant', async () => {
    const res  = await get(terminalsPath())
    const body = await res.json() as { terminals: { model: string }[] }
    expect(res.status).toBe(200)
    // Should have terminals from POST tests above (at least Counter 1)
    expect(body.terminals.length).toBeGreaterThan(0)
  })
})

// ── PUT ────────────────────────────────────────────────────────────────────────

describe('PUT /api/merchants/:id/terminals/:terminalId', () => {
  let termId = ''

  beforeAll(async () => {
    const res  = await post(terminalsPath(), { model: 'pax_a920_pro', nickname: 'Edit Me', serialNumber: 'OLD-SN' })
    const body = await res.json() as { terminal: { id: string } }
    termId = body.terminal.id
  })

  test('updates nickname', async () => {
    const res  = await put(terminalPath(termId), { nickname: 'Updated Name' })
    const body = await res.json() as { terminal: { nickname: string } }
    expect(res.status).toBe(200)
    expect(body.terminal.nickname).toBe('Updated Name')
  })

  test('updates serial number', async () => {
    const res  = await put(terminalPath(termId), { serialNumber: 'NEW-SN' })
    const body = await res.json() as { terminal: { serialNumber: string } }
    expect(res.status).toBe(200)
    expect(body.terminal.serialNumber).toBe('NEW-SN')
  })

  test('clears serial number when empty string sent', async () => {
    const res  = await put(terminalPath(termId), { serialNumber: '' })
    const body = await res.json() as { terminal: { serialNumber: null } }
    expect(res.status).toBe(200)
    expect(body.terminal.serialNumber).toBeNull()
  })

  test('returns 404 for unknown terminal', async () => {
    const res = await put(terminalPath('term_doesnotexist'), { nickname: 'X' })
    expect(res.status).toBe(404)
  })

  test('blocks cross-merchant update', async () => {
    const res = await put(terminalPath(termId, merchantId), { nickname: 'Hack' }, otherToken)
    expect(res.status).toBe(403)
  })
})

// ── DELETE ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/merchants/:id/terminals/:terminalId', () => {
  test('deletes a terminal', async () => {
    const createRes  = await post(terminalsPath(), { model: 'pax_d135', nickname: 'Delete Me' })
    const { terminal } = await createRes.json() as { terminal: { id: string } }

    const delRes = await del(terminalPath(terminal.id))
    expect(delRes.status).toBe(200)
    const body = await delRes.json() as { success: boolean }
    expect(body.success).toBe(true)

    // Confirm removed from DB
    const db  = getDatabase()
    const row = db.query<{ id: string }, [string]>(`SELECT id FROM terminals WHERE id = ?`).get(terminal.id)
    expect(row).toBeNull()
  })

  test('returns 404 when terminal not found', async () => {
    const res = await del(terminalPath('term_doesnotexist'))
    expect(res.status).toBe(404)
  })

  test('blocks cross-merchant deletion', async () => {
    const createRes  = await post(terminalsPath(), { model: 'pax_a800', nickname: 'Guard Me' })
    const { terminal } = await createRes.json() as { terminal: { id: string } }

    const res = await del(terminalPath(terminal.id, merchantId), otherToken)
    expect(res.status).toBe(403)
  })
})
