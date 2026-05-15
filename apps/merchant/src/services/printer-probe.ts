/**
 * printer-probe.ts — Background TCP printer health probe
 *
 * Runs every 120 s and attempts a TCP connection to port 9100 for each
 * configured printer IP.  Results are cached in memory so `GET /api/status`
 * can report real `hardware.printers[].status` without blocking on I/O.
 *
 * ── Status values ──────────────────────────────────────────────────────────
 *   'ok'       — TCP connection to port 9100 succeeded
 *   'timeout'  — No response within PROBE_TIMEOUT_MS
 *   'refused'  — Connection refused (port closed; printer off or firewall)
 *   'unknown'  — Not yet probed (server just started)
 *
 * ── Design constraints ─────────────────────────────────────────────────────
 *   • The cache is reset on server restart → 'unknown' until the first probe.
 *   • Probes run serially per printer to avoid flooding the network.
 *   • The TCP socket is closed immediately after the connection is established
 *     (we only need reachability, not protocol negotiation).
 *   • On Windows (dev) Bun.connect() flush() returns undefined — the probe
 *     still works because we resolve/reject in open/error, not on flush.
 */

import { getDatabase } from '../db/connection'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TCP port used by Star, Epson, and most thermal printers. */
const PRINTER_PORT = 9100

/** Maximum time to wait for a TCP connection before reporting 'timeout'. */
const PROBE_TIMEOUT_MS = 5_000

/** How often to re-probe all configured printers. */
const PROBE_INTERVAL_MS = 120_000

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface PrinterProbeResult {
  status: 'ok' | 'timeout' | 'refused' | 'unknown'
  checked_at: string | null  // ISO 8601 UTC, null = never probed
}

/** ip → last known probe result */
const _cache = new Map<string, PrinterProbeResult>()

/** Guard: prevents a second probe cycle from starting while the first is still in progress. */
let _probing = false

/**
 * Return the cached probe result for a printer IP.
 * Returns `{ status: 'unknown', checked_at: null }` for IPs not yet probed.
 */
export function getPrinterStatus(ip: string): PrinterProbeResult {
  return _cache.get(ip) ?? { status: 'unknown', checked_at: null }
}

// ---------------------------------------------------------------------------
// Single-IP probe
// ---------------------------------------------------------------------------

/**
 * Attempt a TCP connection to `ip:9100`.
 *
 * Resolves with the probe status string.  Never rejects — all errors are
 * mapped to either 'refused' or 'timeout'.
 */
function probePrinter(ip: string): Promise<'ok' | 'timeout' | 'refused'> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: 'ok' | 'timeout' | 'refused') => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    // Overall deadline — fires if the OS doesn't raise ECONNREFUSED quickly
    const timer = setTimeout(() => settle('timeout'), PROBE_TIMEOUT_MS)

    Bun.connect({
      hostname: ip,
      port: PRINTER_PORT,
      socket: {
        open(socket) {
          // Connection established — printer is reachable
          clearTimeout(timer)
          settle('ok')
          // Close the socket immediately; we only needed a SYN-ACK
          socket.end()
        },
        error(_socket, err) {
          clearTimeout(timer)
          // ECONNREFUSED → port closed (printer off or firewall rule)
          // Anything else (EHOSTUNREACH, ENETUNREACH, etc.) → treat as timeout
          const code = (err as NodeJS.ErrnoException).code
          settle(code === 'ECONNREFUSED' ? 'refused' : 'timeout')
        },
        close() {
          // Noop if open() already settled as 'ok' (settled guard prevents double-resolve).
          // Fallback to 'refused' for the rare edge case where close fires without open —
          // in practice this means the connection was torn down before it fully established.
          clearTimeout(timer)
          settle('refused')
        },
        connectError(_socket, err) {
          clearTimeout(timer)
          const code = (err as NodeJS.ErrnoException).code
          settle(code === 'ECONNREFUSED' ? 'refused' : 'timeout')
        },
        // Satisfy Bun's required socket handler signatures:
        data() {},   // no-op — we don't read printer responses
        drain() {},  // no-op — we don't write after the initial open
        end() {},    // no-op — printer FIN after our socket.end(); already settled as 'ok'
        timeout() { clearTimeout(timer); settle('timeout') },
      },
    }).catch(() => {
      // Bun.connect() itself may throw synchronously on bad hostname format
      clearTimeout(timer)
      settle('timeout')
    })
  })
}

// ---------------------------------------------------------------------------
// Probe loop
// ---------------------------------------------------------------------------

/**
 * Collect all distinct printer IPs from the merchants table and probe each one.
 * Evicts stale cache entries for IPs that are no longer configured.
 * Skips the cycle if a previous run is still in progress.
 */
async function runProbes(): Promise<void> {
  if (_probing) return
  _probing = true

  try {
    let db
    try {
      db = getDatabase()
    } catch {
      // DB not available yet (e.g. test teardown) — skip silently
      return
    }

    type Row = {
      printer_ip: string | null
      counter_printer_ip: string | null
      receipt_printer_ip: string | null
    }

    const rows = db.query<Row, []>(
      `SELECT printer_ip, counter_printer_ip, receipt_printer_ip FROM merchants WHERE status IN ('active','paused')`
    ).all()

    // Deduplicate IPs across all merchants and all roles
    const ips = new Set<string>()
    for (const row of rows) {
      if (row.printer_ip)         ips.add(row.printer_ip)
      if (row.counter_printer_ip) ips.add(row.counter_printer_ip)
      if (row.receipt_printer_ip) ips.add(row.receipt_printer_ip)
    }

    // Evict cached entries for IPs that are no longer configured
    for (const cachedIp of _cache.keys()) {
      if (!ips.has(cachedIp)) _cache.delete(cachedIp)
    }

    for (const ip of ips) {
      try {
        const status = await probePrinter(ip)
        _cache.set(ip, { status, checked_at: new Date().toISOString() })
        if (status !== 'ok') {
          console.warn(`[printer-probe] ${ip}: ${status}`)
        }
      } catch (err) {
        // Should never reach here — probePrinter never rejects — but be safe
        _cache.set(ip, { status: 'timeout', checked_at: new Date().toISOString() })
        console.error(`[printer-probe] unexpected error probing ${ip}:`, err)
      }
    }
  } finally {
    _probing = false
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the background printer probe service.
 *
 * - Runs an initial probe 5 s after startup (gives the server time to fully
 *   initialize and the DB to be ready before the first query).
 * - Subsequent probes run every `PROBE_INTERVAL_MS` (120 s).
 *
 * @returns A stop function — call it on SIGTERM to clear the interval.
 */
export function startPrinterProbe(): () => void {
  // Delay first probe slightly so server startup isn't blocked
  const initialTimer = setTimeout(() => {
    runProbes().catch(err => console.error('[printer-probe] initial probe failed:', err))
  }, 5_000)

  const interval = setInterval(() => {
    runProbes().catch(err => console.error('[printer-probe] probe cycle failed:', err))
  }, PROBE_INTERVAL_MS)

  console.log(`✅ Printer probe started (interval: ${PROBE_INTERVAL_MS / 1000}s, timeout: ${PROBE_TIMEOUT_MS / 1000}s)`)

  return () => {
    clearTimeout(initialTimer)
    clearInterval(interval)
    console.log('🛑 Printer probe stopped')
  }
}
