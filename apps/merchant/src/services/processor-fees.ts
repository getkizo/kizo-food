/**
 * Processor Fee Sweep
 *
 * Nightly job that fetches Finix processor fees (interchange + assessment +
 * processor markup) for card-present transfers and stores the total on
 * `payments.processor_fee_cents`. The merchant uses this to understand
 * effective per-transaction cost in the dashboard's payments tab and reports.
 *
 * Timing notes:
 *   - Finix populates `Fee` records during settlement, typically 24h+ after
 *     the transfer's SUCCEEDED state. Polling sooner returns an empty list.
 *   - We mark a row as "fetched" only when at least one fee record exists.
 *     If the response is empty, we leave processor_fee_cents NULL and try
 *     again the next night.
 *   - Only payments older than 24h with a finix_transfer_id and missing fee
 *     are candidates. Refunds are skipped (their fee handling is fuzzier and
 *     "good enough" doesn't require it).
 *
 * Cadence:
 *   - Initial run 60s after server start (so other startup work completes).
 *   - Then every 24h. The appliance is always on; no cron dependency.
 *   - Sequential calls with a small delay so we never burst Finix's rate limit.
 */

import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { listFeesByTransfer } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { logger } from '../utils/logger'

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000  // 24h
const INITIAL_DELAY_MS  = 60_000            // 60s after startup
const PER_CALL_DELAY_MS = 100               // gentle pacing between Finix calls
const MIN_PAYMENT_AGE_HOURS = 24            // wait at least 24h before first attempt

let _sweepRunning = false

/**
 * Loads Finix credentials for a merchant. Returns null when not configured.
 * Local copy of the loader pattern used in services/reconcile.ts and
 * routes/dashboard-payments.ts so this service has no cross-module coupling.
 */
async function loadFinixCreds(merchantId: string): Promise<FinixCredentials | null> {
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return null

  const db = getDatabase()
  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
        WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`,
    )
    .get(merchantId)

  const parts = keyRow?.pos_merchant_id?.split(':') ?? []
  if (parts.length !== 3) return null

  const merchantRow = db
    .query<{ finix_sandbox: number }, [string]>(
      `SELECT finix_sandbox FROM merchants WHERE id = ?`,
    )
    .get(merchantId)
  const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

  return {
    apiUsername:   parts[0],
    applicationId: parts[1],
    merchantId:    parts[2],
    apiPassword,
    sandbox,
  }
}

/**
 * Sweeps unfilled processor fees across all merchants on the appliance.
 * Per-payment errors are logged but do not abort the sweep.
 */
async function sweepUnfilledProcessorFees(): Promise<void> {
  const db = getDatabase()

  type Candidate = {
    payment_id:        string
    merchant_id:       string
    finix_transfer_id: string
  }

  const candidates = db
    .query<Candidate, []>(
      `SELECT id AS payment_id, merchant_id, finix_transfer_id
         FROM payments
        WHERE processor_fee_cents IS NULL
          AND finix_transfer_id IS NOT NULL
          AND finix_transfer_id != ''
          AND created_at < datetime('now', '-${MIN_PAYMENT_AGE_HOURS} hours')
        ORDER BY created_at ASC
        LIMIT 500`,
    )
    .all()

  if (candidates.length === 0) {
    logger.info('[processor-fees]', 'No payments awaiting fee data')
    return
  }

  logger.info('[processor-fees]', `Sweeping ${candidates.length} payment(s) for fee data`)

  // Cache credentials per merchant within a single sweep.
  const credsCache = new Map<string, FinixCredentials | null>()

  let filled = 0
  let pending = 0
  let errored = 0

  for (const row of candidates) {
    let creds = credsCache.get(row.merchant_id)
    if (creds === undefined) {
      creds = await loadFinixCreds(row.merchant_id)
      credsCache.set(row.merchant_id, creds)
    }
    if (!creds) {
      // Merchant doesn't have Finix configured — nothing to fetch ever; mark 0 so
      // we stop re-querying. (Defensive: shouldn't happen since the row has a
      // finix_transfer_id, but guard against an admin removing the key.)
      db.run(
        `UPDATE payments SET processor_fee_cents = 0 WHERE id = ?`,
        [row.payment_id],
      )
      continue
    }

    try {
      const result = await listFeesByTransfer(creds, row.finix_transfer_id)
      if (result.settled) {
        db.run(
          `UPDATE payments SET processor_fee_cents = ? WHERE id = ?`,
          [result.totalCents, row.payment_id],
        )
        filled++
      } else {
        // Fees not yet ready — leave NULL, retry next sweep.
        pending++
      }
    } catch (err) {
      errored++
      logger.warn(
        '[processor-fees]',
        `Failed to fetch fees for ${row.payment_id} (transfer ${row.finix_transfer_id})`,
        { error: (err as Error)?.message ?? String(err) },
      )
    }

    // Pace ourselves so we don't trip Finix rate limits on a large backfill.
    await new Promise(resolve => setTimeout(resolve, PER_CALL_DELAY_MS))
  }

  logger.info(
    '[processor-fees]',
    `Sweep complete: ${filled} filled, ${pending} still pending, ${errored} errored`,
    { filled, pending, errored },
  )
}

/**
 * Starts the nightly processor-fee sweep. Returns a cleanup function.
 */
export function startProcessorFeeSweep(): () => void {
  if (process.env.NODE_ENV === 'test') return () => {}

  const runSweep = async () => {
    if (_sweepRunning) {
      logger.warn('[processor-fees]', 'Previous sweep still running — skipping tick')
      return
    }
    _sweepRunning = true
    try {
      await sweepUnfilledProcessorFees()
    } catch (err) {
      logger.error('[processor-fees]', 'Sweep crashed', { error: (err as Error)?.message ?? String(err) })
    } finally {
      _sweepRunning = false
    }
  }

  const initial = setTimeout(runSweep, INITIAL_DELAY_MS)
  const interval = setInterval(runSweep, SWEEP_INTERVAL_MS)

  return () => {
    clearTimeout(initial)
    clearInterval(interval)
  }
}

// Exported for the on-demand trigger and the unit tests
export { sweepUnfilledProcessorFees }
