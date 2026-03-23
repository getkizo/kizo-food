/**
 * Server-Sent Events (SSE) broadcaster
 *
 * Uses Node's EventEmitter as an in-process pub/sub bus.
 * One emitter is created per merchant on first connect and destroyed when the
 * last connected dashboard tab disconnects.
 *
 * ## Connection lifetime
 * Each dashboard tab opens a persistent GET /api/merchants/:id/events stream.
 * The browser's built-in EventSource API reconnects automatically after ~3 seconds
 * whenever the connection drops (server restart, network hiccup, idle timeout).
 * The server does NOT send keepalive pings — SSE streams are kept alive by Bun's
 * async generator and the browser handles reconnection without server involvement.
 * On reconnect the client re-registers its SSE stream; the emitter refCount
 * increments again and any in-flight events are re-sent from the order store.
 *
 * ## Reconnect behaviour
 * Browser EventSource:
 *   - Reconnects after ~3 s on any non-200 or connection-closed event.
 *   - Does NOT reconnect on HTTP 204 or when `.close()` is called explicitly.
 *   - Sends `Last-Event-ID` header if the server sets `id:` on events (we do not).
 *
 * ## Reference counting
 * Each open tab calls acquireMerchantEmitter (refCount++).
 * Each closed tab calls releaseMerchantEmitter (refCount--).
 * The emitter is GC'd when refCount reaches 0 (all tabs closed / navigated away).
 * High-water mark: a console.warn fires when total concurrent connections > 50.
 *
 * Usage:
 *   acquireMerchantEmitter(merchantId)           — called when a client connects
 *   releaseMerchantEmitter(merchantId, emitter)  — called when the client disconnects
 *   broadcastToMerchant(merchantId, event, data) — called from order/payment handlers
 */

import { EventEmitter } from 'node:events'

/** Shape of every event pushed through the emitter. */
export interface SSEPayload {
  event: string
  data: unknown
}

/** Internal registry: merchantId → { emitter, refCount } */
const registry = new Map<string, { emitter: EventEmitter; refCount: number }>()

/**
 * Acquire the emitter for a merchant, creating it if needed.
 * Increments the reference count so the emitter is kept alive while
 * at least one dashboard tab is connected.
 */
export function acquireMerchantEmitter(merchantId: string): EventEmitter {
  if (!registry.has(merchantId)) {
    const emitter = new EventEmitter()
    emitter.setMaxListeners(0) // 0 = unlimited; reference counting via acquireMerchantEmitter manages lifecycle
    registry.set(merchantId, { emitter, refCount: 0 })
  }
  registry.get(merchantId)!.refCount++

  // High-water mark: warn when total concurrent SSE connections across all merchants is high.
  // Each registered merchant contributes its refCount (active tabs) to the total.
  const totalConnections = [...registry.values()].reduce((sum, e) => sum + e.refCount, 0)
  if (totalConnections > 50) {
    console.warn(`[sse] High-water mark: ${totalConnections} concurrent SSE connections across ${registry.size} merchants`)
  }

  return registry.get(merchantId)!.emitter
}

/**
 * Release the emitter reference when a client disconnects.
 * Removes the emitter from the registry when no tabs remain.
 */
export function releaseMerchantEmitter(merchantId: string, emitter: EventEmitter): void {
  const entry = registry.get(merchantId)
  if (!entry || entry.emitter !== emitter) return
  entry.refCount--
  if (entry.refCount <= 0) registry.delete(merchantId)
}

/**
 * Send an event to all connected SSE clients for a merchant.
 * Synchronous fire-and-forget — individual stream writes are handled
 * asynchronously by each client's event listener.
 */
export function broadcastToMerchant(merchantId: string, event: string, data: unknown): void {
  registry.get(merchantId)?.emitter.emit('sse', { event, data } satisfies SSEPayload)
}
