/**
 * Campaign routes
 *
 * GET  /api/campaigns              — public; all active auto-apply campaigns for PWA
 * GET  /api/campaigns/:slug        — public; validates campaign for PWA
 * POST /internal/campaigns/sync   — internal; syncs campaigns from marketing-engine
 * POST /internal/campaigns/alert  — internal; email alert forwarding from marketing-engine
 */

import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { serverError } from '../utils/server-error'
import { sendEmail } from '../services/email'

const campaigns = new Hono()

// ---------------------------------------------------------------------------
// Campaign-preview rate limiter — per-IP, 1 request per second
//
// Prevents already_redeemed enumeration (attacker hashing guessed phone numbers
// and probing for hits).  Mirrors the parse-instruction limiter pattern.
// In-memory only: single Bun process, no Redis needed at this scale.
// ---------------------------------------------------------------------------
interface PreviewRateRecord { count: number; resetAt: number }
const _previewRateLimits = new Map<string, PreviewRateRecord>()
const PREVIEW_RATE_MAX = 1
const PREVIEW_RATE_WINDOW_MS = 1 * 1000

function _checkPreviewRateLimit(ip: string): boolean {
  const now = Date.now()
  const rec = _previewRateLimits.get(ip)
  if (rec && rec.resetAt > now) {
    if (rec.count >= PREVIEW_RATE_MAX) return false
    rec.count++
  } else {
    _previewRateLimits.set(ip, { count: 1, resetAt: now + PREVIEW_RATE_WINDOW_MS })
  }
  return true
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type CampaignRow = {
  id: number; slug: string; name: string; status: string; start_at: number; end_at: number
  discount_type: string; discount_value: number; min_order_cents: number
  max_uses_per_customer: number; max_uses_global: number | null; fulfillment_restriction: string | null
  schedule_json: string | null; campaign_type: string
  target_json: string | null; trigger_json: string | null; reward_json: string | null
}

function buildDiscountLabel(row: CampaignRow): string {
  const campaignType = row.campaign_type ?? 'coupon'
  if (campaignType === 'bogo' && row.trigger_json && row.reward_json) {
    try {
      const trigger = JSON.parse(row.trigger_json)
      const reward  = JSON.parse(row.reward_json)
      const tQty    = trigger.quantity ?? 1
      const tName   = trigger.item_name ?? trigger.category ?? 'items'
      const rName   = reward.item_name ?? 'item'
      if (reward.type === 'free_item') {
        return `Order ${tQty}+ ${tName} — free ${rName}`
      }
      const rDisc = reward.discount_type === 'percent'
        ? `${reward.discount_value}% off`
        : `$${(reward.discount_value / 100).toFixed(2)} off`
      return `Order ${tQty}+ ${tName} — ${rDisc} ${rName}`
    } catch {
      return row.name
    }
  }
  if (row.target_json) {
    try {
      const target = JSON.parse(row.target_json)
      const amt = row.discount_type === 'percent'
        ? `${row.discount_value}%`
        : `$${(row.discount_value / 100).toFixed(2)}`
      return `${amt} off ${target.item_name ?? 'selected item'}`
    } catch { /* fall through */ }
  }
  return row.discount_type === 'percent'
    ? `${row.discount_value}% off your order`
    : `$${(row.discount_value / 100).toFixed(2)} off your order`
}

function buildCampaignPayload(row: CampaignRow) {
  const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : null } catch { return null } }
  return {
    slug:          row.slug,
    name:          row.name,
    status:        row.status,
    start_at:      row.start_at,
    valid_until:   row.end_at,
    campaign_type: row.campaign_type ?? 'coupon',
    schedule:      safeJson(row.schedule_json),
    target:        safeJson(row.target_json),
    trigger:       safeJson(row.trigger_json),
    reward:        safeJson(row.reward_json),
    offer: {
      type:                    row.discount_type,
      value:                   row.discount_value,
      label:                   buildDiscountLabel(row),
      min_order_cents:         row.min_order_cents,
      max_uses_per_customer:   row.max_uses_per_customer,
      max_uses_global:         row.max_uses_global,
      fulfillment_restriction: row.fulfillment_restriction,
    },
  }
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/:slug — public, called by PWA on load
// ---------------------------------------------------------------------------
campaigns.get('/api/campaigns/:slug', (c) => {
  const slug = c.req.param('slug')!.toUpperCase()
  const db   = getDatabase()
  const now  = Date.now()

  const row = db.query<CampaignRow, [string]>(
    `SELECT id, slug, name, status, start_at, end_at,
            discount_type, discount_value, min_order_cents,
            max_uses_per_customer, max_uses_global, fulfillment_restriction,
            schedule_json, campaign_type, target_json, trigger_json, reward_json
     FROM campaigns WHERE slug = ?`
  ).get(slug)

  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.status !== 'active') return c.json({ error: 'inactive' }, 422)
  if (now < row.start_at)     return c.json({ error: 'not_started' }, 422)
  if (now > row.end_at)       return c.json({ error: 'ended' }, 422)

  return c.json(buildCampaignPayload(row))
})

// ---------------------------------------------------------------------------
// GET /api/campaigns — public; returns active ambient (auto-apply) campaigns for PWA
// Only campaigns with channel='ambient' are returned — QR-distributed campaigns
// (valpak, tabletent, receipt, yelp, etc.) must be loaded via ?c=SLUG and are
// per-customer only.  Omitting this filter was the bug: every QR campaign was
// returned to every user who loaded the store.
// ---------------------------------------------------------------------------
campaigns.get('/api/campaigns', (c) => {
  const db  = getDatabase()
  const now = Date.now()

  const rows = db.query<CampaignRow, [number, number]>(
    `SELECT id, slug, name, status, start_at, end_at,
            discount_type, discount_value, min_order_cents,
            max_uses_per_customer, max_uses_global, fulfillment_restriction,
            schedule_json, campaign_type, target_json, trigger_json, reward_json
     FROM campaigns
     WHERE status = 'active' AND coupon_code_required = 0 AND channel = 'ambient'
           AND start_at <= ? AND end_at >= ?
     ORDER BY start_at ASC`
  ).all(now, now)

  return c.json({ campaigns: rows.map(buildCampaignPayload) })
})

// ---------------------------------------------------------------------------
// POST /api/store/campaign-preview
// Public — always returns campaign data so the modal can be shown for pending
// campaigns. Returns 404 if slug unknown, 410 if campaign has ended.
// Hashes sent in POST body (not GET params) to keep them out of access logs.
// ---------------------------------------------------------------------------
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

campaigns.post('/api/store/campaign-preview', async (c) => {
  const ip = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
  if (!_checkPreviewRateLimit(ip)) return c.json({ error: 'rate_limited' }, 429)

  // Names are NOT hashed for redemption tracking — many customers share
  // first names / nicknames, so a name hash creates false-positive blocks.
  // Phone + email are the only identifiers used.
  let body: { slug?: string; phoneHash?: string; emailHash?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }

  const slug      = (body.slug ?? '').toUpperCase()
  const phoneHash = (typeof body.phoneHash === 'string' && SHA256_HEX_RE.test(body.phoneHash)) ? body.phoneHash : null
  const emailHash = (typeof body.emailHash === 'string' && SHA256_HEX_RE.test(body.emailHash)) ? body.emailHash : null

  if (!slug) return c.json({ error: 'slug_required' }, 400)

  const db  = getDatabase()
  const now = Date.now()

  const row = db.query<CampaignRow, [string]>(
    `SELECT id, slug, name, status, start_at, end_at,
            discount_type, discount_value, min_order_cents,
            max_uses_per_customer, max_uses_global, fulfillment_restriction,
            schedule_json, campaign_type, target_json, trigger_json, reward_json
     FROM campaigns WHERE slug = ?`
  ).get(slug)

  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.status !== 'active') return c.json({ error: 'inactive' }, 422)
  if (now > row.end_at) return c.json({ error: 'ended' }, 410)

  // Determine computed status for the frontend
  const computedStatus = now < row.start_at ? 'pending' : 'active'

  // Check if this customer has already redeemed (hash-based, privacy-preserving)
  let alreadyRedeemed = false
  const hashes = [
    phoneHash ? { hash: phoneHash, type: 'phone' } : null,
    emailHash ? { hash: emailHash, type: 'email' }  : null,
  ].filter(Boolean) as Array<{ hash: string; type: string }>

  for (const { hash } of hashes) {
    const redemptionRow = db.query<{ id: string }, [number, string]>(
      `SELECT id FROM coupon_hash_redemptions WHERE campaign_id = ? AND identifier_hash = ? LIMIT 1`
    ).get(row.id, hash)
    if (redemptionRow) { alreadyRedeemed = true; break }
  }

  return c.json({
    ...buildCampaignPayload(row),
    computed_status: computedStatus,
    already_redeemed: alreadyRedeemed,
  })
})

// ---------------------------------------------------------------------------
// POST /api/store/campaign-instance
// Creates a per-scan coupon instance (unique scan_token) so QR-distributed
// campaigns cannot be shared: each device that scans gets its own token and
// must present it when submitting an order.
// Rate-limited same as campaign-preview (1 req/s per IP).
// ---------------------------------------------------------------------------
campaigns.post('/api/store/campaign-instance', async (c) => {
  const ip = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
  if (!_checkPreviewRateLimit(ip)) return c.json({ error: 'rate_limited' }, 429)

  // Names are NOT hashed for redemption tracking — many customers share
  // first names / nicknames, so a name hash creates false-positive blocks.
  // Phone + email are the only identifiers used.
  let body: { slug?: string; phoneHash?: string; emailHash?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }

  const slug      = (body.slug ?? '').toUpperCase()
  const phoneHash = (typeof body.phoneHash === 'string' && SHA256_HEX_RE.test(body.phoneHash)) ? body.phoneHash : null
  const emailHash = (typeof body.emailHash === 'string' && SHA256_HEX_RE.test(body.emailHash)) ? body.emailHash : null

  if (!slug) return c.json({ error: 'slug_required' }, 400)

  const db  = getDatabase()
  const now = Date.now()

  const row = db.query<CampaignRow, [string]>(
    `SELECT id, slug, name, status, start_at, end_at,
            discount_type, discount_value, min_order_cents,
            max_uses_per_customer, max_uses_global, fulfillment_restriction,
            schedule_json, campaign_type, target_json, trigger_json, reward_json
     FROM campaigns WHERE slug = ?`
  ).get(slug)

  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.status !== 'active') return c.json({ error: 'inactive' }, 422)
  if (now > row.end_at) return c.json({ error: 'ended' }, 410)

  const computedStatus = now < row.start_at ? 'pending' : 'active'

  // Hash-based duplicate redemption check (privacy-preserving)
  let alreadyRedeemed = false
  const hashes = [
    phoneHash ? { hash: phoneHash, type: 'phone' } : null,
    emailHash ? { hash: emailHash, type: 'email' }  : null,
  ].filter(Boolean) as Array<{ hash: string; type: string }>

  for (const { hash } of hashes) {
    const redemptionRow = db.query<{ id: string }, [number, string]>(
      `SELECT id FROM coupon_hash_redemptions WHERE campaign_id = ? AND identifier_hash = ? LIMIT 1`
    ).get(row.id, hash)
    if (redemptionRow) { alreadyRedeemed = true; break }
  }

  // Create a fresh scan instance; always created even if already_redeemed so the
  // caller can show the "already used" UI with a valid token context.
  const scanToken = randomBytes(16).toString('hex')
  const expiresAt = new Date()
  expiresAt.setMonth(expiresAt.getMonth() + 6)

  db.run(
    `INSERT INTO coupon_instances (campaign_id, scan_token, expires_at) VALUES (?, ?, ?)`,
    [row.id, scanToken, expiresAt.toISOString()]
  )

  // Lazy-delete expired instances (keep table tidy at zero extra cost)
  db.run(`DELETE FROM coupon_instances WHERE expires_at < datetime('now')`)

  return c.json({
    ...buildCampaignPayload(row),
    computed_status:  computedStatus,
    already_redeemed: alreadyRedeemed,
    scanToken,
  })
})

// ---------------------------------------------------------------------------
// POST /internal/campaigns/sync
// Receives campaign rows from marketing-engine's kizo-sync.ts job.
// Authenticated by shared X-Sync-Token header (env var CAMPAIGN_SYNC_TOKEN).
// ---------------------------------------------------------------------------
campaigns.post('/internal/campaigns/sync', async (c) => {
  const token = c.req.header('x-sync-token') ?? ''
  const expected = process.env.CAMPAIGN_SYNC_TOKEN ?? ''
  if (!expected || token !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let body: { campaigns: Array<Record<string, unknown>>; synced_at: number }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const db  = getDatabase()
  const now = body.synced_at ?? Date.now()
  let upserted = 0

  for (const row of body.campaigns) {
    try {
      db.run(
        `INSERT INTO campaigns (id, slug, name, channel, mode, coupon_code_required,
           status, start_at, end_at, schedule_json, campaign_type,
           discount_type, discount_value, min_order_cents,
           fulfillment_restriction, max_uses_per_customer, max_uses_global,
           target_json, trigger_json, reward_json, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, name=excluded.name, channel=excluded.channel,
           mode=excluded.mode, coupon_code_required=excluded.coupon_code_required,
           status=excluded.status, start_at=excluded.start_at, end_at=excluded.end_at,
           schedule_json=excluded.schedule_json, campaign_type=excluded.campaign_type,
           discount_type=excluded.discount_type, discount_value=excluded.discount_value,
           min_order_cents=excluded.min_order_cents,
           fulfillment_restriction=excluded.fulfillment_restriction,
           max_uses_per_customer=excluded.max_uses_per_customer,
           max_uses_global=excluded.max_uses_global,
           target_json=excluded.target_json, trigger_json=excluded.trigger_json,
           reward_json=excluded.reward_json,
           synced_at=excluded.synced_at`,
        [
          Number(row.id), String(row.slug), String(row.name), String(row.channel),
          String(row.mode ?? 'single'), Number(row.coupon_code_required ?? 0),
          String(row.status), Number(row.start_at), Number(row.end_at),
          row.schedule_json ? String(row.schedule_json) : null,
          String(row.campaign_type ?? 'coupon'),
          String(row.discount_type), Number(row.discount_value),
          Number(row.min_order_cents ?? 0),
          row.fulfillment_restriction ? String(row.fulfillment_restriction) : null,
          Number(row.max_uses_per_customer ?? 1),
          row.max_uses_global != null ? Number(row.max_uses_global) : null,
          row.target_json  ? String(row.target_json)  : null,
          row.trigger_json ? String(row.trigger_json) : null,
          row.reward_json  ? String(row.reward_json)  : null,
          now,
        ]
      )
      upserted++
    } catch (err) {
      console.warn('[campaigns] sync upsert failed for slug', row.slug, String(err))
    }
  }

  console.log(`[campaigns] synced ${upserted}/${body.campaigns.length} campaign(s)`)
  return c.json({ upserted })
})

// ---------------------------------------------------------------------------
// POST /internal/campaigns/alert
// Email alert forwarding from marketing-engine (process restart, rate spike, etc.)
// Authenticated by shared X-Alert-Token header (env var CAMPAIGN_ALERT_TOKEN).
// ---------------------------------------------------------------------------
campaigns.post('/internal/campaigns/alert', async (c) => {
  const token = c.req.header('x-alert-token') ?? ''
  const expected = process.env.CAMPAIGN_ALERT_TOKEN ?? ''
  if (!expected || token !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let body: { subject: string; text: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  try {
    await sendEmail({
      to:      process.env.ALERT_EMAIL ?? 'operator@example.com',
      subject: `[Marketing Engine] ${body.subject}`,
      text:    body.text,
    })
    return c.json({ sent: true })
  } catch (err) {
    return serverError(c, '[campaigns] alert email', err)
  }
})

export { campaigns }
