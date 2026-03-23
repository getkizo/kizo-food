/**
 * Authentication routes
 * Handles login, token refresh, and user registration
 */

import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import {
  createAccessToken,
  createRefreshToken,
  verifyJWT,
  extractTokenFromHeader,
  generateSecureToken,
} from '../utils/jwt'
import { logSecurityEvent } from '../services/security-log'
import { serverError } from '../utils/server-error'

const auth = new Hono()

// ---------------------------------------------------------------------------
// Login rate limiter — in-memory, per-IP (max 10 attempts per 15 minutes)
//
// M-12: This is intentionally in-memory. The appliance is a single Bun process
// so a Map is sufficient and zero-overhead. On process restart the counters
// reset — this is acceptable because an attacker would also lose their TCP
// connection and have to re-handshake. If the appliance ever moves to a
// multi-process or clustered deployment, replace with Redis/SQLite counters.
// ---------------------------------------------------------------------------
interface LoginAttemptRecord { count: number; resetAt: number }
const loginAttempts = new Map<string, LoginAttemptRecord>()
const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_WINDOW_MS    = 15 * 60 * 1000  // 15 minutes

function recordFailedLogin(ip: string): void {
  const now = Date.now()
  const existing = loginAttempts.get(ip)
  if (existing && existing.resetAt > now) {
    existing.count++
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
  }
}

/**
 * GET /api/auth/check-email
 * Check if an email address is already registered
 */
auth.get('/api/auth/check-email', (c) => {
  const email = c.req.query('email')
  if (!email) return c.json({ error: 'Missing email parameter' }, 400)

  const db = getDatabase()
  const existing = db.query<{ id: string }, [string]>(`SELECT id FROM users WHERE email = ?`).get(email)
  return c.json({ available: !existing })
})

/**
 * POST /api/auth/register
 * Register a new merchant and owner user
 * Supports both email/password and OAuth registration
 */
auth.post('/api/auth/register', async (c) => {
  try {
    const body = await c.req.json()
    const { email, password, fullName, businessName, slug, provider, providerId } = body

    // Validate input
    if (!email || !fullName || !businessName || !slug) {
      return c.json(
        {
          error:
            'Missing required fields: email, fullName, businessName, slug',
        },
        400
      )
    }

    // For email signup, password is required
    // L-01: Enforce minimum complexity — 8 chars, uppercase, digit, special char
    if (!provider) {
      if (!password || password.length < 8) {
        return c.json({ error: 'Password must be at least 8 characters' }, 400)
      }
      if (!/[A-Z]/.test(password)) {
        return c.json({ error: 'Password must contain at least one uppercase letter' }, 400)
      }
      if (!/[0-9]/.test(password)) {
        return c.json({ error: 'Password must contain at least one number' }, 400)
      }
      if (!/[^A-Za-z0-9]/.test(password)) {
        return c.json({ error: 'Password must contain at least one special character' }, 400)
      }
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return c.json({ error: 'Invalid email format' }, 400)
    }

    // Validate slug format (lowercase, alphanumeric, hyphens only)
    const slugRegex = /^[a-z0-9-]+$/
    if (!slugRegex.test(slug)) {
      return c.json(
        {
          error:
            'Slug must contain only lowercase letters, numbers, and hyphens',
        },
        400
      )
    }

    const db = getDatabase()

    // Check if email already exists
    const existingUser = db
      .query<{ id: string }, [string]>(`SELECT id FROM users WHERE email = ?`)
      .get(email)

    if (existingUser) {
      return c.json({ error: 'Email already registered' }, 400)
    }

    // Check if slug already exists
    const existingMerchant = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM merchants WHERE slug = ?`
      )
      .get(slug)

    if (existingMerchant) {
      return c.json(
        {
          error: 'Slug already taken',
          suggestion: `${slug}-${Date.now().toString(36)}`,
        },
        400
      )
    }

    // Hash password (if provided)
    const passwordHash = password ? await Bun.password.hash(password) : null

    // Generate IDs
    const merchantId = generateId('m')
    const userId = generateId('u')

    // Create merchant
    db.run(
      `INSERT INTO merchants (id, business_name, slug, status, created_at)
       VALUES (?, ?, ?, 'active', datetime('now'))`,
      [merchantId, businessName, slug]
    )

    // Create owner user (with OAuth support)
    db.run(
      `INSERT INTO users (id, merchant_id, email, password_hash, full_name, role, is_active, oauth_provider, oauth_provider_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'owner', 1, ?, ?, datetime('now'))`,
      [userId, merchantId, email, passwordHash, fullName, provider || null, providerId || null]
    )

    // If OAuth registration, create OAuth account record
    if (provider && providerId) {
      const { createOAuthAccount } = await import('./oauth')
      createOAuthAccount(userId, {
        provider,
        providerId,
        email,
        profileData: body.profileData || {},
        accessToken: '',
        refreshToken: null,
        expiresIn: 0,
      })
    }

    // Create tokens
    const accessToken = createAccessToken(userId, merchantId, 'owner')
    const refreshToken = createRefreshToken(userId, merchantId, 'owner')

    // Store refresh token
    await storeRefreshToken(userId, refreshToken)

    console.log(`✅ New merchant registered: ${businessName} (${slug})`)

    return c.json(
      {
        user: {
          id: userId,
          email,
          fullName,
          role: 'owner',
          merchantId,
        },
        merchant: {
          id: merchantId,
          businessName,
          slug,
        },
        tokens: {
          accessToken,
          refreshToken,
        },
      },
      201
    )
  } catch (error) {
    return serverError(c, '[auth] register', error, 'Registration failed')
  }
})

/**
 * POST /api/auth/login
 * Login with email and password
 */
auth.post('/api/auth/login', async (c) => {
  // Rate-limit by IP
  // M-13: IP detection relies on Cloudflare's cf-connecting-ip header (set by
  // the Cloudflare Tunnel in production). Behind other proxies x-forwarded-for
  // is used as fallback but is spoofable if the proxy doesn't strip/overwrite
  // it. In non-Cloudflare environments ensure the reverse proxy sets a trusted
  // header or use Bun's socket address for accurate client IP.
  const ip = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
  const now = Date.now()
  const attempt = loginAttempts.get(ip)
  if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_MAX_ATTEMPTS) {
    logSecurityEvent('login_rate_limited', { ip, path: '/api/auth/login' })
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
  }

  try {
    const body = await c.req.json()
    const { email, password } = body

    if (!email || !password) {
      return c.json({ error: 'Missing email or password' }, 400)
    }

    const db = getDatabase()

    // Find user
    const user = db
      .query<{
        id: string
        merchant_id: string
        email: string
        password_hash: string
        full_name: string
        role: 'owner' | 'manager' | 'staff'
        is_active: number
      }, [string]>(
        `SELECT id, merchant_id, email, password_hash, full_name, role, is_active
         FROM users WHERE email = ?`
      )
      .get(email)

    if (!user) {
      recordFailedLogin(ip)
      logSecurityEvent('login_failed', { ip, path: '/api/auth/login', extra: { reason: 'unknown_email' } })
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    // Check if user is active
    if (user.is_active !== 1) {
      recordFailedLogin(ip)
      logSecurityEvent('login_failed', { ip, userId: user.id, merchantId: user.merchant_id, path: '/api/auth/login', extra: { reason: 'deactivated' } })
      return c.json({ error: 'Account is deactivated' }, 403)
    }

    // Verify password
    const isValid = await Bun.password.verify(password, user.password_hash)

    if (!isValid) {
      recordFailedLogin(ip)
      logSecurityEvent('login_failed', { ip, userId: user.id, merchantId: user.merchant_id, path: '/api/auth/login', extra: { reason: 'wrong_password' } })
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    // Successful login — clear failed attempt counter
    loginAttempts.delete(ip)

    // Create tokens
    const accessToken = createAccessToken(
      user.id,
      user.merchant_id,
      user.role
    )
    const refreshToken = createRefreshToken(
      user.id,
      user.merchant_id,
      user.role
    )

    // Store refresh token
    await storeRefreshToken(user.id, refreshToken)

    // Update last login
    db.run(
      `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`,
      [user.id]
    )

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        merchantId: user.merchant_id,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    })
  } catch (error) {
    return serverError(c, '[auth] login', error, 'Login failed')
  }
})

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
auth.post('/api/auth/refresh', async (c) => {
  try {
    const body = await c.req.json()
    const { refreshToken } = body

    if (!refreshToken) {
      return c.json({ error: 'Missing refresh token' }, 400)
    }

    // Verify refresh token
    let payload
    try {
      payload = verifyJWT(refreshToken)
    } catch (error) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401)
    }

    if (payload.type !== 'refresh') {
      return c.json({ error: 'Invalid token type' }, 401)
    }

    // Check if token is revoked
    const db = getDatabase()
    const tokenHash = createHash('sha256')
      .update(refreshToken)
      .digest('hex')

    const storedToken = db
      .query<{ revoked: number }, [string, string]>(
        `SELECT revoked FROM refresh_tokens WHERE user_id = ? AND token_hash = ?`
      )
      .get(payload.sub, tokenHash)

    if (!storedToken) {
      return c.json({ error: 'Refresh token not found' }, 401)
    }

    if (storedToken.revoked === 1) {
      return c.json({ error: 'Refresh token has been revoked' }, 401)
    }

    // Create new access token
    const accessToken = createAccessToken(
      payload.sub,
      payload.merchantId,
      payload.role
    )

    return c.json({
      accessToken,
    })
  } catch (error) {
    return serverError(c, '[auth] refresh', error, 'Token refresh failed')
  }
})

/**
 * POST /api/auth/logout
 * Revoke refresh token
 */
auth.post('/api/auth/logout', async (c) => {
  try {
    const authHeader = c.req.header('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return c.json({ success: true }) // Already logged out
    }

    const payload = verifyJWT(token)
    const db = getDatabase()

    // Revoke all refresh tokens for this user
    db.run(
      `UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`,
      [payload.sub]
    )

    // L-06: Audit log for session revocation
    logSecurityEvent('user_logout', {
      userId: payload.sub,
      merchantId: payload.merchantId,
      path: '/api/auth/logout',
    })

    return c.json({ success: true })
  } catch (error) {
    console.error('[auth] logout:', error)
    return c.json({ success: true }) // Don't expose errors
  }
})

/**
 * GET /api/auth/me
 * Get current user info
 */
auth.get('/api/auth/me', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = extractTokenFromHeader(authHeader)

  if (!token) {
    return c.json({ error: 'Missing authorization token' }, 401)
  }

  try {
    const payload = verifyJWT(token)

    const db = getDatabase()
    const user = db
      .query<{
        id: string
        merchant_id: string
        email: string
        full_name: string
        role: string
      }, [string]>(
        `SELECT id, merchant_id, email, full_name, role FROM users WHERE id = ?`
      )
      .get(payload.sub)

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    return c.json({
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      merchantId: user.merchant_id,
    })
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401)
  }
})

/**
 * Private: Stores refresh token in database
 */
async function storeRefreshToken(
  userId: string,
  refreshToken: string
): Promise<void> {
  const db = getDatabase()
  const tokenId = generateId('rt')
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex')

  // Calculate expiration — must match the JWT exp (30 days, see createRefreshToken in jwt.ts)
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 30)

  db.run(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [tokenId, userId, tokenHash, expiresAt.toISOString()]
  )

  // Clean up expired tokens
  db.run(
    `DELETE FROM refresh_tokens WHERE expires_at < datetime('now')`
  )
}

/** Clear all rate-limit counters — for use in tests only. */
export function clearLoginRateLimits(): void {
  loginAttempts.clear()
}

export { auth }
