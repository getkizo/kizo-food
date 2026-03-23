/**
 * API key encryption and storage
 * Protects merchant POS and payment credentials
 *
 * Security properties:
 * - AES-256-GCM authenticated encryption
 * - Unique IV per encryption
 * - Auth tag prevents tampering
 * - Audit logging of access
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { getDEK } from './dek'
import { auditKeyAccess } from './audit'

export type KeyType = 'pos' | 'payment' | 'cloud' | 'email'

interface APIKeyRecord {
  id: string
  merchantId: string
  keyType: KeyType
  provider: string
  encryptedValue: string
  posMerchantId: string | null
  createdAt: string
  lastUsedAt: string | null
}

/**
 * Encrypts an API key with the merchant's DEK.
 *
 * @param plaintext - API key plaintext
 * @param dek - Data Encryption Key
 * @returns Base64-encoded (IV + ciphertext + auth tag)
 */
function encryptAPIKey(plaintext: string, dek: Buffer): string {
  const iv = randomBytes(12) // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', dek, iv)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  // IV (12) + ciphertext (variable) + authTag (16)
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64')
}

/**
 * Decrypts an API key with the merchant's DEK.
 *
 * @param encryptedValue - Base64-encoded ciphertext
 * @param dek - Data Encryption Key
 * @returns Decrypted API key
 */
function decryptAPIKey(encryptedValue: string, dek: Buffer): string {
  const buffer = Buffer.from(encryptedValue, 'base64')

  const iv = buffer.subarray(0, 12)
  const authTag = buffer.subarray(buffer.length - 16)
  const ciphertext = buffer.subarray(12, buffer.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', dek, iv)
  decipher.setAuthTag(authTag)

  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])

    return plaintext.toString('utf8')
  } catch (error) {
    throw new Error(
      `Failed to decrypt API key: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
      `This may indicate tampering or a corrupted key.`
    )
  }
}

/**
 * Stores an encrypted API key in the database.
 *
 * @param merchantId - Merchant ID (our internal ID, e.g., m_abc123xyz)
 * @param keyType - Type of key ('pos' or 'payment')
 * @param provider - Provider name (e.g., 'square', 'stripe', 'clover')
 * @param apiKey - API key plaintext
 * @param ipAddress - Optional IP address for audit log
 * @param posMerchantId - Optional POS provider's merchant ID (e.g., Clover: WJ3EYD26EN771)
 * @returns API key ID
 */
export async function storeAPIKey(
  merchantId: string,
  keyType: KeyType,
  provider: string,
  apiKey: string,
  ipAddress?: string,
  posMerchantId?: string
): Promise<string> {
  const db = getDatabase()
  const dek = getDEK(merchantId)
  const encryptedValue = encryptAPIKey(apiKey, dek)
  const id = `key_${randomBytes(16).toString('hex')}`

  db.run(
    `INSERT OR REPLACE INTO api_keys (id, merchant_id, key_type, provider, encrypted_value, pos_merchant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [id, merchantId, keyType, provider, encryptedValue, posMerchantId || null]
  )

  // Audit log
  auditKeyAccess(merchantId, 'key_created', keyType, provider, ipAddress)

  console.log(`✅ API key stored: ${keyType}/${provider} for merchant ${merchantId}${posMerchantId ? ` (POS ID: ${posMerchantId})` : ''}`)

  return id
}

/**
 * Retrieves and decrypts an API key.
 *
 * @param merchantId - Merchant ID
 * @param keyType - Type of key ('pos' or 'payment')
 * @param provider - Provider name
 * @param ipAddress - Optional IP address for audit log
 * @returns Decrypted API key or null if not found
 */
export async function getAPIKey(
  merchantId: string,
  keyType: KeyType,
  provider: string,
  ipAddress?: string
): Promise<string | null> {
  const db = getDatabase()

  try {
    const row = db
      .query<APIKeyRecord, [string, KeyType, string]>(
        `SELECT encrypted_value AS encryptedValue FROM api_keys
         WHERE merchant_id = ? AND key_type = ? AND provider = ?
         LIMIT 1`
      )
      .get(merchantId, keyType, provider)

    if (!row) {
      return null
    }

    const dek = getDEK(merchantId)
    const plaintext = decryptAPIKey(row.encryptedValue, dek)

    // Update last_used_at timestamp
    db.run(
      `UPDATE api_keys
       SET last_used_at = datetime('now')
       WHERE merchant_id = ? AND key_type = ? AND provider = ?`,
      [merchantId, keyType, provider]
    )

    // Audit log
    auditKeyAccess(merchantId, 'key_accessed', keyType, provider, ipAddress)

    return plaintext
  } catch (error) {
    // Audit failed access
    auditKeyAccess(merchantId, 'key_failed', keyType, provider, ipAddress)
    throw error
  }
}

/**
 * Retrieves the POS merchant ID for a given provider.
 *
 * @param merchantId - Merchant ID (our internal ID)
 * @param provider - Provider name (e.g., 'clover', 'square')
 * @returns POS merchant ID or null if not found
 */
export function getPOSMerchantId(
  merchantId: string,
  provider: string
): string | null {
  const db = getDatabase()

  const row = db
    .query<{ pos_merchant_id: string | null }, [string, string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'pos' AND provider = ?
       LIMIT 1`
    )
    .get(merchantId, provider)

  return row?.pos_merchant_id || null
}

/**
 * Lists all API keys for a merchant (without decrypting).
 *
 * @param merchantId - Merchant ID
 * @returns Array of API key metadata
 */
export function listAPIKeys(merchantId: string): Array<{
  id: string
  keyType: KeyType
  provider: string
  createdAt: string
  lastUsedAt: string | null
}> {
  const db = getDatabase()
  const rows = db
    .query<APIKeyRecord, [string]>(
      `SELECT id,
              key_type AS keyType,
              provider,
              created_at AS createdAt,
              last_used_at AS lastUsedAt
       FROM api_keys
       WHERE merchant_id = ?
       ORDER BY created_at DESC`
    )
    .all(merchantId)

  return rows.map((row) => ({
    id: row.id,
    keyType: row.keyType,
    provider: row.provider,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }))
}

/**
 * Deletes an API key (secure deletion with overwrite).
 *
 * @param merchantId - Merchant ID
 * @param keyType - Type of key
 * @param provider - Provider name
 * @param ipAddress - Optional IP address for audit log
 */
export async function deleteAPIKey(
  merchantId: string,
  keyType: KeyType,
  provider: string,
  ipAddress?: string
): Promise<void> {
  const db = getDatabase()

  // 1. Overwrite encrypted value with random data (prevent forensic recovery)
  const random = randomBytes(256).toString('base64')
  db.run(
    `UPDATE api_keys SET encrypted_value = ?
     WHERE merchant_id = ? AND key_type = ? AND provider = ?`,
    [random, merchantId, keyType, provider]
  )

  // 2. Delete the record
  db.run(
    `DELETE FROM api_keys
     WHERE merchant_id = ? AND key_type = ? AND provider = ?`,
    [merchantId, keyType, provider]
  )

  // Audit log
  auditKeyAccess(merchantId, 'key_deleted', keyType, provider, ipAddress)

  console.log(`✅ API key deleted: ${keyType}/${provider} for merchant ${merchantId}`)
}

/**
 * Checks if an API key exists
 *
 * @param merchantId - Merchant ID
 * @param keyType - Type of key
 * @param provider - Provider name
 * @returns True if key exists
 */
export function hasAPIKey(
  merchantId: string,
  keyType: KeyType,
  provider: string
): boolean {
  const db = getDatabase()
  const row = db
    .query<{ count: number }, [string, KeyType, string]>(
      `SELECT COUNT(*) as count FROM api_keys
       WHERE merchant_id = ? AND key_type = ? AND provider = ?`
    )
    .get(merchantId, keyType, provider)

  return (row?.count ?? 0) > 0
}

/**
 * Updates an existing API key
 *
 * @param merchantId - Merchant ID
 * @param keyType - Type of key
 * @param provider - Provider name
 * @param newApiKey - New API key value
 * @param ipAddress - Optional IP address for audit log
 */
export async function updateAPIKey(
  merchantId: string,
  keyType: KeyType,
  provider: string,
  newApiKey: string,
  ipAddress?: string
): Promise<void> {
  const dek = getDEK(merchantId)
  const encryptedValue = encryptAPIKey(newApiKey, dek)

  const db = getDatabase()
  db.run(
    `UPDATE api_keys
     SET encrypted_value = ?, created_at = datetime('now'), last_used_at = NULL
     WHERE merchant_id = ? AND key_type = ? AND provider = ?`,
    [encryptedValue, merchantId, keyType, provider]
  )

  // Audit log
  auditKeyAccess(merchantId, 'key_updated', keyType, provider, ipAddress)

  console.log(`✅ API key updated: ${keyType}/${provider} for merchant ${merchantId}`)
}
