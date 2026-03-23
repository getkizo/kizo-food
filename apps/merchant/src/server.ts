/**
 * Merchant Appliance Server
 * Bun + Hono + SQLite + SAM Pattern
 *
 * Single-process, single-merchant appliance — the entire hostname belongs to
 * one restaurant.  No subdomain dispatch; store and dashboard coexist at `/`
 * and `/merchant` on the same origin.
 *
 * ── Request flow ──────────────────────────────────────────────────────────────
 *   Browser / Counter app
 *     → Cloudflare Tunnel (TLS termination)
 *       → Hono middleware stack (CORS, security headers, IP allowlist, request ctx)
 *         → Route handler (auth.ts, store.ts, dashboard-payments.ts, …)
 *           → SQLite (bun:sqlite, WAL mode) / Finix / Converge adapters
 *             → SSE broadcast or printer TCP write
 *
 * ── URL origins ───────────────────────────────────────────────────────────────
 *   /                     Customer-facing PWA store (store/index.html)
 *   /merchant             Staff dashboard (dashboard.html) — IP-restricted
 *   /setup                First-run onboarding (index.html)
 *   /pay-return           Converge payment return (store shell, SAM intercepts)
 *   /gift-cards           Gift card purchase store
 *   /reserve              Reservation widget (embeddable iframe)
 *   /fog-report           Public F.O.G. compliance HTML report
 *   /api/*                REST API
 *   /counter?token=…      Kizo Counter app WebSocket upgrade
 *
 * ── Startup sequence (main()) ─────────────────────────────────────────────────
 *   1. Code integrity verification (Ed25519 — production only)
 *   2. SQLite database open + forward-only migrations
 *   3. Master key derivation (scrypt + AES-256-GCM for API key envelope encryption)
 *   4. VAPID keys loaded for Web Push
 *   5. Active SAM order workflows rehydrated from SQLite
 *   6. Background services started (see below)
 *   7. Bun.serve() on PORT (default 3000)
 *
 * ── Background services ───────────────────────────────────────────────────────
 *   startAutoClockOut()    Every 15 min — auto-clocks-out shifts past max hours
 *   startAutoFire()        Every 60 s  — fires delayed course-2 kitchen tickets
 *   startAutoResetOos()    Midnight     — resets "out_today" stock flags
 *   startAutoBackup()      02:00 daily  — S3 JSON snapshot
 *   startAutoReconcile()   Every 30 s   — re-runs Finix reconciliation for gaps
 *   Clover reconcile       120 s / 15 s adaptive — fast-polls for 2 min after order push
 *   startDailyCloseout()   Configurable — EOD sales report + morning reservation briefing
 *   startFogReminders()    Every 6 h   — alerts if grease trap / hood cleaning is overdue
 *   setInterval (6 h)      — cleans up expired refresh tokens from SQLite
 */

import { resolve, join, sep } from 'node:path'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { serveStatic } from 'hono/bun'
import { getDatabase, closeDatabase } from './db/connection'
import { migrate } from './db/migrate'
import { initializeMasterKey, isMasterKeyInitialized } from './crypto/master-key'
import { verifyCodeIntegrity, hasManifest, skipCodeVerification } from './crypto/verify-code'
import { rehydrateActiveOrders } from './workflows/order-relay'
import { rehydrateTerminalWorkflows } from './workflows/terminal-payment'
import { startAutoClockOut } from './services/auto-clockout'
import { startAutoFire } from './services/auto-fire'
import { startAutoResetOos } from './services/auto-reset-oos'
import { startAutoCancelStale } from './services/auto-cancel-stale'
import { startDailyCloseout } from './services/daily-closeout'
import { getAdapter } from './adapters/registry'
import { orders } from './routes/orders'
import { dashboardOrders } from './routes/dashboard-orders'
import { webhooks } from './routes/webhooks'
import { auth } from './routes/auth'
import { merchants } from './routes/merchants'
import { menu } from './routes/menu'
import { oauth } from './routes/oauth'
import { push, loadVapidKeys } from './routes/push'
import { webauthn } from './routes/webauthn'
import { hours } from './routes/hours'
import { employees } from './routes/employees'
import { terminals } from './routes/terminals'
import { reservations } from './routes/reservations'
import { giftCards } from './routes/gift-cards'
import { fog, startFogReminders } from './routes/fog'
import { systemHealth } from './routes/system-health'
import './utils/system-monitor'   // start background CPU/mem sampling + error capture
import { dashboardPayments } from './routes/dashboard-payments'
import { dashboardRefunds } from './routes/dashboard-refunds'
import { reports } from './routes/reports'
import { backup } from './routes/backup'
import { startAutoBackup } from './services/auto-backup'
import { startAutoReconcile } from './services/reconcile'
import { CloverOrderClient } from './services/clover-order-client'
import { lastCloverPaymentAt } from './services/clover-reconcile-signal'
import { broadcastToMerchant } from './services/sse'
import { store } from './routes/store'
import { events } from './routes/events'
import { BUILD_VERSION } from './utils/build-version'
import { counter } from './routes/counter'
import { merchantIpGuard } from './middleware/ip-allowlist'
import {
  counterWsOpen,
  counterWsMessage,
  counterWsClose,
  validateCounterToken,
} from './services/counter-ws'
import type { CounterWsData } from './services/counter-ws'

// ---------------------------------------------------------------------------
// Service Worker content — pre-processed once at startup.
// The placeholder __BUILD__ is replaced with the git hash (or startup
// timestamp) so every deployment automatically invalidates the old cache
// without requiring a manual version bump in the SW source file.
// ---------------------------------------------------------------------------

const _swMerchantContent = Bun.file('./public/sw.js').text().then((t) =>
  t.replace('merchant-__BUILD__', `merchant-${BUILD_VERSION}`)
)
const _swStoreContent = Bun.file('./public/store/sw.js').text().then((t) =>
  t.replace('store-__BUILD__', `store-${BUILD_VERSION}`)
)

// Type definitions for Hono context
type Variables = {
  merchantId?: string
  userId?: string
  ipAddress?: string
}

const app = new Hono<{ Variables: Variables }>()

/**
 * Middleware
 */

// CORS (configure for your frontend domains)
// CORS_ORIGIN supports comma-separated values: https://dev.kizo.app,http://localhost:5173
//
// Production without CORS_ORIGIN: all cross-origin requests are blocked (safe default
// for an appliance where the store and dashboard are served from the same origin as the API).
// Dev without CORS_ORIGIN: localhost dev-server origins are allowed as a convenience.
const corsOriginEnv = process.env.CORS_ORIGIN
const corsOrigins: string[] = corsOriginEnv
  ? corsOriginEnv.split(',').map(o => o.trim())
  : (process.env.NODE_ENV !== 'production'
      ? ['http://localhost:3000', 'http://localhost:5173']
      : [])

app.use('/*', cors({
  // Empty array = no cross-origin access allowed (safe in prod when CORS_ORIGIN unset)
  origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
  credentials: true,
}))

// Security headers (C-01) — defence-in-depth for the appliance origin.
// CSP is report-only initially to avoid breaking existing inline scripts.
app.use('/*', async (c, next) => {
  await next()
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  // /reserve is intentionally embeddable as an iframe on the restaurant's website.
  // In dev: allow all origins (no restriction).
  // In production: restrict to the merchant's website from store profile.
  // All other routes stay locked down with DENY.
  if (c.req.path.startsWith('/reserve')) {
    if (process.env.NODE_ENV === 'production') {
      const db = getDatabase()
      const row = db.query<{ website: string | null }, []>(
        `SELECT website FROM merchants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`
      ).get()
      const origin = row?.website ? new URL(row.website).origin : "'self'"
      c.res.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${origin}`)
    }
    // dev: no X-Frame-Options, no frame-ancestors CSP → unrestricted embedding
  } else {
    c.res.headers.set('X-Frame-Options', 'DENY')
  }
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
  if (process.env.NODE_ENV === 'production') {
    c.res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  }
  // SEC-XSS-05 / SEC-TPI-01: Enforced CSP for HTML pages.
  // Covers dashboard (/merchant), customer store (/), gift card (/gift-cards), etc.
  // API routes are excluded — JSON responses do not render HTML.
  //
  // script-src: 'unsafe-inline' has been removed. There are no inline <script>
  // blocks or event-handler attributes in any HTML file; all scripts are external
  // files served from 'self' or the pinned Finix CDN origin. Any injected
  // <script> tag from an XSS payload will be blocked by the browser.
  //
  // style-src: 'unsafe-inline' is retained because dashboard.html, reserve,
  // and several JS template strings use inline style="" attributes. Removing it
  // would require auditing and refactoring every style="" occurrence. In CSP3,
  // adding hash values alongside 'unsafe-inline' causes browsers to silently
  // ignore 'unsafe-inline', which would break the UI — so hashes are deferred
  // until inline style attributes are eliminated.
  //
  // Update the Finix CDN origin when the SDK major version changes.
  // report-uri captures violations for monitoring even in enforced mode.
  if (!c.req.path.startsWith('/api/') && !c.req.path.startsWith('/fog-report')) {
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' https://js.finix.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "connect-src 'self' https://js.finix.com https://api.finix.com; " +
      "img-src 'self' data: blob:; " +
      "frame-src 'none'; " +
      "object-src 'none'; " +
      "report-uri /api/csp-report"
    )
  }
})

// Keep-alive header — required for cloudflared compatibility.
// cloudflared pools TCP connections to the origin and reuses them across
// requests. Without an explicit Connection: keep-alive, Bun closes the
// connection after each response and cloudflared gets "unexpected EOF" on
// the next reuse attempt. SSE routes override this header themselves.
app.use('/*', async (c, next) => {
  await next()
  if (!c.res.headers.get('Content-Type')?.includes('text/event-stream')) {
    c.res.headers.set('Connection', 'keep-alive')
  }
})

// HTTP compression (Brotli + gzip) — reduces JS/CSS/JSON transfer size ~70%
app.use(compress())

// Request logging
app.use('/*', logger())

// Pretty JSON in development
if (process.env.NODE_ENV !== 'production') {
  app.use('/*', prettyJSON())
}

/**
 * Request context middleware
 *
 * Architecture: single-merchant appliance — the entire hostname belongs to
 * one merchant. No subdomain dispatch is needed; the store and dashboard
 * coexist on the same origin at / and /merchant respectively.
 *
 * The store API resolves the merchant directly from the database.
 */
app.use('/*', async (c, next) => {
  // Capture IP address for audit logging
  // Bun.serve passes the Server instance as c.env; requestIP() returns socket address.
  // BunEnv is a minimal shim — the full Bun.Server type is not available in the Hono context.
  interface BunEnv { requestIP?: (req: Request) => { address: string } | null }
  const socketIp = (c.env as BunEnv)?.requestIP?.(c.req.raw)?.address
  const ipAddress =
    c.req.header('cf-connecting-ip') || // Cloudflare Tunnel
    c.req.header('x-forwarded-for')?.split(',')[0] || // Proxy
    c.req.header('x-real-ip') || // Nginx
    socketIp ||                         // Direct connection (no proxy)
    'unknown'

  c.set('ipAddress', ipAddress)

  await next()
})

// IP allowlist — restrict merchant-facing routes to configured IP ranges
// Configure via RESTRICT_MERCHANT_TO_LOCAL=true and/or ALLOWED_MERCHANT_IPS in .env
app.use('/merchant',        merchantIpGuard)
app.use('/setup',           merchantIpGuard)
// OAuth callbacks are exempt — they're redirected from external providers (Google/Apple/Facebook)
// through Cloudflare Tunnel, so cf-connecting-ip is the user's public IP. These callbacks are
// already secured by OAuth state validation (CSRF) and single-use authorization codes.
app.use('/api/auth/*', async (c, next) => {
  if (c.req.path.includes('/api/auth/oauth/') && c.req.path.includes('/callback')) {
    return next()
  }
  return merchantIpGuard(c, next)
})
app.use('/api/merchants/*', merchantIpGuard)
app.use('/api/terminals/*', merchantIpGuard)
// /api/push/* is staff-facing (merchant push subscriptions & test notifications).
// Customer push subscriptions go through /api/store/push/subscribe (intentionally public).
app.use('/api/push/*',      merchantIpGuard)
// /api/payments/* — server-IP lookup used by dashboard for Converge whitelist setup.
app.use('/api/payments/*',  merchantIpGuard)

/**
 * Routes
 */

// Serve static files — merchant dashboard assets
app.use('/css/*', serveStatic({ root: './public' }))
app.use('/js/*', serveStatic({ root: './public' }))

// Menu images — in-memory cache + long-lived HTTP cache headers.
// Files are content-addressed (hex hash filenames), so a new upload always
// produces a new URL; we can safely cache forever both on the server and in
// the browser/Cloudflare edge.
//
// Server-side Map<url-path, CachedImage> avoids repeated disk reads for the
// same image across requests (incognito tabs, different customers).
// ETag + If-None-Match let the browser skip re-downloading an image it already
// has in the current session, returning 304 with no body.

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  svg:  'image/svg+xml',
  avif: 'image/avif',
}

interface CachedImage { data: Uint8Array; contentType: string; etag: string }
const _imageCache = new Map<string, CachedImage>()

const _publicRoot = resolve('./public')

app.use('/images/*', async (c) => {
  const urlPath  = new URL(c.req.url).pathname          // e.g. /images/merchants/m_xxx/abc.webp
  const filePath = join('./public', urlPath)

  // SEC-PT-01: Ensure the resolved path stays inside ./public after any
  // normalisation (e.g. encoded dots, redundant slashes).
  // Use path.sep (not '/') so the check works on Windows (backslash) and Linux (forward slash).
  if (!resolve(filePath).startsWith(_publicRoot + sep)) {
    return c.body(null, 403)
  }

  // Serve from in-memory cache if available
  let cached = _imageCache.get(urlPath)

  if (!cached) {
    const file = Bun.file(filePath)
    const exists = await file.exists()
    if (!exists) return c.body(null, 404)

    const data        = new Uint8Array(await file.arrayBuffer())
    const ext         = filePath.split('.').pop()?.toLowerCase() ?? ''
    const contentType = IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // ETag = the filename itself (it's already a content hash)
    const etag        = `"${filePath.split('/').pop()!}"`

    cached = { data, contentType, etag }
    if (_imageCache.size >= 300) {
      const first = _imageCache.keys().next().value
      _imageCache.delete(first)
    }
    _imageCache.set(urlPath, cached)
  }

  // Conditional GET: return 304 if the client already has this version
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && ifNoneMatch === cached.etag) {
    return new Response(null, {
      status: 304,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag':          cached.etag,
      },
    })
  }

  return new Response(cached.data, {
    status: 200,
    headers: {
      'Content-Type':   cached.contentType,
      'Content-Length': String(cached.data.byteLength),
      'Cache-Control':  'public, max-age=31536000, immutable',
      'ETag':           cached.etag,
    },
  })
})
app.use('/icons/*', serveStatic({ root: './public' }))
app.get('/favicon.ico', (c) => c.body(null, 204))
app.get('/manifest.json', serveStatic({ path: './public/manifest.json' }))
app.get('/sw.js', async (c) => {
  return new Response(await _swMerchantContent, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  })
})

// Store service worker must be served with Service-Worker-Allowed header
// for root scope registration. This MUST be registered before the generic
// /store/* static handler, otherwise serveStatic intercepts the request
// and serves the file without the required header.
app.use('/store/sw.js', async () => {
  return new Response(await _swStoreContent, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  })
})

// Serve static files — customer store assets
app.use('/store/*', serveStatic({ root: './public' }))

// Serve static files — refrigerator log app (no auth, localStorage-only)
app.use('/refrigerator/*', serveStatic({ root: './public' }))
app.get('/refrigerator', (c) => {
  return new Response(Bun.file('./public/refrigerator/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// Serve static files — gift card store (public, no auth)
app.use('/gift-cards/*', serveStatic({ root: './public' }))
app.get('/gift-cards', (c) => {
  return new Response(Bun.file('./public/gift-cards/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// Mount API routes
//
// URL prefix reference (registration order matters for Hono first-match):
//   auth              /api/auth/*
//   oauth             /api/oauth/*
//   merchants         /api/merchants/*
//   menu              /api/merchants/:id/menu/*
//   orders            /:merchantSlug/orders  (store-facing, slug-based)
//                     /api/orders/:orderId   (authenticated order lookup)
//   dashboardOrders   /api/merchants/:id/orders/*  (staff dashboard, ID-based)
//
// NOTE: orders.ts and dashboardOrders.ts do NOT share a URL prefix — orders.ts
// uses a slug-based 2-segment path while dashboardOrders.ts uses a 4-segment
// /api/merchants/:id/orders path. Registration order is still preserved here
// because /:merchantSlug/* is a greedy catch-all that must not precede specific
// /api/ prefixes registered before it.
app.route('/', auth)
app.route('/', oauth)
app.route('/', merchants)
app.route('/', menu)
app.route('/', orders)
app.route('/', dashboardOrders)
app.route('/', webhooks)
app.route('/', push)
app.route('/', webauthn)
app.route('/', hours)
app.route('/', employees)
app.route('/', terminals)
app.route('/', dashboardPayments)
app.route('/', dashboardRefunds)
app.route('/', reports)
app.route('/', backup)
app.route('/', store)
app.route('/', events)
app.route('/', counter)
app.route('/', reservations)
app.route('/', giftCards)
app.route('/', fog)
app.route('/', systemHealth)
app.use('/api/merchants/*/counter/*', merchantIpGuard)

// Health check
app.get('/health', (c) => {
  const db = getDatabase()
  const masterKeyInitialized = isMasterKeyInitialized()

  return c.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    database: 'connected',
    masterKey: masterKeyInitialized ? 'initialized' : 'not_initialized',
    environment: process.env.NODE_ENV || 'development',
  })
})

// Public menu endpoint
app.get('/:merchantSlug/menu', async (c) => {
  const slug = c.req.param('merchantSlug')

  try {
    const db = getDatabase()

    // Get merchant
    const merchant = db
      .query<{ id: string; business_name: string }, [string]>(
        `SELECT id, business_name FROM merchants WHERE slug = ? AND status = 'active'`
      )
      .get(slug)

    if (!merchant) {
      return c.json({ error: 'Merchant not found' }, 404)
    }

    // Get menu categories with items
    const categories = db
      .query<{ id: string; name: string; sort_order: number }, [string]>(
        `SELECT id, name, sort_order FROM menu_categories WHERE merchant_id = ? ORDER BY sort_order ASC`
      )
      .all(merchant.id)

    const menuCategories = categories.map((cat) => {
      const items = db
        .query<{
          id: string; name: string; description: string | null
          price_cents: number; image_url: string | null
        }, [string, string]>(
          `SELECT id, name, description, price_cents, image_url
           FROM menu_items WHERE merchant_id = ? AND category_id = ? AND is_available = 1
           ORDER BY sort_order ASC`
        )
        .all(merchant.id, cat.id)
      return { id: cat.id, name: cat.name, items }
    })

    return c.json({
      merchant: { name: merchant.business_name, slug },
      menu: menuCategories,
    })
  } catch (error) {
    console.error('Error fetching menu:', error)
    return c.json({ error: 'Failed to fetch menu' }, 500)
  }
})

// Root — customer-facing store
app.get('/', (c) => {
  return new Response(Bun.file('./public/store/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// Converge payment return — serve store shell; SAM JS intercepts query params
app.get('/pay-return', (c) => {
  return new Response(Bun.file('./public/store/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// Gift card payment return — serve gift card shell; JS intercepts query params
app.get('/gift-cards/pay-return', (c) => {
  return new Response(Bun.file('./public/gift-cards/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// Payment Terms of Service — linked from Finix hosted checkout forms
// Both with and without .html extension are accepted.
app.get('/payments-terms-of-service', (c) => {
  return new Response(Bun.file('./public/store/payments-terms-of-service.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})
app.get('/payments-terms-of-service.html', (c) => {
  return c.redirect('/payments-terms-of-service', 301)
})

// Customer reservation booking page (embeddable as iframe)
app.get('/reserve', (c) => {
  return new Response(Bun.file('./public/reserve/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})
app.use('/reserve/*', serveStatic({ root: './public' }))

// Merchant dashboard (staff only — auth enforced client-side via JWT)
app.get('/merchant', (c) => {
  return new Response(Bun.file('./public/dashboard.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// Merchant onboarding (initial setup when no merchant exists yet)
app.get('/setup', (c) => {
  return new Response(Bun.file('./public/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Server error:', err)
  return c.json(
    {
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    },
    500
  )
})

// Module-level cleanup handles — populated by main(), called by shutdown()
let stopAutoFire: () => void = () => {}
let stopDailyCloseout: () => void = () => {}
let stopFogReminders: () => void = () => {}
let _refreshCleanupInterval: ReturnType<typeof setInterval> | null = null


/**
 * Server startup
 */
async function main() {
  console.log('🚀 Starting Merchant Appliance...')
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`)

  // Warn about CORS config; don't exit — the appliance is same-origin in production
  if (!corsOriginEnv) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('⚠️  CORS_ORIGIN not set — cross-origin requests are blocked.')
      console.warn('   Set CORS_ORIGIN if a separate frontend domain needs API access.')
    } else {
      console.warn('⚠️  CORS_ORIGIN not set — allowing localhost:3000 and localhost:5173 (dev only)')
    }
  }

  // 1. Code verification (skip in development if manifest.json doesn't exist)
  if (process.env.NODE_ENV === 'production' || hasManifest()) {
    await verifyCodeIntegrity()
  } else {
    skipCodeVerification()
  }

  // 2. Initialize database and run migrations
  const db = getDatabase()
  await migrate()
  console.log('✅ Database initialized')

  // 3. Initialize master key
  if (process.env.MASTER_KEY_PASSPHRASE) {
    await initializeMasterKey()
  } else {
    console.warn('⚠️  Master key not initialized (MASTER_KEY_PASSPHRASE not set)')
    console.warn('   API key encryption will not be available until master key is set')
  }

  // 4. Load VAPID keys for push notifications
  loadVapidKeys()

  // 5. Rehydrate active orders (resume SAM workflows)
  try {
    // Get default POS adapter (manual)
    const defaultAdapter = await getAdapter({
      merchantId: 'system',
      posType: 'manual',
    })
    await rehydrateActiveOrders(defaultAdapter)
  } catch (error) {
    console.warn('⚠️  Failed to rehydrate active orders:', error)
    console.warn('   Orders will be reprocessed on next status update')
  }

  try {
    await rehydrateTerminalWorkflows()
  } catch (error) {
    console.warn('⚠️  Failed to rehydrate terminal payment workflows:', error)
  }

  // 6. Start auto clock-out background check (runs every 15 min)
  startAutoClockOut()

  // 7. Start auto-fire background check (fires scheduled orders at pickup_time - prep_time, runs every 60s)
  stopAutoFire = startAutoFire()

  // 8. Reset "out_today" items at midnight (also runs once on startup)
  startAutoResetOos()

  // 9. Start nightly S3 auto-backup scheduler (fires at 02:00)
  startAutoBackup()

  // 9b. Periodic reconciliation sweep — re-runs for any card payment with no
  // reconciliation record (lost due to restart or transient Finix API failure).
  // Fires once after 5 s, then every 30 s (SWEEP_INTERVAL_MS in reconcile.ts).
  startAutoReconcile()

  // 9c. Clover reconciliation — runs at startup then on an adaptive schedule.
  //     Default interval: 120 s.  Drops to 15 s for 2 min after a Clover order
  //     is pushed to the device (payment likely in progress).
  //     Call notifyCloverPaymentInitiated() from any push-order path to trigger
  //     the fast-poll window.
  const cloverClient = new CloverOrderClient()
  if (cloverClient.isEnabled()) {
    const CLOVER_FAST_MS    = 15_000   // poll every 15 s during active payment
    const CLOVER_DEFAULT_MS = 120_000  // poll every 120 s at rest
    const CLOVER_FAST_WINDOW_MS = 2 * 60_000  // stay in fast mode for 2 min

    const doReconcile = () =>
      cloverClient.reconcile(db, (orderId, merchantId) => {
        broadcastToMerchant(merchantId, 'order_updated', { orderId, status: 'paid' })
      }).catch((err: unknown) =>
        console.error('[clover] reconciliation failed:', err instanceof Error ? err.message : err)
      )

    // Startup run (immediate)
    doReconcile()

    let cloverReconcileRunning = false
    const scheduleNext = () => {
      const elapsed = Date.now() - lastCloverPaymentAt()
      const delay = elapsed < CLOVER_FAST_WINDOW_MS ? CLOVER_FAST_MS : CLOVER_DEFAULT_MS
      setTimeout(() => {
        if (cloverReconcileRunning) { scheduleNext(); return }
        cloverReconcileRunning = true
        doReconcile().finally(() => {
          cloverReconcileRunning = false
          scheduleNext()
        })
      }, delay)
    }
    scheduleNext()
  }

  // 10. Daily closeout email — sends sales summary 60 min after close of business
  stopDailyCloseout = startDailyCloseout()

  // 10b. FOG reminder emails — notifies the restaurant when grease trap or hood
  // cleaning intervals are exceeded (polls every 6 hours, sends at most once/day)
  stopFogReminders = startFogReminders()

  // 11. Auto-cancel DISABLED — orders must never be cancelled automatically.
  // Safety invariant: only explicit staff action (or customer self-cancel) may
  // transition an order to 'cancelled'. See temporal-logic note in auto-cancel-stale.ts.
  // startAutoCancelStale()

  // 11. M-16: Periodic cleanup of expired refresh tokens (runs every 6 hours)
  // storeRefreshToken() cleans up on each login, but if no one logs in for days
  // expired rows accumulate. This background sweep prevents unbounded growth.
  _refreshCleanupInterval = setInterval(() => {
    try {
      const db = getDatabase()
      const result = db.run(
        `DELETE FROM refresh_tokens WHERE expires_at < datetime('now')`
      )
      if (result.changes > 0) {
        console.log(`🧹 Cleaned up ${result.changes} expired refresh token(s)`)
      }
    } catch (err) {
      console.error('[refresh-token-cleanup] Error:', err)
    }
  }, 6 * 60 * 60_000)

  // 12. Start server
  const port = parseInt(process.env.PORT || '3000')
  // NOTE: Do NOT use process.env.HOSTNAME — on Windows the OS automatically sets
  // HOSTNAME to the machine name (e.g. DESKTOP-ABC123), which would bind the server
  // to the network interface instead of loopback. Use SERVER_BIND instead.
  const hostname = process.env.SERVER_BIND || '127.0.0.1'

  const server = Bun.serve<CounterWsData>({
    port,
    hostname,
    fetch(req, srv) {
      const url = new URL(req.url)

      // WebSocket upgrade for the Kizo Counter Android app
      if (url.pathname === '/counter') {
        const token = url.searchParams.get('token')
        const merchantId = validateCounterToken(token)
        if (!merchantId) return new Response('Unauthorized', { status: 401 })
        if (srv.upgrade(req, { data: { merchantId } })) return undefined as unknown as Response
        return new Response('WebSocket upgrade required', { status: 426 })
      }

      return app.fetch(req, srv)
    },
    websocket: {
      open(ws)         { counterWsOpen(ws) },
      message(ws, msg) { counterWsMessage(ws, msg) },
      close(ws)        { counterWsClose(ws) },
    },
    development: process.env.NODE_ENV !== 'production',
    // Keep connections alive for cloudflared compatibility.
    // cloudflared reuses TCP connections (keep-alive pooling); Bun's default
    // idle timeout closes them too quickly, causing "unexpected EOF" errors.
    // 255 is Bun's max allowed value (seconds).
    idleTimeout: 255,
  })

  console.log(`✅ Server running on http://${hostname}:${server.port}`)
  console.log(`   Ready to accept requests`)
}

// Handle shutdown gracefully
async function shutdown(signal: string) {
  console.log(`\n🛑 Shutting down gracefully (${signal})...`)
  // Stop background intervals
  stopAutoFire()
  stopDailyCloseout()
  stopFogReminders()
  if (_refreshCleanupInterval) clearInterval(_refreshCleanupInterval)
  // Close Puppeteer browser if it was launched for HTML receipt rendering
  try {
    const { closeHtmlRenderer } = await import('./services/html-receipt')
    await closeHtmlRenderer()
  } catch {
    // Not launched — nothing to close
  }
  // Gift card PDF renderer shares the html-receipt browser; closed above
  // Close SQLite — flushes WAL checkpoint so next startup skips replay
  closeDatabase()
  process.exit(0)
}

process.on('SIGINT',  () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })

// Run server
if (import.meta.main) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error)
    process.exit(1)
  })
}

export { app }
