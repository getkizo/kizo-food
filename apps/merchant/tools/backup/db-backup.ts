/**
 * Full SQLite database backup → S3
 *
 * Backs up both merchant.db and campaigns.db as binary snapshots.
 * Uses Bun's db.serialize() — WAL-safe hot backup, no downtime needed.
 *
 * S3 credentials are read from the `api_keys` table (key_type='cloud',
 * provider='s3') — the same config used by auto-backup.ts for daily orders.
 * The JSON stored there must have shape: { accessKeyId, secretAccessKey, bucket, region }.
 *
 * S3 key layout:
 *   {merchant-slug}/db-backups/merchant/YYYY-MM-DD.db
 *   {merchant-slug}/db-backups/campaigns/YYYY-MM-DD.db
 *
 * Run manually:  bun --env-file .env run tools/backup/db-backup.ts
 * Cron (3 AM):   managed by tools/backup/install.sh
 */

import { createHmac, createHash }   from 'node:crypto'
import { existsSync }                from 'node:fs'
import { Database }                  from 'bun:sqlite'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH      = process.env.DATABASE_PATH ?? './data/merchant.db'
const CAMPAIGNS_DB = '/var/lib/kizo/campaigns.db'

function log(msg: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ' ' + JSON.stringify(extra) : ''
  console.log(`${new Date().toISOString()} [db-backup] ${msg}${suffix}`)
}

function die(msg: string, err?: unknown): never {
  console.error(`${new Date().toISOString()} [db-backup] FATAL: ${msg}`, err ?? '')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// S3 SigV4 — binary PUT (Uint8Array body)
// ---------------------------------------------------------------------------

interface S3Config {
  accessKeyId:     string
  secretAccessKey: string
  bucket:          string
  region:          string
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

async function s3PutBinary(cfg: S3Config, key: string, body: Uint8Array): Promise<void> {
  const { accessKeyId, secretAccessKey, bucket, region } = cfg
  const host        = `${bucket}.s3.${region}.amazonaws.com`
  const path        = '/' + key.replace(/^\//, '')
  const contentType = 'application/octet-stream'

  const now       = new Date()
  const amzDate   = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`

  const signedHeaders    = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = ['PUT', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope  = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign     = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  const kSigning  = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const res = await fetch(`https://${host}${path}`, {
    method:  'PUT',
    headers: {
      Authorization:          `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type':         contentType,
      'x-amz-date':           amzDate,
      'x-amz-content-sha256': payloadHash,
    },
    body,
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`S3 PUT failed (${res.status}): ${text.slice(0, 300)}`)
  }
}

// ---------------------------------------------------------------------------
// Core: snapshot a SQLite file and upload it
// ---------------------------------------------------------------------------

async function backupDatabase(dbPath: string, s3Key: string, cfg: S3Config, label: string): Promise<void> {
  if (!existsSync(dbPath)) {
    log(`SKIP ${label} — not found`, { path: dbPath })
    return
  }

  log(`Snapshotting ${label}…`, { path: dbPath })
  const db       = new Database(dbPath, { readonly: true })
  const snapshot = db.serialize()   // WAL checkpoint + full binary copy
  db.close()

  const sizeMB = (snapshot.byteLength / 1_048_576).toFixed(2)
  log(`Uploading ${label} (${sizeMB} MB)…`, { key: s3Key })
  await s3PutBinary(cfg, s3Key, snapshot)
  log(`✓ ${label} done`, { bucket: cfg.bucket, key: s3Key, sizeMB })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('Backup run started')

  // Load S3 config via the application crypto layer (reads from api_keys table).
  // MASTER_KEY_PASSPHRASE must be in the environment for decryption to work.
  const { initializeMasterKey } = await import('../../src/crypto/master-key')
  const { getAPIKey }           = await import('../../src/crypto/api-keys')

  await initializeMasterKey()   // derives master key from MASTER_KEY_PASSPHRASE env var

  const metaDb   = new Database(DB_PATH, { readonly: true })
  const merchant = metaDb
    .query<{ id: string; slug: string }, []>(
      `SELECT id, slug FROM merchants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`
    )
    .get()
  metaDb.close()

  if (!merchant) die('No active merchant found in database.')

  const raw = await getAPIKey(merchant.id, 'cloud', 's3')
  if (!raw) {
    die(
      `No S3 config for merchant ${merchant.id}. ` +
      `Configure it via Dashboard → Settings → Cloud Backup (S3).`
    )
  }

  let cfg: S3Config
  try {
    cfg = JSON.parse(raw) as S3Config
  } catch {
    die('S3 config in api_keys is not valid JSON.')
  }

  const today  = new Date().toISOString().slice(0, 10)
  const prefix = merchant.slug

  await backupDatabase(DB_PATH,      `${prefix}/db-backups/merchant/${today}.db`,  cfg, 'merchant.db')
  await backupDatabase(CAMPAIGNS_DB, `${prefix}/db-backups/campaigns/${today}.db`, cfg, 'campaigns.db')

  log('Backup run complete ✓')
}

main().catch((err) => {
  console.error(new Date().toISOString(), '[db-backup] UNHANDLED ERROR', err)
  process.exit(1)
})
