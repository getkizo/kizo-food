/**
 * Outbound sync: push campaign updates to Kizo for order attribution.
 * Runs every 60 seconds. If Kizo is down, retries silently — the
 * redirector continues to work regardless.
 */

import { getDatabase } from '../db/connection'
import { config } from '../config'

let _lastSyncAt = 0

type CampaignSyncRow = {
  id: number; slug: string; name: string; channel: string; mode: string
  coupon_code_required: number; status: string; start_at: number; end_at: number
  schedule_json: string | null; campaign_type: string
  discount_type: string; discount_value: number; min_order_cents: number
  fulfillment_restriction: string | null; max_uses_per_customer: number
  target_json: string | null; trigger_json: string | null; reward_json: string | null
  updated_at: number
}

async function syncCampaigns(): Promise<void> {
  if (!config.baabanSyncToken) return  // sync disabled if no token configured

  const db      = getDatabase()
  const since   = _lastSyncAt
  const now     = Date.now()

  const rows = db.query<CampaignSyncRow, [number]>(
    `SELECT id, slug, name, channel, mode, coupon_code_required, status,
            start_at, end_at, schedule_json, campaign_type,
            discount_type, discount_value, min_order_cents,
            fulfillment_restriction, max_uses_per_customer,
            target_json, trigger_json, reward_json, updated_at
     FROM campaigns WHERE updated_at > ?`
  ).all(since)

  if (rows.length === 0) return

  try {
    const res = await fetch(config.baabanSyncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Token': config.baabanSyncToken,
      },
      body: JSON.stringify({ campaigns: rows, synced_at: now }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      _lastSyncAt = now
      console.log(`[sync] pushed ${rows.length} campaign(s) to Kizo`)
    } else {
      console.warn(`[sync] Kizo returned ${res.status}`)
    }
  } catch (err) {
    console.warn('[sync] Kizo unreachable:', String(err))
  }
}

export function startCampaignSync(): void {
  // Run immediately on startup, then every 60s
  syncCampaigns().catch(() => {})
  setInterval(() => { syncCampaigns().catch(() => {}) }, 60_000)
}
