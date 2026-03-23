/**
 * SQLite database connection and utilities
 * Uses bun:sqlite for embedded, zero-config database
 */

import { Database } from 'bun:sqlite'
import { join } from 'node:path'

let db: Database | null = null

/**
 * Gets or creates the database connection
 */
export function getDatabase(): Database {
  if (db) {
    return db
  }

  const dbPath = process.env.DATABASE_PATH || join(process.cwd(), 'data', 'merchant.db')

  db = new Database(dbPath, { create: true })

  // Enable WAL mode for better concurrency
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000') // 5 second timeout

  // Optimize for performance
  db.exec('PRAGMA synchronous = NORMAL') // Faster than FULL, safe with WAL
  db.exec('PRAGMA cache_size = -64000')   // 64MB cache
  db.exec('PRAGMA temp_store = MEMORY')

  console.log(`✅ Database connected: ${dbPath}`)

  return db
}

/**
 * Closes the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    console.log('✅ Database connection closed')
  }
}

/**
 * Runs a transaction
 */
export function transaction<T>(fn: (db: Database) => T): T {
  const database = getDatabase()
  const txn = database.transaction(fn)
  return txn(database)
}

/**
 * Type-safe query wrapper
 */
export interface QueryOptions<T> {
  sql: string
  params?: unknown[]
}

export function query<T = unknown>(options: QueryOptions<T>): T[] {
  const database = getDatabase()
  const stmt = database.query<T, unknown[]>(options.sql)
  return stmt.all(...(options.params || []))
}

export function queryOne<T = unknown>(options: QueryOptions<T>): T | null {
  const database = getDatabase()
  const stmt = database.query<T, unknown[]>(options.sql)
  return stmt.get(...(options.params || [])) || null
}

export function execute(options: QueryOptions<unknown>): void {
  const database = getDatabase()
  database.run(options.sql, ...(options.params || []))
}

/**
 * Prepared statement cache for performance
 */
const stmtCache = new Map<string, any>()

export function prepareStatement<T = unknown, P extends unknown[] = unknown[]>(
  sql: string
) {
  if (stmtCache.has(sql)) {
    return stmtCache.get(sql)
  }

  if (stmtCache.size >= 500) {
    const first = stmtCache.keys().next().value
    stmtCache.delete(first)
  }

  const database = getDatabase()
  const stmt = database.query<T, P>(sql)
  stmtCache.set(sql, stmt)

  return stmt
}

/**
 * Get current schema version
 */
export function getSchemaVersion(): string {
  try {
    const result = queryOne<{ value: string }>({
      sql: "SELECT value FROM system_metadata WHERE key = 'schema_version'",
    })
    return result?.value || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Check if database is initialized
 */
export function isDatabaseInitialized(): boolean {
  try {
    const database = getDatabase()
    const result = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='system_metadata'"
      )
      .get()
    return (result?.count ?? 0) > 0
  } catch {
    return false
  }
}
