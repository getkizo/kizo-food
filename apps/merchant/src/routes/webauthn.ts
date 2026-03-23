/**
 * WebAuthn routes — passkey / fingerprint login
 *
 * Implements WebAuthn Level 2 (W3C) using only Node.js built-in crypto.
 * No external library required — @noble/ed25519 already in dependencies.
 *
 * Flow — Registration (adding a passkey to an existing account):
 *   1. POST /api/auth/webauthn/register/options  → challenge + rp + user info
 *   2. Authenticator creates key pair, signs challenge
 *   3. POST /api/auth/webauthn/register/verify   → verify + store credential
 *
 * Flow — Authentication (login with passkey):
 *   1. POST /api/auth/webauthn/authenticate/options → challenge
 *   2. Authenticator signs challenge with stored key
 *   3. POST /api/auth/webauthn/authenticate/verify  → verify + issue JWT
 *
 * COSE key parsing supports:
 *   - Algorithm -7  (ES256, P-256)  — Touch ID, Face ID, Android biometrics
 *   - Algorithm -257 (RS256, RSA)   — Windows Hello, some security keys
 *   - Algorithm -8  (EdDSA, Ed25519) — FIDO2 security keys
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { createVerify, createPublicKey, randomBytes } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { createAccessToken, createRefreshToken, extractTokenFromHeader, verifyJWT } from '../utils/jwt'
import { serverError } from '../utils/server-error'

const webauthn = new Hono()

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RP_NAME = 'Kizo Register'
const CHALLENGE_TTL_MS = 5 * 60 * 1000  // 5 minutes

/**
 * The expected WebAuthn RP ID, pinned at startup from the environment.
 * Set WEBAUTHN_EXPECTED_DOMAIN to the bare hostname (e.g. "hanuman-thai-cafe-kirkland.kizo.app").
 * When set, getRpId/getOrigin ignore client-supplied Host/Origin headers entirely.
 * When absent (local dev), the headers are used as before.
 */
const EXPECTED_DOMAIN = process.env.WEBAUTHN_EXPECTED_DOMAIN?.trim() || null

function getRpId(_c: Context): string {
  if (EXPECTED_DOMAIN) return EXPECTED_DOMAIN
  // Dev fallback: derive from Host header (acceptable on localhost; Cloudflare
  // Tunnel guarantees the real hostname in production when EXPECTED_DOMAIN is set).
  const host = _c.req.header('host') || 'localhost'
  return host.split(':')[0]
}

function getOrigin(_c: Context): string {
  if (EXPECTED_DOMAIN) return `https://${EXPECTED_DOMAIN}`
  // Dev fallback: trust Origin/Host headers only when no domain is pinned.
  const origin = _c.req.header('origin')
  if (origin) return origin
  const host = _c.req.header('host') || 'localhost:3000'
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  return `${proto}://${host}`
}

// ---------------------------------------------------------------------------
// Registration — options
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/webauthn/register/options
 * Generates a registration challenge for the authenticated user.
 * Requires: JWT in Authorization header (user must already be logged in).
 */
webauthn.post('/api/auth/webauthn/register/options', async (c) => {
  const token = extractTokenFromHeader(c.req.header('Authorization'))
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload: any
  try { payload = verifyJWT(token) } catch { return c.json({ error: 'Invalid token' }, 401) }

  const db = getDatabase()
  const user = db.query<{ id: string; email: string; full_name: string }, [string]>(
    `SELECT id, email, full_name FROM users WHERE id = ?`
  ).get(payload.sub)
  if (!user) return c.json({ error: 'User not found' }, 404)

  // Generate random challenge
  const challenge = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()

  // Store challenge (clean up expired ones first)
  db.run(`DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')`)
  db.run(
    `INSERT INTO webauthn_challenges (id, challenge, user_id, type, expires_at)
     VALUES (?, ?, ?, 'registration', ?)`,
    [generateId('wch'), challenge, user.id, expiresAt]
  )

  // Get existing credentials to exclude (prevent re-registering same authenticator)
  const existing = db.query<{ credential_id: string; transports: string | null }, [string]>(
    `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?`
  ).all(user.id)

  const rpId = getRpId(c)

  return c.json({
    challenge,
    rp: { name: RP_NAME, id: rpId },
    user: {
      id: Buffer.from(user.id).toString('base64url'),
      name: user.email,
      displayName: user.full_name,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },    // ES256 (P-256) — Touch ID, Face ID
      { alg: -257, type: 'public-key' },  // RS256 — Windows Hello
      { alg: -8, type: 'public-key' },    // EdDSA — security keys
    ],
    timeout: 60000,
    attestation: 'none',                  // We don't need attestation for this use case
    authenticatorSelection: {
      authenticatorAttachment: 'platform', // Built-in (Touch ID / Face ID / Windows Hello)
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'required',        // Requires biometric or PIN
    },
    excludeCredentials: existing.map((cred) => ({
      id: cred.credential_id,
      type: 'public-key',
      transports: cred.transports ? JSON.parse(cred.transports) : [],
    })),
  })
})

// ---------------------------------------------------------------------------
// Registration — verify
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/webauthn/register/verify
 * Verifies the authenticator's registration response and stores the credential.
 *
 * Body: {
 *   id: string           — credential ID (base64url)
 *   rawId: string        — credential ID (base64url)
 *   response: {
 *     attestationObject: string  — base64url
 *     clientDataJSON: string     — base64url
 *   }
 *   type: 'public-key'
 *   deviceLabel?: string         — optional label ("Kitchen iPad")
 * }
 */
webauthn.post('/api/auth/webauthn/register/verify', async (c) => {
  const token = extractTokenFromHeader(c.req.header('Authorization'))
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload: any
  try { payload = verifyJWT(token) } catch { return c.json({ error: 'Invalid token' }, 401) }

  const body = await c.req.json()
  const { id: credentialId, response: authResponse, deviceLabel } = body

  if (!credentialId || !authResponse?.attestationObject || !authResponse?.clientDataJSON) {
    return c.json({ error: 'Missing credential data' }, 400)
  }

  try {
    // 1. Parse and verify clientDataJSON
    const clientData = JSON.parse(
      Buffer.from(authResponse.clientDataJSON, 'base64url').toString('utf8')
    )

    if (clientData.type !== 'webauthn.create') {
      return c.json({ error: 'Invalid clientData type' }, 400)
    }

    const expectedOrigin = getOrigin(c)
    if (clientData.origin !== expectedOrigin) {
      return c.json({ error: `Origin mismatch: got ${clientData.origin}` }, 400)
    }

    // 2. Validate challenge
    const db = getDatabase()
    const storedChallenge = db.query<{ id: string; user_id: string }, [string, string]>(
      `SELECT id, user_id FROM webauthn_challenges
       WHERE challenge = ? AND user_id = ? AND type = 'registration'
         AND expires_at > datetime('now')`
    ).get(clientData.challenge, payload.sub)

    if (!storedChallenge) {
      return c.json({ error: 'Invalid or expired challenge' }, 400)
    }

    // 3. Parse attestationObject (CBOR-encoded)
    const { authData } = parseCbor(
      Buffer.from(authResponse.attestationObject, 'base64url')
    )
    if (!authData) return c.json({ error: 'Missing authData' }, 400)

    // 4. Parse authenticatorData
    const authDataBuf = Buffer.from(authData)
    const rpIdHash = authDataBuf.slice(0, 32)
    const flags = authDataBuf[32]
    const userPresent = !!(flags & 0x01)
    const userVerified = !!(flags & 0x04)
    const attestedCredData = !!(flags & 0x40)

    if (!userPresent || !userVerified) {
      return c.json({ error: 'User presence/verification required' }, 400)
    }

    if (!attestedCredData) {
      return c.json({ error: 'No attested credential data' }, 400)
    }

    // Verify RP ID hash
    const { createHash } = await import('node:crypto')
    const rpId = getRpId(c)
    const expectedRpIdHash = createHash('sha256').update(rpId).digest()
    if (!rpIdHash.equals(expectedRpIdHash)) {
      return c.json({ error: 'RP ID hash mismatch' }, 400)
    }

    // 5. Extract credential ID and public key from authData
    // authData layout: rpIdHash(32) + flags(1) + signCount(4) + aaguid(16) + credIdLen(2) + credId + coseKey
    let offset = 37  // after rpIdHash + flags + signCount
    const aaguid = authDataBuf.slice(offset, offset + 16)
    offset += 16
    const credIdLen = authDataBuf.readUInt16BE(offset)
    offset += 2
    const extractedCredId = authDataBuf.slice(offset, offset + credIdLen).toString('base64url')
    offset += credIdLen
    const cosePublicKey = authDataBuf.slice(offset).toString('base64url')

    if (extractedCredId !== credentialId) {
      return c.json({ error: 'Credential ID mismatch' }, 400)
    }

    // 6. Store credential (delete challenge first)
    db.run(`DELETE FROM webauthn_challenges WHERE id = ?`, [storedChallenge.id])
    db.run(
      `INSERT OR REPLACE INTO webauthn_credentials
       (id, user_id, credential_id, public_key, sign_count, transports, device_label, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, datetime('now'))`,
      [
        generateId('wc'),
        payload.sub,
        credentialId,
        cosePublicKey,
        JSON.stringify(body.response?.transports || []),
        deviceLabel || null,
      ]
    )

    console.log(`✅ WebAuthn credential registered for user ${payload.sub}`)
    return c.json({ verified: true })
  } catch (err) {
    return serverError(c, '[webauthn] register', err, 'Registration failed')
  }
})

// ---------------------------------------------------------------------------
// Authentication — options
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/webauthn/authenticate/options
 * Generates an authentication challenge.
 * Body: { email?: string }  — optional, to narrow credential list
 */
webauthn.post('/api/auth/webauthn/authenticate/options', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { email } = body

  const db = getDatabase()
  const challenge = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()

  // Look up credentials for this user (if email provided)
  let allowCredentials: any[] = []
  if (email) {
    const user = db.query<{ id: string }, [string]>(
      `SELECT id FROM users WHERE email = ? AND is_active = 1`
    ).get(email)
    if (user) {
      const creds = db.query<{ credential_id: string; transports: string | null }, [string]>(
        `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?`
      ).all(user.id)
      allowCredentials = creds.map((c) => ({
        id: c.credential_id,
        type: 'public-key',
        transports: c.transports ? JSON.parse(c.transports) : [],
      }))

      // Store challenge linked to user for faster verification
      db.run(`DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')`)
      db.run(
        `INSERT INTO webauthn_challenges (id, challenge, user_id, type, expires_at)
         VALUES (?, ?, ?, 'authentication', ?)`,
        [generateId('wch'), challenge, user.id, expiresAt]
      )
    }
  }

  if (!email || allowCredentials.length === 0) {
    // Discoverable credential flow — no email required
    db.run(`DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')`)
    db.run(
      `INSERT INTO webauthn_challenges (id, challenge, user_id, type, expires_at)
       VALUES (?, ?, NULL, 'authentication', ?)`,
      [generateId('wch'), challenge, expiresAt]
    )
  }

  return c.json({
    challenge,
    timeout: 60000,
    rpId: getRpId(c),
    allowCredentials,
    userVerification: 'required',
  })
})

// ---------------------------------------------------------------------------
// Authentication — verify
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/webauthn/authenticate/verify
 * Verifies the authenticator assertion and issues JWT tokens.
 *
 * Body: {
 *   id: string
 *   rawId: string
 *   response: {
 *     authenticatorData: string  — base64url
 *     clientDataJSON: string     — base64url
 *     signature: string          — base64url
 *     userHandle?: string        — base64url (user ID if resident key)
 *   }
 *   type: 'public-key'
 * }
 */
webauthn.post('/api/auth/webauthn/authenticate/verify', async (c) => {
  const body = await c.req.json()
  const { id: credentialId, response: authResponse } = body

  if (!credentialId || !authResponse?.authenticatorData || !authResponse?.clientDataJSON || !authResponse?.signature) {
    return c.json({ error: 'Missing authentication data' }, 400)
  }

  const db = getDatabase()

  try {
    // 1. Parse clientDataJSON
    const clientData = JSON.parse(
      Buffer.from(authResponse.clientDataJSON, 'base64url').toString('utf8')
    )
    if (clientData.type !== 'webauthn.get') {
      return c.json({ error: 'Invalid clientData type' }, 400)
    }

    const expectedOrigin = getOrigin(c)
    if (clientData.origin !== expectedOrigin) {
      return c.json({ error: 'Origin mismatch' }, 400)
    }

    // 2. Validate challenge
    const storedChallenge = db.query<{ id: string; user_id: string | null }, [string]>(
      `SELECT id, user_id FROM webauthn_challenges
       WHERE challenge = ? AND type = 'authentication' AND expires_at > datetime('now')`
    ).get(clientData.challenge)

    if (!storedChallenge) {
      return c.json({ error: 'Invalid or expired challenge' }, 400)
    }

    // 3. Look up credential
    const cred = db.query<{
      id: string; user_id: string; public_key: string; sign_count: number
    }, [string]>(
      `SELECT id, user_id, public_key, sign_count FROM webauthn_credentials WHERE credential_id = ?`
    ).get(credentialId)

    if (!cred) return c.json({ error: 'Credential not found' }, 401)

    // If challenge was user-specific, verify it matches
    if (storedChallenge.user_id && storedChallenge.user_id !== cred.user_id) {
      return c.json({ error: 'Credential / challenge user mismatch' }, 401)
    }

    // 4. Verify authenticatorData
    const authDataBuf = Buffer.from(authResponse.authenticatorData, 'base64url')
    const rpIdHash = authDataBuf.slice(0, 32)
    const flags = authDataBuf[32]
    const signCount = authDataBuf.readUInt32BE(33)

    const { createHash } = await import('node:crypto')
    const rpId = getRpId(c)
    const expectedRpIdHash = createHash('sha256').update(rpId).digest()
    if (!rpIdHash.equals(expectedRpIdHash)) {
      return c.json({ error: 'RP ID hash mismatch' }, 400)
    }

    const userPresent = !!(flags & 0x01)
    const userVerified = !!(flags & 0x04)
    if (!userPresent || !userVerified) {
      return c.json({ error: 'User presence/verification required' }, 400)
    }

    // Sign count must be greater than stored (replay attack prevention)
    // Exception: signCount = 0 means authenticator doesn't support it (allow)
    if (signCount > 0 && signCount <= cred.sign_count) {
      return c.json({ error: 'Sign count invalid — possible cloned authenticator' }, 401)
    }

    // 5. Verify signature
    const clientDataHash = createHash('sha256')
      .update(Buffer.from(authResponse.clientDataJSON, 'base64url'))
      .digest()
    const signedData = Buffer.concat([authDataBuf, clientDataHash])
    const signature = Buffer.from(authResponse.signature, 'base64url')

    const isValid = await verifyCoseSignature(cred.public_key, signedData, signature)
    if (!isValid) return c.json({ error: 'Signature verification failed' }, 401)

    // 6. Update sign count and last used
    db.run(
      `UPDATE webauthn_credentials SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?`,
      [signCount, cred.id]
    )
    db.run(`DELETE FROM webauthn_challenges WHERE id = ?`, [storedChallenge.id])

    // 7. Load user and issue JWT tokens
    const user = db.query<{
      id: string; merchant_id: string; email: string; full_name: string
      role: 'owner' | 'manager' | 'staff'; is_active: number
    }, [string]>(
      `SELECT id, merchant_id, email, full_name, role, is_active FROM users WHERE id = ?`
    ).get(cred.user_id)

    if (!user || user.is_active !== 1) {
      return c.json({ error: 'Account not found or deactivated' }, 401)
    }

    db.run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, [user.id])

    const accessToken = createAccessToken(user.id, user.merchant_id, user.role)
    const refreshToken = createRefreshToken(user.id, user.merchant_id, user.role)

    // Store refresh token
    const { createHash: hash } = await import('node:crypto')
    const tokenHash = hash('sha256').update(refreshToken).digest('hex')
    const tokenId = generateId('rt')
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)
    db.run(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
      [tokenId, user.id, tokenHash, expiresAt.toISOString()]
    )

    console.log(`✅ WebAuthn login: ${user.email}`)

    return c.json({
      verified: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        merchantId: user.merchant_id,
      },
      tokens: { accessToken, refreshToken },
    })
  } catch (err) {
    return serverError(c, '[webauthn] authenticate', err, 'Authentication failed')
  }
})

// ---------------------------------------------------------------------------
// Credential management
// ---------------------------------------------------------------------------

/**
 * GET /api/auth/webauthn/credentials
 * List registered passkeys for the authenticated user.
 */
webauthn.get('/api/auth/webauthn/credentials', async (c) => {
  const token = extractTokenFromHeader(c.req.header('Authorization'))
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  let payload: any
  try { payload = verifyJWT(token) } catch { return c.json({ error: 'Invalid token' }, 401) }

  const db = getDatabase()
  const creds = db.query<{
    id: string; credential_id: string; device_label: string | null
    created_at: string; last_used_at: string | null
  }, [string]>(
    `SELECT id, credential_id, device_label, created_at, last_used_at
     FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC`
  ).all(payload.sub)

  return c.json({ credentials: creds })
})

/**
 * DELETE /api/auth/webauthn/credentials/:id
 * Remove a registered passkey.
 */
webauthn.delete('/api/auth/webauthn/credentials/:id', async (c) => {
  const token = extractTokenFromHeader(c.req.header('Authorization'))
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  let payload: any
  try { payload = verifyJWT(token) } catch { return c.json({ error: 'Invalid token' }, 401) }

  const credId = c.req.param('id')
  const db = getDatabase()
  db.run(
    `DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?`,
    [credId, payload.sub]
  )
  return c.json({ success: true })
})

// ---------------------------------------------------------------------------
// COSE key parsing and signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a COSE signature against the stored public key.
 * Supports ES256 (P-256), RS256 (RSA-PKCS1), EdDSA (Ed25519).
 */
async function verifyCoseSignature(
  coseKeyB64: string,
  data: Buffer,
  signature: Buffer
): Promise<boolean> {
  const coseBuf = Buffer.from(coseKeyB64, 'base64url')
  const coseMap = parseCborMap(coseBuf)

  const alg = coseMap.get(3)  // COSE alg parameter

  try {
    if (alg === -7) {
      // ES256 — ECDSA with P-256 + SHA-256
      return verifyES256(coseMap, data, signature)
    } else if (alg === -257) {
      // RS256 — RSASSA-PKCS1-v1_5 with SHA-256
      return verifyRS256(coseMap, data, signature)
    } else if (alg === -8) {
      // EdDSA — Ed25519
      return verifyEdDSA(coseMap, data, signature)
    } else {
      console.error(`Unsupported COSE algorithm: ${alg}`)
      return false
    }
  } catch (err) {
    console.error('Signature verification error:', err)
    return false
  }
}

function verifyES256(coseMap: Map<number, any>, data: Buffer, sig: Buffer): boolean {
  const x = coseMap.get(-2) as Buffer
  const y = coseMap.get(-3) as Buffer
  if (!x || !y) return false

  // Build uncompressed EC point (0x04 || x || y)
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y])

  const keyObject = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: x.toString('base64url'),
      y: y.toString('base64url'),
    },
    format: 'jwk',
  })

  const verify = createVerify('SHA256')
  verify.update(data)
  return verify.verify(keyObject, sig)
}

function verifyRS256(coseMap: Map<number, any>, data: Buffer, sig: Buffer): boolean {
  const n = coseMap.get(-1) as Buffer
  const e = coseMap.get(-2) as Buffer
  if (!n || !e) return false

  const keyObject = createPublicKey({
    key: {
      kty: 'RSA',
      n: n.toString('base64url'),
      e: e.toString('base64url'),
    },
    format: 'jwk',
  })

  const verify = createVerify('SHA256')
  verify.update(data)
  return verify.verify(keyObject, sig)
}

async function verifyEdDSA(coseMap: Map<number, any>, data: Buffer, sig: Buffer): Promise<boolean> {
  const x = coseMap.get(-2) as Buffer  // public key bytes
  if (!x) return false

  // Use @noble/ed25519 (already a dependency)
  const { verify } = await import('@noble/ed25519')
  return verify(sig, data, x)
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (handles only what WebAuthn uses)
// ---------------------------------------------------------------------------

/**
 * Parse a CBOR-encoded attestationObject.
 * Returns an object with keys from the top-level CBOR map.
 * Only handles the subset needed for WebAuthn attestation objects.
 */
function parseCbor(buf: Buffer): Record<string, any> {
  const [result] = decodeCbor(buf, 0)
  return result
}

/**
 * Parse a CBOR map specifically (for COSE keys).
 * Returns a JS Map keyed by integer.
 */
function parseCborMap(buf: Buffer): Map<number, any> {
  const [result] = decodeCbor(buf, 0)
  if (result instanceof Map) return result
  // Convert plain object to Map
  const m = new Map<number, any>()
  for (const [k, v] of Object.entries(result as object)) {
    m.set(Number(k), v)
  }
  return m
}

/** Minimal CBOR decoder — returns [value, bytesConsumed] */
function decodeCbor(buf: Buffer, offset: number): [any, number] {
  const initialByte = buf[offset]
  const majorType = (initialByte >> 5) & 0x07
  const addInfo = initialByte & 0x1f
  offset++

  let length: number
  if (addInfo < 24) {
    length = addInfo
  } else if (addInfo === 24) {
    length = buf[offset++]
  } else if (addInfo === 25) {
    length = buf.readUInt16BE(offset); offset += 2
  } else if (addInfo === 26) {
    length = buf.readUInt32BE(offset); offset += 4
  } else {
    length = 0
  }

  switch (majorType) {
    case 0:  // unsigned int
      return [length, offset]

    case 1:  // negative int
      return [-(length + 1), offset]

    case 2:  // byte string
      return [buf.slice(offset, offset + length), offset + length]

    case 3: {  // text string
      const str = buf.slice(offset, offset + length).toString('utf8')
      return [str, offset + length]
    }

    case 4: {  // array
      const arr: any[] = []
      for (let i = 0; i < length; i++) {
        const [item, newOffset] = decodeCbor(buf, offset)
        arr.push(item)
        offset = newOffset
      }
      return [arr, offset]
    }

    case 5: {  // map
      const map = new Map<any, any>()
      for (let i = 0; i < length; i++) {
        const [key, o1] = decodeCbor(buf, offset)
        const [val, o2] = decodeCbor(buf, o1)
        map.set(key, val)
        offset = o2
      }
      return [map, offset]
    }

    default:
      return [null, offset]
  }
}

export { webauthn }
