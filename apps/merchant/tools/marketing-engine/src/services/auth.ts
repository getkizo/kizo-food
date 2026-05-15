/**
 * Admin session authentication.
 * Sessions stored in admin_sessions table; cookie value is a ULID.
 * Argon2id via Bun.password (built-in, no native dep needed).
 */

import { ulid } from 'ulid'
import { getDatabase } from '../db/connection'
import type { Context, Next } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'

const SESSION_TTL_MS = 24 * 60 * 60 * 1000   // 24 hours
const COOKIE_NAME    = 'me_session'

// Login rate-limiting: simple in-memory map (resets on restart, fine for Pi)
const _loginAttempts = new Map<string, { count: number; resetAt: number }>()
const LOGIN_LIMIT   = 5
const LOGIN_WINDOW  = 15 * 60 * 1000

export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = _loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    _loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW })
    return true
  }
  entry.count++
  return entry.count <= LOGIN_LIMIT
}

export function clearLoginRateLimit(ip: string): void {
  _loginAttempts.delete(ip)
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash)
}

/** Create a new session and set the session cookie. */
export function createSession(c: Context, userId: number): void {
  const db        = getDatabase()
  const sessionId = ulid()
  const expiresAt = Date.now() + SESSION_TTL_MS

  db.run(
    `INSERT INTO admin_sessions (id, user_id, expires_at) VALUES (?, ?, ?)`,
    [sessionId, userId, expiresAt]
  )

  setCookie(c, COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure:   true,
    sameSite: 'Strict',
    maxAge:   SESSION_TTL_MS / 1000,
    path:     '/',
  })
}

/** Destroy session and clear cookie. */
export function destroySession(c: Context): void {
  const sessionId = getCookie(c, COOKIE_NAME)
  if (sessionId) {
    getDatabase().run(`DELETE FROM admin_sessions WHERE id = ?`, [sessionId])
  }
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}

export type AdminUser = { id: number; email: string; role: string }

/** Validate session cookie and return the user, or null. */
export function getSessionUser(c: Context): AdminUser | null {
  const sessionId = getCookie(c, COOKIE_NAME)
  if (!sessionId) return null

  const db  = getDatabase()
  const now = Date.now()
  const row = db.query<AdminUser & { expires_at: number }, [string, number]>(
    `SELECT u.id, u.email, u.role, s.expires_at
     FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  ).get(sessionId, now)

  return row ? { id: row.id, email: row.email, role: row.role } : null
}

/** Hono middleware: require valid session, redirect to /marketing/login if not. */
export async function requireSession(c: Context, next: Next): Promise<Response | void> {
  const user = getSessionUser(c)
  if (!user) return c.redirect('/marketing/login')
  c.set('adminUser', user)
  await next()
}
