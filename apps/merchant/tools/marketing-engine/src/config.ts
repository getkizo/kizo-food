/** Runtime configuration — all tenant-specific values come from env vars, never hardcoded. */

export const config = {
  port:            Number(process.env.PORT ?? 3100),
  hostname:        process.env.HOST ?? '127.0.0.1',
  dbPath:          process.env.DB_PATH ?? '/var/lib/kizo/campaigns.db',
  defaultRedirect: process.env.DEFAULT_REDIRECT ?? 'https://demo-restaurant.kizo.example',
  sessionSecret:   process.env.SESSION_SECRET ?? (() => { throw new Error('SESSION_SECRET is required') })(),
  /** Kizo internal sync endpoint */
  baabanSyncUrl:   process.env.KIZO_SYNC_URL ?? 'http://localhost:3000/internal/campaigns/sync',
  baabanSyncToken: process.env.KIZO_SYNC_TOKEN ?? '',
  /** Alert: call Kizo internal alert endpoint (which uses existing SMTP) */
  baabanAlertUrl:  process.env.KIZO_ALERT_URL ?? 'http://localhost:3000/internal/campaigns/alert',
  baabanAlertToken: process.env.KIZO_ALERT_TOKEN ?? '',
  /** Scan rate threshold — auto-pause campaign if scans exceed this per minute globally */
  globalScanRateLimit: Number(process.env.GLOBAL_SCAN_RATE_LIMIT ?? 1000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const

export type Config = typeof config
