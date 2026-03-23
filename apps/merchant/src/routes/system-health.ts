/**
 * system-health.ts — POS appliance health & diagnostics routes.
 *
 * GET  /api/merchants/:id/system/health        — full health snapshot
 * POST /api/merchants/:id/system/printer-test  — run printer diagnostic
 */

import { Hono } from 'hono'
import os from 'os'
import { getDatabase } from '../db/connection'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { getCpuHistory, getMemHistory, getRecentErrors, currentCpuPct } from '../utils/system-monitor'
import { printDiagnostic } from '../services/printer'
import { getCounterStatus } from '../services/counter-ws'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Disk stats for the working directory, gracefully degraded to zeros. */
function getDiskStats(): { total: number; free: number; used: number } {
  try {
    // fs.statfsSync is available Node ≥18.15 / Bun ≥1.0
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statfsSync } = require('fs') as typeof import('fs')
    const sf = (statfsSync as (path: string) => { blocks: number; bfree: number; bavail: number; bsize: number })('.')
    const total = sf.blocks * sf.bsize
    const free  = sf.bavail * sf.bsize
    return { total, free, used: total - free }
  } catch {
    return { total: 0, free: 0, used: 0 }
  }
}

/** Format model key into display name */
function terminalDisplayName(model: string): string {
  const names: Record<string, string> = {
    pax_a920_pro: 'PAX A920 Pro',
    pax_d135:     'PAX D135 (Counter)',
    pax_a800:     'PAX A800',
  }
  return names[model] ?? model
}

/**
 * GET /api/merchants/:id/system/health
 *
 * Returns a full appliance health snapshot: OS info, CPU/memory history,
 * disk usage, connected printers, registered terminals, Counter app status,
 * and recent captured errors. Used by the System Health dashboard panel.
 *
 * @returns `{ os, cpu, memory, disk, printers, terminals, counterApp, recentErrors }`
 */
router.get('/api/merchants/:id/system/health', authenticate, requireOwnMerchant, requireRole('owner', 'manager'), (c: AuthContext) => {
  const db = getDatabase()
  const { id } = c.req.param()

  // ── OS / process stats ────────────────────────────────────────────────
  const memTotal   = os.totalmem()
  const memFree    = os.freemem()
  const proc       = process.memoryUsage()
  const loadAvg    = os.loadavg()           // [1m, 5m, 15m]
  const uptimeSec  = process.uptime()
  const startedAt  = new Date(Date.now() - uptimeSec * 1_000).toISOString()
  const disk       = getDiskStats()

  // ── Printers from merchant profile ────────────────────────────────────
  const merchantRow = db.query<{
    printer_ip: string | null
    kitchen_printer_protocol: string | null
    counter_printer_ip: string | null
    counter_printer_protocol: string | null
    receipt_printer_ip: string | null
    receipt_printer_protocol: string | null
  }, [string]>(
    `SELECT printer_ip, kitchen_printer_protocol,
            counter_printer_ip, counter_printer_protocol,
            receipt_printer_ip, receipt_printer_protocol
       FROM merchants WHERE id = ? LIMIT 1`
  ).get(id)

  const printers: { role: string; ip: string; protocol: string }[] = []
  if (merchantRow?.printer_ip) {
    printers.push({ role: 'kitchen', ip: merchantRow.printer_ip, protocol: merchantRow.kitchen_printer_protocol ?? 'star-line' })
  }
  if (merchantRow?.counter_printer_ip && merchantRow.counter_printer_ip !== merchantRow.printer_ip) {
    printers.push({ role: 'counter', ip: merchantRow.counter_printer_ip, protocol: merchantRow.counter_printer_protocol ?? 'star-line' })
  }
  if (merchantRow?.receipt_printer_ip &&
      merchantRow.receipt_printer_ip !== merchantRow.printer_ip &&
      merchantRow.receipt_printer_ip !== merchantRow.counter_printer_ip) {
    printers.push({ role: 'receipt', ip: merchantRow.receipt_printer_ip, protocol: merchantRow.receipt_printer_protocol ?? 'star-line' })
  }

  // ── Terminals from terminals table ────────────────────────────────────
  const terminalRows = db.query<{
    id: string; model: string; nickname: string; serial_number: string | null
  }, [string]>(
    `SELECT id, model, nickname, serial_number FROM terminals WHERE merchant_id = ? ORDER BY created_at ASC`
  ).all(id)

  const counterWs = getCounterStatus()

  const terminals = terminalRows.map(t => {
    // D135 Android bridge: status from WebSocket connection
    const wsStatus = t.model === 'pax_d135'
      ? (counterWs.connected ? (counterWs.deviceConnected ? 'connected' : 'bridge_only') : 'offline')
      : 'configured'
    return {
      id: t.id,
      model: t.model,
      displayName: terminalDisplayName(t.model),
      nickname: t.nickname,
      serialNumber: t.serial_number,
      status: wsStatus,
    }
  })

  return c.json({
    timestamp: new Date().toISOString(),
    system: {
      uptimeSec,
      startedAt,
      loadAvg,
      memory: {
        sysTotal:    memTotal,
        sysFree:     memFree,
        sysUsed:     memTotal - memFree,
        processRss:  proc.rss,
        heapUsed:    proc.heapUsed,
        heapTotal:   proc.heapTotal,
        external:    proc.external,
      },
      disk,
      platform: os.platform(),
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
    },
    cpuNow: currentCpuPct(),
    cpuHistory: getCpuHistory(),
    memHistory: getMemHistory(),
    printers,
    terminals,
    recentErrors: getRecentErrors(),
  })
})

/**
 * POST /api/merchants/:id/system/printer-test
 *
 * Runs a 5-step TCP/WebPRNT/raster diagnostic against a printer at the given
 * LAN IP address and prints a test page. Takes ~5 s. Only accepts private
 * RFC-1918 IP addresses (10.x, 172.16–31.x, 192.168.x) to prevent SSRF.
 *
 * @param body.ip - Printer's LAN IP address
 * @param body.protocol - Optional protocol override (default: auto-detect)
 * @returns `{ results: DiagnosticResult[] }`
 */

/** Returns true only for RFC-1918 private IPv4 addresses. */
function isPrivateIp(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
}

router.post('/api/merchants/:id/system/printer-test', authenticate, requireOwnMerchant, requireRole('owner', 'manager', 'staff'), async (c: AuthContext) => {
  const body = await c.req.json<{ ip: unknown }>().catch(() => null)
  if (!body?.ip || typeof body.ip !== 'string') return c.json({ error: 'ip required' }, 400)
  if (!isPrivateIp(body.ip)) return c.json({ error: 'ip must be a private LAN address (10.x, 172.16–31.x, or 192.168.x)' }, 400)

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Diagnostic timed out after 12 s')), 12_000)
  )

  try {
    const results = await Promise.race([printDiagnostic(body.ip), timeout])
    return c.json({ ip: body.ip, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ ip: body.ip, error: message, results: [] }, 504)
  }
})

export { router as systemHealth }
