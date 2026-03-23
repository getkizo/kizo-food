/**
 * Push notification routes and dispatcher
 *
 * Implements Web Push (RFC 8030) with VAPID authentication (RFC 8292).
 * No third-party library — uses Bun's built-in crypto APIs directly.
 *
 * VAPID flow:
 *   1. Server has a P-256 EC key pair (generated once, stored in env)
 *   2. On subscribe: browser exchanges public key for a push endpoint
 *   3. On notify: server signs a JWT with private key, encrypts payload,
 *      sends HTTP POST to browser's push endpoint
 */

import { Hono } from 'hono'
import { createSign, createPrivateKey, createECDH, randomBytes, createCipheriv, createHmac, type KeyObject } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { verifyJWT, extractTokenFromHeader } from '../utils/jwt'

const push = new Hono()

// ---------------------------------------------------------------------------
// VAPID key loading
// ---------------------------------------------------------------------------

let vapidPublicKey: string | null = null
let vapidPrivateKey: KeyObject | null = null

/**
 * Loads VAPID keys from environment variables.
 * Imports the private key via JWK — avoids manual DER construction.
 */
export function loadVapidKeys(): void {
  vapidPublicKey = process.env.VAPID_PUBLIC_KEY || null
  const privKeyB64 = process.env.VAPID_PRIVATE_KEY || null

  if (!vapidPublicKey || !privKeyB64) {
    console.warn('⚠️  VAPID keys not configured — push notifications disabled')
    console.warn('   Run: bun run scripts/generate-vapid.ts')
    return
  }

  try {
    // VAPID public key is an uncompressed P-256 point: 0x04 || x (32 bytes) || y (32 bytes)
    const pubKeyBytes = Buffer.from(vapidPublicKey, 'base64url')
    const x = pubKeyBytes.slice(1, 33).toString('base64url')
    const y = pubKeyBytes.slice(33, 65).toString('base64url')

    vapidPrivateKey = createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: privKeyB64, x, y },
      format: 'jwk',
    })

    console.log('✅ VAPID keys loaded')

    if (!process.env.VAPID_SUBJECT) {
      console.warn('⚠️  VAPID_SUBJECT not set — push notifications will advertise dev@kizo.app as contact.')
      console.warn('   Set VAPID_SUBJECT=mailto:your@domain.com in production.')
    }
  } catch (err) {
    console.error('❌ Failed to import VAPID private key:', err)
  }
}

/**
 * Returns true if push notifications are available.
 */
export function isPushEnabled(): boolean {
  return vapidPublicKey !== null && vapidPrivateKey !== null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/push/vapid-public-key
 * Returns the VAPID public key so the browser can subscribe.
 * Public endpoint — no auth required.
 */
push.get('/api/push/vapid-public-key', (c) => {
  if (!vapidPublicKey) {
    return c.json({ error: 'Push notifications not configured' }, 503)
  }
  return c.json({ publicKey: vapidPublicKey })
})

/**
 * POST /api/push/subscribe
 * Saves a push subscription for the authenticated user.
 *
 * Body: { endpoint, keys: { p256dh, auth }, deviceLabel? }
 */
push.post('/api/push/subscribe', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload
  try {
    payload = verifyJWT(token)
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }

  const body = await c.req.json()
  const { endpoint, keys, deviceLabel } = body

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return c.json({ error: 'Missing endpoint or keys' }, 400)
  }

  const db = getDatabase()

  // Upsert: update if endpoint already exists, insert if new
  const existing = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM push_subscriptions WHERE endpoint = ?`
    )
    .get(endpoint)

  if (existing) {
    db.run(
      `UPDATE push_subscriptions
       SET p256dh = ?, auth = ?, device_label = ?, user_id = ?, last_used_at = datetime('now')
       WHERE endpoint = ?`,
      [keys.p256dh, keys.auth, deviceLabel || null, payload.sub, endpoint]
    )
  } else {
    db.run(
      `INSERT INTO push_subscriptions (id, merchant_id, user_id, endpoint, p256dh, auth, device_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [generateId('ps'), payload.merchantId, payload.sub, endpoint, keys.p256dh, keys.auth, deviceLabel || null]
    )
  }

  console.log(`✅ Push subscription saved for merchant ${payload.merchantId}`)
  return c.json({ success: true })
})

/**
 * DELETE /api/push/subscribe
 * Removes a push subscription (on logout or opt-out).
 *
 * Body: { endpoint }
 */
push.delete('/api/push/subscribe', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload
  try {
    payload = verifyJWT(token)
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }

  const body = await c.req.json()
  const { endpoint } = body

  if (!endpoint) {
    return c.json({ error: 'Missing endpoint' }, 400)
  }

  const db = getDatabase()
  db.run(
    `DELETE FROM push_subscriptions WHERE endpoint = ? AND merchant_id = ?`,
    [endpoint, payload.merchantId]
  )

  return c.json({ success: true })
})

/**
 * POST /api/push/test
 * Sends a test notification to all devices of the authenticated merchant.
 * Development only.
 */
push.post('/api/push/test', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'Not available in production' }, 403)
  }

  const authHeader = c.req.header('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload
  try {
    payload = verifyJWT(token)
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }

  await notifyMerchant(payload.merchantId, {
    title: 'Test Notification',
    body: 'Push notifications are working correctly!',
    data: { type: 'test' },
  })

  return c.json({ success: true, message: 'Test notification sent' })
})

// ---------------------------------------------------------------------------
// Push dispatcher
// ---------------------------------------------------------------------------

export interface PushPayload {
  title: string
  body: string
  data?: Record<string, unknown>
  /** Icon URL — defaults to /icons/icon-192.png */
  icon?: string
  /** Badge URL — defaults to /icons/badge-72.png */
  badge?: string
}

/**
 * Sends a push notification to all subscribed devices for a merchant.
 * Fire-and-forget — failed individual subscriptions are cleaned up silently.
 *
 * @param merchantId - Target merchant
 * @param notification - Notification payload
 */
export async function notifyMerchant(
  merchantId: string,
  notification: PushPayload
): Promise<void> {
  if (!isPushEnabled()) return

  const db = getDatabase()
  const subscriptions = db
    .query<{ id: string; endpoint: string; p256dh: string; auth: string }, [string]>(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE merchant_id = ?`
    )
    .all(merchantId)

  if (subscriptions.length === 0) return

  const payload: PushPayload = {
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    ...notification,
  }

  // Send to all subscriptions concurrently
  const results = await Promise.allSettled(
    subscriptions.map((sub) => sendWebPush(sub, JSON.stringify(payload)))
  )

  // Clean up expired/invalid subscriptions (410 Gone, 403 Forbidden, 404 Not Found)
  const staleEndpoints: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const err = result.reason as { statusCode?: number }
      const code = err?.statusCode
      if (code === 410 || code === 403 || code === 404) {
        staleEndpoints.push(subscriptions[i].endpoint)
      } else {
        console.error(`Push failed for subscription ${subscriptions[i].id}:`, result.reason)
      }
    }
  })

  if (staleEndpoints.length > 0) {
    for (const endpoint of staleEndpoints) {
      db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint])
    }
    console.log(`🧹 Removed ${staleEndpoints.length} stale push subscriptions`)
  }
}

// ---------------------------------------------------------------------------
// Web Push implementation (RFC 8030 + RFC 8292 VAPID)
// ---------------------------------------------------------------------------

/**
 * Sends a single Web Push message with VAPID authentication.
 * Implements the minimal subset of the spec needed for browser push.
 */
async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payloadStr: string
): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) {
    throw new Error('VAPID keys not loaded')
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:dev@kizo.app'
  const audience = new URL(subscription.endpoint).origin

  // 1. Build VAPID JWT header + claims
  const vapidJwt = buildVapidJwt(audience, subject)

  // 2. Encrypt payload using ECDH + AES-128-GCM (RFC 8291)
  const encrypted = encryptPayload(subscription.p256dh, subscription.auth, payloadStr)

  // 3. POST to push endpoint
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${vapidJwt},k=${vapidPublicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',         // Message valid for 24 hours
      'Urgency': 'high',      // Deliver immediately (wake device if needed)
    },
    body: encrypted,
  })

  if (!response.ok && response.status !== 201) {
    throw Object.assign(
      new Error(`Push endpoint returned ${response.status}`),
      { statusCode: response.status },
    )
  }
}

/**
 * Builds a VAPID JWT for authenticating the push request.
 * JWT is signed with the server's EC private key (ES256 / P-256).
 */
function buildVapidJwt(audience: string, subject: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = base64url(JSON.stringify({
    aud: audience,
    exp: now + 12 * 3600,   // 12 hour expiry
    sub: subject,
  }))

  const signingInput = `${header}.${claims}`

  // Sign with ES256 (ECDSA P-256 + SHA-256)
  const sign = createSign('SHA256')
  sign.update(signingInput)
  const derSig = sign.sign({ key: vapidPrivateKey!, dsaEncoding: 'der' })

  // Convert DER-encoded ECDSA signature to raw R||S format (64 bytes)
  const rawSig = derToRawEcSig(derSig)

  return `${signingInput}.${base64url(rawSig)}`
}

/**
 * Encrypts the push payload using ECDH + AES-128-GCM (RFC 8291 / aes128gcm).
 */
function encryptPayload(p256dhB64: string, authB64: string, payload: string): Buffer {
  const receiverPublicKey = Buffer.from(p256dhB64, 'base64url')
  const authSecret = Buffer.from(authB64, 'base64url')

  // Generate ephemeral sender key pair (P-256)
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const senderPublicKey = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(receiverPublicKey)

  // HKDF to derive content encryption key and nonce (RFC 8291 §3.4)
  const salt = randomBytes(16)

  // Step 1: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32)
  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info\x00'),
    receiverPublicKey,     // ua_public (subscriber's p256dh key)
    senderPublicKey,       // as_public (ephemeral sender key)
  ])
  const prk = hkdf(authSecret, sharedSecret, authInfo, 32)

  // Step 2-3: Derive CEK and nonce from salt + PRK
  const contentKey = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\x00'), 16)
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\x00'), 12)

  // Encrypt with AES-128-GCM (RFC 8188 §2 record format)
  // Record = plaintext || delimiter(0x02) || padding(zeros)
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  const paddedPayload = Buffer.concat([
    Buffer.from(payload, 'utf8'),
    Buffer.from([0x02]),         // delimiter — marks end of content
  ])
  const ciphertext = Buffer.concat([cipher.update(paddedPayload), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Build aes128gcm content-encoding header (RFC 8188)
  const rs = 4096
  const rsBuffer = Buffer.allocUnsafe(4)
  rsBuffer.writeUInt32BE(rs, 0)

  return Buffer.concat([
    salt,                                         // 16 bytes
    rsBuffer,                                     // 4 bytes record size
    Buffer.from([senderPublicKey.length]),         // 1 byte key length
    senderPublicKey,                              // 65 bytes uncompressed EC point
    ciphertext,
    authTag,                                      // 16 bytes
  ])
}

/** HKDF-SHA256 key derivation */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  const result = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest()
  return result.slice(0, length)
}

/* buildContext removed — inlined per RFC 8291 §3.4 */

/** Convert DER-encoded ECDSA signature to raw 64-byte R||S format */
function derToRawEcSig(der: Buffer): Buffer {
  let offset = 2                          // skip SEQUENCE tag + length
  const rLen = der[offset + 1]
  const r = der.slice(offset + 2, offset + 2 + rLen)
  offset += 2 + rLen
  const sLen = der[offset + 1]
  const s = der.slice(offset + 2, offset + 2 + sLen)

  // Pad R and S to 32 bytes each (strip leading 0x00 padding byte if present)
  const rPad = r.length > 32 ? r.slice(r.length - 32) : r
  const sPad = s.length > 32 ? s.slice(s.length - 32) : s
  const raw = Buffer.alloc(64, 0)
  rPad.copy(raw, 32 - rPad.length)
  sPad.copy(raw, 64 - sPad.length)
  return raw
}

/** Base64URL encode a string or Buffer */
function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64url')
}

/**
 * Sends a push notification to any customer subscriptions for a given order.
 * Called when merchant advances order to 'ready' status.
 *
 * @param orderId - The order whose customer subscriptions to notify
 * @param notification - Notification payload
 */
export async function notifyCustomer(
  orderId: string,
  notification: PushPayload
): Promise<void> {
  if (!isPushEnabled()) return

  const db = getDatabase()
  const subscriptions = db
    .query<{ id: string; endpoint: string; p256dh: string; auth: string }, [string]>(
      `SELECT id, endpoint, p256dh, auth FROM customer_push_subscriptions WHERE order_id = ?`
    )
    .all(orderId)

  if (subscriptions.length === 0) return

  const payload: PushPayload = {
    icon:  '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    ...notification,
  }

  const results = await Promise.allSettled(
    subscriptions.map((sub) => sendWebPush(sub, JSON.stringify(payload)))
  )

  const staleEndpoints: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const err = result.reason as { statusCode?: number }
      const code = err?.statusCode
      if (code === 410 || code === 403 || code === 404) {
        staleEndpoints.push(subscriptions[i].endpoint)
      }
    }
  })

  if (staleEndpoints.length > 0) {
    for (const endpoint of staleEndpoints) {
      db.run(`DELETE FROM customer_push_subscriptions WHERE endpoint = ?`, [endpoint])
    }
  }
}

export { push }
