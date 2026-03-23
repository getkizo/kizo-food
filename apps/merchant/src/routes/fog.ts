/**
 * F.O.G. (Fats, Oils, Grease) — Grease Trap & Hood Cleaning Log
 *
 * Staff endpoints (authenticated):
 *   POST   /api/merchants/:id/fog              — add grease trap entry
 *   GET    /api/merchants/:id/fog              — list grease trap entries
 *   DELETE /api/merchants/:id/fog/:entryId     — soft-delete entry (owner only)
 *
 *   POST   /api/merchants/:id/fog/hood         — add hood cleaning entry
 *   GET    /api/merchants/:id/fog/hood         — list hood entries
 *   DELETE /api/merchants/:id/fog/hood/:id     — soft-delete hood entry (owner only)
 *
 * Public endpoint:
 *   GET /fog-report  — city inspector view (server-rendered HTML)
 *
 * LEGAL: FOG records and hood cleaning records are City of Kirkland compliance
 * documents. Hard deletes are intentionally prohibited — soft-delete preserves
 * the audit trail required by the F.O.G. inspection program.
 */

import { Hono } from 'hono'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { buildSmtpTransport } from '../services/smtp'
import { randomBytes } from 'node:crypto'

const fog = new Hono()

// ---------------------------------------------------------------------------
// Merchant resolution (for public /fog-report)
// ---------------------------------------------------------------------------

interface ApplianceMerchant {
  id: string
  business_name: string
  address: string | null
}

let _merchantCache: ApplianceMerchant | null = null
let _merchantCacheAt = 0
const MERCHANT_CACHE_TTL_MS = 60_000

function getApplianceMerchant(): ApplianceMerchant | null {
  if (_merchantCache && Date.now() - _merchantCacheAt < MERCHANT_CACHE_TTL_MS) return _merchantCache
  const db = getDatabase()
  _merchantCache = db
    .query<ApplianceMerchant, []>(
      `SELECT id, business_name, address
       FROM merchants WHERE status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get()
  _merchantCacheAt = Date.now()
  return _merchantCache
}

/** Reset the in-process merchant cache. For use in tests only. */
export function invalidateFogMerchantCache(): void {
  _merchantCache = null
  _merchantCacheAt = 0
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FogEntry {
  id: string
  cleaned_date: string
  cleaned_by: string
  grease_gallons: number
  solids_gallons: number
  created_at: string
}

interface FogHoodEntry {
  id: string
  cleaned_date: string
  cleaned_by: string
  notes: string | null
  created_at: string
}

/**
 * POST /api/merchants/:id/fog
 *
 * Records a grease trap cleaning event. Stores date, gallons pumped,
 * service company, and optional notes.
 *
 * @param body.date - Service date (`YYYY-MM-DD`)
 * @param body.gallons - Gallons pumped
 * @param body.company - Service company name
 * @param body.notes - Optional notes
 * @returns `{ id: string, success: true }`
 */

fog.post(
  '/api/merchants/:id/fog',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    let body: { cleanedDate?: unknown; cleanedBy?: unknown; greaseGallons?: unknown; solidsGallons?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const { cleanedDate, cleanedBy, greaseGallons, solidsGallons } = body

    if (!cleanedDate || typeof cleanedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cleanedDate)) {
      return c.json({ error: 'cleanedDate is required (YYYY-MM-DD)' }, 400)
    }
    if (!cleanedBy || typeof cleanedBy !== 'string' || !cleanedBy.trim()) {
      return c.json({ error: 'cleanedBy is required' }, 400)
    }
    if (typeof greaseGallons !== 'number' || greaseGallons < 0 || !isFinite(greaseGallons)) {
      return c.json({ error: 'greaseGallons must be a non-negative number' }, 400)
    }
    if (typeof solidsGallons !== 'number' || solidsGallons < 0 || !isFinite(solidsGallons)) {
      return c.json({ error: 'solidsGallons must be a non-negative number' }, 400)
    }

    const id = 'fog_' + randomBytes(6).toString('hex')

    db.run(
      `INSERT INTO fog_entries (id, merchant_id, cleaned_date, cleaned_by, grease_gallons, solids_gallons)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, merchantId, cleanedDate, cleanedBy.trim(), greaseGallons, solidsGallons]
    )

    return c.json({ id, success: true }, 201)
  }
)

/**
 * GET /api/merchants/:id/fog
 *
 * Returns all non-deleted grease trap cleaning entries, newest first.
 * Soft-deleted entries (`deleted_at IS NOT NULL`) are excluded.
 *
 * @returns `{ entries: FogEntry[] }`
 */

fog.get(
  '/api/merchants/:id/fog',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    const entries = db
      .query<FogEntry, [string]>(
        `SELECT id, cleaned_date, cleaned_by, grease_gallons, solids_gallons, created_at
         FROM fog_entries
         WHERE merchant_id = ? AND deleted_at IS NULL
         ORDER BY cleaned_date DESC, created_at DESC`
      )
      .all(merchantId)

    return c.json({ entries })
  }
)

/**
 * DELETE /api/merchants/:id/fog/:entryId
 *
 * Soft-deletes a grease trap entry by setting `deleted_at`. Owner only.
 *
 * @legal FOG records are City of Kirkland compliance documents. Hard deletes
 * are prohibited — `deleted_at` preserves the audit trail required by the
 * F.O.G. inspection program. The entry remains queryable for inspectors.
 */

fog.delete(
  '/api/merchants/:id/fog/:entryId',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const entryId = c.req.param('entryId')
    const db = getDatabase()

    const result = db.run(
      `UPDATE fog_entries SET deleted_at = datetime('now')
       WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL`,
      [entryId, merchantId]
    )

    if (result.changes === 0) {
      return c.json({ error: 'Entry not found' }, 404)
    }

    return c.json({ success: true })
  }
)

/**
 * POST /api/merchants/:id/fog/hood
 *
 * Records an exhaust hood cleaning event.
 *
 * @param body.date - Service date (`YYYY-MM-DD`)
 * @param body.company - Cleaning company name
 * @param body.notes - Optional notes
 * @returns `{ id: string, success: true }`
 */

fog.post(
  '/api/merchants/:id/fog/hood',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    let body: { cleanedDate?: unknown; cleanedBy?: unknown; notes?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const { cleanedDate, cleanedBy, notes } = body

    if (!cleanedDate || typeof cleanedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cleanedDate)) {
      return c.json({ error: 'cleanedDate is required (YYYY-MM-DD)' }, 400)
    }
    if (!cleanedBy || typeof cleanedBy !== 'string' || !cleanedBy.trim()) {
      return c.json({ error: 'cleanedBy is required (company name)' }, 400)
    }

    const id = 'fgh_' + randomBytes(6).toString('hex')
    const notesStr = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null

    db.run(
      `INSERT INTO fog_hood_entries (id, merchant_id, cleaned_date, cleaned_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [id, merchantId, cleanedDate, cleanedBy.trim(), notesStr]
    )

    return c.json({ id, success: true }, 201)
  }
)

/**
 * GET /api/merchants/:id/fog/hood
 *
 * Returns all non-deleted hood cleaning entries, newest first.
 *
 * @returns `{ entries: HoodEntry[] }`
 */

fog.get(
  '/api/merchants/:id/fog/hood',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    const entries = db
      .query<FogHoodEntry, [string]>(
        `SELECT id, cleaned_date, cleaned_by, notes, created_at
         FROM fog_hood_entries
         WHERE merchant_id = ? AND deleted_at IS NULL
         ORDER BY cleaned_date DESC, created_at DESC`
      )
      .all(merchantId)

    return c.json({ entries })
  }
)

/**
 * DELETE /api/merchants/:id/fog/hood/:entryId
 *
 * Soft-deletes a hood cleaning entry by setting `deleted_at`. Owner only.
 *
 * @legal Hood cleaning records are compliance documents. Hard deletes are
 * prohibited — `deleted_at` preserves the audit trail required by the
 * F.O.G. inspection program.
 */

fog.delete(
  '/api/merchants/:id/fog/hood/:entryId',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const entryId = c.req.param('entryId')
    const db = getDatabase()

    const result = db.run(
      `UPDATE fog_hood_entries SET deleted_at = datetime('now')
       WHERE id = ? AND merchant_id = ? AND deleted_at IS NULL`,
      [entryId, merchantId]
    )

    if (result.changes === 0) {
      return c.json({ error: 'Entry not found' }, 404)
    }

    return c.json({ success: true })
  }
)

/**
 * GET /fog-report
 *
 * Public server-rendered HTML page listing all FOG (grease trap) and hood
 * cleaning records. Intended for City of Kirkland inspectors — no
 * authentication required. Only active (non-deleted) entries are shown.
 */

fog.get('/fog-report', (c) => {
  const merchant = getApplianceMerchant()
  if (!merchant) {
    return new Response('Merchant not configured', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  const db = getDatabase()
  const entries = db
    .query<FogEntry, [string]>(
      `SELECT cleaned_date, cleaned_by, grease_gallons, solids_gallons
       FROM fog_entries
       WHERE merchant_id = ? AND deleted_at IS NULL
       ORDER BY cleaned_date ASC, created_at ASC`
    )
    .all(merchant.id)

  const hoodEntries = db
    .query<Pick<FogHoodEntry, 'cleaned_date' | 'cleaned_by' | 'notes'>, [string]>(
      `SELECT cleaned_date, cleaned_by, notes
       FROM fog_hood_entries
       WHERE merchant_id = ? AND deleted_at IS NULL
       ORDER BY cleaned_date ASC, created_at ASC`
    )
    .all(merchant.id)

  /** Escape HTML special characters */
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  /** Format YYYY-MM-DD → MM/DD/YYYY */
  const fmtDate = (d: string) => {
    const [y, m, day] = d.split('-')
    return `${m}/${day}/${y}`
  }

  /** Format number: integer if whole, one decimal otherwise */
  const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

  // Build grease trap table rows — city form layout pairs entries side-by-side
  let rows = ''
  if (entries.length === 0) {
    rows = `<tr><td colspan="8" style="text-align:center;padding:1.25rem;color:#666;font-style:italic">
      No cleaning records on file.
    </td></tr>`
  } else {
    for (let i = 0; i < entries.length; i += 2) {
      const L = entries[i]
      const R = entries[i + 1]
      rows += `<tr>
        <td>${esc(fmtDate(L.cleaned_date))}</td>
        <td>${esc(L.cleaned_by)}</td>
        <td class="num">${esc(fmtNum(L.grease_gallons))}</td>
        <td class="num">${esc(fmtNum(L.solids_gallons))}</td>
        <td class="divider">${R ? esc(fmtDate(R.cleaned_date)) : ''}</td>
        <td>${R ? esc(R.cleaned_by) : ''}</td>
        <td class="num">${R ? esc(fmtNum(R.grease_gallons)) : ''}</td>
        <td class="num">${R ? esc(fmtNum(R.solids_gallons)) : ''}</td>
      </tr>`
    }
  }

  // Build hood cleaning table rows
  let hoodRows = ''
  if (hoodEntries.length === 0) {
    hoodRows = `<tr><td colspan="3" style="text-align:center;padding:1.25rem;color:#666;font-style:italic">
      No hood cleaning records on file.
    </td></tr>`
  } else {
    for (const h of hoodEntries) {
      hoodRows += `<tr>
        <td>${esc(fmtDate(h.cleaned_date))}</td>
        <td>${esc(h.cleaned_by)}</td>
        <td>${h.notes ? esc(h.notes) : ''}</td>
      </tr>`
    }
  }

  const generated = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles',
  })

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>F.O.G. Cleaning Record — ${esc(merchant.business_name)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      color: #111;
      max-width: 980px;
      margin: 2rem auto;
      padding: 1rem 2rem;
      line-height: 1.4;
    }
    .city-header { text-align: center; margin-bottom: 1.25rem; line-height: 2; }
    .city-header p { font-size: 13px; }
    .city-header strong { font-size: 15px; letter-spacing: .04em; }
    h1 {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      text-align: center;
      letter-spacing: .04em;
      border-top: 2px solid #111;
      padding-top: .75rem;
      margin-top: .5rem;
    }
    h2 {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .04em;
      margin: 2rem 0 .5rem;
      border-bottom: 1px solid #999;
      padding-bottom: .25rem;
    }
    .subtitle {
      font-size: 12px;
      text-align: center;
      font-style: italic;
      margin: .35rem 0 1.5rem;
    }
    .establishment { margin-bottom: 1.25rem; line-height: 2; }
    .establishment p { font-size: 13px; }
    .establishment strong { display: inline-block; min-width: 200px; }
    .underline { display: inline-block; min-width: 280px; border-bottom: 1px solid #555; }
    table { width: 100%; border-collapse: collapse; margin-top: .5rem; font-size: 13px; }
    th, td { border: 1px solid #444; padding: .4rem .65rem; }
    thead th {
      background: #e8e8e8;
      text-align: center;
      font-weight: 700;
      font-size: 12px;
      white-space: nowrap;
    }
    thead tr:first-child th { font-size: 13px; text-transform: uppercase; letter-spacing: .03em; }
    tbody tr:nth-child(even) { background: #f8f8f8; }
    tbody td { height: 1.85rem; vertical-align: middle; }
    td.num { text-align: center; }
    td.divider, th.divider { border-left: 2px solid #333; }
    .footer {
      margin-top: 1.5rem;
      font-size: 11px;
      color: #666;
      text-align: center;
    }
    .no-print { margin-top: 2rem; text-align: center; }
    .btn-print {
      padding: .5rem 1.75rem;
      font-size: 14px;
      background: #1d4ed8;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-print:hover { background: #1e40af; }
    @media print {
      .no-print { display: none !important; }
      body { margin: 0; padding: .5cm 1cm; max-width: none; }
    }
  </style>
</head>
<body>

  <div class="city-header">
    <p><strong>CITY OF KIRKLAND</strong></p>
    <p>PUBLIC WORKS DEPARTMENT</p>
    <p>123 5TH AVENUE</p>
    <p>(425) 587-3900</p>
  </div>

  <h1>Grease Trap and Interceptor Cleaning Record Verification Form</h1>
  <p class="subtitle">Please retain copy for City of Kirkland F.O.G. inspector</p>

  <div class="establishment">
    <p><strong>ESTABLISHMENT NAME:</strong> <span class="underline">${esc(merchant.business_name)}</span></p>
    <p><strong>ADDRESS:</strong> <span class="underline">${merchant.address ? esc(merchant.address) : ''}</span></p>
  </div>

  <h2>Grease Trap Cleaning Log</h2>
  <table>
    <thead>
      <tr>
        <th colspan="4">TRAP</th>
        <th colspan="4" class="divider">TRAP</th>
      </tr>
      <tr>
        <th>Date</th>
        <th>Cleaned by</th>
        <th>Grease<br>In Gallons</th>
        <th>Solids<br>In Gallons</th>
        <th class="divider">Date</th>
        <th>Cleaned by</th>
        <th>Grease<br>In Gallons</th>
        <th>Solids<br>In Gallons</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <h2>Exhaust Hood Cleaning Log</h2>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Cleaned By (Company)</th>
        <th>Notes</th>
      </tr>
    </thead>
    <tbody>
      ${hoodRows}
    </tbody>
  </table>

  <p class="footer">
    Report generated ${generated} &nbsp;·&nbsp;
    ${entries.length} grease trap record${entries.length !== 1 ? 's' : ''} &nbsp;·&nbsp;
    ${hoodEntries.length} hood cleaning record${hoodEntries.length !== 1 ? 's' : ''} on file
  </p>

  <div class="no-print">
    <button class="btn-print" onclick="window.print()">🖨&nbsp; Print / Save as PDF</button>
  </div>

</body>
</html>`

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  })
})

// ---------------------------------------------------------------------------
// FOG reminder emails — sent from the restaurant email to itself when
// grease trap or hood cleaning intervals are exceeded.
// ---------------------------------------------------------------------------

interface MerchantReminderRow {
  id: string
  business_name: string
  email: string | null
  receipt_email_from: string | null
  smtp_provider: string
  timezone: string
  fog_trap_reminder_days: number
  fog_hood_reminder_days: number
  fog_trap_last_reminder: string | null
  fog_hood_last_reminder: string | null
}

/** Today as YYYY-MM-DD in the given timezone */
function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat('sv', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** Days between two YYYY-MM-DD strings */
function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
}

/**
 * Check all active merchants for overdue grease trap and hood cleaning.
 * Sends a reminder email (restaurant → itself) when a cleaning interval is exceeded.
 * Each reminder type sends at most once per day per merchant.
 *
 * @returns number of reminder emails sent
 */
export async function checkFogReminders(): Promise<number> {
  const db = getDatabase()

  const merchant = db
    .query<MerchantReminderRow, []>(
      `SELECT id, business_name, email, receipt_email_from,
              COALESCE(smtp_provider, 'gmail')            AS smtp_provider,
              COALESCE(timezone, 'America/Los_Angeles')   AS timezone,
              COALESCE(fog_trap_reminder_days, 90)        AS fog_trap_reminder_days,
              COALESCE(fog_hood_reminder_days, 180)       AS fog_hood_reminder_days,
              fog_trap_last_reminder,
              fog_hood_last_reminder
       FROM merchants WHERE status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get()

  if (!merchant) return 0
  if (!merchant.email || !merchant.receipt_email_from) return 0

  try {
    const today = todayLocal(merchant.timezone)
    const reminders: string[] = []
    let needsTrapUpdate = false
    let needsHoodUpdate = false

    // Check grease trap
    const lastTrap = db
      .query<{ cleaned_date: string | null }, [string]>(
        `SELECT MAX(cleaned_date) AS cleaned_date
         FROM fog_entries WHERE merchant_id = ? AND deleted_at IS NULL`
      )
      .get(merchant.id)

    const trapOverdue =
      !lastTrap?.cleaned_date ||
      daysBetween(lastTrap.cleaned_date, today) >= merchant.fog_trap_reminder_days

    if (trapOverdue && merchant.fog_trap_last_reminder !== today) {
      const msg = lastTrap?.cleaned_date
        ? `Grease trap last cleaned ${lastTrap.cleaned_date} — ${merchant.fog_trap_reminder_days}-day interval exceeded`
        : 'No grease trap cleaning records on file'
      reminders.push(msg)
      needsTrapUpdate = true
    }

    // Check exhaust hood
    const lastHood = db
      .query<{ cleaned_date: string | null }, [string]>(
        `SELECT MAX(cleaned_date) AS cleaned_date
         FROM fog_hood_entries WHERE merchant_id = ? AND deleted_at IS NULL`
      )
      .get(merchant.id)

    const hoodOverdue =
      !lastHood?.cleaned_date ||
      daysBetween(lastHood.cleaned_date, today) >= merchant.fog_hood_reminder_days

    if (hoodOverdue && merchant.fog_hood_last_reminder !== today) {
      const msg = lastHood?.cleaned_date
        ? `Exhaust hood last cleaned ${lastHood.cleaned_date} — ${merchant.fog_hood_reminder_days}-day interval exceeded`
        : 'No exhaust hood cleaning records on file'
      reminders.push(msg)
      needsHoodUpdate = true
    }

    if (reminders.length === 0) return 0

    const appPassword = await getAPIKey(merchant.id, 'email', merchant.smtp_provider)
    if (!appPassword) {
      console.warn(`[fog-reminder] No email app password for ${merchant.business_name} — skipping`)
      return 0
    }

    const transport = buildSmtpTransport(
      merchant.smtp_provider,
      merchant.receipt_email_from,
      appPassword,
    )
    const smtpName = merchant.business_name.replace(/[\r\n]+/g, ' ').replace(/[\\"]/g, '\\$&')
    const bulletList = reminders.map(r => `<li style="margin:.4rem 0">${r}.</li>`).join('')
    const htmlBody = `
      <p>This is an automated reminder from your Kizo system.</p>
      <p style="margin-top:.75rem">The following cleaning tasks are overdue:</p>
      <ul style="margin:.5rem 0 .75rem 1.5rem">${bulletList}</ul>
      <p>Please schedule service and log the completed cleaning in the FOG dashboard.</p>
      <p style="margin-top:1rem;color:#666;font-size:12px">
        To adjust reminder intervals, contact your Kizo administrator.
      </p>`

    await transport.sendMail({
      from: `"${smtpName}" <${merchant.receipt_email_from}>`,
      to: merchant.email,
      subject: `Cleaning reminder — ${reminders.length} task${reminders.length !== 1 ? 's' : ''} overdue`,
      html: htmlBody,
    })

    if (needsTrapUpdate) {
      db.run(`UPDATE merchants SET fog_trap_last_reminder = ? WHERE id = ?`, [today, merchant.id])
    }
    if (needsHoodUpdate) {
      db.run(`UPDATE merchants SET fog_hood_last_reminder = ? WHERE id = ?`, [today, merchant.id])
    }

    console.log(`[fog-reminder] Sent to ${merchant.business_name}: ${reminders.join(' | ')}`)
    return 1
  } catch (err) {
    console.error('[fog-reminder] Error:', err)
    return 0
  }
}

/**
 * Start the FOG reminder background check.
 * Polls every 6 hours — reminder emails send at most once per day per merchant.
 *
 * @returns cleanup function for graceful shutdown
 */
export function startFogReminders(): () => void {
  if (process.env.NODE_ENV === 'test') return () => {}

  // Run once on startup to catch anything missed while the server was down
  checkFogReminders().catch(err => console.error('[fog-reminder] Startup check failed:', err))

  const handle = setInterval(() => {
    checkFogReminders().catch(err => console.error('[fog-reminder] Interval check failed:', err))
  }, 6 * 60 * 60_000) // 6 hours

  return () => clearInterval(handle)
}

export { fog }
