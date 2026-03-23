/**
 * Server-Sent Events (SSE) route
 *
 * Authentication flow (C-01 — JWT never in URL):
 *   1. Dashboard POSTs to GET /api/merchants/:id/sse-ticket (authenticated via JWT header)
 *      and receives a 30-second single-use ticket.
 *   2. Dashboard opens EventSource with ?ticket=<hex> instead of ?token=<jwt>.
 *   3. The SSE handler consumes the ticket (single-use) and begins streaming.
 *
 * Events emitted:
 *   new_order       — a customer submitted and paid an online order
 *   order_updated   — a dashboard status change was made (e.g. confirmed, ready)
 *   printer_warning — a printer fell back from WebPRNT to Star Graphic raster mode
 *   heartbeat       — sent every 30 s so clients can detect stale connections
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomBytes } from 'node:crypto'
import { authenticate, requireOwnMerchant } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { acquireMerchantEmitter, releaseMerchantEmitter } from '../services/sse'
import type { SSEPayload } from '../services/sse'

const events = new Hono()

// ---------------------------------------------------------------------------
// SSE ticket store — in-memory, 30 s TTL, single-use
// ---------------------------------------------------------------------------

interface SseTicket {
  merchantId: string
  userId: string
  role: string
  expiresAt: number
}

const _sseTickets = new Map<string, SseTicket>()

function generateSseTicket(merchantId: string, userId: string, role: string): string {
  const ticket = randomBytes(24).toString('hex')
  _sseTickets.set(ticket, { merchantId, userId, role, expiresAt: Date.now() + 30_000 })
  return ticket
}

function consumeSseTicket(ticket: string): SseTicket | null {
  const entry = _sseTickets.get(ticket)
  if (!entry) return null
  _sseTickets.delete(ticket) // single-use
  if (Date.now() > entry.expiresAt) return null
  return entry
}

// Periodic cleanup of expired tickets (defensive; consumeSseTicket already deletes on use)
const _ticketCleanupHandle = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _sseTickets) {
    if (now > v.expiresAt) _sseTickets.delete(k)
  }
}, 60_000)

/** Stop the SSE ticket cleanup interval (used in tests and graceful shutdown). */
export function stopSseTicketCleanup(): void {
  clearInterval(_ticketCleanupHandle)
}

// ---------------------------------------------------------------------------
// Ticket issuance — requires normal JWT authentication
// ---------------------------------------------------------------------------

/**
 * POST /api/merchants/:id/sse-ticket
 * Issues a short-lived (30 s) single-use SSE ticket.
 * The client exchanges this ticket for the SSE stream — the JWT never touches a URL.
 */
events.post('/api/merchants/:id/sse-ticket', authenticate, requireOwnMerchant, async (c: AuthContext) => {
  const user       = c.get('user')
  const merchantId = c.req.param('id')
  const ticket     = generateSseTicket(merchantId, user.sub, user.role)
  return c.json({ ticket })
})

// ---------------------------------------------------------------------------
// SSE stream — authenticated via single-use ticket
// ---------------------------------------------------------------------------

/**
 * Maximum lifetime for a single SSE connection.
 *
 * On ungraceful client disconnects (browser crash, network drop), the TCP
 * stack may buffer heartbeat writes so they appear to succeed — leaving the
 * listener attached to the emitter indefinitely.  This ceiling ensures the
 * listener is always reaped within 24 h regardless of TCP state.
 *
 * The browser's built-in EventSource reconnects automatically within ~3 s
 * after the server closes the connection, so the user experience is seamless.
 * 24 h is generous for a restaurant shift (typically 8–12 h).
 */
const MAX_CONNECTION_MS = 24 * 60 * 60_000

events.get('/api/merchants/:id/events', async (c) => {
  const merchantId = c.req.param('id')
  const ticket     = c.req.query('ticket')

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!ticket) {
    return c.json({ error: 'Missing ticket' }, 401)
  }

  const ticketData = consumeSseTicket(ticket)
  if (!ticketData) {
    return c.json({ error: 'Invalid or expired ticket' }, 401)
  }

  if (ticketData.merchantId !== merchantId) {
    return c.json({ error: 'Ticket merchant mismatch' }, 403)
  }

  // ── SSE stream ────────────────────────────────────────────────────────────
  // Disable proxy/CDN response buffering so Cloudflare Tunnel forwards each SSE
  // frame immediately instead of accumulating bytes, which would cause the tunnel
  // to cancel the context after its buffer timeout.
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    // Acquire inside the callback so acquire and release are always paired in
    // the same scope. If streamSSE never calls this function, no acquire occurs.
    const emitter      = acquireMerchantEmitter(merchantId)
    const connectedAt  = Date.now()
    let handler: ((payload: SSEPayload) => void) | null = null
    let done = false

    // Mark stream as done when the client disconnects so the loop exits.
    // Handles graceful disconnects (TCP FIN / browser tab close).
    stream.onAbort(() => { done = true })

    // Forward broadcast events immediately as SSE frames.
    // Write failures (detected errors) set done=true to exit the loop promptly.
    handler = ({ event, data }: SSEPayload) => {
      if (done) return
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => { done = true })
    }

    emitter.on('sse', handler)

    try {
      // Keepalive loop: send a named heartbeat every 30 s so proxies don't
      // close idle connections AND write errors surface ungraceful disconnects.
      //
      // Hard ceiling (MAX_CONNECTION_MS): on TCP-level ungraceful disconnects
      // the kernel may buffer writes so they appear to succeed, meaning write
      // errors never fire.  Capping lifetime at 24 h ensures the listener slot
      // is always reclaimed; EventSource auto-reconnects within ~3 s.
      while (!done && !stream.closed && !stream.aborted) {
        if (Date.now() - connectedAt >= MAX_CONNECTION_MS) break
        await stream.sleep(30_000)
        if (done || stream.closed || stream.aborted) break
        if (Date.now() - connectedAt >= MAX_CONNECTION_MS) break
        await stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => { done = true })
      }
    } finally {
      done = true
      if (handler) emitter.off('sse', handler)
      releaseMerchantEmitter(merchantId, emitter)
    }
  })
})

export { events }
