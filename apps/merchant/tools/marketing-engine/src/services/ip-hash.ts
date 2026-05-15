/**
 * IP privacy — never store raw IPs.
 * Hash as SHA256(ip + daily_salt) where the salt rotates at midnight PT.
 * Same IP on the same day → same hash; cross-day tracking is impossible once
 * old salt rows are purged.
 */

import { getDatabase } from '../db/connection'

/** Return today's date string in PT timezone. */
function todayPT(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

/** Get (or create) today's daily salt. */
function getDailySalt(): string {
  const db = getDatabase()
  const today = todayPT()
  const row = db.query<{ salt: string }, [string]>(
    `SELECT salt FROM daily_salt WHERE date = ?`
  ).get(today)
  if (row) return row.salt

  // Generate a new salt for today
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
  db.run(`INSERT OR IGNORE INTO daily_salt (date, salt) VALUES (?, ?)`, [today, salt])

  // Purge salts older than 30 days
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
  db.run(`DELETE FROM daily_salt WHERE date < ?`, [cutoffStr])

  return salt
}

/** Hash an IP address for privacy-preserving storage. */
export async function hashIp(ip: string): Promise<string> {
  const salt = getDailySalt()
  const data = new TextEncoder().encode(ip + salt)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(digest).toString('hex')
}
