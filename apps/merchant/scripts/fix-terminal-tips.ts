/**
 * fix-terminal-tips.ts
 *
 * One-time script to backfill tip_cents (and correct amount_cents) for two
 * terminal payments where the tip collected on the PAX device was not recorded.
 *
 * Root cause: when tip_on_terminal was false (or the fix hadn't been deployed),
 * _tipCents stayed at 0 in the payment modal. The record-payment call then sent:
 *   totalCents = subtotal + tax + 0  ← missing the tip
 *   tipCents   = 0                   ← wrong
 *
 * So BOTH payments.amount_cents and payments.tip_cents are wrong for these records.
 * Finix is the source of truth: status.amount = actual charge, status.tipAmountCents = tip.
 *
 * Preferred usage (auto-fetches amounts from Finix):
 *   cd v2 && bun run scripts/fix-terminal-tips.ts
 *
 * Fallback usage (if Finix API unavailable, pass amounts from Finix dashboard directly):
 *   TIP_TRmUkhn6Vi3iuYunm8sTbVEs=26 AMT_TRmUkhn6Vi3iuYunm8sTbVEs=126 \
 *   TIP_TRqSLtq1nBzeZsHT4Bvm1qCs=1486 AMT_TRqSLtq1nBzeZsHT4Bvm1qCs=7286 \
 *     bun run scripts/fix-terminal-tips.ts
 *   (Env var names: TIP_<transferId> and AMT_<transferId>, values in cents)
 *
 * Transfers to fix:
 *   TRmUkhn6Vi3iuYunm8sTbVEs  — $1.26 Finix total (tip_on_terminal was false in DB at time)
 *   TRqSLtq1nBzeZsHT4Bvm1qCs  — $72.86 Finix total (tip collected on device, not captured)
 */

import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { initializeMasterKey } from '../src/crypto/master-key'
import { getAPIKey } from '../src/crypto/api-keys'
import { getTerminalTransferStatus } from '../src/adapters/finix'
import type { FinixCredentials } from '../src/adapters/finix'

const TRANSFER_IDS = [
  'TRmUkhn6Vi3iuYunm8sTbVEs',
  'TRqSLtq1nBzeZsHT4Bvm1qCs',
]

async function main() {
  const dbPath = process.env.DATABASE_PATH || join(process.cwd(), 'data', 'merchant.db')
  console.log(`Opening DB: ${dbPath}`)
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode=WAL')

  // ── Find the merchant (first active merchant) ─────────────────────────────
  const merchant = db
    .query<{ id: string; finix_sandbox: number }, []>(
      `SELECT id, finix_sandbox FROM merchants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`
    )
    .get()

  if (!merchant) {
    console.error('No active merchant found in DB')
    process.exit(1)
  }
  console.log(`Merchant: ${merchant.id} (sandbox=${merchant.finix_sandbox})`)

  // ── Initialize master key (required to decrypt API keys) ─────────────────
  const passphrase = process.env.MASTER_KEY_PASSPHRASE
  if (passphrase) {
    try {
      await initializeMasterKey(passphrase)
    } catch (err) {
      console.warn(`Master key init failed: ${(err as Error)?.message}`)
    }
  }

  // ── Try to load Finix credentials ─────────────────────────────────────────
  let creds: FinixCredentials | null = null
  try {
    const apiPassword = await getAPIKey(merchant.id, 'payment', 'finix').catch(() => null)
    if (apiPassword) {
      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`
        )
        .get(merchant.id)
      const parts = (keyRow?.pos_merchant_id ?? '').split(':')
      if (parts.length === 3) {
        creds = {
          apiUsername:    parts[0],
          applicationId: parts[1],
          merchantId:    parts[2],
          apiPassword,
          sandbox:       (merchant.finix_sandbox ?? 1) !== 0,
        }
        console.log(`Finix credentials loaded (sandbox=${creds.sandbox})`)
      }
    }
  } catch {}

  if (!creds) {
    console.warn('Finix credentials not available — will use TIP_/AMT_ env vars if set')
  }

  // ── Process each transfer ─────────────────────────────────────────────────
  for (const transferId of TRANSFER_IDS) {
    console.log(`\n── Transfer ${transferId} ──`)

    // Find the payment record by finix_transfer_id or transaction_id
    const payment = db
      .query<{
        id: string
        order_id: string
        amount_cents: number
        subtotal_cents: number
        tax_cents: number
        tip_cents: number
        amex_surcharge_cents: number
      }, [string, string]>(
        `SELECT id, order_id, amount_cents, subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents
         FROM payments WHERE finix_transfer_id = ? OR transaction_id = ?`
      )
      .get(transferId, transferId)

    if (!payment) {
      console.warn(`  No payment record found for transfer ${transferId} — skipping`)
      continue
    }
    console.log(`  Payment record : ${payment.id}`)
    console.log(`  Order          : ${payment.order_id}`)
    console.log(`  Current DB     : amount=${payment.amount_cents}¢  subtotal=${payment.subtotal_cents}¢  tax=${payment.tax_cents}¢  tip=${payment.tip_cents}¢`)

    // ── Determine correct amounts ─────────────────────────────────────────
    let correctAmountCents: number | null = null
    let correctTipCents: number | null = null

    // 1. Try Finix API
    if (creds) {
      try {
        const status = await getTerminalTransferStatus(creds, transferId)
        console.log(`  Finix response : state=${status.state}  amount=${status.amount}¢  tip=${status.tipAmountCents}¢`)
        if (status.state === 'SUCCEEDED') {
          correctAmountCents = status.amount
          correctTipCents    = status.tipAmountCents
        } else {
          console.warn(`  Transfer state is ${status.state} (not SUCCEEDED) — skipping Finix source`)
        }
      } catch (err) {
        console.warn(`  Finix API call failed: ${(err as Error)?.message}`)
      }
    }

    // 2. Fallback: env vars TIP_<transferId> and AMT_<transferId>
    if (correctTipCents === null) {
      const tipEnv = process.env[`TIP_${transferId}`]
      const amtEnv = process.env[`AMT_${transferId}`]
      if (tipEnv) {
        correctTipCents    = parseInt(tipEnv, 10)
        correctAmountCents = amtEnv ? parseInt(amtEnv, 10) : null
        console.log(`  Using env vars: tip=${correctTipCents}¢  amount=${correctAmountCents ?? '(not set)'}¢`)
      }
    }

    // 3. If amount still not set, infer from tip + existing subtotal/tax/surcharge
    if (correctTipCents !== null && correctAmountCents === null) {
      correctAmountCents = payment.subtotal_cents + payment.tax_cents + correctTipCents + payment.amex_surcharge_cents
      console.warn(`  Inferred amount from subtotal+tax+tip+surcharge: ${correctAmountCents}¢`)
    }

    if (correctTipCents === null) {
      console.warn(`  Cannot determine tip amounts — set TIP_${transferId}=<cents> and re-run`)
      continue
    }

    // ── Sanity check ──────────────────────────────────────────────────────
    if (correctTipCents === payment.tip_cents && correctAmountCents === payment.amount_cents) {
      console.log(`  Already correct (tip=${correctTipCents}¢, amount=${correctAmountCents}¢) — nothing to do`)
      continue
    }

    console.log(`  Applying fix   : tip ${payment.tip_cents}¢ → ${correctTipCents}¢  |  amount ${payment.amount_cents}¢ → ${correctAmountCents}¢`)

    // ── Apply the fix ──────────────────────────────────────────────────────
    db.exec('BEGIN')
    try {
      // 1. Update payment record
      db.run(
        `UPDATE payments SET tip_cents = ?, amount_cents = ? WHERE id = ?`,
        [correctTipCents, correctAmountCents, payment.id]
      )

      // 2. Recalculate order-level tip_cents and paid_amount_cents from all legs
      const orderTotals = db
        .query<{ total_tips: number; total_paid: number }, [string]>(
          `SELECT COALESCE(SUM(tip_cents), 0)    AS total_tips,
                  COALESCE(SUM(amount_cents), 0) AS total_paid
           FROM payments WHERE order_id = ?`
        )
        .get(payment.order_id)

      const totalTips = orderTotals?.total_tips ?? correctTipCents
      const totalPaid = orderTotals?.total_paid ?? correctAmountCents
      console.log(`  Order totals   : tip=${totalTips}¢  paid=${totalPaid}¢`)

      db.run(
        `UPDATE orders SET tip_cents = ?, paid_amount_cents = ? WHERE id = ?`,
        [totalTips, totalPaid, payment.order_id]
      )

      db.exec('COMMIT')
      console.log(`  ✓ Fixed`)
    } catch (err) {
      db.exec('ROLLBACK')
      console.error(`  ✗ DB update failed: ${(err as Error)?.message}`)
    }
  }

  console.log('\nDone.')
  db.close()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
