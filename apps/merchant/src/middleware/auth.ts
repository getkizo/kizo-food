/**
 * Authentication middleware for Hono — JWT verification and role-based access control.
 *
 * ── SINGLE-MERCHANT APPLIANCE ──────────────────────────────────────────────
 * The `merchant_id` field in the JWT payload is the merchant's stable UUID.
 * It exists so that:
 *   • `requireOwnMerchant` can verify the caller owns the resource they're
 *     accessing (e.g. their own /api/merchants/:id endpoints).
 *   • External platforms (delivery apps, analytics) can reference the merchant
 *     by a stable, portable identifier.
 *
 * It is NOT a tenant discriminator for multi-tenant query isolation.
 * There is exactly one merchant per appliance — all data in the DB belongs to
 * that merchant. Code reviews should NOT flag the absence of per-query tenant
 * filters as a security gap; the whole DB is already scoped to one tenant.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { Context, Next } from 'hono'
import { verifyJWT, extractTokenFromHeader, type JWTPayload } from '../utils/jwt'
import { logSecurityEvent } from '../services/security-log'

/**
 * Extended context with user information
 */
export type AuthContext = Context<{
  Variables: {
    user: JWTPayload
    merchantId: string
    userId: string
    ipAddress?: string
  }
}>

/**
 * Authentication middleware
 * Verifies JWT token and attaches user to context
 */
export async function authenticate(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  const token = extractTokenFromHeader(authHeader)

  if (!token) {
    return c.json({ error: 'Missing authorization token' }, 401)
  }

  try {
    const payload = verifyJWT(token)

    // Verify it's an access token
    if (payload.type !== 'access') {
      return c.json({ error: 'Invalid token type' }, 401)
    }

    // Attach user to context
    c.set('user', payload)
    c.set('userId', payload.sub)
    c.set('merchantId', payload.merchantId)

    await next()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid token'
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? undefined

    if (message.includes('expired')) {
      logSecurityEvent('auth_expired_token', { ip, path: c.req.path })
      return c.json({ error: 'Token expired', code: 'TOKEN_EXPIRED' }, 401)
    }

    logSecurityEvent('auth_invalid_token', { ip, path: c.req.path })
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401)
  }
}

/**
 * Optional authentication middleware
 * Attaches user if token is valid, but doesn't require it
 */
export async function optionalAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  const token = extractTokenFromHeader(authHeader)

  if (token) {
    try {
      const payload = verifyJWT(token)

      if (payload.type === 'access') {
        c.set('user', payload)
        c.set('userId', payload.sub)
        c.set('merchantId', payload.merchantId)
      }
    } catch {
      // Invalid/expired token - continue without user
    }
  }

  await next()
}

/**
 * Role-based access control middleware
 */
export function requireRole(...allowedRoles: JWTPayload['role'][]) {
  return async (c: AuthContext, next: Next) => {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    if (!allowedRoles.includes(user.role)) {
      const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? undefined
      logSecurityEvent('auth_insufficient_role', { ip, userId: user.sub, merchantId: user.merchantId, path: c.req.path, extra: { required: allowedRoles, current: user.role } })
      return c.json({ error: 'Insufficient permissions' }, 403)
    }

    await next()
  }
}

/**
 * Merchant ownership middleware
 * Ensures user can only access their own merchant's data
 */
export async function requireOwnMerchant(c: AuthContext, next: Next) {
  const user = c.get('user')
  const requestedMerchantId = c.req.param('merchantId') ?? c.req.param('id')

  if (!user) {
    return c.json({ error: 'Authentication required' }, 401)
  }

  // Deny-by-default: if no recognised route parameter carries a merchant ID
  // the middleware was applied to a route with an unexpected parameter name.
  // Fail closed rather than silently bypassing the ownership check.
  if (requestedMerchantId === undefined) {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? undefined
    console.warn('[auth] requireOwnMerchant: no merchant ID parameter on path', c.req.path,
      '— denying. Route should use :merchantId or :id.')
    logSecurityEvent('auth_merchant_mismatch', { ip, userId: user.sub, merchantId: user.merchantId, path: c.req.path, extra: { requestedMerchantId: null } })
    return c.json({ error: 'Access denied', message: 'Merchant context required' }, 403)
  }

  if (user.merchantId !== requestedMerchantId) {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? undefined
    logSecurityEvent('auth_merchant_mismatch', { ip, userId: user.sub, merchantId: user.merchantId, path: c.req.path, extra: { requestedMerchantId } })
    return c.json(
      {
        error: 'Access denied',
        message: 'You can only access your own merchant data',
      },
      403
    )
  }

  await next()
}

/**
 * Combines authentication and role check
 */
export function requireAuth(
  roles?: JWTPayload['role'][],
  options?: {
    requireOwnMerchant?: boolean
  }
) {
  return async (c: Context, next: Next) => {
    // First authenticate
    const authResult = await authenticate(c, async () => {})

    if (authResult instanceof Response) {
      return authResult
    }

    // Then check role if specified
    if (roles && roles.length > 0) {
      const roleResult = await requireRole(...roles)(c as AuthContext, async () => {})

      if (roleResult instanceof Response) {
        return roleResult
      }
    }

    // Check merchant ownership if required
    if (options?.requireOwnMerchant) {
      const ownershipResult = await requireOwnMerchant(c as AuthContext, async () => {})

      if (ownershipResult instanceof Response) {
        return ownershipResult
      }
    }

    await next()
  }
}
