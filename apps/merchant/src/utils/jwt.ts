/**
 * JWT utilities for authentication
 * Uses HS256 (HMAC-SHA256) for signing
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * JWT payload structure
 */
export interface JWTPayload {
  sub: string        // Subject (user/merchant ID)
  jti: string        // JWT ID — random, ensures uniqueness even within the same second
  type: 'access' | 'refresh'
  role: 'owner' | 'manager' | 'staff'
  merchantId: string
  iat: number        // Issued at
  exp: number        // Expiration
}

/**
 * JWT header structure
 */
interface JWTHeader {
  alg: 'HS256'
  typ: 'JWT'
}

/**
 * Gets JWT secret from environment
 */
function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET

  if (!secret) {
    throw new Error(
      'JWT_SECRET environment variable is required. ' +
        'Set it to a secure random string (min 32 characters).'
    )
  }

  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long')
  }

  return secret
}

/**
 * Base64URL encoding (JWT standard)
 */
function base64UrlEncode(data: string | Buffer): string {
  const base64 = Buffer.from(data).toString('base64')
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * Base64URL decoding
 */
function base64UrlDecode(data: string): string {
  // Add padding if needed
  const padded = data + '='.repeat((4 - (data.length % 4)) % 4)
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

/**
 * Signs a JWT token
 */
export function signJWT(payload: Omit<JWTPayload, 'iat' | 'exp' | 'jti'>, expiresIn: number): string {
  const secret = getJWTSecret()

  const header: JWTHeader = {
    alg: 'HS256',
    typ: 'JWT',
  }

  const now = Math.floor(Date.now() / 1000)

  const fullPayload: JWTPayload = {
    ...payload,
    jti: randomBytes(16).toString('hex'), // unique per token — prevents same-second collisions
    iat: now,
    exp: now + expiresIn,
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload))

  const signatureInput = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac('sha256', secret).update(signatureInput).digest()
  const encodedSignature = base64UrlEncode(signature)

  return `${signatureInput}.${encodedSignature}`
}

/**
 * Verifies and decodes a JWT token
 */
export function verifyJWT(token: string): JWTPayload {
  const secret = getJWTSecret()

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts

  // Verify signature — constant-time comparison prevents HMAC timing oracle (SEC-03)
  const signatureInput = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = createHmac('sha256', secret).update(signatureInput).digest()
  const expectedEncodedSignature = base64UrlEncode(expectedSignature)

  const sigBuf = Buffer.from(encodedSignature)
  const expBuf = Buffer.from(expectedEncodedSignature)
  const signaturesMatch = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
  if (!signaturesMatch) {
    throw new Error('Invalid JWT signature')
  }

  // Decode payload
  const payload: JWTPayload = JSON.parse(base64UrlDecode(encodedPayload))

  // Verify expiration
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp < now) {
    throw new Error('JWT expired')
  }

  return payload
}

/**
 * Creates an access token (short-lived)
 */
export function createAccessToken(
  userId: string,
  merchantId: string,
  role: JWTPayload['role']
): string {
  return signJWT(
    {
      sub: userId,
      type: 'access',
      role,
      merchantId,
    },
    24 * 60 * 60 // 24 hours
  )
}

/**
 * Creates a refresh token (long-lived)
 */
export function createRefreshToken(
  userId: string,
  merchantId: string,
  role: JWTPayload['role']
): string {
  return signJWT(
    {
      sub: userId,
      type: 'refresh',
      role,
      merchantId,
    },
    30 * 24 * 60 * 60 // 30 days — reduced from 1 year (H-16); appliance auto-refreshes on each use
  )
}

/**
 * Generates a secure random token (for API keys, etc.)
 */
export function generateSecureToken(length: number = 32): string {
  return randomBytes(length).toString('hex')
}

/**
 * Extracts JWT from Authorization header
 */
export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

/**
 * Checks if a token is expired without throwing
 */
export function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return true
    }

    const payload: JWTPayload = JSON.parse(base64UrlDecode(parts[1]))
    const now = Math.floor(Date.now() / 1000)

    return payload.exp < now
  } catch {
    return true
  }
}

/**
 * Gets time until token expires (in seconds)
 */
export function getTimeUntilExpiry(token: string): number {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return 0
    }

    const payload: JWTPayload = JSON.parse(base64UrlDecode(parts[1]))
    const now = Math.floor(Date.now() / 1000)

    return Math.max(0, payload.exp - now)
  } catch {
    return 0
  }
}
