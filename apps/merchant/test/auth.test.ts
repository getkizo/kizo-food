/**
 * Authentication tests
 * Tests JWT utilities, middleware, and auth routes
 */

import { test, expect, describe, beforeAll, beforeEach } from 'bun:test'
import { app } from '../src/server'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { clearLoginRateLimits } from '../src/routes/auth'
import {
  signJWT,
  verifyJWT,
  createAccessToken,
  createRefreshToken,
  extractTokenFromHeader,
  isTokenExpired,
  getTimeUntilExpiry,
} from '../src/utils/jwt'

beforeAll(async () => {
  // Setup test environment
  process.env.DATABASE_PATH = ':memory:'
  process.env.NODE_ENV = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()
})

describe('JWT Utilities', () => {
  test('should sign and verify JWT token', () => {
    const payload = {
      sub: 'u_test123',
      type: 'access' as const,
      role: 'owner' as const,
      merchantId: 'm_test',
    }

    const token = signJWT(payload, 60) // 1 minute
    const verified = verifyJWT(token)

    expect(verified.sub).toBe(payload.sub)
    expect(verified.type).toBe(payload.type)
    expect(verified.role).toBe(payload.role)
    expect(verified.merchantId).toBe(payload.merchantId)
    expect(verified.iat).toBeGreaterThan(0)
    expect(verified.exp).toBeGreaterThan(verified.iat)
  })

  test('should reject invalid JWT signature', () => {
    const token = signJWT(
      {
        sub: 'u_test',
        type: 'access',
        role: 'owner',
        merchantId: 'm_test',
      },
      60
    )

    // Tamper with token
    const parts = token.split('.')
    parts[2] = 'invalid-signature'
    const tamperedToken = parts.join('.')

    expect(() => verifyJWT(tamperedToken)).toThrow('Invalid JWT signature')
  })

  test('should reject expired JWT', () => {
    const token = signJWT(
      {
        sub: 'u_test',
        type: 'access',
        role: 'owner',
        merchantId: 'm_test',
      },
      -60 // Expired 1 minute ago
    )

    expect(() => verifyJWT(token)).toThrow('JWT expired')
  })

  test('should create access token', () => {
    const token = createAccessToken('u_123', 'm_456', 'manager')
    const payload = verifyJWT(token)

    expect(payload.sub).toBe('u_123')
    expect(payload.merchantId).toBe('m_456')
    expect(payload.role).toBe('manager')
    expect(payload.type).toBe('access')
  })

  test('should create refresh token', () => {
    const token = createRefreshToken('u_123', 'm_456', 'staff')
    const payload = verifyJWT(token)

    expect(payload.sub).toBe('u_123')
    expect(payload.type).toBe('refresh')
  })

  test('should extract token from Authorization header', () => {
    const token = 'abc123'
    const header = `Bearer ${token}`

    expect(extractTokenFromHeader(header)).toBe(token)
    expect(extractTokenFromHeader('InvalidFormat')).toBe(null)
    expect(extractTokenFromHeader(undefined)).toBe(null)
  })

  test('should check if token is expired', () => {
    const validToken = signJWT(
      {
        sub: 'u_test',
        type: 'access',
        role: 'owner',
        merchantId: 'm_test',
      },
      60
    )
    const expiredToken = signJWT(
      {
        sub: 'u_test',
        type: 'access',
        role: 'owner',
        merchantId: 'm_test',
      },
      -60
    )

    expect(isTokenExpired(validToken)).toBe(false)
    expect(isTokenExpired(expiredToken)).toBe(true)
    expect(isTokenExpired('invalid')).toBe(true)
  })

  test('should get time until expiry', () => {
    const token = signJWT(
      {
        sub: 'u_test',
        type: 'access',
        role: 'owner',
        merchantId: 'm_test',
      },
      60 // 1 minute
    )

    const timeLeft = getTimeUntilExpiry(token)
    expect(timeLeft).toBeGreaterThan(50)
    expect(timeLeft).toBeLessThanOrEqual(60)
  })
})

describe('Authentication Routes', () => {
  test('should register new merchant and user', async () => {
    const req = new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@test.com',
        password: 'SecurePass123!',
        fullName: 'Test Owner',
        businessName: 'Test Restaurant',
        slug: 'test-restaurant',
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(201)

    const body = await res.json()
    expect(body.user.email).toBe('owner@test.com')
    expect(body.user.role).toBe('owner')
    expect(body.merchant.slug).toBe('test-restaurant')
    expect(body.tokens.accessToken).toBeDefined()
    expect(body.tokens.refreshToken).toBeDefined()
  })

  test('should reject duplicate email', async () => {
    const req = new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@test.com', // Already registered
        password: 'SecurePass123!',
        fullName: 'Another Owner',
        businessName: 'Another Restaurant',
        slug: 'another-restaurant',
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.error).toContain('already registered')
  })

  test('should reject weak password', async () => {
    const req = new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'weak@test.com',
        password: '123', // Too short
        fullName: 'Test User',
        businessName: 'Test Business',
        slug: 'test-business',
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.error).toContain('at least 8 characters')
  })

  test('should login with valid credentials', async () => {
    const req = new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@test.com',
        password: 'SecurePass123!',
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.user.email).toBe('owner@test.com')
    expect(body.tokens.accessToken).toBeDefined()
    expect(body.tokens.refreshToken).toBeDefined()
  })

  test('should reject invalid credentials', async () => {
    const req = new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@test.com',
        password: 'WrongPassword',
      }),
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(401)

    const body = await res.json()
    expect(body.error).toBe('Invalid credentials')
  })

  test('should refresh access token', async () => {
    // First login
    const loginReq = new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@test.com',
        password: 'SecurePass123!',
      }),
    })

    const loginRes = await app.fetch(loginReq)
    const loginBody = await loginRes.json()
    const refreshToken = loginBody.tokens.refreshToken

    // Then refresh
    const refreshReq = new Request('http://localhost:3000/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })

    const refreshRes = await app.fetch(refreshReq)
    expect(refreshRes.status).toBe(200)

    const refreshBody = await refreshRes.json()
    expect(refreshBody.accessToken).toBeDefined()
    expect(refreshBody.accessToken).not.toBe(loginBody.tokens.accessToken)
  })

  test('should get current user info with valid token', async () => {
    // Login first
    const loginReq = new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@test.com',
        password: 'SecurePass123!',
      }),
    })

    const loginRes = await app.fetch(loginReq)
    const loginBody = await loginRes.json()
    const accessToken = loginBody.tokens.accessToken

    // Get user info
    const meReq = new Request('http://localhost:3000/api/auth/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })

    const meRes = await app.fetch(meReq)
    expect(meRes.status).toBe(200)

    const meBody = await meRes.json()
    expect(meBody.email).toBe('owner@test.com')
    expect(meBody.role).toBe('owner')
  })

  test('should logout successfully', async () => {
    // Login first
    const loginReq = new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@test.com',
        password: 'SecurePass123!',
      }),
    })

    const loginRes = await app.fetch(loginReq)
    const loginBody = await loginRes.json()
    const accessToken = loginBody.tokens.accessToken

    // Logout
    const logoutReq = new Request('http://localhost:3000/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })

    const logoutRes = await app.fetch(logoutReq)
    expect(logoutRes.status).toBe(200)

    const logoutBody = await logoutRes.json()
    expect(logoutBody.success).toBe(true)
  })
})

describe('Protected Routes', () => {
  let accessToken: string
  let merchantId: string

  beforeAll(async () => {
    // Register and login to get access token
    const registerReq = new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'protected@test.com',
        password: 'SecurePass123!',
        fullName: 'Protected Test',
        businessName: 'Protected Restaurant',
        slug: 'protected-restaurant',
      }),
    })

    const registerRes = await app.fetch(registerReq)
    const registerBody = await registerRes.json()

    accessToken = registerBody.tokens.accessToken
    merchantId = registerBody.merchant.id
  })

  test('should access protected merchant route with valid token', async () => {
    const req = new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    )

    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.slug).toBe('protected-restaurant')
  })

  test('should reject access without token', async () => {
    const req = new Request(
      `http://localhost:3000/api/merchants/${merchantId}`
    )

    const res = await app.fetch(req)
    expect(res.status).toBe(401)
  })

  test('should reject access to other merchant data', async () => {
    const req = new Request(
      `http://localhost:3000/api/merchants/m_different_merchant`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    )

    const res = await app.fetch(req)
    expect(res.status).toBe(403)

    const body = await res.json()
    expect(body.error).toContain('Access denied')
  })

  test('expired JWT returns 401', async () => {
    const expiredToken = signJWT(
      { sub: 'u_test', type: 'access', role: 'owner', merchantId },
      -60 // expired 1 minute ago
    )

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      { headers: { Authorization: `Bearer ${expiredToken}` } }
    ))
    expect(res.status).toBe(401)
  })

  test('JWT signed for a different merchant returns 403', async () => {
    // Token is valid but its merchantId claim is for a different merchant
    const crossToken = signJWT(
      { sub: 'u_test', type: 'access', role: 'owner', merchantId: 'm_other_merchant' },
      3600
    )

    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}`,
      { headers: { Authorization: `Bearer ${crossToken}` } }
    ))
    expect(res.status).toBe(403)
  })
})

describe('Login rate limiting', () => {
  // Each test in this suite shares the same in-memory DB initialised by auth.test.ts
  // beforeAll. We use a unique email so the rate limiter tracks this IP/user in isolation.
  const rateLimitEmail = 'ratelimit@test.com'

  beforeEach(() => {
    // Reset rate-limit counters before each test so one test's attempts don't
    // bleed into the next (all test requests arrive from IP 'unknown').
    clearLoginRateLimits()
  })

  beforeAll(async () => {
    // Register the user we'll hammer
    await app.fetch(new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:        rateLimitEmail,
        password:     'SecurePass123!',
        fullName:     'Rate Limit Test',
        businessName: 'Rate Limit Cafe',
        slug:         'rate-limit-cafe',
      }),
    }))
  })

  test('11th failed login attempt within window returns 429', async () => {
    // Fire 10 failed attempts to fill the bucket
    for (let i = 0; i < 10; i++) {
      await app.fetch(new Request('http://localhost:3000/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: rateLimitEmail, password: 'WrongPassword' }),
      }))
    }

    // The 11th attempt should be blocked
    const res = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: rateLimitEmail, password: 'WrongPassword' }),
    }))

    expect(res.status).toBe(429)
  })

  test('successful login clears the rate-limit counter', async () => {
    // Use a fresh email so the counter starts clean
    const freshEmail = 'ratelimit-clear@test.com'
    await app.fetch(new Request('http://localhost:3000/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        email:        freshEmail,
        password:     'SecurePass123!',
        fullName:     'Rate Clear Test',
        businessName: 'Rate Clear Cafe',
        slug:         'rate-clear-cafe',
      }),
    }))

    // Fire 5 failed attempts (below the 10-attempt window limit)
    for (let i = 0; i < 5; i++) {
      await app.fetch(new Request('http://localhost:3000/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: freshEmail, password: 'WrongPassword' }),
      }))
    }

    // A successful login should clear the counter and return 200
    const successRes = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: freshEmail, password: 'SecurePass123!' }),
    }))
    expect(successRes.status).toBe(200)

    // Subsequent failed attempt should NOT be rate-limited (counter was cleared)
    const afterSuccessRes = await app.fetch(new Request('http://localhost:3000/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: freshEmail, password: 'WrongPassword' }),
    }))
    expect(afterSuccessRes.status).toBe(401) // not 429
  })
})
