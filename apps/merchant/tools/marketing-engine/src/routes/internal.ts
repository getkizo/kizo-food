/**
 * Internal API — called by the Kizo main server (not customer-facing).
 *
 * POST /internal/coupon/redeem
 *   Atomically validates and marks a per-coupon code as redeemed.
 *   Auth: X-Sync-Token header matching KIZO_SYNC_TOKEN env var.
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'

const internal = new Hono()

internal.post('/internal/coupon/redeem', async (c) => {
  const token    = c.req.header('x-sync-token') ?? ''
  const expected = process.env.KIZO_SYNC_TOKEN ?? ''
  if (!expected || token !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let body: { campaign_id: number; code: string; order_id: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }

  const codeNorm = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!codeNorm || !body.campaign_id || !body.order_id) {
    return c.json({ error: 'missing_fields' }, 400)
  }

  const db = getDatabase()

  const existing = db.query<{ status: string }, [number, string]>(
    `SELECT status FROM coupon_codes WHERE campaign_id = ? AND code_normalized = ?`
  ).get(Number(body.campaign_id), codeNorm)

  if (!existing)                       return c.json({ error: 'invalid_code' }, 422)
  if (existing.status === 'redeemed') return c.json({ error: 'already_redeemed' }, 422)
  if (existing.status === 'void')     return c.json({ error: 'void' }, 422)

  // Atomic UPDATE — only succeeds while status is still unused/scanned
  const result = db.run(
    `UPDATE coupon_codes
     SET status = 'redeemed',
         redeemed_at       = unixepoch() * 1000,
         redeemed_order_id = ?
     WHERE campaign_id = ? AND code_normalized = ? AND status IN ('unused', 'scanned')`,
    [String(body.order_id), Number(body.campaign_id), codeNorm]
  )

  if (result.changes === 0) {
    // Race: redeemed between the SELECT and UPDATE
    return c.json({ error: 'already_redeemed' }, 422)
  }

  return c.json({ ok: true })
})

export { internal }
