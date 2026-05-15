import { Database } from 'bun:sqlite'

const dbPath = process.env.DB_PATH ?? '/var/lib/kizo/campaigns.db'

let _db: Database | null = null

export function getDatabase(): Database {
  if (_db) return _db
  _db = new Database(dbPath, { create: true })
  _db.exec('PRAGMA journal_mode = WAL')
  _db.exec('PRAGMA foreign_keys = ON')
  return _db
}

export function closeDatabase(): void {
  _db?.close()
  _db = null
}
