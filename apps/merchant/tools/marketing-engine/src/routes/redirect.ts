/**
 * Public redirect endpoints.
 *
 * GET /c/:slug              — campaign-level QR scan
 * GET /c/:slug/:code        — per-coupon unique code scan
 *
 * Steps per spec §6.1.1:
 *   1. Normalize slug/code
 *   2. Rate-limit check
 *   3. Campaign lookup
 *   4. Coupon code validation (if coupon_code_required)
 *   5. Insert scan row
 *   6. 302 redirect with correct params
 */

import { Hono } from 'hono'
import { ulid } from 'ulid'
import { getDatabase } from '../db/connection'
import { hashIp } from '../services/ip-hash'
import { checkAndIncrement } from '../services/rate-limiter'
import { normalizeSlug } from '../utils/slug'
import { config } from '../config'

const redirect = new Hono()

type CampaignRow = {
  id: number
  slug: string
  source_label: string
  mode: string
  coupon_code_required: number
  status: string
  start_at: number
  end_at: number
  redirect_target: string
  fallback_url: string | null
  discount_type: string
  discount_value: number
  min_order_cents: number
  fulfillment_restriction: string | null
  max_uses_per_customer: number
}

type CouponRow = {
  id: number
  status: string
}

async function handleScan(
  c: Parameters<Parameters<typeof Hono.prototype.get>[1]>[0],
  rawSlug: string,
  rawCode: string | undefined
): Promise<Response> {
  const db  = getDatabase()
  const now = Date.now()

  const ip      = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
  const ipHash  = await hashIp(ip)
  const scanId  = ulid()

  // 1. Normalize
  const slugNorm = normalizeSlug(rawSlug)
  const codeNorm = rawCode ? normalizeSlug(rawCode) : undefined

  // 2. Rate limit
  const rateResult = checkAndIncrement(ipHash)
  if (!rateResult.allowed) {
    db.run(
      `INSERT INTO scans (id, slug_requested, code_requested, ip_hash, user_agent, referer, country, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'rate_limited')`,
      [scanId, rawSlug, rawCode ?? null, ipHash,
       c.req.header('user-agent') ?? null,
       c.req.header('referer') ?? null,
       c.req.header('cf-ipcountry') ?? null]
    )
    return c.text('Too Many Requests', 429)
  }

  // 3. Campaign lookup
  const campaign = db.query<CampaignRow, [string]>(
    `SELECT id, slug, source_label, mode, coupon_code_required, status,
            start_at, end_at, redirect_target, fallback_url,
            discount_type, discount_value, min_order_cents,
            fulfillment_restriction, max_uses_per_customer
     FROM campaigns WHERE slug_normalized = ?`
  ).get(slugNorm)

  if (!campaign) {
    db.run(
      `INSERT INTO scans (id, campaign_id, slug_requested, code_requested, ip_hash, user_agent, referer, country, outcome)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'invalid_slug')`,
      [scanId, rawSlug, rawCode ?? null, ipHash,
       c.req.header('user-agent') ?? null,
       c.req.header('referer') ?? null,
       c.req.header('cf-ipcountry') ?? null]
    )
    const fallback = config.defaultRedirect + '?src=unknown_campaign'
    return Response.redirect(fallback, 302)
  }

  // 4. Coupon code validation
  let couponCodeId: number | null = null
  if (campaign.coupon_code_required) {
    if (!codeNorm) {
      db.run(
        `INSERT INTO scans (id, campaign_id, slug_requested, ip_hash, user_agent, referer, country, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'invalid_code')`,
        [scanId, campaign.id, rawSlug, ipHash,
         c.req.header('user-agent') ?? null,
         c.req.header('referer') ?? null,
         c.req.header('cf-ipcountry') ?? null]
      )
      const fb = campaign.fallback_url ?? config.defaultRedirect
      return Response.redirect(fb, 302)
    }

    const coupon = db.query<CouponRow, [number, string]>(
      `SELECT id, status FROM coupon_codes WHERE campaign_id = ? AND code_normalized = ?`
    ).get(campaign.id, codeNorm)

    if (!coupon) {
      db.run(
        `INSERT INTO scans (id, campaign_id, slug_requested, code_requested, ip_hash, user_agent, referer, country, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invalid_code')`,
        [scanId, campaign.id, rawSlug, rawCode ?? null, ipHash,
         c.req.header('user-agent') ?? null,
         c.req.header('referer') ?? null,
         c.req.header('cf-ipcountry') ?? null]
      )
      const fb = campaign.fallback_url ?? config.defaultRedirect
      return Response.redirect(fb, 302)
    }

    if (campaign.mode === 'single' && coupon.status === 'redeemed') {
      db.run(
        `INSERT INTO scans (id, campaign_id, coupon_code_id, slug_requested, code_requested, ip_hash, user_agent, referer, country, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'code_already_redeemed')`,
        [scanId, campaign.id, coupon.id, rawSlug, rawCode ?? null, ipHash,
         c.req.header('user-agent') ?? null,
         c.req.header('referer') ?? null,
         c.req.header('cf-ipcountry') ?? null]
      )
      const fb = (campaign.fallback_url ?? config.defaultRedirect) + '?reason=already_redeemed'
      return Response.redirect(fb, 302)
    }

    couponCodeId = coupon.id
    // Mark as scanned
    db.run(
      `UPDATE coupon_codes SET status='scanned', first_scan_at=COALESCE(first_scan_at,?) WHERE id=?`,
      [now, coupon.id]
    )
  }

  // 5. Determine outcome
  const isActive = campaign.status === 'active' && now >= campaign.start_at && now <= campaign.end_at
  const outcome  = isActive ? 'redirected' : 'fallback'

  db.run(
    `INSERT INTO scans (id, campaign_id, coupon_code_id, slug_requested, code_requested, ip_hash, user_agent, referer, country, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [scanId, campaign.id, couponCodeId, rawSlug, rawCode ?? null, ipHash,
     c.req.header('user-agent') ?? null,
     c.req.header('referer') ?? null,
     c.req.header('cf-ipcountry') ?? null,
     outcome]
  )

  // 6. Redirect
  let target: string
  if (isActive) {
    const params = new URLSearchParams({
      c:   campaign.slug,
      src: campaign.source_label,
      t:   scanId,
    })
    if (rawCode) params.set('code', rawCode)
    target = `${campaign.redirect_target}?${params.toString()}`
  } else {
    target = campaign.fallback_url ?? config.defaultRedirect
  }

  const res = new Response(null, { status: 302, headers: { Location: target } })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

redirect.get('/c/:slug', async (c) => {
  return handleScan(c, c.req.param('slug'), undefined)
})

redirect.get('/c/:slug/:code', async (c) => {
  return handleScan(c, c.req.param('slug'), c.req.param('code'))
})

export { redirect }
