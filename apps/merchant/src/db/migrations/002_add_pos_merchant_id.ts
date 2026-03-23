/**
 * Migration 002: Add pos_merchant_id to api_keys table
 *
 * The pos_merchant_id stores the POS provider's merchant ID (e.g., Clover merchant ID)
 * This is different from our internal merchant_id (m_abc123xyz format)
 *
 * Example: Clover merchant ID is "WJ3EYD26EN771"
 */

import { getDatabase } from '../connection'

export function migrate() {
  const db = getDatabase()

  console.log('Running migration 002: Add pos_merchant_id to api_keys')

  try {
    // Check if column already exists
    const tableInfo = db.query(`PRAGMA table_info(api_keys)`).all() as Array<{
      name: string
      type: string
    }>

    const hasColumn = tableInfo.some((col) => col.name === 'pos_merchant_id')

    if (hasColumn) {
      console.log('  ✓ Column pos_merchant_id already exists, skipping')
      return
    }

    // Add the column
    db.exec(`ALTER TABLE api_keys ADD COLUMN pos_merchant_id TEXT`)

    console.log('  ✓ Added pos_merchant_id column to api_keys table')
  } catch (error) {
    console.error('  ✗ Migration 002 failed:', error)
    throw error
  }
}
