/**
 * Run database migration
 * Usage: bun run src/db/run-migration.ts <migration-file>
 */

import { getDatabase } from './connection'
import { readFileSync } from 'fs'
import { join } from 'path'

async function runMigration(migrationFile: string) {
  console.log(`Running migration: ${migrationFile}`)

  const db = getDatabase()

  // Read migration file
  const migrationPath = join(__dirname, 'migrations', migrationFile)
  const sql = readFileSync(migrationPath, 'utf-8')

  // Split into individual statements (SQLite doesn't support multi-statement exec well)
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'))

  // Execute each statement
  for (const statement of statements) {
    try {
      db.run(statement)
      console.log(`✓ Executed: ${statement.substring(0, 60)}...`)
    } catch (error) {
      console.error(`✗ Failed: ${statement}`)
      throw error
    }
  }

  console.log('✅ Migration completed successfully')
}

// Get migration file from command line args
const migrationFile = process.argv[2]

if (!migrationFile) {
  console.error('Usage: bun run src/db/run-migration.ts <migration-file>')
  process.exit(1)
}

runMigration(migrationFile).catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
