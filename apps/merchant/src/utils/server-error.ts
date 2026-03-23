/**
 * Centralised 5xx response helper.
 *
 * Logs the real error internally and returns a generic message to the client
 * so that internal topology, SQL schema hints, and library versions are never
 * exposed in HTTP response bodies.
 */
import type { Context } from 'hono'
import { pushError } from './system-monitor'

/**
 * Log `err` under `label` and respond with a generic 500/502 message.
 *
 * @param c     Hono context
 * @param label Short prefix for the log line, e.g. `'[store] payment session'`
 * @param err   The caught error value
 * @param msg   Human-readable message returned to the client (default: `'Internal server error'`)
 * @param status HTTP status code (default: 500)
 */
export function serverError(
  c: Context,
  label: string,
  err: unknown,
  msg = 'Internal server error',
  status: 500 | 502 | 503 = 500,
): Response {
  const errMsg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`${label}:`, err)
  pushError(`${label}: ${errMsg}`)
  return c.json({ error: msg }, status)
}
