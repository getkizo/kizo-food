/**
 * Audit logging for security events
 * Tracks API key access, creation, deletion, and failures
 */

import { getDatabase } from '../db/connection'
import type { KeyType } from './api-keys'

export type AuditEvent =
  | 'key_accessed'
  | 'key_created'
  | 'key_updated'
  | 'key_deleted'
  | 'key_failed'
  | 'dek_rotated'
  | 'code_verification_failed'
  | 'file_integrity_failed'

interface AuditLog {
  id: string
  merchantId: string | null
  event: AuditEvent
  keyType: KeyType | null
  provider: string | null
  ipAddress: string | null
  userAgent: string | null
  timestamp: string
}

/**
 * Logs an audit event for API key access
 *
 * @param merchantId - Merchant ID
 * @param event - Event type
 * @param keyType - Key type ('pos' or 'payment')
 * @param provider - Provider name
 * @param ipAddress - Optional IP address
 * @param userAgent - Optional user agent
 */
export function auditKeyAccess(
  merchantId: string,
  event: AuditEvent,
  keyType: KeyType,
  provider: string,
  ipAddress: string | null = null,
  userAgent: string | null = null
): void {
  const db = getDatabase()
  const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

  db.run(
    `INSERT INTO audit_logs (id, merchant_id, event, key_type, provider, ip_address, user_agent, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [id, merchantId, event, keyType, provider, ipAddress, userAgent]
  )
}

/**
 * Logs a security event (code verification, file integrity, etc.)
 *
 * @param event - Event type
 * @param details - Additional details (stored as JSON in merchant_id field)
 */
export function auditSecurityEvent(
  event: AuditEvent,
  details?: Record<string, unknown>
): void {
  const db = getDatabase()
  const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

  db.run(
    `INSERT INTO audit_logs (id, merchant_id, event, timestamp)
     VALUES (?, ?, ?, datetime('now'))`,
    [id, details ? JSON.stringify(details) : null, event]
  )

  // Log to console for immediate visibility
  console.error(`🚨 SECURITY EVENT: ${event}`, details || '')
}

/**
 * Retrieves audit logs for a merchant
 *
 * @param merchantId - Merchant ID
 * @param limit - Maximum number of logs to return
 * @returns Array of audit logs
 */
export function getAuditLogs(merchantId: string, limit: number = 100): AuditLog[] {
  const db = getDatabase()
  const rows = db
    .query<AuditLog, [string, number]>(
      `SELECT id, merchant_id, event, key_type, provider, ip_address, user_agent, timestamp
       FROM audit_logs
       WHERE merchant_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(merchantId, limit)

  return rows
}

/**
 * Retrieves recent security events
 *
 * @param hours - Number of hours to look back
 * @returns Array of security events
 */
export function getRecentSecurityEvents(hours: number = 24): AuditLog[] {
  const db = getDatabase()
  const rows = db
    .query<AuditLog, [AuditEvent[], number]>(
      `SELECT id, merchant_id, event, key_type, provider, ip_address, user_agent, timestamp
       FROM audit_logs
       WHERE event IN (?, ?, ?)
         AND timestamp >= datetime('now', '-' || ? || ' hours')
       ORDER BY timestamp DESC`
    )
    .all(
      ['code_verification_failed', 'file_integrity_failed', 'key_failed'] as AuditEvent[],
      hours
    )

  return rows
}

/**
 * Gets count of failed key access attempts
 *
 * @param merchantId - Merchant ID
 * @param hours - Number of hours to look back
 * @returns Count of failures
 */
export function getFailedAccessCount(merchantId: string, hours: number = 1): number {
  const db = getDatabase()
  const row = db
    .query<{ count: number }, [string, AuditEvent, number]>(
      `SELECT COUNT(*) as count
       FROM audit_logs
       WHERE merchant_id = ?
         AND event = ?
         AND timestamp >= datetime('now', '-' || ? || ' hours')`
    )
    .get(merchantId, 'key_failed' as AuditEvent, hours)

  return row?.count ?? 0
}

/**
 * Cleans up old audit logs (older than retention period)
 *
 * @param retentionDays - Number of days to retain logs
 * @returns Number of logs deleted
 */
export function cleanupOldLogs(retentionDays: number = 90): number {
  const db = getDatabase()
  const result = db.run(
    `DELETE FROM audit_logs
     WHERE timestamp < datetime('now', '-' || ? || ' days')`,
    [retentionDays]
  )

  const deletedCount = result.changes
  if (deletedCount > 0) {
    console.log(`✅ Cleaned up ${deletedCount} audit logs older than ${retentionDays} days`)
  }

  return deletedCount
}
