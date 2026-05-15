/**
 * Marketing admin panel — served at /marketing/*
 *
 * All routes (except /marketing/login) require a valid session cookie.
 *
 * POST /marketing/login
 * POST /marketing/logout
 * GET  /marketing                      → dashboard HTML
 * GET  /marketing/campaigns            → campaign list JSON
 * POST /marketing/campaigns            → create campaign
 * GET  /marketing/campaigns/:id        → campaign detail JSON
 * PATCH /marketing/campaigns/:id       → update campaign
 * POST /marketing/campaigns/:id/pause  → pause
 * POST /marketing/campaigns/:id/resume → resume
 * POST /marketing/campaigns/:id/end    → end
 * GET  /marketing/campaigns/:id/qr.png → QR PNG
 * GET  /marketing/campaigns/:id/scans.csv → scan log export
 * GET  /marketing/metrics             → JSON metrics
 */

import { Hono } from 'hono'
import { ulid } from 'ulid'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getDatabase } from '../db/connection'
import { generateQrPng, generateQrDataUrl } from '../services/qr'
import {
  checkLoginRateLimit, clearLoginRateLimit,
  hashPassword, verifyPassword,
  createSession, destroySession,
  getSessionUser, requireSession,
  type AdminUser,
} from '../services/auth'
import { normalizeSlug, isValidSlug } from '../utils/slug'

type Variables = { adminUser: AdminUser }
const marketing = new Hono<{ Variables: Variables }>()

// ---------------------------------------------------------------------------
// Login / Logout
// ---------------------------------------------------------------------------

marketing.get('/marketing/login', (c) => {
  const err = c.req.query('error')
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Marketing Engine — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; padding: 40px; width: 360px;
            box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 24px; color: #111; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #555; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px;
            font-size: 15px; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #2563eb; }
    button { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none;
             border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .error { background: #fef2f2; color: #dc2626; padding: 10px 14px; border-radius: 8px;
             font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Marketing Engine</h1>
    ${err ? `<div class="error">${err === 'invalid' ? 'Invalid email or password.' : 'Too many attempts. Wait 15 minutes.'}</div>` : ''}
    <form method="POST" action="/marketing/login">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`)
})

marketing.post('/marketing/login', async (c) => {
  const ip   = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
  if (!checkLoginRateLimit(ip)) return c.redirect('/marketing/login?error=rate_limited')

  const body = await c.req.parseBody()
  const email    = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')

  const db  = getDatabase()
  const row = db.query<{ id: number; password_hash: string }, [string]>(
    `SELECT id, password_hash FROM admin_users WHERE email = ?`
  ).get(email)

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return c.redirect('/marketing/login?error=invalid')
  }

  clearLoginRateLimit(ip)
  createSession(c, row.id)
  return c.redirect('/marketing')
})

marketing.post('/marketing/logout', (c) => {
  destroySession(c)
  return c.redirect('/marketing/login')
})

// ---------------------------------------------------------------------------
// All remaining routes require authentication
// ---------------------------------------------------------------------------
marketing.use('/marketing/*', requireSession)

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------
marketing.get('/marketing/', (c) => c.redirect('/marketing', 301))

marketing.get('/marketing', async (c) => {
  const db = getDatabase()
  const campaigns = db.query<{
    id: number; name: string; slug: string; channel: string; status: string;
    start_at: number; end_at: number; discount_type: string; discount_value: number;
    fulfillment_restriction: string | null; scan_count: number
  }, []>(
    `SELECT c.id, c.name, c.slug, c.channel, c.status,
            c.start_at, c.end_at, c.discount_type, c.discount_value,
            c.fulfillment_restriction,
            COUNT(s.id) AS scan_count
     FROM campaigns c
     LEFT JOIN scans s ON s.campaign_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC`
  ).all()

  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const statusBadge = (s: string) => {
    const colors: Record<string, string> = { active: '#16a34a', paused: '#d97706', ended: '#6b7280', draft: '#2563eb' }
    const bg = colors[s] ?? '#6b7280'
    return `<span style="background:${bg};color:#fff;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600">${s}</span>`
  }
  const fmtDiscount = (type: string, val: number) =>
    type === 'percent' ? `${val}% off` : `$${(val / 100).toFixed(2)} off`

  const rows = campaigns.map(c => `
    <tr>
      <td><a href="/marketing/campaigns/${c.id}" style="color:#2563eb;font-weight:600">${esc(c.name)}</a></td>
      <td><code>${esc(c.slug)}</code></td>
      <td>${esc(c.channel)}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${fmtDiscount(c.discount_type, c.discount_value)}</td>
      <td>${c.fulfillment_restriction ? esc(c.fulfillment_restriction) : 'Any'}</td>
      <td>${fmtDate(c.start_at)} – ${fmtDate(c.end_at)}</td>
      <td style="text-align:right">${c.scan_count.toLocaleString()}</td>
    </tr>`).join('')

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Marketing Engine</title>
  ${adminStyles()}
</head>
<body>
  ${adminNav('campaigns')}
  <main class="main">
    <div class="page-header">
      <h1>Campaigns</h1>
      <a href="/marketing/campaigns/new" class="btn">+ New Campaign</a>
    </div>
    <div class="card">
      <table class="table">
        <thead>
          <tr>
            <th>Name</th><th>Slug</th><th>Channel</th><th>Status</th>
            <th>Offer</th><th>Fulfillment</th><th>Window</th><th style="text-align:right">Scans</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#888;padding:32px">No campaigns yet</td></tr>'}</tbody>
      </table>
    </div>
  </main>
</body>
</html>`)
})

// ---------------------------------------------------------------------------
// Campaign detail
// ---------------------------------------------------------------------------
marketing.get('/marketing/campaigns/new', (c) => {
  return c.html(campaignFormHtml(null))
})

marketing.get('/marketing/campaigns/:id/edit', (c) => {
  const db = getDatabase()
  const id = Number(c.req.param('id'))
  const campaign = db.query<CampaignRow, [number]>(`SELECT * FROM campaigns WHERE id = ?`).get(id)
  if (!campaign) return c.text('Not found', 404)
  return c.html(campaignFormHtml(campaign))
})

marketing.get('/marketing/campaigns/:id', async (c) => {
  const db = getDatabase()
  const id = Number(c.req.param('id'))
  const campaign = db.query<CampaignRow, [number]>(
    `SELECT * FROM campaigns WHERE id = ?`
  ).get(id)
  if (!campaign) return c.text('Not found', 404)

  const recentScans = db.query<{ ts: number; outcome: string; country: string | null; user_agent: string | null }, [number]>(
    `SELECT ts, outcome, country, user_agent FROM scans WHERE campaign_id = ? ORDER BY ts DESC LIMIT 20`
  ).all(id)

  const stats7d = db.query<{ total: number; redirected: number }, [number, number]>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome='redirected' THEN 1 ELSE 0 END) AS redirected
     FROM scans WHERE campaign_id = ? AND ts > ?`
  ).get(id, Date.now() - 7 * 86_400_000)

  const proto = c.req.header('x-forwarded-proto') ?? 'https'
  const host  = c.req.header('host') ?? 'kizo.example'
  const qrDataUrl = await generateQrDataUrl(`${proto}://${host}/c/${campaign.slug}`)

  return c.html(campaignDetailHtml(campaign, recentScans, stats7d, qrDataUrl))
})

// ---------------------------------------------------------------------------
// Campaign CRUD API (JSON)
// ---------------------------------------------------------------------------
marketing.get('/marketing/campaigns', (c) => {
  const db = getDatabase()
  const rows = db.query<CampaignRow, []>(`SELECT * FROM campaigns ORDER BY created_at DESC`).all()
  return c.json({ campaigns: rows })
})

marketing.post('/marketing/campaigns', async (c) => {
  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const err = validateCampaignBody(body)
  if (err) return c.json({ error: err }, 400)

  const slug = String(body.slug)
  if (!isValidSlug(slug)) return c.json({ error: 'Invalid slug format' }, 400)
  const slugNorm = normalizeSlug(slug)

  const db = getDatabase()
  const now = Date.now()

  try {
    db.run(
      `INSERT INTO campaigns (slug, slug_normalized, name, channel, source_label, mode,
        coupon_code_required, status, start_at, end_at,
        schedule_json, campaign_type,
        discount_type, discount_value, min_order_cents, fulfillment_restriction,
        max_uses_global, max_uses_per_customer, expected_impressions, drop_cost_cents,
        redirect_target, fallback_url, notes,
        target_json, trigger_json, reward_json,
        created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        slug, slugNorm,
        String(body.name), String(body.channel), String(body.source_label ?? body.channel),
        String(body.mode ?? 'single'),
        body.coupon_code_required ? 1 : 0,
        String(body.status ?? 'draft'),
        Number(body.start_at), Number(body.end_at),
        body.schedule_json ? String(body.schedule_json) : null,
        String(body.campaign_type ?? 'coupon'),
        String(body.discount_type), Number(body.discount_value),
        Number(body.min_order_cents ?? 0),
        body.fulfillment_restriction ? String(body.fulfillment_restriction) : null,
        body.max_uses_global ? Number(body.max_uses_global) : null,
        Number(body.max_uses_per_customer ?? 1),
        body.expected_impressions ? Number(body.expected_impressions) : null,
        body.drop_cost_cents ? Number(body.drop_cost_cents) : null,
        String(body.redirect_target ?? 'https://demo-restaurant.kizo.example'),
        body.fallback_url ? String(body.fallback_url) : null,
        body.notes ? String(body.notes) : null,
        body.target_json  ? String(body.target_json)  : null,
        body.trigger_json ? String(body.trigger_json) : null,
        body.reward_json  ? String(body.reward_json)  : null,
        now, now,
      ]
    )
    const row = db.query<CampaignRow, [string]>(`SELECT * FROM campaigns WHERE slug = ?`).get(slug)
    return c.json(row, 201)
  } catch (err: unknown) {
    if (String(err).includes('UNIQUE')) return c.json({ error: 'Slug already exists' }, 409)
    throw err
  }
})

marketing.patch('/marketing/campaigns/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const db = getDatabase()
  const existing = db.query<CampaignRow, [number]>(`SELECT * FROM campaigns WHERE id = ?`).get(id)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  // Cannot change slug once scans exist
  if (body.slug && String(body.slug) !== existing.slug) {
    const scanCount = db.query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM scans WHERE campaign_id = ?`
    ).get(id)?.n ?? 0
    if (scanCount > 0) return c.json({ error: 'Cannot change slug after scans exist' }, 409)
  }

  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [Date.now()]

  const str = (k: string) => { if (body[k] !== undefined) { sets.push(`${k} = ?`); params.push(String(body[k])) } }
  const num = (k: string) => { if (body[k] !== undefined) { sets.push(`${k} = ?`); params.push(Number(body[k])) } }
  const nullable = (k: string) => { if (body[k] !== undefined) { sets.push(`${k} = ?`); params.push(body[k] ? String(body[k]) : null) } }

  str('name'); str('channel'); str('source_label'); str('status')
  str('discount_type'); str('fulfillment_restriction'); str('campaign_type')
  num('start_at'); num('end_at'); num('discount_value'); num('min_order_cents')
  num('max_uses_per_customer'); num('expected_impressions'); num('drop_cost_cents')
  nullable('fallback_url'); nullable('notes'); nullable('fulfillment_restriction')
  nullable('schedule_json'); nullable('target_json'); nullable('trigger_json'); nullable('reward_json')

  params.push(id)
  db.run(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`, params as string[])
  return c.json(db.query<CampaignRow, [number]>(`SELECT * FROM campaigns WHERE id = ?`).get(id))
})

marketing.post('/marketing/campaigns/:id/pause', (c) => {
  const id = Number(c.req.param('id'))
  const db = getDatabase()
  if (!db.query<{ id: number }, [number]>(`SELECT id FROM campaigns WHERE id = ?`).get(id))
    return c.json({ error: 'Not found' }, 404)
  db.run(`UPDATE campaigns SET status='paused', updated_at=? WHERE id=?`, [Date.now(), id])
  return c.json({ success: true })
})

marketing.post('/marketing/campaigns/:id/resume', (c) => {
  const id  = Number(c.req.param('id'))
  const db  = getDatabase()
  const now = Date.now()
  const row = db.query<{ end_at: number }, [number]>(`SELECT end_at FROM campaigns WHERE id = ?`).get(id)
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (now > row.end_at) return c.json({ error: 'Campaign window has ended' }, 409)
  db.run(`UPDATE campaigns SET status='active', updated_at=? WHERE id=?`, [now, id])
  return c.json({ success: true })
})

marketing.post('/marketing/campaigns/:id/end', (c) => {
  const id  = Number(c.req.param('id'))
  const db  = getDatabase()
  const now = Date.now()
  if (!db.query<{ id: number }, [number]>(`SELECT id FROM campaigns WHERE id = ?`).get(id))
    return c.json({ error: 'Not found' }, 404)
  db.run(`UPDATE campaigns SET status='ended', end_at=?, updated_at=? WHERE id=?`, [now, now, id])
  return c.json({ success: true })
})

// ---------------------------------------------------------------------------
// QR PNG
// ---------------------------------------------------------------------------
marketing.get('/marketing/campaigns/:id/qr.png', async (c) => {
  const id = Number(c.req.param('id'))
  const db = getDatabase()
  const row = db.query<{ slug: string; redirect_target: string }, [number]>(
    `SELECT slug, redirect_target FROM campaigns WHERE id = ?`
  ).get(id)
  if (!row) return c.text('Not found', 404)

  const size = Number(c.req.query('size') ?? 512)
  const url  = `https://qr.kizo.example/c/${row.slug}`
  const png  = await generateQrPng(url, Math.min(Math.max(size, 64), 2048))

  c.header('Content-Type', 'image/png')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(png)
})

// ---------------------------------------------------------------------------
// Print PDF — A6 card: QR + slug + offer summary (for print-test drops)
// ---------------------------------------------------------------------------
marketing.get('/marketing/campaigns/:id/print.pdf', async (c) => {
  const id = Number(c.req.param('id'))
  const db = getDatabase()
  const row = db.query<{
    slug: string; name: string; discount_type: string; discount_value: number
    end_at: number; min_order_cents: number; fulfillment_restriction: string | null
  }, [number]>(
    `SELECT slug, name, discount_type, discount_value, end_at, min_order_cents, fulfillment_restriction
     FROM campaigns WHERE id = ?`
  ).get(id)
  if (!row) return c.text('Not found', 404)

  const qrUrl = `https://qr.kizo.example/c/${row.slug}`
  const qrPng = await generateQrPng(qrUrl, 300)

  // A6: 105mm × 148mm → 298pt × 420pt (1pt = 1/72in, 1mm = 2.835pt)
  const W = 298, H = 420
  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([W, H])

  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const black   = rgb(0.05, 0.05, 0.05)
  const grey    = rgb(0.4, 0.4, 0.4)
  const green   = rgb(0.09, 0.64, 0.29)

  // Header: campaign name
  const nameSize = row.name.length > 28 ? 11 : 13
  page.drawText(row.name, { x: 20, y: H - 28, font: bold, size: nameSize, color: black,
    maxWidth: W - 40 })

  // QR code image centered
  const qrImg  = await pdfDoc.embedPng(qrPng)
  const qrSize = 160
  const qrX    = (W - qrSize) / 2
  const qrY    = H - 48 - qrSize
  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize })

  // Slug below QR
  const slugW = regular.widthOfTextAtSize(row.slug, 10)
  page.drawText(row.slug, { x: (W - slugW) / 2, y: qrY - 16, font: bold, size: 10, color: grey })

  // Discount headline
  const offerLabel = row.discount_type === 'percent'
    ? `${row.discount_value}% OFF YOUR ORDER`
    : `$${(row.discount_value / 100).toFixed(2)} OFF YOUR ORDER`
  const offerW = bold.widthOfTextAtSize(offerLabel, 16)
  page.drawText(offerLabel, { x: (W - offerW) / 2, y: qrY - 42, font: bold, size: 16, color: green })

  // Details line
  const details: string[] = []
  if (row.min_order_cents > 0) details.push(`min $${(row.min_order_cents / 100).toFixed(2)}`)
  if (row.fulfillment_restriction) details.push(row.fulfillment_restriction.replace('_', '-'))
  details.push(`valid until ${new Date(row.end_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`)
  const detailLine = details.join(' · ')
  const detailW = regular.widthOfTextAtSize(detailLine, 8)
  page.drawText(detailLine, { x: (W - detailW) / 2, y: qrY - 58, font: regular, size: 8, color: grey })

  // Footer URL
  page.drawText('kizo.example', { x: 20, y: 18, font: regular, size: 8, color: grey })

  const pdfBytes = await pdfDoc.save()
  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `attachment; filename="campaign-${row.slug}.pdf"`)
  return c.body(pdfBytes)
})

// ---------------------------------------------------------------------------
// Scans CSV export
// ---------------------------------------------------------------------------
marketing.get('/marketing/campaigns/:id/scans.csv', (c) => {
  const id = Number(c.req.param('id'))
  const db = getDatabase()
  if (!db.query<{ id: number }, [number]>(`SELECT id FROM campaigns WHERE id = ?`).get(id))
    return c.text('Not found', 404)

  const rows = db.query<{
    id: string; ts: number; outcome: string; country: string | null;
    slug_requested: string; code_requested: string | null; ip_hash: string
  }, [number]>(
    `SELECT id, ts, outcome, country, slug_requested, code_requested, ip_hash
     FROM scans WHERE campaign_id = ? ORDER BY ts DESC`
  ).all(id)

  const lines = ['id,ts_iso,outcome,country,slug_requested,code_requested,ip_hash']
  for (const r of rows) {
    lines.push([
      r.id,
      new Date(r.ts).toISOString(),
      r.outcome,
      r.country ?? '',
      r.slug_requested,
      r.code_requested ?? '',
      r.ip_hash,
    ].join(','))
  }

  c.header('Content-Type', 'text/csv')
  c.header('Content-Disposition', `attachment; filename="campaign-${id}-scans.csv"`)
  return c.text(lines.join('\n'))
})

// ---------------------------------------------------------------------------
// Metrics JSON
// ---------------------------------------------------------------------------
marketing.get('/marketing/metrics', (c) => {
  const db  = getDatabase()
  const now = Date.now()

  const windows = [
    { label: '1h',  since: now - 3_600_000 },
    { label: '24h', since: now - 86_400_000 },
    { label: '7d',  since: now - 7 * 86_400_000 },
  ]

  const perWindow = windows.map(w => {
    const row = db.query<{ total: number; redirected: number; fallback: number; invalid: number }, [number]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN outcome='redirected' THEN 1 ELSE 0 END) AS redirected,
              SUM(CASE WHEN outcome='fallback'   THEN 1 ELSE 0 END) AS fallback,
              SUM(CASE WHEN outcome NOT IN ('redirected','fallback') THEN 1 ELSE 0 END) AS invalid
       FROM scans WHERE ts > ?`
    ).get(w.since)!
    return { window: w.label, ...row }
  })

  return c.json({ metrics: perWindow, generated_at: new Date().toISOString() })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CampaignRow = {
  id: number; slug: string; slug_normalized: string; name: string;
  channel: string; source_label: string; mode: string
  coupon_code_required: number; status: string
  start_at: number; end_at: number
  schedule_json: string | null; campaign_type: string
  discount_type: string; discount_value: number; min_order_cents: number
  fulfillment_restriction: string | null
  max_uses_global: number | null; max_uses_per_customer: number
  expected_impressions: number | null; drop_cost_cents: number | null
  redirect_target: string; fallback_url: string | null; notes: string | null
  target_json: string | null; trigger_json: string | null; reward_json: string | null
  created_at: number; updated_at: number
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function adminStyles(): string {
  return `<style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f7fa; color: #111; }
    .nav { background: #1e293b; color: #fff; padding: 0 24px;
           display: flex; align-items: center; gap: 24px; height: 56px; }
    .nav-brand { font-size: 17px; font-weight: 700; color: #fff; text-decoration: none; }
    .nav a { color: #94a3b8; text-decoration: none; font-size: 14px; }
    .nav a.active, .nav a:hover { color: #fff; }
    .main { max-width: 1200px; margin: 32px auto; padding: 0 24px; }
    .page-header { display: flex; align-items: center; justify-content: space-between;
                   margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 700; }
    .btn { background: #2563eb; color: #fff; padding: 8px 16px; border-radius: 8px;
           text-decoration: none; font-size: 14px; font-weight: 600; border: none;
           cursor: pointer; display: inline-block; }
    .btn-danger { background: #dc2626; }
    .btn-secondary { background: #64748b; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 6px rgba(0,0,0,.07);
            overflow: hidden; }
    .table { width: 100%; border-collapse: collapse; }
    .table th { background: #f8fafc; font-size: 12px; font-weight: 600; color: #64748b;
                padding: 10px 16px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    .table td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
    .table tr:last-child td { border-bottom: none; }
    code { font-size: 13px; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
  </style>`
}

function adminNav(active: string): string {
  return `<nav class="nav">
    <a href="/marketing" class="nav-brand">Marketing Engine</a>
    <a href="/marketing" class="${active === 'campaigns' ? 'active' : ''}">Campaigns</a>
    <a href="/marketing/metrics" style="margin-left:auto">Metrics</a>
    <button id="me-deploy-btn" class="btn btn-secondary" style="padding:6px 12px;font-size:13px">Deploy</button>
    <form method="POST" action="/marketing/logout" style="margin:0">
      <button class="btn btn-secondary" style="padding:6px 12px;font-size:13px">Sign out</button>
    </form>
  </nav>
  <script>
    document.getElementById('me-deploy-btn').addEventListener('click', async function() {
      if (!confirm('Pull latest code from GitHub and restart the marketing engine?')) return
      this.disabled = true; this.textContent = 'Deploying…'
      try {
        const res = await fetch('/marketing/deploy', { method: 'POST' })
        if (res.ok) {
          this.textContent = 'Restarting…'
          setTimeout(() => location.reload(), 8000)
        } else {
          const j = await res.json()
          alert(j.error || 'Deploy failed')
          this.disabled = false; this.textContent = 'Deploy'
        }
      } catch {
        alert('Deploy request failed')
        this.disabled = false; this.textContent = 'Deploy'
      }
    })
  </script>`
}

function validateCampaignBody(body: Record<string, unknown>): string | null {
  if (!body.slug)           return 'slug required'
  if (!body.name)           return 'name required'
  if (!body.channel)        return 'channel required'
  if (!body.start_at)       return 'start_at required'
  if (!body.end_at)         return 'end_at required'
  if (!body.discount_type)  return 'discount_type required'
  if (body.discount_value === undefined) return 'discount_value required'
  if (!['percent', 'fixed_cents'].includes(String(body.discount_type)))
    return 'discount_type must be percent or fixed_cents'
  if (Number(body.start_at) >= Number(body.end_at))
    return 'end_at must be after start_at'
  return null
}

function _parsedJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
}
function _bogoTriggerType(r: CampaignRow | null): string {
  return String(_parsedJson(r?.trigger_json).type ?? 'item_quantity')
}
function _bogoTriggerName(r: CampaignRow | null): string {
  const t = _parsedJson(r?.trigger_json)
  return esc(String(t.item_name ?? t.category ?? ''))
}
function _bogoTriggerQty(r: CampaignRow | null): string {
  return String(_parsedJson(r?.trigger_json).quantity ?? 1)
}
function _bogoRewardType(r: CampaignRow | null): string {
  return String(_parsedJson(r?.reward_json).type ?? 'free_item')
}
function _bogoRewardItem(r: CampaignRow | null): string {
  return esc(String(_parsedJson(r?.reward_json).item_name ?? ''))
}
function _bogoRewardMaxQty(r: CampaignRow | null): string {
  return String(_parsedJson(r?.reward_json).max_quantity ?? 1)
}

function campaignFormHtml(existing: CampaignRow | null): string {
  const v = (k: keyof CampaignRow) => existing ? esc(String(existing[k] ?? '')) : ''
  const title = existing ? `Edit: ${esc(existing.name)}` : 'New Campaign'
  const action = existing ? `/marketing/campaigns/${existing.id}/form` : '/marketing/campaigns/form'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Marketing Engine</title>
  ${adminStyles()}
  <style>
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 24px; }
    .full { grid-column: span 2; }
    label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 6px; }
    input, select, textarea { width: 100%; padding: 9px 12px; border: 1px solid #ddd;
      border-radius: 8px; font-size: 15px; font-family: inherit; }
    .form-actions { padding: 0 24px 24px; display: flex; gap: 12px; }
  </style>
</head>
<body>
  ${adminNav('campaigns')}
  <main class="main">
    <div class="page-header"><h1>${title}</h1></div>
    <div class="card">
      <form id="form" onsubmit="submitForm(event)">
        <div class="form-grid">
          <div>
            <label>Slug <small style="color:#888">(e.g. VP-2606-KIR, max 24 chars)</small></label>
            <input name="slug" value="${v('slug')}" ${existing ? 'readonly' : 'required'} placeholder="VP-2606-KIR">
          </div>
          <div>
            <label>Campaign name</label>
            <input name="name" value="${v('name')}" required placeholder="Valpak June 2026 Kirkland">
          </div>
          <div>
            <label>Channel</label>
            <input name="channel" value="${v('channel') || 'valpak'}" required placeholder="valpak">
          </div>
          <div>
            <label>Source label <small style="color:#888">(?src= param)</small></label>
            <input name="source_label" value="${v('source_label')}" placeholder="valpak">
          </div>
          <div>
            <label>Status</label>
            <select name="status">
              ${['draft','active','paused','ended'].map(s =>
                `<option value="${s}" ${(existing?.status ?? 'draft') === s ? 'selected' : ''}>${s}</option>`
              ).join('')}
            </select>
          </div>
          <div>
            <label>Fulfillment restriction</label>
            <select name="fulfillment_restriction">
              <option value="">Any</option>
              ${['dine_in','takeout','delivery'].map(s =>
                `<option value="${s}" ${existing?.fulfillment_restriction === s ? 'selected' : ''}>${s}</option>`
              ).join('')}
            </select>
          </div>
          <div>
            <label>Discount type</label>
            <select name="discount_type">
              <option value="percent"     ${(existing?.discount_type ?? 'percent') === 'percent'     ? 'selected' : ''}>Percent off</option>
              <option value="fixed_cents" ${existing?.discount_type === 'fixed_cents' ? 'selected' : ''}>Fixed amount ($)</option>
            </select>
          </div>
          <div>
            <label>Discount value <small style="color:#888">(15 for 15%, or 500 for $5.00)</small></label>
            <input name="discount_value" type="number" min="0" value="${v('discount_value') || '10'}" required>
          </div>
          <div>
            <label>Min order (cents) <small style="color:#888">(0 = no minimum)</small></label>
            <input name="min_order_cents" type="number" min="0" value="${v('min_order_cents') || '0'}">
          </div>
          <div>
            <label>Max uses per customer</label>
            <input name="max_uses_per_customer" type="number" min="1" value="${v('max_uses_per_customer') || '1'}">
          </div>
          <div>
            <label>Start date</label>
            <input name="start_at_local" type="datetime-local"
              value="${existing ? new Date(existing.start_at).toISOString().slice(0,16) : ''}">
          </div>
          <div>
            <label>End date</label>
            <input name="end_at_local" type="datetime-local"
              value="${existing ? new Date(existing.end_at).toISOString().slice(0,16) : ''}">
          </div>
          <div>
            <label>Expected impressions <small style="color:#888">(Valpak drop size)</small></label>
            <input name="expected_impressions" type="number" min="0" value="${v('expected_impressions')}">
          </div>
          <div>
            <label>Drop cost (cents) <small style="color:#888">(for CAC math)</small></label>
            <input name="drop_cost_cents" type="number" min="0" value="${v('drop_cost_cents')}">
          </div>
          <div class="full">
            <label>Redirect target <small style="color:#888">(PWA URL)</small></label>
            <input name="redirect_target" value="${v('redirect_target') || 'https://demo-restaurant.kizo.example'}" required>
          </div>
          <div class="full">
            <label>Notes</label>
            <textarea name="notes" rows="2" placeholder="Optional internal notes">${v('notes')}</textarea>
          </div>

          <div class="full" style="border-top:1px solid #e2e8f0;padding-top:16px;margin-top:4px">
            <h3 style="font-size:14px;font-weight:700;color:#374151;margin-bottom:12px">Campaign Type &amp; Offer Scope</h3>
          </div>
          <div>
            <label>Campaign type</label>
            <select name="campaign_type" id="campaign_type" onchange="onTypeChange()">
              <option value="coupon" ${(existing?.campaign_type ?? 'coupon') === 'coupon' ? 'selected' : ''}>Coupon (order or item discount)</option>
              <option value="bogo"   ${existing?.campaign_type === 'bogo'   ? 'selected' : ''}>BOGO / Conditional ("Get X if you order Y")</option>
            </select>
          </div>
          <div></div>

          <!-- ── Coupon: item target ─────────────────────────────────────── -->
          <div id="section-target" class="full" style="${existing?.campaign_type === 'bogo' ? 'display:none' : ''}">
            <label>Target item name <small style="color:#888">(leave blank = whole order discount)</small></label>
            <input name="target_item_name" placeholder="Pad Thai"
              value="${existing?.target_json ? esc(JSON.parse(existing.target_json).item_name ?? '') : ''}">
          </div>

          <!-- ── BOGO: trigger + reward ──────────────────────────────────── -->
          <div id="section-bogo" class="full" style="${existing?.campaign_type !== 'bogo' ? 'display:none' : ''}">
            <fieldset style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px">
              <legend style="font-size:13px;font-weight:600;color:#555;padding:0 6px">Trigger condition</legend>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                <div>
                  <label>Trigger type</label>
                  <select name="trigger_type">
                    <option value="item_quantity"     ${_bogoTriggerType(existing) === 'item_quantity'     ? 'selected' : ''}>Item quantity</option>
                    <option value="category_quantity" ${_bogoTriggerType(existing) === 'category_quantity' ? 'selected' : ''}>Category quantity</option>
                  </select>
                </div>
                <div>
                  <label>Item or category name</label>
                  <input name="trigger_name" placeholder="Fresh Rolls" value="${_bogoTriggerName(existing)}">
                </div>
                <div>
                  <label>Minimum quantity</label>
                  <input name="trigger_quantity" type="number" min="1" value="${_bogoTriggerQty(existing)}">
                </div>
              </div>
            </fieldset>
            <fieldset style="border:1px solid #e2e8f0;border-radius:8px;padding:16px">
              <legend style="font-size:13px;font-weight:600;color:#555;padding:0 6px">Reward</legend>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
                <div>
                  <label>Reward type</label>
                  <select name="reward_type">
                    <option value="free_item"     ${_bogoRewardType(existing) === 'free_item'     ? 'selected' : ''}>Free item</option>
                    <option value="item_discount" ${_bogoRewardType(existing) === 'item_discount' ? 'selected' : ''}>Item discount</option>
                  </select>
                </div>
                <div>
                  <label>Reward item name</label>
                  <input name="reward_item_name" placeholder="Pot Stickers" value="${_bogoRewardItem(existing)}">
                </div>
                <div>
                  <label>Max reward qty</label>
                  <input name="reward_max_quantity" type="number" min="1" value="${_bogoRewardMaxQty(existing)}">
                </div>
                <div>
                  <label>Discount value <small style="color:#888">(if item_discount; type+value from above)</small></label>
                  <input name="reward_discount_override" placeholder="e.g. 50 for 50% or 200 for $2.00" value="">
                </div>
              </div>
            </fieldset>
          </div>

          <!-- ── Schedule window ────────────────────────────────────────── -->
          <div class="full" style="border-top:1px solid #e2e8f0;padding-top:16px;margin-top:4px">
            <h3 style="font-size:14px;font-weight:700;color:#374151;margin-bottom:12px">Schedule Restriction <small style="font-weight:400;color:#888">(optional — leave blank for all-day / all-week)</small></h3>
          </div>
          <div class="full">
            <label>Days of week</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => {
                const days = existing?.schedule_json ? (JSON.parse(existing.schedule_json).days ?? []) : []
                const checked = days.includes(i) ? 'checked' : ''
                return `<label style="display:flex;align-items:center;gap:4px;font-weight:400;font-size:14px;cursor:pointer">
                  <input type="checkbox" name="sched_day_${i}" value="${i}" ${checked}> ${d}
                </label>`
              }).join('')}
            </div>
          </div>
          <div>
            <label>Window start <small style="color:#888">(HH:MM, 24h)</small></label>
            <input name="sched_start" type="time"
              value="${existing?.schedule_json ? (JSON.parse(existing.schedule_json).windows?.[0]?.start ?? '') : ''}">
          </div>
          <div>
            <label>Window end <small style="color:#888">(HH:MM, 24h)</small></label>
            <input name="sched_end" type="time"
              value="${existing?.schedule_json ? (JSON.parse(existing.schedule_json).windows?.[0]?.end ?? '') : ''}">
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Save campaign</button>
          <a href="/marketing" class="btn btn-secondary">Cancel</a>
        </div>
      </form>
    </div>
  </main>
  <script>
    function onTypeChange() {
      const t = document.getElementById('campaign_type').value
      document.getElementById('section-target').style.display = t === 'bogo' ? 'none' : ''
      document.getElementById('section-bogo').style.display   = t === 'bogo' ? '' : 'none'
    }

    async function submitForm(e) {
      e.preventDefault()
      const form = e.target
      const fd   = new FormData(form)
      const data = Object.fromEntries(fd)

      data.start_at = new Date(data.start_at_local).getTime()
      data.end_at   = new Date(data.end_at_local).getTime()
      data.discount_value        = Number(data.discount_value)
      data.min_order_cents       = Number(data.min_order_cents)
      data.max_uses_per_customer = Number(data.max_uses_per_customer)
      if (data.expected_impressions) data.expected_impressions = Number(data.expected_impressions)
      if (data.drop_cost_cents)      data.drop_cost_cents      = Number(data.drop_cost_cents)
      if (!data.fulfillment_restriction) delete data.fulfillment_restriction
      if (!data.expected_impressions)    delete data.expected_impressions
      if (!data.drop_cost_cents)         delete data.drop_cost_cents
      delete data.start_at_local; delete data.end_at_local

      // ── Build schedule_json ──────────────────────────────────────────────
      const days = [0,1,2,3,4,5,6].filter(i => fd.get('sched_day_' + i))
      const schedStart = data.sched_start
      const schedEnd   = data.sched_end
      if (days.length > 0 || (schedStart && schedEnd)) {
        const sched = {}
        if (days.length > 0) sched.days = days
        if (schedStart && schedEnd) sched.windows = [{ start: schedStart, end: schedEnd }]
        data.schedule_json = JSON.stringify(sched)
      } else {
        data.schedule_json = null
      }
      for (let i = 0; i <= 6; i++) delete data['sched_day_' + i]
      delete data.sched_start; delete data.sched_end

      // ── Build target_json / trigger_json / reward_json ───────────────────
      const campaignType = data.campaign_type
      if (campaignType === 'bogo') {
        delete data.target_json
        const tType = data.trigger_type
        const tName = data.trigger_name?.trim()
        const tQty  = Number(data.trigger_quantity) || 1
        if (tName) {
          const triggerKey = tType === 'category_quantity' ? 'category' : 'item_name'
          data.trigger_json = JSON.stringify({ type: tType, [triggerKey]: tName, quantity: tQty })
        } else {
          data.trigger_json = null
        }
        const rType = data.reward_type
        const rItem = data.reward_item_name?.trim()
        const rMaxQ = Number(data.reward_max_quantity) || 1
        const rOver = data.reward_discount_override?.trim()
        if (rItem) {
          const reward = { type: rType, item_name: rItem, max_quantity: rMaxQ }
          if (rType === 'item_discount' && rOver) {
            reward.discount_type  = data.discount_type   // reuse the form's discount_type
            reward.discount_value = Number(rOver)
          }
          data.reward_json = JSON.stringify(reward)
        } else {
          data.reward_json = null
        }
      } else {
        const targetItem = data.target_item_name?.trim()
        data.target_json  = targetItem ? JSON.stringify({ type: 'item', item_name: targetItem }) : null
        data.trigger_json = null
        data.reward_json  = null
      }
      delete data.target_item_name; delete data.trigger_type; delete data.trigger_name
      delete data.trigger_quantity; delete data.reward_type;  delete data.reward_item_name
      delete data.reward_max_quantity; delete data.reward_discount_override

      const method = ${existing ? `'PATCH'` : `'POST'`}
      const url    = ${existing ? `'/marketing/campaigns/${existing?.id}'` : `'/marketing/campaigns'`}
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      })
      if (res.ok) { window.location.href = '/marketing' }
      else { const j = await res.json(); alert(j.error || 'Save failed') }
    }
  </script>
</body>
</html>`
}

function campaignDetailHtml(
  campaign: CampaignRow,
  recentScans: Array<{ ts: number; outcome: string; country: string | null; user_agent: string | null }>,
  stats7d: { total: number; redirected: number } | null,
  qrDataUrl: string
): string {
  const fmtDate = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
  const scanRows = recentScans.map(s => `
    <tr>
      <td>${fmtDate(s.ts)}</td>
      <td>${esc(s.outcome)}</td>
      <td>${s.country ? esc(s.country) : '—'}</td>
      <td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.user_agent ? esc(s.user_agent) : '—'}</td>
    </tr>`).join('')

  const qrUrl = `https://qr.kizo.example/c/${campaign.slug}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(campaign.name)} — Marketing Engine</title>
  ${adminStyles()}
</head>
<body>
  ${adminNav('campaigns')}
  <main class="main">
    <div class="page-header">
      <h1>${esc(campaign.name)}</h1>
      <div style="display:flex;gap:8px">
        <a href="/marketing/campaigns/${campaign.id}/edit" class="btn btn-secondary">Edit</a>
        ${campaign.status === 'active' ? `<form method="POST" action="/marketing/campaigns/${campaign.id}/pause" style="margin:0"><button class="btn btn-secondary">Pause</button></form>` : ''}
        ${campaign.status === 'paused' ? `<form method="POST" action="/marketing/campaigns/${campaign.id}/resume" style="margin:0"><button class="btn">Resume</button></form>` : ''}
        ${campaign.status !== 'ended' ? `<form method="POST" action="/marketing/campaigns/${campaign.id}/end" style="margin:0"><button class="btn btn-danger">End campaign</button></form>` : ''}
        <a href="/marketing/campaigns/${campaign.id}/qr.png?size=512" download="qr-${esc(campaign.slug)}.png" class="btn btn-secondary">Download QR</a>
        <a href="/marketing/campaigns/${campaign.id}/scans.csv" class="btn btn-secondary">Export CSV</a>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 280px;gap:20px">
      <div>
        <div class="card" style="padding:24px;margin-bottom:20px">
          <p style="font-size:13px;color:#666">Slug: <code>${esc(campaign.slug)}</code> · Channel: ${esc(campaign.channel)} · Status: <strong>${esc(campaign.status)}</strong></p>
          <p style="font-size:13px;color:#666;margin-top:6px">
            Window: ${fmtDate(campaign.start_at)} → ${fmtDate(campaign.end_at)} (PT)
          </p>
          <p style="font-size:13px;color:#666;margin-top:6px">
            Offer: ${campaign.discount_type === 'percent' ? `${campaign.discount_value}% off` : `$${(campaign.discount_value/100).toFixed(2)} off`}
            ${campaign.fulfillment_restriction ? `· ${campaign.fulfillment_restriction} only` : ''}
            ${campaign.min_order_cents ? `· min $${(campaign.min_order_cents/100).toFixed(2)}` : ''}
            · max ${campaign.max_uses_per_customer}x per customer
          </p>
          <p style="font-size:13px;color:#666;margin-top:6px">7d: ${stats7d?.total ?? 0} scans, ${stats7d?.redirected ?? 0} redirected</p>
        </div>

        <div class="card">
          <table class="table">
            <thead>
              <tr><th>Time (PT)</th><th>Outcome</th><th>Country</th><th>User-Agent</th></tr>
            </thead>
            <tbody>${scanRows || '<tr><td colspan="4" style="text-align:center;color:#888;padding:24px">No scans yet</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      <div>
        <div class="card" style="padding:20px;text-align:center">
          <p style="font-size:13px;font-weight:600;margin-bottom:12px">QR Code</p>
          <img src="${qrDataUrl}" alt="QR" style="width:200px;height:200px;display:block;margin:0 auto 12px">
          <p style="font-size:11px;color:#666;word-break:break-all">${esc(qrUrl)}</p>
          <a href="/marketing/campaigns/${campaign.id}/qr.png?size=512" download class="btn" style="margin-top:12px;display:inline-block">Download PNG</a>
          <a href="/marketing/campaigns/${campaign.id}/print.pdf" download class="btn btn-secondary" style="margin-top:8px;display:inline-block">Print PDF (A6)</a>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Deploy — git pull + systemctl restart marketing-engine
// ---------------------------------------------------------------------------

marketing.post('/marketing/deploy', (c) => {
  const home = process.env.HOME ?? '/home/kizo'
  const deployLog = `${home}/deploy-marketing.log`
  const cmd = `cd ${home}/kizo-food && git pull origin main >> ${deployLog} 2>&1 && sudo systemctl restart marketing-engine >> ${deployLog} 2>&1`
  try {
    const proc = Bun.spawn(['bash', '-c', cmd], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PATH: `${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin` },
    })
    proc.unref()
    return c.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ success: false, error: msg }, 500)
  }
})

export { marketing }
