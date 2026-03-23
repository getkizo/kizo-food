/**
 * Structured logging utility.
 *
 * Emits JSON lines to stdout (info/debug/warn) or stderr (error).
 * Log level is controlled by the LOG_LEVEL environment variable (default: 'info').
 *
 * Usage:
 *   import { logger } from '../utils/logger'
 *   logger.info('[store]', 'Order received', { orderId })
 *   logger.error('[auth]', 'Token verification failed', err)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel

function log(level: LogLevel, label: string, msg: string, data?: unknown): void {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    label,
    msg,
    ...(data !== undefined ? { data } : {}),
  })

  if (level === 'error') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

export const logger = {
  /** Verbose debug output — suppressed in production unless LOG_LEVEL=debug */
  debug: (label: string, msg: string, data?: unknown) => log('debug', label, msg, data),
  /** Normal operational events */
  info:  (label: string, msg: string, data?: unknown) => log('info',  label, msg, data),
  /** Recoverable problems or unexpected conditions */
  warn:  (label: string, msg: string, data?: unknown) => log('warn',  label, msg, data),
  /** Errors requiring attention */
  error: (label: string, msg: string, data?: unknown) => log('error', label, msg, data),
}
