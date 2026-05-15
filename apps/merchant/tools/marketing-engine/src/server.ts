/**
 * Marketing Engine — Hono server on port 3100.
 *
 * Routes:
 *   GET /c/:slug              — QR redirect (slug-only campaign)
 *   GET /c/:slug/:code        — QR redirect (per-coupon campaign)
 *   GET /health               — uptime probe
 *   GET /robots.txt           — disallow all
 *   /marketing/*              — admin UI (session-authenticated)
 */

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { config } from './config'
import { migrate } from './db/migrate'
import { closeDatabase } from './db/connection'
import { redirect } from './routes/redirect'
import { marketing } from './routes/marketing'
import { health } from './routes/health'
import { landing } from './routes/landing'
import { internal } from './routes/internal'
import { startCampaignSync } from './sync/kizo-sync'
import { marketingIpGuard } from './middleware/ip-allowlist'

const app = new Hono()

app.use('/*', logger())

// Security: HSTS in production
app.use('/*', async (c, next) => {
  await next()
  if (config.nodeEnv === 'production') {
    c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
})

app.route('/', health)
app.route('/', landing)
app.route('/', redirect)
app.route('/', internal)
app.use('/marketing/*', marketingIpGuard)
app.route('/', marketing)

// 404 fallback
app.notFound((c) => c.json({ error: 'not_found' }, 404))

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
migrate()
startCampaignSync()
console.log(`Marketing engine listening on ${config.hostname}:${config.port}`)

const server = Bun.serve({
  port:     config.port,
  hostname: config.hostname,
  fetch:    app.fetch,
  error:    (err) => new Response(String(err), { status: 500 }),
})

// Graceful shutdown
const shutdown = () => {
  console.log('Shutting down...')
  server.stop()
  closeDatabase()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
