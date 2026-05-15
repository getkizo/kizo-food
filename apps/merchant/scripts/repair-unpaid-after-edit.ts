/**
 * repair-unpaid-after-edit.ts
 *
 * One-shot repair for orders demoted from 'paid' → 'received' by the pre-fix
 * PATCH /orders/:orderId bug (commit 8e08180, Bug #3). That code contained
 *
 *   status = CASE WHEN status IN ('cancelled','picked_up','completed','paid')
 *                 THEN 'received' ELSE status END
 *
 * so any staff edit to a paid order reset its status and overwrote total_cents
 * with subtotal_cents (dropping tax/tip). The payments row was untouched, so
 * the truth can be rebuilt from it.
 *
 * Usage:
 *   cd v2 && bun run scripts/repair-unpaid-after-edit.ts <order-id-prefix>
 *
 *   # dry run (default — print the plan, no writes)
 *   bun run scripts/repair-unpaid-after-edit.ts 112c6345
 *
 *   # apply
 *   bun run scripts/repair-unpaid-after-edit.ts 112c6345 --apply
 *
 * The prefix matches against orders.id with `LIKE 'ord_<prefix>%'`. Exactly one
 * order must match or the script aborts.
 */

import { Database } from 'bun:sqlite'
import { join } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const prefix = args.find(a => !a.startsWith('--'))

if (!prefix) {
  console.error('Usage: bun run scripts/repair-unpaid-after-edit.ts <order-id-prefix> [--apply]')
  process.exit(1)
}

const dbPath = join(import.meta.dir, '..', 'data', 'merchant.db')
const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true })

type OrderRow = {
  id: string
  merchant_id: string
  status: string
  subtotal_cents: number | null
  tax_cents: number | null
  tip_cents: number | null
  total_cents: number | null
  paid_amount_cents: number | null
  payment_method: string | null
}
const orders = db.query<OrderRow, [string]>(
  `SELECT id, merchant_id, status, subtotal_cents, tax_cents, tip_cents,
          total_cents, paid_amount_cents, payment_method
     FROM orders WHERE id LIKE ?`,
).all(`ord_${prefix}%`)

if (orders.length === 0) {
  console.error(`No order matches prefix "ord_${prefix}%"`)
  process.exit(1)
}
if (orders.length > 1) {
  console.error(`Prefix "ord_${prefix}%" matches ${orders.length} orders — be more specific:`)
  for (const o of orders) console.error(`  ${o.id}`)
  process.exit(1)
}

const order = orders[0]!

type PaymentRow = {
  id: string
  amount_cents: number
  subtotal_cents: number | null
  tax_cents: number | null
  tip_cents: number | null
  payment_type: string
  processor: string | null
}
const payments = db.query<PaymentRow, [string]>(
  `SELECT id, amount_cents, subtotal_cents, tax_cents, tip_cents, payment_type, processor
     FROM payments WHERE order_id = ? ORDER BY created_at ASC`,
).all(order.id)

if (payments.length === 0) {
  console.error(`Order ${order.id} has no payments row — nothing to repair from.`)
  process.exit(1)
}

// Sum payment-row amounts so split payments reconcile correctly.
const p = {
  amount_cents:   payments.reduce((s, r) => s + r.amount_cents,              0),
  subtotal_cents: payments.reduce((s, r) => s + (r.subtotal_cents ?? 0),     0),
  tax_cents:      payments.reduce((s, r) => s + (r.tax_cents      ?? 0),     0),
  tip_cents:      payments.reduce((s, r) => s + (r.tip_cents      ?? 0),     0),
  payment_type:   payments[0]!.payment_type,
}

const newStatus        = 'paid'
const newTaxCents      = p.tax_cents > 0 ? p.tax_cents : (order.tax_cents ?? 0)
const newTipCents      = p.tip_cents
const newTotalCents    = p.amount_cents
const newPaidCents     = p.amount_cents
const newPaymentMethod = p.payment_type === 'card' ? 'card' : p.payment_type

console.log(`Order ${order.id}  (merchant ${order.merchant_id})`)
console.log(`  payments: ${payments.length} row(s)${payments.length > 1 ? ' — split legs summed' : ''}`)
console.log()
console.log(`                    current         →  repaired`)
console.log(`  status:           ${order.status.padEnd(15)} →  ${newStatus}`)
console.log(`  tax_cents:        ${String(order.tax_cents ?? 0).padEnd(15)} →  ${newTaxCents}`)
console.log(`  tip_cents:        ${String(order.tip_cents ?? 0).padEnd(15)} →  ${newTipCents}`)
console.log(`  total_cents:      ${String(order.total_cents ?? 0).padEnd(15)} →  ${newTotalCents}`)
console.log(`  paid_amount:      ${String(order.paid_amount_cents ?? 0).padEnd(15)} →  ${newPaidCents}`)
console.log(`  payment_method:   ${String(order.payment_method ?? 'null').padEnd(15)} →  ${newPaymentMethod}`)
console.log()

if (order.status === 'paid') {
  console.log('Order is already paid — no changes needed.')
  process.exit(0)
}

if (!apply) {
  console.log('Dry run. Re-run with --apply to write changes.')
  process.exit(0)
}

db.run(
  `UPDATE orders
      SET status            = ?,
          tax_cents         = ?,
          tip_cents         = ?,
          total_cents       = ?,
          paid_amount_cents = ?,
          payment_method    = ?,
          updated_at        = datetime('now')
    WHERE id = ?`,
  [newStatus, newTaxCents, newTipCents, newTotalCents, newPaidCents, newPaymentMethod, order.id],
)

console.log(`✓ Order ${order.id} repaired.`)
