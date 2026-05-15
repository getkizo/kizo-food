/**
 * Integration tests for the redirect route.
 * Uses an in-memory DB so no external state is needed.
 */

import { describe, it, expect, beforeEach } from 'bun:test'

process.env.DB_PATH = ':memory:'
process.env.SESSION_SECRET = 'test-secret'

import { getDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import app from '../src/server'

const NOW = Date.now()

function seedCampaign(overrides: Record<string, unknown> = {}) {
  const db = getDatabase()
  db.run(`
    INSERT INTO campaigns (slug, slug_normalized, name, channel, source_label, mode,
      coupon_code_required, status, start_at, end_at,
      discount_type, discount_value, min_order_cents, max_uses_per_customer,
      redirect_target, created_at, updated_at)
    VALUES ('VP-2606-KIR','VP2606KIR','Test Campaign','valpak','valpak','single',
      ?,?,?,?,
      'percent',10,0,1,
      'https://demo-restaurant.kizo.example',?,?)
  `, [
    overrides.coupon_code_required ?? 0,
    overrides.status ?? 'active',
    overrides.start_at ?? NOW - 3_600_000,
    overrides.end_at   ?? NOW + 3_600_000,
    NOW, NOW,
  ])
}

beforeEach(() => {
  migrate()
  const db = getDatabase()
  db.exec('DELETE FROM campaigns')
  db.exec('DELETE FROM scans')
  db.exec('DELETE FROM rate_limits')
})

describe('GET /c/:slug — active campaign', () => {
  it('redirects to PWA with correct params', async () => {
    seedCampaign()
    const res = await app.request('/c/VP-2606-KIR', {
      headers: { 'cf-connecting-ip': '1.2.3.4', 'cf-ipcountry': 'US' },
    })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('demo-restaurant.kizo.example')
    expect(loc).toContain('c=VP-2606-KIR')
    expect(loc).toContain('src=valpak')
    expect(loc).toContain('t=')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('normalizes slug to match — vp2606kir → VP2606KIR', async () => {
    seedCampaign()
    const res = await app.request('/c/vp2606kir', {
      headers: { 'cf-connecting-ip': '1.2.3.5' },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('c=VP-2606-KIR')
  })
})

describe('GET /c/:slug — paused campaign', () => {
  it('redirects to fallback URL', async () => {
    seedCampaign({ status: 'paused' })
    const res = await app.request('/c/VP-2606-KIR', {
      headers: { 'cf-connecting-ip': '1.2.3.6' },
    })
    expect(res.status).toBe(302)
    // Fallback to default redirect, not PWA with campaign params
    const loc = res.headers.get('location') ?? ''
    expect(loc).not.toContain('c=VP-2606-KIR')
  })
})

describe('GET /c/:slug — unknown slug', () => {
  it('redirects to default PWA with src=unknown_campaign', async () => {
    const res = await app.request('/c/DOESNOTEXIST', {
      headers: { 'cf-connecting-ip': '1.2.3.7' },
    })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('src=unknown_campaign')
  })
})

describe('GET /c/:slug — expired campaign', () => {
  it('redirects to fallback URL', async () => {
    seedCampaign({ start_at: NOW - 7_200_000, end_at: NOW - 3_600_000 })
    const res = await app.request('/c/VP-2606-KIR', {
      headers: { 'cf-connecting-ip': '1.2.3.8' },
    })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).not.toContain('c=VP-2606-KIR')
  })
})

describe('scan logging', () => {
  it('inserts scan row on redirect', async () => {
    seedCampaign()
    await app.request('/c/VP-2606-KIR', {
      headers: { 'cf-connecting-ip': '1.2.3.9', 'cf-ipcountry': 'US' },
    })
    const db   = getDatabase()
    const scan = db.query<{ outcome: string; country: string }, []>(
      `SELECT outcome, country FROM scans LIMIT 1`
    ).get()
    expect(scan?.outcome).toBe('redirected')
    expect(scan?.country).toBe('US')
  })
})
