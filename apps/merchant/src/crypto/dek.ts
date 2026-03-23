/**
 * Data Encryption Key (DEK) management
 * Implements envelope encryption pattern
 *
 * Architecture:
 * - One DEK per merchant
 * - DEK encrypted with master key before storage
 * - Allows DEK rotation without re-encrypting all API keys (rotateDEK())
 *
 * H-15: Master key rotation constraint
 * ─────────────────────────────────────────────────────────────────────
 * The master key (MASTER_ENCRYPTION_KEY env var) encrypts ALL merchant DEKs.
 * Rotating the master key requires:
 *   1. Decrypt every merchant's DEK with the OLD master key
 *   2. Re-encrypt each DEK with the NEW master key and overwrite in DB
 *   3. Only then replace the env var / secret store value
 *
 * There is currently NO automated master-key rotation tool. Until one is
 * built, treat the master key as a long-lived secret and protect it with:
 *   - Secure secret management (not .env in production)
 *   - Access logs on the secret store
 *   - Periodic manual rotation during scheduled maintenance windows
 *
 * DEK rotation (rotateDEK()) is independent and can be performed per-merchant
 * at any time without touching the master key.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { getMasterKey } from './master-key'

interface DEKRecord {
  merchantId: string
  encryptedDEK: string
  createdAt: string
  rotatedAt: string | null
}

/**
 * Generates a new Data Encryption Key (DEK) for a merchant.
 * DEK is encrypted with the master key before storage.
 *
 * @param merchantId - Merchant ID
 * @returns Plaintext DEK (32 bytes for AES-256)
 */
export function generateDEK(merchantId: string): Buffer {
  const dek = randomBytes(32) // AES-256 key
  const masterKey = getMasterKey()

  // Encrypt DEK with master key (AES-256-GCM)
  const iv = randomBytes(12) // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)

  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Store: IV (12) + ciphertext (32) + authTag (16) = 60 bytes
  const encryptedDEK = Buffer.concat([iv, ciphertext, authTag]).toString('base64')

  // Persist to database
  const db = getDatabase()
  db.run(
    `INSERT OR REPLACE INTO encryption_keys (merchant_id, encrypted_dek, created_at)
     VALUES (?, ?, datetime('now'))`,
    [merchantId, encryptedDEK]
  )

  console.log(`✅ DEK generated for merchant: ${merchantId}`)

  return dek
}

/**
 * Retrieves and decrypts the DEK for a merchant.
 * Creates a new DEK if one doesn't exist.
 *
 * @param merchantId - Merchant ID
 * @returns Decrypted DEK (32 bytes)
 */
export function getDEK(merchantId: string): Buffer {
  const db = getDatabase()
  const row = db
    .query<DEKRecord, [string]>(
      `SELECT encrypted_dek FROM encryption_keys WHERE merchant_id = ?`
    )
    .get(merchantId)

  // Generate new DEK if none exists
  if (!row) {
    return generateDEK(merchantId)
  }

  const masterKey = getMasterKey()
  const encryptedDEK = Buffer.from(row.encrypted_dek, 'base64')

  // Extract: IV (12) + ciphertext (32) + authTag (16)
  const iv = encryptedDEK.subarray(0, 12)
  const ciphertext = encryptedDEK.subarray(12, 44)
  const authTag = encryptedDEK.subarray(44, 60)

  // Decrypt DEK with master key
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(authTag)

  try {
    const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return dek
  } catch (error) {
    throw new Error(
      `Failed to decrypt DEK for merchant ${merchantId}: ` +
      `${error instanceof Error ? error.message : 'Unknown error'}. ` +
      `This may indicate a corrupted DEK or incorrect master key.`
    )
  }
}

/**
 * Rotates the DEK for a merchant.
 * Re-encrypts all API keys with the new DEK.
 *
 * @param merchantId - Merchant ID
 * @returns Promise that resolves when rotation is complete
 */
export async function rotateDEK(merchantId: string): Promise<void> {
  const db = getDatabase()

  // 1. Get old DEK
  const oldDEK = getDEK(merchantId)

  // 2. Get all encrypted API keys
  const apiKeys = db
    .query<{ id: string; encrypted_value: string }, [string]>(
      `SELECT id, encrypted_value FROM api_keys WHERE merchant_id = ?`
    )
    .all(merchantId)

  // 3. Decrypt all API keys with old DEK
  const decryptedKeys = apiKeys.map((k) => ({
    id: k.id,
    plaintext: decryptAPIKeyValue(k.encrypted_value, oldDEK),
  }))

  // 4. Generate new DEK (overwrites old one in DB)
  const newDEK = generateDEK(merchantId)

  // 5. Re-encrypt all API keys with new DEK
  const updateStmt = db.prepare(
    `UPDATE api_keys SET encrypted_value = ? WHERE id = ?`
  )

  for (const { id, plaintext } of decryptedKeys) {
    const encryptedValue = encryptAPIKeyValue(plaintext, newDEK)
    updateStmt.run(encryptedValue, id)
  }

  // 6. Mark rotation timestamp
  db.run(
    `UPDATE encryption_keys SET rotated_at = datetime('now') WHERE merchant_id = ?`,
    [merchantId]
  )

  // 7. Zero-fill old DEK
  oldDEK.fill(0)

  console.log(`✅ DEK rotated for merchant: ${merchantId} (${apiKeys.length} API keys re-encrypted)`)
}

/**
 * Deletes a merchant's DEK (use with caution - makes API keys unrecoverable)
 *
 * @param merchantId - Merchant ID
 */
export function deleteDEK(merchantId: string): void {
  const db = getDatabase()

  // Overwrite with random data first (prevent forensic recovery)
  const random = randomBytes(60).toString('base64')
  db.run(
    `UPDATE encryption_keys SET encrypted_dek = ? WHERE merchant_id = ?`,
    [random, merchantId]
  )

  // Then delete
  db.run(
    `DELETE FROM encryption_keys WHERE merchant_id = ?`,
    [merchantId]
  )

  console.log(`✅ DEK deleted for merchant: ${merchantId}`)
}

/**
 * Checks if a merchant has a DEK
 *
 * @param merchantId - Merchant ID
 * @returns True if DEK exists
 */
export function hasDEK(merchantId: string): boolean {
  const db = getDatabase()
  const row = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM encryption_keys WHERE merchant_id = ?`
    )
    .get(merchantId)

  return (row?.count ?? 0) > 0
}

/**
 * Helper: Encrypts a value with a DEK (used during rotation)
 */
function encryptAPIKeyValue(plaintext: string, dek: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dek, iv)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return Buffer.concat([iv, ciphertext, authTag]).toString('base64')
}

/**
 * Helper: Decrypts a value with a DEK (used during rotation)
 */
function decryptAPIKeyValue(encryptedValue: string, dek: Buffer): string {
  const buffer = Buffer.from(encryptedValue, 'base64')

  const iv = buffer.subarray(0, 12)
  const authTag = buffer.subarray(buffer.length - 16)
  const ciphertext = buffer.subarray(12, buffer.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', dek, iv)
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return plaintext.toString('utf8')
}
