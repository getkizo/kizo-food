/**
 * Request rate counter — 60-second sliding window.
 *
 * Single-process in-memory counter. Records one timestamp per incoming request
 * and reports how many occurred in the last 60 seconds.  Timestamps older than
 * the window are pruned lazily (on read and when the buffer grows large) to
 * keep memory usage bounded without a background timer.
 */

const WINDOW_MS = 60_000
/** Circular buffer of request timestamps (Unix ms). */
const _timestamps: number[] = []

/** Record one incoming HTTP request. Call from Hono middleware. */
export function recordRequest(): void {
  _timestamps.push(Date.now())
  // Prune eagerly when the buffer exceeds ~2 min of heavy traffic
  if (_timestamps.length > 4000) _pruneOld(Date.now())
}

/** Return the number of requests recorded in the last 60 seconds. */
export function getReqPerMin(): number {
  const now = Date.now()
  _pruneOld(now)
  return _timestamps.length
}

function _pruneOld(now: number): void {
  const cutoff = now - WINDOW_MS
  let i = 0
  while (i < _timestamps.length && _timestamps[i] < cutoff) i++
  if (i > 0) _timestamps.splice(0, i)
}
