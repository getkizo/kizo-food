/**
 * Playwright globalTeardown — removes the test DB and cache after all specs finish.
 */

import { unlink, rm }    from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))

export default async function globalTeardown() {
  const dbPath = resolve(__dir, 'test.db')

  // Remove SQLite WAL artefacts
  for (const suffix of ['', '-wal', '-shm']) {
    try { await unlink(dbPath + suffix) } catch { /* already gone */ }
  }

  // Remove world cache
  try {
    await rm(resolve(__dir, '.cache'), { recursive: true, force: true })
  } catch { /* ignore */ }

  console.log('[globalTeardown] Test DB and cache removed.')
}
