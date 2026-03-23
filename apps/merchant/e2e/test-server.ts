/**
 * E2E test server — starts the Kizo appliance on port 3099 with a
 * fresh SQLite database. Invoked by Playwright's webServer config.
 *
 * Runs a minimal subset of server.ts startup (no auto-fire, no S3 backup,
 * no Puppeteer renderer) sufficient for store API + dashboard API e2e tests.
 */

import { resolve, dirname }       from 'node:path'
import { fileURLToPath }          from 'node:url'
import { unlink }                 from 'node:fs/promises'

const __dir = dirname(fileURLToPath(import.meta.url))
const dbPath = resolve(__dir, 'test.db')

// Remove stale DB from a previous interrupted run
try { await unlink(dbPath) } catch { /* first run — nothing to remove */ }

// Set env BEFORE importing any server modules so DB path, JWT secret, etc.
// are picked up by their lazy-init getters.
process.env.PORT                  = '3099'
process.env.DATABASE_PATH         = dbPath
// TEST-ONLY values — no connection to production credentials. The ephemeral
// test DB (`e2e/test.db`) is created and deleted on each run. Static analysis
// tools flagging these as leaked secrets are false positives; the values are
// intentionally hardcoded here for deterministic, reproducible test runs.
process.env.MASTER_KEY_PASSPHRASE = 'TEST_ONLY_e2e-master-key-passphrase-abc!'
process.env.JWT_SECRET            = 'TEST_ONLY_e2e-jwt-secret-min-32-characters!!'
process.env.NODE_ENV              = 'test'
process.env.SERVER_BIND           = '127.0.0.1'

// Lazy-import AFTER env vars are set
const [{ app }, { migrate }, { initializeMasterKey }] = await Promise.all([
  import('../src/server'),
  import('../src/db/migrate'),
  import('../src/crypto/master-key'),
])

await migrate()
await initializeMasterKey()

Bun.serve({
  port:     3099,
  hostname: '127.0.0.1',
  fetch:    app.fetch,
})

console.log('✅ E2E test server listening on http://127.0.0.1:3099')
