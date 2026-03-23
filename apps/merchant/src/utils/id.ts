/**
 * ID generation utilities
 * Generates unique IDs with prefixes for different entity types
 */

import { randomBytes } from 'node:crypto'

/**
 * Generates a unique ID with a prefix
 *
 * @param prefix - Prefix for the ID (e.g., 'm', 'ord', 'dish')
 * @param length - Length of random suffix (default: 16 hex chars = 8 bytes)
 * @returns Prefixed unique ID (e.g., 'm_abc123xyz')
 */
export function generateId(prefix: string, length: number = 16): string {
  const bytes = Math.ceil(length / 2)
  const random = randomBytes(bytes).toString('hex').slice(0, length)
  return `${prefix}_${random}`
}

/**
 * Generates a 4-character pickup code (alphanumeric, uppercase)
 *
 * @returns Pickup code (e.g., 'A7K2')
 */
export function generatePickupCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Excludes I, O, 0, 1 for clarity
  let code = ''

  for (let i = 0; i < 4; i++) {
    const randomIndex = randomBytes(1)[0] % chars.length
    code += chars[randomIndex]
  }

  return code
}

/**
 * Validates an ID format
 *
 * @param id - ID to validate
 * @param prefix - Expected prefix
 * @returns True if valid
 */
export function isValidId(id: string, prefix: string): boolean {
  const pattern = new RegExp(`^${prefix}_[a-f0-9]{16}$`)
  return pattern.test(id)
}
