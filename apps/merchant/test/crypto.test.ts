/**
 * Cryptography layer tests
 * Tests master key, DEK, and API key encryption
 */

import { test, expect, beforeAll, afterAll, describe } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { initializeMasterKey, getMasterKey, clearMasterKey } from '../src/crypto/master-key'
import { generateDEK, getDEK, hasDEK, deleteDEK, rotateDEK } from '../src/crypto/dek'
import {
  storeAPIKey,
  getAPIKey,
  listAPIKeys,
  deleteAPIKey,
  hasAPIKey,
} from '../src/crypto/api-keys'
import { getDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'

// Test passphrase
const TEST_PASSPHRASE = 'TestPassphrase123!@#'

// Test merchant ID
const TEST_MERCHANT_ID = 'm_test123'

beforeAll(async () => {
  // Set test database path
  process.env.DATABASE_PATH = ':memory:' // In-memory database for tests

  // Run migrations
  await migrate()

  // Initialize master key
  await initializeMasterKey(TEST_PASSPHRASE)

  // Create test merchant
  const db = getDatabase()
  db.run(
    `INSERT INTO merchants (id, business_name, slug, status)
     VALUES (?, ?, ?, ?)`,
    [TEST_MERCHANT_ID, 'Test Merchant', 'test-merchant', 'active']
  )
})

afterAll(() => {
  clearMasterKey()
})

describe('Master Key', () => {
  test('should be initialized', () => {
    const masterKey = getMasterKey()
    expect(masterKey).toBeDefined()
    expect(masterKey.length).toBe(32) // 256 bits
  })

  test('should throw if accessed before initialization', async () => {
    clearMasterKey()
    expect(() => getMasterKey()).toThrow('Master key not initialized')
    // Re-initialize for other tests — must await (async)
    await initializeMasterKey(TEST_PASSPHRASE)
  })
})

describe('DEK (Data Encryption Key)', () => {
  test('should generate DEK for merchant', () => {
    const dek = generateDEK(TEST_MERCHANT_ID)
    expect(dek).toBeDefined()
    expect(dek.length).toBe(32) // 256 bits
  })

  test('should retrieve same DEK after generation', () => {
    const dek1 = generateDEK(TEST_MERCHANT_ID)
    const dek2 = getDEK(TEST_MERCHANT_ID)
    expect(dek1.equals(dek2)).toBe(true)
  })

  test('should check if DEK exists', () => {
    expect(hasDEK(TEST_MERCHANT_ID)).toBe(true)
    expect(hasDEK('nonexistent')).toBe(false)
  })

  test('should delete DEK', () => {
    const testId = 'm_delete_test'
    // Must insert merchant first — deks table has FK constraint on merchants.id
    const db = getDatabase()
    db.run(
      `INSERT OR IGNORE INTO merchants (id, business_name, slug, status) VALUES (?, ?, ?, ?)`,
      [testId, 'Delete Test', 'delete-test', 'active']
    )
    generateDEK(testId)
    expect(hasDEK(testId)).toBe(true)

    deleteDEK(testId)
    expect(hasDEK(testId)).toBe(false)
  })

  test('should rotate DEK and re-encrypt API keys', async () => {
    const testId = 'm_rotate_test'
    const db = getDatabase()

    // Create merchant
    db.run(
      `INSERT INTO merchants (id, business_name, slug, status)
       VALUES (?, ?, ?, ?)`,
      [testId, 'Rotate Test', 'rotate-test', 'active']
    )

    // Store API key
    const apiKey = 'sk_test_original_key'
    await storeAPIKey(testId, 'payment', 'stripe', apiKey)

    // Get original DEK
    const oldDEK = getDEK(testId)

    // Rotate DEK
    await rotateDEK(testId)

    // Get new DEK
    const newDEK = getDEK(testId)

    // DEKs should be different
    expect(oldDEK.equals(newDEK)).toBe(false)

    // API key should still be decryptable
    const retrieved = await getAPIKey(testId, 'payment', 'stripe')
    expect(retrieved).toBe(apiKey)
  })
})

describe('API Key Encryption', () => {
  test('should store and retrieve API key', async () => {
    const apiKey = 'sk_test_abc123xyz'
    const keyId = await storeAPIKey(
      TEST_MERCHANT_ID,
      'payment',
      'stripe',
      apiKey
    )

    expect(keyId).toMatch(/^key_/)

    const retrieved = await getAPIKey(TEST_MERCHANT_ID, 'payment', 'stripe')
    expect(retrieved).toBe(apiKey)
  })

  test('should encrypt different keys differently', async () => {
    const db = getDatabase()

    const key1 = 'sk_test_key1'
    const key2 = 'sk_test_key2'

    await storeAPIKey(TEST_MERCHANT_ID, 'payment', 'stripe', key1)
    await storeAPIKey(TEST_MERCHANT_ID, 'pos', 'square', key2)

    // Get encrypted values from database
    const rows = db
      .query<{ encrypted_value: string }, [string]>(
        `SELECT encrypted_value FROM api_keys WHERE merchant_id = ?`
      )
      .all(TEST_MERCHANT_ID)

    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0].encrypted_value).not.toBe(rows[1].encrypted_value)
  })

  test('should handle multiple API keys per merchant', async () => {
    const keys = {
      stripe: 'sk_test_stripe',
      square: 'sq_test_square',
      toast: 'toast_test_key',
    }

    for (const [provider, key] of Object.entries(keys)) {
      await storeAPIKey(TEST_MERCHANT_ID, 'payment', provider, key)
    }

    const list = listAPIKeys(TEST_MERCHANT_ID)
    expect(list.length).toBeGreaterThanOrEqual(3)

    for (const [provider, expectedKey] of Object.entries(keys)) {
      const retrieved = await getAPIKey(TEST_MERCHANT_ID, 'payment', provider)
      expect(retrieved).toBe(expectedKey)
    }
  })

  test('should check if API key exists', async () => {
    await storeAPIKey(TEST_MERCHANT_ID, 'pos', 'toast', 'toast_key')

    expect(hasAPIKey(TEST_MERCHANT_ID, 'pos', 'toast')).toBe(true)
    expect(hasAPIKey(TEST_MERCHANT_ID, 'pos', 'nonexistent')).toBe(false)
  })

  test('should delete API key securely', async () => {
    const testProvider = 'test_delete_provider'
    await storeAPIKey(TEST_MERCHANT_ID, 'payment', testProvider, 'test_key')

    expect(hasAPIKey(TEST_MERCHANT_ID, 'payment', testProvider)).toBe(true)

    await deleteAPIKey(TEST_MERCHANT_ID, 'payment', testProvider)

    expect(hasAPIKey(TEST_MERCHANT_ID, 'payment', testProvider)).toBe(false)
    const retrieved = await getAPIKey(TEST_MERCHANT_ID, 'payment', testProvider)
    expect(retrieved).toBe(null)
  })

  test('should return null for non-existent key', async () => {
    const retrieved = await getAPIKey(TEST_MERCHANT_ID, 'payment', 'nonexistent_provider')
    expect(retrieved).toBe(null)
  })

  test('should update last_used_at on access', async () => {
    const db = getDatabase()
    const provider = 'test_last_used'

    await storeAPIKey(TEST_MERCHANT_ID, 'payment', provider, 'test_key')

    // Get initial last_used_at
    const before = db
      .query<{ last_used_at: string | null }, [string, string, string]>(
        `SELECT last_used_at FROM api_keys
         WHERE merchant_id = ? AND key_type = ? AND provider = ?`
      )
      .get(TEST_MERCHANT_ID, 'payment', provider)

    expect(before?.last_used_at).toBe(null)

    // Access the key
    await getAPIKey(TEST_MERCHANT_ID, 'payment', provider)

    // Check last_used_at was updated
    const after = db
      .query<{ last_used_at: string | null }, [string, string, string]>(
        `SELECT last_used_at FROM api_keys
         WHERE merchant_id = ? AND key_type = ? AND provider = ?`
      )
      .get(TEST_MERCHANT_ID, 'payment', provider)

    expect(after?.last_used_at).not.toBe(null)
  })

  test('should handle large API keys', async () => {
    // Generate a 1KB API key
    const largeKey = randomBytes(1024).toString('base64')

    await storeAPIKey(TEST_MERCHANT_ID, 'payment', 'large_key_test', largeKey)
    const retrieved = await getAPIKey(TEST_MERCHANT_ID, 'payment', 'large_key_test')

    expect(retrieved).toBe(largeKey)
    expect(retrieved?.length).toBe(largeKey.length)
  })
})
