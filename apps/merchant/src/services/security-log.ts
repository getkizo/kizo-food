/**
 * Security event logging
 *
 * Records security-relevant events (failed logins, auth failures, rate-limit
 * hits, payment errors) into a dedicated `security_events` table for audit
 * and alerting purposes.
 */

import { getDatabase } from '../db/connection'

export type SecurityEventType =
  | 'login_failed'
  | 'login_rate_limited'
  | 'auth_invalid_token'
  | 'auth_expired_token'
  | 'auth_insufficient_role'
  | 'auth_merchant_mismatch'
  | 'webhook_unsigned'
  | 'payment_error'
  | 'refund_error'
  | 'order_invalid_transition'
  | 'webhook_invalid_signature'
  | 'mock_oauth_production'
  | 'user_logout'       // L-06: session revocation audit
  | 'printer_failure'         // L-05: print job failures for merchant diagnostics
  | 'payment_unmatched'       // Finix reconciliation: local payment has no matching transfer

/**
 * Log a security event to the `security_events` table.
 *
 * Designed to never throw — if the DB write fails the error is logged to
 * stderr but the calling request continues uninterrupted.
 */
export function logSecurityEvent(
  eventType: SecurityEventType,
  details: {
    ip?: string
    merchantId?: string
    userId?: string
    path?: string
    extra?: Record<string, unknown>
  } = {},
): void {
  try {
    const db = getDatabase()
    db.run(
      `INSERT INTO security_events (event_type, ip_address, merchant_id, user_id, path, extra, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        eventType,
        details.ip ?? null,
        details.merchantId ?? null,
        details.userId ?? null,
        details.path ?? null,
        details.extra ? JSON.stringify(details.extra) : null,
      ],
    )
  } catch (err) {
    // Never let logging failure disrupt the request
    console.error('[security-log] Failed to write security event:', eventType, err)
  }
}
