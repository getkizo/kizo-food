/**
 * Manager App — Phase 1 backend routes
 *
 * All authenticated /api/merchants/:id/* routes require authenticate + requireOwnMerchant.
 * Manager-or-owner routes additionally use requireRole('manager', 'owner').
 * Owner-only routes use requireRole('owner').
 * Public routes (invite validate, location status) have no auth requirement.
 *
 * GET    /api/merchants/:id/manager/users                              owner     List active managers
 * POST   /api/merchants/:id/manager/invites                            owner     Create invite + send email
 * DELETE /api/merchants/:id/manager/users/:userId                      owner     Revoke manager access
 * GET    /api/manager/invites/validate?token=...                       public    Validate invite token
 *
 * POST   /api/merchants/:id/manager/receipts                           mgr|own   Upload + OCR proxy + persist
 * GET    /api/merchants/:id/manager/receipts                           mgr|own   List receipts
 * GET    /api/merchants/:id/manager/receipts/:receiptId                mgr|own   Single receipt + items
 * PATCH  /api/merchants/:id/manager/receipts/:receiptId                mgr|own   Edit header fields
 * PATCH  /api/merchants/:id/manager/receipts/:receiptId/items          mgr|own   Bulk replace line items (+ optional lock)
 * PATCH  /api/merchants/:id/manager/receipts/:receiptId/items/:itemId  mgr|own   Edit single line item
 * DELETE /api/merchants/:id/manager/receipts/:receiptId                owner     Delete receipt
 *
 * GET    /api/merchants/:id/manager/reports/cogs                       mgr|own   COGS spend trend
 * GET    /api/merchants/:id/manager/reports/vendors                    mgr|own   Vendor month-over-month spend
 * GET    /api/merchants/:id/manager/reports/order-warnings             mgr|own   Ingredient reorder warnings
 * GET    /api/merchants/:id/manager/reports/order-warnings/:id/snooze  mgr|own   Snooze warning
 *
 * GET    /api/merchants/:id/manager/ingredients/price-history?q=      mgr|own   Ingredient price search + 30-day chart
 * GET    /api/merchants/:id/manager/ingredients/price-snapshot         mgr|own   All ingredient prices for offline prefetch
 *
 * GET    /api/manager/location-status                                  mgr|own   { onsite: boolean }
 */

import { Hono } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { serverError } from '../utils/server-error'
import { isAllowedIp } from '../middleware/ip-allowlist'
import { getAPIKey } from '../crypto/api-keys'
import { buildSmtpTransport } from '../services/smtp'

const manager = new Hono()

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OCR_SERVICE_URL  = process.env.OCR_SERVICE_URL ?? 'http://127.0.0.1:8765'
const OCR_API_KEY      = process.env.OCR_API_KEY ?? ''
const APP_BASE_URL     = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
const NAME_RE          = /^[a-zA-Z0-9_-]{5,80}$/
const INVITE_TTL_HOURS = 72

// Deduplicates concurrent uploads of the same physical receipt.
// Bun is single-threaded so a plain Map is safe — if two requests arrive with
// the same content hash before either has inserted, the second awaits the first
// promise instead of firing a redundant OCR call that would hit the unique
// constraint and return 500.
type OcrResult = { receiptId: string; lineItems: OcrLineItem[] }
type OcrLineItem = {
  id: string; description: string; quantity: number | null; unit: string | null
  unitPrice: number | null; totalPrice: number; category: string | null
  ingredientId: string | null; autoMatched: boolean
}
const _ocrInFlight = new Map<string, Promise<OcrResult>>()

/**
 * Post-process raw OCR line items before persisting:
 *
 *   1. Drop rows whose description contains NO alphabetic characters.
 *      These are receipt-formatting artifacts such as Costco's "6 @ 4.59"
 *      quantity-notation rows that OCR mistakes for items. Keeping them
 *      produces phantom duplicates because the real item on the next line
 *      carries the same total price.
 *
 *   2. Auto-tag items with a negative total_price as category='discount'.
 *      Coupon / member-savings lines are valid data — we keep them but flag
 *      them so reports can exclude or group them correctly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanupOcrLineItems(items: any[]): any[] {
  return items
    .filter(item => /[a-zA-Z]/.test(String(item.description ?? '')))
    .map(item => {
      if (typeof item.total_price === 'number' && item.total_price < 0) {
        return { ...item, category: 'discount' }
      }
      return item
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generatePlainToken(): string {
  return randomBytes(32).toString('hex')
}

// ---------------------------------------------------------------------------
// Receipt-line description normalizer + ingredient auto-matcher
//
// OCR descriptions arrive with quantity prefixes ("10.24 lb red pepper 25#"),
// compound prefixes ("1 cs 0 dz eggs - medium bulk"), trailing size markers
// ("foo 25#" / "foo 6 top" / "foo - large"), and case suffixes ("- medium").
// The exact-match auto-linker would miss all of these. Normalize before
// looking up names / display_names / aliases.
// ---------------------------------------------------------------------------

/**
 * Strip OCR noise from a receipt line description to expose the underlying
 * ingredient name. Returns lowercase, trimmed.
 *
 * Order matters — compound prefixes must be tried before single-unit prefixes,
 * size suffixes are stripped after prefixes.
 */
export function normalizeReceiptDescription(desc: string): string {
  let d = String(desc ?? '').toLowerCase().trim()
  if (!d) return d

  // Compound prefix: "1 cs 0 dz eggs ..." → "eggs ..."
  // Pattern: <num> <outer-unit> <num> <inner-unit>
  d = d.replace(/^\d+\s+(?:cs|bg|bu|hd|sx|cse|case)\s+\d+\s*(?:dz|lb|oz|ea|pk|ct|pc)s?\.?\s+/i, '')

  // Single-unit quantity prefix: "10.24 lb red pepper" → "red pepper"
  // Covers: lb, oz, bg (bag), bu (bunch), cs (case), hd (head), sx, ea (each),
  // stk (stalks), dz (dozen), pk (pack), pc (piece), ct (count), case,
  // head, bunch, stalks, each.
  d = d.replace(
    /^\d+(?:\.\d+)?\s+(?:lb|oz|bg|bu|cs|hd|sx|ea|stk|dz|pk|pc|ct|cse|case|head|bunch(?:es)?|stalks?|each)s?\.?\s+/i,
    ''
  )

  // Trailing size markers:
  //   "foo 25#"         → "foo"          (case-size weight marker)
  //   "foo 25%"         → "foo"          (OCR error of 25#)
  //   "foo 6 top"       → "foo"          (count-per-box style)
  //   "foo - large"     → "foo"
  //   "foo - medium"    → "foo"
  //   "foo - small"     → "foo"
  //   "foo - jumbo"     → "foo"
  d = d.replace(/\s+\d+[#%]$/, '')
  d = d.replace(/\s+\d+\s*top$/i, '')
  d = d.replace(/\s*-\s*(?:large|medium|small|jumbo|xl|x-large)\s*$/i, '')

  // Collapse internal whitespace
  return d.replace(/\s+/g, ' ').trim()
}

/**
 * Auto-match an OCR'd line description to an ingredient. Returns the
 * extra_ingredients.id when there's exactly one confident match, else null.
 *
 * Match strategy (first hit wins):
 *   1. Exact match (lowercase) against name / display_name / alias
 *   2. Same match against the normalized description (quantities stripped)
 *   3. Substring match: any ingredient whose name appears as a whole word
 *      in the normalized description. Longest-name wins on ties to favor
 *      "sweet potato" over "potato". Returns null if multiple ingredients
 *      tie on length to avoid wrong-bucket matches.
 */
export function autoMatchIngredient(
  db: ReturnType<typeof getDatabase>,
  merchantId: string,
  description: string,
): string | null {
  const lower = String(description ?? '').toLowerCase().trim()
  if (!lower) return null

  type IdRow = { id: string }

  // Tier 1: exact lookup on the raw lowercase description
  const exact = db.query<IdRow, [string, string, string, string, string]>(
    `SELECT id FROM extra_ingredients
       WHERE merchant_id = ? AND (LOWER(name) = ? OR LOWER(display_name) = ?)
     UNION
     SELECT ingredient_id AS id FROM ingredient_aliases
       WHERE merchant_id = ? AND LOWER(alias_text) = ? AND ingredient_id IS NOT NULL
     LIMIT 2`,
  ).all(merchantId, lower, lower, merchantId, lower)
  if (exact.length === 1) return exact[0].id

  // Tier 2: exact lookup on the normalized description
  const normalized = normalizeReceiptDescription(description)
  if (normalized && normalized !== lower) {
    const norm = db.query<IdRow, [string, string, string, string, string]>(
      `SELECT id FROM extra_ingredients
         WHERE merchant_id = ? AND (LOWER(name) = ? OR LOWER(display_name) = ?)
       UNION
       SELECT ingredient_id AS id FROM ingredient_aliases
         WHERE merchant_id = ? AND LOWER(alias_text) = ? AND ingredient_id IS NOT NULL
       LIMIT 2`,
    ).all(merchantId, normalized, normalized, merchantId, normalized)
    if (norm.length === 1) return norm[0].id
  }

  // Tier 3: substring match against ingredient names AND learned aliases.
  // Longest-string wins; refuse if two candidates of the same length both
  // match (ambiguous). Aliases are first-class — staff-curated short forms
  // like "eggs" → "egg" or "red pepper" → "red bell pepper" let tier 3
  // resolve cases where the ingredient name is longer than the OCR phrase.
  const haystack = normalized || lower
  const all = db.query<{ id: string; name: string }, [string, string]>(
    `SELECT id, LOWER(name) AS name
       FROM extra_ingredients WHERE merchant_id = ?
     UNION ALL
     SELECT ingredient_id AS id, LOWER(alias_text) AS name
       FROM ingredient_aliases
      WHERE merchant_id = ? AND ingredient_id IS NOT NULL`,
  ).all(merchantId, merchantId)

  // Whole-word boundary match — "egg" must not match "eggplant".
  const hits = all.filter((r) => {
    if (!r.name) return false
    const re = new RegExp(`(?:^|[^a-z])${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i')
    return re.test(haystack)
  })
  if (hits.length === 0) return null
  // Sort by name length desc; if top two tie on length, ambiguous
  hits.sort((a, b) => b.name.length - a.name.length)
  if (hits.length >= 2 && hits[0].name.length === hits[1].name.length) return null
  return hits[0].id
}

/**
 * Send manager invite email via the merchant's configured SMTP.
 * Fails silently (logged warning) when no email config is present so the
 * invite row is still created and the owner can share the link manually.
 */
async function sendInviteEmail(
  merchantId: string,
  toEmail: string,
  token: string,
  merchantName: string,
  baseUrl: string,
): Promise<void> {
  const db = getDatabase()
  const row = db.query<{
    receipt_email_from: string | null
    smtp_provider: string | null
  }, [string]>(
    `SELECT receipt_email_from, smtp_provider FROM merchants WHERE id = ?`,
  ).get(merchantId)

  if (!row?.receipt_email_from) {
    console.warn(`[manager] No email configured for merchant ${merchantId} — invite not emailed`)
    return
  }

  const fromAddress  = row.receipt_email_from
  const smtpProvider = row.smtp_provider ?? 'gmail'
  const appPassword  = await getAPIKey(merchantId, 'email', smtpProvider)
  if (!appPassword) {
    console.warn(`[manager] No SMTP credentials for merchant ${merchantId} — invite not emailed`)
    return
  }

  try {
    const transporter = buildSmtpTransport(smtpProvider, fromAddress, appPassword)
    const link        = `${baseUrl}/manager-app/accept?token=${encodeURIComponent(token)}`
    const safeName    = merchantName.replace(/[\\<>"']/g, ' ')

    await transporter.sendMail({
      from:    `"${safeName}" <${fromAddress}>`,
      to:      toEmail,
      subject: `${merchantName} — You've been invited as a manager`,
      html: [
        `<p>You've been invited to manage <strong>${safeName}</strong> on Kizo.</p>`,
        `<p><a href="${link}">Accept Invitation</a></p>`,
        `<p>This link expires in ${INVITE_TTL_HOURS} hours.</p>`,
        `<p>If you did not expect this email, you can safely ignore it.</p>`,
      ].join(''),
    })
    console.log(`[manager] Invite email sent to ${toEmail}`)
  } catch (err) {
    console.error(`[manager] Failed to send invite email to ${toEmail}:`, err)
  }
}

// ---------------------------------------------------------------------------
// Manager invite APIs
// ---------------------------------------------------------------------------

/** GET /api/merchants/:id/manager/users — list active managers + pending invites */
manager.get(
  '/api/merchants/:id/manager/users',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()

      const managers = db.query<{
        id: string; email: string; full_name: string; created_at: string
      }, [string]>(
        `SELECT id, email, full_name, created_at
           FROM users
          WHERE merchant_id = ? AND role = 'manager' AND is_active = 1
          ORDER BY created_at DESC`,
      ).all(merchantId)

      const pendingInvites = db.query<{
        id: string; email: string; expires_at: string; created_at: string
      }, [string]>(
        `SELECT id, email, expires_at, created_at
           FROM manager_invites
          WHERE merchant_id = ?
            AND expires_at > datetime('now')
          ORDER BY created_at DESC`,
      ).all(merchantId)

      return c.json({ managers, pendingInvites })
    } catch (err) {
      return serverError(c, '[manager] list users', err)
    }
  },
)

/** POST /api/merchants/:id/manager/invites — create invite + send email */
manager.post(
  '/api/merchants/:id/manager/invites',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    let body: { email?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!email || !email.includes('@') || /[\r\n]/.test(email)) return c.json({ error: 'Valid email is required' }, 400)

    const db = getDatabase()

    // I-7: Only owners can invite (already enforced by requireRole above).
    // Verify email is not already an active manager for this merchant.
    const existing = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM users
        WHERE email = ? AND merchant_id = ? AND role = 'manager' AND is_active = 1`,
    ).get(email, merchantId)
    if (existing) {
      return c.json({ error: 'This email is already a manager for this merchant' }, 409)
    }

    const merchantRow = db.query<{ business_name: string }, [string]>(
      `SELECT business_name FROM merchants WHERE id = ?`,
    ).get(merchantId)
    if (!merchantRow) return c.json({ error: 'Merchant not found' }, 404)

    const plainToken = generatePlainToken()
    const tokenHash  = hashToken(plainToken)
    const expiresAt  = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000)
      .toISOString().replace('T', ' ').slice(0, 19)
    const inviteId   = generateId('mgrinv')

    try {
      // I-1: One active invite per email per merchant — delete old before inserting fresh.
      db.run(`DELETE FROM manager_invites WHERE merchant_id = ? AND email = ?`, [merchantId, email])
      db.run(
        `INSERT INTO manager_invites (id, merchant_id, email, token_hash, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [inviteId, merchantId, email, tokenHash, expiresAt],
      )
    } catch (err) {
      return serverError(c, '[manager] create invite', err)
    }

    // Fire-and-forget — does not block the response
    const reqUrl  = new URL(c.req.url)
    const baseUrl = APP_BASE_URL || `${reqUrl.protocol}//${reqUrl.host}`
    sendInviteEmail(merchantId, email, plainToken, merchantRow.business_name, baseUrl).catch(() => {})

    return c.json({ ok: true, inviteId, expiresAt }, 201)
  },
)

/** DELETE /api/merchants/:id/manager/users/:userId — revoke manager access (soft-delete) */
manager.delete(
  '/api/merchants/:id/manager/users/:userId',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const userId     = c.req.param('userId')!
    try {
      const db = getDatabase()
      const user = db.query<{ id: string; role: string }, [string, string]>(
        `SELECT id, role FROM users WHERE id = ? AND merchant_id = ?`,
      ).get(userId, merchantId)

      if (!user) return c.json({ error: 'Not found' }, 404)
      if (user.role !== 'manager') return c.json({ error: 'Can only revoke manager accounts' }, 400)

      db.run(`UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`, [userId])
      db.run(`DELETE FROM refresh_tokens WHERE user_id = ?`, [userId])

      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, '[manager] revoke user', err)
    }
  },
)

/** GET /api/manager/invites/validate?token=... — public, no auth required */
manager.get('/api/manager/invites/validate', (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ valid: false, error: 'Missing token' }, 400)

  try {
    const db        = getDatabase()
    const tokenHash = hashToken(token)
    const invite    = db.query<{
      email: string; expires_at: string; merchant_id: string
    }, [string]>(
      `SELECT email, expires_at, merchant_id
         FROM manager_invites
        WHERE token_hash = ?
          AND expires_at > datetime('now')`,
    ).get(tokenHash)

    if (!invite) return c.json({ valid: false, error: 'Invalid or expired invite' })

    const merchant = db.query<{ business_name: string }, [string]>(
      `SELECT business_name FROM merchants WHERE id = ?`,
    ).get(invite.merchant_id)

    return c.json({
      valid:        true,
      email:        invite.email,
      merchantName: merchant?.business_name ?? '',
    })
  } catch (err) {
    return serverError(c, '[manager] validate invite', err)
  }
})

// ---------------------------------------------------------------------------
// Receipt APIs
// ---------------------------------------------------------------------------

/** POST /api/merchants/:id/manager/receipts — upload images, proxy to OCR, persist */
manager.post(
  '/api/merchants/:id/manager/receipts',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const userId     = c.get('userId') as string | undefined

    // Check OCR service health first
    try {
      const health = await fetch(`${OCR_SERVICE_URL}/healthz`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (!health.ok) throw new Error('unhealthy')
    } catch {
      return c.json({ error: 'OCR service unavailable' }, 503)
    }

    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      return c.json({ error: 'Expected multipart/form-data' }, 400)
    }

    // Validate or generate idempotency name (I-2)
    const clientName = formData.get('name')
    let ocrName: string
    if (typeof clientName === 'string' && NAME_RE.test(clientName)) {
      ocrName = clientName
    } else {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      ocrName = `${merchantId.slice(0, 8)}-${today}-${randomBytes(4).toString('hex')}`
    }

    // Idempotency: return existing receipt if this ocr_name was already processed
    const db = getDatabase()
    const existingReceipt = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM supplier_receipts WHERE ocr_name = ? AND merchant_id = ?`,
    ).get(ocrName, merchantId)
    if (existingReceipt) {
      const rawItems = db.query<{
        id: string; description: string; quantity: number | null; unit: string | null
        unit_price: number | null; total_price: number; category: string | null
        ingredient_id: string | null; auto_matched: number
      }, [string]>(
        `SELECT id, description, quantity, unit, unit_price, total_price,
                category, ingredient_id, auto_matched
           FROM receipt_line_items WHERE supplier_receipt_id = ? ORDER BY rowid`,
      ).all(existingReceipt.id)
      const lineItems = rawItems.map(i => ({
        id:           i.id,
        description:  i.description,
        quantity:     i.quantity,
        unit:         i.unit,
        unitPrice:    i.unit_price,
        totalPrice:   i.total_price,
        category:     i.category,
        ingredientId: i.ingredient_id,
        autoMatched:  i.auto_matched === 1,
      }))
      return c.json({ receiptId: existingReceipt.id, name: ocrName, lineItems }, 200)
    }

    // Optional vendor override — when set, replaces the OCR-detected vendor name.
    const vendorOverride = (() => {
      const v = formData.get('vendor')
      return typeof v === 'string' ? v.trim() : ''
    })()

    // Collect files from form data (File entries only)
    const files: File[] = []
    for (const [, value] of formData.entries()) {
      if (typeof value !== 'string') files.push(value as File)
    }
    if (files.length === 0) return c.json({ error: 'At least one image file is required' }, 400)

    // Content-hash dedup: SHA-256 of all file bytes concatenated in order.
    // Catches re-uploads of the same physical receipt across different sessions.
    const fileBuffers = await Promise.all(files.map(f => f.arrayBuffer()))
    const hashInput   = Buffer.concat(fileBuffers.map(b => Buffer.from(b)))
    const contentHash = createHash('sha256').update(hashInput).digest('hex')

    const hashMatch = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM supplier_receipts WHERE merchant_id = ? AND content_hash = ? LIMIT 1`,
    ).get(merchantId, contentHash)
    if (hashMatch) {
      const rawItems = db.query<{
        id: string; description: string; quantity: number | null; unit: string | null
        unit_price: number | null; total_price: number; category: string | null
        ingredient_id: string | null; auto_matched: number
      }, [string]>(
        `SELECT id, description, quantity, unit, unit_price, total_price,
                category, ingredient_id, auto_matched
           FROM receipt_line_items WHERE supplier_receipt_id = ? ORDER BY rowid`,
      ).all(hashMatch.id)
      const lineItems = rawItems.map(i => ({
        id:           i.id,
        description:  i.description,
        quantity:     i.quantity,
        unit:         i.unit,
        unitPrice:    i.unit_price,
        totalPrice:   i.total_price,
        category:     i.category,
        ingredientId: i.ingredient_id,
        autoMatched:  i.auto_matched === 1,
      }))
      return c.json({ receiptId: hashMatch.id, name: ocrName, lineItems, isDuplicate: true }, 200)
    }

    // If an identical upload is already being processed (same content hash),
    // await that promise rather than firing a second OCR call which would race
    // on the unique constraint and return 500 → client retry loop.
    if (_ocrInFlight.has(contentHash)) {
      try {
        const { receiptId, lineItems } = await _ocrInFlight.get(contentHash)!
        return c.json({ receiptId, name: ocrName, lineItems, isDuplicate: true }, 200)
      } catch {
        return c.json({ error: 'OCR processing failed' }, 422)
      }
    }

    // Forward multipart to OCR service
    const ocrForm = new FormData()
    for (const file of files) {
      ocrForm.append('files', file, (file as File).name)
    }

    const processing: Promise<OcrResult> = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let ocrJson: any
      try {
        const ocrRes = await fetch(`${OCR_SERVICE_URL}/v1/data/${encodeURIComponent(ocrName)}`, {
          method:  'POST',
          headers: { 'X-API-Key': OCR_API_KEY },
          body:    ocrForm,
          signal:  AbortSignal.timeout(120_000),
        })
        if (!ocrRes.ok) {
          const errText = await ocrRes.text().catch(() => '')
          console.error(`[manager] OCR service error ${ocrRes.status}: ${errText}`)
          throw new Error(`OCR service error ${ocrRes.status}: ${errText}`)
        }
        ocrJson = await ocrRes.json()
      } catch (err) {
        throw err
      }

      // Persist receipt
      // OCR service may return fields in different shapes depending on vendor format.
      // Always try the normalised flat name first, then nested fallbacks.
      const receiptId     = generateId('srec')
      const vendorName: string = (
        vendorOverride ||
        (typeof ocrJson.vendor_name    === 'string' ? ocrJson.vendor_name    :
         typeof ocrJson.vendor?.name   === 'string' ? ocrJson.vendor.name    :
         typeof ocrJson.merchant?.name === 'string' ? ocrJson.merchant.name  :
         'Unknown Vendor')
      )
      const vendorTaxId: string | null = (
        typeof ocrJson.vendor_tax_id      === 'string' ? ocrJson.vendor_tax_id      :
        typeof ocrJson.vendor?.tax_id     === 'string' ? ocrJson.vendor.tax_id      :
        null
      )
      const docTypeRaw    = typeof ocrJson.document_type  === 'string' ? ocrJson.document_type  : ''
      const documentType  = ['receipt', 'invoice', 'unknown'].includes(docTypeRaw) ? docTypeRaw : 'receipt'
      const documentNumber = typeof ocrJson.document_number === 'string' ? ocrJson.document_number : null
      const receiptDate: string | null = (
        typeof ocrJson.receipt_date       === 'string' ? ocrJson.receipt_date       :
        typeof ocrJson.invoice_date       === 'string' ? ocrJson.invoice_date       :
        typeof ocrJson.date               === 'string' ? ocrJson.date               :
        null
      )
      const subtotal      = typeof ocrJson.subtotal       === 'number'  ? ocrJson.subtotal       : null
      const taxAmount: number | null = (
        typeof ocrJson.tax_amount         === 'number'  ? ocrJson.tax_amount        :
        typeof ocrJson.tax                === 'number'  ? ocrJson.tax               :
        null
      )
      const total         = typeof ocrJson.total          === 'number'  ? ocrJson.total          : 0
      const currency      = typeof ocrJson.currency       === 'string'  ? ocrJson.currency       : 'USD'
      const rawJson       = JSON.stringify(ocrJson)

      const lineItemsRaw = cleanupOcrLineItems(
        Array.isArray(ocrJson.line_items) ? ocrJson.line_items : []
      )
      const insertedItems: OcrLineItem[] = []

      db.transaction(() => {
        db.run(
          `INSERT INTO supplier_receipts
             (id, merchant_id, ocr_name, vendor_name, vendor_tax_id, document_type,
              document_number, receipt_date, subtotal, tax_amount, total, currency,
              raw_json, uploaded_by, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [receiptId, merchantId, ocrName, vendorName, vendorTaxId, documentType,
           documentNumber, receiptDate, subtotal, taxAmount, total, currency,
           rawJson, userId ?? null, contentHash],
        )

        for (const item of lineItemsRaw) {
          const description = typeof item.description === 'string' ? item.description : ''
          if (!description) continue

          const totalPrice = typeof item.total_price === 'number' ? item.total_price : 0
          const quantity   = typeof item.quantity    === 'number' ? item.quantity    : null
          const unit       = typeof item.unit        === 'string' ? item.unit        : null
          const unitPrice  = typeof item.unit_price  === 'number' ? item.unit_price  : null
          const category   = typeof item.category    === 'string' ? item.category    : null

          // Auto-match through the normalizer: exact lookup on raw + normalized
          // description, then whole-word substring fallback. See helpers above.
          const ingredientId = autoMatchIngredient(db, merchantId, description)
          const autoMatched  = ingredientId !== null ? 1 : 0
          const itemId       = generateId('rli')

          db.run(
            `INSERT INTO receipt_line_items
               (id, supplier_receipt_id, merchant_id, description, quantity, unit,
                unit_price, total_price, category, ingredient_id, auto_matched)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [itemId, receiptId, merchantId, description, quantity, unit,
             unitPrice, totalPrice, category, ingredientId, autoMatched],
          )
          insertedItems.push({
            id: itemId, description, quantity, unit, unitPrice, totalPrice,
            category, ingredientId, autoMatched: autoMatched === 1,
          })
        }
      })()

      return { receiptId, lineItems: insertedItems }
    })()

    _ocrInFlight.set(contentHash, processing)
    try {
      const { receiptId, lineItems } = await processing
      return c.json({ receiptId, name: ocrName, lineItems }, 201)
    } catch (err) {
      // Surface OCR errors as 422; DB errors as 500
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('OCR service error')) {
        return c.json({ error: 'OCR processing failed', detail: msg }, 422)
      }
      return serverError(c, '[manager] persist receipt', err)
    } finally {
      _ocrInFlight.delete(contentHash)
    }
  },
)

/** GET /api/merchants/:id/manager/receipts — list receipts (paginated) */
manager.get(
  '/api/merchants/:id/manager/receipts',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const from       = c.req.query('from')
    const to         = c.req.query('to')
    const vendor     = c.req.query('vendor')
    const limit      = Math.min(100, Math.max(1, Number(c.req.query('limit')  ?? 50)))
    const offset     = Math.max(0, Number(c.req.query('offset') ?? 0))

    try {
      const db         = getDatabase()
      const conditions = ['merchant_id = ?']
      const params: (string | number)[] = [merchantId]

      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        conditions.push('receipt_date >= ?')
        params.push(from)
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        conditions.push('receipt_date <= ?')
        params.push(to)
      }
      if (vendor) {
        conditions.push('LOWER(vendor_name) LIKE ?')
        params.push(`%${vendor.toLowerCase()}%`)
      }
      params.push(limit, offset)

      const where    = conditions.join(' AND ')
      const rawReceipts = db.query<{
        id: string; vendor_name: string; receipt_date: string | null
        total: number; currency: string; document_type: string; status: string
        created_at: string; line_item_count: number
      }, (string | number)[]>(
        `SELECT sr.id, sr.vendor_name, sr.receipt_date, sr.total, sr.currency,
                sr.document_type, sr.status, sr.created_at,
                (SELECT COUNT(*) FROM receipt_line_items WHERE supplier_receipt_id = sr.id) AS line_item_count
           FROM supplier_receipts sr
          WHERE ${where}
          ORDER BY COALESCE(sr.receipt_date, sr.created_at) DESC
          LIMIT ? OFFSET ?`,
      ).all(...params)

      const receipts = rawReceipts.map(r => ({
        id:            r.id,
        vendorName:    r.vendor_name,
        receiptDate:   r.receipt_date,
        total:         r.total,
        currency:      r.currency,
        documentType:  r.document_type,
        status:        r.status,
        createdAt:     r.created_at,
        lineItemCount: r.line_item_count,
      }))

      return c.json({ receipts, limit, offset })
    } catch (err) {
      return serverError(c, '[manager] list receipts', err)
    }
  },
)

/** GET /api/merchants/:id/manager/receipts/:receiptId — single receipt + line items */
manager.get(
  '/api/merchants/:id/manager/receipts/:receiptId',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const receiptId  = c.req.param('receiptId')!
    try {
      const db      = getDatabase()
      const rawReceipt = db.query<{
        id: string; vendor_name: string; vendor_tax_id: string | null
        document_type: string; document_number: string | null
        receipt_date: string | null; subtotal: number | null; tax_amount: number | null
        total: number; currency: string; status: string; created_at: string
      }, [string, string]>(
        `SELECT id, vendor_name, vendor_tax_id, document_type, document_number,
                receipt_date, subtotal, tax_amount, total, currency, status, created_at
           FROM supplier_receipts
          WHERE id = ? AND merchant_id = ?`,
      ).get(receiptId, merchantId)

      if (!rawReceipt) return c.json({ error: 'Not found' }, 404)

      const receipt = {
        id:             rawReceipt.id,
        vendorName:     rawReceipt.vendor_name,
        vendorTaxId:    rawReceipt.vendor_tax_id,
        documentType:   rawReceipt.document_type,
        documentNumber: rawReceipt.document_number,
        receiptDate:    rawReceipt.receipt_date,
        subtotal:       rawReceipt.subtotal,
        taxAmount:      rawReceipt.tax_amount,
        total:          rawReceipt.total,
        currency:       rawReceipt.currency,
        status:         rawReceipt.status,
        createdAt:      rawReceipt.created_at,
      }

      const rawItems = db.query<{
        id: string; description: string; quantity: number | null; unit: string | null
        unit_price: number | null; total_price: number; category: string | null
        ingredient_id: string | null; auto_matched: number; ingredient_name: string | null
      }, [string]>(
        `SELECT rli.id, rli.description, rli.quantity, rli.unit,
                rli.unit_price, rli.total_price, rli.category,
                rli.ingredient_id, rli.auto_matched,
                ei.name AS ingredient_name
           FROM receipt_line_items rli
           LEFT JOIN extra_ingredients ei ON ei.id = rli.ingredient_id
          WHERE rli.supplier_receipt_id = ?
          ORDER BY rli.rowid`,
      ).all(receiptId)

      const lineItems = rawItems.map(i => ({
        id:             i.id,
        description:    i.description,
        quantity:       i.quantity,
        unit:           i.unit,
        unitPrice:      i.unit_price,
        totalPrice:     i.total_price,
        category:       i.category,
        ingredientId:   i.ingredient_id,
        autoMatched:    i.auto_matched === 1,
        ingredientName: i.ingredient_name,
      }))

      return c.json({ receipt, lineItems })
    } catch (err) {
      return serverError(c, '[manager] get receipt', err)
    }
  },
)

/** PATCH /api/merchants/:id/manager/receipts/:receiptId — edit header fields */
manager.patch(
  '/api/merchants/:id/manager/receipts/:receiptId',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const receiptId  = c.req.param('receiptId')!
    let body: {
      vendorName?: unknown; receiptDate?: unknown; total?: unknown
      subtotal?: unknown; taxAmount?: unknown; documentType?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const db  = getDatabase()
    const row = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM supplier_receipts WHERE id = ? AND merchant_id = ?`,
    ).get(receiptId, merchantId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const sets: string[]               = []
    const params: (string | number)[]  = []

    if (typeof body.vendorName === 'string' && body.vendorName.trim()) {
      sets.push('vendor_name = ?'); params.push(body.vendorName.trim())
    }
    if (typeof body.receiptDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.receiptDate)) {
      sets.push('receipt_date = ?'); params.push(body.receiptDate)
    }
    if (typeof body.total === 'number') {
      sets.push('total = ?'); params.push(body.total)
    }
    if (typeof body.subtotal === 'number') {
      sets.push('subtotal = ?'); params.push(body.subtotal)
    }
    if (typeof body.taxAmount === 'number') {
      sets.push('tax_amount = ?'); params.push(body.taxAmount)
    }
    if (typeof body.documentType === 'string' &&
        ['receipt', 'invoice', 'unknown'].includes(body.documentType)) {
      sets.push('document_type = ?'); params.push(body.documentType)
    }

    if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400)

    try {
      params.push(receiptId)
      db.run(`UPDATE supplier_receipts SET ${sets.join(', ')} WHERE id = ?`, [...params])
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, '[manager] patch receipt', err)
    }
  },
)

/** PATCH /api/merchants/:id/manager/receipts/:receiptId/items/:itemId — edit line item */
manager.patch(
  '/api/merchants/:id/manager/receipts/:receiptId/items/:itemId',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const itemId     = c.req.param('itemId')!
    let body: {
      description?: unknown; quantity?: unknown; unitPrice?: unknown
      totalPrice?: unknown; ingredientId?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const db   = getDatabase()
    const item = db.query<{ id: string; description: string }, [string, string]>(
      `SELECT rli.id, rli.description FROM receipt_line_items rli
        JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
       WHERE rli.id = ? AND sr.merchant_id = ?`,
    ).get(itemId, merchantId)
    if (!item) return c.json({ error: 'Not found' }, 404)

    const sets: string[]                    = []
    const params: (string | number | null)[] = []
    let   learnedIngId: string | null        = null

    if (typeof body.description === 'string' && body.description.trim()) {
      sets.push('description = ?'); params.push(body.description.trim())
    }
    if (body.quantity === null || typeof body.quantity === 'number') {
      sets.push('quantity = ?'); params.push(body.quantity as number | null)
    }
    if (body.unitPrice === null || typeof body.unitPrice === 'number') {
      sets.push('unit_price = ?'); params.push(body.unitPrice as number | null)
    }
    if (typeof body.totalPrice === 'number') {
      sets.push('total_price = ?'); params.push(body.totalPrice)
    }
    if ('ingredientId' in body) {
      const ingId = (body.ingredientId ?? null) as string | null
      if (ingId !== null) {
        const valid = db.query<{ id: string }, [string, string]>(
          `SELECT id FROM extra_ingredients WHERE id = ? AND merchant_id = ?`,
        ).get(ingId, merchantId)
        if (!valid) return c.json({ error: 'ingredientId not found' }, 400)
        learnedIngId = ingId
      }
      sets.push('ingredient_id = ?')
      sets.push('auto_matched = 0')   // literal — no placeholder needed
      params.push(ingId)
    }

    if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400)

    try {
      params.push(itemId)
      db.run(`UPDATE receipt_line_items SET ${sets.join(', ')} WHERE id = ?`, [...params])
      // When staff manually links a line item to an ingredient, persist both the
      // raw and normalised description as aliases so future receipts auto-match
      // even when OCR adds quantity prefixes or size suffixes.
      if (learnedIngId !== null && item.description) {
        const rawAlias  = item.description.toLowerCase()
        const normAlias = normalizeReceiptDescription(item.description)
        const upsertAlias = db.prepare(
          `INSERT INTO ingredient_aliases (merchant_id, alias_text, ingredient_id)
           VALUES (?, ?, ?)
           ON CONFLICT(merchant_id, alias_text) DO UPDATE SET ingredient_id = excluded.ingredient_id`,
        )
        upsertAlias.run(merchantId, rawAlias, learnedIngId)
        if (normAlias && normAlias !== rawAlias) {
          upsertAlias.run(merchantId, normAlias, learnedIngId)
        }
      }
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, '[manager] patch line item', err)
    }
  },
)

/** PATCH /api/merchants/:id/manager/receipts/:receiptId/items — bulk replace line items */
manager.patch(
  '/api/merchants/:id/manager/receipts/:receiptId/items',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const receiptId  = c.req.param('receiptId')!
    let body: { lineItems?: unknown; lock?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    if (!Array.isArray(body.lineItems)) {
      return c.json({ error: 'lineItems array is required' }, 400)
    }

    const db  = getDatabase()
    const row = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM supplier_receipts WHERE id = ? AND merchant_id = ?`,
    ).get(receiptId, merchantId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    try {
      db.transaction(() => {
        db.run(`DELETE FROM receipt_line_items WHERE supplier_receipt_id = ?`, [receiptId])

        for (const item of body.lineItems as unknown[]) {
          if (typeof item !== 'object' || item === null) continue
          const it          = item as Record<string, unknown>
          const description = typeof it.description === 'string' ? it.description.trim() : ''
          if (!description) continue

          const quantity     = typeof it.quantity   === 'number' ? it.quantity   : null
          const unit         = typeof it.unit       === 'string' ? it.unit       : null
          const unitPrice    = typeof it.unitPrice  === 'number' ? it.unitPrice  : null
          const totalPrice   = typeof it.totalPrice === 'number' ? it.totalPrice : 0
          const rawIngId     = typeof it.ingredientId === 'string' && it.ingredientId ? it.ingredientId : null

          if (rawIngId) {
            const valid = db.query<{ id: string }, [string, string]>(
              `SELECT id FROM extra_ingredients WHERE id = ? AND merchant_id = ?`,
            ).get(rawIngId, merchantId)
            if (!valid) continue
          }

          db.run(
            `INSERT INTO receipt_line_items
               (id, supplier_receipt_id, merchant_id, description, quantity, unit,
                unit_price, total_price, ingredient_id, auto_matched)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [generateId('rli'), receiptId, merchantId, description,
             quantity, unit, unitPrice, totalPrice, rawIngId],
          )

          // Learn: persist raw + normalised description as aliases so future
          // receipts from the same vendor auto-match without manual work.
          if (rawIngId) {
            const rawAlias  = description.toLowerCase()
            const normAlias = normalizeReceiptDescription(description)
            const upsertAlias = db.prepare(
              `INSERT INTO ingredient_aliases (merchant_id, alias_text, ingredient_id)
               VALUES (?, ?, ?)
               ON CONFLICT(merchant_id, alias_text) DO UPDATE SET ingredient_id = excluded.ingredient_id`,
            )
            upsertAlias.run(merchantId, rawAlias, rawIngId)
            if (normAlias && normAlias !== rawAlias) {
              upsertAlias.run(merchantId, normAlias, rawIngId)
            }
          }
        }

        if (body.lock === true) {
          db.run(
            `UPDATE supplier_receipts SET status = 'reviewed' WHERE id = ?`,
            [receiptId],
          )
        }
      })()

      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, '[manager] bulk save items', err)
    }
  },
)

/** DELETE /api/merchants/:id/manager/receipts/:receiptId — delete receipt + cascades items */
manager.delete(
  '/api/merchants/:id/manager/receipts/:receiptId',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const receiptId  = c.req.param('receiptId')!
    try {
      const db     = getDatabase()
      const result = db.run(
        `DELETE FROM supplier_receipts WHERE id = ? AND merchant_id = ?`,
        [receiptId, merchantId],
      )
      if (result.changes === 0) return c.json({ error: 'Not found' }, 404)
      return c.json({ ok: true })
    } catch (err) {
      return serverError(c, '[manager] delete receipt', err)
    }
  },
)

// ---------------------------------------------------------------------------
// Report APIs
// ---------------------------------------------------------------------------

/** GET /api/merchants/:id/manager/reports/cogs?granularity=weekly|monthly&weeks=12 */
manager.get(
  '/api/merchants/:id/manager/reports/cogs',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId  = c.req.param('id')!
    const granularity = c.req.query('granularity') === 'monthly' ? 'monthly' : 'weekly'
    const weeks       = Math.min(52, Math.max(1, Number(c.req.query('weeks') ?? 12)))

    try {
      const db = getDatabase()
      let rows: Array<{ label: string; total: number }>

      if (granularity === 'weekly') {
        rows = db.query<{ label: string; total: number }, [string, number]>(
          `SELECT strftime('%Y-W%W', sr.receipt_date) AS label,
                  SUM(rli.total_price) AS total
             FROM receipt_line_items rli
             JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
            WHERE rli.merchant_id = ?
              AND sr.receipt_date >= date('now', ? || ' days')
            GROUP BY label
            ORDER BY label`,
        ).all(merchantId, -(weeks * 7))
      } else {
        const months = Math.ceil(weeks / 4)
        rows = db.query<{ label: string; total: number }, [string, number]>(
          `SELECT strftime('%Y-%m', sr.receipt_date) AS label,
                  SUM(rli.total_price) AS total
             FROM receipt_line_items rli
             JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
            WHERE rli.merchant_id = ?
              AND sr.receipt_date >= date('now', ? || ' months')
            GROUP BY label
            ORDER BY label`,
        ).all(merchantId, -months)
      }

      return c.json({ periods: rows, granularity })
    } catch (err) {
      return serverError(c, '[manager] cogs report', err)
    }
  },
)

/** GET /api/merchants/:id/manager/reports/vendors?months=12 */
manager.get(
  '/api/merchants/:id/manager/reports/vendors',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const months     = Math.min(24, Math.max(1, Number(c.req.query('months') ?? 12)))

    try {
      const db = getDatabase()
      const rows = db.query<{
        vendor: string; month: string; total: number
      }, [string, number]>(
        `SELECT sr.vendor_name AS vendor,
                strftime('%Y-%m', sr.receipt_date) AS month,
                SUM(rli.total_price) AS total
           FROM receipt_line_items rli
           JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
          WHERE rli.merchant_id = ?
            AND sr.receipt_date >= date('now', ? || ' months')
          GROUP BY vendor, month
          ORDER BY vendor, month`,
      ).all(merchantId, -months)

      // Pivot into vendor → months[] with month-over-month % change
      const vendorMap = new Map<string, Array<{ month: string; total: number; pctChange: number | null }>>()
      for (const row of rows) {
        if (!vendorMap.has(row.vendor)) vendorMap.set(row.vendor, [])
        vendorMap.get(row.vendor)!.push({ month: row.month, total: row.total, pctChange: null })
      }

      const vendors = []
      for (const [vendor, monthData] of vendorMap) {
        for (let i = 1; i < monthData.length; i++) {
          const prev = monthData[i - 1].total
          if (prev > 0) {
            monthData[i].pctChange = ((monthData[i].total - prev) / prev) * 100
          }
        }
        vendors.push({ vendor, months: monthData })
      }

      return c.json({ vendors })
    } catch (err) {
      return serverError(c, '[manager] vendor report', err)
    }
  },
)

/** GET /api/merchants/:id/manager/reports/order-warnings */
manager.get(
  '/api/merchants/:id/manager/reports/order-warnings',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db  = getDatabase()
      const now = new Date()

      // Snoozed ingredient IDs
      const snoozed = new Set(
        db.query<{ ingredient_id: string }, [string]>(
          `SELECT ingredient_id FROM ingredient_order_snoozes
            WHERE merchant_id = ? AND snoozed_until > datetime('now')`,
        ).all(merchantId).map(r => r.ingredient_id),
      )

      // Ingredients purchased at least twice (I-8)
      const candidates = db.query<{
        ingredient_id: string; ingredient_name: string
      }, [string]>(
        `SELECT rli.ingredient_id,
                ei.name AS ingredient_name
           FROM receipt_line_items rli
           JOIN extra_ingredients ei ON ei.id = rli.ingredient_id
           JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
          WHERE rli.merchant_id = ?
            AND rli.ingredient_id IS NOT NULL
            AND sr.receipt_date IS NOT NULL
          GROUP BY rli.ingredient_id
         HAVING COUNT(DISTINCT sr.receipt_date) >= 2`,
      ).all(merchantId)

      const warnings: Array<{
        ingredientId: string; ingredientName: string; lastOrderDate: string
        avgIntervalDays: number; daysSinceLastOrder: number; dayOverdue: number
        lastVendor: string | null
      }> = []

      for (const { ingredient_id, ingredient_name } of candidates) {
        if (snoozed.has(ingredient_id)) continue

        const lastRow = db.query<{ last_date: string; last_vendor: string | null }, [string, string]>(
          `SELECT MAX(sr.receipt_date) AS last_date, sr.vendor_name AS last_vendor
             FROM receipt_line_items rli
             JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
            WHERE rli.ingredient_id = ? AND rli.merchant_id = ?
              AND sr.receipt_date IS NOT NULL`,
        ).get(ingredient_id, merchantId)

        if (!lastRow?.last_date) continue

        const avgRow = db.query<{ avg_gap: number | null }, [string, string]>(
          `SELECT AVG(gap_days) AS avg_gap FROM (
             SELECT CAST(
               julianday(receipt_date) -
               julianday(LAG(receipt_date) OVER (ORDER BY receipt_date)) AS REAL
             ) AS gap_days
             FROM (
               SELECT DISTINCT sr.receipt_date
               FROM receipt_line_items rli
               JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
               WHERE rli.ingredient_id = ? AND rli.merchant_id = ?
                 AND sr.receipt_date IS NOT NULL
             )
           ) WHERE gap_days IS NOT NULL`,
        ).get(ingredient_id, merchantId)

        const avgInterval = avgRow?.avg_gap
        if (!avgInterval || avgInterval <= 0) continue

        const lastDate      = new Date(lastRow.last_date)
        const daysSinceLast = (now.getTime() - lastDate.getTime()) / 86_400_000
        const threshold     = avgInterval * 1.2

        if (daysSinceLast > threshold) {
          warnings.push({
            ingredientId:       ingredient_id,
            ingredientName:     ingredient_name,
            lastOrderDate:      lastRow.last_date,
            avgIntervalDays:    Math.round(avgInterval),
            daysSinceLastOrder: Math.round(daysSinceLast),
            dayOverdue:         Math.round(daysSinceLast - avgInterval),
            lastVendor:         lastRow.last_vendor,
          })
        }
      }

      return c.json({ warnings })
    } catch (err) {
      return serverError(c, '[manager] order warnings', err)
    }
  },
)

/** POST /api/merchants/:id/manager/reports/order-warnings/:ingredientId/snooze — snooze 7 days */
manager.post(
  '/api/merchants/:id/manager/reports/order-warnings/:ingredientId/snooze',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId   = c.req.param('id')!
    const ingredientId = c.req.param('ingredientId')!
    try {
      const db   = getDatabase()
      const ingr = db.query<{ id: string }, [string, string]>(
        `SELECT id FROM extra_ingredients WHERE id = ? AND merchant_id = ?`,
      ).get(ingredientId, merchantId)
      if (!ingr) return c.json({ error: 'Not found' }, 404)

      // I-9: upsert, always exactly 7 days from now
      const snoozedUntil = new Date(Date.now() + 7 * 86_400_000)
        .toISOString().replace('T', ' ').slice(0, 19)

      db.run(
        `INSERT INTO ingredient_order_snoozes (ingredient_id, merchant_id, snoozed_until)
         VALUES (?, ?, ?)
         ON CONFLICT(ingredient_id, merchant_id) DO UPDATE SET snoozed_until = excluded.snoozed_until`,
        [ingredientId, merchantId, snoozedUntil],
      )

      return c.json({ ok: true, snoozedUntil })
    } catch (err) {
      return serverError(c, '[manager] snooze warning', err)
    }
  },
)

/** GET /api/merchants/:id/manager/reports/price-changes — per-ingredient unit price history */
manager.get(
  '/api/merchants/:id/manager/reports/price-changes',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db  = getDatabase()
      const now = new Date()
      const thisYear   = now.getFullYear()
      const ytdStart   = `${thisYear}-01-01`
      const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

      // One row per (ingredient × vendor): all vendors side-by-side for shopping comparison.
      // A pair needs only 1 purchase to appear (delta = null when no prior purchase exists).
      const candidates = db.query<{
        ingredient_id: string; ingredient_name: string; vendor_name: string
      }, [string]>(
        `SELECT rli.ingredient_id,
                ei.name          AS ingredient_name,
                sr.vendor_name
           FROM receipt_line_items rli
           JOIN extra_ingredients ei  ON ei.id  = rli.ingredient_id
           JOIN supplier_receipts sr  ON sr.id  = rli.supplier_receipt_id
          WHERE rli.merchant_id = ?
            AND rli.ingredient_id IS NOT NULL
            AND rli.unit_price IS NOT NULL
            AND sr.receipt_date IS NOT NULL
          GROUP BY rli.ingredient_id, sr.vendor_name
          ORDER BY ei.name, sr.vendor_name`,
      ).all(merchantId)

      const result: Array<{
        ingredientId:         string
        ingredientName:       string
        vendorName:           string | null
        lastOrderDate:        string
        latestUnitPrice:      number
        previousUnitPrice:    number
        last30StartUnitPrice: number | null
        ytdStartUnitPrice:    number | null
        lastOrderDelta:       number | null
        last30Delta:          number | null
        ytdDelta:             number | null
        history:              Array<{ date: string; unitPrice: number }>
      }> = []

      for (const { ingredient_id, ingredient_name, vendor_name } of candidates) {
        // History scoped to this vendor only — prices are only comparable within a vendor
        const history = db.query<{
          date: string; unit_price: number
        }, [string, string, string]>(
          `SELECT sr.receipt_date AS date, rli.unit_price
             FROM receipt_line_items rli
             JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
            WHERE rli.ingredient_id = ?
              AND rli.merchant_id = ?
              AND sr.vendor_name = ?
              AND rli.unit_price IS NOT NULL
              AND sr.receipt_date IS NOT NULL
            ORDER BY sr.receipt_date ASC`,
        ).all(ingredient_id, merchantId, vendor_name)

        if (history.length === 0) continue

        const latest      = history[history.length - 1]
        const latestPrice = latest.unit_price

        // Last Order: second-most-recent purchase from this vendor (null when only 1 visit)
        const prev              = history.length >= 2 ? history[history.length - 2] : null
        const previousUnitPrice = prev?.unit_price ?? null
        const lastOrderDelta    = prev && prev.unit_price > 0
          ? ((latestPrice - prev.unit_price) / prev.unit_price) * 100
          : null

        // Last 30 days: latest vs earliest purchase within rolling 30-day window
        const last30History       = history.filter(h => h.date >= last30Start)
        const last30StartUnitPrice = last30History.length >= 1 ? last30History[0].unit_price : null
        const last30Delta          = last30History.length >= 2 && last30History[0].unit_price > 0
          ? ((latestPrice - last30History[0].unit_price) / last30History[0].unit_price) * 100
          : null

        // YTD: latest vs first purchase this calendar year from this vendor
        const ytdHistory       = history.filter(h => h.date >= ytdStart)
        const ytdStartUnitPrice = ytdHistory.length >= 1 ? ytdHistory[0].unit_price : null
        const ytdDelta          = ytdHistory.length >= 2 && ytdHistory[0].unit_price > 0
          ? ((latestPrice - ytdHistory[0].unit_price) / ytdHistory[0].unit_price) * 100
          : null

        result.push({
          ingredientId:         ingredient_id,
          ingredientName:       ingredient_name,
          vendorName:           vendor_name ?? null,
          lastOrderDate:        latest.date,
          latestUnitPrice:      latestPrice,
          previousUnitPrice:    previousUnitPrice ?? latestPrice,
          last30StartUnitPrice,
          ytdStartUnitPrice,
          lastOrderDelta,
          last30Delta,
          ytdDelta,
          history: history.map(h => ({ date: h.date, unitPrice: h.unit_price })),
        })
      }

      // Sort: ingredient name A→Z, then by active tab delta desc within each ingredient
      result.sort((a, b) => {
        const nameOrder = a.ingredientName.localeCompare(b.ingredientName)
        if (nameOrder !== 0) return nameOrder
        // Within same ingredient: vendor with the highest (or most recent) delta first
        const da = a.lastOrderDelta ?? -Infinity
        const db2 = b.lastOrderDelta ?? -Infinity
        return db2 - da
      })

      return c.json(result)
    } catch (err) {
      return serverError(c, '[manager] price changes report', err)
    }
  },
)

// ---------------------------------------------------------------------------
// Last-order price comparison (cross-vendor, all ingredients)
// ---------------------------------------------------------------------------

/** GET /api/merchants/:id/manager/reports/last-order-changes
 *  For every tracked ingredient, returns the two most recent purchases across
 *  all vendors and computes the price delta between them.
 */
manager.get(
  '/api/merchants/:id/manager/reports/last-order-changes',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()

      type PurchaseRow = {
        ingredient_id:   string
        ingredient_name: string
        vendor_name:     string
        receipt_date:    string
        unit_price:      number
        rn:              number
      }

      // One row per (ingredient, rank) where rank 1 = most recent, rank 2 = second most recent.
      // Window function partitions by ingredient across all vendors so the comparison is
      // chronological regardless of where the item was purchased.
      const purchases = db.query<PurchaseRow, [string]>(`
        SELECT ingredient_id, ingredient_name, vendor_name, receipt_date, unit_price, rn
        FROM (
          SELECT rli.ingredient_id,
                 ei.name          AS ingredient_name,
                 sr.vendor_name,
                 sr.receipt_date,
                 rli.unit_price,
                 ROW_NUMBER() OVER (
                   PARTITION BY rli.ingredient_id
                   ORDER BY sr.receipt_date DESC
                 ) AS rn
            FROM receipt_line_items rli
            JOIN extra_ingredients ei ON ei.id = rli.ingredient_id
            JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
           WHERE rli.merchant_id = ?
             AND rli.ingredient_id IS NOT NULL
             AND rli.unit_price IS NOT NULL
             AND sr.receipt_date IS NOT NULL
        )
        WHERE rn <= 2
        ORDER BY ingredient_name, rn
      `).all(merchantId)

      type Entry = {
        ingredientId:     string
        ingredientName:   string
        latestVendorName: string
        latestDate:       string
        latestUnitPrice:  number
        prevVendorName:   string | null
        prevDate:         string | null
        prevUnitPrice:    number | null
        delta:            number | null
      }

      const byIngredient = new Map<string, Entry>()
      for (const row of purchases) {
        if (row.rn === 1) {
          byIngredient.set(row.ingredient_id, {
            ingredientId:     row.ingredient_id,
            ingredientName:   row.ingredient_name,
            latestVendorName: row.vendor_name,
            latestDate:       row.receipt_date,
            latestUnitPrice:  row.unit_price,
            prevVendorName:   null,
            prevDate:         null,
            prevUnitPrice:    null,
            delta:            null,
          })
        } else {
          const entry = byIngredient.get(row.ingredient_id)
          if (entry) {
            entry.prevVendorName  = row.vendor_name
            entry.prevDate        = row.receipt_date
            entry.prevUnitPrice   = row.unit_price
            const rawDelta        = row.unit_price > 0
              ? ((entry.latestUnitPrice - row.unit_price) / row.unit_price) * 100
              : null
            entry.delta           = rawDelta !== null && Math.abs(rawDelta) < 0.5 ? null : rawDelta
          }
        }
      }

      const result = [...byIngredient.values()].sort((a, b) => {
        if (a.delta == null && b.delta == null) return a.ingredientName.localeCompare(b.ingredientName)
        if (a.delta == null) return 1
        if (b.delta == null) return -1
        const d = b.delta - a.delta
        return d !== 0 ? d : a.ingredientName.localeCompare(b.ingredientName)
      })

      return c.json(result)
    } catch (err) {
      return serverError(c, '[manager] last-order-changes report', err)
    }
  },
)

// ---------------------------------------------------------------------------
// Last-receipt price comparison
// ---------------------------------------------------------------------------

/** GET /api/merchants/:id/manager/reports/last-receipt
 *  Returns every line item from the most recently uploaded receipt together
 *  with the previous purchase price for that ingredient from any vendor.
 */
manager.get(
  '/api/merchants/:id/manager/reports/last-receipt',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()

      // Most recently uploaded receipt
      const receipt = db.query<{
        id: string; vendor_name: string; receipt_date: string; total: number | null
      }, [string]>(
        `SELECT id, vendor_name, receipt_date, total
           FROM supplier_receipts
          WHERE merchant_id = ?
            AND receipt_date IS NOT NULL
          ORDER BY receipt_date DESC, created_at DESC
          LIMIT 1`,
      ).get(merchantId)

      if (!receipt) return c.json({ receipt: null, items: [] })

      // All line items from that receipt with a unit price
      const lineItems = db.query<{
        description:     string
        quantity:        number | null
        unit:            string | null
        unit_price:      number
        ingredient_id:   string | null
        ingredient_name: string | null
      }, [string]>(
        `SELECT li.description, li.quantity, li.unit, li.unit_price,
                li.ingredient_id, ei.name AS ingredient_name
           FROM receipt_line_items li
           LEFT JOIN extra_ingredients ei ON ei.id = li.ingredient_id
          WHERE li.supplier_receipt_id = ?
            AND li.unit_price IS NOT NULL
          ORDER BY li.description`,
      ).all(receipt.id)

      // For each item, find the most recent prior purchase from any vendor.
      // Prefer ingredient_id lookup (cross-vendor, description-agnostic) when the
      // item has been matched; fall back to exact description match otherwise.
      const today = new Date().toISOString().slice(0, 10)
      const items = lineItems.map(item => {
        let prev: { unit_price: number; receipt_date: string; vendor_name: string } | null = null

        if (item.ingredient_id) {
          // Ingredient-based: finds prior price even when vendor descriptions vary
          prev = db.query<{
            unit_price: number; receipt_date: string; vendor_name: string
          }, [string, string, string]>(
            `SELECT li2.unit_price, sr2.receipt_date, sr2.vendor_name
               FROM receipt_line_items li2
               JOIN supplier_receipts sr2 ON sr2.id = li2.supplier_receipt_id
              WHERE li2.merchant_id = ?
                AND li2.ingredient_id = ?
                AND sr2.receipt_date < ?
                AND li2.unit_price IS NOT NULL
              ORDER BY sr2.receipt_date DESC
              LIMIT 1`,
          ).get(merchantId, item.ingredient_id, receipt.receipt_date)
        }

        if (!prev) {
          // Description-based fallback for unmatched items (or no prior by ingredient)
          prev = db.query<{
            unit_price: number; receipt_date: string; vendor_name: string
          }, [string, string, string]>(
            `SELECT li2.unit_price, sr2.receipt_date, sr2.vendor_name
               FROM receipt_line_items li2
               JOIN supplier_receipts sr2 ON sr2.id = li2.supplier_receipt_id
              WHERE li2.merchant_id = ?
                AND LOWER(li2.description) = LOWER(?)
                AND sr2.receipt_date < ?
                AND li2.unit_price IS NOT NULL
              ORDER BY sr2.receipt_date DESC
              LIMIT 1`,
          ).get(merchantId, item.description, receipt.receipt_date)
        }

        const rawDelta = prev && prev.unit_price > 0
          ? ((item.unit_price - prev.unit_price) / prev.unit_price) * 100
          : null
        const delta = rawDelta !== null && Math.abs(rawDelta) < 0.5 ? null : rawDelta

        // Human-readable "N days ago" label
        let prevLabel: string | null = null
        if (prev) {
          const diffMs  = new Date(today).getTime() - new Date(prev.receipt_date).getTime()
          const diffDays = Math.round(diffMs / 86_400_000)
          prevLabel = diffDays === 0 ? 'today'
                    : diffDays === 1 ? '1 day ago'
                    : diffDays < 14  ? `${diffDays} days ago`
                    : diffDays < 60  ? `${Math.round(diffDays / 7)} weeks ago`
                    : `${Math.round(diffDays / 30)} months ago`
        }

        return {
          description:     item.description,
          ingredientName:  item.ingredient_name ?? null,
          quantity:        item.quantity,
          unit:            item.unit,
          unitPrice:       item.unit_price,
          prevUnitPrice:   prev?.unit_price ?? null,
          prevVendorName:  prev?.vendor_name ?? null,
          prevDate:        prev?.receipt_date ?? null,
          prevLabel,
          delta,
        }
      })

      return c.json({
        receipt: {
          id:         receipt.id,
          vendorName: receipt.vendor_name,
          date:       receipt.receipt_date,
          total:      receipt.total,
        },
        items,
      })
    } catch (err) {
      return serverError(c, '[manager] last-receipt report', err)
    }
  },
)

// ---------------------------------------------------------------------------
// Ingredient price history & snapshot (offline-capable)
// ---------------------------------------------------------------------------

/**
 * GET /api/merchants/:id/manager/ingredients/price-history?q=lamb
 *
 * Fuzzy-searches receipt_line_items.description for the query term and
 * returns the last known unit price plus a 30-day daily price series.
 *
 * Response shape:
 *   { query, lastPrice, lastDate, vendor, unit, history: [{ date, unitPrice, vendor }] }
 */
manager.get(
  '/api/merchants/:id/manager/ingredients/price-history',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c) => {
    const merchantId = c.req.param('id')!
    const q      = (c.req.query('q') ?? '').trim()
    const vendor = (c.req.query('vendor') ?? '').trim()
    if (!q) return c.json({ error: 'q is required' }, 400)

    const db = getDatabase()
    try {
      const pattern = `%${q}%`
      const cutoff  = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

      type HistoryRow = { date: string; unit_price: number | null; vendor: string; unit: string | null; description: string }
      const baseSQL = `
        SELECT
          sr.receipt_date          AS date,
          rli.unit_price,
          sr.vendor_name           AS vendor,
          rli.unit,
          rli.description
        FROM receipt_line_items rli
        JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
        WHERE rli.merchant_id = ?
          AND rli.description LIKE ? COLLATE NOCASE
          AND sr.receipt_date >= ?`
      const vendorClause = vendor ? `\n          AND sr.vendor_name = ? COLLATE NOCASE` : ''

      // History: all matching line items in the last 30 days, newest first
      const history: HistoryRow[] = vendor
        ? db.query<HistoryRow, [string, string, string, string]>(
            baseSQL + vendorClause + `\n        ORDER BY sr.receipt_date DESC`,
          ).all(merchantId!, pattern, cutoff, vendor)
        : db.query<HistoryRow, [string, string, string]>(
            baseSQL + `\n        ORDER BY sr.receipt_date DESC`,
          ).all(merchantId!, pattern, cutoff)

      const latestBase = `
        SELECT
          sr.receipt_date          AS date,
          rli.unit_price,
          sr.vendor_name           AS vendor,
          rli.unit,
          rli.description
        FROM receipt_line_items rli
        JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
        WHERE rli.merchant_id = ?
          AND rli.description LIKE ? COLLATE NOCASE
          AND sr.receipt_date IS NOT NULL
          AND rli.unit_price IS NOT NULL`

      // Last price: newest row overall (not limited to 30 days)
      const latest: HistoryRow | null = vendor
        ? db.query<HistoryRow, [string, string, string]>(
            latestBase + `\n          AND sr.vendor_name = ? COLLATE NOCASE\n        ORDER BY sr.receipt_date DESC\n        LIMIT 1`,
          ).get(merchantId!, pattern, vendor)
        : db.query<HistoryRow, [string, string]>(
            latestBase + `\n        ORDER BY sr.receipt_date DESC\n        LIMIT 1`,
          ).get(merchantId!, pattern)

      return c.json({
        query:     q,
        lastPrice: latest?.unit_price ?? null,
        lastDate:  latest?.date ?? null,
        vendor:    latest?.vendor ?? null,
        unit:      latest?.unit ?? null,
        history:   history.map((r) => ({
          date:      r.date,
          unitPrice: r.unit_price,
          vendor:    r.vendor,
          unit:      r.unit,
        })),
      })
    } catch (err) {
      return serverError(c, '[manager] ingredient price-history', err)
    }
  },
)

/**
 * GET /api/merchants/:id/manager/ingredients/price-snapshot
 *
 * Returns one row per distinct ingredient description — the most recent
 * unit price within the last 90 days.  Used by the frontend to prefetch
 * all ingredient data into IndexedDB for offline search.
 *
 * Response shape:
 *   { generatedAt, items: [{ description, lastPrice, lastDate, vendor, unit }] }
 */
manager.get(
  '/api/merchants/:id/manager/ingredients/price-snapshot',
  authenticate,
  requireOwnMerchant,
  requireRole('manager', 'owner'),
  (c) => {
    const merchantId = c.req.param('id')!
    const db = getDatabase()
    try {
      const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)

      // One row per (description, vendor, unit) combination: the newest purchase
      // within 90 days. Correlated subquery ranks by receipt_date DESC, selecting
      // the rowid of the most-recent purchase for each unique combination.
      const items = db.query<{
        description: string
        unit_price: number | null
        date: string
        vendor: string
        unit: string | null
      }, [string, string, string]>(`
        SELECT
          rli.description,
          rli.unit_price,
          sr.receipt_date AS date,
          sr.vendor_name  AS vendor,
          rli.unit
        FROM receipt_line_items rli
        JOIN supplier_receipts sr ON sr.id = rli.supplier_receipt_id
        WHERE rli.merchant_id = ?
          AND sr.receipt_date >= ?
          AND rli.unit_price IS NOT NULL
          AND sr.receipt_date IS NOT NULL
          AND rli.rowid = (
            SELECT rli2.rowid
            FROM receipt_line_items rli2
            JOIN supplier_receipts sr2 ON sr2.id = rli2.supplier_receipt_id
            WHERE rli2.merchant_id = rli.merchant_id
              AND rli2.description = rli.description COLLATE NOCASE
              AND sr2.vendor_name  = sr.vendor_name  COLLATE NOCASE
              AND COALESCE(rli2.unit, '') = COALESCE(rli.unit, '') COLLATE NOCASE
              AND sr2.receipt_date >= ?
              AND rli2.unit_price IS NOT NULL
              AND sr2.receipt_date IS NOT NULL
            ORDER BY sr2.receipt_date DESC
            LIMIT 1
          )
        ORDER BY rli.description COLLATE NOCASE ASC, sr.vendor_name ASC
      `).all(merchantId!, cutoff, cutoff)

      return c.json({
        generatedAt: new Date().toISOString(),
        items: items.map((r) => ({
          description: r.description,
          lastPrice:   r.unit_price,
          lastDate:    r.date,
          vendor:      r.vendor,
          unit:        r.unit,
        })),
      })
    } catch (err) {
      return serverError(c, '[manager] ingredient price-snapshot', err)
    }
  },
)

// ---------------------------------------------------------------------------
// Location status
// ---------------------------------------------------------------------------

/** GET /api/manager/location-status — { onsite: boolean } */
manager.get(
  '/api/manager/location-status',
  authenticate,
  (c) => {
    const ip = ((c as any).get('ipAddress') as string | undefined) ?? 'unknown'
    return c.json({ onsite: isAllowedIp(ip) })
  },
)

export { manager }
