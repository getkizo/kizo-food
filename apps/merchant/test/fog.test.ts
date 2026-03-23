/**
 * F.O.G. route tests
 *
 * Focus: XSS regression for the public /fog-report HTML endpoint.
 * The endpoint renders merchant-supplied data (business_name, address) and
 * staff-supplied entry data (cleaned_by) as HTML — all must be escaped.
 *
 * Tests:
 *  (a) business_name containing <script> is escaped in the response
 *  (b) address containing <script> is escaped in the response
 *  (c) cleaned_by containing <script> is escaped in the response
 *  (d) /fog-report returns 404 when no merchant is configured
 */

import { test, expect, beforeAll } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { app } from '../src/server'
import { invalidateFogMerchantCache } from '../src/routes/fog'

// ── fixtures ──────────────────────────────────────────────────────────────────

const XSS = `<script>alert('xss')</script>`

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
      email:        'owner@fog.test',
      password:     'SecurePass123!',
      fullName:     'FOG Owner',
      businessName: `Grease Co ${XSS}`,
      slug:         'grease-co',
    }),
  }))
  expect(res.status).toBe(201)
  const body = await res.json() as { merchant: { id: string } }
  const merchantId = body.merchant.id

  const db = getDatabase()

  // Set address to contain XSS payload
  db.run(`UPDATE merchants SET address = ? WHERE id = ?`, [`123 Main St ${XSS}`, merchantId])

  // Insert a fog entry with XSS in cleaned_by
  db.run(
    `INSERT INTO fog_entries (id, merchant_id, cleaned_date, cleaned_by, grease_gallons, solids_gallons)
     VALUES ('fog_test_1', ?, '2025-01-15', ?, 12.5, 3)`,
    [merchantId, `Acme Grease ${XSS}`]
  )

  // Reset cache so the handler picks up the test merchant
  invalidateFogMerchantCache()
})

// ── helpers ────────────────────────────────────────────────────────────────────

async function getFogReport(): Promise<string> {
  const res = await app.fetch(new Request('http://localhost:3000/fog-report'))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  return res.text()
}

// ── tests ──────────────────────────────────────────────────────────────────────

test('(a) business_name with <script> is HTML-escaped in /fog-report', async () => {
  const html = await getFogReport()
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
})

test('(b) address with <script> is HTML-escaped in /fog-report', async () => {
  const html = await getFogReport()
  // The literal tag must not appear; the escaped form must be present
  expect(html).not.toContain('<script>')
  // Confirm the address section contains escaped content (not just from business_name)
  expect(html).toContain('123 Main St')
  expect(html).toContain('&lt;script&gt;')
})

test('(c) cleaned_by with <script> is HTML-escaped in /fog-report', async () => {
  const html = await getFogReport()
  expect(html).not.toContain('<script>')
  expect(html).toContain('Acme Grease')
  expect(html).toContain('&lt;script&gt;')
})

test('(d) /fog-report returns 404 when no active merchant exists', async () => {
  // Use a fresh in-memory DB with no merchants
  closeDatabase()
  process.env.DATABASE_PATH = ':memory:'
  await migrate()
  await initializeMasterKey()
  invalidateFogMerchantCache()

  const res = await app.fetch(new Request('http://localhost:3000/fog-report'))
  expect(res.status).toBe(404)
})
