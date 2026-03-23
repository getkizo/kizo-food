/**
 * Terminal management routes
 * CRUD for PAX payment terminals registered at this location.
 *
 * Phase 2: When a serial number is provided, the server automatically looks up
 * the Finix device ID via the Finix API and stores it on the terminal record.
 * An explicit finixDeviceId field can override the auto-lookup result.
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { authenticate, requireOwnMerchant } from '../middleware/auth'
import { serverError } from '../utils/server-error'
import { getAPIKey } from '../crypto/api-keys'
import { listDevices } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import type { AuthContext } from '../middleware/auth'

const VALID_MODELS = ['pax_a800', 'pax_a920_pro', 'pax_a920_emu', 'pax_d135'] as const
type TerminalModel = typeof VALID_MODELS[number]

/** The fixed Finix device ID used by the A920 emulator (`bun run emulator:a920`). */
const EMU_FINIX_DEVICE_ID = 'DEemulatora920001'

interface TerminalRow {
  id: string
  merchant_id: string
  model: string
  nickname: string
  serial_number: string | null
  finix_device_id: string | null
  created_at: string
}

/** Formats a DB row into the API response shape. */
function formatTerminal(row: TerminalRow) {
  return {
    id:            row.id,
    model:         row.model,
    nickname:      row.nickname,
    serialNumber:  row.serial_number ?? null,
    finixDeviceId: row.finix_device_id ?? null,
    createdAt:     row.created_at,
  }
}

/** Loads Finix credentials for a merchant. Returns null if not fully configured. */
async function loadFinixCreds(merchantId: string): Promise<FinixCredentials | null> {
  const db = getDatabase()
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return null

  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`,
    )
    .get(merchantId)

  const parts = (keyRow?.pos_merchant_id ?? '').split(':')
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
 * Auto-discovers the Finix device ID for a terminal by matching serial number
 * against the list of devices registered under the merchant's Finix account.
 * Returns null if credentials are missing, the Finix call fails, or no match is found.
 */
async function lookupFinixDeviceId(merchantId: string, serialNumber: string): Promise<string | null> {
  try {
    const creds = await loadFinixCreds(merchantId)
    if (!creds) return null
    const devices = await listDevices(creds)
    const match = devices.find(d => d.serialNumber === serialNumber)
    if (match) {
      console.log(`[terminals] Finix device ID resolved: serial ${serialNumber} → ${match.id}`)
    } else {
      console.warn(`[terminals] No Finix device found for serial ${serialNumber} — set finixDeviceId manually if known`)
    }
    return match?.id ?? null
  } catch (err) {
    console.warn(`[terminals] Finix device lookup failed for serial ${serialNumber}:`, (err as Error).message ?? err)
    return null
  }
}

const terminals = new Hono()

/**
 * GET /api/merchants/:id/terminals
 * List all terminals for the merchant, ordered by creation time.
 */
terminals.get('/api/merchants/:id/terminals', authenticate, requireOwnMerchant, async (c: AuthContext) => {
  const merchantId = c.req.param('id')
  try {
    const db = getDatabase()
    const rows = db.query<TerminalRow, [string]>(
      `SELECT id, merchant_id, model, nickname, serial_number, finix_device_id, created_at
         FROM terminals
        WHERE merchant_id = ?
        ORDER BY created_at ASC`,
    ).all(merchantId)
    return c.json({ terminals: rows.map(formatTerminal) })
  } catch (err) {
    return serverError(c, '[terminals] GET', err, 'Failed to list terminals')
  }
})

/**
 * POST /api/merchants/:id/terminals
 * Add a new terminal. If a serialNumber is provided, the server will attempt
 * to look up and store the Finix device ID automatically.
 * An explicit finixDeviceId overrides the auto-lookup result.
 */
terminals.post('/api/merchants/:id/terminals', authenticate, requireOwnMerchant, async (c: AuthContext) => {
  const merchantId = c.req.param('id')
  try {
    const body = await c.req.json() as {
      model?: string
      nickname?: string
      serialNumber?: string
      finixDeviceId?: string
    }

    if (!body.model || !(VALID_MODELS as readonly string[]).includes(body.model)) {
      return c.json({ error: `model must be one of: ${VALID_MODELS.join(', ')}` }, 400)
    }
    if (!body.nickname || typeof body.nickname !== 'string' || !body.nickname.trim()) {
      return c.json({ error: 'nickname is required' }, 400)
    }
    const nickname     = body.nickname.trim()
    if (nickname.length > 64) {
      return c.json({ error: 'nickname must be 64 characters or fewer' }, 400)
    }
    const db = getDatabase()

    // Emulator model: sandbox must be ON, device ID is fixed, serial is not applicable
    if (body.model === 'pax_a920_emu') {
      const merchantRow = db.query<{ finix_sandbox: number }, [string]>(
        `SELECT finix_sandbox FROM merchants WHERE id = ?`,
      ).get(merchantId)
      if (!merchantRow || !merchantRow.finix_sandbox) {
        return c.json({ error: 'Pax A920 Emulator can only be added when sandbox mode is enabled' }, 400)
      }
    }

    const serialNumber = body.model === 'pax_a920_emu' ? null : (body.serialNumber?.trim() || null)
    const explicitDeviceId = body.finixDeviceId?.trim() || null

    let finixDeviceId: string | null
    if (body.model === 'pax_a920_emu') {
      finixDeviceId = EMU_FINIX_DEVICE_ID
    } else {
      finixDeviceId = explicitDeviceId
      if (!finixDeviceId && serialNumber) {
        finixDeviceId = await lookupFinixDeviceId(merchantId, serialNumber)
      }
    }
    const id = generateId('term')
    db.run(
      `INSERT INTO terminals (id, merchant_id, model, nickname, serial_number, finix_device_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, merchantId, body.model, nickname, serialNumber, finixDeviceId],
    )
    const row = db.query<TerminalRow, [string]>(
      `SELECT id, merchant_id, model, nickname, serial_number, finix_device_id, created_at FROM terminals WHERE id = ?`,
    ).get(id)!
    return c.json({ terminal: formatTerminal(row) }, 201)
  } catch (err) {
    return serverError(c, '[terminals] POST', err, 'Failed to create terminal')
  }
})

/**
 * PUT /api/merchants/:id/terminals/:terminalId
 * Update nickname, serial number, and/or Finix device ID. Model is immutable.
 * If serialNumber changes (and no explicit finixDeviceId is provided), re-looks up
 * the Finix device ID automatically.
 */
terminals.put('/api/merchants/:id/terminals/:terminalId', authenticate, requireOwnMerchant, async (c: AuthContext) => {
  const merchantId  = c.req.param('id')
  const terminalId  = c.req.param('terminalId')
  try {
    const db = getDatabase()
    const existing = db.query<TerminalRow, [string, string]>(
      `SELECT id, merchant_id, model, nickname, serial_number, finix_device_id, created_at
         FROM terminals WHERE id = ? AND merchant_id = ?`,
    ).get(terminalId, merchantId)
    if (!existing) return c.json({ error: 'Terminal not found' }, 404)

    const body = await c.req.json() as {
      nickname?: string
      serialNumber?: string
      finixDeviceId?: string
    }

    let nickname = existing.nickname
    if (body.nickname !== undefined) {
      const trimmed = body.nickname.trim()
      if (!trimmed) return c.json({ error: 'nickname cannot be empty' }, 400)
      if (trimmed.length > 64) return c.json({ error: 'nickname must be 64 characters or fewer' }, 400)
      nickname = trimmed
    }

    const serialNumber = body.serialNumber !== undefined
      ? (body.serialNumber.trim() || null)
      : existing.serial_number

    const serialChanged = serialNumber !== existing.serial_number
    const explicitDeviceId = body.finixDeviceId !== undefined
      ? (body.finixDeviceId.trim() || null)
      : undefined   // undefined means "not provided in this request"

    // Determine the new finix_device_id:
    //   1. Explicit value provided → use it (allows manual override or clearing with "")
    //   2. Serial changed → re-lookup automatically (old device ID is stale)
    //   3. No change → keep existing device ID
    let finixDeviceId: string | null = existing.finix_device_id
    if (explicitDeviceId !== undefined) {
      finixDeviceId = explicitDeviceId
    } else if (serialChanged) {
      finixDeviceId = serialNumber ? await lookupFinixDeviceId(merchantId, serialNumber) : null
    }

    db.run(
      `UPDATE terminals SET nickname = ?, serial_number = ?, finix_device_id = ? WHERE id = ? AND merchant_id = ?`,
      [nickname, serialNumber, finixDeviceId, terminalId, merchantId],
    )
    const updated = db.query<TerminalRow, [string]>(
      `SELECT id, merchant_id, model, nickname, serial_number, finix_device_id, created_at FROM terminals WHERE id = ?`,
    ).get(terminalId)!
    return c.json({ terminal: formatTerminal(updated) })
  } catch (err) {
    return serverError(c, '[terminals] PUT', err, 'Failed to update terminal')
  }
})

/**
 * DELETE /api/merchants/:id/terminals/:terminalId
 * Remove a terminal.
 */
terminals.delete('/api/merchants/:id/terminals/:terminalId', authenticate, requireOwnMerchant, async (c: AuthContext) => {
  const merchantId = c.req.param('id')
  const terminalId = c.req.param('terminalId')
  try {
    const db = getDatabase()
    const existing = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM terminals WHERE id = ? AND merchant_id = ?`,
    ).get(terminalId, merchantId)
    if (!existing) return c.json({ error: 'Terminal not found' }, 404)

    db.run(`DELETE FROM terminals WHERE id = ? AND merchant_id = ?`, [terminalId, merchantId])
    return c.json({ success: true })
  } catch (err) {
    return serverError(c, '[terminals] DELETE', err, 'Failed to delete terminal')
  }
})

export { terminals }
