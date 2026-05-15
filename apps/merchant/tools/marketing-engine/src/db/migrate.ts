/**
 * Database migration — runs schema.sql then any one-time migrations.
 * Called automatically at server startup and via `bun run db:migrate`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from './connection'

export function migrate(): void {
  const db = getDatabase()
  const schema = readFileSync(join(import.meta.dir, 'schema.sql'), 'utf8')
  db.exec(schema)
  console.log('✓ Marketing engine migrations applied')
}

if (import.meta.main) {
  migrate()
  console.log('Migration complete.')
}
