/**
 * system-health route tests
 *
 * Tests:
 *  (a) GET health returns expected top-level shape
 *  (b) GET health requires authentication (no token → 401)
 *  (c) POST printer-test with no body → 400
 *  (d) POST printer-test with missing ip field → 400
 *  (e) POST printer-test with public IP (SSRF guard, F007) → 400
 *  (f) POST printer-test with loopback 127.x.x.x (not RFC-1918) → 400
 *  (g) POST printer-test with non-numeric IP → 400
 *  (h) POST printer-test requires authentication (no token → 401)
 *  (i) POST printer-test timeout path → 504 [todo — requires live network or mock]
 */

import { test, expect, beforeAll } from 'bun:test'
import { closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { app } from '../src/server'

// ── fixtures ──────────────────────────────────────────────────────────────────

let merchantId = ''
let accessToken = ''

// ── setup ──────────────────────────────────────────────────────────────────────

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
      email:        'owner@health.test',
      password:     'SecurePass123!',
      fullName:     'Health Owner',
      businessName: 'Health Cafe',
      slug:         'health-cafe',
    }),
  }))
  expect(res.status).toBe(201)
  const body = await res.json() as { merchant: { id: string }; tokens: { accessToken: string } }
  merchantId   = body.merchant.id
  accessToken  = body.tokens.accessToken
})

// ── helpers ────────────────────────────────────────────────────────────────────

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

function healthUrl(): string {
  return `http://localhost:3000/api/merchants/${merchantId}/system/health`
}

function printerTestUrl(): string {
  return `http://localhost:3000/api/merchants/${merchantId}/system/printer-test`
}

// ── health endpoint ───────────────────────────────────────────────────────────

test('(a) GET health returns expected top-level shape', async () => {
  const res = await app.fetch(new Request(healthUrl(), { headers: authHeaders() }))
  expect(res.status).toBe(200)
  const body = await res.json() as Record<string, unknown>

  // Required top-level keys
  expect(typeof body.timestamp).toBe('string')
  expect(body.system).toBeDefined()
  expect(typeof body.cpuNow).toBe('number')
  expect(Array.isArray(body.cpuHistory)).toBe(true)
  expect(Array.isArray(body.memHistory)).toBe(true)
  expect(Array.isArray(body.printers)).toBe(true)
  expect(Array.isArray(body.terminals)).toBe(true)
  expect(Array.isArray(body.recentErrors)).toBe(true)

  // system sub-object keys
  const system = body.system as Record<string, unknown>
  expect(typeof system.uptimeSec).toBe('number')
  expect(typeof system.startedAt).toBe('string')
  expect(Array.isArray(system.loadAvg)).toBe(true)
  expect(system.memory).toBeDefined()
  expect(system.disk).toBeDefined()
  expect(typeof system.platform).toBe('string')
  expect(typeof system.cpuCount).toBe('number')
})

test('(b) GET health requires authentication', async () => {
  const res = await app.fetch(new Request(healthUrl()))
  expect(res.status).toBe(401)
})

// ── printer-test validation ───────────────────────────────────────────────────

test('(c) POST printer-test with no body returns 400', async () => {
  const res = await app.fetch(new Request(printerTestUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: 'not-json',
  }))
  expect(res.status).toBe(400)
})

test('(d) POST printer-test with missing ip field returns 400', async () => {
  const res = await app.fetch(new Request(printerTestUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ protocol: 'star-line' }),
  }))
  expect(res.status).toBe(400)
  const body = await res.json() as { error: string }
  expect(body.error).toContain('ip')
})

// ── SSRF guard (F007) ─────────────────────────────────────────────────────────

test('(e) POST printer-test with public IP returns 400 (SSRF guard)', async () => {
  const res = await app.fetch(new Request(printerTestUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ip: '1.2.3.4' }),
  }))
  expect(res.status).toBe(400)
  const body = await res.json() as { error: string }
  expect(body.error).toContain('private')
})

test('(f) POST printer-test with loopback 127.0.0.1 returns 400 (not RFC-1918)', async () => {
  const res = await app.fetch(new Request(printerTestUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ip: '127.0.0.1' }),
  }))
  expect(res.status).toBe(400)
  const body = await res.json() as { error: string }
  expect(body.error).toContain('private')
})

test('(g) POST printer-test with non-numeric IP returns 400', async () => {
  const res = await app.fetch(new Request(printerTestUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ip: 'not.an.ip.address' }),
  }))
  expect(res.status).toBe(400)
  const body = await res.json() as { error: string }
  expect(body.error).toContain('private')
})

test('(h) POST printer-test requires authentication', async () => {
  const res = await app.fetch(new Request(printerTestUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: '192.168.1.100' }),
  }))
  expect(res.status).toBe(401)
})

test.todo('(i) POST printer-test with unreachable private IP returns 504 after timeout — requires live network or printDiagnostic mock')
