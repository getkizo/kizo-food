/**
 * Seed supplier receipts from docs/GOGS/ OCR output files.
 *
 * Usage:
 *   DATABASE_PATH=/path/to/kizo.db \
 *   MASTER_KEY_PASSPHRASE=<passphrase> \
 *   bun run v2/scripts/seed-gogs-receipts.ts
 *
 * The script is idempotent: receipts already in the DB (matched by
 * document_number + vendor_name) are skipped.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { closeDatabase, getDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

/** Collect all *.json files recursively under a directory. */
function collectJsonFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectJsonFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Per-vendor field normalisation
// (GOGS files are raw OCR output; field names vary by vendor format)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractVendorName(raw: any): string {
  return (
    raw?.vendor?.name ||
    raw?.merchant?.name ||
    'Unknown Vendor'
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDocumentNumber(raw: any): string | null {
  return (
    raw?.invoice_number ||
    raw?.transaction?.invoice_number ||
    raw?.transaction?.transaction_number ||
    null
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReceiptDate(raw: any): string | null {
  return (
    raw?.invoice_date ||
    raw?.transaction?.date ||
    null
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTotals(raw: any): { subtotal: number | null; taxAmount: number | null; total: number } {
  const t = raw?.totals ?? {}
  const subtotal = t.subtotal ?? t.sub_total ?? t.net_sales ?? null
  const taxAmount = t.tax ?? t.total_tax ?? null
  const total = t.total ?? t.total_sales ?? 0
  return {
    subtotal: typeof subtotal === 'number' ? subtotal : null,
    taxAmount: typeof taxAmount === 'number' ? taxAmount : null,
    total: typeof total === 'number' ? total : 0,
  }
}

interface NormalisedLineItem {
  description: string
  quantity: number | null
  unit: string | null
  unitPrice: number | null
  totalPrice: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normaliseLineItems(raw: any): NormalisedLineItem[] {
  if (!Array.isArray(raw?.line_items)) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (raw.line_items as any[]).flatMap((item): NormalisedLineItem[] => {
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    if (!description) return []

    // Quantity: prefer numeric fields, then parse string quantity fields.
    // City Produce uses two formats:
    //   Simple:   `qty: "3.56 LB"` (weight items)
    //   Compound: `qty: "1CS 0DZ"` / `qty: "0CS 6.04LB"` (case/sack items).
    // Older City Produce receipts use `ordered`/`shipped` with the same formats.
    // For compound "NCS XLBU" strings, pick whichever component is non-zero.
    let quantity: number | null = null
    let parsedUnit: string | null = null

    /** Parse "1CS 0DZ", "0CS 6.04LB", "3.56 LB", "35 LB" → [qty, UNIT] | null */
    const parseQtyString = (s: string): [number, string] | null => {
      // Match first component
      const m1 = s.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)/i)
      if (!m1) return null
      const n1 = Number(m1[1]); const u1 = m1[2].toUpperCase()
      // Try second component (compound: "1CS 0DZ" / "0CS 6.04LB")
      const m2 = s.slice(m1[0].length).match(/^\s+(\d+(?:\.\d+)?)\s*([A-Za-z]+)/i)
      if (m2) {
        const n2 = Number(m2[1]); const u2 = m2[2].toUpperCase()
        // Prefer the non-zero component; if first is non-zero take first (e.g. "1CS 0DZ" → 1 CS)
        return n1 > 0 ? [n1, u1] : n2 > 0 ? [n2, u2] : [n1, u1]
      }
      return [n1, u1]
    }

    // When multiple string sources exist (ordered + shipped + qty), pick the one
    // whose parsed quantity × vendor unit_price is closest to line_total.
    // This rejects OCR errors in the `ordered` field (City Produce sometimes
    // mis-reads ordered qty while the `shipped` qty always matches the invoice).
    const vendorUnitPrice = typeof item.unit_price === 'number' ? item.unit_price : null
    const vendorLineTotal = typeof item.line_total === 'number' ? item.line_total
                          : typeof item.amount === 'number'     ? item.amount : null

    if (typeof item.quantity === 'number') quantity = item.quantity
    else if (typeof item.qty === 'number') quantity = item.qty
    else if (typeof item.qty === 'string' && !isNaN(Number(item.qty))) quantity = Number(item.qty)
    else {
      // Collect all candidate quantity strings; prefer shipped → ordered → qty
      const candidates: string[] = []
      if (typeof item.shipped  === 'string') candidates.push(item.shipped)
      if (typeof item.ordered  === 'string') candidates.push(item.ordered)
      if (typeof item.qty      === 'string') candidates.push(item.qty)

      let bestQty: number | null = null
      let bestUnit: string | null = null
      let bestError = Infinity

      for (const str of candidates) {
        const parsed = parseQtyString(str)
        if (!parsed || parsed[0] <= 0) continue
        const [q, u] = parsed
        // Score by how closely q × vendorUnitPrice matches line_total
        const err = (vendorUnitPrice && vendorLineTotal)
          ? Math.abs(q * vendorUnitPrice - vendorLineTotal) / vendorLineTotal
          : Infinity
        if (err < bestError || (bestQty === null && err === Infinity)) {
          bestError = err; bestQty = q; bestUnit = u
        }
      }
      quantity = bestQty; parsedUnit = bestUnit
    }

    // Unit: explicit field takes priority over unit parsed from qty string
    const unit: string | null = typeof item.unit === 'string' ? item.unit : parsedUnit

    // Total price: line_total > amount > price (when qty=1)
    // Resolved before unit price so we can use it to compute per-ordered-unit cost.
    let totalPrice = 0
    const haExplicitTotal = typeof item.line_total === 'number' || typeof item.amount === 'number'
    if (typeof item.line_total === 'number') totalPrice = item.line_total
    else if (typeof item.amount === 'number') totalPrice = item.amount
    else if (typeof item.price === 'number') totalPrice = item.price

    // Unit price: when an explicit line total is present and quantity > 0, derive
    // the per-ordered-unit cost from line_total / quantity.  This is always correct
    // regardless of the sub-unit the vendor uses for their unit_price field
    // (e.g. City Produce reports unit_price per dozen for a case of eggs, but we
    // want to track cost per case — line_total / 1 CS = $21.00, not $1.40/DZ).
    let unitPrice: number | null = null
    if (haExplicitTotal && totalPrice > 0 && quantity !== null && quantity > 0) {
      unitPrice = Math.round((totalPrice / quantity) * 10000) / 10000
    } else if (typeof item.unit_price === 'number') {
      unitPrice = item.unit_price
    } else if (typeof item.rate === 'number') {
      unitPrice = item.rate
    } else if (typeof item.price === 'number') {
      // Costco-style: price is both unit and line total when qty=1
      unitPrice = (quantity === null || quantity === 1) ? item.price : null
    }

    return [{ description, quantity, unit, unitPrice, totalPrice }]
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Allow overriding the GOGS directory via env
  const gogsDir = process.env.GOGS_DIR ?? join(process.cwd(), '..', 'docs', 'GOGS')

  console.log('[seed-gogs] Initialising database …')
  await migrate()
  await initializeMasterKey()

  const db = getDatabase()

  // Find the first active merchant
  const merchant = db.query<{ id: string; business_name: string }, []>(
    `SELECT id, business_name FROM merchants WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`,
  ).get()

  if (!merchant) {
    console.error('[seed-gogs] No active merchant found — run the server once to onboard first.')
    process.exit(1)
  }

  console.log(`[seed-gogs] Merchant: ${merchant.business_name} (${merchant.id})`)

  const files = collectJsonFiles(gogsDir)
  console.log(`[seed-gogs] Found ${files.length} JSON files in ${gogsDir}`)

  let inserted = 0
  let skipped  = 0
  let errors   = 0

  for (const filePath of files) {
    const filename = basename(filePath)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch {
      console.warn(`  [skip] ${filename} — JSON parse error`)
      errors++
      continue
    }

    if (typeof raw !== 'object' || raw === null) {
      console.warn(`  [skip] ${filename} — not an object`)
      errors++
      continue
    }

    const vendorName     = extractVendorName(raw)
    const docType        = (raw as Record<string, unknown>).document_type as string ?? 'receipt'
    const documentType   = ['receipt', 'invoice', 'unknown'].includes(docType) ? docType : 'receipt'
    const documentNumber = extractDocumentNumber(raw)
    const receiptDate    = extractReceiptDate(raw)
    const { subtotal, taxAmount, total } = extractTotals(raw)
    const lineItems      = normaliseLineItems(raw)
    const ocrName        = filename.replace(/\.json$/, '')

    // Idempotency: skip if we already have this receipt
    const exists = db.query<{ id: string }, [string, string, string]>(
      `SELECT id FROM supplier_receipts
        WHERE merchant_id = ? AND (
          (document_number IS NOT NULL AND document_number = ?)
          OR ocr_name = ?
        )
        LIMIT 1`,
    ).get(merchant.id, documentNumber ?? '', ocrName)

    if (exists) {
      skipped++
      continue
    }

    if (lineItems.length === 0) {
      console.warn(`  [skip] ${filename} — no line items`)
      skipped++
      continue
    }

    const receiptId = generateId('srec')

    try {
      db.transaction(() => {
        db.run(
          `INSERT INTO supplier_receipts
             (id, merchant_id, ocr_name, vendor_name, vendor_tax_id, document_type,
              document_number, receipt_date, subtotal, tax_amount, total, currency,
              raw_json, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, NULL)`,
          [
            receiptId, merchant.id, ocrName, vendorName, null, documentType,
            documentNumber, receiptDate, subtotal, taxAmount, total,
            JSON.stringify(raw),
          ],
        )

        for (const item of lineItems) {
          const lowerDesc = item.description.toLowerCase()

          // Auto-match: exact name/display_name, then learned aliases
          const matched = db.query<{ id: string }, [string, string, string, string, string]>(
            `SELECT id FROM extra_ingredients
              WHERE merchant_id = ?
                AND (LOWER(name) = ? OR LOWER(display_name) = ?)
             UNION
             SELECT ingredient_id AS id FROM ingredient_aliases
              WHERE merchant_id = ? AND LOWER(alias_text) = ?
                AND ingredient_id IS NOT NULL
             LIMIT 2`,
          ).all(merchant.id, lowerDesc, lowerDesc, merchant.id, lowerDesc)

          const ingredientId = matched.length === 1 ? matched[0].id : null
          const autoMatched  = ingredientId !== null ? 1 : 0

          db.run(
            `INSERT INTO receipt_line_items
               (id, supplier_receipt_id, merchant_id, description, quantity, unit,
                unit_price, total_price, category, ingredient_id, auto_matched)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [
              generateId('rli'), receiptId, merchant.id,
              item.description, item.quantity, item.unit,
              item.unitPrice, item.totalPrice,
              ingredientId, autoMatched,
            ],
          )
        }
      })()

      console.log(`  [ok] ${filename} — ${lineItems.length} items (vendor: ${vendorName}, date: ${receiptDate ?? '?'})`)
      inserted++
    } catch (err) {
      console.error(`  [err] ${filename} —`, err instanceof Error ? err.message : err)
      errors++
    }
  }

  closeDatabase()

  console.log()
  console.log(`[seed-gogs] Done.  inserted=${inserted}  skipped=${skipped}  errors=${errors}`)
}

main().catch(err => {
  console.error('[seed-gogs] Fatal:', err)
  process.exit(1)
})
