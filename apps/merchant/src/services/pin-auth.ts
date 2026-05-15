/**
 * Shared employee-PIN authentication helpers.
 *
 * PIN security:
 *   - PINs are SHA-256 hashed with the merchantId as a salt before storage
 *     or comparison; never stored or compared in plaintext.
 *   - Rate limiting:
 *       * Per source IP: max {@link PIN_MAX_ATTEMPTS} failed attempts per
 *         {@link PIN_WINDOW_MS}, returns 429 thereafter.
 *       * Per (merchantId, PIN-hash): max {@link PIN_HASH_MAX_FAILURES}
 *         failures, then the specific PIN is locked for
 *         {@link PIN_HASH_LOCKOUT_MS} regardless of source IP. Defends
 *         against distributed brute-force against a known PIN.
 *   - Successful authentication clears both counters.
 *
 * State is in-memory (per-process Map). Single-merchant appliance == single
 * process, so this is durable enough; a restart resets counters which is
 * acceptable for the threat model.
 */

import { createHash } from 'node:crypto'
import { getDatabase } from '../db/connection'

// ── Constants ─────────────────────────────────────────────────────────────

export const PIN_MAX_ATTEMPTS       = 3
export const PIN_WINDOW_MS          = 10 * 60 * 1000  // 10 minutes
export const PIN_HASH_MAX_FAILURES  = 3
export const PIN_HASH_LOCKOUT_MS    = 30 * 60 * 1000  // 30 minutes

// ── State ──────────────────────────────────────────────────────────────────

interface PinAttemptRecord  { count: number; resetAt: number }
interface PinHashFailRecord { count: number; resetAt: number }

const pinAttempts     = new Map<string, PinAttemptRecord>()    // ip → record
const pinHashFailures = new Map<string, PinHashFailRecord>()   // "mid:hash" → record
const pinHashLockouts = new Map<string, number>()              // "mid:hash" → unlocksAt

// ── Hash ───────────────────────────────────────────────────────────────────

/**
 * Deterministic hash for a 4-digit PIN, scoped to this merchant.
 * SHA-256(merchantId + "::" + code) — prevents cross-merchant code reuse.
 */
export function hashCode(merchantId: string, code: string): string {
  return createHash('sha256').update(`${merchantId}::${code}`).digest('hex')
}

// ── Counters ───────────────────────────────────────────────────────────────

export function isIpLocked(ip: string | null): boolean {
  if (ip === null) return false
  const rec = pinAttempts.get(ip)
  return !!rec && rec.resetAt > Date.now() && rec.count >= PIN_MAX_ATTEMPTS
}

export function recordFailedPin(ip: string | null): void {
  if (ip === null) return
  const now = Date.now()
  const existing = pinAttempts.get(ip)
  if (existing && existing.resetAt > now) {
    existing.count++
  } else {
    pinAttempts.set(ip, { count: 1, resetAt: now + PIN_WINDOW_MS })
  }
}

export function clearIpAttempts(ip: string | null): void {
  if (ip !== null) pinAttempts.delete(ip)
}

export function recordFailedPinHash(merchantId: string, codeHash: string): void {
  const key = `${merchantId}:${codeHash}`
  const now = Date.now()
  const existing = pinHashFailures.get(key)
  let count = 1
  if (existing && existing.resetAt > now) {
    count = existing.count + 1
    existing.count = count
  } else {
    pinHashFailures.set(key, { count: 1, resetAt: now + PIN_WINDOW_MS })
  }
  if (count >= PIN_HASH_MAX_FAILURES) {
    pinHashLockouts.set(key, now + PIN_HASH_LOCKOUT_MS)
  }
}

export function isPinHashLocked(merchantId: string, codeHash: string): boolean {
  const key = `${merchantId}:${codeHash}`
  const unlocksAt = pinHashLockouts.get(key)
  if (!unlocksAt) return false
  if (unlocksAt < Date.now()) {
    pinHashLockouts.delete(key)
    pinHashFailures.delete(key)
    return false
  }
  return true
}

export function clearPinHashFailures(merchantId: string, codeHash: string): void {
  const key = `${merchantId}:${codeHash}`
  pinHashLockouts.delete(key)
  pinHashFailures.delete(key)
}

/** Extract the source IP for rate-limit bucketing. May be null on local LAN. */
export function getRequestIp(headers: {
  cfConnectingIp?: string | null
  xForwardedFor?:  string | null
}): string | null {
  return headers.cfConnectingIp
    ?? headers.xForwardedFor?.split(',')[0]?.trim()
    ?? null
}

// ── High-level verify ──────────────────────────────────────────────────────

export type PinVerifyResult =
  | { ok: true;  employee: { id: string; role: string } }
  | { ok: false; status: 400 | 401 | 429; error: string }

/**
 * Validate a PIN against the merchant's `employees` table, applying rate
 * limits. On success, clears the failure counters; on failure, increments
 * them and returns a structured error.
 *
 * @param opts.allowedRoles - if set, restricts to employees whose role is in
 *   this list (e.g. `['owner','manager']` for manager-only operations).
 */
export function verifyEmployeePin(opts: {
  merchantId:    string
  pin:           string
  ip:            string | null
  allowedRoles?: string[]
}): PinVerifyResult {
  const { merchantId, pin, ip, allowedRoles } = opts

  if (!/^\d{4}$/.test(pin)) {
    return { ok: false, status: 400, error: 'pin must be a 4-digit string' }
  }

  if (isIpLocked(ip)) {
    return { ok: false, status: 429, error: 'Too many PIN attempts. Try again in a few minutes.' }
  }

  const codeHash = hashCode(merchantId, pin)
  if (isPinHashLocked(merchantId, codeHash)) {
    return { ok: false, status: 429, error: 'PIN locked due to too many failed attempts. Try again later.' }
  }

  const db = getDatabase()
  const emp = db
    .query<{ id: string; role: string }, [string, string]>(
      `SELECT id, role FROM employees
       WHERE merchant_id = ? AND access_code_hash = ? AND active = 1`
    )
    .get(merchantId, codeHash)

  if (!emp || (allowedRoles && !allowedRoles.includes(emp.role))) {
    recordFailedPin(ip)
    recordFailedPinHash(merchantId, codeHash)
    return { ok: false, status: 401, error: emp ? 'PIN does not have permission for this action' : 'Invalid PIN' }
  }

  clearIpAttempts(ip)
  clearPinHashFailures(merchantId, codeHash)
  return { ok: true, employee: { id: emp.id, role: emp.role } }
}
