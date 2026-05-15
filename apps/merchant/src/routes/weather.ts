/**
 * weather.ts — NWS weather forecast proxy with 1-hour cache.
 *
 * GET /api/merchants/:id/weather
 *
 * Proxies api.weather.gov so the required User-Agent header is set server-side
 * and responses are cached to avoid hammering the NWS API on every tab open.
 * Grid coordinates are for Kirkland, WA (NWS office SEW, grid 129,71).
 */

import { Hono } from 'hono'
import { authenticate, requireOwnMerchant } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'

const router = new Hono<{ Variables: AuthContext }>()

const NWS_FORECAST_URL = 'https://api.weather.gov/gridpoints/SEW/129,71/forecast'
const NWS_USER_AGENT   = 'Kizo/1.0 (jj@cognitivefab.com)'
const CACHE_TTL_MS     = 60 * 60 * 1000  // 1 hour

let _cache: { periods: unknown[]; updated: string } | null = null
let _cacheExpiry = 0

router.get('/api/merchants/:id/weather', authenticate, requireOwnMerchant, async (c) => {
  const now = Date.now()
  if (_cache && now < _cacheExpiry) {
    return c.json(_cache)
  }

  let res: Response
  try {
    res = await fetch(NWS_FORECAST_URL, {
      headers: { 'User-Agent': NWS_USER_AGENT, 'Accept': 'application/geo+json' },
    })
  } catch (err) {
    return c.json({ error: 'Failed to reach NWS API', detail: String(err) }, 502)
  }

  if (!res.ok) {
    return c.json({ error: `NWS returned ${res.status}` }, 502)
  }

  const data = await res.json() as { properties?: { periods?: unknown[] } }
  const periods = (data.properties?.periods ?? []).slice(0, 14)

  _cache = { periods, updated: new Date().toISOString() }
  _cacheExpiry = now + CACHE_TTL_MS

  return c.json(_cache)
})

export { router as weather }
