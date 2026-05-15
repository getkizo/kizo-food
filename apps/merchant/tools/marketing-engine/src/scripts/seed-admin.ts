/**
 * Seed the first admin user.
 * Usage: bun run seed-admin <email> <password>
 */

import { getDatabase, closeDatabase } from '../db/connection'
import { migrate } from '../db/migrate'

const email    = process.argv[2]
const password = process.argv[3]

if (!email || !password) {
  console.error('Usage: bun run seed-admin <email> <password>')
  process.exit(1)
}

if (password.length < 12) {
  console.error('Password must be at least 12 characters')
  process.exit(1)
}

migrate()

const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
const db   = getDatabase()

try {
  db.run(
    `INSERT INTO admin_users (email, password_hash, role) VALUES (?, ?, 'admin')`,
    [email.toLowerCase().trim(), hash]
  )
  console.log(`✓ Admin user created: ${email}`)
} catch (err) {
  if (String(err).includes('UNIQUE')) {
    console.log('User already exists — updating password.')
    db.run(`UPDATE admin_users SET password_hash = ? WHERE email = ?`, [hash, email.toLowerCase().trim()])
    console.log('✓ Password updated.')
  } else {
    closeDatabase()
    process.exit(1)
  }
} finally {
  closeDatabase()
}

process.exit(0)
