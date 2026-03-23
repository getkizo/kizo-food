/**
 * OAuth authentication routes
 * Handles Google, Apple ID, and Facebook social login
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { createAccessToken, createRefreshToken } from '../utils/jwt'
import { mockOAuth } from './oauth-mock'
import { serverError } from '../utils/server-error'
import type { JWTPayload } from '../utils/jwt'

/**
 * Asserts that a DB-sourced role string is a valid JWT role.
 * Throws if the value is outside the allowed set — prevents issuing tokens with
 * unknown roles that would fail type checks downstream.
 */
function assertValidRole(role: string): asserts role is JWTPayload['role'] {
  const VALID_ROLES: JWTPayload['role'][] = ['owner', 'manager', 'staff']
  if (!(VALID_ROLES as string[]).includes(role)) {
    throw new Error(`Invalid user role: ${role}`)
  }
}

const oauth = new Hono()

/** Check if mock OAuth is enabled */
const MOCK_OAUTH_ENABLED = process.env.MOCK_OAUTH === 'true'

// H-10: Refuse to start with MOCK_OAUTH in production
if (MOCK_OAUTH_ENABLED && process.env.NODE_ENV === 'production') {
  console.error('❌ MOCK_OAUTH=true is not allowed in production. Exiting.')
  process.exit(1)
}

/**
 * OAuth Configuration
 * Set these via environment variables
 */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/oauth/google/callback'

const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || ''
const APPLE_CLIENT_SECRET = process.env.APPLE_CLIENT_SECRET || ''
const APPLE_REDIRECT_URI = process.env.APPLE_REDIRECT_URI || 'http://localhost:3000/api/auth/oauth/apple/callback'

const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || ''
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || ''
const FACEBOOK_REDIRECT_URI = process.env.FACEBOOK_REDIRECT_URI || 'http://localhost:3000/api/auth/oauth/facebook/callback'

// Warn at startup when a provider's secret is set but redirect URI still points to localhost,
// indicating likely misconfiguration on a deployed appliance.
function warnIfLocalhostRedirect(provider: string, clientSecret: string, uri: string): void {
  if (clientSecret && uri.includes('localhost')) {
    console.warn(`⚠️  ${provider} OAuth: client secret is set but redirect URI still points to localhost.`)
    console.warn(`   Set ${provider.toUpperCase()}_REDIRECT_URI env var for production.`)
  }
}
warnIfLocalhostRedirect('Google',   GOOGLE_CLIENT_SECRET,  GOOGLE_REDIRECT_URI)
warnIfLocalhostRedirect('Apple',    APPLE_CLIENT_SECRET,   APPLE_REDIRECT_URI)
warnIfLocalhostRedirect('Facebook', FACEBOOK_APP_SECRET,   FACEBOOK_REDIRECT_URI)

/**
 * Check if OAuth provider is configured
 * In mock mode, all providers are considered configured
 */
function isProviderConfigured(provider: 'google' | 'apple' | 'facebook'): boolean {
  if (MOCK_OAUTH_ENABLED) {
    return true // All providers work in mock mode
  }

  switch (provider) {
    case 'google':
      return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== 'your-google-client-id.apps.googleusercontent.com')
    case 'apple':
      return !!(APPLE_CLIENT_ID && APPLE_CLIENT_ID !== 'your.apple.service.id')
    case 'facebook':
      return !!(FACEBOOK_APP_ID && FACEBOOK_APP_ID !== 'your-facebook-app-id')
  }
}

/**
 * GET /api/auth/oauth/config
 * Check which OAuth providers are configured
 */
oauth.get('/api/auth/oauth/config', (c) => {
  return c.json({
    google: isProviderConfigured('google'),
    apple: isProviderConfigured('apple'),
    facebook: isProviderConfigured('facebook'),
    mockMode: MOCK_OAUTH_ENABLED,
  })
})

// Mount mock OAuth routes if enabled
if (MOCK_OAUTH_ENABLED) {
  oauth.route('/', mockOAuth)
}

/**
 * GET /api/auth/oauth/google
 * Initiate Google OAuth flow
 */
oauth.get('/api/auth/oauth/google', (c) => {
  // Skip to mock if enabled (mock routes will handle it)
  if (MOCK_OAUTH_ENABLED) {
    return c.next()
  }

  if (!isProviderConfigured('google')) {
    return c.json({
      error: 'Google OAuth not configured',
      message: 'Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file',
      docs: '/docs/OAUTH-SETUP.md#google-oauth-setup',
    }, 503)
  }

  const scopes = ['openid', 'profile', 'email']
  const state = generateSecureState()
  storeOAuthState(state)

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', scopes.join(' '))
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')

  return c.redirect(authUrl.toString())
})

/**
 * GET /api/auth/oauth/google/callback
 *
 * Google redirects here with ?code=...&state=...
 * We exchange the code server-side, store the result in a short-lived
 * oauth_sessions row (60-second TTL), and redirect the browser to:
 *   /setup?session=<opaque-token>   (existing user → dashboard)
 *   /setup?session=<opaque-token>&onboard=1  (new user → onboarding)
 *
 * The browser then POSTs to /api/auth/oauth/session to redeem the token
 * for real JWTs.  This avoids exposing JWT tokens in the browser URL bar,
 * history, and Referer headers.
 */
oauth.get('/api/auth/oauth/google/callback', async (c) => {
  if (MOCK_OAUTH_ENABLED) {
    return c.next()
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error || !code) {
    return c.redirect(`/setup?error=${encodeURIComponent(error || 'access_denied')}`)
  }

  // M-01: Validate state to prevent CSRF on OAuth callback
  if (!validateOAuthState(state)) {
    return c.redirect('/setup?error=invalid_state')
  }

  try {
    // 1. Exchange code for Google tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text()
      console.error('Google token exchange failed:', err)
      return c.redirect('/setup?error=token_exchange_failed')
    }

    const googleTokens = await tokenResponse.json()

    // 2. Fetch user profile
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${googleTokens.access_token}` },
    })

    if (!userInfoResponse.ok) {
      return c.redirect('/setup?error=userinfo_failed')
    }

    const userInfo = await userInfoResponse.json()

    // 3. Find or create user
    const result = await findOrCreateOAuthUser({
      provider: 'google',
      providerId: userInfo.id,
      email: userInfo.email,
      fullName: userInfo.name,
      profileData: { picture: userInfo.picture, locale: userInfo.locale },
      accessToken: googleTokens.access_token,
      refreshToken: googleTokens.refresh_token ?? null,
      expiresIn: googleTokens.expires_in ?? 3600,
    })

    // 4. Store result in short-lived session row, redirect with opaque token
    const sessionToken = storeOAuthSession(result)

    if (result.existingUser) {
      return c.redirect(`/setup?session=${sessionToken}`)
    } else {
      return c.redirect(`/setup?session=${sessionToken}&onboard=1`)
    }
  } catch (err) {
    console.error('[oauth] Google callback:', err)
    return c.redirect('/setup?error=oauth_failed')
  }
})

/**
 * POST /api/auth/oauth/session
 * Redeem a short-lived oauth session token for real JWTs.
 * The token is single-use and expires after 60 seconds.
 */
oauth.post('/api/auth/oauth/session', async (c) => {
  try {
    const { token } = await c.req.json()
    if (!token) return c.json({ error: 'Missing token' }, 400)

    const result = redeemOAuthSession(token)
    if (!result) return c.json({ error: 'Invalid or expired session' }, 401)

    return c.json(result)
  } catch (err) {
    return serverError(c, '[oauth] session-redeem', err, 'Session redemption failed')
  }
})

/**
 * GET /api/auth/oauth/apple
 * Initiate Apple OAuth flow
 */
oauth.get('/api/auth/oauth/apple', (c) => {
  if (MOCK_OAUTH_ENABLED) {
    return c.next()
  }

  if (!isProviderConfigured('apple')) {
    return c.json({
      error: 'Apple OAuth not configured',
      message: 'Please set APPLE_CLIENT_ID and APPLE_CLIENT_SECRET in your .env file',
      docs: '/docs/OAUTH-SETUP.md#apple-oauth-setup',
    }, 503)
  }

  const scopes = ['name', 'email']
  const state = generateSecureState()
  storeOAuthState(state)

  const authUrl = new URL('https://appleid.apple.com/auth/authorize')
  authUrl.searchParams.set('client_id', APPLE_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', APPLE_REDIRECT_URI)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', scopes.join(' '))
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('response_mode', 'form_post')

  return c.redirect(authUrl.toString())
})

/**
 * POST /api/auth/oauth/apple/callback
 * Handle Apple OAuth callback
 */
oauth.post('/api/auth/oauth/apple/callback', async (c) => {
  if (MOCK_OAUTH_ENABLED) {
    return c.next()
  }

  try {
    const { code, user, state } = await c.req.json()

    if (!code) {
      return c.json({ error: 'Missing authorization code' }, 400)
    }

    // M-01: Validate state if provided (SPA-mediated flow)
    if (state && !validateOAuthState(state)) {
      return c.json({ error: 'Invalid OAuth state' }, 403)
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: APPLE_CLIENT_ID,
        client_secret: APPLE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: APPLE_REDIRECT_URI,
      }),
    })

    if (!tokenResponse.ok) {
      throw new Error('Failed to exchange code for tokens')
    }

    const tokens = await tokenResponse.json()

    // Decode ID token to get user info
    const idToken = tokens.id_token
    const payload = decodeJWT(idToken)

    // Apple only provides name on first sign-in
    const fullName = user?.name
      ? `${user.name.firstName} ${user.name.lastName}`
      : 'Apple User'

    // Find or create user
    const result = await findOrCreateOAuthUser({
      provider: 'apple',
      providerId: payload.sub,
      email: payload.email,
      fullName,
      profileData: {
        isPrivateEmail: payload.is_private_email === 'true',
      },
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    })

    return c.json(result)
  } catch (error) {
    return serverError(c, '[oauth] Apple', error, 'OAuth authentication failed')
  }
})

/**
 * GET /api/auth/oauth/facebook
 * Initiate Facebook OAuth flow
 */
oauth.get('/api/auth/oauth/facebook', (c) => {
  if (MOCK_OAUTH_ENABLED) {
    return c.next()
  }

  if (!isProviderConfigured('facebook')) {
    return c.json({
      error: 'Facebook OAuth not configured',
      message: 'Please set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in your .env file',
      docs: '/docs/OAUTH-SETUP.md#facebook-oauth-setup',
    }, 503)
  }

  const scopes = ['email', 'public_profile']
  const state = generateSecureState()
  storeOAuthState(state)

  const authUrl = new URL('https://www.facebook.com/v18.0/dialog/oauth')
  authUrl.searchParams.set('client_id', FACEBOOK_APP_ID)
  authUrl.searchParams.set('redirect_uri', FACEBOOK_REDIRECT_URI)
  authUrl.searchParams.set('scope', scopes.join(','))
  authUrl.searchParams.set('state', state)

  return c.redirect(authUrl.toString())
})

/**
 * POST /api/auth/oauth/facebook/callback
 * Handle Facebook OAuth callback
 */
oauth.post('/api/auth/oauth/facebook/callback', async (c) => {
  if (MOCK_OAUTH_ENABLED) {
    return c.next()
  }

  try {
    const { code, state } = await c.req.json()

    if (!code) {
      return c.json({ error: 'Missing authorization code' }, 400)
    }

    // M-01: Validate state if provided (SPA-mediated flow)
    if (state && !validateOAuthState(state)) {
      return c.json({ error: 'Invalid OAuth state' }, 403)
    }

    // Exchange code for access token
    const tokenUrl = new URL('https://graph.facebook.com/v18.0/oauth/access_token')
    tokenUrl.searchParams.set('client_id', FACEBOOK_APP_ID)
    tokenUrl.searchParams.set('client_secret', FACEBOOK_APP_SECRET)
    tokenUrl.searchParams.set('redirect_uri', FACEBOOK_REDIRECT_URI)
    tokenUrl.searchParams.set('code', code)

    const tokenResponse = await fetch(tokenUrl.toString())

    if (!tokenResponse.ok) {
      throw new Error('Failed to exchange code for token')
    }

    const tokens = await tokenResponse.json()

    // Get user info
    const userInfoUrl = new URL('https://graph.facebook.com/me')
    userInfoUrl.searchParams.set('fields', 'id,name,email,picture')
    userInfoUrl.searchParams.set('access_token', tokens.access_token)

    const userInfoResponse = await fetch(userInfoUrl.toString())

    if (!userInfoResponse.ok) {
      throw new Error('Failed to fetch user info')
    }

    const userInfo = await userInfoResponse.json()

    // Find or create user
    const result = await findOrCreateOAuthUser({
      provider: 'facebook',
      providerId: userInfo.id,
      email: userInfo.email,
      fullName: userInfo.name,
      profileData: {
        picture: userInfo.picture?.data?.url,
      },
      accessToken: tokens.access_token,
      refreshToken: null,
      expiresIn: tokens.expires_in,
    })

    return c.json(result)
  } catch (error) {
    return serverError(c, '[oauth] Facebook', error, 'OAuth authentication failed')
  }
})

// ---------------------------------------------------------------------------
// OAuth state store — M-01 CSRF protection
// Short-lived (5 min), single-use. Maps state → true.
// ---------------------------------------------------------------------------

const oauthStateStore = new Map<string, number>() // state → expiresAt
const STATE_TTL_MS = 5 * 60_000 // 5 minutes

function storeOAuthState(state: string): void {
  oauthStateStore.set(state, Date.now() + STATE_TTL_MS)
  // Prune expired entries
  for (const [k, exp] of oauthStateStore) {
    if (exp < Date.now()) oauthStateStore.delete(k)
  }
}

function validateOAuthState(state: string | undefined): boolean {
  if (!state) return false
  const exp = oauthStateStore.get(state)
  if (!exp || exp < Date.now()) return false
  oauthStateStore.delete(state) // single-use
  return true
}

// ---------------------------------------------------------------------------
// OAuth session store — short-lived in-memory (single process, single node)
// Stores result of findOrCreateOAuthUser for 60s; redeemed once by the browser.
// ---------------------------------------------------------------------------

type OAuthSessionResult = Awaited<ReturnType<typeof findOrCreateOAuthUser>>

interface OAuthSessionEntry {
  result: OAuthSessionResult
  expiresAt: number
}

const oauthSessionStore = new Map<string, OAuthSessionEntry>()

function storeOAuthSession(result: OAuthSessionResult): string {
  // Generate 32-byte opaque token
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')

  oauthSessionStore.set(token, {
    result,
    expiresAt: Date.now() + 60_000,  // 60 seconds
  })

  // Prune stale entries (keep the Map from growing unbounded on a busy server)
  for (const [k, v] of oauthSessionStore) {
    if (v.expiresAt < Date.now()) oauthSessionStore.delete(k)
  }

  return token
}

function redeemOAuthSession(token: string): any | null {
  const entry = oauthSessionStore.get(token)
  if (!entry || entry.expiresAt < Date.now()) return null
  oauthSessionStore.delete(token)  // single-use
  return entry.result
}

/**
 * Private: Find or create OAuth user
 */
async function findOrCreateOAuthUser(params: {
  provider: 'google' | 'apple' | 'facebook'
  providerId: string
  email: string
  fullName: string
  profileData: any
  accessToken: string
  refreshToken: string | null
  expiresIn: number
}) {
  const db = getDatabase()

  // 1. Check if this exact OAuth identity already exists
  const existingOAuth = db
    .query<{ user_id: string }, [string, string]>(
      `SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?`
    )
    .get(params.provider, params.providerId)

  // 2. If not, check if a user with the same email already exists (email-password account)
  //    Auto-link: add the OAuth identity to their existing account.
  //    This is safe because Google verifies email ownership before issuing a token.
  const emailUser = existingOAuth
    ? null
    : db
        .query<{ id: string; merchant_id: string; email: string; full_name: string; role: string }, [string]>(
          `SELECT id, merchant_id, email, full_name, role FROM users WHERE email = ?`
        )
        .get(params.email)

  const userId = existingOAuth?.user_id ?? emailUser?.id ?? null

  if (userId) {
    // Known user (via OAuth identity or email match) — update/create OAuth link
    if (existingOAuth) {
      updateOAuthAccount(userId, params)
    } else {
      // First Google sign-in for an email-registered account — link it
      createOAuthAccount(userId, params)
    }

    // Fetch full user row
    const user = db
      .query<{ id: string; merchant_id: string; email: string; full_name: string; role: string }, [string]>(
        `SELECT id, merchant_id, email, full_name, role FROM users WHERE id = ?`
      )
      .get(userId)

    if (!user) throw new Error('User not found after OAuth link')

    assertValidRole(user.role)
    const accessToken  = createAccessToken(user.id, user.merchant_id, user.role)
    const refreshToken = createRefreshToken(user.id, user.merchant_id, user.role)

    return {
      existingUser: true,
      tokens: { accessToken, refreshToken },
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        merchantId: user.merchant_id,
      },
    }
  }

  // 3. Brand-new user — return profile data for onboarding
  return {
    existingUser: false,
    provider: params.provider,
    providerId: params.providerId,
    email: params.email,
    fullName: params.fullName,
    profileData: params.profileData,
  }
}

/**
 * Private: Update OAuth account tokens
 */
function updateOAuthAccount(userId: string, params: {
  provider: string
  providerId: string
  accessToken: string
  refreshToken: string | null
  expiresIn: number
}) {
  const db = getDatabase()

  const expiresAt = new Date()
  expiresAt.setSeconds(expiresAt.getSeconds() + params.expiresIn)

  db.run(
    `UPDATE oauth_accounts
     SET access_token = ?,
         refresh_token = ?,
         expires_at = ?,
         updated_at = datetime('now')
     WHERE user_id = ? AND provider = ?`,
    [
      params.accessToken,
      params.refreshToken,
      expiresAt.toISOString(),
      userId,
      params.provider,
    ]
  )
}

/**
 * Private: Create OAuth account record
 */
export function createOAuthAccount(
  userId: string,
  params: {
    provider: string
    providerId: string
    email: string
    profileData: any
    accessToken: string
    refreshToken: string | null
    expiresIn: number
  }
) {
  const db = getDatabase()
  const oauthId = generateId('oauth')

  const expiresAt = new Date()
  expiresAt.setSeconds(expiresAt.getSeconds() + params.expiresIn)

  db.run(
    `INSERT INTO oauth_accounts (
      id, user_id, provider, provider_user_id, email, profile_data,
      access_token, refresh_token, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      oauthId,
      userId,
      params.provider,
      params.providerId,
      params.email,
      JSON.stringify(params.profileData),
      params.accessToken,
      params.refreshToken,
      expiresAt.toISOString(),
    ]
  )
}

/**
 * Private: Generate secure random state for CSRF protection
 */
function generateSecureState(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Decode a JWT payload without cryptographic signature verification.
 *
 * M-14: This is intentionally used only for Apple Sign-In ID tokens that were
 * obtained server-side from Apple's token endpoint via a TLS-authenticated
 * POST (`https://appleid.apple.com/auth/token`). The token's authenticity is
 * guaranteed by the TLS channel — Apple's server would not issue a forged JWT.
 *
 * Do NOT use this function on tokens received directly from untrusted clients.
 * If the Apple flow ever changes to accept the id_token from the client SPA
 * without a server-side exchange, replace this with proper JWKS verification
 * using Apple's published keys at `https://appleid.apple.com/auth/keys`.
 */
function decodeJWT(token: string): any {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT')
  }

  const payload = parts[1]
  const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  return JSON.parse(decoded)
}

export { oauth }
