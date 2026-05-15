/**
 * status.ts — COSA monitoring endpoint
 *
 * GET /api/status
 *
 * Returns a comprehensive appliance snapshot used by COSA to power its watcher
 * system.  COSA polls this endpoint every 60 s to check for anomalies, stale
 * orders, hardware issues, and payment errors.
 *
 * ── Access control ────────────────────────────────────────────────────────────
 *   • Requires a valid Bearer JWT (same `authenticate` middleware as all
 *     merchant API routes).
 *   • COSA authenticates with a `cloud`-scoped API key that maps to a JWT.
 *   • The endpoint is blocked at the Cloudflare tunnel level (§8 of
 *     cosa-monitoring-spec.md) — it is reachable from the LAN only.
 *
 * ── Design constraints ────────────────────────────────────────────────────────
 *   • All data comes from SQLite or in-process counters — no blocking I/O.
 *   • Target latency < 200 ms; no TCP printer probes (see Phase B).
 *   • Cache-Control: no-store — COSA must always get fresh data.
 *
 * ── Phase coverage ────────────────────────────────────────────────────────────
 *   Phase A (this file): store, orders, payments (stubs), hardware, system,
 *                        errors, security groups.
 *   Phase B: real printer probe status (currently 'unknown').
 *   Phase C: payment_errors table → payments.recent_errors populated.
 *   Phase D: anomalous_req_rate baseline from hourly req_per_min history.
 */

import { Hono } from 'hono'
import os from 'os'
import { getDatabase } from '../db/connection'
import { authenticate } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { getCpuHistory, getRecentErrors, currentCpuPct } from '../utils/system-monitor'
import { getCounterStatus } from '../services/counter-ws'
import { getSseClientCount } from '../services/sse'
import { getPrinterStatus } from '../services/printer-probe'
import { getReqPerMin } from '../utils/req-counter'
import { getFailedAuthCount1h, getBlockedIps, getRateLimited1h } from './auth'
import { getBaselineReqPerMin } from '../services/system-metrics'
import { BUILD_VERSION } from '../utils/build-version'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Disk stats for the working directory, gracefully degraded to zeros. */
function getDiskStats(): { total: number; free: number; used: number } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statfsSync } = require('fs') as typeof import('fs')
    const sf = (statfsSync as (path: string) => { blocks: number; bavail: number; bsize: number })('.')
    const total = sf.blocks * sf.bsize
    const free  = sf.bavail * sf.bsize
    return { total, free, used: total - free }
  } catch {
    return { total: 0, free: 0, used: 0 }
  }
}

/** Format terminal model key to a human-readable display name. */
function terminalDisplayName(model: string): string {
  const names: Record<string, string> = {
    pax_a920_pro: 'PAX A920 Pro',
    pax_d135:     'PAX D135 (Counter)',
    pax_a800:     'PAX A800',
  }
  return names[model] ?? model
}

/**
 * Compute whether the store is currently open based on business_hours and
 * scheduled_closures, in the merchant's local timezone.
 *
 * Returns `{ isOpen, nextOpenLabel }` where `nextOpenLabel` is a human-readable
 * label like "Tomorrow · 11:00 AM" or "Sat · 5:00 PM" when the store is closed.
 * Scans up to 7 days ahead to find the next opening.
 *
 * ⚠️  Divergence risk: The store PWA's `getStoreOpenStatus()` (store-menu.js) is
 * the customer-facing source of truth.  This server-side reimplementation handles
 * `business_hours` and `scheduled_closures` but does NOT replicate the PWA's
 * `isCategoryAvailableNow()` blackout-date or `availableDays` logic.  If the PWA's
 * open-status calculation is updated, this function must be kept in sync.
 */
function computeStoreOpenStatus(
  merchantId: string,
  timezone: string,
  db: ReturnType<typeof getDatabase>,
): { isOpen: boolean; nextOpenLabel: string | null } {
  const now = new Date()
  // Derive "now" in merchant local time by parsing the locale string
  const localNow  = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  const currentHH = `${String(localNow.getHours()).padStart(2, '0')}:${String(localNow.getMinutes()).padStart(2, '0')}`
  const todayStr  = localNow.toLocaleDateString('en-CA')  // YYYY-MM-DD
  const todayDow  = localNow.getDay()                     // 0=Sun … 6=Sat

  const isScheduledClosed = (dateStr: string) =>
    !!db.query<{ id: string }, [string, string, string]>(
      `SELECT id FROM scheduled_closures
       WHERE merchant_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1`
    ).get(merchantId, dateStr, dateStr)

  // Check if open right now
  if (!isScheduledClosed(todayStr)) {
    const todaySlots = db.query<{ open_time: string; close_time: string }, [string, number]>(
      `SELECT open_time, close_time FROM business_hours
       WHERE merchant_id = ? AND service_type = 'regular' AND day_of_week = ? AND is_closed = 0
       ORDER BY slot_index ASC`
    ).all(merchantId, todayDow)

    for (const slot of todaySlots) {
      if (currentHH >= slot.open_time && currentHH < slot.close_time) {
        return { isOpen: true, nextOpenLabel: null }
      }
    }
  }

  // Scan up to 7 days ahead to find next opening
  const dayAbbr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  for (let ahead = 1; ahead <= 7; ahead++) {
    const candidate = new Date(localNow)
    candidate.setDate(candidate.getDate() + ahead)
    const candidateStr = candidate.toLocaleDateString('en-CA')
    const candidateDow = candidate.getDay()

    if (isScheduledClosed(candidateStr)) continue

    const firstSlot = db.query<{ open_time: string }, [string, number]>(
      `SELECT open_time FROM business_hours
       WHERE merchant_id = ? AND service_type = 'regular' AND day_of_week = ? AND is_closed = 0
       ORDER BY slot_index ASC LIMIT 1`
    ).get(merchantId, candidateDow)

    if (firstSlot) {
      const [hh, mm] = firstSlot.open_time.split(':').map(Number)
      const ampm  = hh >= 12 ? 'PM' : 'AM'
      const h12   = hh % 12 || 12
      const label = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`
      const dayLabel = ahead === 1 ? 'Tomorrow' : dayAbbr[candidateDow]
      return { isOpen: false, nextOpenLabel: `${dayLabel} · ${label}` }
    }
  }

  return { isOpen: false, nextOpenLabel: null }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Orders active longer than this many minutes are considered stale. */
const STALE_THRESHOLD_MINUTES = 60

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * GET /api/status
 *
 * COSA monitoring snapshot.  See `docs/cosa-monitoring-spec.md` for full schema
 * documentation, watcher examples, and implementation plan.
 *
 * @returns Full status snapshot — see spec §3 for schema.
 */
router.get('/api/status', authenticate, (c: AuthContext) => {
  const db = getDatabase()

  // ── Merchant row ────────────────────────────────────────────────────────
  const m = db.query<{
    id: string
    status: string
    timezone: string
    is_paused: number
    printer_ip: string | null
    kitchen_printer_protocol: string | null
    counter_printer_ip: string | null
    counter_printer_protocol: string | null
    receipt_printer_ip: string | null
    receipt_printer_protocol: string | null
  }, []>(
    `SELECT id, status, timezone,
            (online_orders_paused_until IS NOT NULL
             AND online_orders_paused_until > datetime('now')) AS is_paused,
            printer_ip, kitchen_printer_protocol,
            counter_printer_ip, counter_printer_protocol,
            receipt_printer_ip, receipt_printer_protocol
       FROM merchants WHERE status IN ('active','paused') ORDER BY created_at ASC LIMIT 1`
  ).get()

  if (!m) return c.json({ error: 'No active merchant found' }, 503)

  const merchantId = m.id
  const tz = m.timezone ?? 'America/Los_Angeles'
  const now = new Date().toISOString()

  // ── §3: store ───────────────────────────────────────────────────────────
  const isPaused   = m.is_paused === 1
  const openStatus = computeStoreOpenStatus(merchantId, tz, db)

  const store = {
    paused:           isPaused,
    online_ordering:  m.status === 'active',
    is_open:          openStatus.isOpen,
    next_open_label:  openStatus.nextOpenLabel,
  }

  // ── §3: orders ──────────────────────────────────────────────────────────
  const pendingCount = (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM orders WHERE merchant_id=? AND status='submitted'`
  ).get(merchantId)?.n ?? 0)

  const activeCount = (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM orders
     WHERE merchant_id=? AND status IN ('confirmed','preparing','ready')`
  ).get(merchantId)?.n ?? 0)

  // Use SQLite localtime for today-scoped counts (merchant tz is approximated via server tz;
  // true merchant-local date filtering handled Phase A-3 via application-layer tz conversion)
  const completedToday = (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM orders
     WHERE merchant_id=? AND status='completed'
       AND DATE(created_at,'localtime') = DATE('now','localtime')`
  ).get(merchantId)?.n ?? 0)

  const cancelledToday = (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM orders
     WHERE merchant_id=? AND status='cancelled'
       AND DATE(created_at,'localtime') = DATE('now','localtime')`
  ).get(merchantId)?.n ?? 0)

  const staleCount = (db.query<{ n: number }, [string, number]>(
    `SELECT COUNT(*) AS n FROM orders
     WHERE merchant_id=?
       AND status IN ('confirmed','preparing','ready')
       AND (unixepoch('now') - unixepoch(created_at)) / 60 > ?`
  ).get(merchantId, STALE_THRESHOLD_MINUTES)?.n ?? 0)

  const orphanedCount = (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM orders o
     WHERE o.merchant_id=? AND o.status='completed'
       AND (unixepoch('now') - unixepoch(o.updated_at)) / 3600 > 1
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)`
  ).get(merchantId)?.n ?? 0)

  const oldestActiveMinutes = (db.query<{ v: number | null }, [string]>(
    `SELECT MAX((unixepoch('now') - unixepoch(created_at)) / 60) AS v
     FROM orders WHERE merchant_id=? AND status IN ('confirmed','preparing','ready')`
  ).get(merchantId)?.v ?? null)

  type StaleOrderRow = { id: string; status: string; age_minutes: number; item_count: number; source: string }
  const staleOrders = db.query<StaleOrderRow, [string, number]>(
    `SELECT id, status,
            ROUND((unixepoch('now') - unixepoch(created_at)) / 60.0) AS age_minutes,
            json_array_length(items) AS item_count,
            CASE WHEN source='online' THEN 'online' ELSE 'in_person' END AS source
       FROM orders
      WHERE merchant_id=?
        AND status IN ('confirmed','preparing','ready')
        AND (unixepoch('now') - unixepoch(created_at)) / 60 > ?
      ORDER BY created_at ASC LIMIT 10`
  ).all(merchantId, STALE_THRESHOLD_MINUTES)

  const orders = {
    pending_count:            pendingCount,
    active_count:             activeCount,
    completed_today:          completedToday,
    cancelled_today:          cancelledToday,
    stale_count:              staleCount,
    stale_threshold_minutes:  STALE_THRESHOLD_MINUTES,
    orphaned_count:           orphanedCount,
    oldest_active_minutes:    oldestActiveMinutes,
    stale_orders:             staleOrders,
  }

  // ── §3: payments ────────────────────────────────────────────────────────
  // All recorded payments have an order_id (NOT NULL in schema), so
  // unmatched_count is always 0 unless there is a data-integrity problem.
  const unmatchedCount = (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM payments WHERE merchant_id=? AND order_id IS NULL`
  ).get(merchantId)?.n ?? 0)

  // terminal_errors_24h: rows in payment_errors inserted in the last 24 hours.
  // Exclude rows marked superseded — those are retry/cash-switch noise that ended
  // in a successful payment on the same order (see record-payment supersede sweep).
  const terminalErrors24h = (db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM payment_errors
     WHERE merchant_id=? AND occurred_at >= datetime('now', '-24 hours')
       AND superseded_at IS NULL`
  ).get(merchantId)?.n ?? 0)

  // last_successful_at: most recent successful payment (all payment rows are successes).
  const lastSuccessfulAt = db.query<{ ts: string | null }, [string]>(
    `SELECT MAX(created_at) AS ts FROM payments WHERE merchant_id=?`
  ).get(merchantId)?.ts ?? null

  // recent_errors: last 5 non-superseded entries, most recent first.
  type PaymentErrorRow = { occurred_at: string; error_type: string; order_id: string | null; detail: string }
  const recentPaymentErrors = db.query<PaymentErrorRow, [string]>(
    `SELECT occurred_at, error_type, order_id, detail
       FROM payment_errors WHERE merchant_id=?
        AND superseded_at IS NULL
      ORDER BY occurred_at DESC LIMIT 5`
  ).all(merchantId)

  const payments = {
    unmatched_count:      unmatchedCount,
    terminal_errors_24h:  terminalErrors24h,
    last_successful_at:   lastSuccessfulAt,
    recent_errors: recentPaymentErrors.map(e => ({
      at:       e.occurred_at,
      type:     e.error_type,
      order_id: e.order_id,
      detail:   e.detail,
    })),
  }

  // ── §3: hardware ────────────────────────────────────────────────────────
  // Printer status is read from the background TCP probe cache (printer-probe.ts).
  // Status is 'unknown' only on the first 5 s after startup, before the first probe runs.
  const printers: Array<{ role: string; ip: string; protocol: string; status: string; checked_at: string | null }> = []
  if (m.printer_ip) {
    const probe = getPrinterStatus(m.printer_ip)
    printers.push({ role: 'kitchen', ip: m.printer_ip,
      protocol: m.kitchen_printer_protocol ?? 'star-line',
      status: probe.status, checked_at: probe.checked_at })
  }
  if (m.counter_printer_ip && m.counter_printer_ip !== m.printer_ip) {
    const probe = getPrinterStatus(m.counter_printer_ip)
    printers.push({ role: 'counter', ip: m.counter_printer_ip,
      protocol: m.counter_printer_protocol ?? 'star-line',
      status: probe.status, checked_at: probe.checked_at })
  }
  if (m.receipt_printer_ip &&
      m.receipt_printer_ip !== m.printer_ip &&
      m.receipt_printer_ip !== m.counter_printer_ip) {
    const probe = getPrinterStatus(m.receipt_printer_ip)
    printers.push({ role: 'receipt', ip: m.receipt_printer_ip,
      protocol: m.receipt_printer_protocol ?? 'star-line',
      status: probe.status, checked_at: probe.checked_at })
  }

  const termRows = db.query<{ id: string; model: string; nickname: string }, [string]>(
    `SELECT id, model, nickname FROM terminals WHERE merchant_id=? ORDER BY created_at ASC`
  ).all(merchantId)

  const counterWs = getCounterStatus()

  const terminals = termRows.map(t => {
    const status = t.model === 'pax_d135'
      ? (counterWs.connected ? (counterWs.deviceConnected ? 'connected' : 'bridge_only') : 'offline')
      : 'configured'
    return {
      id:           t.id,
      model:        t.model,
      display_name: terminalDisplayName(t.model),
      nickname:     t.nickname,
      status,
      // checked_at is only meaningful for pax_d135 (live WebSocket probe).
      // Other terminal models report a static DB-derived status — use null
      // so COSA doesn't infer a recent health check that never happened.
      checked_at: t.model === 'pax_d135' ? now : null,
    }
  })

  const hardware = { printers, terminals }

  // ── §3: system ──────────────────────────────────────────────────────────
  const memTotal    = os.totalmem()
  const memFree     = os.freemem()
  const disk        = getDiskStats()
  const cpuHistory  = getCpuHistory()
  const cpuNow      = currentCpuPct()

  // Sliding averages from CPU history (5 s samples: 12 samples = 1 min, 60 = 5 min)
  const cpu1mSamples  = cpuHistory.slice(-12)
  const cpu5mSamples  = cpuHistory.slice(-60)
  const cpu1mAvg  = cpu1mSamples.length
    ? Math.round(cpu1mSamples.reduce((s, x) => s + x.pct, 0) / cpu1mSamples.length * 10) / 10
    : cpuNow
  const cpu5mAvg  = cpu5mSamples.length
    ? Math.round(cpu5mSamples.reduce((s, x) => s + x.pct, 0) / cpu5mSamples.length * 10) / 10
    : cpuNow

  const memUsedPct  = Math.round((memTotal - memFree) / memTotal * 1000) / 10
  const diskUsedPct = disk.total > 0
    ? Math.round(disk.used / disk.total * 1000) / 10
    : 0
  const diskFreeGb  = Math.round(disk.free / (1024 ** 3) * 10) / 10

  // Validate DB is responsive
  let dbStatus: 'ok' | 'error' = 'ok'
  try { db.query('SELECT 1').get() } catch { dbStatus = 'error' }

  const reqPerMin = getReqPerMin()

  const system = {
    uptime_s:       Math.round(process.uptime()),
    cpu_now_pct:    Math.round(cpuNow * 10) / 10,
    cpu_1m_avg:     cpu1mAvg,
    cpu_5m_avg:     cpu5mAvg,
    mem_used_pct:   memUsedPct,
    disk_used_pct:  diskUsedPct,
    disk_free_gb:   diskFreeGb,
    req_per_min:    reqPerMin,
    sse_clients:    getSseClientCount(),
    db:             dbStatus,
  }

  // ── §3: security ────────────────────────────────────────────────────────
  // anomalous_req_rate: true if current req_per_min exceeds 10× the 24-hour median baseline.
  // Returns false when fewer than 3 hourly samples exist (fresh deployment) to avoid
  // false alerts. Baseline is computed from system_metrics (populated by startHourlyMetricsSample).
  const baselineReqPerMin = getBaselineReqPerMin()
  const security = {
    failed_auth_1h:     getFailedAuthCount1h(),
    rate_limited_1h:    getRateLimited1h(),
    blocked_ips:        getBlockedIps(),
    anomalous_req_rate: baselineReqPerMin !== null && reqPerMin > baselineReqPerMin * 10,
  }

  // ── §3: errors ──────────────────────────────────────────────────────────
  const recentErrors = getRecentErrors()
  const oneHourAgo   = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const errors = {
    count_1h: recentErrors.filter(e => e.timestamp >= oneHourAgo).length,
    recent:   recentErrors.slice(0, 5).map(e => ({
      at:      e.timestamp,
      message: e.message,
      route:   null as string | null,  // stack parsing not in scope Phase A
      stack:   null as string | null,
    })),
  }

  // ── §3: instructions ────────────────────────────────────────────────────
  // Surfaces AI special-instruction parse outcomes for the last 24 hours.
  // Used by COSA to monitor parse quality and detect jailbreak attempts.
  type SilStats = { total: number; jailbreak: number; unfulfillable: number; accepted: number }
  const instrStats = db.query<SilStats, [string]>(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN outcome='jailbreak'     THEN 1 ELSE 0 END), 0) AS jailbreak,
       COALESCE(SUM(CASE WHEN outcome='unfulfillable' THEN 1 ELSE 0 END), 0) AS unfulfillable,
       COALESCE(SUM(CASE WHEN outcome='accepted'      THEN 1 ELSE 0 END), 0) AS accepted
     FROM special_instruction_log
     WHERE merchant_id = ? AND occurred_at >= datetime('now', '-24 hours')`,
  ).get(merchantId) ?? { total: 0, jailbreak: 0, unfulfillable: 0, accepted: 0 }

  type SilRow = { occurred_at: string; item_id: string | null; instruction_text: string; outcome: string }
  const recentUnfulfillable = db.query<SilRow, [string]>(
    `SELECT occurred_at, item_id, instruction_text, outcome
       FROM special_instruction_log
      WHERE merchant_id = ? AND outcome IN ('unfulfillable','jailbreak')
      ORDER BY occurred_at DESC LIMIT 5`,
  ).all(merchantId)

  const instructions = {
    parse_calls_24h:      instrStats.total,
    accepted_24h:         instrStats.accepted,
    unfulfillable_24h:    instrStats.unfulfillable,
    jailbreak_24h:        instrStats.jailbreak,
    recent_unfulfillable: recentUnfulfillable.map(r => ({
      at:      r.occurred_at,
      item_id: r.item_id,
      text:    r.instruction_text,
      outcome: r.outcome,
    })),
  }

  // ── Response ────────────────────────────────────────────────────────────
  return c.json(
    { timestamp: now, version: BUILD_VERSION, store, orders, payments, instructions, hardware, system, security, errors },
    200,
    { 'Cache-Control': 'no-store' },
  )
})

export { router as status }
